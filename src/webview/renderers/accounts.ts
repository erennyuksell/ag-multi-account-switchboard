/**
 * Account tab renderer — builds the account card HTML for the sidebar.
 */

import { dotClass, fillClass, timeLeft, shortModelName, shortTierName, fmtK, fmtNum } from '../../shared/helpers';
import { pinnedModels } from '../context';

// SVG icon constants for tracked account action buttons
const SWITCH_SVG = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M8 3 4 7l4 4"/><path d="M4 7h16"/><path d="M16 21l4-4-4-4"/><path d="M20 17H4"/></svg>';
const KEY_SVG = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 2l-2 2m-7.61 7.61a5.5 5.5 0 1 1-7.778 7.778 5.5 5.5 0 0 1 7.777-7.777zm0 0L15.5 7.5m0 0l3 3L22 7l-3-3m-3.5 3.5L19 4"/></svg>';
const TRASH_SVG = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 6h18"/><path d="M19 6v14c0 1-1 2-2 2H7c-1 0-2-1-2-2V6"/><path d="M8 6V4c0-1 1-2 2-2h4c1 0 2 1 2 2v2"/></svg>';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function renderAll(localData: any, selectedModels: any, trackedAccounts: any, activeEmail: string): void {
    const list = document.getElementById('accountList')!;
    const dots = document.getElementById('healthDots')!;
    const label = document.getElementById('summaryLabel')!;

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const accounts: any[] = [];
    const aeNorm = (activeEmail || '').toLowerCase();

    // 1. Active account
    const status = localData?.userStatus;
    if (status) {
        const rawModels = (status.cascadeModelConfigData?.clientModelConfigs || [])
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            .filter((m: any) => m.quotaInfo)
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            .sort((a: any, b: any) => (a.label || '').localeCompare(b.label || ''));

        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const models = rawModels.map((m: any) => ({
            id: m.modelOrAlias?.model || m.label,
            label: m.label,
            pct: m.quotaInfo.remainingFraction !== undefined
                ? Math.max(0, Math.min(100, Math.round(m.quotaInfo.remainingFraction * 100)))
                : 0,
            resetTime: m.quotaInfo.resetTime,
            isLocal: true,
        }));

        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const bn = models.length > 0 ? models.reduce((a: any, b: any) => a.pct < b.pct ? a : b) : null;

        // Extract plan & tier info
        const ut = status.userTier || {};
        const ps = status.planStatus || {};
        const pi = ps.planInfo || {};
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const aiCreds = (ut.availableCredits || []).find(function(c: any) { return c.creditType === 'GOOGLE_ONE_AI'; });

        accounts.push({
            type: 'active',
            email: status.email || 'active-local',
            models,
            bottleneck: bn,
            resetTime: bn?.resetTime || models[0]?.resetTime || '',
            isError: false,
            selectedModels: selectedModels || [],
            tierName: ut.name || null,
            tierId: ut.id || null,
            aiCredits: aiCreds ? parseInt(aiCreds.creditAmount, 10) : null,
            promptCredits: ps.availablePromptCredits != null ? ps.availablePromptCredits : null,
            promptCreditsMax: pi.monthlyPromptCredits || null,
            flowCredits: ps.availableFlowCredits != null ? ps.availableFlowCredits : null,
            flowCreditsMax: pi.monthlyFlowCredits || null,
        });
    }

    // 2. Tracked accounts (deduplicate: skip if same email as active IDE account)
    const activeEmail2 = accounts.length > 0 ? accounts[0].email.toLowerCase() : '';
    if (trackedAccounts) {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        for (const ta of trackedAccounts as any[]) {
            if (activeEmail2 && (ta.email || '').toLowerCase() === activeEmail2) continue;

            const isActiveTracked = aeNorm && (ta.email || '').toLowerCase() === aeNorm && accounts.length === 0;

            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            const models = (ta.models || []).map((m: any) => ({
                id: m.name,
                label: shortModelName(m.name),
                pct: m.percentage || 0,
                resetTime: m.resetTimeRaw || m.resetTime || '',
                isLocal: false,
            }));

            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            const bn = models.length > 0 ? models.reduce((a: any, b: any) => a.pct < b.pct ? a : b) : null;

            accounts.push({
                type: isActiveTracked ? 'active' : 'tracked',
                id: ta.id,
                email: ta.email || 'Unknown',
                models,
                bottleneck: bn,
                resetTime: bn?.resetTime || '',
                tier: ta.tier,
                tierName: ta.tierName || ta.tier || null,
                isError: ta.isError || ta.isForbidden,
                errorMessage: ta.isForbidden ? 'Access forbidden' : (ta.errorMessage || ''),
                selectedModels: [],
                aiCredits: null,
                promptCredits: null,
                flowCredits: null,
            });
        }
    }

    // ─── Summary dots ───
    let dotsHtml = '';
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    for (const a of accounts) {
        const minPct = a.bottleneck ? a.bottleneck.pct : (a.isError ? 0 : 100);
        const cls = a.isError ? 'r' : dotClass(minPct);
        dotsHtml += '<div class="hdot ' + cls + '"></div>';
    }
    dots.innerHTML = dotsHtml;

    let nearestReset = '';
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    for (const a of accounts) {
        const tl = timeLeft(a.resetTime);
        if (tl && tl !== 'Reset' && (!nearestReset || tl < nearestReset)) nearestReset = tl;
    }
    label.textContent = accounts.length + ' account' + (accounts.length !== 1 ? 's' : '')
        + (nearestReset ? ' \u00b7 ' + nearestReset + ' reset' : '');

    // ─── Account cards ───
    if (accounts.length === 0) {
        list.innerHTML = '<div class="empty-state"><div class="em-icon">\ud83d\udce1</div><div class="em-title">No accounts</div><div class="em-desc">Add an account to start monitoring quotas</div></div>';
        return;
    }

    // Preserve open states
    const openStates: Record<number, boolean> = {};
    document.querySelectorAll('.acct').forEach((el, idx) => {
        openStates[idx] = el.classList.contains('open');
    });

    let html = '';
    for (let i = 0; i < accounts.length; i++) {
        const a = accounts[i];
        const wasOpen = openStates[i] !== undefined ? openStates[i] : (i === 0);
        const minPct = a.bottleneck ? a.bottleneck.pct : 0;
        const dotCls = a.isError ? 'x' : dotClass(minPct);
        const openCls = wasOpen ? ' open' : '';


        const actionBtns = a.type === 'tracked'
            ? '<div class="acct-actions">'
              + '<button class="acct-switch" title="Switch IDE to this account" data-action="switch-account" data-id="' + a.id + '">' + SWITCH_SVG + '</button>'
              + '<button class="acct-key" title="Copy Token" data-action="copy-token" data-id="' + a.id + '">' + KEY_SVG + '</button>'
              + '<button class="acct-del" title="Remove" data-action="remove-account" data-id="' + a.id + '">' + TRASH_SVG + '</button>'
              + '</div>'
            : '';
        const activeBadge = a.type === 'active' ? '<span class="active-tag">ACTIVE</span>' : '';
        const tierBadge = a.tierName ? '<span class="tier-tag">' + shortTierName(a.tierName) + '</span>' : '';

        // Credits as pill badges
        let creditsLine = '';
        if (a.aiCredits != null || a.promptCredits != null || a.flowCredits != null) {
            let chips = '';
            if (a.aiCredits != null) chips += '<span class="cr-chip"><span class="cr-icon">CR</span>' + fmtNum(a.aiCredits) + '</span>';
            if (a.promptCredits != null) {
                const pmx = a.promptCreditsMax ? '/' + fmtNum(a.promptCreditsMax) : '';
                chips += '<span class="cr-chip cr-prompt">P ' + fmtNum(a.promptCredits) + pmx + '</span>';
            }
            if (a.flowCredits != null) {
                const fmx = a.flowCreditsMax ? '/' + fmtNum(a.flowCreditsMax) : '';
                chips += '<span class="cr-chip cr-flow">F ' + fmtNum(a.flowCredits) + fmx + '</span>';
            }
            creditsLine = '<div class="acct-credits">' + chips + '</div>';
        }

        // Pinned or bottleneck for collapsed view
        let subBlock = '';
        if (a.isError) {
            subBlock = '<div class="acct-sub"><span style="color:var(--error)">\u26a0 ' + (a.errorMessage || 'Error') + '</span></div>';
        } else {
            const pinnedId = pinnedModels[a.email];
            const displayModel = pinnedId
                // eslint-disable-next-line @typescript-eslint/no-explicit-any
                ? (a.models.find((m: any) => m.id === pinnedId) || a.bottleneck)
                : a.bottleneck;
            if (displayModel) {
                const bnLabel = displayModel.label || shortModelName(displayModel.id);
                const pctCls = fillClass(displayModel.pct);
                const tl = timeLeft(a.resetTime);
                subBlock = '<div class="acct-sub">'
                    + '<span class="bn-model">' + bnLabel + '</span> \u00b7 '
                    + '<span class="bn-pct ' + pctCls + '">' + displayModel.pct + '%</span>'
                    + (tl ? ' <span class="bn-sep">\u00b7</span> ' + tl : '')
                    + '</div>';
            } else {
                subBlock = '<div class="acct-sub">No model data</div>';
            }
        }

        const activeCls = a.type === 'active' ? ' acct-active' : '';
        html += '<div class="acct' + activeCls + openCls + '">';
        html += '<div class="acct-hdr" data-action="toggle-open">';
        html += '<div class="acct-dot ' + dotCls + '"></div>';
        html += '<div class="acct-info">';
        html += '<div class="acct-email">' + a.email + ' ' + activeBadge + ' ' + tierBadge + '</div>';
        html += subBlock;
        html += creditsLine;
        html += '</div>';
        html += actionBtns;
        html += '<span class="acct-chev">\u203a</span>';
        html += '</div>';

        // Model details
        html += '<div class="m-details">';
        if (a.models.length > 0) {
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            for (const m of a.models as any[]) {
                const fCls = fillClass(m.pct);
                const mTl = timeLeft(m.resetTime);
                const acctKey = a.email;
                const isPinned = pinnedModels[acctKey] === m.id;
                const starCls = isPinned ? 'star-btn pinned' : 'star-btn';
                const starIcon = isPinned ? '\u2605' : '\u2606';
                const safeModelId = encodeURIComponent(m.id);
                html += '<div class="m-item">';
                html += '<button class="' + starCls + '" title="Pin to collapsed view" data-action="pin-model" data-account-key="' + acctKey + '" data-model-id="' + safeModelId + '">'
                    + starIcon + '</button>';
                html += '<div class="m-content">';
                html += '<div class="m-top">';
                html += '<span class="m-label">' + m.label + '</span>';
                html += '<div class="m-right">';
                html += '<span class="m-pct">' + m.pct + '%</span>';
                if (m.isLocal) {
                    const chk = a.selectedModels.includes(m.id) ? ' checked' : '';
                    html += '<label class="sb-t" title="Status Bar"><input type="checkbox" data-id="' + m.id + '" data-action="toggle-model"' + chk + '><span class="sb-s"></span></label>';
                }
                html += '</div></div>';
                html += '<div class="m-track"><div class="m-fill ' + fCls + '" style="width:' + m.pct + '%"></div></div>';
                if (mTl) html += '<div class="m-reset-inline">Reset ' + mTl + '</div>';
                html += '</div></div>';
            }
        } else if (a.isError) {
            html += '<div class="acct-err">\u26a0 ' + (a.errorMessage || 'Connection error') + '</div>';
        } else {
            html += '<div class="acct-err" style="color:var(--muted)">No quota data available</div>';
        }
        html += '</div></div>';
    }

    list.innerHTML = html;
}
