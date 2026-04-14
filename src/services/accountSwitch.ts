import * as vscode from 'vscode';
import { exec } from 'child_process';
import { promisify } from 'util';
import * as path from 'path';
import * as https from 'https';
import * as fs from 'fs';
import { GoogleAuthService } from './googleAuth';
import { SwitchAccountOptions, USSApi } from '../types';
import { LS_CERT_PATHS, LS_PROCESS_GREP } from '../constants';
import {
    encodeVarInt, encodeTag, encodeString, encodeVarintField,
    encodeMessage, extractField, extractStringField,
} from '../utils/protobuf';
import { createLogger } from '../utils/logger';
import { writeToStateDb } from '../utils/dbWriter';

const log = createLogger('AccountSwitch');

const execAsync = promisify(exec);

/**
 * AccountSwitchService — Programmatic IDE account switching (NO RELOAD)
 *
 * WHY HTTP calls are necessary (reverse-engineered from IDE source):
 *
 *   registerGdmUser (the call that makes LS fetch models + profile from backend)
 *   is ONLY called inside initializeAuthSession(), which runs ONCE during
 *   extension activation. Subsequent token changes (uss-oauth onDidChange)
 *   call handleAuthSessionChange(AuthenticationEvent) which does NOT call
 *   registerGdmUser. Therefore we MUST call it ourselves via HTTP.
 *
 * Token Renewal Strategy (Proactive Token Renewal):
 *   The LS binary caches its session token and does NOT auto-refresh on its own
 *   after our programmatic switch. IDE's main-process 5-min loop refreshes USS
 *   via google-auth-library, but the LS doesn't pick up USS changes.
 *
 *   Solution: schedule a proactive refresh 10 minutes before token expiry.
 *   Each cycle: refreshAccessToken → update USS → registerGdmUser on all LS.
 *   This is the production-standard "Proactive Token Renewal" pattern used by
 *   AWS SDK, Azure SDK, and google-auth-library's eagerRefreshThreshold.
 *
 * Flow:
 *   1. pushSerializedUpdateIPC → instant name/email in USS
 *   2. setOAuthTokenInfo       → uss-oauth topic update (minimal internal handling)
 *   3. handleAuthRefresh       → createSession → _sessionChangeEmitter (profile UI)
 *   4. HTTP registerGdmUser    → LS fetches models + profile from backend
 *   5. HTTP GetUserStatus      → read rich UserStatus from LS memory
 *   6. pushSerializedUpdateIPC → push rich UserStatus to USS → instant model selector + avatar
 *   7. scheduleTokenRenewal    → proactive renewal before expiry (keeps LS alive)
 */
export class AccountSwitchService {

    private readonly context: vscode.ExtensionContext;
    private readonly authService: GoogleAuthService;

    // Proactive Token Renewal state
    private renewalTimer: ReturnType<typeof setTimeout> | null = null;
    private activeRefreshToken: string | null = null;
    private activeEmail: string | null = null;

    // Race condition guard: monotonically increasing counter per switch call.
    // Polling loops check this to abort if a newer switch has started.
    private switchGeneration = 0;

    /** Buffer before expiry to trigger refresh (10 minutes in seconds) */
    private static readonly RENEWAL_BUFFER_SECS = 10 * 60;
    /** Minimum delay to prevent tight loops on clock skew (30 seconds) */
    private static readonly MIN_RENEWAL_DELAY_MS = 30_000;
    /** Maximum safe setTimeout delay — Node.js caps at 2^31-1 ms (~24.8 days) */
    private static readonly MAX_TIMEOUT_MS = 2_147_483_647;

    constructor(context: vscode.ExtensionContext, authService: GoogleAuthService) {
        this.context = context;
        this.authService = authService;
    }

    /** Clean up the renewal timer on extension deactivation */
    dispose(): void {
        if (this.renewalTimer) {
            clearTimeout(this.renewalTimer);
            this.renewalTimer = null;
        }
        this.switchGeneration++; // Abort any running polls
        this.activeRefreshToken = null;
        this.activeEmail = null;
        log.info('Token renewal stopped');
    }

