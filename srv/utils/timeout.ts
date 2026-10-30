// SPDX-License-Identifier: Apache-2.0

/** `work`, or a rejection with `onTimeout()` after `ms`. The timer is cleared either way. */
export function withTimeout<T>(work: Promise<T>, ms: number, onTimeout: () => Error = () => new Error(`timed out after ${ms} ms`)): Promise<T> {
    let timer: NodeJS.Timeout | undefined;
    const expired = new Promise<never>((_, reject) => { timer = setTimeout(() => reject(onTimeout()), ms); });
    return Promise.race([work, expired]).finally(() => clearTimeout(timer));
}
