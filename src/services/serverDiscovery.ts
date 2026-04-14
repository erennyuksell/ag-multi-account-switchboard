import { exec } from 'child_process';
import { promisify } from 'util';
import * as http from 'http';
import { ServerInfo } from '../types';
import { LS_PROCESS_GREP } from '../constants';

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
            const candidates = isWindows
                ? await this.findCandidatesWindows()
                : await this.findCandidatesUnix();

            // Prioritize: exact workspace match first, then any
            if (workspaceId) {
                candidates.sort((a, b) => {
                    const aMatch = a.wsId === workspaceId ? 0 : 1;
                    const bMatch = b.wsId === workspaceId ? 0 : 1;
                    return aMatch - bMatch;
                });
            }

            for (const cand of candidates) {
                const ports = await this.getListeningPorts(cand.pid);
                if (ports.length === 0) continue;

                for (const port of ports) {
                    try {
                        await this.probe({ port, csrfToken: cand.csrfToken, protocol: 'http' });
                        return { port, csrfToken: cand.csrfToken, protocol: 'http' };
                    } catch { /* try next port */ }
                }
            }
        } catch {
            // No matching processes found
        }

        return null;
    }

    /** macOS / Linux: use ps to find candidates */
    private async findCandidatesUnix(): Promise<{ pid: string; csrfToken: string; wsId?: string }[]> {
        const { stdout } = await execAsync(
            `ps -A -ww -o pid,args | grep "${LS_PROCESS_GREP}" | grep -v grep`
        );
        return this.parsePsOutput(stdout);
    }

    /** Windows: use wmic to find candidates */
    private async findCandidatesWindows(): Promise<{ pid: string; csrfToken: string; wsId?: string }[]> {
        const { stdout } = await execAsync(
            `wmic process where "CommandLine like '%${LS_PROCESS_GREP}%'" get ProcessId,CommandLine /format:csv 2>nul`
        );
        // wmic CSV: Node,CommandLine,ProcessId
        const candidates: { pid: string; csrfToken: string; wsId?: string }[] = [];
        for (const line of stdout.split('\n')) {
            const tokenMatch = line.match(/--csrf_token\s+([a-zA-Z0-9\-]+)/);
            if (!tokenMatch) continue;
            const pidMatch = line.trim().match(/,(\d+)\s*$/);
            if (!pidMatch) continue;
            const wsMatch = line.match(/--workspace_id\s+(\S+)/);
            candidates.push({ pid: pidMatch[1], csrfToken: tokenMatch[1], wsId: wsMatch?.[1] });
        }
        return candidates;
    }

    /** Parse `ps` stdout into candidates */
    private parsePsOutput(stdout: string): { pid: string; csrfToken: string; wsId?: string }[] {
        const candidates: { pid: string; csrfToken: string; wsId?: string }[] = [];
        for (const line of stdout.split('\n')) {
            if (!line.trim()) continue;
            const pidMatch = line.trim().match(/^(\d+)\s/);
            if (!pidMatch) continue;
            const tokenMatch = line.match(/--csrf_token\s+([a-zA-Z0-9\-]+)/);
            if (!tokenMatch) continue;
            const wsMatch = line.match(/--workspace_id\s+(\S+)/);
            candidates.push({ pid: pidMatch[1], csrfToken: tokenMatch[1], wsId: wsMatch?.[1] });
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
        return new Promise((resolve, reject) => {
            const body = JSON.stringify({
                metadata: { ideName: 'antigravity', extensionName: 'antigravity', locale: 'en' },
            });

            const req = http.request({
                hostname: '127.0.0.1',
                port: serverInfo.port,
                path: '/exa.language_server_pb.LanguageServerService/GetUserStatus',
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Content-Length': Buffer.byteLength(body),
                    'Connect-Protocol-Version': '1',
                    'X-Codeium-Csrf-Token': serverInfo.csrfToken,
                },
                timeout: 3000,
            }, (res: any) => {
                let chunks = '';
                res.on('data', (chunk: any) => chunks += chunk);
                res.on('end', () => {
                    if (res.statusCode && res.statusCode >= 200 && res.statusCode < 300) {
                        try {
                            resolve(JSON.parse(chunks));
                        } catch {
                            reject(new Error('Invalid JSON response'));
                        }
                    } else {
                        reject(new Error(`Server responded with status ${res.statusCode}`));
                    }
                });
            });

            req.on('error', (e: any) => reject(e));
            req.on('timeout', () => { req.destroy(); reject(new Error('Request timed out')); });
            req.write(body);
            req.end();
        });
    }

    /** Quick probe to validate a server candidate */
    private probe(serverInfo: ServerInfo): Promise<void> {
        return this.fetchLocalQuota(serverInfo).then(() => {});
    }
}
