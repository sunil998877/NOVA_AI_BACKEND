import { CadenceEnrollment, CadencePolicy, CadenceStep } from "../../../models/ase-cadence.model.js";
import { Lead } from "../../../models/lead.model.js";
import { LeadEvent } from "../../../models/lead-event.model.js";
import { Call } from "../../../models/call.model.js";
import { Callback } from "../../../models/callback.model.js";
import { Suppression } from "../../../models/suppression.model.js";
import { eventBus } from "../eventBus.service.js";
import { voiceAdapter } from "../adapters/voice.adapter.js";
import { emailAdapter } from "../adapters/email.adapter.js";
import { validateDispatchEligibility } from "../complianceGate.service.js";
import { applyCapacityGate } from "../capacityPacingGate.service.js";
import { CAPACITY_RETRY_MS } from "../capacityPacing.constants.js";
import { getOperatingMode } from "../operatingMode.service.js";
import { OPERATING_MODES } from "../operatingMode.constants.js";
import { transitionLeadState } from "../leadStateMachine.js";
import { jobQueue } from "../jobQueue.service.js";
import { schedulePlivoCallSync } from "../plivoCallPoll.service.js";
import { applyCadenceClose } from "../lifecycleClose.service.js";
import { validateEmailDraft } from "../emailQuality.service.js";
import { aseDecisionEngine } from "../brain/aseDecisionEngine.service.js";
import { addQueueJob, getQueue } from "../../queue/queue.registry.js";
import { JOB_NAMES, QUEUE_NAMES } from "../../queue/queue.constants.js";
import { shouldEnqueueToRedis } from "../../../config/redis.js";
import { bodyToHtml } from "../../../utils/outreachEmail.js";
import { draftCadenceEmail } from "./cadenceEmailDrafter.js";
import { stopCadenceForLead } from "./cadenceHalt.js";
import {
    classifyCallResult,
    decideAfterCall,
    decideAfterEmail,
    decideAfterReview,
    evaluateLeadEligibility,
    mapProviderCallState,
    normalizeCadenceSettings,
    planFirstStep,
    planNextFollowUp,
    precheckStep,
    resolveLeadTimezone,
} from "./cadencePolicy.js";
import { alignToWindow } from "./cadenceTime.js";
import {
    CADENCE_ACTIONS,
    CADENCE_NEXT_ACTION,
    CALL_RESULT,
    DECIDED_BY,
    ELIGIBILITY,
    EMAIL_STATE,
    ENROLLMENT_STATUS,
    OPEN_ENROLLMENT_STATUSES,
    RESUMABLE_ENROLLMENT_STATUSES,
    ORPHAN_ENROLLMENT_MS,
    STALE_AWAITING_OUTCOME_MS,
    STALE_EXECUTING_MS,
    STEP_STATUS,
} from "./cadence.constants.js";

const MAX_STEP_EXECUTION_ATTEMPTS = 3;
const EMAIL_RETRY_MS = 15 * 60 * 1000;
const DIRECT_EXECUTE_OVERDUE_MS = 2 * 60 * 1000;
const ML_TIMEOUT_MS = 1500;
const BOUNCE_PATTERN = /bounce|\b5\.\d\.\d\b|\b55[0-4]\b|user unknown|no such user|mailbox (unavailable|not found)|does not exist|recipient (address )?rejected|invalid recipient/i;
const BLOCKING_COMPLIANCE = /suppress|do_not_contact|terminal|consent|opt/i;

const settingsOf = (enrollment) => normalizeCadenceSettings(enrollment?.policy_snapshot || {}).settings;
const closedStatus = (status) => status === ENROLLMENT_STATUS.STOPPED || status === ENROLLMENT_STATUS.COMPLETED;

class CadenceError extends Error {
    constructor(message, status = 400, details = null) {
        super(message);
        this.status = status;
        this.statusCode = status;
        this.details = details;
    }
}

function parseCounters(lead) {
    const raw = typeof lead?.attempt_counters === "string"
        ? (() => { try { return JSON.parse(lead.attempt_counters || "{}"); } catch { return {}; } })()
        : (lead?.attempt_counters || {});
    return { email: Number(raw.email || 0), voice: Number(raw.voice || 0), total: Number(raw.total || 0) };
}

async function audit(orgId, leadId, eventType, payload, idempotencyKey = null, status = null) {
    await eventBus.publish(eventType, {
        organization_id: orgId,
        lead_id: leadId,
        channel: "CADENCE",
        status,
        payload,
        ...(idempotencyKey ? { idempotency_key: idempotencyKey } : {}),
    }).catch(() => {});
}

async function modelRecommendation(lead) {
    if (process.env.ASE_CADENCE_LOG_ML === "false") return null;
    try {
        const decision = await Promise.race([
            aseDecisionEngine.evaluateLead(lead, { audit: false }),
            new Promise((resolve) => setTimeout(() => resolve(null), ML_TIMEOUT_MS)),
        ]);
        if (!decision) return { available: false, reason: "timeout" };
        return {
            available: true,
            action: decision.action || null,
            confidence: decision.confidence ?? null,
            reasonCode: decision.reasonCode || null,
            modelVersion: decision.modelVersion || null,
            assistedByMl: Boolean(decision.isAssistedByMl),
            appliedAs: "advisory",
        };
    } catch (err) {
        return { available: false, reason: err.message };
    }
}

async function isLeadSuppressed(orgId, lead) {
    const domain = lead?.email ? lead.email.split("@")[1] : null;
    const hit = await Suppression.isSuppressed(orgId, { email: lead?.email, phone: lead?.phone, domain }).catch(() => null);
    return hit ? { suppressed: true, reason: hit.reason || "Matches suppression list" } : { suppressed: false };
}

export async function resolvePolicy(orgId, policyId = null) {
    if (policyId) {
        const policy = await CadencePolicy.findById(orgId, policyId);
        if (!policy) throw new CadenceError("Cadence policy not found", 404);
        if (!policy.is_active) throw new CadenceError("Cadence policy is inactive", 409);
        return policy;
    }
    const existing = await CadencePolicy.findDefault(orgId);
    if (existing) return existing;
    const { settings } = normalizeCadenceSettings({});
    const { policy } = await CadencePolicy.create(orgId, { name: "Default smart cadence", settings, isDefault: true });
    return policy;
}

export async function savePolicy(orgId, { id = null, name, settings: rawSettings, isDefault = false, isActive, expectedVersion = null }, actorId = null) {
    const { settings, errors } = normalizeCadenceSettings(rawSettings || {});
    if (errors.length) throw new CadenceError("Invalid cadence settings", 422, { errors });
    let policy;
    if (id) {
        policy = await CadencePolicy.update(orgId, id, { name, settings, isActive, expectedVersion });
        if (!policy) throw new CadenceError("Policy not found or modified by someone else", 409);
    } else {
        ({ policy } = await CadencePolicy.create(orgId, { name: name || "Cadence policy", settings, createdBy: actorId }));
    }
    if (isDefault && !policy.is_default) policy = await CadencePolicy.setDefault(orgId, policy.id);
    return policy;
}

export async function checkEligibility(orgId, leadId, { policyId = null } = {}) {
    const lead = await Lead.findById(leadId, orgId);
    if (!lead) throw new CadenceError("Lead not found", 404);
    const [policy, suppression, openEnrollment] = await Promise.all([
        resolvePolicy(orgId, policyId),
        isLeadSuppressed(orgId, lead),
        CadenceEnrollment.findOpenByLead(orgId, lead.id),
    ]);
    const { settings } = normalizeCadenceSettings(policy.settings);
    const eligibility = evaluateLeadEligibility(lead, {
        settings,
        suppressed: suppression.suppressed,
        suppressedReason: suppression.reason,
        openEnrollment: Boolean(openEnrollment),
    });
    return { lead, policy, settings, eligibility, timezone: resolveLeadTimezone(lead, settings), openEnrollment };
}

