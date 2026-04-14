import { exec } from 'child_process';
import { promisify } from 'util';
import * as http from 'http';
import { ServerInfo } from '../types';

const execAsync = promisify(exec);

export class ServerDiscoveryService {

    /**
     * Discover the local Antigravity language server.
     * 
     * Strategy:
     * 1. `ps` scan → find language_server PIDs + LSP CSRF tokens
     * 2. `lsof` → find actual TCP listening ports for each PID
     * 3. Probe each port+CSRF combination until GetUserStatus responds
     * 
     * Why not use args ports? The `--extension_server_port` in args is a different
     * server that doesn't serve GetUserStatus (returns 404). The actual HTTP API
     * port is dynamically assigned and only discoverable via lsof.
     */
    async discover(workspaceId?: string): Promise<ServerInfo | null> {
        try {
            const { stdout } = await execAsync(
                'ps -A -ww -o pid,args | grep "language_server_macos" | grep -v grep'
            );

            const candidates: { pid: string; csrfToken: string; wsId?: string }[] = [];

            for (const line of stdout.split('\n')) {
                if (!line.trim()) continue;

                const pidMatch = line.trim().match(/^(\d+)\s/);
                if (!pidMatch) continue;
                const pid = pidMatch[1];

                const tokenMatch = line.match(/--csrf_token\s+([a-zA-Z0-9\-]+)/);
                if (!tokenMatch) continue;

                const wsMatch = line.match(/--workspace_id\s+(\S+)/);

                candidates.push({
                    pid,
                    csrfToken: tokenMatch[1],
                    wsId: wsMatch?.[1],
                });
            }

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

    /** Get TCP listening ports for a specific PID */
    private async getListeningPorts(pid: string): Promise<number[]> {
        try {
            const { stdout } = await execAsync(
                `lsof -Pan -p ${pid} -i TCP -sTCP:LISTEN 2>/dev/null`
            );
            const ports: number[] = [];
            for (const line of stdout.split('\n')) {
                const match = line.match(/:(\d+)\s+\(LISTEN\)/);
                if (match) ports.push(parseInt(match[1], 10));
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
