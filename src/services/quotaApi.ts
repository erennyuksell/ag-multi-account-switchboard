import * as https from 'https';
import { QUOTA_API_ENDPOINTS, LOAD_CODE_ASSIST_ENDPOINTS, MODEL_DISPLAY_NAMES, USER_AGENT } from '../constants';
import { QuotaModel, QuotaResult, HttpError } from '../types';
import { collectBody } from '../utils/http';

export class QuotaApiService {

    /** Timeout for Google Cloud quota API requests */
    private static readonly CLOUD_API_TIMEOUT_MS = 25_000;

    /** Fetch quota for a remote account using its access token */
    async fetchRemoteQuota(accessToken: string): Promise<QuotaResult> {
        // 1. Get tier info and projectId
        const { projectId, tier, tierName } = await this.loadProjectInfo(accessToken);

        // 2. Fetch quota via retrieveUserQuota
        let quotaData: any = null;
        for (const ep of QUOTA_API_ENDPOINTS) {
            try {
                quotaData = await this.postJson(ep, { project: projectId }, accessToken);
                break;
            } catch (e) {
                if (e instanceof HttpError) {
                    if (e.statusCode === 403) return { models: [], tier, tierName, isForbidden: true, isError: false };
                    if (e.statusCode === 401) throw e;
                    if (e.statusCode === 429 || e.statusCode >= 500) continue;
                }
                continue;
            }
        }

        if (!quotaData) {
            return { models: [], tier, tierName, isForbidden: false, isError: true, errorMessage: 'All endpoints exhausted' };
        }

        const models = this.parseBuckets(quotaData.buckets || []);
        return { models, tier, tierName, isForbidden: false, isError: false };
    }

    // --- Private ---

    private async loadProjectInfo(accessToken: string): Promise<{ projectId: string; tier: string | null; tierName: string | null }> {
        let projectId = 'cloudaicompanion-enterprise';
        let tier: string | null = null;
        let tierName: string | null = null;

        for (const ep of LOAD_CODE_ASSIST_ENDPOINTS) {
            try {
                const res = await this.postJson(ep, { metadata: { ideType: 'ANTIGRAVITY' } }, accessToken);
                projectId = res.cloudaicompanionProject || projectId;
                tier = res.paidTier?.id || res.currentTier?.id || null;
                tierName = res.paidTier?.name || res.currentTier?.name || null;
                break;
            } catch (e) {
                if (e instanceof HttpError) {
                    if (e.statusCode === 401) throw e;
                    if (e.statusCode === 429 || e.statusCode >= 500) continue;
                    break;
                }
                continue;
            }
        }

        return { projectId, tier, tierName };
    }

    /**
     * Parse retrieveUserQuota buckets[] response.
     * Each bucket: { tokenType, modelId, remainingFraction, resetTime? }
     * Shows ALL models — no filtering. Uses display name overrides when available,
     * otherwise auto-humanizes the model slug.
     */
    private parseBuckets(buckets: any[]): QuotaModel[] {
        const models: QuotaModel[] = [];

        for (const bucket of buckets) {
            const modelId = bucket.modelId || '';
            if (!modelId) continue;

            const cleanId = modelId.split('/').pop()!;
            const displayName = MODEL_DISPLAY_NAMES[cleanId]
                || MODEL_DISPLAY_NAMES[modelId]
                || QuotaApiService.humanizeModelId(cleanId);

            const fraction = bucket.remainingFraction ?? bucket.remaining_fraction ?? 0;
            let localResetTime = '';
            if (bucket.resetTime) {
                try {
                    localResetTime = new Date(bucket.resetTime).toLocaleString(undefined, {
                        month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false,
                    });
                } catch { localResetTime = bucket.resetTime; }
            }

            models.push({
                name: displayName,
                percentage: Math.round(fraction * 100),
                resetTime: localResetTime,
                resetTimeRaw: bucket.resetTime || '',
            });
        }

        return models.sort((a, b) => a.name.localeCompare(b.name));
    }

    /**
     * Auto-humanize a model slug: 'gemini-3.1-pro-high' → 'Gemini 3.1 Pro (High)'
     * Treats the last segment as a variant qualifier when it's a known modifier.
     */
    private static humanizeModelId(slug: string): string {
        const VARIANT_QUALIFIERS = new Set(['high', 'low', 'medium', 'fast', 'thinking', 'lite', 'experimental', 'preview']);
        const ACRONYMS = new Set(['gpt', 'oss', 'llm', 'tts', 'api']);
        const parts = slug.split('-');
        let variant = '';
        if (parts.length > 1 && VARIANT_QUALIFIERS.has(parts[parts.length - 1].toLowerCase())) {
            variant = parts.pop()!;
        }
        const base = parts.map(p => {
            if (ACRONYMS.has(p.toLowerCase())) return p.toUpperCase();
            return p.charAt(0).toUpperCase() + p.slice(1);
        }).join(' ');
        return variant ? `${base} (${variant.charAt(0).toUpperCase() + variant.slice(1)})` : base;
    }

    private postJson(endpoint: string, body: any, accessToken: string): Promise<any> {
        return new Promise((resolve, reject) => {
            const bodyStr = JSON.stringify(body);
            const parsed = new URL(endpoint);
            const req = https.request({
                hostname: parsed.hostname,
                path: parsed.pathname + parsed.search,
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Content-Length': Buffer.byteLength(bodyStr),
                    'Authorization': `Bearer ${accessToken}`,
                    'User-Agent': USER_AGENT,
                    'Accept': 'application/json',
                },
                timeout: QuotaApiService.CLOUD_API_TIMEOUT_MS,
            }, async (res) => {
                try {
                    const { status, body: data } = await collectBody(res);
                    if (status >= 200 && status < 300) {
                        try { resolve(JSON.parse(data)); } catch { resolve(data); }
                    } else {
                        reject(new HttpError(status, `HTTP ${status}: ${data.substring(0, 200)}`));
                    }
                } catch (e) { reject(e); }
            });
            req.on('error', reject);
            req.on('timeout', () => { req.destroy(); reject(new Error('Request timed out')); });
            req.write(bodyStr);
            req.end();
        });
    }
}
