import { userSchema } from "./user.schema.js";
import { campaignSchema } from "./campaign.schema.js";
import { mailSchema } from "./mail.schema.js";
import { conversationSchema } from "./conversation.schema.js";
import { messageSchema } from "./message.schema.js";
import { auditSchema } from "./audit.schema.js";
import { influencerSchema } from "./influencer.schema.js";

export const schemas = [
    userSchema,
    campaignSchema,
    mailSchema,
    conversationSchema,
    messageSchema,
    auditSchema,
    influencerSchema,
];

export const tableStatements = schemas.map((schema) => schema.createTable);