    async switchAccount(opts: SwitchAccountOptions): Promise<boolean> {
        const { email, name, accessToken, refreshToken, expiryTimestamp } = opts;

        // Bump generation FIRST — aborts any in-flight polling from previous switch
        this.switchGeneration++;
        const generation = this.switchGeneration;

        try {
            const uss = getUSS();
            if (!uss) {
                vscode.window.showErrorMessage('antigravityUnifiedStateSync API not available.');
                return false;
            }

            // 1. Instant name/email display via USS
            await uss.pushSerializedUpdateIPC(this.buildUserStatusUpdate(name, email));

            // 2. Legacy auth status JSON (safe — no SQL injection, async to not block)
            this.writeAuthStatusToDb(name, email, accessToken);

            // 3. Set OAuth token — triggers internal uss-oauth subscriber
            //    (but this does NOT call registerGdmUser — see header comment)
            //    CRITICAL: use the REAL expiry timestamp, not a hardcoded +3600.
            //    IDE's google-auth-library uses this to decide when to auto-refresh.
            //    A wrong value causes auto-refresh to miss, leading to 401s.
            await uss.OAuthPreferences.setOAuthTokenInfo({
                accessToken,
                refreshToken,
                expiryDateSeconds: expiryTimestamp,
                tokenType: 'Bearer',
                isGcpTos: false,
            });

            // 4. Trigger _sessionChangeEmitter for profile UI
            await vscode.commands.executeCommand('antigravity.handleAuthRefresh');

            // 5. registerGdmUser on all LS → makes LS fetch models from backend
            await delay(500);
            await this.callRegisterGdmUserOnAllLS();

            // 6. Adaptive poll: fetch rich UserStatus from LS, push incrementally
            //    to USS as data arrives, stop when response stabilizes.
            //    Generation guard ensures this aborts if a newer switch starts.
            this.pollRichUserStatus(uss, generation).catch(err =>
                log.warn('UserStatus poll failed:', err?.message || err)
            );

            // 7. Schedule proactive token renewal before expiry
            //    This is the critical fix: LS binary caches its token and doesn't
            //    auto-refresh after our programmatic switch. We must proactively
            //    refresh and re-register before the token expires.
            this.scheduleTokenRenewal(refreshToken, expiryTimestamp, email);

            vscode.window.showInformationMessage(`✅ Switched to ${email}`);
            return true;
        } catch (err: any) {
            vscode.window.showErrorMessage(`Failed to switch account: ${err?.message || err}`);
            log.error('Switch failed:', err);
            return false;
        }
    }

    // ==================== Proactive Token Renewal ====================

    /**
     * Schedule next token refresh based on ACTUAL expiry.
     * Fires (expiryTimestamp - BUFFER) from now — much better than fixed interval.
     * After each renewal, re-schedules based on the new token's expiry (adaptive chain).
     */
    private scheduleTokenRenewal(refreshToken: string, expiryTimestamp: number, email: string): void {
        if (this.renewalTimer) {
            clearTimeout(this.renewalTimer);
            this.renewalTimer = null;
        }

        this.activeRefreshToken = refreshToken;
        this.activeEmail = email;

        const nowSecs = Math.floor(Date.now() / 1000);
        const renewAtSecs = expiryTimestamp - AccountSwitchService.RENEWAL_BUFFER_SECS;
        const delayMs = Math.min(
            Math.max((renewAtSecs - nowSecs) * 1000, AccountSwitchService.MIN_RENEWAL_DELAY_MS),
            AccountSwitchService.MAX_TIMEOUT_MS,
        );

        const delayMins = Math.round(delayMs / 60_000);
        log.info(`Token renewal scheduled in ${delayMins}m for ${email} (expiry in ${Math.round((expiryTimestamp - nowSecs) / 60)}m)`);

        this.renewalTimer = setTimeout(() => this.executeRenewal(), delayMs);
    }

    /**
     * Execute a single renewal cycle:
     *   1. Refresh the access_token via Google OAuth2
     *   2. Push new token to USS (so main process picks it up)
     *   3. Call registerGdmUser on all LS (so LS gets fresh credentials)
     *   4. Re-schedule for the new token's expiry
     */
    private async executeRenewal(): Promise<void> {
        if (!this.activeRefreshToken || !this.activeEmail) return;

        try {
            const refreshed = await this.authService.refreshAccessToken(this.activeRefreshToken);
            const newExpiry = Math.floor(Date.now() / 1000) + (refreshed.expires_in || 3600);

            // Capture rotated refresh_token if Google returns one
            if (refreshed.refresh_token) {
                this.activeRefreshToken = refreshed.refresh_token;
            }

            const uss = getUSS();
            if (uss) {
                await uss.OAuthPreferences.setOAuthTokenInfo({
                    accessToken: refreshed.access_token,
                    refreshToken: this.activeRefreshToken,
                    expiryDateSeconds: newExpiry,
                    tokenType: 'Bearer',
                    isGcpTos: false,
                });
            }

            await this.callRegisterGdmUserOnAllLS();

            log.info(`✅ Token renewed for ${this.activeEmail}, next in ~${Math.round((refreshed.expires_in || 3600) / 60) - 10}m`);

            this.scheduleTokenRenewal(this.activeRefreshToken, newExpiry, this.activeEmail);
        } catch (err: any) {
            log.error(`❌ Token renewal failed for ${this.activeEmail}:`, err?.message || err);
            // Retry in 2 minutes on transient failure
            this.renewalTimer = setTimeout(() => this.executeRenewal(), 2 * 60_000);
        }
    }

