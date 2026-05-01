/**
 * Worker Logger — Lightweight file-based logger for detached workers.
 * ════════════════════════════════════════════════════════════════════
 * ZERO vscode dependency — safe for ELECTRON_RUN_AS_NODE=1 processes
 * where the full `createLogger` (which depends on vscode.OutputChannel)
 * is unavailable.
 *
 * Mirrors the same scoped-module pattern as utils/logger.ts but writes
 * exclusively to a physical file (no OutputChannel).
 */

import * as fs from 'fs';

export function createWorkerLogger(filePath: string, module: string) {
    const write = (level: string, msg: string) => {
        const timestamp = new Date().toISOString().slice(0, 23);
        const line = `${timestamp} [${level}] [${module}] ${msg}\n`;
        try { fs.appendFileSync(filePath, line); } catch { /* ignore */ }
    };

    return {
        info:  (msg: string) => write('INFO', msg),
        warn:  (msg: string) => write('WARN', msg),
        error: (msg: string) => write('ERROR', msg),
    };
}