async function enqueueStep(step) {
    if (!step || step.status !== STEP_STATUS.SCHEDULED) return null;
    if (!shouldEnqueueToRedis() || !getQueue(QUEUE_NAMES.ASE_CADENCE)) return null;
    const dueMs = new Date(step.due_at).getTime();
    return addQueueJob(
        QUEUE_NAMES.ASE_CADENCE,
        JOB_NAMES.EXECUTE_CADENCE_STEP,
        { organizationId: Number(step.organization_id), stepId: Number(step.id) },
        { jobId: `cadence-${step.id}-${dueMs}`, delay: Math.max(0, dueMs - Date.now()), attempts: 3 }
    );
}

async function syncLeadNextAction(orgId, enrollment) {
    const lead = await Lead.findById(enrollment.lead_id, orgId);
    if (!lead) return;
    const next = closedStatus(enrollment.status) ? null : await CadenceStep.findNextOpen(orgId, enrollment.id);
    const owned = lead.next_action == null || lead.next_action === CADENCE_NEXT_ACTION || lead.next_action === "WAIT";
    if (next && owned) {
        await Lead.updateById(lead.id, { next_action: CADENCE_NEXT_ACTION, next_action_time: new Date(next.due_at) }, orgId);
    } else if (!next && lead.next_action === CADENCE_NEXT_ACTION) {
        await Lead.updateById(lead.id, { next_action: null, next_action_time: null }, orgId);
    }
}

async function scheduleSteps(enrollment, planned, { modelRec = null, reviveCancelled = false } = {}) {
    const orgId = Number(enrollment.organization_id);
    const created = [];
    for (const item of planned || []) {
        let { step, created: isNew } = await CadenceStep.insert({
            organizationId: orgId,
            enrollmentId: enrollment.id,
            leadId: enrollment.lead_id,
            stepKey: item.stepKey,
            action: item.action,
            purpose: item.purpose,
            dueAt: item.dueAt,
            decidedBy: item.decidedBy || DECIDED_BY.POLICY,
            reason: item.reason,
            modelRecommendation: modelRec,
            channelState: item.action === CADENCE_ACTIONS.CALL ? "QUEUED" : (item.action === CADENCE_ACTIONS.EMAIL ? EMAIL_STATE.SCHEDULED : null),
        });
        if (!isNew && reviveCancelled && step?.status === STEP_STATUS.CANCELLED) {
            const revived = await CadenceStep.transition(orgId, step.id, {
                fromStatuses: [STEP_STATUS.CANCELLED],
                patch: { status: STEP_STATUS.SCHEDULED, due_at: item.dueAt, completed_at: null, locked_at: null, decision_reason: String(item.reason || "Rescheduled").slice(0, 255) },
            });
            if (revived) {
                step = revived;
                isNew = true;
            }
        }
        if (!isNew || !step) continue;
        created.push(step);
        await enqueueStep(step);
        await audit(orgId, enrollment.lead_id, "CadenceStepScheduled", {
            enrollmentId: enrollment.id,
            stepId: step.id,
            stepKey: step.step_key,
            action: step.action,
            purpose: step.purpose,
            dueAt: step.due_at,
            decidedBy: step.decided_by,
            reason: step.decision_reason,
            modelRecommendation: modelRec,
        }, `cadence_step_scheduled_${step.id}`, STEP_STATUS.SCHEDULED);
    }
    return created;
}

export async function enrollLead(orgId, leadId, { policyId = null, actorId = null, startNow = false, confirmReview = false } = {}) {
    const ctx = await checkEligibility(orgId, leadId, { policyId });
    const { lead, policy, settings, eligibility, timezone, openEnrollment } = ctx;
    if (openEnrollment) return { enrolled: false, reason: "ALREADY_ENROLLED", enrollment: openEnrollment, eligibility };
    if (eligibility.result === ELIGIBILITY.SUPPRESSED) {
        throw new CadenceError("Lead is suppressed and cannot be enrolled", 409, { eligibility });
    }
    if (eligibility.result === ELIGIBILITY.NEEDS_REVIEW && !confirmReview) {
        return { enrolled: false, reason: "CONFIRMATION_REQUIRED", requiresConfirmation: true, eligibility };
    }
    const first = planFirstStep({ settings, now: new Date(), timezone, channels: eligibility.channels, immediate: Boolean(startNow) });
    if (!first) {
        throw new CadenceError(`First cadence channel (${settings.firstAction}) is not permitted for this lead`, 409, { eligibility });
    }

    const { created, enrollment } = await CadenceEnrollment.create({
        organizationId: orgId,
        leadId: lead.id,
        policyId: policy.id,
        policySnapshot: { ...settings, policyVersion: policy.version, policyName: policy.name },
        stage: first.purpose,
        enrolledBy: actorId,
    });
    if (!created) return { enrolled: false, reason: "ALREADY_ENROLLED", enrollment, eligibility };

    const modelRec = await modelRecommendation(lead);
    const steps = await scheduleSteps(enrollment, [first], { modelRec });
    const queued = transitionLeadState(lead.status, first.action === CADENCE_ACTIONS.CALL ? "DISPATCH_CALL" : "DISPATCH_EMAIL");
    await Lead.updateById(lead.id, {
        status: lead.status === "NEW" ? (queued.nextState || "QUEUED") : lead.status,
        next_action: CADENCE_NEXT_ACTION,
        next_action_time: first.dueAt,
    }, orgId);
    await audit(orgId, lead.id, "CadenceEnrolled", {
        enrollmentId: enrollment.id,
        policyId: policy.id,
        policyVersion: policy.version,
        actor: actorId ? `user:${actorId}` : "system",
        eligibility: eligibility.result,
        reasons: eligibility.reasons,
        confirmedReview: Boolean(confirmReview),
        timezone,
        firstStep: { key: first.stepKey, action: first.action, dueAt: first.dueAt },
        modelRecommendation: modelRec,
    }, `cadence_enrolled_${enrollment.id}`, ENROLLMENT_STATUS.ACTIVE);
    return { enrolled: true, enrollment, steps, eligibility };
}

async function applyDecision(enrollment, step, plan, { lead = null } = {}) {
    const orgId = Number(enrollment.organization_id);
    const now = new Date();
    if (plan.cancelOpen) {
        await CadenceStep.cancelOpen(orgId, enrollment.id, plan.reason || "Superseded by outcome", { exceptId: step?.id });
    }
    const closing = closedStatus(plan.status);
    const updated = await CadenceEnrollment.transition(orgId, enrollment.id, {
        fromStatuses: [ENROLLMENT_STATUS.ACTIVE, ENROLLMENT_STATUS.NEEDS_REVIEW],
        patch: {
            status: plan.status,
            stage: plan.stage || enrollment.stage,
            latest_outcome: plan.result || plan.outcome || enrollment.latest_outcome,
            status_reason: plan.reason ? String(plan.reason).slice(0, 255) : null,
            last_event_at: now,
            ...(closing ? { completed_at: now } : {}),
        },
        mergeFlags: plan.flags,
    });
    if (!updated) {
        await CadenceEnrollment.transition(orgId, enrollment.id, {
            patch: { latest_outcome: plan.result || plan.outcome || null, last_event_at: now },
            mergeFlags: plan.flags,
        });
        await audit(orgId, enrollment.lead_id, "CadenceDecisionDeferred", {
            enrollmentId: enrollment.id,
            stepId: step?.id,
            result: plan.result || plan.outcome,
            reason: "Enrollment is not active; outcome recorded, no new touches scheduled",
        }, step ? `cadence_decision_deferred_${step.id}` : null);
        return null;
    }

    const modelRec = plan.newSteps?.length ? await modelRecommendation(lead || await Lead.findById(enrollment.lead_id, orgId)) : null;
    const created = await scheduleSteps(updated, plan.newSteps || [], { modelRec });
    await audit(orgId, enrollment.lead_id, "CadenceDecision", {
        enrollmentId: enrollment.id,
        stepId: step?.id || null,
        stepKey: step?.step_key || null,
        result: plan.result || plan.outcome || null,
        decision: plan.status,
        stage: plan.stage,
        reason: plan.reason,
        decidedBy: DECIDED_BY.POLICY,
        flags: plan.flags,
        skipped: plan.skipped || [],
        scheduled: created.map((s) => ({ id: s.id, key: s.step_key, action: s.action, dueAt: s.due_at })),
        modelRecommendation: modelRec,
    }, step ? `cadence_decision_${step.id}` : null, plan.status);

    if (plan.status === ENROLLMENT_STATUS.COMPLETED) {
        const fresh = lead || await Lead.findById(enrollment.lead_id, orgId);
        const settings = settingsOf(updated);
        if (fresh) await applyCadenceClose(fresh, { closeOutcome: settings.closeOutcome, reason: plan.reason }).catch(() => null);
    }
    await syncLeadNextAction(orgId, updated);
    return updated;
}

