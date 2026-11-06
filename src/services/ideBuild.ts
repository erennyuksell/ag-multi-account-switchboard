/**
 * Which Antigravity build this extension host runs in.
 *
 * Open VSX cannot serve different releases to different Antigravity builds:
 * it picks a release only by the VS Code version the host reports, and the
 * app before the IDE line, Antigravity IDE 2.5 and 2.6 all report 1.107.0
 * (read from product.json and IDE logs on 2026-10-29). So the build is told
 * apart here, at runtime, from the running app's product.json:
 *   ideVersion       Antigravity's own version, "2.6.0" on 2.6
 *   dataFolderName   ".antigravity-ide" on the IDE line, ".antigravity"
 *                    on the app before it (its argv.json lives there)
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

interface ProductInfo { ideVersion?: string; dataFolderName?: string; applicationName?: string }

let _product: ProductInfo | null | undefined;

function product(): ProductInfo | null {
    if (_product === undefined) {
        try {
            const appRoot = require('vscode').env.appRoot as string;
            _product = JSON.parse(fs.readFileSync(path.join(appRoot, 'product.json'), 'utf8'));
        } catch {
            _product = null; // outside the extension host, or no product.json
        }
    }
    return _product ?? null;
}

/** Antigravity's own version, e.g. "2.6.0"; '' when the build does not say. */
export function ideVersion(): string {
    return product()?.ideVersion ?? '';
}

/**
 * True on Antigravity builds before the IDE line (2.5). The account switch
 * was reworked against 2.5 and never run on these, so they keep the 3.2.1
 * flow that shipped on them (see AccountSwitchService.switchLegacy).
 *
 * A build that cannot be identified counts as current: the 3.2.1 flow is
 * the one that empties the model list on 2.5.
 */
export function isLegacyAntigravity(): boolean {
    const p = product();
    if (!p) return false;
    const m = /^(\d+)\.(\d+)/.exec(p.ideVersion ?? '');
    if (m) {
        const major = Number(m[1]);
        return major < 2 || (major === 2 && Number(m[2]) < 5);
    }
    return p.dataFolderName === '.antigravity' || p.applicationName === 'antigravity';
}

/**
 * Version of the agy CLI that 2.6 runs as each window's hub, from the file its
 * self-updater writes. It updates on its own, independently of the IDE
 * (1.4.10 → 1.4.12 → 1.5.2 between 2026-10-29 and 2026-11-06). '' if absent.
 */
export function agyVersion(): string {
    try {
        return JSON.parse(fs.readFileSync(path.join(os.homedir(), '.gemini', 'bin', 'agy.version.json'), 'utf8')).version || '';
    } catch { return ''; }
}

/** One line for logs and bug reports: which Antigravity this is. */
export function buildSummary(): string {
    let vsc = '';
    try { vsc = require('vscode').version as string; } catch { /* outside the extension host */ }
    const agy = agyVersion();
    return `Antigravity ${ideVersion() || 'unknown'} (VS Code ${vsc || '?'}, ${process.platform})${agy ? `, agy ${agy}` : ''}`;
}
