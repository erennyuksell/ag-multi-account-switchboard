/**
 * Conversation Guard — Detection & Fix Orchestrator
 * Detects missing conversations by comparing conversation files on disk
 * with the sidebar index, and repairs the index when asked.
 *
 *   up to 2.5  .pb files vs the trajectorySummaries blob in state.vscdb;
 *              a detached worker rebuilds the blob while the IDE is closed.
 *   2.6        .db files vs conversation_summaries.db; the repair restarts
 *              this window's hub, which restores missing rows itself on
 *              start (see AgyHubKeeper.restartForReindex). The extension
 *              writes nothing to the index.
 */

import * as vscode from 'vscode';
import * as fs from 'fs';
import * as cp from 'child_process';
import * as path from 'path';
import { STATE_DB_PATH } from '../constants';
import { CONVERSATIONS_DIR, BRAIN_DIR } from '../shared/agPaths';
import { isAgyMode } from './agyAuth';
import type { AgyHubKeeper } from './agyHub';
import { getGlobalIndexData, getConversationSummariesData, isGenericTitle, getTitleFromBrain, getTitleFromTranscript } from '../shared/titleResolver';
import { isDbAvailable } from '../shared/db';
import { createLogger } from '../utils/logger';

const log = createLogger('ConvGuard');

export interface MissingConversationDetail {
    id: string;
    title: string;
    date: string;
}

export interface ConversationStatus {
    onDisk: number;
    inIndex: number;
    missing: number;
    missingIds: string[];
}

export class ConversationGuard implements vscode.Disposable {
    private _dismissedCount = -1;
    private _lastStatus: ConversationStatus | null = null;
    private _dbAvailable: boolean | undefined;
    private _keeper: AgyHubKeeper | undefined;
    private _onStatusChange = new vscode.EventEmitter<ConversationStatus>();
    public readonly onStatusChange = this._onStatusChange.event;

    constructor(private readonly context: vscode.ExtensionContext) {
        this._dismissedCount = context.globalState.get('ag_dismissedMissingCount', -1);
    }

    /** 2.6: the window's hub keeper, which performs the repair. */
    setHubKeeper(keeper: AgyHubKeeper): void {
        this._keeper = keeper;
    }

    /** Run detection after a delay (non-blocking) */
    startDelayedDetection(delayMs = 15000): void {
        setTimeout(() => this.detect(), delayMs);
    }

    /** Get the last detection result */
    getLastStatus(): ConversationStatus | null {
        return this._lastStatus;
    }

    /**
     * Detect missing conversations via ID-level set diff.
     * A simple count comparison (100 disk == 100 index) can hide
     * mismatches where ghost entries mask missing ones.
     */
    async detect(): Promise<ConversationStatus | null> {
        try {
            if (isAgyMode()) return await this._detectAgy();
            if (!fs.existsSync(CONVERSATIONS_DIR)) return null;

            const pbFiles = fs.readdirSync(CONVERSATIONS_DIR).filter(f => f.endsWith('.pb'));
            const onDisk = pbFiles.length;
            if (onDisk === 0) return null;

            if (!fs.existsSync(STATE_DB_PATH)) return null;

            // Verify DB backend is available (cache result)
            if (this._dbAvailable === undefined) {
                this._dbAvailable = isDbAvailable();
                if (!this._dbAvailable) log.warn('No DB backend available — conversation detection disabled');
            }
            if (!this._dbAvailable) return null;

            const diskIds = new Set(pbFiles.map(f => f.replace('.pb', '')));
            const indexIds = await this._readIndexIds();

            // Missing = on disk but NOT in index (user can't see these)
            const missingIds: string[] = [];
            for (const id of diskIds) {
                if (!indexIds.has(id)) missingIds.push(id);
            }

            const status: ConversationStatus = { onDisk, inIndex: indexIds.size, missing: missingIds.length, missingIds };
            this._lastStatus = status;

            log.info(`Detection: ${onDisk} on disk, ${indexIds.size} indexed, ${missingIds.length} missing (set diff)`);

            if (missingIds.length > 0) {
                this._onStatusChange.fire(status);
            }

            return status;
        } catch (e: any) {
            log.error(`Detection error: ${e.message}`);
            return null;
        }
    }

    /**
     * 2.6: conversation files (.db, and .pb carried over from older builds)
     * absent from conversation_summaries.db. Both were measured to come back
     * when a hub starts on a copy with the row deleted. Files touched in the
     * last two minutes are skipped, since the hub writes the row just after
     * creating the file.
     */
    private async _detectAgy(): Promise<ConversationStatus | null> {
        if (!fs.existsSync(CONVERSATIONS_DIR)) return null;
        const settledBefore = Date.now() - 2 * 60_000;
        const diskIds = fs.readdirSync(CONVERSATIONS_DIR)
            .filter(f => f.endsWith('.db') || f.endsWith('.pb'))
            .filter(f => { try { return fs.statSync(path.join(CONVERSATIONS_DIR, f)).mtimeMs < settledBefore; } catch { return false; } })
            .map(f => f.slice(0, -3))
            .filter((id, i, all) => all.indexOf(id) === i);
        if (diskIds.length === 0) return null;

        const { allIds } = await getConversationSummariesData().catch(() => ({ allIds: new Set<string>() }));
        // An unreadable index is not an empty one; claiming everything is
        // missing would only send the user to a repair that cannot help.
        if (allIds.size === 0) return null;

        const missingIds = diskIds.filter(id => !allIds.has(id));
        const status: ConversationStatus = { onDisk: diskIds.length, inIndex: allIds.size, missing: missingIds.length, missingIds };
        this._lastStatus = status;
        log.info(`Detection (2.6): ${diskIds.length} conversations on disk, ${allIds.size} indexed, ${missingIds.length} missing`);
        if (missingIds.length > 0) this._onStatusChange.fire(status);
        return status;
    }

