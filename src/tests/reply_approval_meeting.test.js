process.env.NODE_ENV = "test";
process.env.TEST = "true";

import test, { describe, before, after } from "node:test";
import assert from "node:assert/strict";
import { connectDb, execute, query } from "../config/db.js";
import { env } from "../config/env.js";
import { Lead } from "../models/lead.model.js";
import { LeadEvent } from "../models/lead-event.model.js";
import { Suppression } from "../models/suppression.model.js";
import { FollowUpEnrollment } from "../models/follow-up-enrollment.model.js";
import { SalesMeeting } from "../models/sales-meeting.model.js";
import { emailReplyListener } from "../services/ase/emailReplyListener.service.js";
import { followUpEngine } from "../services/followup/followUpEngine.service.js";
import { queueCallbackHandoff } from "../services/ase/callbackHandoff.service.js";
import { ASE_OUTCOMES } from "../services/ase/outcomeNormalizer.service.js";
import { setHandoffStatus } from "../services/ase/handoffStatus.service.js";
import {
    approveReplyDraft,
    getReplyDraft,
    rejectReplyDraft,
    sendReplyDraft,
} from "../services/ase/replyApproval.service.js";
import {
    bookMeeting,
    cancelMeeting,
    requestMeeting,
    rescheduleMeeting,
    setMeetingPreferences,
} from "../services/ase/meetingBooking.service.js";

const ORG = 9971;
const TABLES = [
    "sales_meetings",
    "email_reply_drafts",
    "inbound_emails",
    "callbacks",
    "follow_up_tasks",
    "follow_up_enrollments",
    "lead_events",
    "suppressions",
    "leads",
];
const stamp = Date.now();
const reviewer = { id: 1, email: "reviewer@example.test", role: "ORG_ADMIN", organization_id: ORG, authVia: "user_jwt" };

async function cleanup() {
    for (const table of TABLES) {
        await execute(`DELETE FROM ${table} WHERE organization_id = ?`, [ORG]).catch(() => {});
    }
}

async function newLead(name) {
    return Lead.create({
        organization_id: ORG,
        user_id: 1,
        name,
        email: `${name.toLowerCase().replace(/\W+/g, ".")}.${stamp}@example.test`,
        company: `${name} Co`,
        status: "CONTACTED",
    });
}

const inTwoDays = (hour = 10) => {
    const d = new Date(Date.now() + 2 * 86400000);
    return `${d.toISOString().slice(0, 10)}T${String(hour).padStart(2, "0")}:00`;
};

function fakeCalendar({ busy = [], createError = null, status = "confirmed", delayMs = 0 } = {}) {
    const calls = { availability: 0, create: 0, update: 0, cancel: 0, created: [] };
    return {
        calls,
        provider: {
            name: "fake",
            configured: true,
            async checkAvailability() {
                calls.availability += 1;
                return { available: busy.length === 0, busy };
            },
            async createEvent(args) {
                calls.create += 1;
                if (delayMs) await new Promise((r) => setTimeout(r, delayMs));
                if (createError) throw createError;
                calls.created.push(args.eventId);
                return { eventId: args.eventId, status, htmlLink: `https://calendar.example/${args.eventId}`, created: true };
            },
            async updateEvent(args) {
                calls.update += 1;
                return { eventId: args.eventId, status: "confirmed" };
            },
            async cancelEvent() {
                calls.cancel += 1;
                return { cancelled: true };
            },
        },
    };
}

const eventsOf = (leadId, type) =>
    query("SELECT * FROM lead_events WHERE organization_id = ? AND lead_id = ? AND event_type = ?", [ORG, leadId, type]);

