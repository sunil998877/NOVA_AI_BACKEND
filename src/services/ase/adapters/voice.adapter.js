import { BaseChannelAdapter } from "./base.adapter.js";
import { plivoVoiceAdapter } from "./plivoVoice.adapter.js";

export class CallingBotVoiceAdapter extends BaseChannelAdapter {
    constructor() {
        super("VOICE");
    }

    async execute(lead, action, payload = {}) {
        return plivoVoiceAdapter.execute(lead, action, payload);
    }
}

export const voiceAdapter = new CallingBotVoiceAdapter();

