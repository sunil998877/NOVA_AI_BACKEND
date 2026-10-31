import { Callback } from "../../models/callback.model.js";
import { startClickToCall } from "./clickToCall.service.js";

export async function startCallbackQueueClickToCall(orgId, callbackId, user = {}, deps = {}) {
    const callback = await Callback.findById(orgId, callbackId);
    if (!callback) {
        throw Object.assign(new Error("Callback not found"), { status: 404 });
    }
    if (String(callback.status || "").toUpperCase() === "COMPLETED") {
        throw Object.assign(new Error("This callback is already completed"), { status: 400 });
    }

    const result = await startClickToCall(orgId, callback.lead_id, user, {
        ...deps,
        callbackId: callback.id,
        primaryPhone: deps.primaryPhone || deps.repPhone || "",
    });

    await Callback.updateById(orgId, callback.id, {
        call_id: result.call?.id || callback.call_id,
        status: "IN_PROGRESS",
        assigned_rep_id: callback.assigned_rep_id || user.id || null,
    });

    return {
        ...result,
        callback,
        humanPhone: result.primaryPhone,
        leadPhone: result.leadPhone,
        from: process.env.PLIVO_PHONE_NUMBER || null,
    };
}
