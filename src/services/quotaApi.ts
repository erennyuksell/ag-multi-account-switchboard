import * as https from 'https';
import { QUOTA_API_ENDPOINTS, LOAD_CODE_ASSIST_ENDPOINTS, IMPORTANT_MODELS, USER_AGENT, DEFAULT_PROJECT_ID } from '../constants';
import { QuotaModel, QuotaResult, HttpError } from '../types';
import { collectBody } from '../utils/http';

export class QuotaApiService {

    /** Fetch quota for a remote account using its access token */
    async fetchRemoteQuota(accessToken: string): Promise<QuotaResult> {
        // 1. Get project ID + tier
        const { projectId, tier, tierName } = await this.loadProjectInfo(accessToken);

        // 2. Fetch model quotas
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
                // Network / timeout errors → try next endpoint
                continue;
            }
        }

        if (!quotaData) {
            return { models: [], tier, tierName, isForbidden: false, isError: true, errorMessage: 'All endpoints exhausted' };
        }

        const models = this.parseModels(quotaData.models || {});
        return { models, tier, tierName, isForbidden: false, isError: false };
    }

    // --- Private ---

    private async loadProjectInfo(accessToken: string): Promise<{ projectId: string; tier: string | null; tierName: string | null }> {
        let projectId = DEFAULT_PROJECT_ID;
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
                    break; // Other HTTP errors → stop
                }
                // Network / timeout → try next endpoint
                continue;
            }
        }

        return { projectId, tier, tierName };
    }

    private parseModels(modelsData: Record<string, any>): QuotaModel[] {
        const models: QuotaModel[] = [];

        for (const [name, info] of Object.entries(modelsData)) {
            if (!IMPORTANT_MODELS.some(kw => name.toLowerCase().includes(kw))) continue;

            const quotaInfo = (info as any).quotaInfo || {};
            let localResetTime = '';
            if (quotaInfo.resetTime) {
                try {
                    localResetTime = new Date(quotaInfo.resetTime).toLocaleString(undefined, {
                        month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false,
                    });
                } catch { localResetTime = quotaInfo.resetTime; }
            }

            models.push({
                name,
                percentage: Math.round((quotaInfo.remainingFraction || 0) * 100),
                resetTime: localResetTime,
                resetTimeRaw: quotaInfo.resetTime || '',
            });
        }

        return models.sort((a, b) => a.name.localeCompare(b.name));
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
                timeout: 25000,
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
