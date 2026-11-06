/**
 * Antigravity 2.6+ identity.
 *
 * 2.6 replaced the per-window language server binary with an agent hub
 * (`~/.gemini/bin/agy --hub`, one per window). The hubs do not take identity
 * from USS any more. They read a stored OAuth token, from two places:
 *   1. macOS Keychain, service "gemini", account "antigravity" (go-keyring,
 *      value "go-keyring-base64:" + base64(JSON)) — read first
 *   2. ~/.gemini/jetski-standalone-oauth-token — same JSON, fallback
 * Measured on 2026-10-29: USS still named flow.event7 while all three hubs,
 * the keychain item and the file were on erenyk75. Rewriting only the file
 * and restarting a hub brought it back on the keychain's account.
 *
 * A running hub keeps the token it loaded; it does not watch either store.
 *
 * Shape (Go oauth2.Token plus three fields):
 *   { token: { access_token, token_type, refresh_token, expiry: RFC3339, expires_in },
 *     auth_method: "consumer", id_token_email, writer_id }
 * writer_id tags the writer; agy logs "Skipping refreshed token save because
 * stored token changed externally" when it notices someone else's write.
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as crypto from 'crypto';
import { execFile, spawn } from 'child_process';

export const AGY_TOKEN_FILE = path.join(os.homedir(), '.gemini', 'jetski-standalone-oauth-token');
export const AGY_BINARY = path.join(os.homedir(), '.gemini', 'bin', process.platform === 'win32' ? 'agy.exe' : 'agy');

/** Stable for this extension host, so our writes are recognisable as one writer. */
const WRITER_ID = crypto.randomBytes(16).toString('base64url').slice(0, 22);

let _agyMode: boolean | undefined;

/**
 * True when this IDE runs the 2.6 hub architecture. Decided by the IDE build
 * itself (it ships the agy extension instead of the language server one), not
 * by ~/.gemini — the standalone agy CLI can be installed next to an older IDE.
 */
export function isAgyMode(): boolean {
    if (_agyMode === undefined) {
        let appRoot = '';
        try { appRoot = require('vscode').env.appRoot as string; } catch { /* outside the extension host */ }
        _agyMode = appRoot
            ? fs.existsSync(path.join(appRoot, 'extensions', 'agy'))
            : fs.existsSync(AGY_TOKEN_FILE);
    }
    return _agyMode;
}

const KEYCHAIN_SERVICE = 'gemini';
const KEYCHAIN_ACCOUNT = 'antigravity';
const KEYRING_PREFIX = 'go-keyring-base64:';

export function readKeychainJson(): Promise<Record<string, unknown> | null> {
    if (process.platform !== 'darwin') return Promise.resolve(null);
    return new Promise(resolve => {
        execFile('/usr/bin/security', ['find-generic-password', '-s', KEYCHAIN_SERVICE, '-a', KEYCHAIN_ACCOUNT, '-w'],
            { timeout: 5_000 }, (err, stdout) => {
                if (err) return resolve(null);
                let v = stdout.trim();
                if (v.startsWith(KEYRING_PREFIX)) v = Buffer.from(v.slice(KEYRING_PREFIX.length), 'base64').toString('utf8');
                try { resolve(JSON.parse(v)); } catch { resolve(null); }
            });
    });
}

/**
 * Write through `security -i` so the secret goes over stdin, not argv where
 * any process listing could see it. The value is base64 plus a fixed prefix,
 * so it needs no quoting.
 */
export function writeKeychainJson(value: Record<string, unknown>): Promise<void> {
    if (process.platform !== 'darwin') return Promise.resolve();
    const encoded = KEYRING_PREFIX + Buffer.from(JSON.stringify(value), 'utf8').toString('base64');
    return new Promise((resolve, reject) => {
        const p = spawn('/usr/bin/security', ['-i']);
        let stderr = '';
        p.stderr.on('data', d => { stderr += d; });
        p.on('error', reject);
        p.on('close', code => code === 0 && !stderr.trim() ? resolve() : reject(new Error(`security exited ${code}: ${stderr.trim()}`)));
        p.stdin.end(`add-generic-password -U -s ${KEYCHAIN_SERVICE} -a ${KEYCHAIN_ACCOUNT} -w ${encoded}\n`);
    });
}

/** Account the keychain item names — what a restarted hub will come up on. */
export async function readAgyKeychainIdentity(): Promise<string> {
    const v = await readKeychainJson();
    return (v?.id_token_email as string) || '';
}

export function readAgyIdentity(): string {
    try {
        return JSON.parse(fs.readFileSync(AGY_TOKEN_FILE, 'utf8')).id_token_email || '';
    } catch { return ''; }
}

/** RFC3339 with the local offset, the way Go's time.Time marshals. */
function rfc3339Local(ms: number): string {
    const d = new Date(ms);
    const off = -d.getTimezoneOffset();
    const sign = off >= 0 ? '+' : '-';
    const pad = (n: number, w = 2) => String(Math.abs(n)).padStart(w, '0');
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}.${pad(d.getMilliseconds(), 3)}`
        + `${sign}${pad(Math.trunc(off / 60))}:${pad(off % 60)}`;
}

/**
 * Point the stored identity at a different account: keychain item and file.
 * Fields we do not know about are kept. The file is written to a temp file
 * and renamed so a hub reading mid-write never sees a half file. Running hubs
 * only pick this up when they restart.
 */
export async function writeAgyToken(opts: {
    email: string; accessToken: string; refreshToken: string; expiryTimestamp: number;
}): Promise<void> {
    let prior: Record<string, unknown> = (await readKeychainJson()) ?? {};
    if (Object.keys(prior).length === 0) {
        try { prior = JSON.parse(fs.readFileSync(AGY_TOKEN_FILE, 'utf8')); } catch { /* first write */ }
    }
    const priorToken = (prior.token && typeof prior.token === 'object') ? prior.token as Record<string, unknown> : {};

    const expiresIn = Math.max(0, opts.expiryTimestamp - Math.floor(Date.now() / 1000));
    const next = {
        ...prior,
        token: {
            ...priorToken,
            access_token: opts.accessToken,
            token_type: 'Bearer',
            refresh_token: opts.refreshToken,
            expiry: rfc3339Local(opts.expiryTimestamp * 1000),
            expires_in: expiresIn,
        },
        auth_method: (prior.auth_method as string) || 'consumer',
        id_token_email: opts.email,
        writer_id: WRITER_ID,
    };

    // Keychain first: it is what a hub reads first.
    await writeKeychainJson(next);

    const tmp = `${AGY_TOKEN_FILE}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(next), { mode: 0o600 });
    fs.renameSync(tmp, AGY_TOKEN_FILE);
}