    // ==================== LS HTTP Communication ====================

    private async callRegisterGdmUserOnAllLS(): Promise<void> {
        const lsProcesses = await findActiveLanguageServers();
        if (lsProcesses.length === 0) {
            log.warn('No active LS processes found');
            return;
        }
        const ca = loadLSCert();
        const results = await Promise.allSettled(
            lsProcesses.map(ls => callLSEndpoint(ls, '/exa.language_server_pb.LanguageServerService/RegisterGdmUser', ca))
        );
        results.forEach((r, i) => {
            const ls = lsProcesses[i];
            log.info(`registerGdmUser on port=${ls.port}: ${r.status === 'fulfilled' ? 'OK' : (r as PromiseRejectedResult).reason}`);
        });
    }

    /**
     * Adaptive poll: call GetUserStatus every INTERVAL, push to USS whenever
     * new data arrives (response grows), stop when 2 consecutive stable reads
     * or MAX_WAIT is reached. Fire-and-forget from the main flow.
     *
     * @param generation - Switch generation counter. If a newer switch starts,
     *   this.switchGeneration will increment and this loop will abort.
     */
    private async pollRichUserStatus(uss: USSApi, generation: number, maxWaitMs = 12000, intervalMs = 1000): Promise<void> {
        const lsProcesses = await findActiveLanguageServers();
        if (lsProcesses.length === 0) return;
        const ca = loadLSCert();
        const ls = lsProcesses[0];

        let lastSize = 0;
        let stableCount = 0;
        const start = Date.now();

        await delay(1000); // Let LS begin fetching from backend

        while (Date.now() - start < maxWaitMs) {
            // Abort if a newer switch has started
            if (generation !== this.switchGeneration) {
                log.info('Polling aborted — newer switch detected');
                return;
            }

            try {
                const body = await callLSEndpoint(ls, '/exa.language_server_pb.LanguageServerService/GetUserStatus', ca);
                let userStatus = body ? extractField(body, 1) : null;

                if (userStatus && userStatus.length > 5) {
                    // Also fetch profile picture (field 38, NOT in GetUserStatus)
                    try {
                        const profileBody = await callLSEndpoint(ls, '/exa.language_server_pb.LanguageServerService/GetProfileData', ca);
                        const profilePicUrl = profileBody ? extractStringField(profileBody, 1) : '';
                        if (profilePicUrl.length > 10) {
                            userStatus = Buffer.concat([userStatus, encodeString(38, profilePicUrl)]);
                        }
                    } catch (e: any) {
                        log.warn('Profile picture fetch failed:', e?.message);
                    }

                    if (userStatus.length > lastSize) {
                        await this.pushUserStatusToUSS(uss, userStatus);
                        await vscode.commands.executeCommand('antigravity.handleAuthRefresh');
                        log.info(`UserStatus grew ${lastSize} → ${userStatus.length}B, pushed to USS`);
                        lastSize = userStatus.length;
                        stableCount = 0;
                    } else {
                        stableCount++;
                        if (stableCount >= 2) {
                            log.info(`UserStatus stable at ${lastSize}B — polling complete`);
                            return;
                        }
                    }
                }
            } catch (e: any) {
                log.warn('UserStatus poll iteration failed:', e?.message);
            }

            await delay(intervalMs);
        }
        log.info(`Polling timed out after ${maxWaitMs}ms (last=${lastSize}B)`);
    }

    // ==================== USS IPC ====================

    /** Wrap raw UserStatus proto bytes in USS UpdateRequest and push via IPC */
    private async pushUserStatusToUSS(uss: USSApi, userStatus: Buffer): Promise<void> {
        const row = encodeString(1, userStatus.toString('base64'));
        const update = Buffer.concat([
            encodeString(1, 'userStatusSentinelKey'),
            encodeMessage(2, row),
        ]);
        const req = Buffer.concat([
            encodeString(1, 'uss-userStatus'),
            encodeMessage(5, update),
        ]);
        await uss.pushSerializedUpdateIPC(req.toString('base64'));
    }

    private buildUserStatusUpdate(name: string, email: string): string {
        const proto = Buffer.concat([encodeVarintField(2, 1), encodeString(3, name), encodeString(7, email)]);
        const row = encodeString(1, proto.toString('base64'));
        const update = Buffer.concat([encodeString(1, 'userStatusSentinelKey'), encodeMessage(2, row)]);
        return Buffer.concat([encodeString(1, 'uss-userStatus'), encodeMessage(5, update)]).toString('base64');
    }

