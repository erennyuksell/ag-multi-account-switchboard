/**
 * Language Server HTTP client utilities — shared across all LS callers.
 *
 * Previously duplicated in accountSwitch.ts and tokenBase.ts.
 * Centralised here so each fix only needs to happen once.
 *
 * Process-discovery strategy:
 *   - macOS/Linux: `ps -A -ww -o args` + grep
 *   - Windows:     `wmic process … get CommandLine`
 *
 * Both approaches read --https_server_port and --csrf_token directly from
 * the process argv, which is faster than going via lsof/netstat (that is
 * serverDiscovery.ts's concern, which resolves the separate API port).
 */

import * as https from 'https';
import * as http from 'http';
import * as fs from 'fs';
import * as path from 'path';
import { exec } from 'child_process';
import { promisify } from 'util';
import {
    LS_CERT_PATHS, LS_PROCESS_GREP, SERVER_PROCESS_GREP_E, workspaceIdFromArgs, LS_SERVICE_PATH, CSRF_TOKEN_RE, isWindows,
    PROCESS_EXEC_TIMEOUT_MS, WMIC_EXEC_TIMEOUT_MS, LSOF_EXEC_TIMEOUT_MS,
    LS_REQUEST_TIMEOUT_MS, DEFAULT_LS_TIMEOUT_MS,
} from '../constants';
import { collectBuffer } from './http';

const execAsync = promisify(exec);

/**
 * Returns raw command-line strings for all processes matching `grep` on Windows.
 * Prefers PowerShell (works on Win 11 22H2+ where wmic is removed), falls back to wmic.
 * Never throws — returns [] on any failure.
 */
export async function getWindowsProcessLines(grep: string): Promise<string[]> {
    const ps = `powershell -NoProfile -Command "Get-WmiObject Win32_Process | Where-Object { $_.CommandLine -like '*${grep}*' } | Select-Object -ExpandProperty CommandLine"`;
    const wmic = `wmic process where "CommandLine like '%${grep}%'" get CommandLine /format:value 2>nul`;
    try {
        const { stdout } = await execAsync(ps, { timeout: PROCESS_EXEC_TIMEOUT_MS });
        return stdout.split('\n').map(l => l.trim()).filter(Boolean);
    } catch { /* expected: base64 decode may fail for non-protobuf data */
        try {
            const { stdout } = await execAsync(wmic, { timeout: WMIC_EXEC_TIMEOUT_MS });
            // wmic /format:value emits "CommandLine=<value>" lines
            return stdout.split('\n')
                .map(l => l.replace(/^CommandLine=/i, '').trim())
                .filter(Boolean);
        } catch { /* expected: CSRF extraction heuristic — try next pattern */
            return [];
        }
    }
}

/** { port, csrf, wsId } tuple extracted from a running Language Server process */
export interface LsEndpoint {
    port: number;
    csrf: string;
    /** workspace_id from LS process args — used to match the active workspace */
    wsId?: string;
    /** Transport that actually answered on this port. Defaults to https. */
    protocol?: 'http' | 'https';
    /** True for the instance started without --workspace_id (the global LS). */
    isGlobal?: boolean;
    /**
     * Owning process id. Carried because the workspace instance restarts often
     * and the replacement inherits the same port: a match recorded against a
     * port alone can be credited to a process that has since been replaced by
     * one running a different account.
     */
    pid?: string;
}

// ==================== Process Discovery ====================

/** TCP ports a PID is listening on. Returns [] on any failure. */
async function getListeningPorts(pid: string): Promise<number[]> {
    try {
        const ports: number[] = [];
        if (isWindows) {
            const { stdout } = await execAsync('netstat -ano -p TCP 2>nul', { timeout: LSOF_EXEC_TIMEOUT_MS });
            for (const line of stdout.split('\n')) {
                if (!line.includes('LISTENING')) continue;
                const parts = line.trim().split(/\s+/);
                if (parts[parts.length - 1] !== pid) continue;
                const m = parts[1]?.match(/:(\d+)$/);
                if (m) ports.push(parseInt(m[1], 10));
            }
        } else {
            const { stdout } = await execAsync(
                `lsof -Pan -p ${pid} -i TCP -sTCP:LISTEN 2>/dev/null`,
                { timeout: LSOF_EXEC_TIMEOUT_MS },
            );
            for (const line of stdout.split('\n')) {
                const m = line.match(/:(\d+)\s+\(LISTEN\)/);
                if (m) ports.push(parseInt(m[1], 10));
            }
        }
        return [...new Set(ports)];
    } catch { return []; }
}

