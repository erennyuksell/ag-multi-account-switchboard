/**
 * Hub discovery — SSOT for reading Antigravity 2.6+ hub daemon files.
 * ═══════════════════════════════════════════════════════════════
 * The new IDE spawns `agy --hub --hub-port=<port> ...` and writes:
 *   ~/.gemini/<profile>/daemon/hub_<httpPort>.json
 *
 * File shape (2.29):
 *   { "pid": 1779, "httpsPort": 36081, "httpPort": 34821,
 *     "lsVersion": "2.29.0", "csrfToken": "..." }
 *
 * ZERO vscode dependency — safe for extension host and workers.
 */

import * as fs from 'fs';
import * as path from 'path';
import { execFileSync } from 'child_process';
import { HUB_DISCOVERY_DIRS } from './agPaths';

export interface HubInfo {
    pid: number;
    /** Plain HTTP port (JSON ConnectRPC). */
    httpPort: number;
    /** TLS port (protobuf ConnectRPC). May be absent in future versions. */
    httpsPort: number;
    csrfToken: string;
    lsVersion?: string;
    /** Parent process — the extension host that spawned this hub, when detectable. */
    parentPid?: number;
    /** Absolute path of the hub_*.json file. */
    filePath: string;
    /** File mtime — newest hub is probed first. */
    mtimeMs: number;
}

/**
 * Parent PID lookup. The IDE spawns `agy --hub` from each window's extension
 * host, so parentPid === process.pid identifies the hub belonging to this window.
 * Returns undefined on platforms where the lookup is unavailable.
 */
function getParentPid(pid: number): number | undefined {
    try {
        if (process.platform === 'linux') {
            const status = fs.readFileSync(`/proc/${pid}/status`, 'utf8');
            const match = status.match(/^PPid:\s*(\d+)/m);
            return match ? Number(match[1]) : undefined;
        }
        if (process.platform === 'darwin') {
            const out = execFileSync('ps', ['-o', 'ppid=', '-p', String(pid)], {
                encoding: 'utf8', timeout: 1000, stdio: ['ignore', 'pipe', 'ignore'],
            });
            const ppid = parseInt(out.trim(), 10);
            return Number.isInteger(ppid) ? ppid : undefined;
        }
    } catch { /* process vanished or lookup unavailable */ }
    return undefined;
}

/** Cross-platform PID existence check (never throws). */
export function isPidAlive(pid: number): boolean {
    if (!Number.isInteger(pid) || pid <= 0) return false;
    try {
        process.kill(pid, 0);
        return true;
    } catch (e: any) {
        // EPERM means the process exists but belongs to another user.
        return e?.code === 'EPERM';
    }
}

function toPort(value: unknown): number {
    const port = Number(value);
    return Number.isInteger(port) && port > 0 && port <= 65535 ? port : 0;
}

/**
 * Read all live hub discovery files, newest first.
 * Files with dead PIDs or malformed content are ignored.
 */
export function readHubInfos(): HubInfo[] {
    const hubs: HubInfo[] = [];

    for (const dir of HUB_DISCOVERY_DIRS) {
        let entries: string[];
        try {
            entries = fs.readdirSync(dir);
        } catch { continue; }

        for (const entry of entries) {
            if (!entry.startsWith('hub_') || !entry.endsWith('.json')) continue;
            const filePath = path.join(dir, entry);

            try {
                const stat = fs.statSync(filePath);
                const raw = JSON.parse(fs.readFileSync(filePath, 'utf8'));

                const pid = Number(raw.pid);
                const httpPort = toPort(raw.httpPort ?? raw.http_port ?? raw.port);
                const httpsPort = toPort(raw.httpsPort ?? raw.https_port ?? raw.httpsServerPort);
                const csrfToken = String(raw.csrfToken ?? raw.csrf_token ?? '');

                if (!isPidAlive(pid) || !httpPort || !csrfToken) continue;

                hubs.push({
                    pid,
                    httpPort,
                    httpsPort,
                    csrfToken,
                    lsVersion: raw.lsVersion ?? raw.ls_version,
                    parentPid: getParentPid(pid),
                    filePath,
                    mtimeMs: stat.mtimeMs,
                });
            } catch { /* malformed file — ignore */ }
        }
    }

    return hubs.sort((a, b) => b.mtimeMs - a.mtimeMs);
}
