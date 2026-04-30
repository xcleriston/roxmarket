import Logger from './logger.js';

export interface RetryOptions {
    retries?: number;
    factor?: number;
    minTimeout?: number;
    maxTimeout?: number;
    onRetry?: (error: any, attempt: number) => void;
}

const defaultOptions: Required<RetryOptions> = {
    retries: 3,
    factor: 2,
    minTimeout: 1000,
    maxTimeout: 10000,
    onRetry: (error, attempt) => {
        Logger.warning(`Attempt ${attempt} failed: ${error.message || error}. Retrying...`);
    },
};

export const retry = async <T>(
    fn: () => Promise<T>,
    options: RetryOptions = {}
): Promise<T> => {
    const opts = { ...defaultOptions, ...options };
    let lastError: any;

    for (let attempt = 1; attempt <= opts.retries + 1; attempt++) {
        try {
            return await fn();
        } catch (error) {
            lastError = error;
            if (attempt <= opts.retries) {
                const timeout = Math.min(
                    opts.minTimeout * Math.pow(opts.factor, attempt - 1),
                    opts.maxTimeout
                );
                opts.onRetry(error, attempt);
                await new Promise((resolve) => setTimeout(resolve, timeout));
            }
        }
    }

    throw lastError;
};