/** One LS process as seen in `ps` / `Get-WmiObject` output. */
interface LsProcess { pid: string; csrf: string; wsId?: string; httpsPort?: number }

/** Parse "pid args" lines into LS process records. */
function parseLsProcessLines(lines: string[]): LsProcess[] {
    return lines.flatMap(line => {
        const csrf = line.match(CSRF_TOKEN_RE)?.[1];
        if (!csrf) return [];
        const pid = line.trim().match(/^(\d+)\s/)?.[1] ?? '0';
        const wsId = workspaceIdFromArgs(line);
        const httpsPort = line.match(/--https_server_port[=\s]+(\d+)/)?.[1];
        return [{ pid, csrf, wsId, httpsPort: httpsPort ? parseInt(httpsPort, 10) : undefined }];
    });
}

/**
 * Probe timeout. Deliberately short: most candidate sockets are NOT RPC ports
 * (the LSP port, for one) and simply never reply. At the default 10s request
 * timeout a single dead port cost 20s (https then http), which stalled the
 * switch confirmation poll for over 21 seconds.
 */
const PROBE_TIMEOUT_MS = 1_500;

/** Does this port answer GetUserStatus over the given transport? */
async function endpointAnswers(ep: LsEndpoint): Promise<boolean> {
    try {
        const body = await callLSEndpoint(ep, `${LS_SERVICE_PATH}/GetUserStatus`, undefined, PROBE_TIMEOUT_MS);
        return body.length > 0;
    } catch { return false; }
}

// Endpoint probing costs an lsof + a handful of HTTP calls per process, and the
// readiness gate calls this every 400ms. Cache briefly, keyed by the process
// snapshot so an LS restart (new pid/port) invalidates immediately.
let _endpointCache: { signature: string; ts: number; endpoints: LsEndpoint[] } | null = null;
const ENDPOINT_CACHE_TTL_MS = 10_000;

/**
 * Drop the cached endpoints so the next lookup re-probes.
 * Call this on 401/CSRF failures: the LS can rotate its CSRF token without
 * restarting, which leaves the pid/port signature unchanged and would
 * otherwise keep serving credentials that no longer work.
 */
export function invalidateLsEndpointCache(): void {
    _endpointCache = null;
}

/**
 * Find active Language Server processes and resolve a working RPC endpoint for each.
 *
 * Antigravity runs a GLOBAL LS (no --workspace_id) alongside one LS per
 * workspace. They hold independent accounts and adopt changes at different
 * times, so identity-sensitive callers need to see all of them — and the
 * global instance never advertises an --https_server_port, so reading the port
 * out of argv (the previous behaviour) made it structurally invisible.
 *
 * So: take the argv port when present, otherwise fall back to scanning the
 * PID's listening sockets, and probe candidates to find one that actually
 * answers. Global instances are returned FIRST so identity-sensitive callers
 * hit the right LS even if they only use endpoints[0].
 *
 * Cross-platform: ps + lsof on macOS/Linux, Get-WmiObject + netstat on Windows.
 * Returns an empty array (never throws) so callers can safely ignore LS absence.
 */
