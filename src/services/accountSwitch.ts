import * as vscode from 'vscode';
import { GoogleAuthService } from './googleAuth';
import { SwitchAccountOptions, USSApi } from '../types';
import { getUSS } from '../utils/uss';
import {
    encodeString, encodeVarintField,
    encodeMessage, extractField, extractStringField, stripFieldFromProtobuf,
} from '../shared/protobuf';
import { createLogger } from '../utils/logger';
import { tokenFingerprint } from '../utils/tokenFingerprint';
import { isAgyMode, writeAgyToken, readAgyKeychainIdentity, readAgyIdentity, snapshotAgyStore, restoreAgyStore } from './agyAuth';
import { agyState, findOwnHub, hubCall, hubIdentity } from './agyHub';
import { isLegacyAntigravity, buildSummary } from './ideBuild';
import { dbExec, dbGet } from '../shared/db';
import { findLSEndpoints, loadLSCert, callLSEndpoint, invalidateLsEndpointCache, LsEndpoint } from '../utils/lsClient';
import {
    LS_SERVICE_PATH, RENEWAL_RETRY_DELAY_MS,
    AG_CMD_AUTH_REFRESH,
} from '../constants';

const log = createLogger('AccountSwitch');

/** Legacy auth-status key — present in Antigravity 2.0.x and earlier, dropped in 2.5.x */
const LEGACY_AUTH_STATUS_KEY = 'antigravityAuthStatus';

