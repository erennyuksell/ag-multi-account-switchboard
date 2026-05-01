/**
 * Conversation Guard — Detached Worker
 * =====================================
 * Runs as a standalone Node.js process (via ELECTRON_RUN_AS_NODE=1)
 * after AntiGravity exits. Rebuilds the sidebar conversation index
 * from .pb files on disk using sqlite3 CLI (no WASM dependency).
 *
 * Usage: spawned by conversationGuard.ts with parentPid as argv[2]
 */

import * as fs from 'fs';
import * as path from 'path';
import * as cp from 'child_process';
import * as os from 'os';
import { STATE_DB_PATH, CONVERSATIONS_DIR, BRAIN_DIR, isMac, isWindows } from '../shared/agPaths';
import {
    decodeVarint, skipProtobufField,
    stripFieldFromProtobuf, encodeLengthDelimited, encodeStringField,
    buildTimestampFields, hasTimestampFields,
} from '../shared/protobuf';
import { isGenericTitle, getTitleFromBrain, getTitleFromTranscript } from '../shared/titleResolver';
import { createWorkerLogger } from '../shared/workerLogger';

// ─── Worker-local state ──────────────────────────────────────────────
const LOG_PATH = path.join(os.tmpdir(), 'ag-conversation-fix.log');
const log = createWorkerLogger(LOG_PATH, 'ConvFix');
let _hasRelaunched = false;

interface RelaunchInfo {
    workspaceFolders: string[];
    mainPid?: number;
}

// ─── sqlite3 CLI wrapper ────────────────────────────────────────────
/**
 * Unified sqlite3 CLI executor — always uses temp file to avoid shell arg limits.
 * Returns stdout (for SELECT) or empty string (for UPDATE/INSERT).
 */
function sqlite3(sql: string, opts?: { timeout?: number; maxBuffer?: number }): string {
    const tmpFile = path.join(os.tmpdir(), 'ag-conv-fix-sql.tmp');
    try {
        fs.writeFileSync(tmpFile, sql, 'utf8');
        return cp.execSync(`sqlite3 "${STATE_DB_PATH}" < "${tmpFile}"`, {
            encoding: 'utf8',
            timeout: opts?.timeout ?? 30000,
            maxBuffer: opts?.maxBuffer ?? 50 * 1024 * 1024,
            shell: isWindows ? 'cmd.exe' : '/bin/sh',
        }).trim();
    } catch (e: unknown) {
        log.error(`sqlite3 error: ${(e as Error).message}`);
        throw e;
    } finally {
        try { fs.unlinkSync(tmpFile); } catch { /* ignore */ }
    }
}

// ─── Title Helpers (isGenericTitle, getTitleFromBrain, getTitleFromTranscript
// are imported from shared/titleResolver.ts — SSOT) ──────────────────

function extractTitleFromInnerBlob(innerBlob: Buffer | null): string | null {
    if (!innerBlob) return null;
    let fallbackText: string | null = null;
    try {
        let pos = 0;
        while (pos < innerBlob.length) {
            const { value: tag, pos: next } = decodeVarint(innerBlob, pos);
            const wireType = tag & 7;
            const fieldNum = Math.floor(tag / 8);
            if (wireType === 2) {
                const { value: len, pos: dataStart } = decodeVarint(innerBlob, next);
                const content = innerBlob.slice(dataStart, dataStart + len);
                pos = dataStart + len;
                try {
                    const textExtract = content.toString('utf8').trim();
                    if (textExtract && !textExtract.includes('{"workspace') && !textExtract.includes('"context"')) {
                        if (fieldNum === 1 && textExtract.length > 3) {
                            return isGenericTitle(textExtract) ? null : textExtract;
                        }
                        if (textExtract.length > 5 && textExtract.length < 150 && !isGenericTitle(textExtract)) {
                            const letterCount = (textExtract.match(/[a-zA-Z\s0-9]/g) || []).length;
                            if (letterCount / textExtract.length > 0.8) fallbackText = textExtract;
                        }
                    }
                } catch { /* ignore */ }
            } else if (wireType === 0) {
                pos = decodeVarint(innerBlob, next).pos;
            } else {
                pos = skipProtobufField(innerBlob, next, wireType);
            }
        }
    } catch { /* ignore */ }
    return fallbackText;
}

interface ExistingMetadata {
    titles: Record<string, string>;
    innerBlobs: Record<string, Buffer>;
}

