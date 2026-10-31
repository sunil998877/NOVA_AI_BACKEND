import { asyncHandler } from "../../utils/asyncHandler.js";
import { plivoVoiceAdapter } from "../../services/ase/adapters/plivoVoice.adapter.js";
import {
    completeWarmTransfer,
    failWarmTransfer,
    getPendingTransfer,
    transferBridgeXml,
    transferJoinXml,
} from "../../services/ase/warmTransfer.service.js";
import { CALLBACK_PROMISE_SPEECH } from "../../services/ase/warmTransfer.constants.js";

function roomFrom(req) {
    return String(req.query?.room || req.body?.room || req.query?.ConferenceName || req.body?.ConferenceName || "");
}

export const handleTransferBridge = asyncHandler(async (req, res) => {
    const room = roomFrom(req);
    const xml = transferBridgeXml(room);
    res.set("Content-Type", "application/xml");
    return res.status(200).send(xml);
});

export const handleTransferJoin = asyncHandler(async (req, res) => {
    const room = roomFrom(req);
    const xml = transferJoinXml(room);
    res.set("Content-Type", "application/xml");
    if (room) {
        await completeWarmTransfer(room).catch(() => null);
    }
    return res.status(200).send(xml);
});

export const handleTransferPromise = asyncHandler(async (req, res) => {
    const message = req.query?.message || req.body?.message || CALLBACK_PROMISE_SPEECH;
    const xml = plivoVoiceAdapter.generateCallbackPromiseXml(message);
    res.set("Content-Type", "application/xml");
    return res.status(200).send(xml);
});

export const handleTransferStatus = asyncHandler(async (req, res) => {
    const payload = { ...(req.query || {}), ...(req.body || {}) };
    const room = roomFrom({ query: payload, body: payload });
    const status = String(payload.CallStatus || payload.call_status || payload.Status || "").toLowerCase();
    const pending = room ? getPendingTransfer(room) : null;
    if (pending && ["busy", "no-answer", "no_answer", "failed", "canceled", "cancelled", "rejected", "timeout"].includes(status)) {
        await failWarmTransfer(room, { reason: status }).catch(() => null);
    }
    return res.status(200).json({ status: "received", room, callStatus: status || "unknown" });
});
