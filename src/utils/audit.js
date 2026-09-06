import { AuditLog } from "../models/audit.model.js";

export const audit = async (userId, action, resourceId, ip) => {
    await AuditLog.create({
        user_id: userId,
        action,
        resource_id: resourceId ? String(resourceId) : null,
        ip_address: ip || "unknown",
    });
};