/**
 * AccountSwitchService — Programmatic IDE account switching (no window reload)
 *
 * Antigravity has no account switcher of its own: the only supported path is
 * sign out and sign back in, which clears both the OAuth token and the cached
 * UserStatus and then restarts everything. This service reproduces the parts
 * of that sequence that matter, without dropping the window.
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
 * How the LS learns who you are (Antigravity 2.5.x, read from its extension.js):
 *   The extension host spawns the LS and writes the OAuth access token from
 *   USS to its stdin. Every second it recomputes the LS launch inputs, which
 *   include the email parsed from USS UserStatus; when that email changes it
 *   kills the LS and spawns a new one. So the IDE's own switch is: token into
 *   USS, then email into USS. Measured: restart ~0.5s after the email write,
 *   new LS authenticated ~1s later, every open window restarts at once.
 *
 *   A running LS can also re-key in place without a restart, but on its own
 *   clock (measured 5s to 54s). Earlier versions of this service waited for
 *   that and only wrote the email once it landed, which is why switching took
 *   half a minute.
 *
 *   The workspace instance is the authority for confirmation: it serves this
 *   window's chat. The main-process instance (no --workspace_id) is not
 *   restarted by the email change and can lag.
 *
 * Flow:
 *   1. setOAuthTokenInfo       → new token into USS (read by the next spawn)
 *   2. writeAuthStatusToDb     → legacy key, older builds only
 *   3. UserStatus email → USS  → IDE restarts the LS on the new account
 *   4. handleAuthRefresh       → profile UI
 *   5. Readiness gate          → some instance reachable
 *   6. HTTP registerGdmUser    → matches what the IDE does post-spawn
 *   7. HTTP GetUserStatus      → poll until the workspace LS reports the target
 *   8. pushSerializedUpdateIPC → push the LS's rich UserStatus to USS
 *   9. watchForLateAdoption    → detached; covers adoption past the wait
 *  10. scheduleTokenRenewal    → proactive renewal before expiry
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

    /** Refresh-token fingerprint → account it was verified to belong to. */
    private readonly verifiedOwners = new Map<string, string>();

    /** Buffer before expiry to trigger refresh (10 minutes in seconds) */
    private static readonly RENEWAL_BUFFER_SECS = 10 * 60;
    /** Minimum delay to prevent tight loops on clock skew (30 seconds) */
    private static readonly MIN_RENEWAL_DELAY_MS = 30_000;
    /** Maximum safe setTimeout delay — Node.js caps at 2^31-1 ms (~24.8 days) */
    private static readonly MAX_TIMEOUT_MS = 2_147_483_647;

    // ── LS Readiness Gate timing ──
    /**
     * The gate only proves some LS is reachable before the adoption wait starts.
     * The restart triggered by the email write takes 2-3s, and instances that
     * are not restarted answer immediately, so this ceiling is only reached
     * when the IDE itself is still coming up.
     */
    private static readonly LS_READY_MAX_WAIT_MS = 8_000;
    private static readonly LS_READY_POLL_INTERVAL_MS = 400;

    // ── Email Confirmation Polling timing ──
    /**
     * How long to wait before telling the user anything. With the email write
     * driving a restart, adoption is expected in ~3s; the ceiling stays wide
     * for machines where the LS boots slowly. Beyond it the detached watch
     * takes over.
     */
    private static readonly POLL_MAX_WAIT_MS = 60_000;
    private static readonly POLL_INTERVAL_MS = 800;
    private static readonly POLL_INITIAL_DELAY_MS = 300;
    /**
     * How often to re-issue registerGdmUser while polling. Cheap, and its
     * effect on adoption is unproven — so a slow cadence rather than a tight
     * retry loop pretending it is the mechanism.
     */
    private static readonly REGISTER_RETRY_MS = 4_000;
    /**
     * Minimum gap between endpoint re-discoveries while polling. Discovery is
     * fired without awaiting, so this bounds how often it starts, not how long
     * the loop waits.
     */
    private static readonly REDISCOVER_MIN_INTERVAL_MS = 2_000;
    /**
     * Detached watch that outlives the foreground wait. Sized from field
     * reports where adoption landed around two minutes on Windows; costs one
     * request per instance every few seconds and stops on the first match or
     * as soon as a newer switch supersedes it.
     */
    private static readonly LATE_ADOPT_MAX_WAIT_MS = 120_000;
    private static readonly LATE_ADOPT_INTERVAL_MS = 3_000;
    /** Settle time before a late match is believed — see the recheck. */
    private static readonly LATE_ADOPT_CONFIRM_MS = 2_500;
    /** Consecutive stabilize failures tolerated before the loop gives up. */
    private static readonly STABILIZE_MAX_FAILURES = 3;
    /**
     * Per-request timeout inside the poll loop. Must stay well under the poll
     * interval: the loop walks every endpoint sequentially, so at the default
     * 10s request timeout a single hung socket — routine while the LS restarts
     * mid-switch — stretched one iteration to 10s, or 20s with two endpoints.
     */
    private static readonly POLL_REQUEST_TIMEOUT_MS = 2_000;
    /**
     * Cadence and cap for re-broadcasting the credentials while polling. The
     * first round lands once the IDE's restart of the workspace LS (~2s) has
     * produced servers that are subscribed and listening.
     */
    private static readonly REASSERT_INTERVAL_MS = 2_500;
    private static readonly MAX_REASSERTS = 12;

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

    async switchAccount(opts: SwitchAccountOptions): Promise<{ confirmed: boolean; alreadyActive?: boolean; superseded?: boolean }> {
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

            // 0. Make sure the stored token really is this account's. The IDE
            //    takes identity from the token, not from the email we announce,
            //    so a token filed under the wrong account switches the IDE to
            //    someone else while the panel claims success.
            const fp = tokenFingerprint(refreshToken);
            const owner = this.verifiedOwners.get(fp) ?? await this.authService.fetchUserInfo(accessToken)
                .then(u => u.email).catch(() => '');
            if (owner) this.verifiedOwners.set(fp, owner);
            log.info(`Switch → ${email}: token owner=${owner || 'unverified'} refresh=${tokenFingerprint(refreshToken)}`);
            if (owner && owner.toLowerCase() !== email.toLowerCase()) {
                vscode.window.showErrorMessage(
                    `The saved token for ${email} belongs to ${owner}. Re-add ${email} to fix it.`);
                return { confirmed: false };
            }

            if (isAgyMode()) {
                return await this.switchAgy(opts, generation, uss);
            }
            if (isLegacyAntigravity()) {
                return await this.switchLegacy(opts, generation, uss);
            }

            // 1. Credentials first. This is the value the language server reads
            //    when it re-keys, so nothing that might wake it should land
            //    before it — the previous order announced the new email while
            //    the old token was still the one on file.
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
            const readBack = await uss.OAuthPreferences.getOAuthTokenInfo().catch(() => null);
            log.info(`USS oauth read-back: ${readBack ? 'present' : 'empty'}`);

            // 2. Legacy auth status JSON (safe — no SQL injection, async to not block)
            this.writeAuthStatusToDb(name, email, accessToken)
                .catch(err => log.warn('Legacy DB write failed:', err?.message));

            // 3. Announce the new identity in USS — this is what actually
            //    switches the IDE.
            //
            //    Antigravity 2.5.x re-derives each language server's launch
            //    inputs once a second (LanguageServerManager.maybeUpdate) and
            //    one of those inputs is the email parsed out of USS UserStatus.
            //    When it differs, the extension host restarts its LS, and the
            //    replacement reads the OAuth token from USS at spawn. Measured:
            //    restart within ~0.5s of the write, "Auth succeeded" ~1s later,
            //    fully up in 2-3s, in every open window at once.
            //
            //    Without this write the running LS has to re-key itself on its
            //    own schedule — measured 5s to 54s — and the restart only came
            //    once our poll matched and pushed the rich record, i.e. at the
            //    very end. That wait was the whole of the slow switch.
            //
            //    Token first (step 1), then email: a restart triggered before
            //    the token lands would come up on the previous account.
            //
            //    The record written is the current one with name and email
            //    replaced, not a bare stub. The model picker reads this record
            //    straight out of USS, and a three-field stub is what emptied it
            //    ("No models available") whenever the confirmation poll failed
            //    to put the real one back.
            const priorStatus = await uss.UserStatus.getUserStatus().catch(() => '');
            const priorBytes = decodeUserStatus(priorStatus);
            const priorEmail = priorBytes ? extractStringField(priorBytes, 7) : '';

            // Already there: USS and every workspace server name the target.
            // Checked before the write, because afterwards the restarted
            // servers would report the target and every switch would look like
            // a no-op. A single agreeing server is not enough: the global one
            // routinely is while the workspace ones sit on a stale account, and
            // re-running the flow below is exactly what repairs that.
            if (priorEmail.toLowerCase() === email.toLowerCase()) {
                const ids = await this.probeIdentities(await findLSEndpoints());
                const ws = ids.filter(i => !i.isGlobal);
                const pool = ws.length > 0 ? ws : ids;
                if (pool.length > 0 && pool.every(i => i.email.toLowerCase() === email.toLowerCase())) {
                    log.info(`${email} is already the active account on every LS — nothing to switch`);
                    this.scheduleTokenRenewal(refreshToken, expiryTimestamp, email);
                    vscode.window.showInformationMessage(`Already on ${email}`);
                    return { confirmed: true, alreadyActive: true };
                }
                log.info(`USS already names ${email} but LS report [${ids.map(i => i.email).join(', ')}] — re-running the switch to repair`);
            }

            const base = priorBytes
                ? stripFieldFromProtobuf(stripFieldFromProtobuf(priorBytes, 3), 7)
                : encodeVarintField(2, 1);
            const patched = Buffer.concat([base, encodeString(3, name), encodeString(7, email)]);
            // Same content, different bytes — see the re-broadcast below.
            const patchedAlt = Buffer.concat([base, encodeString(7, email), encodeString(3, name)]);
            await this.pushUserStatusToUSS(uss, patched);
            log.info(`USS userStatus → ${email} (${priorBytes ? 'patched existing record' : 'no prior record, minimal'}; was ${priorEmail || 'empty'})`);

            // 4. Nudge the IDE's own auth path (profile UI). Cheap, harmless.
            try {
                await vscode.commands.executeCommand(AG_CMD_AUTH_REFRESH);
            } catch (e: any) {
                log.warn(`${AG_CMD_AUTH_REFRESH} failed (non-fatal):`, e?.message);
            }

            // 5. Readiness Gate — confirm some LS is reachable and hand the
            //    endpoints down. The restart from step 3 may be in progress;
            //    the poll rediscovers as the replacements come up.
            const { endpoints, email: staleEmail } = await this.awaitLSReadiness();

            // 6. registerGdmUser — uses gate-provided endpoints (no independent discovery)
            await this.callRegisterGdmUser(endpoints);

            // 7. Await confirmation, re-broadcasting the credentials while we
            //    wait. This is the step that actually lands the switch.
            //
            //    A freshly spawned LS asks its window's extension host for the
            //    uss-oauth and uss-userStatus topics. The extension host answers
            //    with the snapshot it took when the window opened, not current
            //    state, and then forwards only updates made after that. Probed
            //    directly on 2026-10-15: every restarted LS was handed the token
            //    of whichever account was active when its window opened (Oct 10
            //    or Oct 12), so the restart put each window on a different stale
            //    account and the write we had just made never reached them.
            //
            //    A new write after the restart does reach them as a live update.
            //    It has to differ from the last one, so each round shifts the
            //    expiry by a second and swaps the field order of the identical
            //    UserStatus record. Same token, same account, new update.
            let rebroadcasts = 0;
            const reassert = async () => {
                rebroadcasts++;
                await uss.OAuthPreferences.setOAuthTokenInfo({
                    accessToken, refreshToken,
                    expiryDateSeconds: expiryTimestamp - rebroadcasts,
                    tokenType: 'Bearer', isGcpTos: false,
                });
                await this.pushUserStatusToUSS(uss, rebroadcasts % 2 ? patchedAlt : patched);
            };

            const result = await this.pollRichUserStatus(
                uss, generation, email, endpoints, staleEmail, reassert,
            );

            // A superseded switch must stay silent. The switch that replaced it
            // owns the outcome and raises its own toast; warning here made a
            // double-click look like a failure while the real switch was still
            // in flight and about to succeed.
            if (result.superseded) {
                log.info(`Switch to ${email} superseded by a newer switch — no toast, no renewal`);
                return { confirmed: false, superseded: true };
            }

            if (!result.confirmed) {
                log.warn('Email confirmation timed out — LS may not have adopted the new email yet');
            }

            // 8. Schedule proactive token renewal before expiry
            this.scheduleTokenRenewal(refreshToken, expiryTimestamp, email);

            // 9. Toast reflects actual state — don't mislead the user
            if (result.confirmed) {
                vscode.window.showInformationMessage(`✅ Switched to ${email}`);
            } else {
                // Not a failure: the detached watch is still on it and will
                // announce the switch when it lands. Phrasing this as a warning
                // read as "it didn't work" on switches that completed moments
                // later.
                vscode.window.showInformationMessage(`Switching to ${email} — the language server is still catching up, models will update on their own`);
            }
            return result;
        } catch (err: any) {
            vscode.window.showErrorMessage(`Failed to switch account: ${err?.message || err}`);
            log.error('Switch failed:', err);
            return { confirmed: false };
        }
    }

    // ==================== Antigravity 2.6 (agent hubs) ====================

    private static readonly AGY_POLL_MS = 500;
    private static readonly AGY_MAX_WAIT_MS = 60_000;
    /** Windows/Linux: how long this window's hub gets to take the account before it is put back. */
    private static readonly AGY_VERIFY_MS = 10_000;

    /**
     * 2.6 switch: store the account where the hubs read it, then let every
     * window's AgyHubKeeper restart its own hub onto it (see agyHub.ts), and
     * confirm once every hub reports the target.
     */
    private async switchAgy(opts: SwitchAccountOptions, generation: number, uss: USSApi)
        : Promise<{ confirmed: boolean; alreadyActive?: boolean; superseded?: boolean }> {
        const { email, name, accessToken, refreshToken, expiryTimestamp } = opts;
        const target = email.toLowerCase();
        const ca = loadLSCert();

        const probe = async () => {
            invalidateLsEndpointCache();
            const out: Array<{ ep: LsEndpoint; email: string; status: Buffer }> = [];
            for (const ep of await findLSEndpoints()) {
                const body = await callLSEndpoint(ep, `${LS_SERVICE_PATH}/GetUserStatus`, ca,
                    AccountSwitchService.POLL_REQUEST_TIMEOUT_MS).catch(() => null);
                const status = body ? extractField(body, 1) : null;
                if (status) out.push({ ep, email: extractStringField(status, 7).toLowerCase(), status });
            }
            return out;
        };

        const stored = ((await readAgyKeychainIdentity()) || readAgyIdentity()).toLowerCase();
        const before = await probe();
        if (stored === target && before.length > 0 && before.every(h => h.email === target)) {
            log.info(`${email} is already the account of every hub — nothing to switch`);
            this.scheduleTokenRenewal(refreshToken, expiryTimestamp, email);
            vscode.window.showInformationMessage(`Already on ${email}`);
            return { confirmed: true, alreadyActive: true };
        }

        // The Windows and Linux store layouts follow go-keyring's source but
        // have not been run against a real hub. Keep what is there now, and
        // if this window's hub does not take the new account, put it back
        // rather than leave a store the hubs might not be able to read.
        const snapshot = process.platform === 'darwin' ? null : await snapshotAgyStore();

        const start = Date.now();
        await writeAgyToken({ email, accessToken, refreshToken, expiryTimestamp });
        log.info(`agy: stored ${email} (was ${stored || 'none'}); hubs [${before.map(h => h.email).join(', ')}]`);

        if (snapshot) {
            let own = await findOwnHub();
            let now = '';
            if (own) {
                await hubCall(own, 'GetAuthStatus').catch(e => log.warn('agy: GetAuthStatus failed:', e?.message));
                const t0 = Date.now();
                while (Date.now() - t0 < 4_000) {
                    now = (await hubIdentity(own).catch(() => '')).toLowerCase();
                    if (now === target) break;
                    await delay(AccountSwitchService.AGY_POLL_MS);
                }

                // If GetAuthStatus didn't switch the running hub (e.g. agy 1.5.3 or Windows where
                // in-process reload is not triggered by GetAuthStatus), trigger Restart RPC.
                // The IDE respawns the hub cleanly on the newly stored credentials.
                if (now !== target) {
                    log.info(`agy: hub stayed on ${now || 'none'} after GetAuthStatus — requesting Restart RPC`);
                    await hubCall(own, 'Restart').catch(() => { /* exits mid-reply */ });
                    const tRestart = Date.now();
                    while (Date.now() - tRestart < 8_000) {
                        await delay(AccountSwitchService.AGY_POLL_MS);
                        const freshOwn = await findOwnHub();
                        if (freshOwn && freshOwn.pid !== own.pid) {
                            own = freshOwn;
                            now = (await hubIdentity(own).catch(() => '')).toLowerCase();
                            if (now === target) break;
                        }
                    }
                }
            }
            if (now !== target) {
                log.warn(`agy: this window's hub ${own ? `stayed on ${now || '(no answer)'}` : 'was not found'} on ${buildSummary()} — restoring the previous account`);
                await restoreAgyStore(snapshot).catch(e => log.error('agy: restore failed:', e?.message));
                this.offerReport(`Switching accounts is not working on ${buildSummary()} yet. Nothing was changed.`,
                    `This window's hub ${own ? `stayed on its account` : 'was not found'} after the account was written to the credential store.`);
                return { confirmed: false };
            }
            log.info(`agy: this window's hub took ${email} in ${Date.now() - start}ms (${process.platform})`);
        }

        // Keep USS in step for anything in the IDE still reading it. The hubs
        // ignore it, so failures here do not affect the switch.
        try {
            await uss.OAuthPreferences.setOAuthTokenInfo({
                accessToken, refreshToken, expiryDateSeconds: expiryTimestamp, tokenType: 'Bearer', isGcpTos: false,
            });
        } catch (e: any) { log.warn('agy: USS token write failed:', e?.message); }

        agyState.switching = true;
        try {
            const ownPid = (await findOwnHub())?.pid;
            let noOtherHubsCount = 0;
            while (Date.now() - start < AccountSwitchService.AGY_MAX_WAIT_MS) {
                if (generation !== this.switchGeneration) return { confirmed: false, superseded: true };
                // Another window switched after us: the store names someone else.
                if (readAgyIdentity().toLowerCase() !== target) {
                    log.info(`agy: switch to ${email} superseded by ${readAgyIdentity()} from another window`);
                    return { confirmed: false, superseded: true };
                }
                await delay(AccountSwitchService.AGY_POLL_MS);
                const hubs = await probe();
                // This window's hub moves only once the extension host restarts,
                // which waits for us — so do not wait for it.
                const relevant = agyState.hostRestartPending ? hubs.filter(h => h.ep.pid !== ownPid) : hubs;
                if (relevant.length > 0 && relevant.every(h => h.email === target)) {
                    log.info(`agy: every hub on ${email} after ${Date.now() - start}ms`);
                    await this.pushUserStatusToUSS(uss, hubs[0].status).catch(() => { /* cosmetic */ });
                    this.scheduleTokenRenewal(refreshToken, expiryTimestamp, email);
                    vscode.window.showInformationMessage(`✅ Switched to ${email}`);
                    return { confirmed: true };
                }

                // If own hub is already verified on target, and no other hubs exist across consecutive probes
                // (e.g. single window setup, or other hubs have already exited)
                if (relevant.length === 0 && (!before.length || before.every(h => h.ep.pid === ownPid))) {
                    noOtherHubsCount++;
                    if (noOtherHubsCount >= 8) { // ~2 seconds of stability
                        log.info(`agy: single hub verified on ${email} after ${Date.now() - start}ms`);
                        this.scheduleTokenRenewal(refreshToken, expiryTimestamp, email);
                        vscode.window.showInformationMessage(`✅ Switched to ${email}`);
                        return { confirmed: true };
                    }
                } else {
                    noOtherHubsCount = 0;
                }
            }
        } finally {
            agyState.switching = false;
        }
        log.warn(`agy: hubs not all on ${email} after ${AccountSwitchService.AGY_MAX_WAIT_MS}ms on ${buildSummary()}`);
        this.scheduleTokenRenewal(refreshToken, expiryTimestamp, email);
        // A minute without every hub moving is not a slow switch: on tested
        // builds it lands in 2-3s. The likeliest cause is an Antigravity or
        // agy update that changed how hubs take the account, so say so and
        // make the report carry the versions.
        this.offerReport(`Switching to ${email} has not reached every window after a minute. ${buildSummary()} may not be supported yet.`,
            'A switch did not reach every window within 60 s.');
        return { confirmed: false };
    }

    /** Warning with a button that opens an issue prefilled with the build (no account data). */
    private offerReport(message: string, detail: string): void {
        void vscode.window.showWarningMessage(message, 'Report issue').then(choice => {
            if (choice !== 'Report issue') return;
            const version = vscode.extensions.getExtension('erennyuksell.ag-multi-account-switchboard')?.packageJSON.version ?? '?';
            const body = `**Build:** ${buildSummary()}\n**Extension:** ${version}\n\n${detail}`;
            void vscode.env.openExternal(vscode.Uri.parse(
                `https://github.com/erennyuksell/ag-multi-account-switchboard/issues/new?title=${encodeURIComponent('Switch not working on ' + buildSummary())}&body=${encodeURIComponent(body)}`));
        });
    }

    // ==================== Antigravity before 2.5 ====================

    private static readonly LEGACY_POLL_MAX_WAIT_MS = 12_000;

    /**
     * The 3.2.1 switch, kept for builds before Antigravity IDE 2.5 (see
     * ideBuild.ts). The flow in switchAccount was reworked against 2.5 and
     * never run on these builds; this one shipped on them.
     *
     * Differences from 3.2.1, all fixes that hold on any build: the poll waits
     * between reads instead of spinning on the LS, a superseded switch stays
     * silent, and stabilizeUSS stops rather than push another account.
     * Discovery now also returns the global LS, which 3.2.1 could not see, so
     * it is filtered out here to watch the same instances 3.2.1 did.
     */
    private async switchLegacy(opts: SwitchAccountOptions, generation: number, uss: USSApi)
        : Promise<{ confirmed: boolean; superseded?: boolean }> {
        const { email, name, accessToken, refreshToken, expiryTimestamp } = opts;
        log.info(`Switch → ${email}: pre-2.5 Antigravity, 3.2.1 flow`);

        // 1. Instant name/email display via USS
        await this.pushUserStatusToUSS(uss,
            Buffer.concat([encodeVarintField(2, 1), encodeString(3, name), encodeString(7, email)]));

        // 2. Legacy auth status JSON, read by these builds
        this.writeAuthStatusToDb(name, email, accessToken)
            .catch(err => log.warn('Legacy DB write failed:', err?.message));

        // 3. Set OAuth token, with the real expiry
        await uss.OAuthPreferences.setOAuthTokenInfo({
            accessToken, refreshToken, expiryDateSeconds: expiryTimestamp, tokenType: 'Bearer', isGcpTos: false,
        });

        // 4. handleAuthRefresh — propagates the new session to the LS before registerGdmUser
        try {
            await vscode.commands.executeCommand(AG_CMD_AUTH_REFRESH);
        } catch (e: any) {
            log.warn(`${AG_CMD_AUTH_REFRESH} failed (non-fatal):`, e?.message);
        }

        // 5-6. Readiness gate, then registerGdmUser on the endpoints it found
        const { endpoints } = await this.awaitLSReadiness();
        const workspaceEndpoints = workspaceOnly(endpoints);
        await this.callRegisterGdmUser(workspaceEndpoints);

        // 7. Await email confirmation from LS
        const result = await this.pollLegacy(uss, generation, email, workspaceEndpoints);
        if (result.superseded) {
            log.info(`Switch to ${email} superseded by a newer switch — no toast, no renewal`);
            return result;
        }
        if (!result.confirmed) {
            log.warn('Email confirmation timed out — LS may not have adopted the new email yet');
        }

        // 8. Schedule proactive token renewal before expiry
        this.scheduleTokenRenewal(refreshToken, expiryTimestamp, email);

        // 9. Toast reflects actual state
        if (result.confirmed) {
            vscode.window.showInformationMessage(`✅ Switched to ${email}`);
        } else {
            vscode.window.showWarningMessage(`⚠️ Switching to ${email} — model update may take a moment`);
        }
        return result;
    }

    /** 3.2.1's confirmation poll: one workspace LS, 12s, push on the first match. */
    private async pollLegacy(
        uss: USSApi, generation: number, targetEmail: string, initialEndpoints: LsEndpoint[],
    ): Promise<{ confirmed: boolean; superseded?: boolean }> {
        let lsProcesses = initialEndpoints.length > 0 ? initialEndpoints : workspaceOnly(await findLSEndpoints());
        if (lsProcesses.length === 0) return { confirmed: false };
        const ca = loadLSCert();
        let ls = lsProcesses[0];
        const targetNorm = targetEmail.toLowerCase();
        const maxWaitMs = AccountSwitchService.LEGACY_POLL_MAX_WAIT_MS;
        const intervalMs = AccountSwitchService.POLL_INTERVAL_MS;
        const start = Date.now();

        await delay(AccountSwitchService.POLL_INITIAL_DELAY_MS);

        while (Date.now() - start < maxWaitMs) {
            if (generation !== this.switchGeneration) {
                log.info('Polling aborted — newer switch detected');
                return { confirmed: false, superseded: true };
            }
            try {
                const body = await callLSEndpoint(ls, `${LS_SERVICE_PATH}/GetUserStatus`, ca);
                const userStatus = body ? extractField(body, 1) : null;
                const lsEmail = userStatus ? extractStringField(userStatus, 7) : '';
                if (userStatus && userStatus.length > 5 && lsEmail.toLowerCase() === targetNorm) {
                    log.info(`EMAIL_MATCH @${Date.now() - start}ms on :${ls.port} — pushing to USS`);
                    await this.pushUserStatusToUSS(uss, userStatus);
                    await vscode.commands.executeCommand(AG_CMD_AUTH_REFRESH);
                    this.stabilizeUSS(uss, ls, ca, generation, userStatus.length, intervalMs,
                        maxWaitMs - (Date.now() - start), targetEmail)
                        .catch(err => log.warn('USS stabilization error:', err?.message));
                    return { confirmed: true };
                }
            } catch (e: any) {
                const msg = e?.message || '';
                // CSRF token regenerated after registerGdmUser — re-discover endpoints
                if (msg.includes('401') || msg.includes('CSRF') || msg.includes('unauthenticated')) {
                    invalidateLsEndpointCache();
                    lsProcesses = workspaceOnly(await findLSEndpoints());
                    if (lsProcesses.length > 0) ls = lsProcesses[0];
                } else {
                    log.warn('UserStatus poll iteration failed:', msg);
                }
            }
            // 3.2.1 skipped this on a non-matching read and spun on the LS.
            await delay(intervalMs);
        }
        log.info(`Polling timed out after ${maxWaitMs}ms`);
        return { confirmed: false };
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
        // 2.6 hubs refresh their own token from the stored refresh token. A
        // renewal timer here would only keep writing this window's last
        // account into USS after another window switched elsewhere.
        if (isAgyMode()) return;

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
     * Readiness Gate — waits for an LS that answers.
     *
     * Discovery lives inside the loop because instances come and go: the IDE
     * restarts them on its own schedule, and a new one listens on a different
     * port with a different CSRF token.
     *
     * Passing the gate proves an LS is *reachable*, not that it adopted the new
     * identity. The email it reports here is usually still the old account —
     * often from the main-process LS, which this restart does not touch. It is
     * returned so the caller can tell adoption from mere reachability.
     *
     * Gate-Once-Pass-Down: returns discovered endpoints so downstream functions
     * (registerGdmUser, pollRichUserStatus) don't need independent discovery.
     */
    private async awaitLSReadiness(
        maxWaitMs = AccountSwitchService.LS_READY_MAX_WAIT_MS,
        intervalMs = AccountSwitchService.LS_READY_POLL_INTERVAL_MS,
    ): Promise<{ ready: boolean; endpoints: LsEndpoint[]; email: string }> {
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

                log.info(`LS readiness gate: REACHABLE (current identity=${email}, ${Date.now() - start}ms, ${endpoints.length} LS)`);
                return { ready: true, endpoints, email };
            } catch (e: any) {
                log.info(`LS readiness gate: probe failed (${e?.message}), waiting...`);
            }
            await delay(intervalMs);
        }
        log.warn(`LS readiness gate: TIMEOUT after ${maxWaitMs}ms — proceeding best-effort`);
        return { ready: false, endpoints: [], email: '' };
    }

    /** Ask every endpoint which account it is on. Unreachable ones are skipped. */
    private async probeIdentities(endpoints: LsEndpoint[]): Promise<Array<{ email: string; isGlobal: boolean }>> {
        const ca = loadLSCert();
        const out: Array<{ email: string; isGlobal: boolean }> = [];
        for (const ep of endpoints) {
            const body = await callLSEndpoint(ep, `${LS_SERVICE_PATH}/GetUserStatus`, ca,
                AccountSwitchService.POLL_REQUEST_TIMEOUT_MS).catch(() => null);
            const status = body ? extractField(body, 1) : null;
            const email = status ? extractStringField(status, 7) : '';
            if (email) out.push({ email, isGlobal: !!ep.isGlobal });
        }
        return out;
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
     * @param previousEmail - Identity the LS still reported at the gate.
     *   Used only to spot the anomalous case where the LS adopts some third
     *   account instead of the requested one.
     */
    private async pollRichUserStatus(
        uss: USSApi,
        generation: number,
        targetEmail: string,
        initialEndpoints: LsEndpoint[],
        previousEmail = '',
        /** Re-push the new credentials to the IDE. See the retry block for why. */
        reassert?: () => Promise<void>,
        maxWaitMs = AccountSwitchService.POLL_MAX_WAIT_MS,
        intervalMs = AccountSwitchService.POLL_INTERVAL_MS,
    ): Promise<{ confirmed: boolean; superseded?: boolean }> {
        // Starting empty is normal, not fatal: the switch restarts the LS, so
        // there is a window with nothing listening. Bailing out here made a
        // slow respawn look like a failed switch. The loop re-discovers.
        let lsProcesses = initialEndpoints.length > 0 ? initialEndpoints : await findLSEndpoints();
        const ca = loadLSCert();

        let emailMatched = false;
        const targetNorm = targetEmail.toLowerCase();
        const previousNorm = previousEmail.toLowerCase();
        const start = Date.now();
        let pollCount = 0;
        let lastRegisterAt = Date.now();
        let lastRediscoverAt = 0;
        let rediscoverInFlight = false;
        let lastReassertAt = Date.now();
        let reassertCount = 0;
        let driftWarned = false;
        let globalPartialLogged = false;

        await delay(AccountSwitchService.POLL_INITIAL_DELAY_MS);

        while (Date.now() - start < maxWaitMs) {
            if (generation !== this.switchGeneration) {
                log.info('Polling aborted — newer switch detected');
                return { confirmed: false, superseded: true };
            }

            pollCount++;
            const elapsed = Date.now() - start;

            // Check EVERY reachable instance — they carry independent
            // identities and adopt at different times (measured in one sample:
            // global on erenyk75 while the workspace instance was already on
            // dietlioapp).
            //
            // But they are not equally authoritative. The workspace instance is
            // the one serving this window's chat, so it decides. Accepting a
            // global-only match declared the switch done while every request
            // from the editor still went to the previous account.
            //
            // Every workspace instance has to agree, not just one: each window
            // runs its own, the IDE restarts all of them on a switch, and each
            // comes back on its own stale snapshot (see the re-broadcast). Stopping
            // at the first match left the other windows on old accounts.
            let matched: { status: Buffer; endpoint: LsEndpoint } | null = null;
            let globalOnly: { status: Buffer; endpoint: LsEndpoint } | null = null;
            const haveWorkspaceLs = lsProcesses.some(ep => !ep.isGlobal);
            const seen: string[] = [];
            let wsAnswered = 0;
            let wsOnTarget: { status: Buffer; endpoint: LsEndpoint } | null = null;
            let wsAllTarget = true;

            for (const ep of lsProcesses) {
                const body = await callLSEndpoint(ep, `${LS_SERVICE_PATH}/GetUserStatus`, ca,
                    AccountSwitchService.POLL_REQUEST_TIMEOUT_MS)
                    .catch(() => null);
                const status = body ? extractField(body, 1) : null;
                if (!status || status.length <= 5) continue;
                const em = extractStringField(status, 7) || '';
                seen.push(`${ep.isGlobal ? 'global' : 'ws'}#${ep.pid ?? '?'}:${ep.port}=${em || '(empty)'}`);
                const onTarget = em.toLowerCase() === targetNorm;

                if (!ep.isGlobal) {
                    wsAnswered++;
                    if (onTarget) { wsOnTarget = wsOnTarget ?? { status, endpoint: ep }; } else { wsAllTarget = false; }
                } else if (onTarget) {
                    globalOnly = { status, endpoint: ep };
                }
                // Identity moved, but not to the account we asked for.
                if (!onTarget && !driftWarned && em && previousNorm && em.toLowerCase() !== previousNorm) {
                    driftWarned = true;
                    log.warn(`LS ${ep.port} adopted an unexpected identity: ${em} (asked for ${targetEmail})`);
                }
            }

            if (wsAnswered > 0 && wsAllTarget && wsOnTarget) {
                matched = wsOnTarget;
            } else if (!haveWorkspaceLs && globalOnly) {
                // An empty window, or one still starting: the global instance
                // is all there is.
                matched = globalOnly;
            }

            if (!matched && globalOnly && !globalPartialLogged) {
                globalPartialLogged = true;
                log.info(`Global LS is on ${targetEmail} but the workspace LS is not — still waiting, the workspace instance serves the editor`);
            }

            log.info(`poll#${pollCount} @${elapsed}ms: [${seen.join(' ')}] target=${targetEmail}`);

            if (matched) {
                emailMatched = true;
                log.info(`EMAIL_MATCH @${elapsed}ms after ${pollCount} poll(s) on ${matched.endpoint.isGlobal ? 'global' : 'workspace'} LS :${matched.endpoint.port} — pushing to USS`);

                await this.pushUserStatusToUSS(uss, matched.status);
                await vscode.commands.executeCommand('antigravity.handleAuthRefresh');

                // Continue USS stabilization in background (profile pic, data growth)
                this.stabilizeUSS(uss, matched.endpoint, ca, generation, matched.status.length, intervalMs, maxWaitMs - (Date.now() - start), targetEmail)
                    .catch(err => log.warn('USS stabilization error:', err?.message));

                return { confirmed: true };
            }

            // Nothing reports the target yet, so keep the endpoint list fresh
            // — a language server can restart underneath us and come back on a
            // different port with a different CSRF token, and the stale-but-
            // healthy instance answering every probe would otherwise mask that.
            //
            // Fired WITHOUT awaiting. Discovery costs a process listing plus a
            // port scan, and awaiting it inside the loop stretched each tick
            // from 800ms to ~3.9s — 8 probes across a 30s window instead of 37,
            // which is a far worse trade than a slightly stale endpoint list.
            if (!rediscoverInFlight
                && Date.now() - lastRediscoverAt >= AccountSwitchService.REDISCOVER_MIN_INTERVAL_MS) {
                lastRediscoverAt = Date.now();
                rediscoverInFlight = true;
                invalidateLsEndpointCache();
                void findLSEndpoints()
                    .then(fresh => {
                        if (fresh.length === 0) return;
                        const added = fresh.filter(f => !lsProcesses.some(p => p.port === f.port));
                        if (added.length > 0) {
                            log.info(`Poll: discovered ${added.map(a => `${a.isGlobal ? 'global' : 'ws'}:${a.port}`).join(' ')}`);
                        }
                        lsProcesses = fresh;
                    })
                    .catch(() => { /* next tick tries again */ })
                    .finally(() => { rediscoverInFlight = false; });
            }

            // Whether this call drives adoption or merely coincides with it is
            // unproven. It answers 200 with an empty body and nothing changed
            // 6s later when measured directly — but adoption has been observed
            // landing anywhere from ~10s to two minutes out, so that window was
            // simply too short to conclude from. Antigravity issues the call
            // once after startup; we re-issue it periodically because it is
            // cheap and because the endpoint list moves underneath us.
            if (Date.now() - lastRegisterAt >= AccountSwitchService.REGISTER_RETRY_MS) {
                lastRegisterAt = Date.now();
                log.info('Poll: re-issuing registerGdmUser (identity not adopted yet)');
                this.callRegisterGdmUser(lsProcesses).catch(err =>
                    log.warn('registerGdmUser retry failed:', err?.message));
            }

            if (reassert && reassertCount < AccountSwitchService.MAX_REASSERTS
                && Date.now() - lastReassertAt >= AccountSwitchService.REASSERT_INTERVAL_MS) {
                // The probes above can take seconds; a newer switch may have
                // started meanwhile, and re-broadcasting now would put this
                // switch's account back over it.
                if (generation !== this.switchGeneration) {
                    return { confirmed: false, superseded: true };
                }
                lastReassertAt = Date.now();
                reassertCount++;
                log.info(`Poll: re-broadcasting credentials (${reassertCount}/${AccountSwitchService.MAX_REASSERTS})`);
                // Awaited: a round still in flight must not land after the
                // rich record pushed on a match and overwrite it.
                await reassert().catch(err => log.warn('re-broadcast failed:', err?.message));
            }

            // Always pace the loop. The previous "no match" guards used
            // `continue`, which skipped this delay and turned the poll into a
            // ~320 req/s flood — 3800+ calls in a 12s window — against the very
            // LS we were waiting on.
            await delay(intervalMs);
        }
        log.info(`Polling timed out after ${maxWaitMs}ms and ${pollCount} poll(s) (emailMatched=${emailMatched})`);

        // Giving up on the toast must not mean giving up on the switch. The
        // model list lives in the rich UserStatus, and that is only written to
        // USS on a match — so a bare timeout leaves USS holding the new email
        // with no models behind it, which surfaces as "No models available"
        // even though the account did change. Field reports on Windows put
        // adoption anywhere from 11s to about two minutes, well past any
        // timeout we would want the user to sit through. So keep watching
        // quietly and push the moment it lands.
        this.watchForLateAdoption(uss, generation, targetEmail, lsProcesses, ca);
        return { confirmed: emailMatched };
    }

    /**
     * Keep polling for adoption after the foreground wait has already returned.
     *
     * Runs detached, on a slow cadence, and writes the rich UserStatus to USS
     * as soon as the target appears. That write is what repopulates the model
     * picker, and it also wakes the panel: the extension subscribes to the USS
     * userStatus topic and refreshes on change.
     */
    private watchForLateAdoption(
        uss: USSApi,
        generation: number,
        targetEmail: string,
        endpoints: LsEndpoint[],
        ca: Buffer | undefined,
    ): void {
        const targetNorm = targetEmail.toLowerCase();
        const start = Date.now();
        let lsProcesses = endpoints;

        void (async () => {
            while (Date.now() - start < AccountSwitchService.LATE_ADOPT_MAX_WAIT_MS) {
                await delay(AccountSwitchService.LATE_ADOPT_INTERVAL_MS);
                if (generation !== this.switchGeneration) return;

                // Same authority rule as the foreground poll: the workspace
                // instance serves the editor, so it decides. Pushing a
                // global-only match would repopulate the model picker for an
                // account the editor is not actually using.
                const haveWorkspaceLs = lsProcesses.some(ep => !ep.isGlobal);
                let found: { status: Buffer; endpoint: LsEndpoint } | null = null;
                for (const ep of lsProcesses) {
                    if (ep.isGlobal && haveWorkspaceLs) continue;
                    const body = await callLSEndpoint(ep, `${LS_SERVICE_PATH}/GetUserStatus`, ca,
                        AccountSwitchService.POLL_REQUEST_TIMEOUT_MS).catch(() => null);
                    const status = body ? extractField(body, 1) : null;
                    if (!status || status.length <= 5) continue;
                    if ((extractStringField(status, 7) || '').toLowerCase() === targetNorm) {
                        found = { status, endpoint: ep };
                        break;
                    }
                }

                if (found) {
                    // Confirm against the same process before believing it.
                    // The workspace instance restarts frequently and its
                    // replacement takes over the same port, so a single
                    // matching read can belong to a process that is already
                    // gone — which is exactly how a switch that never reached
                    // the editor got announced as finished.
                    await delay(AccountSwitchService.LATE_ADOPT_CONFIRM_MS);
                    if (generation !== this.switchGeneration) return;

                    const recheck = await callLSEndpoint(found.endpoint,
                        `${LS_SERVICE_PATH}/GetUserStatus`, ca,
                        AccountSwitchService.POLL_REQUEST_TIMEOUT_MS).catch(() => null);
                    const stillStatus = recheck ? extractField(recheck, 1) : null;
                    const stillEmail = stillStatus
                        ? (extractStringField(stillStatus, 7) || '').toLowerCase()
                        : '';

                    if (stillEmail !== targetNorm) {
                        log.warn(`Late adoption: ${targetEmail} seen on ${found.endpoint.isGlobal ? 'global' : 'ws'}#${found.endpoint.pid ?? '?'}:${found.endpoint.port} but the recheck read ${stillEmail || '(nothing)'} — not counting it`);
                        invalidateLsEndpointCache();
                        const fresh = await findLSEndpoints();
                        if (fresh.length > 0) lsProcesses = fresh;
                        continue;
                    }

                    const elapsed = Math.round((Date.now() - start) / 1000);
                    log.info(`Late adoption: ${targetEmail} confirmed on ws#${found.endpoint.pid ?? '?'}:${found.endpoint.port} ${elapsed}s after the wait ended — pushing models to USS`);
                    await this.pushUserStatusToUSS(uss, stillStatus!);
                    // Close the loop the timeout left open. Without this the
                    // user's last word on the switch is a warning, even though
                    // it went on to succeed moments later.
                    vscode.window.showInformationMessage(`✅ Switched to ${targetEmail}`);
                    return;
                }

                invalidateLsEndpointCache();
                const fresh = await findLSEndpoints();
                if (fresh.length > 0) lsProcesses = fresh;
            }
            log.info(`Late adoption watch for ${targetEmail} gave up after ${AccountSwitchService.LATE_ADOPT_MAX_WAIT_MS}ms`);
        })();
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
        targetEmail: string,
    ): Promise<void> {
        let lastSize = initialSize;
        let stableCount = 0;
        let failures = 0;
        const start = Date.now();
        const targetNorm = targetEmail.toLowerCase();

        while (Date.now() - start < remainingMs) {
            if (generation !== this.switchGeneration) return;
            await delay(intervalMs);

            try {
                const body = await callLSEndpoint(ls, `${LS_SERVICE_PATH}/GetUserStatus`, ca);
                let userStatus = body ? extractField(body, 1) : null;
                if (!userStatus || userStatus.length <= 5) continue;

                // This loop pushes whatever the LS reports straight into USS. If
                // the LS has meanwhile moved to a different account, pushing it
                // would silently switch the user back — which is exactly what
                // happened: a confirmed switch reverted seconds later, and the
                // reverting write was ours. Only stabilize the account we just
                // switched to.
                const liveEmail = extractStringField(userStatus, 7) || '';
                if (liveEmail.toLowerCase() !== targetNorm) {
                    log.warn(`USS stabilize: LS now reports ${liveEmail || '(empty)'}, expected ${targetEmail} — stopping rather than reverting the account`);
                    return;
                }

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
                // The instance we latched onto is gone or rotated its CSRF —
                // it restarts on its own and the successor answers 401 on the
                // same port. There is nothing to stabilize against any more, so
                // stop: retrying only produced a warning every 800ms for the
                // rest of the budget, twenty-odd identical lines deep.
                const msg = e?.message || '';
                if (msg.includes('401') || msg.includes('CSRF') || msg.includes('unauthenticated')) {
                    invalidateLsEndpointCache();
                    log.info('USS stabilize: endpoint no longer accepts our token — stopping');
                    return;
                }
                if (++failures >= AccountSwitchService.STABILIZE_MAX_FAILURES) {
                    log.warn(`USS stabilize: giving up after ${failures} failures (${msg})`);
                    return;
                }
                log.warn('USS stabilize iteration failed:', msg);
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

    // ==================== Legacy ====================

    /**
     * Write auth status to the IDE's state database (async — does not block extension host).
     * Uses hex-encoded JSON as SQLite X'...' blob to prevent SQL injection.
     * Delegates to shared/db which: (1) creates a backup first, (2) uses cross-platform CLI args.
     *
     * Kept for Antigravity 2.0.x and earlier, which still read this key. 2.5.x
     * dropped it, so we probe before writing: dbExec copies the entire state DB
     * as a backup first, and paying that on every switch for an UPDATE that
     * matches zero rows is pure waste.
     */
    private async writeAuthStatusToDb(name: string, email: string, apiKey: string): Promise<void> {
        const existing = await dbGet(LEGACY_AUTH_STATUS_KEY).catch(() => null);
        if (existing === null) {
            log.info('Legacy auth status key absent — skipping legacy DB write');
            return;
        }

        const proto = Buffer.concat([encodeVarintField(2, 1), encodeString(3, name), encodeString(7, email)]);
        const json = JSON.stringify({ name, apiKey, email, userStatusProtoBinaryBase64: proto.toString('base64') });

        const hexValue = Buffer.from(json, 'utf-8').toString('hex');
        const sql = `UPDATE ItemTable SET value = CAST(X'${hexValue}' AS TEXT) WHERE key = '${LEGACY_AUTH_STATUS_KEY}';`;

        await dbExec(sql);
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



/**
 * USS hands UserStatus back as base64 of the proto. Returns null unless it
 * decodes to something carrying an email, so a malformed or empty record is
 * never patched and re-published as if it were real.
 */
function decodeUserStatus(serialized: string | null | undefined): Buffer | null {
    if (!serialized) return null;
    try {
        const bytes = Buffer.from(serialized, 'base64');
        return extractStringField(bytes, 7).includes('@') ? bytes : null;
    } catch {
        return null;
    }
}

/** Workspace instances only, as 3.2.1's discovery returned; all of them if there are none. */
function workspaceOnly(endpoints: LsEndpoint[]): LsEndpoint[] {
    const ws = endpoints.filter(ep => !ep.isGlobal);
    return ws.length > 0 ? ws : endpoints;
}

function delay(ms: number): Promise<void> {
    return new Promise(r => setTimeout(r, ms));
}


// findActiveLanguageServers, loadLSCert, callLSEndpoint → moved to src/utils/lsClient.ts
