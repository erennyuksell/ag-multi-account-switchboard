/**
 * AccountCardBuilder — Pure function module for constructing pre-processed account cards.
 * No state, no side effects, easily testable. Renderer does zero logic.
 */

import { AccountQuota, AccountCard, ModelCard, LocalQuotaData } from '../types';
import { shortModelName, normalizeModelKey } from '../shared/helpers';
import { parseUserTier, parsePlanStatus } from '../utils/lsTypes';

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

const TIER_SUFFIX_RE = /\s*\((Extra Low|Low|Medium|High)\)\s*$/i;
const TIER_ORDER = ['Extra Low', 'Low', 'Medium', 'High'];

/**
 * Collapse a model's effort tiers into a single row.
 *
 * Antigravity exposes every tier as its own model, but they draw from one pool:
 * all twelve Gemini entries move together and reset at the same moment, so the
 * list showed twelve identical bars. Collapsing happens ONLY when the numbers
 * genuinely match — if a tier ever diverges it stays on its own row rather than
 * being hidden behind a sibling's percentage.
 */
function groupEffortTiers(models: ModelCard[]): ModelCard[] {
    const groups = new Map<string, ModelCard[]>();
    for (const m of models) {
        const base = m.label.replace(TIER_SUFFIX_RE, '');
        const arr = groups.get(base) ?? [];
        arr.push(m);
        groups.set(base, arr);
    }

    const out: ModelCard[] = [];
    for (const [base, group] of groups) {
        const collapsible = group.length > 1
            && group.every(g => g.pct === group[0].pct && g.resetTime === group[0].resetTime);
        if (!collapsible) { out.push(...group); continue; }

        const tiers = group
            .map(g => g.label.match(TIER_SUFFIX_RE)?.[1] || '')
            .filter(Boolean)
            .sort((a, b) => TIER_ORDER.indexOf(a) - TIER_ORDER.indexOf(b));
        out.push({ ...group[0], label: base, tiers });
    }
    return out;
}

export function buildAccountCards(
    localData: LocalQuotaData | null,
    trackedQuotas: AccountQuota[],
    activeEmailRaw: string,
    switchActive: boolean,
    selectedModels: string[],
    /**
     * When localData was actually read from the LS. Cards get re-rendered from
     * memory on every push, so stamping "now" here would present a reading kept
     * from a failed refresh as if it were live.
     */
    localDataAt = 0,
    /**
     * Account the user just asked for, while that switch is still in flight.
     * Kept separate from activeEmailRaw so a request can never be mistaken for
     * the account actually in use.
     */
    pendingEmailRaw = '',
): AccountCard[] {
    // Authority on "which account is in use" is USS — the same record
    // Antigravity's own profile menu reads. It deliberately is NOT whichever
    // language server happens to answer: the workspace instance restarts on its
    // own and the replacement can come up on the previous account, which had
    // the panel badge an account the IDE had already moved off.
    const activeEmail = (activeEmailRaw || '').toLowerCase();
    const pendingEmail = (pendingEmailRaw || '').toLowerCase();
    const cards: AccountCard[] = [];

    // Build label map from local LS data (Rosetta Stone for cross-source pin matching)
    const labelMap = buildLabelMap(localData);

    const status = localData?.userStatus;
    const localEmail = (status?.email || '').toLowerCase();

    if (status) {
        const rawModels = (status.cascadeModelConfigData?.clientModelConfigs || [])
            .filter((m: any) => m.quotaInfo)
            .sort((a: any, b: any) => (a.label || '').localeCompare(b.label || ''));

        const models: ModelCard[] = groupEffortTiers(rawModels.map((m: any) => ({
            id: m.modelOrAlias?.model || m.label,
            label: m.label || shortModelName(m.modelOrAlias?.model),
            pct: m.quotaInfo.remainingFraction !== undefined
                ? Math.max(0, Math.min(100, Math.round(m.quotaInfo.remainingFraction * 100)))
                : 0,
            resetTime: m.quotaInfo.resetTime || '',
            isLocal: true,
        })));

        const bottleneckModel = models.length > 0 ? models.reduce((a, b) => a.pct < b.pct ? a : b) : null;
        const userTier = parseUserTier(status.userTier);
        const planStatus = parsePlanStatus(status.planStatus);
        const aiCredits = userTier.availableCredits.find(c => c.creditType === 'GOOGLE_ONE_AI');

        // A switch is running and this card is not its destination.
        const isTransitioning = !!(
            switchActive && pendingEmail && localEmail && pendingEmail !== localEmail
        );

        cards.push({
            email: status.email || 'active-local',
            // Built from language server data, so it only holds the badge while
            // that server agrees with USS. When it lags behind — or restarts
            // onto the previous account — the quota numbers here describe an
            // account the IDE is no longer using, and the badge belongs to the
            // tracked card that does match.
            isActive: !activeEmail || activeEmail === localEmail,
            isTransitioning,
            pendingEmail: isTransitioning ? pendingEmailRaw : undefined,
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
            dataTimestamp: localDataAt,
        });
    }

    // Dedup: skip tracked account if its email matches local card (local has richer data).
    // During switch A→B: local=A(stale), tracked A must still be deduped.
    const dedupEmail = localEmail || '';

    for (const trackedQuota of trackedQuotas) {
        const trackedEmail = (trackedQuota.account.email || '').toLowerCase();
        if (dedupEmail && trackedEmail === dedupEmail) continue;

        const models: ModelCard[] = groupEffortTiers((trackedQuota.models || []).map(m => ({
            id: m.name,
            label: resolveLabel(m.name, labelMap),
            pct: m.percentage || 0,
            resetTime: m.resetTimeRaw || m.resetTime || '',
            isLocal: false,
        })));

        const bottleneckModel = models.length > 0 ? models.reduce((a, b) => a.pct < b.pct ? a : b) : null;

        // Requested, and USS has not moved to it yet. Driven by the in-flight
        // request rather than by language server lag, so the badge appears when
        // the user clicks and clears the moment the IDE actually switches.
        const isPendingTarget = !!(
            pendingEmail && trackedEmail === pendingEmail && trackedEmail !== activeEmail
        );

        cards.push({
            email: trackedQuota.account.email || 'Unknown',
            name: trackedQuota.account.name,
            isActive: !!activeEmail && activeEmail === trackedEmail,
            isPendingTarget,
            trackingId: trackedQuota.account.id,
            models,
            bottleneck: bottleneckModel,
            tierName: trackedQuota.tierName || trackedQuota.tier || null,
            resetTime: bottleneckModel?.resetTime || '',
            isError: trackedQuota.isError || trackedQuota.isForbidden,
            errorMessage: trackedQuota.isForbidden ? 'Access forbidden' : (trackedQuota.errorMessage || ''),
            dataTimestamp: trackedQuota.lastUpdated,
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
