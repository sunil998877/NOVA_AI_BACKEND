export const fetchWithTimeout = async (url, options = {}, timeoutMs = 15_000) => {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);

    try {
        return await fetch(url, {
            ...options,
            signal: options.signal || controller.signal,
        });
    } finally {
        clearTimeout(timeout);
    }
};
