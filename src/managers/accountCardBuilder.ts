/**
 * AccountCardBuilder — Pure function module for constructing pre-processed account cards.
 * No state, no side effects, easily testable. Renderer does zero logic.
 */

import { AccountQuota, AccountCard, ModelCard, LocalQuotaData } from '../types';
import { shortModelName } from '../shared/helpers';
import { parseUserTier, parsePlanStatus } from '../utils/lsTypes';

export function buildAccountCards(
    localData: LocalQuotaData | null,
    trackedQuotas: AccountQuota[],
    activeEmailRaw: string,
    switchActive: boolean,
    selectedModels: string[],
): AccountCard[] {
    const activeEmail = (activeEmailRaw || '').toLowerCase();
    const cards: AccountCard[] = [];

    const status = localData?.userStatus;
    const localEmail = (status?.email || '').toLowerCase();

    if (status) {
        const rawModels = (status.cascadeModelConfigData?.clientModelConfigs || [])
            .filter((m: any) => m.quotaInfo)
            .sort((a: any, b: any) => (a.label || '').localeCompare(b.label || ''));

        const models: ModelCard[] = rawModels.map((m: any) => ({
            id: m.modelOrAlias?.model || m.label,
            label: m.label || shortModelName(m.modelOrAlias?.model),
            pct: m.quotaInfo.remainingFraction !== undefined
                ? Math.max(0, Math.min(100, Math.round(m.quotaInfo.remainingFraction * 100)))
                : 0,
            resetTime: m.quotaInfo.resetTime || '',
            isLocal: true,
        }));

        const bottleneckModel = models.length > 0 ? models.reduce((a, b) => a.pct < b.pct ? a : b) : null;
        const userTier = parseUserTier(status.userTier);
        const planStatus = parsePlanStatus(status.planStatus);
        const aiCredits = userTier.availableCredits.find(c => c.creditType === 'GOOGLE_ONE_AI');

        // Intent email ≠ LS email → switch in progress, LS hasn't adopted new identity yet
        const isTransitioning = !!(
            activeEmail && localEmail &&
            activeEmail !== localEmail &&
            switchActive
        );

        cards.push({
            email: status.email || 'active-local',
            isActive: !activeEmail || activeEmail === localEmail,
            isTransitioning,
            pendingEmail: isTransitioning ? activeEmailRaw : undefined,
            models,
            bottleneck: bottleneckModel,
            tierName: userTier.name,
            tierId: userTier.id,
            aiCredits: aiCredits ? parseInt(aiCredits.creditAmount, 10) : null,
            promptCredits: planStatus.availablePromptCredits,
            promptCreditsMax: planStatus.planInfo.monthlyPromptCredits,
            flowCredits: planStatus.availableFlowCredits,
            flowCreditsMax: planStatus.planInfo.monthlyFlowCredits,
            resetTime: bottleneckModel?.resetTime || models[0]?.resetTime || '',
            isError: false,
            selectedModels,
            isLocal: true,
        });
    }

    // Dedup: skip tracked account if its email matches local card (local has richer data).
    // During switch A→B: local=A(stale), tracked A must still be deduped.
    const dedupEmail = localEmail || '';

    for (const trackedQuota of trackedQuotas) {
        const trackedEmail = (trackedQuota.account.email || '').toLowerCase();
        if (dedupEmail && trackedEmail === dedupEmail) continue;

        const models: ModelCard[] = (trackedQuota.models || []).map(m => ({
            id: m.name,
            label: shortModelName(m.name),
            pct: m.percentage || 0,
            resetTime: m.resetTimeRaw || m.resetTime || '',
            isLocal: false,
        }));

        const bottleneckModel = models.length > 0 ? models.reduce((a, b) => a.pct < b.pct ? a : b) : null;

        cards.push({
            email: trackedQuota.account.email || 'Unknown',
            name: trackedQuota.account.name,
            isActive: !!(activeEmail && activeEmail === trackedEmail),
            trackingId: trackedQuota.account.id,
            models,
            bottleneck: bottleneckModel,
            tierName: trackedQuota.tierName || trackedQuota.tier || null,
            resetTime: bottleneckModel?.resetTime || '',
            isError: trackedQuota.isError || trackedQuota.isForbidden,
            errorMessage: trackedQuota.isForbidden ? 'Access forbidden' : (trackedQuota.errorMessage || ''),
            selectedModels: [],
            isLocal: false,
            aiCredits: null,
            promptCredits: null,
            promptCreditsMax: null,
            flowCredits: null,
            flowCreditsMax: null,
        });
    }

    cards.sort((a, b) => (a.isActive ? 0 : 1) - (b.isActive ? 0 : 1));
    return cards;
}
