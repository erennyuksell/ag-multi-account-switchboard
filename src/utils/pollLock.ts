/**
 * PollLock — File-based locking to prevent duplicate refresh
 * across multiple VS Code windows.
 * Uses fs.writeFile with 'wx' (exclusive create) for atomic lock acquisition.
 *
 * Uses PID + instanceId to distinguish between different extension host
 * lifecycles within the same parent process (e.g., Reload Window).
 */

import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import * as crypto from 'crypto';

const LOCK_DIR = path.join(os.homedir(), '.gemini', 'antigravity');
const MAX_LOCK_AGE_MS = 30 * 1000; // 30 seconds (down from 5 min — refresh should never take this long)

// Unique per extension host lifecycle — changes on Reload Window
const INSTANCE_ID = crypto.randomUUID();

export class PollLock {
    private readonly lockPath: string;
    private acquired = false;

    constructor(lockName = '.ag-panel-refresh.lock') {
        this.lockPath = path.join(LOCK_DIR, lockName);
    }

    /** Attempt to acquire. Returns true if acquired, false if another instance holds it. */
    async tryAcquire(): Promise<boolean> {
        try {
            fs.mkdirSync(LOCK_DIR, { recursive: true });

            if (fs.existsSync(this.lockPath)) {
                try {
                    const { pid, instanceId, acquiredAt } = JSON.parse(fs.readFileSync(this.lockPath, 'utf8'));
                    const age = Date.now() - acquiredAt;

                    // Same instance — we already hold it (re-entrant)
                    if (instanceId === INSTANCE_ID) {
                        this.acquired = true;
                        return true;
                    }

                    // Different instance but same PID (Reload Window) or dead PID → stale
                    if (age >= MAX_LOCK_AGE_MS || !this.isAlive(pid)) {
                        // Stale lock — remove it
                    } else if (instanceId && instanceId !== INSTANCE_ID) {
                        // Active lock held by different extension host instance
                        return false;
                    } else {
                        // Legacy lock without instanceId — check PID only
                        if (this.isAlive(pid) && age < MAX_LOCK_AGE_MS) return false;
                    }
                } catch { /* corrupt lock — overwrite */ }
                try { fs.unlinkSync(this.lockPath); } catch { /* ok */ }
            }

            fs.writeFileSync(this.lockPath, JSON.stringify({
                pid: process.pid,
                instanceId: INSTANCE_ID,
                acquiredAt: Date.now(),
            }), { flag: 'wx' });
            this.acquired = true;
            return true;
        } catch (err: any) {
            // EEXIST = lost the race; other errors = fail-open
            return err.code !== 'EEXIST';
        }
    }

    /** Release the lock (only if we own it) */
    async release(): Promise<void> {
        if (!this.acquired) return;
        try {
            const data = JSON.parse(fs.readFileSync(this.lockPath, 'utf8'));
            if (data.instanceId === INSTANCE_ID || data.pid === process.pid) {
                fs.unlinkSync(this.lockPath);
            }
        } catch { /* already released */ }
        this.acquired = false;
    }

    private isAlive(pid: number): boolean {
        try { process.kill(pid, 0); return true; } catch { return false; }
    }
}
