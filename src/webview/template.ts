import * as vscode from 'vscode';
import { getStyles } from './styles';
import { getScripts } from './scripts';

/**
 * Assembles the full webview HTML from separate style and script modules.
 * This file only contains the HTML skeleton — all CSS is in styles.ts, all JS in scripts.ts.
 */
export function getWebviewContent(webview: vscode.Webview, extensionUri: vscode.Uri): string {
    return `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Quota Radar</title>
    <style>${getStyles()}</style>
</head>
<body>
    <div id="loading" class="loader"></div>
    <div id="error" class="err-msg"></div>

    <div id="content" class="hidden">
        <!-- Tab Bar -->
        <div class="tab-bar">
            <button class="tab-btn active" data-tab="accounts" onclick="switchTab('accounts', this)">
                <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4"><circle cx="8" cy="5" r="3"/><path d="M2 14c0-3.3 2.7-6 6-6s6 2.7 6 6"/></svg>
                Accounts
            </button>
            <button class="tab-btn" data-tab="tokens" onclick="switchTab('tokens', this)">
                <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4"><circle cx="8" cy="8" r="6.5"/><path d="M8 4v4l2.5 2.5"/></svg>
                Token Budget
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
                    <button class="s-btn" id="refreshBtn" title="Refresh" onclick="doRefresh()">
                        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 12a9 9 0 1 1-9-9c2.52 0 4.93 1 6.74 2.74L21 8"/><path d="M21 3v5h-5"/></svg>
                    </button>
                    <button class="s-btn" title="Add via Token" onclick="addAccountByToken()">
                        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 2l-2 2m-7.61 7.61a5.5 5.5 0 1 1-7.778 7.778 5.5 5.5 0 0 1 7.777-7.777zm0 0L15.5 7.5m0 0l3 3L22 7l-3-3m-3.5 3.5L19 4"/></svg>
                    </button>
                    <button class="s-btn" title="Add Account" onclick="addAccount()">
                        <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5"><line x1="8" y1="3" x2="8" y2="13"/><line x1="3" y1="8" x2="13" y2="8"/></svg>
                    </button>
                </div>
            </div>

            <!-- Account List -->
            <div class="account-list" id="accountList"></div>

            <!-- Add Account -->
            <div class="add-area">
                <button class="add-btn" onclick="addAccount()">
                    <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5"><line x1="8" y1="3" x2="8" y2="13"/><line x1="3" y1="8" x2="13" y2="8"/></svg>
                    Add Account
                </button>
            </div>
        </div>

        <!-- Tab 2: Token Budget -->
        <div id="tab-tokens" class="tab-content">
            <div id="tokenContent" class="token-tab">
                <div class="token-empty">
                    <div class="em-icon">\\ud83d\\udcca</div>
                    <div class="em-title">Loading token data...</div>
                </div>
            </div>
        </div>

        <!-- Footer -->
        <div class="foot">
            <span id="lastUpdated">—</span>
            <div class="interval-pick">
                <button class="iv-btn" data-ms="30000" onclick="setInterval2(this)">30s</button>
                <button class="iv-btn active" data-ms="60000" onclick="setInterval2(this)">1m</button>
                <button class="iv-btn" data-ms="120000" onclick="setInterval2(this)">2m</button>
                <button class="iv-btn" data-ms="300000" onclick="setInterval2(this)">5m</button>
            </div>
        </div>
    </div>

    <script>${getScripts()}</script>
</body>
</html>`;
}
