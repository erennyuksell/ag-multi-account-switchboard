/**
 * Webview JavaScript logic for Quota Radar panel.
 * Handles message routing, rendering, state management, and interval polling.
 */
export function getScripts(): string {
    return `
        const vscode = acquireVsCodeApi();
        let refreshTimer = null;
        let isFirstLoad = true;
        let currentIntervalMs = 60000;

        // ─── Actions ───
        function refresh() { vscode.postMessage({ type: 'refresh' }); }
        function addAccount() { vscode.postMessage({ type: 'addAccount' }); }
        function addAccountByToken() { vscode.postMessage({ type: 'addAccountByToken' }); }
        function removeAccount(id) { vscode.postMessage({ type: 'removeAccount', accountId: id }); }
        function switchAccount(id) { vscode.postMessage({ type: 'switchAccount', accountId: id }); }
        function copyToken(id) { vscode.postMessage({ type: 'copyToken', accountId: id }); }
        function toggleModel(modelId, isVisible) { vscode.postMessage({ type: 'toggleModel', modelId, isVisible }); }
        window._pinnedModels = window._pinnedModels || {};
        function pinModel(accountId, modelId) {
            if (window._pinnedModels[accountId] === modelId) {
                delete window._pinnedModels[accountId];
            } else {
                window._pinnedModels[accountId] = modelId;
            }
            vscode.setState({ ...vscode.getState(), pinnedModels: window._pinnedModels });
            renderAll(...(window._lastRenderArgs || []));
        }

        function doRefresh() {
            const btn = document.getElementById('refreshBtn');
            if (btn) { btn.classList.add('spinning'); setTimeout(() => btn.classList.remove('spinning'), 1200); }
            refresh();
        }

        // ─── Tab Switching ───
        function switchTab(tabId, el) {
            document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
            document.querySelectorAll('.tab-content').forEach(c => c.classList.remove('active'));
            el.classList.add('active');
            const target = document.getElementById('tab-' + tabId);
            if (target) target.classList.add('active');
            vscode.setState({ ...vscode.getState(), activeTab: tabId });
        }

        function setInterval2(el) {
            document.querySelectorAll('.iv-btn').forEach(b => b.classList.remove('active'));
            el.classList.add('active');
            currentIntervalMs = parseInt(el.dataset.ms);
            if (refreshTimer) clearInterval(refreshTimer);
            refreshTimer = setInterval(refresh, currentIntervalMs);
            vscode.setState({ ...vscode.getState(), intervalMs: currentIntervalMs });
        }

        // Restore state
        const savedState = vscode.getState() || {};
        currentIntervalMs = savedState.intervalMs || 60000;
        window._pinnedModels = savedState.pinnedModels || {};
        document.querySelectorAll('.iv-btn').forEach(b => {
            b.classList.toggle('active', parseInt(b.dataset.ms) === currentIntervalMs);
        });
        refreshTimer = setInterval(refresh, currentIntervalMs);

        vscode.postMessage({ type: 'ready' });

        // Restore active tab
        if (savedState.activeTab) {
            const tabBtn = document.querySelector('.tab-btn[data-tab="' + savedState.activeTab + '"]');
            if (tabBtn) switchTab(savedState.activeTab, tabBtn);
        }

        // ─── Helpers ───
        function dotClass(pct) { return pct >= 50 ? 'g' : pct >= 20 ? 'y' : 'r'; }
        function fillClass(pct) { return pct >= 50 ? 'g' : pct >= 20 ? 'y' : 'r'; }

        function timeLeft(resetTimeStr) {
            if (!resetTimeStr) return '';
            const reset = new Date(resetTimeStr);
            if (isNaN(reset.getTime())) return '';
            const diff = reset.getTime() - Date.now();
            if (diff <= 0) return 'Reset';
            const h = Math.floor(diff / 3600000);
            const m = Math.floor((diff % 3600000) / 60000);
            return h > 0 ? h + 'h ' + m + 'm' : m + 'm';
        }

        function resetDateStr(resetTimeStr) {
            if (!resetTimeStr) return 'Unknown';
            const d = new Date(resetTimeStr);
            if (isNaN(d.getTime())) return 'Unknown';
            return d.toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
        }

        function shortModelName(name) {
            if (!name) return '?';
            return name.split('/').pop().replace(/^models-/, '').replace(/^models_/, '');
        }

        function shortTierName(name) {
            if (!name) return '';
            // "Google AI Ultra" → "Ultra", "Google AI Premium" → "Premium"
            const parts = (name || '').split(' ');
            return parts[parts.length - 1] || name;
        }

        function fmtK(n) {
            if (n == null) return '';
            if (n >= 1000) return Math.round(n / 1000) + 'K';
            return '' + n;
        }

        function clockSvg() {
            return '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4"><circle cx="8" cy="8" r="6.5"/><polyline points="8 4.5 8 8 10.5 10"/></svg>';
        }

        // ─── Render ───
        function renderAll(localData, selectedModels, trackedAccounts, activeEmail) {
            const list = document.getElementById('accountList');
            const dots = document.getElementById('healthDots');
            const label = document.getElementById('summaryLabel');

            const accounts = [];
            const aeNorm = (activeEmail || '').toLowerCase();

            // 1. Active account
            const status = localData?.userStatus;
            if (status) {
                const rawModels = (status.cascadeModelConfigData?.clientModelConfigs || [])
                    .filter(m => m.quotaInfo)
                    .sort((a, b) => (a.label || '').localeCompare(b.label || ''));

                const models = rawModels.map(m => ({
                    id: m.modelOrAlias?.model || m.label,
                    label: m.label,
                    pct: m.quotaInfo.remainingFraction !== undefined
                        ? Math.max(0, Math.min(100, Math.round(m.quotaInfo.remainingFraction * 100)))
                        : 0,
                    resetTime: m.quotaInfo.resetTime,
                    isLocal: true,
                }));

                const bn = models.length > 0 ? models.reduce((a, b) => a.pct < b.pct ? a : b) : null;

                // Extract plan & tier info
                const ut = status.userTier || {};
                const ps = status.planStatus || {};
                const pi = ps.planInfo || {};
                const aiCreds = (ut.availableCredits || []).find(function(c) { return c.creditType === 'GOOGLE_ONE_AI'; });

                accounts.push({
                    type: 'active',
                    email: status.email || status.name || 'Active Account',
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
                for (const ta of trackedAccounts) {
                    if (activeEmail2 && (ta.email || '').toLowerCase() === activeEmail2) continue;

                    // If this tracked account matches the IDE's active email, mark it as active
                    const isActiveTracked = aeNorm && (ta.email || '').toLowerCase() === aeNorm && accounts.length === 0;

                    const models = (ta.models || []).map(m => ({
                        id: m.name,
                        label: shortModelName(m.name),
                        pct: m.percentage || 0,
                        resetTime: m.resetTimeRaw || m.resetTime || '',
                        isLocal: false,
                    }));

                    const bn = models.length > 0 ? models.reduce((a, b) => a.pct < b.pct ? a : b) : null;

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
            for (const a of accounts) {
                const minPct = a.bottleneck ? a.bottleneck.pct : (a.isError ? 0 : 100);
                const cls = a.isError ? 'r' : dotClass(minPct);
                dotsHtml += '<div class="hdot ' + cls + '"></div>';
            }
            dots.innerHTML = dotsHtml;

            let nearestReset = '';
            for (const a of accounts) {
                const tl = timeLeft(a.resetTime);
                if (tl && tl !== 'Reset' && (!nearestReset || tl < nearestReset)) nearestReset = tl;
            }
            label.textContent = accounts.length + ' account' + (accounts.length !== 1 ? 's' : '')
                + (nearestReset ? ' \\u00b7 ' + nearestReset + ' reset' : '');

            // ─── Account cards ───
            if (accounts.length === 0) {
                list.innerHTML = '<div class="empty-state"><div class="em-icon">\\ud83d\\udce1</div><div class="em-title">No accounts</div><div class="em-desc">Add an account to start monitoring quotas</div></div>';
                return;
            }

            // Preserve open states
            const openStates = {};
            document.querySelectorAll('.acct').forEach((el, idx) => {
                openStates[idx] = el.classList.contains('open');
            });

            // Pinned model per account (accountId → modelId)
            const pinnedModels = window._pinnedModels;

            let html = '';
            for (let i = 0; i < accounts.length; i++) {
                const a = accounts[i];
                const wasOpen = openStates[i] !== undefined ? openStates[i] : (i === 0);
                const minPct = a.bottleneck ? a.bottleneck.pct : 0;
                const dotCls = a.isError ? 'x' : dotClass(minPct);
                const openCls = wasOpen ? ' open' : '';

                const switchSvg = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M8 3 4 7l4 4"/><path d="M4 7h16"/><path d="M16 21l4-4-4-4"/><path d="M20 17H4"/></svg>';
                const keySvg = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 2l-2 2m-7.61 7.61a5.5 5.5 0 1 1-7.778 7.778 5.5 5.5 0 0 1 7.777-7.777zm0 0L15.5 7.5m0 0l3 3L22 7l-3-3m-3.5 3.5L19 4"/></svg>';
                const trashSvg = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 6h18"/><path d="M19 6v14c0 1-1 2-2 2H7c-1 0-2-1-2-2V6"/><path d="M8 6V4c0-1 1-2 2-2h4c1 0 2 1 2 2v2"/></svg>';

                const actionBtns = a.type === 'tracked'
                    ? '<div class="acct-actions">'
                      + '<button class="acct-switch" title="Switch IDE to this account" onclick="event.stopPropagation();switchAccount(\\'' + a.id + '\\')">' + switchSvg + '</button>'
                      + '<button class="acct-key" title="Copy Token" onclick="event.stopPropagation();copyToken(\\\'' + a.id + '\\\')">' + keySvg + '</button>'
                      + '<button class="acct-del" title="Remove" onclick="event.stopPropagation();removeAccount(\\\'' + a.id + '\\\')">' + trashSvg + '</button>'
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
                    // Use pinned model if set, otherwise bottleneck
                    const pinnedId = pinnedModels[a.id || a.email];
                    const displayModel = pinnedId
                        ? (a.models.find(m => m.id === pinnedId) || a.bottleneck)
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
                html += '<div class="acct-hdr" onclick="toggleOpen(this)">';
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
                    for (const m of a.models) {
                        const fCls = fillClass(m.pct);
                        const mTl = timeLeft(m.resetTime);
                        const acctKey = a.id || a.email;
                        const isPinned = pinnedModels[acctKey] === m.id;
                        const starCls = isPinned ? 'star-btn pinned' : 'star-btn';
                        const starIcon = isPinned ? '\u2605' : '\u2606';
                        html += '<div class="m-item">';
                        html += '<button class="' + starCls + '" title="Pin to collapsed view" onclick="event.stopPropagation();pinModel(\\'' + acctKey + '\\',\\'' + m.id + '\\')">' + starIcon + '</button>';
                        html += '<div class="m-content">';
                        html += '<div class="m-top">';
                        html += '<span class="m-label">' + m.label + '</span>';
                        html += '<div class="m-right">';
                        html += '<span class="m-pct">' + m.pct + '%</span>';
                        if (m.isLocal) {
                            const chk = a.selectedModels.includes(m.id) ? ' checked' : '';
                            html += '<label class="sb-t" title="Status Bar"><input type="checkbox" data-id="' + m.id + '"' + chk + ' onchange="toggleModel(this.dataset.id,this.checked)"><span class="sb-s"></span></label>';
                        }
                        html += '</div></div>';
                        html += '<div class="m-track"><div class="m-fill ' + fCls + '" style="width:' + m.pct + '%"></div></div>';
                        if (mTl) html += '<div class="m-reset-inline">Reset ' + mTl + '</div>';
                        html += '</div></div>';
                    }
                } else if (a.isError) {
                    html += '<div class="acct-err">\\u26a0 ' + (a.errorMessage || 'Connection error') + '</div>';
                } else {
                    html += '<div class="acct-err" style="color:var(--muted)">No quota data available</div>';
                }
                html += '</div></div>';
            }

            list.innerHTML = html;
        }

        // ─── Message Handler ───
        window.addEventListener('message', event => {
            const msg = event.data;

            if (msg.type === 'loading') {
                if (isFirstLoad) {
                    document.getElementById('loading').style.display = 'block';
                    document.getElementById('content').classList.add('hidden');
                } else {
                    document.getElementById('refreshBtn').classList.add('spinning');
                }
                document.getElementById('error').innerText = '';
            }
            else if (msg.type === 'error') {
                document.getElementById('loading').style.display = 'none';
                document.getElementById('refreshBtn').classList.remove('spinning');
                document.getElementById('error').innerText = msg.message;
                if (isFirstLoad) {
                    document.getElementById('content').classList.remove('hidden');
                    isFirstLoad = false;
                }
            }
            else if (msg.type === 'update') {
                document.getElementById('loading').style.display = 'none';
                const rb = document.getElementById('refreshBtn');
                if (rb) rb.classList.remove('spinning');
                document.getElementById('content').classList.remove('hidden');
                document.getElementById('error').innerText = '';
                isFirstLoad = false;

                try {
                    window._lastRenderArgs = [msg.data, msg.selectedModels, msg.trackedAccounts || [], msg.activeEmail || ''];
                    renderAll(...window._lastRenderArgs);
                    if (msg.tokenBase) renderTokenBudget(msg.tokenBase);
                    document.getElementById('lastUpdated').textContent = 'Updated ' + new Date().toLocaleTimeString();
                } catch (e) {
                    document.getElementById('error').innerText = 'Render error: ' + e.message;
                }
            }
        });

        // ─── Token Budget Render ───
        const CAT_ICONS = { 'Rules': '\\ud83d\\udccb', 'Skills': '\\ud83e\\udde0', 'Workflows': '\\u2699\\ufe0f', 'Mcp Tools': '\\ud83d\\udd0c' };

        function fmtNum(n) { return n.toLocaleString(); }

        function pctClass(pct) { return pct >= 80 ? 'r' : pct >= 50 ? 'y' : 'g'; }

        function toggleOpen(el) { el.parentElement.classList.toggle('open'); }

        function renderTokenBudget(tb) {
            const el = document.getElementById('tokenContent');
            if (!el || !tb) return;

            const usedPct = tb.usedPercent;
            const cls = pctClass(usedPct);

            // SVG donut (64px)
            const r = 26, c = 2 * Math.PI * r;
            const dashOffset = c - (c * Math.min(usedPct, 100) / 100);

            let html = '';

            // Budget summary strip with donut
            html += '<div class="budget-strip">';
            html += '<div class="donut-wrap">';
            html += '<svg viewBox="0 0 64 64"><circle class="donut-bg" cx="32" cy="32" r="' + r + '"/>';
            html += '<circle class="donut-fg ' + cls + '" cx="32" cy="32" r="' + r + '" stroke-dasharray="' + c.toFixed(1) + '" stroke-dashoffset="' + dashOffset.toFixed(1) + '"/></svg>';
            html += '<div class="donut-label">' + usedPct + '%</div>';
            html += '</div>';
            html += '<div class="budget-info">';
            html += '<div class="budget-title">Context Token Usage</div>';
            html += '<div class="budget-detail">';
            html += fmtNum(tb.totalTokens) + ' / ' + fmtNum(tb.customizationBudget) + ' tokens';
            if (tb.remainingBudget < 0) {
                html += '<br><span class="over">Over budget by ' + fmtNum(Math.abs(tb.remainingBudget)) + ' tokens</span>';
            } else {
                html += '<br>' + fmtNum(tb.remainingBudget) + ' remaining';
            }
            if (usedPct >= 90) {
                html += '<br><span class="over">\u26a0 Context may be trimmed</span>';
            }
            html += '</div></div></div>';

            // Category breakdown
            const cats = (tb.categories || []).sort((a, b) => b.totalTokens - a.totalTokens);

            for (let ci = 0; ci < cats.length; ci++) {
                const cat = cats[ci];
                const catPct = tb.customizationBudget > 0 ? Math.round(cat.totalTokens / tb.customizationBudget * 100) : 0;
                const icon = CAT_ICONS[cat.name] || '\\ud83d\\udce6';

                html += '<div class="cat-card">';
                html += '<div class="cat-hdr" onclick="toggleOpen(this)">';
                html += '<span class="cat-icon">' + icon + '</span>';
                html += '<span class="cat-name">' + cat.name + '</span>';
                html += '<span class="cat-tokens">' + fmtNum(cat.totalTokens) + '</span>';
                html += '<span class="cat-pct ' + pctClass(catPct * 3) + '">' + catPct + '%</span>';
                html += '<span class="cat-chev">\\u203a</span>';
                html += '</div>';

                // Items
                html += '<div class="cat-items">';
                const items = (cat.items || []).sort((a, b) => b.tokens - a.tokens);
                for (const item of items) {
                    const itemPct = cat.totalTokens > 0 ? Math.round(item.tokens / cat.totalTokens * 100) : 0;
                    const hasTools = item.tools && item.tools.length > 0;

                    if (hasTools) {
                        // MCP server — 2nd level collapsible
                        html += '<div class="mcp-server">';
                        html += '<div class="mcp-server-hdr" onclick="toggleOpen(this)">';
                        html += '<span class="mcp-server-chev">\\u203a</span>';
                        html += '<span class="cat-item-name">' + item.name + '</span>';
                        html += '<span class="cat-item-tokens">' + fmtNum(item.tokens) + '</span>';
                        html += '<div class="cat-item-bar"><div class="cat-item-fill ' + pctClass(itemPct) + '" style="width:' + itemPct + '%"></div></div>';
                        html += '</div>';
                        html += '<div class="mcp-tools">';
                        var sortedTools = item.tools.slice().sort(function(a, b) { return b.tokens - a.tokens; });
                        for (var ti = 0; ti < sortedTools.length; ti++) {
                            html += '<div class="mcp-tool">';
                            html += '<span class="mcp-tool-name">' + sortedTools[ti].name + '</span>';
                            html += '<span class="mcp-tool-tokens">' + fmtNum(sortedTools[ti].tokens) + '</span>';
                            html += '</div>';
                        }
                        html += '</div></div>';
                    } else {
                        // Regular item (rules, skills, workflows)
                        html += '<div class="cat-item">';
                        html += '<span class="cat-item-name">' + item.name + '</span>';
                        html += '<span class="cat-item-tokens">' + fmtNum(item.tokens) + '</span>';
                        html += '<div class="cat-item-bar"><div class="cat-item-fill ' + pctClass(itemPct) + '" style="width:' + itemPct + '%"></div></div>';
                        html += '</div>';
                    }
                }
                html += '</div></div>';
            }

            el.innerHTML = html;
        }
    `;
}
