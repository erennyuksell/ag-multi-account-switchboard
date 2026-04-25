/**
 * Cross-process file lock for UsageStats cache writes.
 * Ensures only ONE extension instance (across multiple windows)
 * actively fetches from the API and writes to disk cache.
 * Other instances operate in read-only mode using the disk cache.
 *
 * Lock file: ~/.gemini/antigravity/brain/.deep_stats_cache.lock
 * Format: { pid: number, ts: number }
 */

import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { createLogger } from '../../utils/logger';

const log = createLogger('ProcessLock');

const LOCK_FILE = path.join(os.homedir(), '.gemini', 'antigravity', 'brain', '.deep_stats_cache.lock');
const STALE_THRESHOLD_MS = 60_000; // 60 seconds — lock expires if holder crashes

interface LockData {
    pid: number;
    ts: number;
}

export class ProcessLock {
    private held = false;

    /**
     * Try to acquire the writer lock.
     * Returns true if this process is now the exclusive writer.
     * Returns false if another live process already holds the lock.
     */
    acquire(): boolean {
        try {
            const existing = this.readLock();
            if (existing && !this.isStale(existing)) {
                // Another process holds a fresh lock — we're a reader
                log.info(`Lock held by PID ${existing.pid} (${Math.round((Date.now() - existing.ts) / 1000)}s ago) — read-only mode`);
                return false;
            }

            // No lock or stale lock — we become the writer
            this.writeLock();
            this.held = true;
            log.info(`Lock acquired (PID ${process.pid})`);
            return true;
        } catch (e: any) {
            log.warn(`Lock acquire failed: ${e?.message} — proceeding as writer`);
            // On error, proceed as writer (fail-open) to avoid data starvation
            this.held = true;
            return true;
        }
    }

    /**
     * Release the lock. Only releases if this process holds it.
     */
    release(): void {
        if (!this.held) return;
        try {
            // Verify we still own the lock before deleting
            const current = this.readLock();
            if (current && current.pid === process.pid) {
                fs.unlinkSync(LOCK_FILE);
            }
            this.held = false;
            log.info('Lock released');
        } catch { /* expected: lock file read may fail if deleted */
            this.held = false;
        }
    }

    /**
     * Refresh the lock timestamp (heartbeat) — prevents stale detection
     * during long-running fetches.
     */
    heartbeat(): void {
        if (!this.held) return;
        try {
            this.writeLock();
        } catch { /* best-effort */ }
    }

    /** Check if this instance currently holds the lock */
    isHeld(): boolean {
        return this.held;
    }

    private readLock(): LockData | null {
        try {
            if (!fs.existsSync(LOCK_FILE)) return null;
            const raw = fs.readFileSync(LOCK_FILE, 'utf-8');
            return JSON.parse(raw) as LockData;
        } catch { /* expected: lock file delete may fail if already removed */
            return null;
        }
    }

    private writeLock(): void {
        const data: LockData = { pid: process.pid, ts: Date.now() };
        fs.writeFileSync(LOCK_FILE, JSON.stringify(data), 'utf-8');
    }

    private isStale(lock: LockData): boolean {
        // Time-based: older than threshold
        if (Date.now() - lock.ts > STALE_THRESHOLD_MS) return true;

        // PID-based: process no longer running
        try {
            process.kill(lock.pid, 0); // signal 0 = existence check
            return false;
        } catch { /* expected: stale lock cleanup — PID no longer exists */
            return true; // process doesn't exist
        }
    }
}