export async function findLSEndpoints(): Promise<LsEndpoint[]> {
    try {
        let lines: string[];
        if (isWindows) {
            // Emit "PID <args>" so the same parser works on both platforms.
            const ps = `powershell -NoProfile -Command "Get-WmiObject Win32_Process | Where-Object { $_.CommandLine -like '*${LS_PROCESS_GREP}*' } | ForEach-Object { ($_.ProcessId.ToString() + ' ' + $_.CommandLine) }"`;
            try {
                const { stdout } = await execAsync(ps, { timeout: PROCESS_EXEC_TIMEOUT_MS });
                lines = stdout.split('\n').map(l => l.trim()).filter(Boolean);
            } catch {
                // No PID available from this fallback — argv ports only.
                lines = (await getWindowsProcessLines(LS_PROCESS_GREP)).map(l => `0 ${l}`);
            }
        } else {
            const { stdout } = await execAsync(
                `ps -A -ww -o pid,args | grep -E "${SERVER_PROCESS_GREP_E}" | grep -v grep`,
                { timeout: LSOF_EXEC_TIMEOUT_MS },
            );
            lines = stdout.trim().split('\n').filter(Boolean);
        }

        const procs = parseLsProcessLines(lines);
        if (procs.length === 0) return [];

        // Global first — see doc comment.
        procs.sort((a, b) => Number(!!a.wsId) - Number(!!b.wsId));

        const signature = procs.map(p => `${p.pid}:${p.httpsPort ?? ''}`).join('|');
        if (_endpointCache && _endpointCache.signature === signature
            && Date.now() - _endpointCache.ts < ENDPOINT_CACHE_TTL_MS) {
            return _endpointCache.endpoints;
        }

        // Probe every process concurrently, and every candidate socket within a
        // process concurrently. Sequential probing made discovery scale with the
        // number of dead ports instead of staying flat.
        const perProcess = await Promise.all(procs.map(async (proc): Promise<LsEndpoint | null> => {
            const base = { csrf: proc.csrf, wsId: proc.wsId, isGlobal: !proc.wsId, pid: proc.pid };

            // Candidates in priority order: the advertised HTTPS port first,
            // then every other listening socket over https and http. The socket
            // scan is what finds the global LS, which advertises no port at all.
            const candidates: LsEndpoint[] = [];
            if (proc.httpsPort) candidates.push({ ...base, port: proc.httpsPort, protocol: 'https' });
            if (proc.pid !== '0') {
                for (const port of await getListeningPorts(proc.pid)) {
                    if (port === proc.httpsPort) continue; // already queued
                    candidates.push({ ...base, port, protocol: 'https' });
                    candidates.push({ ...base, port, protocol: 'http' });
                }
            }
            if (candidates.length === 0) return null;

            const answers = await Promise.all(candidates.map(endpointAnswers));
            const idx = answers.indexOf(true);
            return idx >= 0 ? candidates[idx] : null;
        }));

        const resolved = perProcess.filter((e): e is LsEndpoint => e !== null);

        _endpointCache = { signature, ts: Date.now(), endpoints: resolved };
        return resolved;
    } catch { /* expected: process listing can fail while the LS restarts */
        return [];
    }
}

// ==================== Certificate ====================

/**
 * Load the Language Server's self-signed TLS certificate.
 * Tries a dynamic path relative to the LS binary first, then falls back to
 * platform-specific installation paths defined in LS_CERT_PATHS.
 *
 * Returns undefined (never throws) — callers should fall back to
 * `rejectUnauthorized: false` when no cert is found.
 */
export function loadLSCert(): Buffer | undefined {
    const dynamicPath = path.join(
        path.dirname(require.main?.filename || ''),
        '..',
        'languageServer',
        'cert.pem',
    );
    for (const p of [dynamicPath, ...LS_CERT_PATHS]) {
        try { return fs.readFileSync(p); } catch { /* try next candidate */ }
    }
    return undefined;
}

// ==================== HTTP ====================

/**
 * Make a ConnectRPC-style POST to a Language Server endpoint.
 *
 * @param ls       - Endpoint info (port + CSRF token)
 * @param endpoint - Full gRPC path, e.g.
 *                   '/exa.language_server_pb.LanguageServerService/RegisterGdmUser'
 * @param ca       - Optional CA cert.  If omitted TLS verification is skipped.
 */
export function callLSEndpoint(
    ls: LsEndpoint,
    endpoint: string,
    ca?: Buffer,
    timeoutMs = LS_REQUEST_TIMEOUT_MS,
): Promise<Buffer> {
    // The global LS answers plain HTTP on some of its sockets; endpoints
    // resolved by port scanning carry the transport that actually replied.
    const useHttps = ls.protocol !== 'http';
    const transport = useHttps ? https : http;
    return new Promise((resolve, reject) => {
        const req = transport.request(
            {
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
                ...(useHttps
                    ? (ca ? { ca, rejectUnauthorized: true } : { rejectUnauthorized: false })
                    : {}),
            },
            async (res) => {
                try {
                    const { status, body } = await collectBuffer(res);
                    if (status === 200) {
                        resolve(body);
                    } else {
                        reject(new Error(`HTTP ${status}: ${body.toString().substring(0, 200)}`));
                    }
                } catch (e) { reject(e); }
            },
        );
        req.on('error', reject);
        req.setTimeout(timeoutMs, () => req.destroy(new Error('LS request timed out')));
        req.end();
    });
}

// ==================== Unified LS HTTP Client ====================
//
// Single source of truth for all Language Server HTTP calls.
// Replaces 5 duplicate implementations in:
//   contextWindow.callLs, usage/index.callLsJson, serverDiscovery.fetchLocalQuota,
//   tokenBase.callHttp, rpcDirectClient.httpsPost

