import { asyncHandler } from "../../utils/asyncHandler.js";
import {
    emptyPlaybookContent,
    getOrgPlaybook,
    saveOrgPlaybook,
    validatePlaybook,
    renderPlaybookEmail,
    buildVoiceContext,
    EMAIL_TYPES,
} from "../../services/ase/salesPlaybook.service.js";

export const getPlaybook = asyncHandler(async (req, res) => {
    const orgId = Number(req.user?.organization_id || 1);
    const row = await getOrgPlaybook(orgId);
    const content = row?.content || emptyPlaybookContent();
    const validation = validatePlaybook(content);
    return res.status(200).json({
        success: true,
        data: {
            id: row?.id || null,
            version: row?.version || 0,
            status: row?.status || "DRAFT",
            content: validation.playbook,
            validation,
        },
    });
});

export const savePlaybook = asyncHandler(async (req, res) => {
    const orgId = Number(req.user?.organization_id || 1);
    const content = req.body?.content || req.body || {};
    const status = req.body?.status;
    const result = await saveOrgPlaybook(orgId, content, status);
    return res.status(200).json({
        success: true,
        data: {
            id: result.playbook?.id || null,
            version: result.playbook?.version || 1,
            status: result.playbook?.status || "DRAFT",
            content: result.validation.playbook,
            validation: result.validation,
        },
    });
});

export const previewPlaybook = asyncHandler(async (req, res) => {
    const orgId = Number(req.user?.organization_id || 1);
    const row = await getOrgPlaybook(orgId);
    const content = req.body?.content || row?.content || emptyPlaybookContent();
    const type = String(req.body?.type || EMAIL_TYPES.INITIAL).toUpperCase();
    const lead = req.body?.lead || {
        first_name: "Alex",
        name: "Alex Rivera",
        company: "Northwind",
        title: "Operations Lead",
        industry: "Software",
    };
    const email = renderPlaybookEmail({ ...content, version: row?.version }, type, lead);
    const voice = buildVoiceContext(content, lead);
    return res.status(200).json({
        success: true,
        data: {
            email,
            voice,
            validation: validatePlaybook(content),
        },
    });
});
