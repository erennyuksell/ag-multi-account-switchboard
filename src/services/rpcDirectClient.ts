/**
 * RpcDirectClient — Direct HTTPS RPC to Antigravity's language server.
 * Bypasses USS binary via Connect-protocol JSON RPC calls.
 * Falls back gracefully if HTTPS port unavailable or RPC fails.
 *
 * Patterns adopted from ddarkr/antigravity-token-monitor:
 * - Heartbeat validation before first use
 * - GetCascadeTrajectory → GetCascadeTrajectorySteps dual-endpoint fallback
 */

import { ServerInfo } from '../types';
import { callLsHttpsJson } from '../utils/lsClient';
import { createLogger } from '../utils/logger';

const log = createLogger('RpcDirect');

const SVC = '/exa.language_server_pb.LanguageServerService';

export class RpcDirectClient {
    private validated = false;

    constructor(private readonly serverInfo: ServerInfo) {}

    isAvailable(): boolean {
        return typeof this.serverInfo.httpsPort === 'number' && this.serverInfo.httpsPort > 0;
    }

    /** Validate connection with a Heartbeat RPC before first real use. */
    async heartbeat(): Promise<boolean> {
        if (this.validated) return true;
        const resp = await this.rpc(`${SVC}/Heartbeat`, { uuid: '00000000-0000-0000-0000-000000000000' }, 2000);
        this.validated = resp !== null;
        return this.validated;
    }

    /** Get metadata for a cascade. Returns raw items or null on failure. */
    async getMetadata(cascadeId: string): Promise<any[] | null> {
        const PAGE_SIZE = 250;
        const MAX_PAGES = 20; // safety cap: 5000 entries max
        const allMeta: any[] = [];

        for (let page = 0; page < MAX_PAGES; page++) {
            // Use cumulative offset (allMeta.length) — NOT page*PAGE_SIZE.
            // The server returns items starting at the offset; fixed-step offsets
            // cause overlapping windows and duplicate entries.
            const resp = await this.rpc(`${SVC}/GetCascadeTrajectoryGeneratorMetadata`, {
                cascade_id: cascadeId, generator_metadata_offset: allMeta.length,
            });
            const items = resp ? (resp.generatorMetadata || resp.generator_metadata || []) : [];
            if (!Array.isArray(items) || items.length === 0) break;
            allMeta.push(...items);
            if (items.length < PAGE_SIZE) break;
        }

        return allMeta.length > 0 ? allMeta : null;
    }

    /**
     * Get steps for a cascade — paginated fetch with dual endpoint fallback:
     * 1. GetCascadeTrajectorySteps (flat .steps — paginated)
     * 2. GetCascadeTrajectory (nested .trajectory.steps — single page fallback)
     */
    async getSteps(cascadeId: string): Promise<any[] | null> {
        // Primary: paginated flat step list (consistent with how HTTP fallback works)
        const PAGE_SIZE = 5000; // Steps endpoint returns large pages (~6k), use generous size
        const MAX_PAGES = 10;   // safety cap: 50k steps max
        const allSteps: any[] = [];

        for (let page = 0; page < MAX_PAGES; page++) {
            const resp = await this.rpc(`${SVC}/GetCascadeTrajectorySteps`, {
                cascade_id: cascadeId, step_offset: page === 0 ? 0 : allSteps.length,
            });
            const items = resp ? (resp.steps || []) : [];
            if (!Array.isArray(items) || items.length === 0) break;
            allSteps.push(...items);
            if (items.length < PAGE_SIZE) break;
        }

        if (allSteps.length > 0) return allSteps;

        // Fallback: GetCascadeTrajectory — returns nested trajectory with steps
        const full = await this.rpc(`${SVC}/GetCascadeTrajectory`, { cascadeId });
        if (full?.trajectory?.steps && Array.isArray(full.trajectory.steps)) {
            return full.trajectory.steps;
        }

        return null;
    }

    /** RPC call with built-in error handling — returns null on any failure. */
    private async rpc(path: string, body: Record<string, unknown>, timeoutMs = 8000): Promise<any | null> {
        if (!this.isAvailable()) return null;
        try {
            return await this.httpsPost(path, body, timeoutMs);
        } catch (e: any) {
            log.warn(`RPC ${path.split('/').pop()} failed:`, e?.message);
            return null;
        }
    }

    private httpsPost(path: string, body: Record<string, unknown>, timeoutMs = 8000): Promise<any> {
        return callLsHttpsJson(this.serverInfo.httpsPort!, this.serverInfo.csrfToken, path, body, timeoutMs);
    }
}