async function releaseStep(orgId, step, dueAt, reason) {
    const updated = await CadenceStep.transition(orgId, step.id, {
        fromStatuses: [STEP_STATUS.EXECUTING, STEP_STATUS.SCHEDULED],
        patch: { status: STEP_STATUS.SCHEDULED, due_at: dueAt, locked_at: null, decision_reason: String(reason).slice(0, 255) },
    });
    if (updated) await enqueueStep(updated);
    const enrollment = await CadenceEnrollment.findById(orgId, step.enrollment_id);
    if (enrollment) await syncLeadNextAction(orgId, enrollment);
    return updated;
}

async function failStep(orgId, step, reason, result = null) {
    return CadenceStep.transition(orgId, step.id, {
        fromStatuses: [STEP_STATUS.EXECUTING, STEP_STATUS.SCHEDULED, STEP_STATUS.AWAITING_OUTCOME],
        patch: { status: STEP_STATUS.FAILED, completed_at: new Date(), decision_reason: String(reason).slice(0, 255), result },
    });
}

async function skipAndAdvance(ctx, reason) {
    const { orgId, step, enrollment, settings, timezone, channels, lead } = ctx;
    const skipped = await CadenceStep.transition(orgId, step.id, {
        fromStatuses: [STEP_STATUS.SCHEDULED, STEP_STATUS.EXECUTING, STEP_STATUS.PENDING_APPROVAL],
        patch: { status: STEP_STATUS.SKIPPED, completed_at: new Date(), decision_reason: String(reason).slice(0, 255) },
    });
    if (!skipped) return { executed: false, reason: "Step already moved" };
    const afterKey = settings.followUpSteps.some((s) => s.key === step.step_key) ? step.step_key : null;
    const planned = planNextFollowUp({ settings, enrollment, afterKey, now: new Date(), timezone, channels });
    const plan = planned.next
        ? { status: ENROLLMENT_STATUS.ACTIVE, stage: "FOLLOW_UP", newSteps: [planned.next], skipped: planned.skipped, reason: `Skipped ${step.step_key}: ${reason}` }
        : { status: ENROLLMENT_STATUS.COMPLETED, stage: settings.closeOutcome === "CLOSED_LOST" ? "CLOSED_LOST" : "NURTURE", newSteps: [], reason: `Skipped ${step.step_key}: ${reason}; no touches remain` };
    await applyDecision(enrollment, step, { ...plan, outcome: "SKIPPED" }, { lead });
    return { executed: false, skipped: true, reason };
}

function currentChannels(lead, settings, suppressed = false) {
    return evaluateLeadEligibility(lead, { settings, suppressed }).channels;
}

async function loadStepContext(orgId, stepId) {
    const step = await CadenceStep.findById(orgId, stepId);
    if (!step) return null;
    const enrollment = await CadenceEnrollment.findById(orgId, step.enrollment_id);
    const lead = await Lead.findById(step.lead_id, orgId);
    const settings = settingsOf(enrollment);
    const timezone = resolveLeadTimezone(lead, settings);
    return { orgId, step, enrollment, lead, settings, timezone, channels: lead ? currentChannels(lead, settings) : { call: false, email: false } };
}

export async function executeStep(orgId, stepId, { source = "queue" } = {}) {
    const ctx = await loadStepContext(Number(orgId), Number(stepId));
    if (!ctx) return { executed: false, reason: "Step not found" };
    const { step, enrollment, lead, settings, timezone } = ctx;
    if (step.status !== STEP_STATUS.SCHEDULED) return { executed: false, reason: `Step is ${step.status}` };
    const now = new Date();
    if (new Date(step.due_at).getTime() > now.getTime() + 5000) return { executed: false, reason: "Step not due yet" };

    const openCallback = lead ? await Callback.hasActiveCallback(orgId, lead.id).catch(() => false) : false;
    const verdict = precheckStep({ step, enrollment, lead, settings, now, timezone, openCallback });
    if (!verdict.proceed) {
        switch (verdict.verdict) {
            case "DEFER":
                return { executed: false, deferred: true, reason: verdict.reason };
            case "RESCHEDULE":
                await releaseStep(orgId, step, verdict.dueAt, verdict.reason);
                return { executed: false, rescheduled: true, dueAt: verdict.dueAt, reason: verdict.reason };
            case "SKIP":
                return skipAndAdvance(ctx, verdict.reason);
            case "STOP":
                await stopCadenceForLead(orgId, step.lead_id, verdict.reason, { actor: "policy" });
                return { executed: false, stopped: true, reason: verdict.reason };
            case "REPLIED":
                await holdEnrollment(orgId, enrollment, ENROLLMENT_STATUS.REPLIED, "REPLIED", verdict.reason);
                return { executed: false, reason: verdict.reason };
            case "HANDOFF":
                await holdEnrollment(orgId, enrollment, openCallback ? ENROLLMENT_STATUS.CALLBACK : ENROLLMENT_STATUS.HANDOFF, "HANDOFF", verdict.reason);
                return { executed: false, reason: verdict.reason };
            default:
                await CadenceStep.transition(orgId, step.id, {
                    fromStatuses: [STEP_STATUS.SCHEDULED],
                    patch: { status: STEP_STATUS.CANCELLED, completed_at: now, decision_reason: verdict.reason },
                });
                return { executed: false, cancelled: true, reason: verdict.reason };
        }
    }

    const claimed = await CadenceStep.claim(orgId, step.id, now);
    if (!claimed) return { executed: false, reason: "Step already claimed" };
    const claimedCtx = { ...ctx, step: claimed, source };
    try {
        if (claimed.action === CADENCE_ACTIONS.CALL) return await executeCall(claimedCtx);
        if (claimed.action === CADENCE_ACTIONS.EMAIL) return await executeEmail(claimedCtx);
        if (claimed.action === CADENCE_ACTIONS.HUMAN_REVIEW) return await executeReview(claimedCtx);
        if (claimed.action === CADENCE_ACTIONS.CLOSE) return await executeClose(claimedCtx);
        await failStep(orgId, claimed, `Unknown action ${claimed.action}`);
        return { executed: false, reason: `Unknown action ${claimed.action}` };
    } catch (err) {
        console.error(`[Cadence] Step ${claimed.id} failed:`, err.message);
        const fresh = await CadenceStep.findById(orgId, claimed.id).catch(() => null) || claimed;
        if (fresh.status !== STEP_STATUS.EXECUTING) throw err;
        if (fresh.call_id) {
            await CadenceStep.transition(orgId, fresh.id, {
                fromStatuses: [STEP_STATUS.EXECUTING],
                patch: { status: STEP_STATUS.AWAITING_OUTCOME, executed_at: new Date() },
            });
        } else if (Number(fresh.attempts || 0) < MAX_STEP_EXECUTION_ATTEMPTS) {
            await releaseStep(orgId, fresh, new Date(Date.now() + EMAIL_RETRY_MS), `Execution error: ${err.message}`);
        } else {
            await failStep(orgId, claimed, `Execution error: ${err.message}`);
            await CadenceEnrollment.transition(orgId, enrollment.id, {
                fromStatuses: [ENROLLMENT_STATUS.ACTIVE],
                patch: { status: ENROLLMENT_STATUS.NEEDS_REVIEW, status_reason: `Step ${claimed.step_key} failed repeatedly`, last_event_at: new Date() },
            });
        }
        throw err;
    }
}

