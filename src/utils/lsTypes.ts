/**
 * Runtime type guards for Language Server protobuf responses.
 *
 * Replaces `status.userTier || {} as any` patterns with safe,
 * validated wrappers that prevent silent undefined access when
 * the LS response shape changes.
 *
 * Zero external dependencies — manual guards (Zod-lite pattern).
 */

/** Validated LS UserTier — replaces `status.userTier || {} as any` */
export interface SafeUserTier {
    name: string | null;
    id: string | null;
    availableCredits: Array<{ creditType: string; creditAmount: string }>;
}

export function parseUserTier(raw: unknown): SafeUserTier {
    if (!raw || typeof raw !== 'object') {
        return { name: null, id: null, availableCredits: [] };
    }
    const r = raw as Record<string, unknown>;
    return {
        name: typeof r.name === 'string' ? r.name : null,
        id: typeof r.id === 'string' ? r.id : null,
        availableCredits: Array.isArray(r.availableCredits)
            ? (r.availableCredits as any[]).filter(
                (c) => c && typeof c === 'object' && typeof c.creditType === 'string'
            )
            : [],
    };
}

/** Validated LS PlanStatus — replaces `status.planStatus || {} as any` */
export interface SafePlanStatus {
    availablePromptCredits: number | null;
    availableFlowCredits: number | null;
    planInfo: {
        monthlyPromptCredits: number | null;
        monthlyFlowCredits: number | null;
    };
}

export function parsePlanStatus(raw: unknown): SafePlanStatus {
    if (!raw || typeof raw !== 'object') {
        return {
            availablePromptCredits: null,
            availableFlowCredits: null,
            planInfo: { monthlyPromptCredits: null, monthlyFlowCredits: null },
        };
    }
    const r = raw as Record<string, unknown>;
    const pi = (r.planInfo && typeof r.planInfo === 'object')
        ? r.planInfo as Record<string, unknown>
        : {} as Record<string, unknown>;
    return {
        availablePromptCredits: typeof r.availablePromptCredits === 'number'
            ? r.availablePromptCredits : null,
        availableFlowCredits: typeof r.availableFlowCredits === 'number'
            ? r.availableFlowCredits : null,
        planInfo: {
            monthlyPromptCredits: typeof pi.monthlyPromptCredits === 'number'
                ? pi.monthlyPromptCredits : null,
            monthlyFlowCredits: typeof pi.monthlyFlowCredits === 'number'
                ? pi.monthlyFlowCredits : null,
        },
    };
}
