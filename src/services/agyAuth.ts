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
import { spawn } from 'child_process';

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

/**
 * The OS credential store holding the hub's account. agy uses
 * zalando/go-keyring (module path read from the agy binary, 2026-11-06),
 * whose layout per platform is:
 *   macOS    Keychain generic password, service "gemini", account
 *            "antigravity"; value "go-keyring-base64:" + base64(JSON)
 *   Windows  Credential Manager generic credential "gemini:antigravity",
 *            user "antigravity"; blob = the JSON's UTF-8 bytes
 *   Linux    Secret Service item with attributes service=gemini,
 *            username=antigravity; secret = the JSON
 * Only macOS has been run against a real hub. Windows and Linux follow the
 * library's source; switchAgy verifies the result and rolls back if the hub
 * does not take it.
 */
export async function readKeyringRaw(): Promise<string | null> {
    switch (process.platform) {
        case 'darwin': {
            const out = await run('/usr/bin/security', ['find-generic-password', '-s', KEYCHAIN_SERVICE, '-a', KEYCHAIN_ACCOUNT, '-w']);
            if (out === null) return null;
            const v = out.trim();
            return v.startsWith(KEYRING_PREFIX) ? Buffer.from(v.slice(KEYRING_PREFIX.length), 'base64').toString('utf8') : v;
        }
        case 'win32': {
            const out = await runPowerShell(`${WIN_CRED_TYPE}\n$b = [AgCred]::Read('${WIN_TARGET}'); if ($b -ne $null) { [Console]::Out.Write($b) }`);
            return out ? Buffer.from(out.trim(), 'base64').toString('utf8') : null;
        }
        case 'linux':
            return await run('secret-tool', ['lookup', 'service', KEYCHAIN_SERVICE, 'username', KEYCHAIN_ACCOUNT]);
        default:
            return null;
    }
}

/** Write a raw value back, e.g. to restore what readKeyringRaw returned. The secret goes over stdin, never argv. */
export async function writeKeyringRaw(value: string): Promise<void> {
    switch (process.platform) {
        case 'darwin': {
            // `security -i` takes the command on stdin; base64 plus a fixed prefix needs no quoting.
            const encoded = KEYRING_PREFIX + Buffer.from(value, 'utf8').toString('base64');
            await run('/usr/bin/security', ['-i'], `add-generic-password -U -s ${KEYCHAIN_SERVICE} -a ${KEYCHAIN_ACCOUNT} -w ${encoded}\n`, true);
            return;
        }
        case 'win32':
            // Base64 on stdin so the bytes reach CredWrite exactly as UTF-8.
            await runPowerShell(`${WIN_CRED_TYPE}\n[AgCred]::Write('${WIN_TARGET}', '${KEYCHAIN_ACCOUNT}', [Convert]::FromBase64String([Console]::In.ReadToEnd().Trim()))`,
                Buffer.from(value, 'utf8').toString('base64'), true);
            return;
        case 'linux':
            await run('secret-tool', ['store', '--label', `Password for '${KEYCHAIN_ACCOUNT}' on '${KEYCHAIN_SERVICE}'`,
                'service', KEYCHAIN_SERVICE, 'username', KEYCHAIN_ACCOUNT], value, true);
            return;
        default:
            throw new Error(`no credential store support on ${process.platform}`);
    }
}

export async function readKeychainJson(): Promise<Record<string, unknown> | null> {
    const raw = await readKeyringRaw().catch(() => null);
    if (!raw) return null;
    try { return JSON.parse(raw); } catch { return null; }
}

export function writeKeychainJson(value: Record<string, unknown>): Promise<void> {
    return writeKeyringRaw(JSON.stringify(value));
}

const WIN_TARGET = `${KEYCHAIN_SERVICE}:${KEYCHAIN_ACCOUNT}`;

