import { exec } from 'child_process';
import { promisify } from 'util';
import { ServerInfo } from '../types';
import { LS_PROCESS_GREP, CSRF_TOKEN_RE, isWindows, CASCADE_PROBE_TIMEOUT_MS, PROCESS_EXEC_TIMEOUT_MS } from '../constants';
import { getWindowsProcessLines, callLsJson } from '../utils/lsClient';
import { readHubInfos } from '../shared/hub';
import { createLogger } from '../utils/logger';

const log = createLogger('ServerDiscovery');

const execAsync = promisify(exec);

interface DiscoveryCandidate {
    pid: string;
    csrfToken: string;
    wsId?: string;
    /** HTTP/JSON port when known directly (hub discovery). */
    httpPort?: number;
    httpsPort?: number;
    source: 'hub' | 'process';
}

export class ServerDiscoveryService {

    /**
     * Discover the local Antigravity language server.
     *
     * Strategy:
     * 1. Hub discovery → read `daemon/hub_*.json` (Antigravity 2.6+)
     * 2. Process scan → find legacy language_server PIDs + LSP CSRF tokens
     * 3. Port scan → find actual TCP listening ports for each PID
     * 4. Probe each port+CSRF combination until GetUserStatus responds
     *
     * macOS/Linux: uses `ps` + `lsof`
     * Windows:     uses `wmic` + `netstat`
     */
    async discover(workspaceId?: string): Promise<ServerInfo | null> {
        try {
            let candidates = await this.findCandidates();

            log.diag(`discover: ${candidates.length} candidates on ${isWindows ? 'Windows' : 'Unix'} (wsFilter=${workspaceId ?? 'none'})`);
            if (candidates.length > 0) {
                log.diag(`discover: ${candidates.map(c => `${c.source}:pid=${c.pid} wsId=${c.wsId ?? 'global'}`).join(' | ')}`);
            }

            // STRICT workspace isolation applies to legacy per-workspace LS processes.
            // Hub candidates are global and always relevant.
            if (workspaceId) {
                const matching = candidates.filter(c => c.source === 'hub' || c.wsId === workspaceId);
                log.diag(`discover: workspace filter '${workspaceId}' → ${matching.length}/${candidates.length} match`);
                if (matching.some(c => c.source === 'process')) {
                    candidates = matching; // Only probe our workspace's LS (+ global hub)
                }
                // If no matching process exists, fall through to all candidates (cold start)
            }

            for (const cand of candidates) {
                const ports = cand.httpPort
                    ? [cand.httpPort]
                    : await this.getListeningPorts(cand.pid);
                log.diag(`discover: ${cand.source} pid=${cand.pid} → ports: [${ports.join(', ')}]`);
                if (ports.length === 0) {
                    log.warn(`discover: ${cand.source} pid=${cand.pid} has no listening TCP ports — skipping`);
                    continue;
                }

                for (const port of ports) {
                    try {
                        await this.probe({ port, csrfToken: cand.csrfToken, protocol: 'http' });
                        log.diag(`discover: ✓ ${cand.source} port ${port} pid=${cand.pid}`);
                        return { port, csrfToken: cand.csrfToken, protocol: 'http' as const, httpsPort: cand.httpsPort };
                    } catch (e: any) {
                        log.diag(`discover: ${cand.source} port ${port} failed`);
                    }
                }
            }

        } catch (e: any) {
            log.warn('discover: exception during discovery:', e?.message);
        }

        return null;
    }

