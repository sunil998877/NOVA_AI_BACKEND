import { asyncHandler } from "../../utils/asyncHandler.js";
import { SenderAccount } from "../../models/sender-account.model.js";

export const listSenderAccounts = asyncHandler(async (req, res) => {
    const orgId = Number(req.user?.organization_id || 1);
    const status = req.query.status ? String(req.query.status) : "";
    const accounts = await SenderAccount.listByOrg(orgId, { status });
    return res.status(200).json({ success: true, data: accounts });
});

export const createSenderAccount = asyncHandler(async (req, res) => {
    const orgId = Number(req.user?.organization_id || 1);
    const { name, email, host, port, username, password, replyTo, secure, dailyLimit, hourlyLimit } = req.body;

    if (!email || !host || !username || !password) {
        return res.status(400).json({
            error: "Missing required fields: email, host, username, and password are required",
        });
    }

    const created = await SenderAccount.create({
        organization_id: orgId,
        user_id: req.user.id,
        name: name || email,
        email,
        host,
        port: Number(port) || 587,
        username,
        password,
        reply_to: replyTo,
        secure: secure !== undefined ? Boolean(secure) : Number(port) === 465,
        daily_limit: Number(dailyLimit) || 200,
        hourly_limit: Number(hourlyLimit) || 50,
    });

    return res.status(201).json({
        success: true,
        message: "Sender account created successfully",
        data: created,
    });
});

export const getSenderAccount = asyncHandler(async (req, res) => {
    const orgId = Number(req.user?.organization_id || 1);
    const account = await SenderAccount.findSafeById(req.params.id, orgId);
    if (!account) {
        return res.status(404).json({ error: "Sender account not found" });
    }
    return res.status(200).json({ success: true, data: account });
});

export const updateSenderAccount = asyncHandler(async (req, res) => {
    const orgId = Number(req.user?.organization_id || 1);
    const updates = {};
    if (req.body.name !== undefined) updates.name = req.body.name;
    if (req.body.email !== undefined) updates.email = req.body.email;
    if (req.body.replyTo !== undefined) updates.reply_to = req.body.replyTo;
    if (req.body.host !== undefined) updates.host = req.body.host;
    if (req.body.port !== undefined) updates.port = Number(req.body.port);
    if (req.body.username !== undefined) updates.username = req.body.username;
    if (req.body.password) updates.password = req.body.password;
    if (req.body.secure !== undefined) updates.secure = req.body.secure ? 1 : 0;
    if (req.body.dailyLimit !== undefined) updates.daily_limit = Number(req.body.dailyLimit);
    if (req.body.hourlyLimit !== undefined) updates.hourly_limit = Number(req.body.hourlyLimit);
    if (req.body.status !== undefined) updates.status = req.body.status;

    const updated = await SenderAccount.updateById(req.params.id, updates, orgId);
    if (!updated) {
        return res.status(404).json({ error: "Sender account not found" });
    }
    return res.status(200).json({
        success: true,
        message: "Sender account updated successfully",
        data: updated,
    });
});

export const deleteSenderAccount = asyncHandler(async (req, res) => {
    const orgId = Number(req.user?.organization_id || 1);
    const deleted = await SenderAccount.deleteById(req.params.id, orgId);
    if (!deleted) {
        return res.status(404).json({ error: "Sender account not found" });
    }
    return res.status(200).json({ success: true, message: "Sender account deleted" });
});

export const verifySenderAccount = asyncHandler(async (req, res) => {
    const orgId = Number(req.user?.organization_id || 1);
    const result = await SenderAccount.verifyConnection(req.params.id, orgId);
    if (!result.ok) {
        return res.status(400).json({ success: false, error: result.error });
    }
    const safe = await SenderAccount.findSafeById(req.params.id, orgId);
    return res.status(200).json({ success: true, message: result.message, data: safe });
});

export const pauseSenderAccount = asyncHandler(async (req, res) => {
    const orgId = Number(req.user?.organization_id || 1);
    const updated = await SenderAccount.updateById(req.params.id, { status: "paused" }, orgId);
    if (!updated) {
        return res.status(404).json({ error: "Sender account not found" });
    }
    return res.status(200).json({ success: true, message: "Sender account paused", data: updated });
});

export const resumeSenderAccount = asyncHandler(async (req, res) => {
    const orgId = Number(req.user?.organization_id || 1);
    const updated = await SenderAccount.updateById(req.params.id, { status: "active" }, orgId);
    if (!updated) {
        return res.status(404).json({ error: "Sender account not found" });
    }
    return res.status(200).json({ success: true, message: "Sender account resumed", data: updated });
});
