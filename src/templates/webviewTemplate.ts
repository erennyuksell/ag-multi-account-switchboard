import * as vscode from 'vscode';

/**
 * Generate a random nonce for Content Security Policy.
 */
function getNonce(): string {
    let text = '';
    const possible = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
    for (let i = 0; i < 32; i++) {
        text += possible.charAt(Math.floor(Math.random() * possible.length));
    }
    return text;
}

/**
 * Assembles the full webview HTML with:
 * - CSP (Content Security Policy) with nonce
 * - External CSS via <link> (loaded from out/webview/panel.css)
 * - External JS via <script> (loaded from out/webview/panel.js)
 * 
 * HTML skeleton only — all CSS is in panel.css, all JS in panel.js (esbuild bundle).
 */
export function getWebviewContent(webview: vscode.Webview, extensionUri: vscode.Uri): string {
    // Get URIs for external resources
    const scriptUri = webview.asWebviewUri(
        vscode.Uri.joinPath(extensionUri, 'out', 'webview', 'panel.js')
    );
    const styleUri = webview.asWebviewUri(
        vscode.Uri.joinPath(extensionUri, 'out', 'webview', 'panel.css')
    );
    const nonce = getNonce();

    return `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <meta http-equiv="Content-Security-Policy"
          content="default-src 'none';
                   style-src ${webview.cspSource} 'unsafe-inline';
                   script-src ${webview.cspSource} 'nonce-${nonce}';
                   font-src ${webview.cspSource};">
    <link rel="stylesheet" href="${styleUri}">
    <title>Quota Radar</title>
</head>
<body>
    <div id="loading" class="loader" style="display: block;">
        <div class="init-screen">
            <div class="radar-wrap">
                <div class="radar-ring r1"></div>
                <div class="radar-ring r2"></div>
                <div class="radar-ring r3"></div>
                <div class="radar-core"></div>
            </div>
            <div class="init-title">AG Multi-Account Switchboard</div>
            <div class="init-status">Connecting to Antigravity...</div>
            <div class="init-dots">
                <span class="idot d1"></span>
                <span class="idot d2"></span>
                <span class="idot d3"></span>
            </div>
        </div>
    </div>
    <div id="error" class="err-msg"></div>

    <div id="content" class="hidden">
        <!-- Tab Bar -->
        <div class="tab-bar">
            <button class="tab-btn active" data-action="switch-tab" data-tab="accounts">
                <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4"><circle cx="8" cy="5" r="3"/><path d="M2 14c0-3.3 2.7-6 6-6s6 2.7 6 6"/></svg>
                Accounts
            </button>
            <button class="tab-btn" data-action="switch-tab" data-tab="tokens">
                <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4"><circle cx="8" cy="8" r="6.5"/><path d="M8 4v4l2.5 2.5"/></svg>
                Token Budget
            </button>
            <button class="tab-btn" data-action="switch-tab" data-tab="usage">
                <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4"><rect x="1" y="5" width="3" height="9" rx="0.5"/><rect x="6.5" y="1" width="3" height="13" rx="0.5"/><rect x="12" y="3" width="3" height="11" rx="0.5"/></svg>
                Usage Stats
            </button>
        </div>

        <!-- Tab 1: Accounts -->
        <div id="tab-accounts" class="tab-content active">
            <!-- Summary Strip -->
            <div class="summary-strip">
                <div class="summary-left">
                    <div class="dot-group" id="healthDots"></div>
                    <span class="summary-label" id="summaryLabel">Loading...</span>
                </div>
                <div class="summary-right">
                    <button class="s-btn" id="refreshBtn" title="Refresh" data-action="refresh">
                        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 12a9 9 0 1 1-9-9c2.52 0 4.93 1 6.74 2.74L21 8"/><path d="M21 3v5h-5"/></svg>
                    </button>
                    <button class="s-btn" title="Add via Token" data-action="add-account-by-token">
                        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 2l-2 2m-7.61 7.61a5.5 5.5 0 1 1-7.778 7.778 5.5 5.5 0 0 1 7.777-7.777zm0 0L15.5 7.5m0 0l3 3L22 7l-3-3m-3.5 3.5L19 4"/></svg>
                    </button>
                    <button class="s-btn" title="Add Account" data-action="add-account">
                        <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5"><line x1="8" y1="3" x2="8" y2="13"/><line x1="3" y1="8" x2="13" y2="8"/></svg>
                    </button>
                </div>
            </div>

            <!-- Account List -->
            <div class="account-list" id="accountList"></div>

            <!-- Add Account -->
            <div class="add-area">
                <button class="add-btn" data-action="add-account">
                    <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5"><line x1="8" y1="3" x2="8" y2="13"/><line x1="3" y1="8" x2="13" y2="8"/></svg>
                    Add Account
                </button>
                <button class="add-btn" data-action="add-account-by-token">
                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 2l-2 2m-7.61 7.61a5.5 5.5 0 1 1-7.778 7.778 5.5 5.5 0 0 1 7.777-7.777zm0 0L15.5 7.5m0 0l3 3L22 7l-3-3m-3.5 3.5L19 4"/></svg>
                    Add via Token
                </button>
            </div>
        </div>

        <!-- Tab 2: Token Budget -->
        <div id="tab-tokens" class="tab-content">
            <!-- Token tab refresh strip -->
            <div class="token-strip">
                <span class="token-strip-label">Context Budget</span>
                <button class="s-btn" id="tokenRefreshBtn" title="Refresh token budget" data-action="refresh-token-only">
                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 12a9 9 0 1 1-9-9c2.52 0 4.93 1 6.74 2.74L21 8"/><path d="M21 3v5h-5"/></svg>
                </button>
            </div>
            <div class="token-scroll">
                <div id="tokenContent" class="token-tab">
                    <div class="token-empty">
                        <div class="em-icon">📊</div>
                        <div class="em-title">Token data loading...</div>
                    </div>
                </div>
                <!-- Active Context Window -->
                <div id="contextWindowContent" class="ctx-window-wrap"></div>
                <!-- Workspace Context: .agent/ items from LS index (not filesystem) -->
                <div class="wc-section">
                    <div class="wc-section-hdr">
                        <span class="wc-section-icon">🗂️</span>
                        <span class="wc-section-label">Workspace Context</span>
                        <span class="wc-section-badge">.agent/</span>
                    </div>
                    <div id="workspaceContextContent" class="wc-content">
                        <div class="wc-empty">Loading workspace context...</div>
                    </div>
                </div>
            </div>
        </div>


        <!-- Tab 3: Usage Stats -->
        <div id="tab-usage" class="tab-content">
            <div class="token-strip">
                <span class="token-strip-label">Session Token Usage</span>
                <button class="s-btn" id="usageRefreshBtn" title="Refresh usage stats" data-action="refresh-usage-only">
                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 12a9 9 0 1 1-9-9c2.52 0 4.93 1 6.74 2.74L21 8"/><path d="M21 3v5h-5"/></svg>
                </button>
            </div>
            <div class="token-scroll">
                <div id="usageContent" class="usage-tab">
                    <div class="token-empty">
                        <div class="em-icon">📊</div>
                        <div class="em-title">Usage data loading...</div>
                    </div>
                </div>
            </div>
        </div>

        <!-- Footer -->
        <div class="foot">
            <span id="lastUpdated">—</span>
            <span class="build-tag">b32</span>
            <div class="interval-pick">
                <button class="iv-btn" data-ms="30000" data-action="set-interval">30s</button>
                <button class="iv-btn active" data-ms="60000" data-action="set-interval">1m</button>
                <button class="iv-btn" data-ms="120000" data-action="set-interval">2m</button>
                <button class="iv-btn" data-ms="300000" data-action="set-interval">5m</button>
            </div>
        </div>
    </div>

    <script nonce="${nonce}" src="${scriptUri}"></script>
</body>
</html>`;
}
