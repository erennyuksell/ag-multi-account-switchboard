// Renders the real panel (compiled out/webview/panel.css + panel.js, real HTML
// template) in a plain browser, fed with fixture data, so layout bugs like
// issue #11 can be checked without the IDE.
//   node scripts/webview-harness/build.cjs   → scripts/webview-harness/index.html
const Module = require('module');
const path = require('path');
const fs = require('fs');

const root = path.resolve(__dirname, '..', '..');
const origLoad = Module._load;
Module._load = function (req, ...rest) {
    if (req === 'vscode') {
        return { Uri: { joinPath: (base, ...p) => ({ p: path.posix.join(...p) }) } };
    }
    return origLoad.call(this, req, ...rest);
};
const { getWebviewContent } = require(path.join(root, 'out', 'templates', 'webviewTemplate.js'));
const webview = { cspSource: "'self'", asWebviewUri: u => '../../' + u.p };
let html = getWebviewContent(webview, {});
html = html.replace(/<meta http-equiv="Content-Security-Policy"[\s\S]*?>/, '');

const models = (n, prefix) => Array.from({ length: n }, (_, i) => ({
    id: `${prefix}-${i}`, label: `${prefix} Model ${i + 1}`, pct: 100 - i * 5,
    resetTime: new Date(Date.now() + 6 * 86400e3).toISOString(), isLocal: false,
}));
const card = (email, n, extra = {}) => ({
    email, isActive: false, models: models(n, email.split('@')[0]),
    bottleneck: { id: 'x', label: 'x', pct: 40, resetTime: '' }, tierName: 'Pro', resetTime: '',
    isError: false, selectedModels: [], isLocal: false, trackingId: email, dataTimestamp: Date.now(),
    aiCredits: null, promptCredits: null, promptCreditsMax: null, flowCredits: null, flowCreditsMax: null, ...extra,
});
const fixture = {
    type: 'update',
    accountCards: [
        card('active@example.com', 7, { isActive: true, isLocal: true, trackingId: undefined }),
        card('tracked1@example.com', 15),
        card('tracked2@example.com', 22),
    ],
    pinnedModels: {}, tokenBase: null, workspaceContext: null, usageStats: null, contextWindow: null, pricing: {},
};

const stub = `<script>
window.acquireVsCodeApi = () => ({ postMessage: () => {}, getState: () => ({}), setState: () => {} });
window.addEventListener('load', () => setTimeout(() => window.postMessage(${JSON.stringify(fixture)}, '*'), 100));
</script>`;
html = html.replace('<head>', '<head>' + stub);
fs.writeFileSync(path.join(__dirname, 'index.html'), html);
console.log('wrote', path.join(__dirname, 'index.html'));