function extractExistingMetadata(rawB64: string): ExistingMetadata {
    const titles: Record<string, string> = {};
    const innerBlobs: Record<string, Buffer> = {};
    if (!rawB64) return { titles, innerBlobs };
    try {
        const decoded = Buffer.from(rawB64, 'base64');
        let pos = 0;
        while (pos < decoded.length) {
            try {
                const { value: tag, pos: tagEnd } = decodeVarint(decoded, pos);
                if ((tag & 7) !== 2) break;
                const { value: entryLen, pos: entryStart } = decodeVarint(decoded, tagEnd);
                const entry = decoded.slice(entryStart, entryStart + entryLen);
                pos = entryStart + entryLen;
                let ep = 0;
                let uid: string | null = null;
                let infoB64: string | null = null;
                while (ep < entry.length) {
                    const { value: t, pos: tnext } = decodeVarint(entry, ep);
                    const fn = Math.floor(t / 8);
                    const wt = t & 7;
                    if (wt === 2) {
                        const { value: l, pos: ds } = decodeVarint(entry, tnext);
                        const content = entry.slice(ds, ds + l);
                        ep = ds + l;
                        if (fn === 1) uid = content.toString('utf8');
                        else if (fn === 2) {
                            let sp = 0;
                            while (sp < content.length) {
                                try {
                                    const { value: subt, pos: stnext } = decodeVarint(content, sp);
                                    const swt = subt & 7;
                                    const sfn = Math.floor(subt / 8);
                                    if (swt === 2) {
                                        const { value: slen, pos: sds } = decodeVarint(content, stnext);
                                        if (sfn === 1) { infoB64 = content.slice(sds, sds + slen).toString('utf8'); break; }
                                        else { sp = sds + slen; }
                                    } else if (swt === 0) { sp = decodeVarint(content, stnext).pos; }
                                    else { sp = skipProtobufField(content, stnext, swt); }
                                } catch { break; }
                            }
                        }
                    } else if (wt === 0) { ep = decodeVarint(entry, tnext).pos; }
                    else { ep = skipProtobufField(entry, tnext, wt); }
                }
                if (uid && infoB64) {
                    try {
                        const rawInner = Buffer.from(infoB64, 'base64');
                        innerBlobs[uid] = rawInner;
                        const title = extractTitleFromInnerBlob(rawInner);
                        if (title && !title.startsWith('_headers:') && !title.includes('{"workspace') && !title.includes('[{"type"')) {
                            titles[uid] = title;
                        }
                    } catch { /* ignore */ }
                }
            } catch { break; }
        }
    } catch { /* ignore */ }
    return { titles, innerBlobs };
}

// ─── Title Resolution ────────────────────────────────────────────────
// getTitleFromBrain + getTitleFromTranscript → imported from shared/titleResolver.ts

function resolveTitle(cid: string, existingTitles: Record<string, string>): { title: string; source: string } {
    if (existingTitles[cid] && !isGenericTitle(existingTitles[cid])) {
        return { title: existingTitles[cid], source: 'preserved' };
    }
    const brain = getTitleFromBrain(cid);
    if (brain && !isGenericTitle(brain)) return { title: brain, source: 'brain' };
    const transcript = getTitleFromTranscript(cid);
    if (transcript && !isGenericTitle(transcript)) return { title: transcript, source: 'transcript' };
    const pbPath = path.join(CONVERSATIONS_DIR, `${cid}.pb`);
    let dateStr = '';
    if (fs.existsSync(pbPath)) {
        dateStr = ` (${fs.statSync(pbPath).mtime.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })})`;
    }
    return { title: `Chat${dateStr} ${cid.substring(0, 6)}`, source: 'fallback' };
}

// ─── Entry Builder ───────────────────────────────────────────────────
function buildTrajectoryEntry(cid: string, title: string, existingInnerData: Buffer | null, pbMtime: number | null): Buffer {
    let innerInfo: Buffer;
    if (existingInnerData) {
        const preserved = stripFieldFromProtobuf(existingInnerData, 1);
        innerInfo = Buffer.concat([encodeStringField(1, title), preserved]);
        if (pbMtime && !hasTimestampFields(existingInnerData)) {
            innerInfo = Buffer.concat([innerInfo, buildTimestampFields(pbMtime)]);
        }
    } else {
        innerInfo = encodeStringField(1, title);
        if (pbMtime) {
            innerInfo = Buffer.concat([innerInfo, buildTimestampFields(pbMtime)]);
        }
    }
    const infoB64 = innerInfo.toString('base64');
    const subMessage = encodeStringField(1, infoB64);
    let entry = encodeStringField(1, cid);
    entry = Buffer.concat([entry, encodeLengthDelimited(2, subMessage)]);
    return entry;
}

