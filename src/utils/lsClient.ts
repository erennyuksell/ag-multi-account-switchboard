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
import { LS_CERT_PATHS, LS_PROCESS_GREP, LS_SERVICE_PATH, CSRF_TOKEN_RE, isWindows } from '../constants';
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
        const { stdout } = await execAsync(ps, { timeout: 8000 });
        return stdout.split('\n').map(l => l.trim()).filter(Boolean);
    } catch { /* expected: base64 decode may fail for non-protobuf data */
        try {
            const { stdout } = await execAsync(wmic, { timeout: 5000 });
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
}

// ==================== Process Discovery ====================

/**
 * Find active Language Server processes and extract their HTTPS port + CSRF token
 * directly from process arguments (--https_server_port, --csrf_token).
 *
 * Cross-platform: ps on macOS/Linux, wmic on Windows.
 * Returns an empty array (never throws) so callers can safely ignore LS absence.
 */
export async function findLSEndpoints(): Promise<LsEndpoint[]> {
    try {
        let lines: string[];
        if (isWindows) {
            lines = await getWindowsProcessLines(LS_PROCESS_GREP);
        } else {
            const { stdout } = await execAsync(
                `ps -A -ww -o args | grep "${LS_PROCESS_GREP}" | grep -v grep`,
                { timeout: 5000 },
            );
            lines = stdout.trim().split('\n').filter(Boolean);
        }

        return lines.flatMap(line => {
            const port = line.match(/--https_server_port[=\s]+(\d+)/)?.[1];
            const csrf = line.match(CSRF_TOKEN_RE)?.[1];
            const wsId = line.match(/--workspace_id[=\s]+(\S+)/)?.[1];
            return port && csrf ? [{ port: +port, csrf, wsId }] : [];
        });
    } catch { /* expected: JSON parse failure — raw text response */
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
): Promise<Buffer> {
    return new Promise((resolve, reject) => {
        const req = https.request(
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
                ...(ca ? { ca, rejectUnauthorized: true } : { rejectUnauthorized: false }),
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
        req.setTimeout(10_000, () => req.destroy(new Error('LS request timed out')));
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
    timeoutMs = 8000,
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
    timeoutMs = 8000,
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
    timeoutMs = 8000,
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