async function holdEnrollment(orgId, enrollment, status, stage, reason) {
    const updated = await CadenceEnrollment.transition(orgId, enrollment.id, {
        fromStatuses: [ENROLLMENT_STATUS.ACTIVE, ENROLLMENT_STATUS.PAUSED, ENROLLMENT_STATUS.NEEDS_REVIEW],
        patch: { status, stage, status_reason: String(reason).slice(0, 255), last_event_at: new Date() },
    });
    if (!updated) return null;
    await CadenceStep.cancelOpen(orgId, enrollment.id, reason);
    await audit(orgId, enrollment.lead_id, "CadenceHeld", { enrollmentId: enrollment.id, status, reason }, null, status);
    await syncLeadNextAction(orgId, updated);
    return updated;
}

async function gateDispatch(ctx, action) {
    const { orgId, step, enrollment, lead } = ctx;
    const userTriggered = step.decided_by === DECIDED_BY.USER || Boolean(step.approved_by);
    const mode = await getOperatingMode(orgId);
    if (mode === OPERATING_MODES.HUMAN_ESCALATION && !userTriggered) {
        await releaseStep(orgId, step, new Date(step.due_at), "Operating mode HUMAN_ESCALATION; paused for reps");
        await CadenceEnrollment.transition(orgId, enrollment.id, {
            fromStatuses: [ENROLLMENT_STATUS.ACTIVE],
            patch: { status: ENROLLMENT_STATUS.PAUSED, paused_at: new Date(), status_reason: "Operating mode is HUMAN_ESCALATION" },
        });
        return { allowed: false, reason: "HUMAN_ESCALATION" };
    }
    if (mode === OPERATING_MODES.AI_RECOMMENDED && action === CADENCE_ACTIONS.CALL && !enrollment.enrolled_by && !userTriggered) {
        await releaseStep(orgId, step, new Date(step.due_at), "AI_RECOMMENDED mode requires a human-confirmed enrollment");
        await CadenceEnrollment.transition(orgId, enrollment.id, {
            fromStatuses: [ENROLLMENT_STATUS.ACTIVE],
            patch: { status: ENROLLMENT_STATUS.NEEDS_REVIEW, status_reason: "Confirm enrollment to allow automated calls" },
        });
        return { allowed: false, reason: "AI_RECOMMENDED" };
    }
    const capacity = await applyCapacityGate(lead, action, { manual: userTriggered });
    if (!capacity.allowed) {
        await releaseStep(orgId, step, new Date(Date.now() + CAPACITY_RETRY_MS), `Capacity: ${capacity.reason}`);
        return { allowed: false, reason: capacity.reason };
    }
    const compliance = await validateDispatchEligibility(lead, action, { cadence: true, bypassCooldown: true, isEngagementTrigger: true });
    if (!compliance.eligible) {
        if (BLOCKING_COMPLIANCE.test(compliance.reason || "")) {
            if (/consent/i.test(compliance.reason || "")) {
                await skipAndAdvance(ctx, compliance.reason);
            } else {
                await failStep(orgId, step, compliance.reason);
                await stopCadenceForLead(orgId, lead.id, compliance.reason, { actor: "compliance" });
            }
        } else {
            await failStep(orgId, step, compliance.reason);
            await applyDecision(enrollment, step, {
                status: ENROLLMENT_STATUS.NEEDS_REVIEW,
                stage: action === CADENCE_ACTIONS.CALL ? "FIX_PHONE" : "FIX_EMAIL",
                flags: action === CADENCE_ACTIONS.CALL ? { invalidPhone: true } : {},
                newSteps: [],
                outcome: "BLOCKED",
                reason: compliance.reason,
            }, { lead });
        }
        return { allowed: false, reason: compliance.reason };
    }
    return { allowed: true, mode, userTriggered };
}

async function executeCall(ctx) {
    const { orgId, step, enrollment, lead } = ctx;
    const gate = await gateDispatch(ctx, CADENCE_ACTIONS.CALL);
    if (!gate.allowed) return { executed: false, reason: gate.reason };

    const idempotencyKey = `cadence_step_${step.id}`;
    const { call, created } = await Call.create({
        organization_id: orgId,
        lead_id: lead.id,
        idempotency_key: idempotencyKey,
        phone_number: lead.phone_e164 || lead.phone,
        call_channel: "VOICE",
        call_type: "OUTBOUND",
        initiation_source: gate.userTriggered ? "MANUAL" : "AUTONOMOUS_AI",
        provider: "plivo",
        provider_status: "initiated",
        normalized_outcome: "INITIATED",
        cost_status: "PENDING",
        raw_metadata: { cadenceStepId: step.id, enrollmentId: enrollment.id, stepKey: step.step_key },
    });
    if (!created && call?.provider_call_uuid) {
        await CadenceStep.transition(orgId, step.id, {
            fromStatuses: [STEP_STATUS.EXECUTING],
            patch: { status: STEP_STATUS.AWAITING_OUTCOME, call_id: call.id, provider_ref: call.provider_call_uuid, executed_at: new Date() },
        });
        return { executed: true, duplicate: true, callId: call.id };
    }
    await CadenceStep.transition(orgId, step.id, {
        fromStatuses: [STEP_STATUS.EXECUTING],
        patch: { call_id: call.id, channel_state: "CALLING" },
    });
    await CadenceEnrollment.transition(orgId, enrollment.id, {
        patch: { latest_outcome: "CALLING", stage: step.purpose, last_event_at: new Date() },
        incrementCalls: 1,
    });

    jobQueue.beginVoiceJob();
    let result;
    try {
        result = await voiceAdapter.execute(lead, "CALL", { callId: call.id });
    } finally {
        jobQueue.endVoiceJob();
    }

    if (result.status !== "SUCCEEDED") {
        await Call.updateById(orgId, call.id, {
            provider_status: "request_failed",
            normalized_outcome: "FAILED",
            failure_reason: result.error || "Provider call creation rejected",
        });
        await finishCallStep(orgId, { ...step, call_id: call.id }, {
            result: CALL_RESULT.FAILED,
            providerStatus: "request_failed",
            error: result.error || "Provider rejected the call",
        });
        return { executed: false, reason: result.error || "Call provider rejected the request" };
    }

    const providerUuid = result.metadata?.providerCallId || result.metadata?.callId || null;
    const initiated = await Call.updateById(orgId, call.id, { provider_call_uuid: providerUuid, provider_status: "initiated" });
    schedulePlivoCallSync(initiated || { ...call, provider_call_uuid: providerUuid });
    await CadenceStep.transition(orgId, step.id, {
        fromStatuses: [STEP_STATUS.EXECUTING],
        patch: { status: STEP_STATUS.AWAITING_OUTCOME, provider_ref: providerUuid, executed_at: new Date(), channel_state: "CALLING" },
    });

    const counters = parseCounters(lead);
    counters.voice += 1;
    counters.total += 1;
    const transition = transitionLeadState(lead.status, "CALL_INITIATED");
    await Lead.updateById(lead.id, { status: transition.nextState, attempt_counters: counters, last_contacted_at: new Date() }, orgId);
    await audit(orgId, lead.id, "ActionDispatched", {
        action: "CALL",
        cadenceStepId: step.id,
        stepKey: step.step_key,
        purpose: step.purpose,
        callId: call.id,
        providerCallUuid: providerUuid,
        actor: gate.userTriggered ? "user" : "policy",
    }, `cadence_dispatch_${step.id}`, "DISPATCHED");

    if (result.rawResponse?.simulated || result.metadata?.simulated) {
        await finishCallStep(orgId, { ...step, call_id: call.id }, {
            result: classifyCallResult({ normalizedOutcome: "OUTCOME_NO_ANSWER" }),
            providerStatus: "simulated",
            simulated: true,
        });
    }
    return { executed: true, action: "CALL", callId: call.id };
}

