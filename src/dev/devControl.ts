/**
 * DevControl — a file-based control channel for testing the extension without
 * a person at the keyboard.
 *
 * Off unless `ag-switchboard.devControl` is true. When on, every window's
 * extension instance:
 *   - registers itself in <root>/windows/<instanceId>.json (heartbeat 5s)
 *   - picks up command files dropped into <root>/inbox/
 *   - writes one result per command to <root>/outbox/<cmdId>.<instanceId>.json
 *
 * Command file: { id, action, args?, target: 'any' | 'all' | <instanceId>, createdAt }
 *   any         → exactly one instance runs it (claimed by atomic rename)
 *   all         → every instance activated before createdAt runs it once
 *   <instanceId>→ only that instance
 *
 * scripts/agdev.mjs is the client. Results carry no tokens, only short
 * fingerprints.
 */

import * as vscode from 'vscode';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as crypto from 'crypto';
import { QuotaManager } from '../managers/quotaManager';
import { getUSS } from '../utils/uss';
import { findLSEndpoints, loadLSCert, callLSEndpoint, invalidateLsEndpointCache } from '../utils/lsClient';
import { extractField, extractStringField } from '../shared/protobuf';
import { LS_SERVICE_PATH } from '../constants';
import { tokenFingerprint } from '../utils/tokenFingerprint';
import { isAgyMode, readAgyIdentity, readAgyKeychainIdentity, writeAgyToken, readKeychainJson, writeKeychainJson } from '../services/agyAuth';
import { findOwnHub, hubCall, hubIdentity } from '../services/agyHub';
import { ideVersion, isLegacyAntigravity } from '../services/ideBuild';
import { createLogger } from '../utils/logger';

const log = createLogger('DevControl');

export const DEV_ROOT = path.join(os.homedir(), '.ag-switchboard-dev');
const POLL_MS = 500;
const HEARTBEAT_MS = 5_000;
/** Commands older than this are ignored and swept, so a stale inbox can't replay. */
const COMMAND_TTL_MS = 120_000;

interface Command {
    id: string;
    action: string;
    args?: Record<string, unknown>;
    target: string;
    createdAt: number;
}

export class DevControl implements vscode.Disposable {
    private readonly instanceId = crypto.randomUUID().slice(0, 8);
    private readonly activatedAt = Date.now();
    private readonly processed = new Set<string>();
    private pollTimer: ReturnType<typeof setInterval> | null = null;
    private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
    private busy = false;

    constructor(
        private readonly context: vscode.ExtensionContext,
        private readonly quotaManager: QuotaManager,
    ) {}

    start(): void {
        if (this.pollTimer) return;
        for (const d of ['inbox', 'outbox', 'claimed', 'windows']) {
            fs.mkdirSync(path.join(DEV_ROOT, d), { recursive: true, mode: 0o700 });
        }
        this.heartbeat();
        this.heartbeatTimer = setInterval(() => this.heartbeat(), HEARTBEAT_MS);
        this.pollTimer = setInterval(() => { void this.poll(); }, POLL_MS);
        log.info(`dev control on — instance ${this.instanceId} (${this.workspaceName()})`);
    }

    stop(): void {
        if (this.pollTimer) clearInterval(this.pollTimer);
        if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
        this.pollTimer = this.heartbeatTimer = null;
        try { fs.unlinkSync(this.windowFile()); } catch { /* already gone */ }
    }

    dispose(): void { this.stop(); }

    // ── registry ──────────────────────────────────────────────────

    private windowFile(): string {
        return path.join(DEV_ROOT, 'windows', `${this.instanceId}.json`);
    }

    private workspaceName(): string {
        return vscode.workspace.workspaceFolders?.[0]?.name ?? '(no folder)';
    }

    private buildStamp(): number {
        try {
            return fs.statSync(path.join(this.context.extensionPath, 'out', 'extension.js')).mtimeMs;
        } catch { return 0; }
    }

