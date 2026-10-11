import { BaseChannelAdapter } from "./base.adapter.js";

export class CallingBotVoiceAdapter extends BaseChannelAdapter {
    constructor() {
        super("VOICE");
    }

    async execute(lead, action, payload = {}) {
        if (!lead || !lead.phone) {
            return {
                channel: "VOICE",
                status: "FAILED",
                error: "Lead has no phone number",
                rawResponse: null,
            };
        }

        return {
            channel: "VOICE",
            status: "SUCCEEDED",
            rawResponse: { simulated: true },
            metadata: {
                phone: lead.phone,
            },
        };
    }
}

export const voiceAdapter = new CallingBotVoiceAdapter();