async function finishCallStep(orgId, step, outcome) {
    const finished = await CadenceStep.transition(orgId, step.id, {
        fromStatuses: [STEP_STATUS.EXECUTING, STEP_STATUS.AWAITING_OUTCOME],
        patch: {
            status: STEP_STATUS.DONE,
            channel_state: outcome.result === CALL_RESULT.FAILED || outcome.result === CALL_RESULT.INVALID_NUMBER
                ? "FAILED"
                : (outcome.result === CALL_RESULT.NO_ANSWER ? "NO_ANSWER" : outcome.result === CALL_RESULT.BUSY ? "BUSY" : outcome.result === CALL_RESULT.VOICEMAIL ? "VOICEMAIL" : "COMPLETED"),
            result: outcome,
            completed_at: new Date(),
        },
    });
    if (!finished) return null;
    const enrollment = await CadenceEnrollment.findById(orgId, step.enrollment_id);
    const lead = await Lead.findById(step.lead_id, orgId);
    const settings = settingsOf(enrollment);
    const timezone = resolveLeadTimezone(lead, settings);
    const plan = decideAfterCall({
        settings,
        step: finished,
        enrollment,
        result: outcome.result,
        now: new Date(),
        timezone,
        channels: lead ? currentChannels(lead, settings) : { call: false, email: false },
    });
    return applyDecision(enrollment, finished, plan, { lead });
}

export async function handleCallEvent({ orgId, call, callStatus, normalized, hangupCause = null, duration = 0, isFinal = false }) {
    if (!call?.id) return { handled: false };
    const step = await CadenceStep.findByCallId(orgId, call.id);
    if (!step) return { handled: false };
    if (!isFinal) {
        const state = mapProviderCallState(callStatus);
        if (state && [STEP_STATUS.EXECUTING, STEP_STATUS.AWAITING_OUTCOME].includes(step.status)) {
            await CadenceStep.transition(orgId, step.id, { fromStatuses: [STEP_STATUS.EXECUTING, STEP_STATUS.AWAITING_OUTCOME], patch: { channel_state: state } });
        }
        return { handled: true, cadence: true, final: false };
    }
    if (![STEP_STATUS.EXECUTING, STEP_STATUS.AWAITING_OUTCOME].includes(step.status)) {
        await LeadEvent.create({
            organization_id: orgId,
            lead_id: step.lead_id,
            channel: "CADENCE",
            event_type: "CADENCE_LATE_EVENT_IGNORED",
            status: step.status,
            payload: { stepId: step.id, callId: call.id, callStatus, outcome: normalized?.normalizedOutcome },
            idempotency_key: `cadence_late_${step.id}_${String(callStatus).slice(0, 20)}`,
        }).catch(() => {});
        return { handled: true, cadence: true, ignored: true };
    }
    const result = classifyCallResult({
        normalizedOutcome: normalized?.normalizedOutcome,
        isAnswered: normalized?.isAnswered,
        disposition: normalized?.disposition,
        hangupCause,
    });
    await finishCallStep(orgId, step, {
        result,
        providerStatus: callStatus,
        normalizedOutcome: normalized?.normalizedOutcome || null,
        disposition: normalized?.disposition || null,
        hangupCause,
        duration: Number(duration || 0),
        isAnswered: Boolean(normalized?.isAnswered),
    });
    return { handled: true, cadence: true, result };
}

export async function isCadenceCall(orgId, call) {
    return Boolean(call?.id) && String(call.idempotency_key || "").startsWith("cadence_step_");
}

async function executeEmail(ctx) {
    const { orgId, step, enrollment, lead, settings } = ctx;
    const approved = Boolean(step.approved_at);
    let draft = approved ? step.draft : null;
    if (!draft?.subject || !draft?.text) {
        const previousBodies = await CadenceStep.listRecentEmailBodies(orgId, enrollment.id);
        draft = await draftCadenceEmail(lead, { purpose: step.purpose, previousBodies });
    }
    const mode = await getOperatingMode(orgId);
    const autoAllowed = settings.emailApprovalMode === "AUTO" && mode === OPERATING_MODES.FULLY_AUTOMATED && !draft.needsReview;
    if (!approved && !autoAllowed) {
        await CadenceStep.transition(orgId, step.id, {
            fromStatuses: [STEP_STATUS.EXECUTING],
            patch: { status: STEP_STATUS.PENDING_APPROVAL, channel_state: EMAIL_STATE.PENDING_APPROVAL, draft, locked_at: null },
        });
        await audit(orgId, lead.id, "EMAIL_READY_FOR_APPROVAL", {
            cadenceStepId: step.id,
            stepKey: step.step_key,
            purpose: step.purpose,
            subject: draft.subject,
            grounding: draft.grounding,
            reviewReasons: draft.reviewReasons,
            reason: draft.needsReview ? "Draft needs review" : (settings.emailApprovalMode === "MANUAL" ? "Manual approval mode" : `Operating mode ${mode}`),
        }, `cadence_email_pending_${step.id}`, EMAIL_STATE.PENDING_APPROVAL);
        await syncLeadNextAction(orgId, enrollment);
        return { executed: false, pendingApproval: true };
    }
    if (draft.blocked) {
        await CadenceStep.transition(orgId, step.id, {
            fromStatuses: [STEP_STATUS.EXECUTING],
            patch: { status: STEP_STATUS.PENDING_APPROVAL, channel_state: EMAIL_STATE.DRAFT, draft, locked_at: null },
        });
        return { executed: false, pendingApproval: true, reason: "Draft failed quality checks" };
    }

    const gate = await gateDispatch(ctx, CADENCE_ACTIONS.EMAIL);
    if (!gate.allowed) return { executed: false, reason: gate.reason };
    await CadenceStep.transition(orgId, step.id, { fromStatuses: [STEP_STATUS.EXECUTING], patch: { channel_state: EMAIL_STATE.SENDING, draft } });

    const sent = await emailAdapter.execute(lead, "SEND", {
        subject: draft.subject,
        text: draft.text,
        html: draft.html || bodyToHtml(draft.text),
        idempotencyKey: `cadence_step_${step.id}`,
    });

    if (sent.status !== "SUCCEEDED") {
        const errorText = `${sent.error || ""} ${JSON.stringify(sent.rawResponse || {})}`;
        if (BOUNCE_PATTERN.test(errorText)) {
            return finishEmailStep(ctx, { ...draft }, { outcome: EMAIL_STATE.BOUNCED, error: sent.error });
        }
        if (/compliance gate blocked/i.test(sent.error || "")) {
            await skipAndAdvance(ctx, sent.error);
            return { executed: false, reason: sent.error };
        }
        if (Number(step.attempts || 0) < MAX_STEP_EXECUTION_ATTEMPTS) {
            await releaseStep(orgId, step, new Date(Date.now() + EMAIL_RETRY_MS), `Email send failed: ${sent.error || "unknown"}`);
            return { executed: false, retrying: true, reason: sent.error };
        }
        return finishEmailStep(ctx, draft, { outcome: EMAIL_STATE.FAILED, error: sent.error });
    }
    return finishEmailStep(ctx, draft, {
        outcome: EMAIL_STATE.SENT,
        messageId: sent.metadata?.messageId || null,
        simulated: Boolean(sent.metadata?.simulated),
        senderAccountId: sent.metadata?.senderAccountId || null,
    });
}

async function finishEmailStep(ctx, draft, outcome) {
    const { orgId, step, lead } = ctx;
    const sentOk = outcome.outcome === EMAIL_STATE.SENT;
    const finished = await CadenceStep.transition(orgId, step.id, {
        fromStatuses: [STEP_STATUS.EXECUTING],
        patch: {
            status: sentOk ? STEP_STATUS.DONE : STEP_STATUS.FAILED,
            channel_state: outcome.outcome,
            draft,
            result: outcome,
            provider_ref: outcome.messageId || null,
            executed_at: new Date(),
            completed_at: new Date(),
        },
    });
    if (!finished) return { executed: false, reason: "Step already moved" };
    if (sentOk) {
        await CadenceEnrollment.transition(orgId, step.enrollment_id, { patch: { last_event_at: new Date() }, incrementEmails: 1 });
        const counters = parseCounters(lead);
        counters.email += 1;
        counters.total += 1;
        const transition = transitionLeadState(lead.status, "EMAIL_SENT");
        await Lead.updateById(lead.id, { status: transition.nextState, attempt_counters: counters, last_contacted_at: new Date() }, orgId);
        await audit(orgId, lead.id, "ActionCompleted", {
            action: "EMAIL",
            cadenceStepId: step.id,
            stepKey: step.step_key,
            purpose: step.purpose,
            subject: draft.subject,
            messageId: outcome.messageId,
            simulated: outcome.simulated,
            approvedBy: step.approved_by || null,
        }, `cadence_email_sent_${step.id}`, EMAIL_STATE.SENT);
    }
    const enrollment = await CadenceEnrollment.findById(orgId, step.enrollment_id);
    const freshLead = await Lead.findById(lead.id, orgId);
    const settings = settingsOf(enrollment);
    const plan = decideAfterEmail({
        settings,
        step: finished,
        enrollment,
        outcome: outcome.outcome,
        now: new Date(),
        timezone: resolveLeadTimezone(freshLead, settings),
        channels: freshLead ? currentChannels(freshLead, settings) : { call: false, email: false },
    });
    await applyDecision(enrollment, finished, { ...plan, outcome: outcome.outcome }, { lead: freshLead });
    return { executed: sentOk, action: "EMAIL", outcome: outcome.outcome };
}

