export class BaseChannelAdapter {
    constructor(channelName) {
        this.channelName = channelName;
    }

    async execute(lead, action, payload = {}) {
        throw new Error(`execute() not implemented for channel ${this.channelName}`);
    }
}
