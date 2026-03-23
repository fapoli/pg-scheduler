export function maxRetries(maxRetries) {
    return ({ consecutiveFailures }) => {
        if (consecutiveFailures >= maxRetries) {
            return null; // Stop retrying
        }
        return new Date(); // Retry immediately
    };
}
export function exponentialBackoff(initialDelayMs, maxRetries) {
    return ({ executionTime, consecutiveFailures }) => {
        if (maxRetries !== undefined && consecutiveFailures >= maxRetries) {
            return null;
        }
        const base = Math.max(Date.now(), executionTime.getTime());
        const delayMs = initialDelayMs * Math.pow(2, consecutiveFailures - 1);
        return new Date(base + delayMs);
    };
}
export function fixedDelay(delayMs, maxRetries) {
    return ({ executionTime, consecutiveFailures }) => {
        if (maxRetries !== undefined && consecutiveFailures >= maxRetries) {
            return null;
        }
        const base = Math.max(Date.now(), executionTime.getTime());
        return new Date(base + delayMs);
    };
}