describe("Reply approval queue and meeting status accuracy", () => {
    const savedDefaultCalendar = env.calendar.defaultCalendarId;

    before(async () => {
        await connectDb();
        await cleanup();
        env.calendar.defaultCalendarId = "rep.calendar@example.test";
    });

    after(async () => {
        env.calendar.defaultCalendarId = savedDefaultCalendar;
        await cleanup();
    });

    test("schema: new tables and lead handoff columns exist", async () => {
        const tables = await query(
            `SELECT TABLE_NAME FROM information_schema.TABLES
             WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME IN ('sales_meetings', 'inbound_emails', 'email_reply_drafts')`
        );
        assert.equal(tables.length, 3);
        const cols = await query(
            `SELECT COLUMN_NAME FROM information_schema.COLUMNS
             WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'leads' AND COLUMN_NAME IN ('handoff_status', 'handoff_updated_at')`
        );
        assert.equal(cols.length, 2);
    });

    test("inbound duplicate webhook is processed once (with and without Message-ID)", async () => {
        const lead = await newLead("Dup Webhook");
        const message = {
            from: lead.email,
            subject: "Re: Operations review",
            body: "Can you tell me how the onboarding works?",
            messageId: `<dup-${stamp}@example.test>`,
        };
        const first = await emailReplyListener.handleIncomingReply(message);
        const retry = await emailReplyListener.handleIncomingReply(message);
        assert.equal(first.processed, true);
        assert.ok(first.inboundEmailId);
        assert.equal(retry.duplicate, true);
        assert.equal(retry.inboundEmailId, first.inboundEmailId);

        const noId = { from: lead.email, subject: "Re: Operations review", body: "One more question: does it integrate with HubSpot?", messageId: null, date: null };
        const a = await emailReplyListener.handleIncomingReply(noId);
        const b = await emailReplyListener.handleIncomingReply(noId);
        assert.equal(b.duplicate, true);
        assert.equal(b.inboundEmailId, a.inboundEmailId);

        const inbound = await query("SELECT id FROM inbound_emails WHERE organization_id = ? AND lead_id = ?", [ORG, lead.id]);
        const drafts = await query("SELECT id FROM email_reply_drafts WHERE organization_id = ? AND lead_id = ?", [ORG, lead.id]);
        const received = await eventsOf(lead.id, "EMAIL_REPLY_RECEIVED");
        assert.equal(inbound.length, 2);
        assert.equal(drafts.length, 2);
        assert.equal(received.length, 2);
    });

    test("reply creates a draft in the approval queue and nothing is sent", async () => {
        const lead = await newLead("Draft Create");
        const result = await emailReplyListener.handleIncomingReply({
            from: lead.email,
            subject: "Re: Intro",
            body: "This looks interesting, tell me more.",
            messageId: `<draft-${stamp}@example.test>`,
        });
        assert.equal(result.intent, "INTERESTED");
        assert.ok(result.draftId);
        assert.ok(["PENDING_APPROVAL", "NEEDS_HUMAN_REVIEW"].includes(result.draftStatus));

        const { draft, inbound } = await getReplyDraft(ORG, result.draftId);
        assert.equal(inbound.message_id, `<draft-${stamp}@example.test>`);
        assert.equal(draft.sent_at, null);
        assert.equal((await eventsOf(lead.id, "AI_RESPONSE_SENT")).length, 0);
        const drafted = await eventsOf(lead.id, "AI_RESPONSE_DRAFTED");
        assert.equal(drafted.length, 1);
        const payload = typeof drafted[0].payload === "string" ? JSON.parse(drafted[0].payload) : drafted[0].payload;
        assert.equal(payload.requiresApproval, true);
    });

    test("approve then send exactly once; reject blocks sending; automation cannot approve", async () => {
        const lead = await newLead("Approve Flow");
        const reply = await emailReplyListener.handleIncomingReply({
            from: lead.email,
            subject: "Re: Intro",
            body: "Sounds good, tell me more about how it works.",
            messageId: `<approve-${stamp}@example.test>`,
        });
        const draftId = reply.draftId;
        const delivered = [];
        const deliver = async (args) => {
            delivered.push(args);
            return { status: "SUCCEEDED", messageId: `<sent-${stamp}@example.test>` };
        };

        await assert.rejects(sendReplyDraft(ORG, draftId, reviewer, { deliver }), (err) => err.code === "NOT_APPROVED");
        await assert.rejects(
            approveReplyDraft(ORG, draftId, { ...reviewer, authVia: "n8n_campaign_token" }),
            (err) => err.code === "HUMAN_APPROVAL_REQUIRED"
        );
        assert.equal(delivered.length, 0);

        const approved = await approveReplyDraft(ORG, draftId, reviewer, { acknowledgeIssues: true });
        assert.equal(approved.status, "APPROVED");
        assert.equal(Number(approved.reviewed_by), reviewer.id);

        const sent = await sendReplyDraft(ORG, draftId, reviewer, { deliver });
        assert.equal(sent.draft.status, "SENT");
        assert.equal(delivered.length, 1);
        assert.equal(delivered[0].to, lead.email);
        assert.equal(delivered[0].headers["In-Reply-To"], `<approve-${stamp}@example.test>`);

        const again = await sendReplyDraft(ORG, draftId, reviewer, { deliver });
        assert.equal(again.alreadySent, true);
        assert.equal(delivered.length, 1, "a second send must not deliver again");
        assert.equal((await eventsOf(lead.id, "AI_RESPONSE_SENT")).length, 1);
        assert.equal((await eventsOf(lead.id, "REPLY_DRAFT_APPROVED")).length, 1);

        const other = await newLead("Reject Flow");
        const r2 = await emailReplyListener.handleIncomingReply({
            from: other.email,
            subject: "Re: Intro",
            body: "Tell me more please.",
            messageId: `<reject-${stamp}@example.test>`,
        });
        const rejected = await rejectReplyDraft(ORG, r2.draftId, reviewer, { reason: "Off-brand tone" });
        assert.equal(rejected.status, "REJECTED");
        await assert.rejects(sendReplyDraft(ORG, r2.draftId, reviewer, { deliver }), (err) => err.code === "NOT_APPROVED");
        await assert.rejects(approveReplyDraft(ORG, r2.draftId, reviewer), (err) => err.code === "INVALID_STATE");
        assert.equal(delivered.length, 1);
    });

    test("opt-out suppresses immediately, cancels open drafts and never drafts a reply", async () => {
        const lead = await newLead("Opt Out");
        const first = await emailReplyListener.handleIncomingReply({
            from: lead.email,
            subject: "Re: Intro",
            body: "Tell me more about pricing tiers?",
            messageId: `<pre-optout-${stamp}@example.test>`,
        });
        assert.ok(first.draftId);

        const result = await emailReplyListener.handleIncomingReply({
            from: lead.email,
            subject: "Re: Intro",
            body: "Please unsubscribe me and remove me from your list.",
            messageId: `<optout-${stamp}@example.test>`,
        });
        assert.equal(result.intent, "OPT_OUT");
        assert.equal(result.draftId, null);

        const updated = await Lead.findById(lead.id, ORG);
        assert.equal(Boolean(updated.do_not_contact), true);
        assert.ok(await Suppression.isSuppressed(ORG, { email: lead.email }));
        assert.equal((await eventsOf(lead.id, "OPT_OUT_SUPPRESSED")).length, 1);

        const { draft: earlier } = await getReplyDraft(ORG, first.draftId);
        assert.equal(earlier.status, "CANCELLED");
        await assert.rejects(approveReplyDraft(ORG, first.draftId, reviewer), (err) => err.status === 409);
    });

    test("callback handoff is not a booked meeting", async () => {
        const lead = await newLead("Handoff Only");
        const enrolled = await followUpEngine.enrollLead(lead, { sentAt: new Date(), subject: "Intro", messageId: `<hand-${stamp}@example.test>` });
        assert.ok(enrolled.enrollment?.id);

        const handoff = await queueCallbackHandoff(lead, { channel: "VOICE", outcome: ASE_OUTCOMES.CALLBACK, organization_id: ORG }, { outcome: ASE_OUTCOMES.CALLBACK });
        assert.equal(handoff.queued, true);

        const after = await Lead.findById(lead.id, ORG);
        assert.equal(after.handoff_status, "CALLBACK_PENDING");
        const enrollment = await FollowUpEnrollment.findById(enrolled.enrollment.id, ORG);
        assert.equal(enrollment.status, "stopped_handoff");
        const meetings = await SalesMeeting.listForLead(ORG, lead.id);
        assert.equal(meetings.filter((m) => m.status === "MEETING_BOOKED").length, 0);

        await assert.rejects(
            setHandoffStatus(lead, "MEETING_BOOKED", { orgId: ORG, authoritative: true }),
            (err) => err.code === "BOOKING_CONFIRMATION_REQUIRED"
        );
    });

    test("meeting request by email is MEETING_REQUESTED, then MEETING_PENDING, never booked without a calendar", async () => {
        const lead = await newLead("Meeting Ask");
        const reply = await emailReplyListener.handleIncomingReply({
            from: lead.email,
            subject: "Re: Intro",
            body: "Can we schedule a meeting next week to go through this?",
            messageId: `<meet-${stamp}@example.test>`,
        });
        assert.equal(reply.intent, "MEETING_REQUEST");

        let meeting = await SalesMeeting.findOpenForLead(ORG, lead.id);
        assert.equal(meeting.status, "MEETING_REQUESTED");
        assert.equal((await Lead.findById(lead.id, ORG)).handoff_status, "MEETING_REQUESTED");
        await assert.rejects(bookMeeting(ORG, meeting.id, { provider: fakeCalendar().provider }), (err) => err.code === "NOT_BOOKABLE");

        meeting = await setMeetingPreferences(ORG, meeting.id, { preferredStart: inTwoDays(15), timezone: "Asia/Kolkata" });
        assert.equal(meeting.status, "MEETING_PENDING");
        assert.equal((await Lead.findById(lead.id, ORG)).handoff_status, "MEETING_PENDING");
        assert.equal(meeting.calendar_event_id, null);
    });

    test("successful booking stores the event id and confirmation, then marks MEETING_BOOKED", async () => {
        const lead = await newLead("Book Ok");
        const { meeting } = await requestMeeting(ORG, lead.id, { preferredStart: inTwoDays(11), timezone: "UTC", durationMinutes: 30 });
        assert.equal(meeting.status, "MEETING_PENDING");

        const cal = fakeCalendar();
        const result = await bookMeeting(ORG, meeting.id, { provider: cal.provider });
        assert.equal(result.booked, true);
        assert.equal(result.meeting.status, "MEETING_BOOKED");
        assert.equal(result.meeting.calendar_event_id, `nova${ORG}m${meeting.id}r0`);
        assert.equal(result.meeting.confirmation.calendarEventId, result.meeting.calendar_event_id);
        assert.equal(cal.calls.availability, 1);
        assert.equal(cal.calls.create, 1);

        const fresh = await Lead.findById(lead.id, ORG);
        assert.equal(fresh.handoff_status, "MEETING_BOOKED");
        assert.equal((await eventsOf(lead.id, "MEETING_BOOKED")).length, 1);

        const moved = await rescheduleMeeting(ORG, meeting.id, { preferredStart: inTwoDays(14), timezone: "UTC", provider: cal.provider });
        assert.equal(moved.rescheduled, true);
        assert.equal(moved.meeting.status, "MEETING_BOOKED");
        assert.equal(cal.calls.update, 1);
        assert.equal((await eventsOf(lead.id, "MEETING_RESCHEDULED")).length, 1);

        const cancelled = await cancelMeeting(ORG, meeting.id, { reason: "Prospect asked to cancel", provider: cal.provider });
        assert.equal(cancelled.meeting.status, "MEETING_CANCELLED");
        assert.equal(cal.calls.cancel, 1);
        assert.equal((await Lead.findById(lead.id, ORG)).handoff_status, "MEETING_CANCELLED");
    });

    test("booking failures are BOOKING_FAILED, never MEETING_BOOKED", async () => {
        const busyLead = await newLead("Book Busy");
        const { meeting: m1 } = await requestMeeting(ORG, busyLead.id, { preferredStart: inTwoDays(9), timezone: "UTC" });
        const busy = fakeCalendar({ busy: [{ start: "x", end: "y" }] });
        const r1 = await bookMeeting(ORG, m1.id, { provider: busy.provider });
        assert.equal(r1.booked, false);
        assert.equal(r1.failure.code, "REP_UNAVAILABLE");
        assert.equal(r1.meeting.status, "BOOKING_FAILED");
        assert.equal(busy.calls.create, 0);
        assert.equal((await Lead.findById(busyLead.id, ORG)).handoff_status, "BOOKING_FAILED");

        const errLead = await newLead("Book Error");
        const { meeting: m2 } = await requestMeeting(ORG, errLead.id, { preferredStart: inTwoDays(9), timezone: "UTC" });
        const broken = fakeCalendar({ createError: Object.assign(new Error("Calendar API returned HTTP 500"), { code: "EVENT_CREATE_FAILED" }) });
        const r2 = await bookMeeting(ORG, m2.id, { provider: broken.provider });
        assert.equal(r2.meeting.status, "BOOKING_FAILED");
        assert.equal(r2.meeting.calendar_event_id, null);

        const r3 = await bookMeeting(ORG, m2.id, { provider: { name: "none", configured: false } });
        assert.equal(r3.failure.code, "CALENDAR_NOT_CONFIGURED");

        const tentative = fakeCalendar({ status: "tentative" });
        const r4 = await bookMeeting(ORG, m2.id, { provider: tentative.provider });
        assert.equal(r4.failure.code, "EVENT_NOT_CONFIRMED");
        assert.equal(tentative.calls.cancel, 1, "an unconfirmed event is withdrawn");

        const recovered = await bookMeeting(ORG, m2.id, { provider: fakeCalendar().provider });
        assert.equal(recovered.meeting.status, "MEETING_BOOKED", "a failed booking can be retried");
        assert.equal((await eventsOf(errLead.id, "MEETING_BOOKING_FAILED")).length >= 3, true);
    });

    test("duplicate booking is prevented (concurrent clicks, repeat requests, re-book)", async () => {
        const lead = await newLead("Book Dup");
        const { meeting } = await requestMeeting(ORG, lead.id, { preferredStart: inTwoDays(16), timezone: "UTC" });
        const again = await requestMeeting(ORG, lead.id, {});
        assert.equal(again.created, false);
        assert.equal(again.meeting.id, meeting.id);

        const cal = fakeCalendar({ delayMs: 300 });
        const results = await Promise.allSettled([
            bookMeeting(ORG, meeting.id, { provider: cal.provider }),
            bookMeeting(ORG, meeting.id, { provider: cal.provider }),
        ]);
        assert.equal(cal.calls.create, 1, "only one calendar event may be created");
        const fulfilled = results.filter((r) => r.status === "fulfilled").map((r) => r.value);
        assert.ok(fulfilled.some((r) => r.booked && !r.alreadyBooked));
        for (const r of results.filter((x) => x.status === "rejected")) assert.equal(r.reason.code, "BOOKING_IN_PROGRESS");

        const rebook = await bookMeeting(ORG, meeting.id, { provider: cal.provider });
        assert.equal(rebook.alreadyBooked, true);
        assert.equal(cal.calls.create, 1);
        assert.equal((await eventsOf(lead.id, "MEETING_BOOKED")).length, 1);
    });
});
