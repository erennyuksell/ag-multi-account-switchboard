import * as vscode from 'vscode';
import * as fs from 'fs';
import { isDiagEnabled } from '../constants';

/** Log levels ordered by severity */
export enum LogLevel {
    DIAG = -1,  // diagnostic mode only — gated by isDiagEnabled()
    DEBUG = 0,
    INFO = 1,
    WARN = 2,
    ERROR = 3,
}

const LEVEL_LABELS: Record<LogLevel, string> = {
    [LogLevel.DIAG]: 'DIAG',
    [LogLevel.DEBUG]: 'DEBUG',
    [LogLevel.INFO]: 'INFO',
    [LogLevel.WARN]: 'WARN',
    [LogLevel.ERROR]: 'ERROR',
};

let outputChannel: vscode.OutputChannel | null = null;
let minLevel: LogLevel = LogLevel.DEBUG;

/** Physical file path — when set, every log line is also appended here. */
let fileSinkPath: string | null = null;

/** Diagnostic-specific file sink — gated by isDiagEnabled(), independent from fileSinkPath. */
let diagSinkPath: string | null = null;

/**
 * Initialize the shared OutputChannel.
 * Call once during extension activation.
 */
export function initLogger(context: vscode.ExtensionContext, level: LogLevel = LogLevel.DEBUG): void {
    outputChannel = vscode.window.createOutputChannel('AG Panel', { log: true });
    context.subscriptions.push(outputChannel);
    minLevel = level;
}

/**
 * Set file sink path — all subsequent log lines are also appended to this file.
 * Pass null to disable. Truncates on first set (fresh per session).
 */
export function setFileSink(path: string | null): void {
    fileSinkPath = path;
    if (path) {
        try { fs.writeFileSync(path, ''); } catch { /* non-fatal */ }
    }
}

/**
 * Set diagnostic file sink — DIAG-level lines are appended here when isDiagEnabled() is true.
 * Pass null to disable. Truncates on first set (fresh per session).
 */
export function setDiagSink(path: string | null): void {
    diagSinkPath = path;
    if (path) {
        try { fs.writeFileSync(path, ''); } catch { /* non-fatal */ }
    }
}

/**
 * Create a scoped logger for a specific module.
 *
 * Usage:
 * ```ts
 * const log = createLogger('AccountSwitch');
 * log.info('Token renewed');        // → [INFO] [AccountSwitch] Token renewed
 * log.warn('No LS found');          // → [WARN] [AccountSwitch] No LS found
 * log.error('Renewal failed', err); // → [ERROR] [AccountSwitch] Renewal failed ...
 * log.diag('offset=42 total=100');  // → [DIAG] [AccountSwitch] offset=42 total=100  (only when diagnostic mode enabled)
 * ```
 */
export function createLogger(module: string) {
    const write = (level: LogLevel, msg: string, ...args: unknown[]) => {
        if (level !== LogLevel.DIAG && level < minLevel) return;

        const timestamp = new Date().toISOString().slice(11, 23); // HH:MM:SS.mmm
        const label = LEVEL_LABELS[level];
        const suffix = args.length > 0 ? ' ' + args.map(a => a instanceof Error ? a.message : String(a)).join(' ') : '';
        const line = `[${timestamp}] [${label}] [${module}] ${msg}${suffix}`;

        outputChannel?.appendLine(line);

        // DIAG level → write to diagnostic sink (separate from normal file sink)
        if (level === LogLevel.DIAG && diagSinkPath) {
            try { fs.appendFileSync(diagSinkPath, line + '\n'); } catch { /* non-fatal */ }
        }

        if (fileSinkPath) {
            try { fs.appendFileSync(fileSinkPath, line + '\n'); } catch { /* non-fatal */ }
        }

        switch (level) {
            case LogLevel.DIAG: console.debug(line); break;
            case LogLevel.DEBUG: console.debug(line); break;
            case LogLevel.INFO: console.log(line); break;
            case LogLevel.WARN: console.warn(line); break;
            case LogLevel.ERROR: console.error(line); break;
        }
    };

    return {
        /** Diagnostic — only writes when isDiagEnabled() is true. Zero overhead when off. */
        diag: (msg: string, ...args: unknown[]) => { if (isDiagEnabled()) write(LogLevel.DIAG, msg, ...args); },
        debug: (msg: string, ...args: unknown[]) => write(LogLevel.DEBUG, msg, ...args),
        info: (msg: string, ...args: unknown[]) => write(LogLevel.INFO, msg, ...args),
        warn: (msg: string, ...args: unknown[]) => write(LogLevel.WARN, msg, ...args),
        error: (msg: string, ...args: unknown[]) => write(LogLevel.ERROR, msg, ...args),
    };
}

