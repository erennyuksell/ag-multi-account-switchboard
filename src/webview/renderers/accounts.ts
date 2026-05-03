/**
 * Account tab renderer — pure HTML rendering from pre-processed AccountCard[].
 * ZERO data logic — all merging, deduplication, classification, and sorting
 * is done in quotaManager.buildAccountCards() on the extension host side.
 */

import { dotClass, fillClass, timeLeft, shortModelName, shortTierName, fmtNum } from '../../shared/helpers';

// SVG icon constants for tracked account action buttons
const SWITCH_SVG = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M8 3 4 7l4 4"/><path d="M4 7h16"/><path d="M16 21l4-4-4-4"/><path d="M20 17H4"/></svg>';
const KEY_SVG = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 2l-2 2m-7.61 7.61a5.5 5.5 0 1 1-7.778 7.778 5.5 5.5 0 0 1 7.777-7.777zm0 0L15.5 7.5m0 0l3 3L22 7l-3-3m-3.5 3.5L19 4"/></svg>';
const TRASH_SVG = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 6h18"/><path d="M19 6v14c0 1-1 2-2 2H7c-1 0-2-1-2-2V6"/><path d="M8 6V4c0-1 1-2 2-2h4c1 0 2 1 2 2v2"/></svg>';

/** Track previous active email to detect account switches and auto-collapse */
let _lastActiveEmail = '';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function renderAll(cards: any[], pinnedModels: Record<string, string>): void {
    const list = document.getElementById('accountList')!;
    const dots = document.getElementById('healthDots')!;
    const label = document.getElementById('summaryLabel')!;

    if (!cards || cards.length === 0) {
        dots.innerHTML = '';
        label.textContent = '0 accounts';
        list.innerHTML = '<div class="empty-state"><div class="em-icon">\ud83d\udce1</div><div class="em-title">No accounts</div><div class="em-desc">Add an account to start monitoring quotas</div></div>';
        return;
    }

    // ─── Summary dots ───
    let dotsHtml = '';
    for (const a of cards) {
        const minPct = a.bottleneck ? a.bottleneck.pct : (a.isError ? 0 : 100);
        const cls = a.isError ? 'r' : dotClass(minPct);
        dotsHtml += '<div class="hdot ' + cls + '"></div>';
    }
    dots.innerHTML = dotsHtml;

    let nearestReset = '';
    for (const a of cards) {
        const tl = timeLeft(a.resetTime);
        if (tl && tl !== 'Reset' && (!nearestReset || tl < nearestReset)) nearestReset = tl;
    }
    label.textContent = cards.length + ' account' + (cards.length !== 1 ? 's' : '')
        + (nearestReset ? ' \u00b7 ' + nearestReset + ' reset' : '');

    // ─── Preserve open states by EMAIL (stable across re-renders) ───
    const openStates: Record<string, boolean> = {};
    document.querySelectorAll('.acct[data-email]').forEach(el => {
        openStates[(el as HTMLElement).dataset.email!] = el.classList.contains('open');
    });

    // Detect account switch — when active email changes, reset open states
    const activeCard = cards.find((c: any) => c.isActive);
    const newActiveEmail = activeCard?.email || '';
    const switched = newActiveEmail && newActiveEmail !== _lastActiveEmail;
    if (newActiveEmail) _lastActiveEmail = newActiveEmail;

    // ─── Account cards ───
    let html = '';
    for (const a of cards) {
        // On switch: active card opens, others collapse. Normal re-render: preserve state.
        const wasOpen = switched
            ? a.isActive
            : (openStates[a.email] !== undefined ? openStates[a.email] : a.isActive);
        const minPct = a.bottleneck ? a.bottleneck.pct : 0;
        const dotCls = a.isError ? 'x' : dotClass(minPct);
        const openCls = wasOpen ? ' open' : '';

        // Action buttons: only for tracked (non-local) accounts
        const actionBtns = a.trackingId
            ? '<div class="acct-actions">'
              + '<button class="acct-switch" title="Switch IDE to this account" data-action="switch-account" data-id="' + a.trackingId + '">' + SWITCH_SVG + '</button>'
              + '<button class="acct-key" title="Copy Token" data-action="copy-token" data-id="' + a.trackingId + '">' + KEY_SVG + '</button>'
              + '<button class="acct-del" title="Remove" data-action="remove-account" data-id="' + a.trackingId + '">' + TRASH_SVG + '</button>'
              + '</div>'
            : '';

        const activeBadge = a.isActive ? '<span class="active-tag">ACTIVE</span>' : '';
        const transitionBadge = a.isTransitioning && a.pendingEmail
            ? '<span class="transition-tag">→ ' + a.pendingEmail + '</span>'
            : '';
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
            const pinnedLabel = pinnedModels[a.email];
            const displayModel = pinnedLabel
                // eslint-disable-next-line @typescript-eslint/no-explicit-any
                ? (a.models.find((m: any) => m.label === pinnedLabel) || a.bottleneck)
                : a.bottleneck;
            if (displayModel) {
                const bnLabel = displayModel.label || shortModelName(displayModel.id);
                const pctCls = fillClass(displayModel.pct);
                const tl = timeLeft(displayModel.resetTime);
                subBlock = '<div class="acct-sub">'
                    + '<span class="bn-model">' + bnLabel + '</span> \u00b7 '
                    + '<span class="bn-pct ' + pctCls + '">' + displayModel.pct + '%</span>'
                    + (tl ? ' <span class="bn-sep">\u00b7</span> ' + tl : '')
                    + '</div>';
            } else {
                subBlock = '<div class="acct-sub">No model data</div>';
            }
        }

        const activeCls = a.isActive ? ' acct-active' : '';
        html += '<div class="acct' + activeCls + openCls + '" data-email="' + a.email + '">';
        html += '<div class="acct-hdr" data-action="toggle-open">';
        html += '<div class="acct-dot ' + dotCls + '"></div>';
        html += '<div class="acct-info">';
        html += '<div class="acct-email">' + a.email + ' ' + activeBadge + ' ' + tierBadge + transitionBadge + '</div>';
        html += subBlock;
        html += creditsLine;
        html += '</div>';
        html += actionBtns;
        html += '<span class="acct-chev">\u203a</span>';
        html += '</div>';

        // Model details (expanded content)
        html += '<div class="m-details">';
        if (a.models.length > 0) {
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            for (const m of a.models as any[]) {
                const fCls = fillClass(m.pct);
                const mTl = timeLeft(m.resetTime);
                const acctKey = a.email;
                const isPinned = pinnedModels[acctKey] === m.label;
                const starCls = isPinned ? 'star-btn pinned' : 'star-btn';
                const starIcon = isPinned ? '\u2605' : '\u2606';
                const safeModelId = encodeURIComponent(m.label);
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