    // ==================== Legacy ====================

    /**
     * Write auth status to the IDE's state database (async — does not block extension host).
     * Uses hex-encoded JSON as SQLite X'...' blob to prevent SQL injection.
     * Delegates to dbWriter which: (1) creates a backup first, (2) uses cross-platform CLI args.
     */
    private writeAuthStatusToDb(name: string, email: string, apiKey: string): void {
        const proto = Buffer.concat([encodeVarintField(2, 1), encodeString(3, name), encodeString(7, email)]);
        const json = JSON.stringify({ name, apiKey, email, userStatusProtoBinaryBase64: proto.toString('base64') });

        const hexValue = Buffer.from(json, 'utf-8').toString('hex');
        const sql = `UPDATE ItemTable SET value = CAST(X'${hexValue}' AS TEXT) WHERE key = 'antigravityAuthStatus';`;

        // Delegate to dbWriter: backs up state.vscdb first, then writes cross-platform
        writeToStateDb(sql).catch(err => log.warn('Legacy DB write failed:', err?.message));
    }

    async testApiAccess(): Promise<boolean> {
        try {
            const uss = getUSS();
            if (!uss) return false;
            await uss.OAuthPreferences.getOAuthTokenInfo();
            return true;
        } catch {
            return false;
        }
    }
}

// ==================== Standalone Helpers ====================
// These are pure functions / stateless utilities extracted from the class
// to reduce class size and improve testability.

/** Typed accessor for USS — returns null if API not available */
function getUSS(): USSApi | null {
    return (vscode as any).antigravityUnifiedStateSync ?? null;
}

function delay(ms: number): Promise<void> {
    return new Promise(r => setTimeout(r, ms));
}

/**
 * Find active language server processes and return their HTTP port + CSRF token.
 * Uses ps on macOS/Linux, wmic on Windows — reads --https_server_port directly
 * from process args (faster than lsof; different from serverDiscovery which finds
 * the dynamically-assigned API port via TCP scan).
 */
async function findActiveLanguageServers(): Promise<Array<{ port: number; csrf: string }>> {
    try {
        let stdout: string;
        if (process.platform === 'win32') {
            ({ stdout } = await execAsync(
                `wmic process where "CommandLine like '%${LS_PROCESS_GREP}%'" get CommandLine /format:value 2>nul`,
                { timeout: 5000 }
            ));
        } else {
            ({ stdout } = await execAsync(
                `ps -A -ww -o args | grep "${LS_PROCESS_GREP}" | grep -v grep`,
                { timeout: 5000 }
            ));
        }
        return stdout.trim().split('\n').filter(Boolean).map(line => {
            const port = line.match(/--https_server_port[=\s]+(\d+)/)?.[1];
            const csrf = line.match(/--csrf_token[=\s]+([\w-]+)/)?.[1];
            return port && csrf ? { port: +port, csrf } : null;
        }).filter((x): x is { port: number; csrf: string } => x !== null);
    } catch {
        return [];
    }
}

/** Load LS TLS certificate for verified HTTPS calls */
function loadLSCert(): Buffer | undefined {
    const dynamicPath = path.join(path.dirname(require.main?.filename || ''), '..', 'languageServer', 'cert.pem');
    for (const p of [dynamicPath, ...LS_CERT_PATHS]) {
        try { return fs.readFileSync(p); } catch { /* try next */ }
    }
    return undefined;
}

/** Make a ConnectRPC-style POST to a language server endpoint */
function callLSEndpoint(ls: { port: number; csrf: string }, endpoint: string, ca?: Buffer): Promise<Buffer> {
    return new Promise((resolve, reject) => {
        const req = https.request({
            hostname: 'localhost',
            port: ls.port,
            path: endpoint,
            method: 'POST',
            headers: {
                'Content-Type': 'application/proto',
                'Connect-Protocol-Version': '1',
                'x-codeium-csrf-token': ls.csrf,
                'Content-Length': '0',
            },
            ...(ca ? { ca, rejectUnauthorized: true } : { rejectUnauthorized: false }),
        }, (res) => {
            const chunks: Buffer[] = [];
            res.on('data', (c: Buffer) => chunks.push(c));
            res.on('end', () => {
                const body = Buffer.concat(chunks);
                res.statusCode === 200 ? resolve(body) : reject(new Error(`HTTP ${res.statusCode}: ${body.toString()}`));
            });
        });
        req.on('error', reject);
        req.setTimeout(10000, () => req.destroy(new Error('timeout')));
        req.end();
    });
}