async function executeReview(ctx) {
    const { orgId, step, enrollment, lead } = ctx;
    await CadenceStep.transition(orgId, step.id, {
        fromStatuses: [STEP_STATUS.EXECUTING],
        patch: { status: STEP_STATUS.PENDING_APPROVAL, locked_at: null },
    });
    const updated = await CadenceEnrollment.transition(orgId, enrollment.id, {
        fromStatuses: [ENROLLMENT_STATUS.ACTIVE, ENROLLMENT_STATUS.NEEDS_REVIEW],
        patch: { status: ENROLLMENT_STATUS.NEEDS_REVIEW, stage: "REVIEW", status_reason: step.decision_reason || "Human review required", last_event_at: new Date() },
    });
    await audit(orgId, lead.id, "CadenceReviewRequested", { cadenceStepId: step.id, stepKey: step.step_key, reason: step.decision_reason }, `cadence_review_${step.id}`, "NEEDS_REVIEW");
    if (updated) await syncLeadNextAction(orgId, updated);
    return { executed: true, action: "HUMAN_REVIEW" };
}

async function executeClose(ctx) {
    const { orgId, step, enrollment, lead, settings } = ctx;
    await CadenceStep.transition(orgId, step.id, {
        fromStatuses: [STEP_STATUS.EXECUTING],
        patch: { status: STEP_STATUS.DONE, completed_at: new Date(), executed_at: new Date() },
    });
    await applyDecision(enrollment, step, {
        status: ENROLLMENT_STATUS.COMPLETED,
        stage: settings.closeOutcome === "CLOSED_LOST" ? "CLOSED_LOST" : "NURTURE",
        newSteps: [],
        outcome: "CLOSED",
        reason: `Cadence closed to ${settings.closeOutcome}`,
    }, { lead });
    return { executed: true, action: "CLOSE" };
}

export async function approveEmailStep(orgId, stepId, actorId, edits = {}) {
    const step = await CadenceStep.findById(orgId, stepId);
    if (!step || step.action !== CADENCE_ACTIONS.EMAIL) throw new CadenceError("Email step not found", 404);
    if (step.status !== STEP_STATUS.PENDING_APPROVAL) throw new CadenceError(`Step is ${step.status}, not pending approval`, 409);
    const enrollment = await CadenceEnrollment.findById(orgId, step.enrollment_id);
    if (!enrollment || enrollment.status !== ENROLLMENT_STATUS.ACTIVE) throw new CadenceError("Cadence is not active", 409);
    const base = step.draft || {};
    const subject = String(edits.subject ?? base.subject ?? "").trim();
    const text = String(edits.text ?? base.text ?? "").trim();
    const previousBodies = await CadenceStep.listRecentEmailBodies(orgId, enrollment.id);
    const quality = validateEmailDraft({ subject, text, noPriorConversation: true, previousBodies });
    if (!quality.eligibleToSend) throw new CadenceError("Email failed quality checks", 422, { issues: quality.issues });
    const settings = settingsOf(enrollment);
    const lead = await Lead.findById(step.lead_id, orgId);
    const dueAt = alignToWindow(new Date(), settings.emailWindow, resolveLeadTimezone(lead, settings));
    const edited = edits.subject !== undefined || edits.text !== undefined;
    const updated = await CadenceStep.transition(orgId, step.id, {
        fromStatuses: [STEP_STATUS.PENDING_APPROVAL],
        patch: {
            status: STEP_STATUS.SCHEDULED,
            channel_state: EMAIL_STATE.SCHEDULED,
            due_at: dueAt,
            approved_by: actorId ? Number(actorId) : null,
            approved_at: new Date(),
            draft: { ...base, subject, text, html: edited ? bodyToHtml(text) : (base.html || bodyToHtml(text)), qualityChecks: quality, needsReview: false, blocked: false, editedBy: edited ? actorId : null },
        },
    });
    if (!updated) throw new CadenceError("Step changed while approving", 409);
    await enqueueStep(updated);
    await audit(orgId, step.lead_id, "CadenceEmailApproved", { cadenceStepId: step.id, actor: actorId ? `user:${actorId}` : null, edited, dueAt }, `cadence_email_approved_${step.id}`, EMAIL_STATE.SCHEDULED);
    await syncLeadNextAction(orgId, enrollment);
    return updated;
}

export async function rejectEmailStep(orgId, stepId, actorId, reason = "Rejected by reviewer") {
    const ctx = await loadStepContext(Number(orgId), Number(stepId));
    if (!ctx || ctx.step.action !== CADENCE_ACTIONS.EMAIL) throw new CadenceError("Email step not found", 404);
    if (ctx.step.status !== STEP_STATUS.PENDING_APPROVAL) throw new CadenceError(`Step is ${ctx.step.status}, not pending approval`, 409);
    await audit(orgId, ctx.step.lead_id, "CadenceEmailRejected", { cadenceStepId: ctx.step.id, actor: actorId ? `user:${actorId}` : null, reason }, `cadence_email_rejected_${ctx.step.id}`);
    return skipAndAdvance(ctx, `Email rejected: ${reason}`);
}

export async function resolveReviewStep(orgId, stepId, actorId, { decision = "CONTINUE", note = "" } = {}) {
    const ctx = await loadStepContext(Number(orgId), Number(stepId));
    if (!ctx || ctx.step.action !== CADENCE_ACTIONS.HUMAN_REVIEW) throw new CadenceError("Review step not found", 404);
    if (ctx.step.status !== STEP_STATUS.PENDING_APPROVAL) throw new CadenceError(`Step is ${ctx.step.status}`, 409);
    const { step, enrollment, settings, timezone, channels, lead } = ctx;
    const choice = String(decision).toUpperCase();
    await CadenceStep.transition(orgId, step.id, {
        fromStatuses: [STEP_STATUS.PENDING_APPROVAL],
        patch: { status: STEP_STATUS.DONE, approved_by: actorId ? Number(actorId) : null, approved_at: new Date(), completed_at: new Date(), result: { decision: choice, note: String(note).slice(0, 500) } },
    });
    await audit(orgId, step.lead_id, "CadenceReviewResolved", { cadenceStepId: step.id, decision: choice, note, actor: actorId ? `user:${actorId}` : null }, `cadence_review_resolved_${step.id}`);
    if (choice === "STOP") return stopCadenceForLead(orgId, step.lead_id, note || "Stopped by reviewer", { actor: `user:${actorId}` });
    if (choice === "HANDOFF") return holdEnrollment(orgId, enrollment, ENROLLMENT_STATUS.HANDOFF, "HANDOFF", note || "Reviewer handed off to sales");
    if (choice === "CLOSE") {
        return applyDecision(enrollment, step, { status: ENROLLMENT_STATUS.COMPLETED, stage: settings.closeOutcome === "CLOSED_LOST" ? "CLOSED_LOST" : "NURTURE", newSteps: [], outcome: "CLOSED", reason: note || "Closed by reviewer" }, { lead });
    }
    const plan = decideAfterReview({ settings, step, enrollment, now: new Date(), timezone, channels });
    return applyDecision(enrollment, step, { ...plan, outcome: "REVIEWED" }, { lead });
}

