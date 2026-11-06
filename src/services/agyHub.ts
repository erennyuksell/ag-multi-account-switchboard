/**
 * Keeps this window's Antigravity 2.6 hub on the stored account.
 *
 * A running hub never re-reads the stored token (keychain item and
 * ~/.gemini/jetski-standalone-oauth-token, see agyAuth.ts); it only picks up a
 * different account when it starts. Every window runs its own hub, spawned by
 * the Antigravity extension in the same extension host as this one, so each
 * window's instance of this extension looks after exactly one hub: the one
 * whose parent process is ours.
 *
 * Trigger: the token file changes (we rename a new one into place on a
 * switch). Condition: the hub reports a different account than the stored
 * one. agy also rewrites the file when it refreshes a token; that keeps the
 * account, so the condition is false and nothing restarts.
 *
 * How the hub is restarted, measured 2026-10-29:
 *   - LanguageServerService/Restart makes the hub exit with code 42; the IDE
 *     treats that as a crash and respawns it on the stored account in ~4.5s.
 *     The IDE allows 3 such recoveries per window per 10 minutes, with
 *     backoff 1s, 3s, 9s; a 4th crash is not recovered and the window's agent
 *     stays down.
 *   - Restarting the extension host stops the hub cleanly and starts a fresh
 *     manager with a fresh budget, ~6s, but restarts every extension in the
 *     window.
 *   - GetAuthStatus makes a running hub re-read the keychain item, measured
 *     2026-11-06: same pid, new account in ~2.4s; with the write alone the
 *     hub stayed on the old account for 10s. No restart, so the agent is not
 *     interrupted and the IDE's recovery budget is untouched. (Found in PR #12.)
 * So: GetAuthStatus first. If the hub has not moved within AUTH_RELOAD_WAIT_MS,
 * the Restart RPC while we have used fewer than two recoveries in the window,
 * the extension host restart after that.
 */

import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import * as http from 'http';
import { exec } from 'child_process';
import { promisify } from 'util';
import { AGY_TOKEN_FILE, readAgyIdentity, readAgyKeychainIdentity } from './agyAuth';
import { LS_SERVICE_PATH } from '../constants';
import { createLogger } from '../utils/logger';

const execAsync = promisify(exec);
const log = createLogger('AgyHub');

const RECOVERY_WINDOW_MS = 10 * 60_000;
/** Leave the IDE's third recovery for real crashes. */
const RPC_RESTARTS_PER_WINDOW = 2;
const DEBOUNCE_MS = 150;
const AUTH_RELOAD_WAIT_MS = 5_000;
const AUTH_RELOAD_POLL_MS = 250;

export interface HubEndpoint { pid: string; port: number; csrf: string }

/**
 * Shared between the switch flow and the keeper in this extension host.
 * When the keeper has to fall back to restarting the extension host, doing it
 * mid-switch killed the switch that caused it ("Channel has been closed"), so
 * it waits for the switch to finish, and the switch stops waiting for this
 * window's hub, which only that restart can move.
 */
export const agyState = { switching: false, hostRestartPending: false };

/** The hub spawned by this extension host, if it is running. */
export async function findOwnHub(): Promise<HubEndpoint | null> {
    try {
        const { stdout } = await execAsync('ps -A -ww -o pid,ppid,args | grep "agy --hub" | grep -v grep', { timeout: 5_000 });
        for (const line of stdout.split('\n')) {
            const m = line.trim().match(/^(\d+)\s+(\d+)\s+(.*)$/);
            if (!m || Number(m[2]) !== process.pid) continue;
            const port = m[3].match(/--hub-port[=\s]+(\d+)/)?.[1];
            const csrf = m[3].match(/--csrf_token[=\s]+([\w-]+)/)?.[1];
            if (port && csrf) return { pid: m[1], port: Number(port), csrf };
        }
    } catch { /* no hub running */ }
    return null;
}

export function hubCall(hub: HubEndpoint, method: string, timeoutMs = 3_000): Promise<string> {
    return new Promise((resolve, reject) => {
        const req = http.request({
            hostname: '127.0.0.1', port: hub.port, method: 'POST',
            path: `${LS_SERVICE_PATH}/${method}`,
            headers: { 'Content-Type': 'application/json', 'x-codeium-csrf-token': hub.csrf, 'Content-Length': 2 },
        }, res => {
            let body = '';
            res.on('data', d => { body += d; });
            res.on('end', () => res.statusCode === 200 ? resolve(body) : reject(new Error(`HTTP ${res.statusCode}`)));
        });
        req.on('error', reject);
        req.setTimeout(timeoutMs, () => req.destroy(new Error('hub request timed out')));
        req.end('{}');
    });
}

export async function hubIdentity(hub: HubEndpoint): Promise<string> {
    const body = await hubCall(hub, 'GetUserStatus');
    return (JSON.parse(body)?.userStatus?.email as string) || '';
}

export class AgyHubKeeper implements vscode.Disposable {
    private readonly rpcRestarts: number[] = [];
    private timer: ReturnType<typeof setTimeout> | null = null;
    private dirWatcher: fs.FSWatcher | null = null;
    private running = false;
    private again = false;