    /**
     * Discover the LS instance that handles cascade/chat operations.
     *
     * Legacy IDE runs TWO LS processes:
     *   1. Workspace LS (--workspace_id, --enable_lsp) → code completions, quota
     *   2. Global LS (no workspace_id) → cascade/chat inference, generator metadata
     *
     * The Antigravity 2.6+ hub is always global, so it is the preferred target.
     *
     * Strategy: try global candidates (hub + legacy no-workspace LS), probe each with
     * GetCascadeTrajectory for the given cascadeId, and return the one that has actual
     * data (numTotalGeneratorMetadata > 0). Falls back to the workspace LS.
     */
    async discoverCascadeServer(cascadeId: string, workspaceServer?: ServerInfo | null): Promise<ServerInfo | null> {
        try {
            const candidates = await this.findCandidates();

            // Prioritize global candidates (hub or legacy Global LS).
            const globalCandidates = candidates.filter(c => c.source === 'hub' || !c.wsId);

            // Track the first reachable Global LS — even if it has no data for this
            // cascade yet (brand new conversation), it's still the correct target.
            let firstReachableGlobal: ServerInfo | null = null;

            for (const cand of globalCandidates) {
                const ports = cand.httpPort
                    ? [cand.httpPort]
                    : await this.getListeningPorts(cand.pid);
                if (ports.length === 0) continue;

                for (const port of ports) {
                    try {
                        const info: ServerInfo = { port, csrfToken: cand.csrfToken, protocol: 'http' as const, httpsPort: cand.httpsPort };
                        const resp = await callLsJson(info, 'GetCascadeTrajectory', { cascade_id: cascadeId }, CASCADE_PROBE_TIMEOUT_MS);
                        const metaCount = parseInt(resp?.numTotalGeneratorMetadata || '0', 10);
                        if (!firstReachableGlobal) firstReachableGlobal = info;
                        if (metaCount > 0) return info;
                    } catch { /* port doesn't respond */ }
                }
            }

            // Brand new cascade: Global LS is reachable but has no metadata yet.
            // Return it anyway — data will appear once inference starts.
            if (firstReachableGlobal) return firstReachableGlobal;
        } catch { /* expected: HTTP probe may fail if port not listening */
            // Discovery failed
        }

        // Fallback: return workspace server only if no Global LS is reachable
        return workspaceServer ?? null;
    }

    /** Hub (2.6+) + legacy process candidates, hubs first. */
    private async findCandidates(): Promise<DiscoveryCandidate[]> {
        const hubs = this.findHubCandidates();
        const processes = isWindows
            ? await this.findCandidatesWindows()
            : await this.findCandidatesUnix();
        return [...hubs, ...processes];
    }

    /** Antigravity 2.6+ hub discovery via daemon/hub_*.json. */
    private findHubCandidates(): DiscoveryCandidate[] {
        try {
            const hubs = readHubInfos();

            // Each IDE window has its own hub. Prefer the hub spawned by THIS
            // extension host so per-workspace cascade/context data resolves to
            // the right window when several windows are open.
            const ownPid = process.pid;
            hubs.sort((a, b) =>
                Number(b.parentPid === ownPid) - Number(a.parentPid === ownPid));

            for (const hub of hubs) {
                const own = hub.parentPid === ownPid ? ' own' : '';
                log.info(`findHubCandidates: pid=${hub.pid}${own} ppid=${hub.parentPid ?? '?'} http=${hub.httpPort} https=${hub.httpsPort || 'none'} ls=${hub.lsVersion ?? '?'} file=${hub.filePath}`);
            }
            return hubs.map(hub => ({
                pid: String(hub.pid),
                csrfToken: hub.csrfToken,
                httpPort: hub.httpPort,
                httpsPort: hub.httpsPort || undefined,
                source: 'hub' as const,
            }));
        } catch (e: any) {
            log.warn('findHubCandidates: failed:', e?.message);
            return [];
        }
    }

    /** macOS / Linux: use ps to find legacy candidates */
    private async findCandidatesUnix(): Promise<DiscoveryCandidate[]> {
        try {
            const { stdout } = await execAsync(
                `ps -A -ww -o pid,args | grep "${LS_PROCESS_GREP}" | grep -v grep`,
                { timeout: PROCESS_EXEC_TIMEOUT_MS },
            );
            return this.parsePsOutput(stdout);
        } catch {
            // grep exits 1 when no language_server process is running — normal on 2.6+.
            return [];
        }
    }