// ─── AG App Path ─────────────────────────────────────────────────────
function getAGAppPath(): string {
    if (isMac) return 'open -a Antigravity';
    if (isWindows) {
        const localApp = process.env.LOCALAPPDATA ?? path.join(os.homedir(), 'AppData', 'Local');
        const candidates = [
            path.join(localApp, 'Programs', 'Antigravity', 'Antigravity.exe'),
            path.join(localApp, 'Antigravity', 'Antigravity.exe'),
            path.join(os.homedir(), '.antigravity', 'Antigravity.exe'),
        ];
        for (const c of candidates) {
            if (fs.existsSync(c)) return `"${c}"`;
        }
        // Fallback: try `where` to find in PATH
        try {
            const found = cp.execSync('where Antigravity', { encoding: 'utf8' }).trim().split('\n')[0];
            if (found && fs.existsSync(found.trim())) return `"${found.trim()}"`;
        } catch { /* not in PATH */ }
        // Last resort: assume default path
        return `"${candidates[0]}"`;
    }
    // Linux: try known path first, fall back to PATH
    const linuxPath = path.join(os.homedir(), '.antigravity', 'antigravity', 'bin', 'antigravity');
    if (fs.existsSync(linuxPath)) return `"${linuxPath}"`;
    return 'antigravity';
}