    constructor(private readonly onRestarted: (email: string) => void) {}

    start(): void {
        // The file is replaced by rename, so watch the directory, not the inode.
        try {
            this.dirWatcher = fs.watch(path.dirname(AGY_TOKEN_FILE), (_e, name) => {
                if (name && name.toString() === path.basename(AGY_TOKEN_FILE)) this.schedule('token file changed');
            });
        } catch (e) {
            log.warn('cannot watch token directory:', (e as Error)?.message);
        }
        // fs.watch can miss events; a slow poll backs it up.
        fs.watchFile(AGY_TOKEN_FILE, { interval: 2_000 }, () => this.schedule('token file changed (poll)'));
        // A window opened while the store already changed.
        setTimeout(() => this.schedule('startup'), 10_000);
    }

    dispose(): void {
        if (this.timer) clearTimeout(this.timer);
        this.dirWatcher?.close();
        fs.unwatchFile(AGY_TOKEN_FILE);
    }

    /** Ask for a check now, e.g. right after this window wrote the store. */
    schedule(reason: string): void {
        if (this.timer) clearTimeout(this.timer);
        this.timer = setTimeout(() => { this.timer = null; void this.reconcile(reason); }, DEBOUNCE_MS);
    }

    /**
     * Restart this window's hub, for the Conversation Guard. A starting hub
     * reconciles conversation_summaries.db against the conversation files on
     * disk and writes back rows that are missing. Measured 2026-11-06 on a
     * copy of the data dir with one row deleted: "reconcile checked 1
     * conversations, restored 1", every field equal to the original row. So
     * the index is repaired by Antigravity itself, from its own data.
     */
    async restartForReindex(): Promise<boolean> {
        const hub = await findOwnHub();
        if (!hub) return false;
        await this.restart(hub, `reindex: hub ${hub.pid}`);
        return true;
    }

    /**
     * Restart RPC while under the budget (true: hub restarted in place),
     * otherwise the extension host (false: this extension restarts with it).
     */
    private async restart(hub: HubEndpoint, what: string): Promise<boolean> {
        const now = Date.now();
        while (this.rpcRestarts.length && now - this.rpcRestarts[0] > RECOVERY_WINDOW_MS) this.rpcRestarts.shift();

        if (this.rpcRestarts.length < RPC_RESTARTS_PER_WINDOW) {
            this.rpcRestarts.push(now);
            log.info(`${what} — restarting hub (${this.rpcRestarts.length}/${RPC_RESTARTS_PER_WINDOW} in 10m)`);
            await hubCall(hub, 'Restart').catch(() => { /* it exits mid-reply */ });
            return true;
        }
        log.info(`${what} — recovery budget spent, restarting the extension host`);
        agyState.hostRestartPending = true;
        const deadline = Date.now() + 70_000;
        while (agyState.switching && Date.now() < deadline) await new Promise(r => setTimeout(r, 250));
        await vscode.commands.executeCommand('workbench.action.restartExtensionHost');
        return false;
    }

    private async reconcile(reason: string): Promise<void> {
        if (this.running) { this.again = true; return; }
        this.running = true;
        try {
            const stored = (await readAgyKeychainIdentity()) || readAgyIdentity();
            const hub = await findOwnHub();
            if (!stored || !hub) return;
            const current = await hubIdentity(hub).catch(() => '');
            if (!current || current.toLowerCase() === stored.toLowerCase()) return;

            // The keychain is what GetAuthStatus re-reads. Without it (no
            // macOS keychain) only a restart picks up the token file.
            const keychain = await readAgyKeychainIdentity();
            if (keychain && keychain.toLowerCase() === stored.toLowerCase()) {
                const t0 = Date.now();
                await hubCall(hub, 'GetAuthStatus').catch(e => log.warn('GetAuthStatus failed:', e?.message));
                while (Date.now() - t0 < AUTH_RELOAD_WAIT_MS) {
                    const now = (await hubIdentity(hub).catch(() => '')).toLowerCase();
                    // A newer switch may have landed meanwhile; the queued
                    // reconcile handles it, a restart would not help.
                    if (now === stored.toLowerCase() || (now && now === readAgyIdentity().toLowerCase())) {
                        log.info(`${reason}: hub ${hub.pid} ${current} → ${stored} by GetAuthStatus in ${Date.now() - t0}ms, no restart`);
                        this.onRestarted(stored);
                        return;
                    }
                    await new Promise(r => setTimeout(r, AUTH_RELOAD_POLL_MS));
                }
                log.warn(`${reason}: hub ${hub.pid} still on ${current} ${AUTH_RELOAD_WAIT_MS}ms after GetAuthStatus — restarting it`);
            }

            if (await this.restart(hub, `${reason}: hub ${hub.pid} on ${current}, stored ${stored}`)) this.onRestarted(stored);
        } catch (e) {
            log.warn('reconcile failed:', (e as Error)?.message);
        } finally {
            this.running = false;
            if (this.again) { this.again = false; this.schedule('queued'); }
        }
    }
}
