import { userSchema } from "./user.schema.js";
import { organizationSchema } from "./organization.schema.js";
import { campaignSchema } from "./campaign.schema.js";
import { mailSchema } from "./mail.schema.js";
import { conversationSchema } from "./conversation.schema.js";
import { messageSchema } from "./message.schema.js";
import { auditSchema } from "./audit.schema.js";
import { influencerSchema } from "./influencer.schema.js";
import { myInfluencerSchema } from "./my-influencer.schema.js";
import { contactSchema } from "./contact.schema.js";
import { campaignRecipientSchema } from "./campaign-recipient.schema.js";
import { emailEventSchema } from "./email-event.schema.js";
import { emailTrackingLinkSchema } from "./email-tracking-link.schema.js";
import { collaborationSchema } from "./collaboration.schema.js";
import { collaborationMessageSchema } from "./collaboration-message.schema.js";
import { leadSchema } from "./lead.schema.js";
import { leadEventSchema } from "./lead-event.schema.js";
import { callbackSchema } from "./callback.schema.js";
import { suppressionSchema } from "./suppression.schema.js";
import { aseExecutionSchema } from "./ase-execution.schema.js";

export const schemas = [
    organizationSchema,
    userSchema,
    campaignSchema,
    mailSchema,
    conversationSchema,
    messageSchema,
    auditSchema,
    influencerSchema,
    myInfluencerSchema,
    contactSchema,
    campaignRecipientSchema,
    emailEventSchema,
    emailTrackingLinkSchema,
    collaborationSchema,
    collaborationMessageSchema,
    leadSchema,
    leadEventSchema,
    callbackSchema,
    suppressionSchema,
    aseExecutionSchema,
];

export const tableStatements = schemas.map((schema) => schema.createTable);

export {
    organizationSchema,
    userSchema,
    campaignSchema,
    mailSchema,
    leadSchema,
    leadEventSchema,
    callbackSchema,
    suppressionSchema,
    aseExecutionSchema,
};