    private heartbeat(): void {
        const info = {
            instanceId: this.instanceId,
            pid: process.pid,
            workspace: this.workspaceName(),
            version: this.context.extension.packageJSON.version,
            build: this.buildStamp(),
            activatedAt: this.activatedAt,
            heartbeatAt: Date.now(),
        };
        try { fs.writeFileSync(this.windowFile(), JSON.stringify(info), { mode: 0o600 }); } catch { /* next beat */ }
    }

    // ── inbox ─────────────────────────────────────────────────────

    private async poll(): Promise<void> {
        if (this.busy) return;
        this.busy = true;
        try {
            const inbox = path.join(DEV_ROOT, 'inbox');
            for (const name of fs.readdirSync(inbox)) {
                if (!name.endsWith('.json')) continue;
                const file = path.join(inbox, name);
                let cmd: Command;
                try { cmd = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { continue; }
                if (!cmd.id || this.processed.has(cmd.id)) continue;
                if (Date.now() - cmd.createdAt > COMMAND_TTL_MS) {
                    try { fs.unlinkSync(file); } catch { /* another instance swept it */ }
                    continue;
                }

                if (cmd.target === 'all') {
                    // Only instances that existed when the command was written;
                    // a window restarted by this very command must not run it again.
                    if (this.activatedAt > cmd.createdAt) { this.processed.add(cmd.id); continue; }
                } else {
                    if (cmd.target !== 'any' && cmd.target !== this.instanceId) continue;
                    try {
                        fs.renameSync(file, path.join(DEV_ROOT, 'claimed', name));
                    } catch { continue; } // another instance claimed it first
                }
                this.processed.add(cmd.id);
                void this.run(cmd);
            }
        } catch (e) {
            log.warn('poll failed:', (e as Error)?.message);
        } finally {
            this.busy = false;
        }
    }

    private async run(cmd: Command): Promise<void> {
        const startedAt = Date.now();
        let ok = true;
        let result: unknown;
        let after: (() => void) | undefined;
        try {
            switch (cmd.action) {
                case 'ping':
                    result = { workspace: this.workspaceName(), build: this.buildStamp(), activatedAt: this.activatedAt };
                    break;
                case 'state':
                    result = await this.state();
                    break;
                case 'switch': {
                    const email = String(cmd.args?.email || '');
                    const id = this.quotaManager.getAccountIdByEmail(email);
                    if (!id) throw new Error(`no tracked account ${email}`);
                    result = await this.quotaManager.switchAccount(id, { skipConfirm: true });
                    break;
                }
                case 'agyWrite': {
                    // Experiment hook: point the hubs at an account by writing
                    // the shared token file only, nothing else.
                    const email = String(cmd.args?.email || '');
                    const tokens = await this.quotaManager.getTokensForEmail(email);
                    if (!tokens) throw new Error(`no tokens for ${email}`);
                    await writeAgyToken({ email, accessToken: tokens.access_token, refreshToken: tokens.refresh_token, expiryTimestamp: tokens.expiry_timestamp });
                    result = { written: email, refresh: tokenFingerprint(tokens.refresh_token) };
                    break;
                }
                case 'authStatusProbe': {
                    // PR #12 claim: a running hub re-reads the keychain when
                    // GetAuthStatus is called. Writes the keychain item only
                    // (the token file is what AgyHubKeeper watches, so it stays
                    // out of the way), asks this window's hub, watches its
                    // identity and pid, then restores the item.
                    const email = String(cmd.args?.email || '');
                    const tokens = await this.quotaManager.getTokensForEmail(email);
                    if (!tokens) throw new Error(`no tokens for ${email}`);
                    const hub = await findOwnHub();
                    if (!hub) throw new Error('no hub for this window');
                    const original = await readKeychainJson();
                    if (!original) throw new Error('keychain item unreadable');
                    const shape = (body: string) => {
                        try { const o = JSON.parse(body); return Object.fromEntries(Object.entries(o).map(([k, v]) => [k, typeof v === 'object' ? Object.keys(v as object) : typeof v])); }
                        catch { return `non-json ${body.length}B`; }
                    };
                    const timeline: unknown[] = [];
                    const before = await hubIdentity(hub).catch(e => `err ${e.message}`);
                    const orig = original as any;
                    try {
                        await writeKeychainJson({
                            ...orig,
                            token: { ...orig.token, access_token: tokens.access_token, refresh_token: tokens.refresh_token,
                                expiry: new Date(tokens.expiry_timestamp * 1000).toISOString(),
                                expires_in: Math.max(0, tokens.expiry_timestamp - Math.floor(Date.now() / 1000)) },
                            id_token_email: email,
                        });
                        const t0 = Date.now();
                        const authBody = cmd.args?.skipAuthStatus ? '{"skipped":{}}' : await hubCall(hub, 'GetAuthStatus').catch(e => `err ${e.message}`);
                        timeline.push({ at: Date.now() - t0, getAuthStatus: shape(authBody) });
                        for (let i = 0; i < 10; i++) {
                            await new Promise(r => setTimeout(r, 1_000));
                            const live = await findOwnHub();
                            const em = live ? await hubIdentity(live).catch(e => `err ${e.message}`) : 'no hub';
                            timeline.push({ at: Date.now() - t0, pid: live?.pid, email: em });
                            if (em === email) break;
                        }
                    } finally {
                        await writeKeychainJson(original);
                    }
                    // Put the hub back the same way, if the claim held.
                    const live = await findOwnHub();
                    if (live) await hubCall(live, 'GetAuthStatus').catch(() => '');
                    await new Promise(r => setTimeout(r, 1_500));
                    const after = live ? await hubIdentity(live).catch(e => `err ${e.message}`) : 'no hub';
                    result = { hubPid: hub.pid, before, target: email, timeline, restoredKeychain: await readAgyKeychainIdentity(), hubAfterRestore: after };
                    break;
                }
                case 'oauthProbe': {
                    // Issue #8 check without a browser: start a copy-mode flow,
                    // confirm the link reached the clipboard and the callback
                    // server is up, then hit it with a forged state and confirm
                    // the flow ends and the port closes. Restores the clipboard.
                    const auth = this.quotaManager.getAuthService();
                    const savedClipboard = await vscode.env.clipboard.readText();
                    auth.lastAuthUrl = '';
                    let outcome: unknown = 'pending';
                    const flow = auth.startOAuthFlow({ mode: 'copy' }).then(r => { outcome = r === null ? 'null' : 'tokens'; });
                    const t0 = Date.now();
                    while (!auth.lastAuthUrl && Date.now() - t0 < 5_000) await new Promise(r => setTimeout(r, 100));
                    const url = auth.lastAuthUrl;
                    const clip = await vscode.env.clipboard.readText();
                    const redirect = new URL(new URL(url).searchParams.get('redirect_uri') || 'http://x');
                    const hit = (q: string) => new Promise<number>(res => {
                        require('http').get(`http://127.0.0.1:${redirect.port}/callback?${q}`, (r: any) => { r.resume(); res(r.statusCode); })
                            .on('error', () => res(-1));
                    });
                    const forged = await hit('code=x&state=forged');
                    await Promise.race([flow, new Promise(r => setTimeout(r, 3_000))]);
                    const afterClose = await hit('code=x&state=again');
                    await vscode.env.clipboard.writeText(savedClipboard);
                    result = {
                        urlHost: url ? new URL(url).host : '', clipboardHasUrl: !!url && clip === url,
                        redirect: redirect.host, forgedCallbackStatus: forged, flowOutcome: outcome,
                        portAfterFinish: afterClose === -1 ? 'closed' : `still answering ${afterClose}`,
                    };
                    break;
                }
                case 'pollInterval': {
                    // Same path as the panel's picker; reports what is in effect.
                    if (cmd.args?.ms) this.quotaManager.setPollInterval(Number(cmd.args.ms));
                    result = { inEffect: this.quotaManager.getPollInterval() };
                    break;
                }
                case 'countRefresh': {
                    // Wraps refresh() for a while and records when it is called.
                    const qm = this.quotaManager as any;
                    const original = qm.refresh;
                    const t0 = Date.now();
                    const at: number[] = [];
                    qm.refresh = (...a: unknown[]) => { at.push(Math.round((Date.now() - t0) / 1000)); return original.apply(qm, a); };
                    try { await new Promise(r => setTimeout(r, Number(cmd.args?.seconds || 60) * 1000)); }
                    finally { qm.refresh = original; }
                    result = { seconds: Number(cmd.args?.seconds || 60), calls: at };
                    break;
                }
                case 'tabs': {
                    const { AG_DATA_DIR, STATE_DB_PATH } = require('../shared/agPaths');
                    result = { paths: { AG_DATA_DIR, STATE_DB_PATH }, ...this.quotaManager.getTabsSnapshot() };
                    break;
                }
                case 'refresh':
                    await this.quotaManager.refresh();
                    result = this.quotaManager.getDebugSnapshot();
                    break;
                case 'restartExtensionHost':
                    result = 'restarting';
                    after = () => { void vscode.commands.executeCommand('workbench.action.restartExtensionHost'); };
                    break;
                case 'reloadWindow':
                    result = 'reloading';
                    after = () => { void vscode.commands.executeCommand('workbench.action.reloadWindow'); };
                    break;
                default:
                    throw new Error(`unknown action ${cmd.action}`);
            }
        } catch (e) {
            ok = false;
            result = (e as Error)?.message || String(e);
        }
        const out = {
            id: cmd.id, action: cmd.action, instanceId: this.instanceId,
            workspace: this.workspaceName(), ok, result, startedAt, finishedAt: Date.now(),
        };
        try {
            fs.writeFileSync(path.join(DEV_ROOT, 'outbox', `${cmd.id}.${this.instanceId}.json`),
                JSON.stringify(out, null, 1), { mode: 0o600 });
        } catch (e) {
            log.warn('result write failed:', (e as Error)?.message);
        }
        if (after) setTimeout(after, 300);
    }

    private async state() {
        const uss = getUSS();
        let ussEmail = '';
        let oauthFp = '';
        if (uss) {
            const status = await uss.UserStatus.getUserStatus().catch(() => null);
            if (status) {
                try { ussEmail = extractStringField(Buffer.from(status, 'base64'), 7); } catch { /* unparsed */ }
            }
            const info: any = await uss.OAuthPreferences.getOAuthTokenInfo().catch(() => null);
            const refresh = typeof info === 'object' && info ? info.refreshToken : '';
            oauthFp = refresh ? tokenFingerprint(refresh) : (info ? 'unparsed' : 'none');
        }

        invalidateLsEndpointCache();
        const ca = loadLSCert();
        const servers: Array<{ pid?: string; port: number; global: boolean; email: string }> = [];
        for (const ep of await findLSEndpoints().catch(() => [])) {
            const body = await callLSEndpoint(ep, `${LS_SERVICE_PATH}/GetUserStatus`, ca, 2_000).catch(() => null);
            const st = body ? extractField(body, 1) : null;
            servers.push({ pid: ep.pid, port: ep.port, global: !!ep.isGlobal, email: st ? extractStringField(st, 7) : '' });
        }

        return {
            workspace: this.workspaceName(),
            build: this.buildStamp(),
            uss: { email: ussEmail, oauth: oauthFp },
            ide: { version: ideVersion(), legacy: isLegacyAntigravity() },
            agy: isAgyMode() ?{ fileEmail: readAgyIdentity(), keychainEmail: await readAgyKeychainIdentity() } : null,
            panel: this.quotaManager.getDebugSnapshot(),
            servers,
        };
    }
}