// ─── Main ────────────────────────────────────────────────────────────
async function main(): Promise<void> {
    const parentPid = parseInt(process.argv[2], 10);
    let relaunchInfo: RelaunchInfo = { workspaceFolders: [] };
    try { relaunchInfo = JSON.parse(process.argv[3] || '{}'); } catch { /* ignore */ }
    const mainPid = relaunchInfo.mainPid || parentPid;

    log.info(`Started. ExtHost PID: ${parentPid}, Main PID: ${mainPid}`);
    log.info(`DB: ${STATE_DB_PATH}`);

    // 1. Wait for Extension Host to exit (max 30s safety limit)
    log.info('Waiting for Extension Host to exit...');
    let extWait = 60;
    while (extWait-- > 0) {
        try { process.kill(parentPid, 0); await new Promise(r => setTimeout(r, 500)); }
        catch { break; }
    }
    if (extWait <= 0) log.warn('Extension Host wait timed out, proceeding...');
    else log.info('Extension Host exited.');

    // 1b. Wait for main AG process to exit too
    if (mainPid && mainPid !== parentPid) {
        log.info(`Waiting for main AG process (${mainPid})...`);
        let waitCycles = 30;
        while (waitCycles-- > 0) {
            try { process.kill(mainPid, 0); await new Promise(r => setTimeout(r, 500)); }
            catch { break; }
        }
        log.info('Main AG process exited.');
    }

    // 2. Wait for WAL checkpoint
    const walPath = STATE_DB_PATH + '-wal';
    let retries = 20;
    while (fs.existsSync(walPath) && retries-- > 0) {
        log.info(`WAL file exists, waiting... (${retries} retries left)`);
        await new Promise(r => setTimeout(r, 1000));
    }
    if (fs.existsSync(walPath)) {
        log.warn('WAL still exists, attempting anyway...');
    }

    // 3. Validate paths
    if (!fs.existsSync(STATE_DB_PATH)) { log.error('DB not found'); relaunchAG(relaunchInfo); return; }
    if (!fs.existsSync(CONVERSATIONS_DIR)) { log.error('Conv dir not found'); relaunchAG(relaunchInfo); return; }

    // 4. Read existing index via sqlite3 CLI
    log.info('Reading existing index via sqlite3...');
    let rawB64 = '';
    try {
        rawB64 = sqlite3("SELECT value FROM ItemTable WHERE key='antigravityUnifiedStateSync.trajectorySummaries';");
    } catch { /* will rebuild from scratch */ }
    if (!rawB64) {
        log.warn('No existing index found, building from scratch.');
    }

    // 5. Discover conversations
    const pbFiles = fs.readdirSync(CONVERSATIONS_DIR).filter(f => f.endsWith('.pb'));
    if (!pbFiles.length) { log.warn('No .pb files found.'); relaunchAG(relaunchInfo); return; }
    pbFiles.sort((a, b) => {
        const ma = fs.statSync(path.join(CONVERSATIONS_DIR, a)).mtimeMs;
        const mb = fs.statSync(path.join(CONVERSATIONS_DIR, b)).mtimeMs;
        return mb - ma;
    });
    const conversationIds = pbFiles.map(f => f.replace('.pb', ''));
    log.info(`Found ${conversationIds.length} conversations on disk.`);

    // 6. Extract existing metadata
    const { titles: existingTitles, innerBlobs } = extractExistingMetadata(rawB64);
    log.info(`Preserved ${Object.keys(existingTitles).length} existing titles.`);

    // 7. Resolve titles
    interface Resolved { cid: string; title: string; source: string; innerData: Buffer | null }
    const resolved: Resolved[] = [];
    const stats: Record<string, number> = { preserved: 0, brain: 0, transcript: 0, fallback: 0 };
    for (const cid of conversationIds) {
        const innerData = innerBlobs[cid] || null;
        const { title, source } = resolveTitle(cid, existingTitles);
        resolved.push({ cid, title, source, innerData });
        stats[source] = (stats[source] || 0) + 1;
    }
    log.info(`Titles — Preserved: ${stats.preserved}, Brain: ${stats.brain}, Transcript: ${stats.transcript}, Fallback: ${stats.fallback}`);

    // 8. Build new index
    let resultBytes = Buffer.alloc(0);
    for (const { cid, title, innerData } of resolved) {
        const pbPath = path.join(CONVERSATIONS_DIR, `${cid}.pb`);
        const pbMtime = fs.existsSync(pbPath) ? fs.statSync(pbPath).mtimeMs / 1000 : null;
        const entry = buildTrajectoryEntry(cid, title, innerData, pbMtime);
        resultBytes = Buffer.concat([resultBytes, encodeLengthDelimited(1, entry)]);
    }

    // 9. Backup old value
    if (rawB64) {
        try {
            const backupPath = path.join(path.dirname(STATE_DB_PATH), 'trajectorySummaries_backup.txt');
            fs.writeFileSync(backupPath, rawB64, 'utf8');
            log.info('Backup saved.');
        } catch (e: unknown) { log.warn(`Backup warning: ${(e as Error).message}`); }
    }

    // 10. Write new index via sqlite3 CLI
    const encoded = resultBytes.toString('base64');
    // Escape single quotes for SQL
    const escapedVal = encoded.replace(/'/g, "''");
    try {
        sqlite3(`UPDATE ItemTable SET value='${escapedVal}' WHERE key='antigravityUnifiedStateSync.trajectorySummaries';`);
        log.info(`SUCCESS: Rebuilt index with ${resolved.length} conversations.`);
    } catch (e: unknown) {
        log.error(`Writing index failed: ${(e as Error).message}`);
        relaunchAG(relaunchInfo);
        return;
    }

    // 11. Relaunch AG
    relaunchAG(relaunchInfo);
}

/** Clean Electron/VSCode env vars that prevent proper relaunch */
function cleanElectronEnv(): Record<string, string | undefined> {
    const env = { ...process.env };
    delete env.ELECTRON_RUN_AS_NODE;
    for (const key of Object.keys(env)) {
        if (key.startsWith('VSCODE_') || key.startsWith('ELECTRON_') || key.startsWith('APPLICATION_INSIGHTS_')) {
            delete env[key];
        }
    }
    return env;
}

function relaunchAG(info: RelaunchInfo): void {
    if (_hasRelaunched) { log.warn('Already relaunched — guard triggered.'); return; }
    _hasRelaunched = true;
    log.info('Initiating restart...');

    const folders = info.workspaceFolders || [];
    const appCmd = getAGAppPath();
    const cleanEnv = cleanElectronEnv();

    if (isMac) {
        const args = folders.length > 0 ? ` --args ${folders.map(f => `"${f}"`).join(' ')}` : '';
        const cmd = `${appCmd}${args}`;
        log.info(`Relaunching: ${cmd}`);
        try {
            cp.exec(cmd, { env: cleanEnv });
            log.info('Relaunch initiated.');
        } catch (e: unknown) {
            log.error(`Relaunch error: ${(e as Error).message}`);
        }
    } else {
        const args = folders.length > 0 ? folders : [];
        log.info(`Relaunching: ${appCmd} ${args.join(' ')}`);
        try {
            const child = cp.spawn(appCmd, args, { detached: true, stdio: 'ignore', env: cleanEnv, shell: true });
            child.unref();
            log.info('Relaunch spawned.');
        } catch (e: unknown) {
            log.error(`Relaunch error: ${(e as Error).message}`);
        }
    }
    setTimeout(() => process.exit(0), 3000);
}

main().catch(e => {
    log.error(`FATAL: ${e.message}\n${e.stack}`);
    process.exit(1);
});
