import { exec } from 'child_process';
import { promisify } from 'util';
import { ServerInfo } from '../types';
import { LS_PROCESS_GREP } from '../constants';
import { getWindowsProcessLines, callLsJson } from '../utils/lsClient';

const execAsync = promisify(exec);
const isWindows = process.platform === 'win32';

export class ServerDiscoveryService {

    /**
     * Discover the local Antigravity language server.
     * 
     * Strategy:
     * 1. Process scan → find language_server PIDs + LSP CSRF tokens
     * 2. Port scan → find actual TCP listening ports for each PID
     * 3. Probe each port+CSRF combination until GetUserStatus responds
     * 
     * macOS/Linux: uses `ps` + `lsof`
     * Windows:     uses `wmic` + `netstat`
     */
    async discover(workspaceId?: string): Promise<ServerInfo | null> {
        try {
            let candidates = isWindows
                ? await this.findCandidatesWindows()
                : await this.findCandidatesUnix();

            // STRICT workspace isolation: if workspaceId is provided,
            // ONLY try candidates from the same workspace.
            // Falling through to other workspaces causes wrong-LS contamination.
            if (workspaceId) {
                const matching = candidates.filter(c => c.wsId === workspaceId);
                if (matching.length > 0) {
                    candidates = matching; // Only probe our workspace's LS
                }
                // If no match found, fall through to all candidates (cold start)
            }

            for (const cand of candidates) {
                const ports = await this.getListeningPorts(cand.pid);
                if (ports.length === 0) continue;

                for (const port of ports) {
                    try {
                        await this.probe({ port, csrfToken: cand.csrfToken, protocol: 'http' });
                        return { port, csrfToken: cand.csrfToken, protocol: 'http' as const, httpsPort: cand.httpsPort };
                    } catch { /* try next port */ }
                }
            }
        } catch {
            // No matching processes found
        }

        return null;
    }

    /** macOS / Linux: use ps to find candidates */
    private async findCandidatesUnix(): Promise<{ pid: string; csrfToken: string; wsId?: string; httpsPort?: number }[]> {
        const { stdout } = await execAsync(
            `ps -A -ww -o pid,args | grep "${LS_PROCESS_GREP}" | grep -v grep`
        );
        return this.parsePsOutput(stdout);
    }

    /** Windows: use PowerShell + wmic fallback to find candidates */
    private async findCandidatesWindows(): Promise<{ pid: string; csrfToken: string; wsId?: string; httpsPort?: number }[]> {
        const lines = await getWindowsProcessLines(LS_PROCESS_GREP);
        return lines.flatMap(line => {
            const csrf = line.match(/--csrf_token[\s=]+([a-zA-Z0-9-]+)/)?.[1];
            const pid  = line.match(/--api_server_port[\s=]+(\d+)/)?.[1]  // not used but present
                      ?? line.match(/ProcessId[=,"\s]*(\d+)/i)?.[1];
            // PID comes from PowerShell's ExpandProperty — not in the line itself.
            // Use a sentinel to force port-scan-all-LS-ports fallback when pid unknown.
            const wsId = line.match(/--workspace_id[\s=]+(\S+)/)?.[1];
            const httpsPortMatch = line.match(/--https_server_port[\s=]+(\d+)/);
            return csrf ? [{ pid: pid ?? '0', csrfToken: csrf, wsId, httpsPort: httpsPortMatch ? parseInt(httpsPortMatch[1], 10) : undefined }] : [];
        });
    }

    /** Parse `ps` stdout into candidates */
    private parsePsOutput(stdout: string): { pid: string; csrfToken: string; wsId?: string; httpsPort?: number }[] {
        const candidates: { pid: string; csrfToken: string; wsId?: string; httpsPort?: number }[] = [];
        for (const line of stdout.split('\n')) {
            if (!line.trim()) continue;
            const pidMatch = line.trim().match(/^(\d+)\s/);
            if (!pidMatch) continue;
            const tokenMatch = line.match(/--csrf_token\s+([a-zA-Z0-9\-]+)/);
            if (!tokenMatch) continue;
            const wsMatch = line.match(/--workspace_id\s+(\S+)/);
            const httpsPortMatch = line.match(/--https_server_port\s+(\d+)/);
            candidates.push({
                pid: pidMatch[1],
                csrfToken: tokenMatch[1],
                wsId: wsMatch?.[1],
                httpsPort: httpsPortMatch ? parseInt(httpsPortMatch[1], 10) : undefined,
            });
        }
        return candidates;
    }

    /** Get TCP listening ports for a specific PID */
    private async getListeningPorts(pid: string): Promise<number[]> {
        try {
            const ports: number[] = [];
            if (isWindows) {
                // netstat -ano shows PID in last column
                const { stdout } = await execAsync(`netstat -ano -p TCP 2>nul`);
                for (const line of stdout.split('\n')) {
                    if (!line.includes('LISTENING')) continue;
                    const parts = line.trim().split(/\s+/);
                    if (parts[parts.length - 1] !== pid) continue;
                    const portMatch = parts[1]?.match(/:(\d+)$/);
                    if (portMatch) ports.push(parseInt(portMatch[1], 10));
                }
            } else {
                const { stdout } = await execAsync(
                    `lsof -Pan -p ${pid} -i TCP -sTCP:LISTEN 2>/dev/null`
                );
                for (const line of stdout.split('\n')) {
                    const match = line.match(/:(\d+)\s+\(LISTEN\)/);
                    if (match) ports.push(parseInt(match[1], 10));
                }
            }
            return ports;
        } catch {
            return [];
        }
    }

    /** Fetch GetUserStatus from the local language server */
    fetchLocalQuota(serverInfo: ServerInfo): Promise<any> {
        return callLsJson(serverInfo, 'GetUserStatus', {
            metadata: { ideName: 'antigravity', extensionName: 'antigravity', locale: 'en' },
        }, 3000);
    }

    /** Quick probe to validate a server candidate */
    private probe(serverInfo: ServerInfo): Promise<void> {
        return this.fetchLocalQuota(serverInfo).then(() => {});
    }
}