    /** Extract conversation IDs from the trajectory summaries protobuf index.
     *  Delegates to titleResolver.getGlobalIndexData() — SSOT for protobuf parsing.
     *  Uses allIds (not titleMap) to include title-less indexed conversations. */
    private async _readIndexIds(): Promise<Set<string>> {
        try {
            const { allIds } = await getGlobalIndexData();
            return allIds;
        } catch { return new Set(); }
    }

    /** Dismiss the current missing count (don't nag again for the same number) */
    dismiss(): void {
        if (this._lastStatus) {
            this._dismissedCount = this._lastStatus.missing;
            this.context.globalState.update('ag_dismissedMissingCount', this._dismissedCount);
        }
    }

    /** Check if the current missing count was already dismissed */
    isDismissed(): boolean {
        return this._lastStatus !== null && this._lastStatus.missing === this._dismissedCount;
    }

    /** Resolve titles & dates for missing conversations (for UI display).
     *  lsTitles: optional map from GetAllCascadeTrajectories LS endpoint (highest fidelity) */
    resolveMissingDetails(ids: string[], lsTitles?: Map<string, string>): MissingConversationDetail[] {
        return ids.map(id => {
            // Date from the conversation file's mtime (.pb up to 2.5, .db on 2.6)
            const pbPath = [`${id}.pb`, `${id}.db`].map(f => path.join(CONVERSATIONS_DIR, f)).find(p => fs.existsSync(p));
            let date = '?';
            try {
                if (pbPath) {
                    const mtime = fs.statSync(pbPath).mtime;
                    date = mtime.toLocaleDateString('tr-TR', { day: '2-digit', month: 'short', year: 'numeric' });
                }
            } catch { /* ignore */ }

            // Priority 1: LS title (from GetAllCascadeTrajectories — highest fidelity)
            let title = '';
            const lsTitle = lsTitles?.get(id);
            if (lsTitle && !isGenericTitle(lsTitle) && lsTitle.length > 3) {
                title = lsTitle.length > 50 ? lsTitle.substring(0, 47) + '...' : lsTitle;
            }

            // Priority 2: Brain markdown files (shared SSOT)
            if (!title) {
                const brainTitle = getTitleFromBrain(id, 50);
                if (brainTitle) title = brainTitle;
            }

            // Priority 3: Transcript (shared SSOT)
            if (!title) {
                const transcriptTitle = getTitleFromTranscript(id, 50);
                if (transcriptTitle) title = transcriptTitle;
            }

            // Final fallback
            if (!title) title = `Chat ${id.substring(0, 8)}`;

            return { id, title, date };
        }).sort((a, b) => b.date.localeCompare(a.date));
    }

    /**
     * 2.6 repair: restart this window's hub, let it reconcile, check again.
     * Returns the status after the restart, or null if there is no hub.
     */
    async runFixAgy(): Promise<ConversationStatus | null> {
        if (!this._keeper || !(await this._keeper.restartForReindex())) return null;
        this.context.globalState.update('ag_dismissedMissingCount', -1);
        // Measured: the IDE respawns the hub in ~4.5s and the reconcile takes
        // milliseconds. Poll a little past that.
        let status: ConversationStatus | null = null;
        for (let i = 0; i < 6; i++) {
            await new Promise(r => setTimeout(r, 3_000));
            status = await this.detect();
            if (status && status.missing === 0) break;
        }
        return status;
    }

    /** Spawn detached worker to fix conversations — AG will quit */
    runFix(): void {
        const workerPath = path.join(__dirname, '..', 'scripts', 'conversationFix.js');

        if (!fs.existsSync(workerPath)) {
            log.error(`Worker script not found: ${workerPath}`);
            vscode.window.showErrorMessage('Conversation fix script not found. Please reinstall the extension.');
            return;
        }

        const workspaceFolders = (vscode.workspace.workspaceFolders || []).map(f => f.uri.fsPath);
        const mainPid = process.env.VSCODE_PID ? parseInt(process.env.VSCODE_PID, 10) : process.ppid;
        const relaunchInfo = JSON.stringify({ workspaceFolders, mainPid });

        const child = cp.spawn(process.execPath, [workerPath, process.pid.toString(), relaunchInfo], {
            env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
            detached: true,
            stdio: 'ignore',
        });
        child.unref();

        log.info('Detached fixer spawned. Quitting AG...');

        // Clear dismiss state so it monitors normally after a fix
        this.context.globalState.update('ag_dismissedMissingCount', -1);

        vscode.commands.executeCommand('workbench.action.quit');
    }

    dispose(): void {
        this._onStatusChange.dispose();
    }
}