import { ServerInfo } from '../types';

/**
 * POST JSON to a Language Server HTTP endpoint and return parsed JSON.
 * This is the SSOT for all JSON-based LS communication.
 *
 * @param serverInfo  - Server connection info (port + csrf)
 * @param method      - RPC method name, e.g. 'GetAllCascadeTrajectories'
 * @param body        - JSON body to send (default: {})
 * @param timeoutMs   - Request timeout (default: 8000ms)
 */
export function callLsJson(
    serverInfo: ServerInfo,
    method: string,
    body: Record<string, unknown> = {},
    timeoutMs = DEFAULT_LS_TIMEOUT_MS,
): Promise<any> {
    const fullPath = method.startsWith('/') ? method : `${LS_SERVICE_PATH}/${method}`;

    return new Promise((resolve, reject) => {
        const bodyStr = JSON.stringify(body);
        const req = http.request({
            hostname: '127.0.0.1',
            port: serverInfo.port,
            path: fullPath,
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Content-Length': Buffer.byteLength(bodyStr),
                'Connect-Protocol-Version': '1',
                'X-Codeium-Csrf-Token': serverInfo.csrfToken,
            },
            timeout: timeoutMs,
        }, (res) => {
            let data = '';
            res.on('data', (chunk: string | Buffer) => { data += chunk; });
            res.on('end', () => {
                const status = res.statusCode ?? 0;
                if (status >= 200 && status < 300) {
                    try { resolve(JSON.parse(data)); }
                    catch { resolve(null); }
                } else {
                    reject(new Error(`${method} HTTP ${status}: ${data.substring(0, 200)}`));
                }
            });
            res.on('error', reject);
        });
        req.on('error', reject);
        req.on('timeout', () => { req.destroy(); reject(new Error(`${method} timeout`)); });
        req.write(bodyStr);
        req.end();
    });
}

/**
 * POST to a Language Server HTTP endpoint and return raw Buffer (for proto responses).
 * This is the SSOT for all proto-binary LS communication.
 */
export function callLsProto(
    serverInfo: ServerInfo,
    endpointPath: string,
    timeoutMs = DEFAULT_LS_TIMEOUT_MS,
): Promise<Buffer> {
    return new Promise((resolve, reject) => {
        const req = http.request({
            hostname: '127.0.0.1',
            port: serverInfo.port,
            path: endpointPath,
            method: 'POST',
            headers: {
                'Content-Type': 'application/proto',
                'Content-Length': '0',
                'Connect-Protocol-Version': '1',
                'X-Codeium-Csrf-Token': serverInfo.csrfToken,
            },
            timeout: timeoutMs,
        }, async (res) => {
            try {
                const { status, body } = await collectBuffer(res);
                if (status === 200) {
                    resolve(body);
                } else {
                    reject(new Error(`HTTP ${status}: ${body.toString().substring(0, 100)}`));
                }
            } catch (e) { reject(e); }
        });
        req.on('error', reject);
        req.on('timeout', () => req.destroy(new Error('timeout')));
        req.end();
    });
}

/**
 * POST JSON to a Language Server HTTPS endpoint (for RPC Direct calls).
 * This is the SSOT for all HTTPS JSON-based LS communication.
 */
export function callLsHttpsJson(
    httpsPort: number,
    csrfToken: string,
    path: string,
    body: Record<string, unknown> = {},
    timeoutMs = DEFAULT_LS_TIMEOUT_MS,
): Promise<any> {
    return new Promise((resolve, reject) => {
        const bodyStr = JSON.stringify(body);
        const req = https.request({
            hostname: '127.0.0.1',
            port: httpsPort,
            path,
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Content-Length': Buffer.byteLength(bodyStr),
                'Connect-Protocol-Version': '1',
                'X-Codeium-Csrf-Token': csrfToken,
            },
            timeout: timeoutMs,
            rejectUnauthorized: false,
        }, (res) => {
            let data = '';
            res.on('data', (c: string | Buffer) => { data += c; });
            res.on('end', () => {
                if (res.statusCode && res.statusCode >= 200 && res.statusCode < 300) {
                    try { resolve(JSON.parse(data)); }
                    catch { reject(new Error(`Invalid JSON from ${path}`)); }
                } else {
                    reject(new Error(`${path} returned ${res.statusCode}`));
                }
            });
        });
        req.on('error', reject);
        req.on('timeout', () => { req.destroy(); reject(new Error(`${path} timeout`)); });
        req.write(bodyStr);
        req.end();
    });
}

