import * as vscode from 'vscode';
import { GoogleAuthService } from './googleAuth';
import { SwitchAccountOptions, USSApi } from '../types';
import { getUSS } from '../utils/uss';
import {
    encodeString, encodeVarintField,
    encodeMessage, extractField, extractStringField,
} from '../shared/protobuf';
import { createLogger } from '../utils/logger';
import { dbExec } from '../shared/db';
import { findLSEndpoints, loadLSCert, callLSEndpoint, LsEndpoint } from '../utils/lsClient';
import { LS_SERVICE_PATH, RENEWAL_RETRY_DELAY_MS } from '../constants';

const log = createLogger('AccountSwitch');

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

    // ── LS Readiness Gate timing ──
    private static readonly LS_READY_MAX_WAIT_MS = 8_000;
    private static readonly LS_READY_POLL_INTERVAL_MS = 400;

    // ── Email Confirmation Polling timing ──
    private static readonly POLL_MAX_WAIT_MS = 12_000;
    private static readonly POLL_INTERVAL_MS = 800;
    private static readonly POLL_INITIAL_DELAY_MS = 300;

    constructor(_context: vscode.ExtensionContext, authService: GoogleAuthService) {
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

    async switchAccount(opts: SwitchAccountOptions): Promise<{ confirmed: boolean }> {
        const { email, name, accessToken, refreshToken, expiryTimestamp } = opts;

        // Bump generation FIRST — aborts any in-flight polling from previous switch
        this.switchGeneration++;
        const generation = this.switchGeneration;

        try {
            const uss = getUSS();
            if (!uss) {
                vscode.window.showErrorMessage('antigravityUnifiedStateSync API not available.');
                return { confirmed: false };
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

            // 4. handleAuthRefresh FIRST — fires IDE's createSession + sessionChangeEmitter.
            //    This propagates the new token context to LS via USS IPC notification,
            //    ensuring LS is aware of the new session BEFORE we call registerGdmUser.
            try {
                await vscode.commands.executeCommand('antigravity.handleAuthRefresh');
                log.info('handleAuthRefresh completed — session context propagated to LS');
            } catch (e: any) {
                log.warn('handleAuthRefresh failed (non-fatal):', e?.message);
            }

            // 5. Readiness Gate — wait for LS to confirm its USS IPC reconnect.
            //    Returns discovered endpoints so downstream functions don't need
            //    to re-discover (Gate-Once-Pass-Down pattern).
            //    handleAuthRefresh can temporarily kill LS — the gate retries
            //    endpoint discovery inside its loop until LS comes back.
            const { ready, endpoints } = await this.awaitLSReadiness();

            // 6. registerGdmUser — uses gate-provided endpoints (no independent discovery)
            await this.callRegisterGdmUser(endpoints);

            // 7. Await email confirmation from LS
            const result = await this.pollRichUserStatus(uss, generation, email, endpoints);
            if (!result.confirmed) {
                log.warn('Email confirmation timed out — LS may not have adopted the new email yet');
            }

            // 8. Schedule proactive token renewal before expiry
            this.scheduleTokenRenewal(refreshToken, expiryTimestamp, email);

            // 9. Toast reflects actual state — don't mislead the user
            if (result.confirmed) {
                vscode.window.showInformationMessage(`✅ Switched to ${email}`);
            } else {
                vscode.window.showWarningMessage(`⚠️ Switching to ${email} — model update may take a moment`);
            }
            return result;
        } catch (err: any) {
            vscode.window.showErrorMessage(`Failed to switch account: ${err?.message || err}`);
            log.error('Switch failed:', err);
            return { confirmed: false };
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

            await this.callRegisterGdmUser(await findLSEndpoints());

            log.info(`✅ Token renewed for ${this.activeEmail}, next in ~${Math.round((refreshed.expires_in || 3600) / 60) - 10}m`);

            this.scheduleTokenRenewal(this.activeRefreshToken, newExpiry, this.activeEmail);
        } catch (err: any) {
            log.error(`❌ Token renewal failed for ${this.activeEmail}:`, err?.message || err);
            // Retry in 2 minutes on transient failure
            this.renewalTimer = setTimeout(() => this.executeRenewal(), RENEWAL_RETRY_DELAY_MS);
        }
    }

    // ==================== LS Readiness Gate ====================

    /**
     * Readiness Gate — confirms LS has a working USS IPC channel.
     *
     * After IDE reload, the LS process reconnects to the new extension_server_port
     * asynchronously. Until this reconnect completes, registerGdmUser calls are
     * accepted (HTTP 200) but INEFFECTIVE — LS can't fetch the new token from USS,
     * so it silently uses stale credentials.
     *
     * This gate polls GetUserStatus; a non-empty response with an email field
     * proves the IPC channel is live. This is the Kubernetes Readiness Probe
     * pattern — don't send traffic until the target is ready.
     *
     * Gate-Once-Pass-Down: returns discovered endpoints so downstream functions
     * (registerGdmUser, pollRichUserStatus) don't need independent discovery.
     * Endpoint discovery is INSIDE the retry loop — handles LS temporarily
     * going down after handleAuthRefresh.
     */
    private async awaitLSReadiness(
        maxWaitMs = AccountSwitchService.LS_READY_MAX_WAIT_MS,
        intervalMs = AccountSwitchService.LS_READY_POLL_INTERVAL_MS,
    ): Promise<{ ready: boolean; endpoints: LsEndpoint[] }> {
        const ca = loadLSCert();
        const start = Date.now();

        while (Date.now() - start < maxWaitMs) {
            const endpoints = await findLSEndpoints();
            if (endpoints.length === 0) {
                log.info(`LS readiness gate: no endpoints yet (${Date.now() - start}ms), retrying...`);
                await delay(intervalMs);
                continue;
            }
            const ls = endpoints[0];

            try {
                const body = await callLSEndpoint(
                    ls,
                    `${LS_SERVICE_PATH}/GetUserStatus`,
                    ca,
                );
                const userStatus = body ? extractField(body, 1) : null;
                if (!userStatus || userStatus.length <= 5) { await delay(intervalMs); continue; }

                const email = extractStringField(userStatus, 7);
                if (!email) { await delay(intervalMs); continue; }

                log.info(`LS readiness gate: READY (email=${email}, ${Date.now() - start}ms, ${endpoints.length} LS)`);
                return { ready: true, endpoints };
            } catch (e: any) {
                log.info(`LS readiness gate: probe failed (${e?.message}), waiting...`);
            }
            await delay(intervalMs);
        }
        log.warn(`LS readiness gate: TIMEOUT after ${maxWaitMs}ms — proceeding best-effort`);
        return { ready: false, endpoints: [] };
    }

    // ==================== LS HTTP Communication ====================

    /**
     * Call RegisterGdmUser on provided LS endpoints.
     * Endpoints come from awaitLSReadiness (Gate-Once-Pass-Down) —
     * no independent discovery needed.
     */
    private async callRegisterGdmUser(lsEndpoints: LsEndpoint[]): Promise<void> {
        if (lsEndpoints.length === 0) {
            log.warn('registerGdmUser: no LS endpoints provided (gate returned empty)');
            return;
        }
        const ca = loadLSCert();
        const results = await Promise.allSettled(
            lsEndpoints.map(ls => callLSEndpoint(ls, `${LS_SERVICE_PATH}/RegisterGdmUser`, ca))
        );
        results.forEach((r, i) => {
            const ls = lsEndpoints[i];
            log.info(`registerGdmUser on port=${ls.port}: ${r.status === 'fulfilled' ? 'OK' : (r as PromiseRejectedResult).reason}`);
        });
    }

    /**
     * Adaptive poll: call GetUserStatus every INTERVAL, push to USS whenever
     * new data arrives (response grows), stop when email matches target AND
     * 2 consecutive stable reads, or MAX_WAIT is reached.
     *
     * When the target email is detected in LS response, fires onSwitchSettled
     * so quotaManager can trigger a refresh with real LS data.
     *
     * @param generation - Switch generation counter. If a newer switch starts,
     *   this.switchGeneration will increment and this loop will abort.
     * @param targetEmail - Expected email after switch. Used for early exit.
     */
    /**
     * @param initialEndpoints - Endpoints from awaitLSReadiness gate.
     *   Falls back to independent discovery if these go stale (CSRF rotation).
     */
    private async pollRichUserStatus(
        uss: USSApi,
        generation: number,
        targetEmail: string,
        initialEndpoints: LsEndpoint[],
        maxWaitMs = AccountSwitchService.POLL_MAX_WAIT_MS,
        intervalMs = AccountSwitchService.POLL_INTERVAL_MS,
    ): Promise<{ confirmed: boolean }> {
        let lsProcesses = initialEndpoints.length > 0 ? initialEndpoints : await findLSEndpoints();
        if (lsProcesses.length === 0) return { confirmed: false };
        const ca = loadLSCert();
        let ls = lsProcesses[0];

        let emailMatched = false;
        const targetNorm = targetEmail.toLowerCase();
        const start = Date.now();
        let pollCount = 0;

        await delay(AccountSwitchService.POLL_INITIAL_DELAY_MS);

        while (Date.now() - start < maxWaitMs) {
            if (generation !== this.switchGeneration) {
                log.info('Polling aborted — newer switch detected');
                return { confirmed: false };
            }

            pollCount++;
            try {
                const body = await callLSEndpoint(ls, `${LS_SERVICE_PATH}/GetUserStatus`, ca);
                const userStatus = body ? extractField(body, 1) : null;

                // ── FORENSIC: log every poll iteration ──
                const elapsed = Date.now() - start;
                const lsEmail = userStatus ? extractStringField(userStatus, 7) : '';
                log.info(`FORENSIC poll#${pollCount} @${elapsed}ms: bodyLen=${body?.length ?? 0} statusLen=${userStatus?.length ?? 0} email=${lsEmail || '(empty)'} target=${targetEmail} matched=${emailMatched}`);

                // Guard: skip if no useful status, already matched, or wrong email
                if (!userStatus || userStatus.length <= 5 || emailMatched) continue;
                if (!lsEmail || lsEmail.toLowerCase() !== targetNorm) continue;

                emailMatched = true;
                log.info(`FORENSIC EMAIL_MATCH @${elapsed}ms: statusLen=${userStatus.length}B — THIS is pushed to USS`);

                await this.pushUserStatusToUSS(uss, userStatus);
                await vscode.commands.executeCommand('antigravity.handleAuthRefresh');

                // Continue USS stabilization in background (profile pic, data growth)
                this.stabilizeUSS(uss, ls, ca, generation, userStatus.length, intervalMs, maxWaitMs - (Date.now() - start))
                    .catch(err => log.warn('USS stabilization error:', err?.message));

                return { confirmed: true };
            } catch (e: any) {
                const msg = e?.message || '';
                log.info(`FORENSIC poll#${pollCount} ERROR: ${msg}`);
                // CSRF token regenerated after registerGdmUser — re-discover endpoints
                if (msg.includes('401') || msg.includes('CSRF') || msg.includes('unauthenticated')) {
                    log.info('Poll: CSRF invalid, re-discovering LS endpoints');
                    lsProcesses = await findLSEndpoints();
                    if (lsProcesses.length > 0) ls = lsProcesses[0];
                } else {
                    log.warn('UserStatus poll iteration failed:', msg);
                }
            }

            await delay(intervalMs);
        }
        log.info(`Polling timed out after ${maxWaitMs}ms (emailMatched=${emailMatched})`);
        return { confirmed: emailMatched };
    }

    /**
     * Background USS stabilization — pushes incremental UserStatus updates
     * (profile pic, growing data) AFTER email is already confirmed.
     * Detached from the main switch flow.
     */
    private async stabilizeUSS(
        uss: USSApi, ls: any, ca: Buffer | undefined,
        generation: number, initialSize: number,
        intervalMs: number, remainingMs: number,
    ): Promise<void> {
        let lastSize = initialSize;
        let stableCount = 0;
        const start = Date.now();

        while (Date.now() - start < remainingMs) {
            if (generation !== this.switchGeneration) return;
            await delay(intervalMs);

            try {
                const body = await callLSEndpoint(ls, `${LS_SERVICE_PATH}/GetUserStatus`, ca);
                let userStatus = body ? extractField(body, 1) : null;
                if (!userStatus || userStatus.length <= 5) continue;

                // Append profile picture URL if available
                const profilePicUrl = await this.fetchProfilePicUrl(ls, ca);
                if (profilePicUrl) {
                    userStatus = Buffer.concat([userStatus, encodeString(38, profilePicUrl)]);
                }

                if (userStatus.length <= lastSize) {
                    stableCount++;
                    if (stableCount >= 2) { log.info(`USS stabilized at ${lastSize}B`); return; }
                    continue;
                }

                await this.pushUserStatusToUSS(uss, userStatus);
                await vscode.commands.executeCommand('antigravity.handleAuthRefresh');
                log.info(`USS stabilize: grew ${lastSize} → ${userStatus.length}B`);
                lastSize = userStatus.length;
                stableCount = 0;
            } catch (e: any) {
                log.warn('USS stabilize iteration failed:', e?.message);
            }
        }
    }

    private async fetchProfilePicUrl(ls: any, ca: Buffer | undefined): Promise<string> {
        try {
            const body = await callLSEndpoint(ls, `${LS_SERVICE_PATH}/GetProfileData`, ca);
            const url = body ? extractStringField(body, 1) : '';
            return url.length > 10 ? url : '';
        } catch { /* expected: profile endpoint may not be available */
            return '';
        }
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
     * Delegates to shared/db which: (1) creates a backup first, (2) uses cross-platform CLI args.
     */
    private writeAuthStatusToDb(name: string, email: string, apiKey: string): void {
        const proto = Buffer.concat([encodeVarintField(2, 1), encodeString(3, name), encodeString(7, email)]);
        const json = JSON.stringify({ name, apiKey, email, userStatusProtoBinaryBase64: proto.toString('base64') });

        const hexValue = Buffer.from(json, 'utf-8').toString('hex');
        const sql = `UPDATE ItemTable SET value = CAST(X'${hexValue}' AS TEXT) WHERE key = 'antigravityAuthStatus';`;

        dbExec(sql).catch(err => log.warn('Legacy DB write failed:', err?.message));
    }

    async testApiAccess(): Promise<boolean> {
        try {
            const uss = getUSS();
            if (!uss) return false;
            await uss.OAuthPreferences.getOAuthTokenInfo();
            return true;
        } catch { /* expected: process scan may fail during LS restart */
            return false;
        }
    }
}

// ==================== Standalone Helpers ====================
// These are pure functions / stateless utilities extracted from the class
// to reduce class size and improve testability.



function delay(ms: number): Promise<void> {
    return new Promise(r => setTimeout(r, ms));
}


// findActiveLanguageServers, loadLSCert, callLSEndpoint → moved to src/utils/lsClient.ts
