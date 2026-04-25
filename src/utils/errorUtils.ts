/**
 * Error handling utilities — structured replacements for silent catch blocks.
 *
 * Replaces ad-hoc `.catch(() => {})` patterns with observable, classified error handling.
 * Three severity levels mirror SRE error taxonomy:
 *   - expectError:  Fire-and-forget with WARN log (replaces `.catch(() => {})`)
 *   - fallback:     Returns default value on failure with INFO log (replaces `.catch(() => null)`)
 *   - expectSync:   Synchronous try/catch with INFO log (replaces `try { ... } catch { }`)
 */

import { createLogger } from './logger';

const log = createLogger('ErrorUtils');

/**
 * Fire-and-forget async wrapper — logs at WARN instead of silent swallow.
 * Use for operations where failure is tolerable but should be observed.
 *
 * @example expectError('liveStreamConnect', () => stream.connect(server))
 */
export function expectError(label: string, fn: () => Promise<void>): void {
    fn().catch((e: unknown) =>
        log.warn(`[EXPECTED] ${label}:`, (e as Error)?.message || String(e))
    );
}

/**
 * Async operation with fallback — logs and returns default on failure.
 * Use for data fetching where stale/default data is acceptable.
 *
 * @example const data = await fallback('loadCert', () => readFile(p), undefined)
 */
export async function fallback<T>(
    label: string,
    fn: () => Promise<T>,
    defaultVal: T,
): Promise<T> {
    try {
        return await fn();
    } catch (e: unknown) {
        log.info(`[FALLBACK] ${label}: ${(e as Error)?.message || String(e)}`);
        return defaultVal;
    }
}

/**
 * Synchronous try/catch with logging — replaces `try { ... } catch { }` blocks.
 * Returns undefined on failure.
 *
 * @example const cert = expectSync('readCert', () => fs.readFileSync(path))
 */
export function expectSync<T>(label: string, fn: () => T): T | undefined {
    try {
        return fn();
    } catch (e: unknown) {
        log.info(`[EXPECTED] ${label}: ${(e as Error)?.message || String(e)}`);
        return undefined;
    }
}
