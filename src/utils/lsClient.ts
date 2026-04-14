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
import * as fs from 'fs';
import * as path from 'path';
import { exec } from 'child_process';
import { promisify } from 'util';
import { LS_CERT_PATHS, LS_PROCESS_GREP } from '../constants';
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
    } catch {
        try {
            const { stdout } = await execAsync(wmic, { timeout: 5000 });
            // wmic /format:value emits "CommandLine=<value>" lines
            return stdout.split('\n')
                .map(l => l.replace(/^CommandLine=/i, '').trim())
                .filter(Boolean);
        } catch {
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
        if (process.platform === 'win32') {
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
            const csrf = line.match(/--csrf_token[=\s]+([\w-]+)/)?.[1];
            const wsId = line.match(/--workspace_id[=\s]+(\S+)/)?.[1];
            return port && csrf ? [{ port: +port, csrf, wsId }] : [];
        });
    } catch {
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
