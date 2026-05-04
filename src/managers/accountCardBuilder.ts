/**
 * AccountCardBuilder — Pure function module for constructing pre-processed account cards.
 * No state, no side effects, easily testable. Renderer does zero logic.
 */

import { AccountQuota, AccountCard, ModelCard, LocalQuotaData } from '../types';
import { shortModelName, normalizeModelKey } from '../shared/helpers';
import { parseUserTier, parsePlanStatus } from '../utils/lsTypes';
import { MODEL_DISPLAY_NAMES } from '../constants';

/**
 * Build a normKey → LS label lookup map from local protobuf data.
 * This is the "Rosetta Stone" that bridges LS enum IDs and API keys
 * to a single canonical label.
 *
 * Example map entries:
 *   "claudeopus46thinking" → "Claude Opus 4.6 (Thinking)"
 *   "gemini31prohigh"      → "Gemini 3.1 Pro (High)"
 */
function buildLabelMap(localData: LocalQuotaData | null): Map<string, string> {
    const map = new Map<string, string>();
    const configs = localData?.userStatus?.cascadeModelConfigData?.clientModelConfigs || [];
    for (const m of configs as any[]) {
        const label = m.label;
        if (!label) continue;
        // Index by normalized label (for matching against tracked API keys)
        map.set(normalizeModelKey(label), label);
    }
    return map;
}

/**
 * Resolve a tracked API key to the canonical LS label using the label map.
 * Uses exact normKey match first, then startsWith fallback for edge cases
 * like "claude-sonnet-4-6" matching "Claude Sonnet 4.6 (Thinking)".
 */
function resolveLabel(apiKey: string, labelMap: Map<string, string>): string {
    const norm = normalizeModelKey(apiKey);

    // 1. Exact normKey match
    const exact = labelMap.get(norm);
    if (exact) return exact;

    // 2. startsWith fallback: tracked key might be a prefix of LS label
    //    e.g. "claudesonnet46" (from "claude-sonnet-4-6")
    //    vs   "claudesonnet46thinking" (from "Claude Sonnet 4.6 (Thinking)")
    for (const [normLabel, label] of labelMap) {
        if (normLabel.startsWith(norm) || norm.startsWith(normLabel)) {
            return label;
        }
    }

    // 3. No match → fallback to shortModelName (existing behavior)
    return shortModelName(apiKey);
}

export function buildAccountCards(
    localData: LocalQuotaData | null,
    trackedQuotas: AccountQuota[],
    activeEmailRaw: string,
    switchActive: boolean,
    selectedModels: string[],
): AccountCard[] {
    const activeEmail = (activeEmailRaw || '').toLowerCase();
    const cards: AccountCard[] = [];

    // Build label map from local LS data (Rosetta Stone for cross-source pin matching)
    const labelMap = buildLabelMap(localData);

    const status = localData?.userStatus;
    const localEmail = (status?.email || '').toLowerCase();

    if (status) {
        const knownDisplayNames = new Set(Object.values(MODEL_DISPLAY_NAMES));
        const rawModels = (status.cascadeModelConfigData?.clientModelConfigs || [])
            .filter((m: any) => m.quotaInfo && knownDisplayNames.has(m.label || shortModelName(m.modelOrAlias?.model)))
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
            label: resolveLabel(m.name, labelMap),
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