/** CredReadW / CredWriteW, as go-keyring's wincred backend calls them (generic, persist local machine). */
const WIN_CRED_TYPE = `Add-Type -TypeDefinition @"
using System; using System.Runtime.InteropServices;
public static class AgCred {
  [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
  struct CREDENTIAL { public int Flags; public int Type; public string TargetName; public string Comment;
    public System.Runtime.InteropServices.ComTypes.FILETIME LastWritten; public int CredentialBlobSize;
    public IntPtr CredentialBlob; public int Persist; public int AttributeCount; public IntPtr Attributes;
    public string TargetAlias; public string UserName; }
  [DllImport("advapi32.dll", EntryPoint = "CredReadW", CharSet = CharSet.Unicode, SetLastError = true)]
  static extern bool CredRead(string target, int type, int flags, out IntPtr cred);
  [DllImport("advapi32.dll", EntryPoint = "CredWriteW", CharSet = CharSet.Unicode, SetLastError = true)]
  static extern bool CredWrite(ref CREDENTIAL cred, int flags);
  [DllImport("advapi32.dll")] static extern void CredFree(IntPtr p);
  public static string Read(string target) {
    IntPtr p; if (!CredRead(target, 1, 0, out p)) return null;
    try { var c = (CREDENTIAL)Marshal.PtrToStructure(p, typeof(CREDENTIAL));
      var b = new byte[c.CredentialBlobSize]; Marshal.Copy(c.CredentialBlob, b, 0, b.Length);
      return Convert.ToBase64String(b); } finally { CredFree(p); } }
  public static void Write(string target, string user, byte[] blob) {
    var c = new CREDENTIAL(); c.Type = 1; c.TargetName = target; c.UserName = user; c.Persist = 2;
    c.CredentialBlobSize = blob.Length; c.CredentialBlob = Marshal.AllocHGlobal(blob.Length);
    try { Marshal.Copy(blob, 0, c.CredentialBlob, blob.Length);
      if (!CredWrite(ref c, 0)) throw new System.ComponentModel.Win32Exception(Marshal.GetLastWin32Error()); }
    finally { Marshal.FreeHGlobal(c.CredentialBlob); } }
}
"@`;

/**
 * Run a command, optionally feeding stdin. Resolves stdout, or null on a
 * non-zero exit; with `strict`, rejects instead (and on any stderr).
 */
function run(cmd: string, args: string[], stdin?: string, strict = false, stderrIsError = true): Promise<string | null> {
    return new Promise((resolve, reject) => {
        const p = spawn(cmd, args, { windowsHide: true });
        let stdout = '', stderr = '';
        const timer = setTimeout(() => p.kill(), 20_000);
        p.stdout.on('data', d => { stdout += d; });
        p.stderr.on('data', d => { stderr += d; });
        p.on('error', e => { clearTimeout(timer); strict ? reject(e) : resolve(null); });
        p.on('close', code => {
            clearTimeout(timer);
            if (code === 0 && !(strict && stderrIsError && stderr.trim())) return resolve(stdout);
            strict ? reject(new Error(`${path.basename(cmd)} exited ${code}: ${stderr.trim()}`)) : resolve(null);
        });
        p.stdin.end(stdin ?? '');
    });
}

/**
 * PowerShell with the script passed encoded, leaving stdin free for the
 * secret. Failures surface as a non-zero exit; stderr alone is not trusted,
 * since PowerShell writes progress records there when output is redirected.
 */
function runPowerShell(script: string, stdin?: string, strict = false): Promise<string | null> {
    const full = `$ErrorActionPreference = 'Stop'; $ProgressPreference = 'SilentlyContinue'\n${script}`;
    const encoded = Buffer.from(full, 'utf16le').toString('base64');
    return run('powershell.exe', ['-NoProfile', '-NonInteractive', '-EncodedCommand', encoded], stdin, strict, false);
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

export interface AgyStoreSnapshot { keyring: string | null; file: string | null }

/** Both stores as they are now, to put back if a switch must be undone. */
export async function snapshotAgyStore(): Promise<AgyStoreSnapshot> {
    let file: string | null = null;
    try { file = fs.readFileSync(AGY_TOKEN_FILE, 'utf8'); } catch { /* none yet */ }
    return { keyring: await readKeyringRaw().catch(() => null), file };
}

export async function restoreAgyStore(snap: AgyStoreSnapshot): Promise<void> {
    if (snap.keyring !== null) await writeKeyringRaw(snap.keyring);
    if (snap.file !== null) {
        const tmp = `${AGY_TOKEN_FILE}.${process.pid}.tmp`;
        fs.writeFileSync(tmp, snap.file, { mode: 0o600 });
        fs.renameSync(tmp, AGY_TOKEN_FILE);
    }
}