export async function pauseCadence(orgId, leadId, actorId, reason = "Paused by user") {
    const enrollment = await CadenceEnrollment.findOpenByLead(orgId, leadId);
    if (!enrollment) throw new CadenceError("No open cadence for this lead", 404);
    const updated = await CadenceEnrollment.transition(orgId, enrollment.id, {
        fromStatuses: [ENROLLMENT_STATUS.ACTIVE, ENROLLMENT_STATUS.NEEDS_REVIEW],
        patch: { status: ENROLLMENT_STATUS.PAUSED, paused_at: new Date(), status_reason: String(reason).slice(0, 255), last_event_at: new Date() },
    });
    if (!updated) throw new CadenceError(`Cadence is ${enrollment.status} and cannot be paused`, 409);
    await audit(orgId, leadId, "CadencePaused", { enrollmentId: enrollment.id, actor: actorId ? `user:${actorId}` : null, reason }, null, ENROLLMENT_STATUS.PAUSED);
    return updated;
}

export async function resumeCadence(orgId, leadId, actorId, reason = "Resumed by user") {
    const enrollment = await CadenceEnrollment.findOpenByLead(orgId, leadId);
    if (!enrollment) throw new CadenceError("No open cadence for this lead", 404);
    if (!RESUMABLE_ENROLLMENT_STATUSES.includes(enrollment.status)) throw new CadenceError(`Cadence is ${enrollment.status}`, 409);
    const lead = await Lead.findById(leadId, orgId);
    const suppression = await isLeadSuppressed(orgId, lead);
    const settings = settingsOf(enrollment);
    const eligibility = evaluateLeadEligibility(lead, { settings, suppressed: suppression.suppressed, suppressedReason: suppression.reason });
    if (eligibility.result === ELIGIBILITY.SUPPRESSED) {
        await stopCadenceForLead(orgId, leadId, "Lead is suppressed", { actor: `user:${actorId}` });
        throw new CadenceError("Lead is suppressed; cadence stopped", 409, { eligibility });
    }
    const flags = {};
    if (enrollment.flags?.invalidPhone && eligibility.channels.call) flags.invalidPhone = false;
    if (enrollment.flags?.lastCallFailed) flags.lastCallFailed = false;
    const updated = await CadenceEnrollment.transition(orgId, enrollment.id, {
        fromStatuses: [enrollment.status],
        patch: { status: ENROLLMENT_STATUS.ACTIVE, paused_at: null, status_reason: String(reason).slice(0, 255), last_event_at: new Date() },
        mergeFlags: flags,
    });
    if (!updated) throw new CadenceError("Cadence changed while resuming", 409);

    const timezone = resolveLeadTimezone(lead, settings);
    const steps = await CadenceStep.listByEnrollment(orgId, enrollment.id);
    const now = new Date();
    const scheduled = steps.filter((s) => s.status === STEP_STATUS.SCHEDULED);
    for (const s of scheduled) {
        const due = new Date(s.due_at).getTime() < now.getTime() ? now : new Date(s.due_at);
        const moved = await CadenceStep.transition(orgId, s.id, { fromStatuses: [STEP_STATUS.SCHEDULED], patch: { due_at: due } });
        if (moved) await enqueueStep(moved);
    }
    const open = steps.some((s) => [STEP_STATUS.SCHEDULED, STEP_STATUS.PENDING_APPROVAL, STEP_STATUS.EXECUTING, STEP_STATUS.AWAITING_OUTCOME].includes(s.status));
    if (!open) {
        const followKeys = new Set(settings.followUpSteps.map((s) => s.key));
        const last = [...steps].reverse().find((s) => followKeys.has(s.step_key) && [STEP_STATUS.DONE, STEP_STATUS.SKIPPED].includes(s.status));
        const planned = planNextFollowUp({ settings, enrollment: updated, afterKey: last?.step_key || null, now, timezone, channels: eligibility.channels });
        if (planned.next) {
            await scheduleSteps(updated, [{ ...planned.next, decidedBy: DECIDED_BY.USER, reason: `${planned.next.reason} (resumed)` }], { reviveCancelled: true });
        } else {
            await applyDecision(updated, null, { status: ENROLLMENT_STATUS.COMPLETED, stage: settings.closeOutcome === "CLOSED_LOST" ? "CLOSED_LOST" : "NURTURE", newSteps: [], outcome: "RESUMED", reason: "No touches remain after resume" }, { lead });
        }
    }
    await audit(orgId, leadId, "CadenceResumed", { enrollmentId: enrollment.id, actor: actorId ? `user:${actorId}` : null, reason, previousStatus: enrollment.status }, null, ENROLLMENT_STATUS.ACTIVE);
    await syncLeadNextAction(orgId, updated);
    return CadenceEnrollment.findById(orgId, enrollment.id);
}

export async function stopCadence(orgId, leadId, actorId, reason = "Stopped by user") {
    const result = await stopCadenceForLead(orgId, leadId, reason, { actor: actorId ? `user:${actorId}` : "user" });
    if (!result.stopped) throw new CadenceError("No open cadence for this lead", 404);
    const lead = await Lead.findById(leadId, orgId);
    if (lead?.next_action === CADENCE_NEXT_ACTION) await Lead.updateById(lead.id, { next_action: null, next_action_time: null }, orgId);
    return result.enrollment;
}

export async function onLeadReplied(orgId, leadId, { messageId = null, intent = null } = {}) {
    const enrollment = await CadenceEnrollment.findOpenByLead(orgId, leadId);
    if (!enrollment || ![ENROLLMENT_STATUS.ACTIVE, ENROLLMENT_STATUS.PAUSED, ENROLLMENT_STATUS.NEEDS_REVIEW].includes(enrollment.status)) {
        return { paused: false };
    }
    const updated = await holdEnrollment(orgId, enrollment, ENROLLMENT_STATUS.REPLIED, "REPLIED", "Prospect replied; sequence paused for reply handling");
    if (updated) {
        await CadenceEnrollment.transition(orgId, enrollment.id, { patch: { latest_outcome: "REPLIED" } });
        const steps = await CadenceStep.listByEnrollment(orgId, enrollment.id);
        const lastEmail = [...steps].reverse().find((s) => s.action === CADENCE_ACTIONS.EMAIL && s.status === STEP_STATUS.DONE);
        if (lastEmail) await CadenceStep.transition(orgId, lastEmail.id, { patch: { channel_state: EMAIL_STATE.REPLIED } });
        await audit(orgId, leadId, "CadenceReplied", { enrollmentId: enrollment.id, messageId, intent }, messageId ? `cadence_reply_${enrollment.id}_${messageId}` : null, ENROLLMENT_STATUS.REPLIED);
    }
    return { paused: Boolean(updated) };
}

export async function onEmailBounced(orgId, leadId, { messageId = null, reason = "Bounced" } = {}) {
    const enrollment = await CadenceEnrollment.findOpenByLead(orgId, leadId);
    if (!enrollment) return { flagged: false };
    await CadenceEnrollment.transition(orgId, enrollment.id, { patch: { latest_outcome: EMAIL_STATE.BOUNCED, last_event_at: new Date() }, mergeFlags: { emailUndeliverable: true } });
    if (messageId) {
        const steps = await CadenceStep.listByEnrollment(orgId, enrollment.id);
        const match = steps.find((s) => s.provider_ref === messageId);
        if (match) await CadenceStep.transition(orgId, match.id, { patch: { channel_state: EMAIL_STATE.BOUNCED } });
    }
    await audit(orgId, leadId, "CadenceEmailBounced", { enrollmentId: enrollment.id, messageId, reason }, messageId ? `cadence_bounce_${messageId}` : null, EMAIL_STATE.BOUNCED);
    return { flagged: true };
}

