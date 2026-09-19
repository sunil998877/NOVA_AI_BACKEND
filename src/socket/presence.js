
class PresenceManager {
    constructor() {
        this.userSockets = new Map();
        this.socketUser = new Map();
    }

    add(userId, socketId) {
        if (!userId || !socketId) return false;
        const key = String(userId);

        this.socketUser.set(socketId, key);

        if (!this.userSockets.has(key)) {
            this.userSockets.set(key, new Set([socketId]));
            return true;
        }

        const sockets = this.userSockets.get(key);
        sockets.add(socketId);
        return false;
    }

    remove(socketId) {
        const userId = this.socketUser.get(socketId);
        if (!userId) return false;

        this.socketUser.delete(socketId);

        const sockets = this.userSockets.get(userId);
        if (!sockets) return false;

        sockets.delete(socketId);

        if (sockets.size === 0) {
            this.userSockets.delete(userId);
            return true;
        }

        return false;
    }

    isOnline(userId) {
        if (!userId) return false;
        const sockets = this.userSockets.get(String(userId));
        return Boolean(sockets && sockets.size > 0);
    }

    getOnlineUserIds() {
        return Array.from(this.userSockets.keys());
    }

    getUserSockets(userId) {
        const sockets = this.userSockets.get(String(userId));
        return sockets ? Array.from(sockets) : [];
    }
}

export const presence = new PresenceManager();
