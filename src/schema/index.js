import { userSchema } from "./user.schema.js";
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
import { collaborationSchema } from "./collaboration.schema.js";

export const schemas = [
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
    collaborationSchema,
];

export const tableStatements = schemas.map((schema) => schema.createTable);