export async function getLeadCadence(orgId, leadId) {
    const ctx = await checkEligibility(orgId, leadId);
    const enrollment = await CadenceEnrollment.findLatestByLead(orgId, leadId);
    const steps = enrollment ? await CadenceStep.listByEnrollment(orgId, enrollment.id) : [];
    const nextStep = steps.find((s) => [STEP_STATUS.SCHEDULED, STEP_STATUS.PENDING_APPROVAL, STEP_STATUS.EXECUTING, STEP_STATUS.AWAITING_OUTCOME].includes(s.status)) || null;
    return {
        eligibility: ctx.eligibility,
        timezone: ctx.timezone,
        policy: { id: ctx.policy.id, name: ctx.policy.name, version: ctx.policy.version, settings: ctx.settings },
        enrollment,
        open: Boolean(enrollment && OPEN_ENROLLMENT_STATUSES.includes(enrollment.status)),
        nextStep,
        steps,
    };
}

export const QUEUE_FILTERS = Object.freeze({
    retry_due: { actions: ["CALL"], purposes: ["RETRY_CALL"], statuses: ["SCHEDULED"] },
    calls_scheduled: { actions: ["CALL"], statuses: ["SCHEDULED"] },
    email_pending_approval: { actions: ["EMAIL"], statuses: ["PENDING_APPROVAL"] },
    email_scheduled: { actions: ["EMAIL"], statuses: ["SCHEDULED"] },
    no_answer: { actions: ["CALL"], channelStates: ["NO_ANSWER", "BUSY", "VOICEMAIL"], latestOnly: true },
    replied: { enrollmentStatuses: ["REPLIED"], latestOnly: true },
    callback_requested: { enrollmentStatuses: ["CALLBACK"], latestOnly: true },
    needs_review: { enrollmentStatuses: ["NEEDS_REVIEW"], latestOnly: true },
    failed: { statuses: ["FAILED"] },
    suppressed: { leadSuppressed: true, latestOnly: true },
});

export async function listQueue(orgId, { filter = null, leadId = null, limit = 50, offset = 0 } = {}) {
    const preset = filter ? QUEUE_FILTERS[filter] : { statuses: ["SCHEDULED", "PENDING_APPROVAL", "AWAITING_OUTCOME"] };
    if (!preset) throw new CadenceError(`Unknown queue filter ${filter}`, 400, { allowed: Object.keys(QUEUE_FILTERS) });
    const [items, counts] = await Promise.all([
        CadenceStep.listQueue(orgId, { ...preset, leadId, limit, offset }),
        CadenceEnrollment.countByStatus(orgId),
    ]);
    return { filter: filter || "open", items, enrollmentCounts: counts, filters: Object.keys(QUEUE_FILTERS) };
}

let sweepRunning = false;

export async function recoverDueSteps({ limit = 200 } = {}) {
    if (sweepRunning) return { skipped: true };
    sweepRunning = true;
    const summary = { due: 0, executedDirect: 0, enqueued: 0, staleExecuting: 0, staleAwaiting: 0 };
    try {
        const now = Date.now();
        const due = await CadenceStep.findDue(new Date(), limit);
        summary.due = due.length;
        const redis = shouldEnqueueToRedis() && Boolean(getQueue(QUEUE_NAMES.ASE_CADENCE));
        for (const row of due) {
            const overdue = now - new Date(row.due_at).getTime();
            if (redis && overdue < DIRECT_EXECUTE_OVERDUE_MS) {
                const step = await CadenceStep.findById(row.organization_id, row.id);
                if (await enqueueStep(step)) summary.enqueued += 1;
                continue;
            }
            await executeStep(row.organization_id, row.id, { source: "sweep" }).catch((err) => {
                console.warn(`[Cadence] Sweep execution of step ${row.id} failed:`, err.message);
            });
            summary.executedDirect += 1;
        }

        const staleExec = await CadenceStep.findStale(STEP_STATUS.EXECUTING, new Date(now - STALE_EXECUTING_MS));
        for (const step of staleExec) {
            summary.staleExecuting += 1;
            if (step.call_id) {
                await CadenceStep.transition(step.organization_id, step.id, { fromStatuses: [STEP_STATUS.EXECUTING], patch: { status: STEP_STATUS.AWAITING_OUTCOME, executed_at: new Date() } });
            } else if (Number(step.attempts || 0) < MAX_STEP_EXECUTION_ATTEMPTS) {
                await releaseStep(step.organization_id, step, new Date(), "Recovered from stale execution lock");
            } else {
                await failStep(step.organization_id, step, "Execution lock expired repeatedly");
            }
        }

        const staleAwait = await CadenceStep.findStale(STEP_STATUS.AWAITING_OUTCOME, new Date(now - STALE_AWAITING_OUTCOME_MS));
        for (const step of staleAwait) {
            summary.staleAwaiting += 1;
            const call = step.call_id ? await Call.findById(step.organization_id, step.call_id).catch(() => null) : null;
            const providerStatus = String(call?.provider_status || "").toLowerCase();
            const result = call && call.normalized_outcome && !["INITIATED", "IN_PROGRESS"].includes(String(call.normalized_outcome).toUpperCase())
                ? classifyCallResult({ normalizedOutcome: call.normalized_outcome, isAnswered: Boolean(call.is_answered), disposition: call.business_disposition, hangupCause: call.hangup_cause })
                : CALL_RESULT.FAILED;
            await finishCallStep(step.organization_id, step, {
                result,
                providerStatus: providerStatus || "unknown",
                error: result === CALL_RESULT.FAILED ? "No provider outcome received" : null,
                recovered: true,
            });
        }

        const orphans = await CadenceEnrollment.findOrphaned(new Date(now - ORPHAN_ENROLLMENT_MS), limit);
        for (const row of orphans) {
            if (await replanOrphan(row.organization_id, row.id).catch((err) => {
                console.warn(`[Cadence] Orphan recovery of enrollment ${row.id} failed:`, err.message);
                return false;
            })) summary.orphansRecovered = (summary.orphansRecovered || 0) + 1;
        }
    } finally {
        sweepRunning = false;
    }
    return summary;
}

// A step is closed before its decision is applied (the close is the dedup guard), so a crash in
// between leaves an ACTIVE enrollment with no open step. Rebuild the decision from the stored outcome.
export async function replanOrphan(orgId, enrollmentId) {
    const enrollment = await CadenceEnrollment.findById(orgId, enrollmentId);
    if (!enrollment || enrollment.status !== ENROLLMENT_STATUS.ACTIVE) return false;
    if (await CadenceStep.findNextOpen(orgId, enrollmentId)) return false;
    const steps = await CadenceStep.listByEnrollment(orgId, enrollmentId);
    const last = steps
        .filter((s) => [STEP_STATUS.DONE, STEP_STATUS.FAILED].includes(s.status) && s.completed_at)
        .sort((a, b) => new Date(b.completed_at) - new Date(a.completed_at))[0];
    const lead = await Lead.findById(enrollment.lead_id, orgId);
    const settings = settingsOf(enrollment);
    const context = {
        settings,
        step: last,
        enrollment,
        now: new Date(),
        timezone: resolveLeadTimezone(lead, settings),
        channels: lead ? currentChannels(lead, settings) : { call: false, email: false },
    };
    let plan;
    if (last?.action === CADENCE_ACTIONS.CALL && last.result?.result) {
        plan = decideAfterCall({ ...context, result: last.result.result });
    } else if (last?.action === CADENCE_ACTIONS.EMAIL && (last.result?.outcome || last.channel_state)) {
        const outcome = last.result?.outcome || last.channel_state;
        plan = { ...decideAfterEmail({ ...context, outcome }), outcome };
    } else if (last?.action === CADENCE_ACTIONS.CLOSE) {
        plan = { status: ENROLLMENT_STATUS.COMPLETED, stage: settings.closeOutcome === "CLOSED_LOST" ? "CLOSED_LOST" : "NURTURE", newSteps: [], outcome: "CLOSED", reason: `Cadence closed to ${settings.closeOutcome}` };
    } else {
        plan = { status: ENROLLMENT_STATUS.NEEDS_REVIEW, stage: "REVIEW", newSteps: [], outcome: "RECOVERED", reason: "No scheduled touch remained; human review required" };
    }
    await applyDecision(enrollment, last || null, { ...plan, reason: plan.reason || "Recovered interrupted decision" }, { lead });
    return true;
}

export { CadenceError };