    /** Windows: use PowerShell + wmic fallback to find candidates (with PID) */
    private async findCandidatesWindows(): Promise<DiscoveryCandidate[]> {
        // Emit "PID|||CommandLine" per process so we can capture the real PID.
        // Triple-pipe separator is safe — never appears in process command lines.
        const ps = `powershell -NoProfile -Command "Get-WmiObject Win32_Process | Where-Object { $_.CommandLine -like '*${LS_PROCESS_GREP}*' } | ForEach-Object { ($_.ProcessId.ToString() + '|||' + $_.CommandLine) }"`;
        const wmicFallback = `wmic process where "CommandLine like '%${LS_PROCESS_GREP}%'" get ProcessId,CommandLine /format:csv 2>nul`;

        let rawLines: string[] = [];

        try {
            const { stdout } = await execAsync(ps, { timeout: PROCESS_EXEC_TIMEOUT_MS });
            rawLines = stdout.split('\n').map(l => l.trim()).filter(Boolean);
            log.info(`findCandidatesWindows: PowerShell returned ${rawLines.length} line(s)`);
        } catch (e: any) {
            log.warn(`findCandidatesWindows: PowerShell failed (${e?.message}) — trying wmic CSV fallback`);
            try {
                // wmic CSV: "Node,CommandLine,ProcessId" header + data rows
                const { stdout } = await execAsync(wmicFallback, { timeout: PROCESS_EXEC_TIMEOUT_MS });
                const csvLines = stdout.split('\n').map(l => l.trim()).filter(Boolean);
                // Skip header row, convert "Node,CmdLine,PID" → "PID|||CmdLine"
                for (const line of csvLines.slice(1)) {
                    const cols = line.split(',');
                    if (cols.length >= 3) {
                        const pid = cols[cols.length - 1].trim();
                        const cmdLine = cols.slice(1, -1).join(',').trim();
                        rawLines.push(`${pid}|||${cmdLine}`);
                    }
                }
                log.info(`findCandidatesWindows: wmic CSV returned ${rawLines.length} line(s)`);
            } catch (e2: any) {
                log.warn(`findCandidatesWindows: wmic also failed (${e2?.message}) — falling back to CommandLine-only (pid=0)`);
                rawLines = (await getWindowsProcessLines(LS_PROCESS_GREP)).map(l => `0|||${l}`);
            }
        }

        return rawLines.flatMap(line => {
            const sepIdx = line.indexOf('|||');
            let pid = '0';
            let cmdLine = line;
            if (sepIdx > 0) {
                const maybePid = line.substring(0, sepIdx).trim();
                if (/^\d+$/.test(maybePid)) {
                    pid = maybePid;
                    cmdLine = line.substring(sepIdx + 3);
                }
            }
            const csrf = cmdLine.match(CSRF_TOKEN_RE)?.[1];
            const wsId = cmdLine.match(/--workspace_id[\s=]+(\S+)/)?.[1];
            const httpsPortMatch = cmdLine.match(/--https_server_port[\s=]+(\d+)/);
            if (csrf) {
                log.info(`findCandidatesWindows: candidate pid=${pid} wsId=${wsId ?? 'global'} httpsPort=${httpsPortMatch?.[1] ?? 'none'} csrf=${csrf.substring(0, 8)}...`);
            }
            return csrf ? [{
                pid,
                csrfToken: csrf,
                wsId,
                httpsPort: httpsPortMatch ? parseInt(httpsPortMatch[1], 10) : undefined,
                source: 'process' as const,
            }] : [];
        });
    }

    /** Parse `ps` stdout into candidates */
    private parsePsOutput(stdout: string): DiscoveryCandidate[] {
        const candidates: DiscoveryCandidate[] = [];
        for (const line of stdout.split('\n')) {
            if (!line.trim()) continue;
            const pidMatch = line.trim().match(/^(\d+)\s/);
            if (!pidMatch) continue;
            const tokenMatch = line.match(CSRF_TOKEN_RE);
            if (!tokenMatch) continue;
            const wsMatch = line.match(/--workspace_id\s+(\S+)/);
            const httpsPortMatch = line.match(/--https_server_port\s+(\d+)/);
            candidates.push({
                pid: pidMatch[1],
                csrfToken: tokenMatch[1],
                wsId: wsMatch?.[1],
                httpsPort: httpsPortMatch ? parseInt(httpsPortMatch[1], 10) : undefined,
                source: 'process',
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
        } catch { /* expected: discovery may fail under heavy load */
            return [];
        }
    }

    /** Fetch GetUserStatus from the local language server */
    fetchLocalQuota(serverInfo: ServerInfo): Promise<any> {
        return callLsJson(serverInfo, 'GetUserStatus', {
            metadata: { ideName: 'antigravity', extensionName: 'antigravity', locale: 'en' },
        }, CASCADE_PROBE_TIMEOUT_MS);
    }

    /** Quick probe to validate a server candidate */
    private probe(serverInfo: ServerInfo): Promise<void> {
        return this.fetchLocalQuota(serverInfo).then(() => {});
    }
}
