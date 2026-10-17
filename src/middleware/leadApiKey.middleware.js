import { authenticate } from "./auth.middleware.js";
import { verifyLeadApiKey } from "../services/leads/leadApiCredential.service.js";

const headerOrgMismatch = (req) => {
    const headerOrg = req.headers["x-organization-id"];
    if (headerOrg == null || String(headerOrg).trim() === "") return false;
    return Number(headerOrg) !== Number(req.user?.organization_id);
};

export const authenticateLeadApi = async (req, res, next) => {
    try {
        const apiKey = req.headers["x-api-key"];
        if (apiKey) {
            const result = await verifyLeadApiKey(apiKey);
            if (!result.ok) {
                return res.status(result.status).json({ error: result.error });
            }
            req.user = {
                id: String(result.userId),
                organization_id: result.organizationId,
                role: "api_service",
            };
            req.authVia = "lead_api_key";
            if (headerOrgMismatch(req)) {
                return res.status(403).json({
                    error: "Organization header does not match the API key",
                });
            }
            return next();
        }

        return authenticate(req, res, (err) => {
            if (err) return next(err);
            if (res.headersSent) return;
            if (headerOrgMismatch(req)) {
                return res.status(403).json({
                    error: "Organization header does not match the authenticated organization",
                });
            }
            return next();
        });
    } catch (error) {
        return next(error);
    }
};
