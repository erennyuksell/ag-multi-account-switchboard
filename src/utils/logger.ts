import * as vscode from 'vscode';

/** Log levels ordered by severity */
export enum LogLevel {
    DEBUG = 0,
    INFO = 1,
    WARN = 2,
    ERROR = 3,
}

const LEVEL_LABELS: Record<LogLevel, string> = {
    [LogLevel.DEBUG]: 'DEBUG',
    [LogLevel.INFO]: 'INFO',
    [LogLevel.WARN]: 'WARN',
    [LogLevel.ERROR]: 'ERROR',
};

let outputChannel: vscode.OutputChannel | null = null;
let minLevel: LogLevel = LogLevel.DEBUG;

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
 * Create a scoped logger for a specific module.
 *
 * Usage:
 * ```ts
 * const log = createLogger('AccountSwitch');
 * log.info('Token renewed');        // → [INFO] [AccountSwitch] Token renewed
 * log.warn('No LS found');          // → [WARN] [AccountSwitch] No LS found
 * log.error('Renewal failed', err); // → [ERROR] [AccountSwitch] Renewal failed ...
 * ```
 */
export function createLogger(module: string) {
    const write = (level: LogLevel, msg: string, ...args: unknown[]) => {
        if (level < minLevel) return;

        const timestamp = new Date().toISOString().slice(11, 23); // HH:MM:SS.mmm
        const label = LEVEL_LABELS[level];
        const suffix = args.length > 0 ? ' ' + args.map(a => a instanceof Error ? a.message : String(a)).join(' ') : '';
        const line = `[${timestamp}] [${label}] [${module}] ${msg}${suffix}`;

        // Write to OutputChannel (visible in Output panel → "AG Panel")
        outputChannel?.appendLine(line);

        // Also forward to DevTools console for debugging
        switch (level) {
            case LogLevel.DEBUG: console.debug(line); break;
            case LogLevel.INFO: console.log(line); break;
            case LogLevel.WARN: console.warn(line); break;
            case LogLevel.ERROR: console.error(line); break;
        }
    };

    return {
        debug: (msg: string, ...args: unknown[]) => write(LogLevel.DEBUG, msg, ...args),
        info: (msg: string, ...args: unknown[]) => write(LogLevel.INFO, msg, ...args),
        warn: (msg: string, ...args: unknown[]) => write(LogLevel.WARN, msg, ...args),
        error: (msg: string, ...args: unknown[]) => write(LogLevel.ERROR, msg, ...args),
    };
}
