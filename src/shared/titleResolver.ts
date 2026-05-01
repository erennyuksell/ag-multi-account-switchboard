/**
 * Title Resolver — SSOT for extracting conversation titles from local files.
 * ═══════════════════════════════════════════════════════════════════════════
 * ZERO vscode dependency — safe for both extension host AND
 * detached worker processes (ELECTRON_RUN_AS_NODE=1).
 *
 * Consumers:
 * - conversationGuard.ts (extension host — UI display)
 * - conversationFix.ts (detached worker — index rebuild)
 */

import * as fs from 'fs';
import * as path from 'path';
import { BRAIN_DIR } from './agPaths';

// ─── Generic Title Detection ────────────────────────────────────────

/** Returns true if the title is auto-generated/useless (e.g., "New Conversation", "Untitled") */
export function isGenericTitle(title: string | null): boolean {
    if (!title) return true;
    const t = title.trim().toLowerCase();
    if (t.startsWith('conversation (') || t.startsWith('chat (')) return true;
    if (t.startsWith('conversation ') && t.length < 25) return true;
    if (t === 'new conversation' || t === 'untitled') return true;
    return false;
}

// ─── Brain .md Title Extraction ─────────────────────────────────────

/**
 * Extract a meaningful title from brain markdown files (implementation_plan.md, walkthrough.md, etc.)
 * Returns the first non-trivial line of text, or null if nothing useful found.
 */
export function getTitleFromBrain(cid: string, maxLen = 55): string | null {
    const brainPath = path.join(BRAIN_DIR, cid);
    if (!fs.existsSync(brainPath) || !fs.statSync(brainPath).isDirectory()) return null;
    try {
        const files = fs.readdirSync(brainPath)
            .filter(f => f.endsWith('.md') && !f.startsWith('.'))
            .map(f => ({ name: f, stat: fs.statSync(path.join(brainPath, f)) }))
            .sort((a, b) => a.stat.mtimeMs - b.stat.mtimeMs);
        for (const { name } of files) {
            try {
                const content = fs.readFileSync(path.join(brainPath, name), 'utf8').substring(0, 2000);
                const lines = content.split('\n').map(l => l.trim()).filter(l => l.length > 0);
                for (const line of lines) {
                    if (line.startsWith('```') || line.startsWith('<') || line.startsWith('>')) continue;
                    const text = line.replace(/^#+\s*/, '').replace(/[*_~`]/g, '').trim();
                    if (isGenericTitle(text)) continue;
                    if (/\p{L}/u.test(text) && text.length > 3) {
                        return text.length > maxLen ? text.substring(0, maxLen - 3) + '...' : text;
                    }
                }
            } catch { /* ignore individual file errors */ }
        }
    } catch { /* ignore directory errors */ }
    return null;
}

// ─── Transcript Title Extraction ────────────────────────────────────

/**
 * Extract the first user prompt from overview.txt (conversation transcript log).
 * Reads only the first 8KB for performance — most user requests appear in the header.
 */
export function getTitleFromTranscript(cid: string, maxLen = 55): string | null {
    const logPath = path.join(BRAIN_DIR, cid, '.system_generated', 'logs', 'overview.txt');
    if (!fs.existsSync(logPath)) return null;
    try {
        const fd = fs.openSync(logPath, 'r');
        const buffer = Buffer.alloc(8192);
        const bytesRead = fs.readSync(fd, buffer, 0, 8192, 0);
        fs.closeSync(fd);
        const content = buffer.toString('utf8', 0, bytesRead);

        let rawPrompt: string | null = null;

        // Try XML-style user request
        const xmlMatch = content.match(/<USER_REQUEST>([\s\S]*?)<\/USER_REQUEST>/i);
        if (xmlMatch && xmlMatch[1].trim().length > 0) {
            rawPrompt = xmlMatch[1];
        } else {
            // Try JSON-style
            const jsonMatch = content.match(/"role"\s*:\s*"user"[\s\S]*?"content"\s*:\s*"((?:[^"\\]|\\.)*)"/i);
            if (jsonMatch) {
                try { rawPrompt = JSON.parse(`"${jsonMatch[1]}"`); }
                catch { rawPrompt = jsonMatch[1]; }
            }
        }

        if (rawPrompt) {
            let text = rawPrompt
                .replace(/<[^>]+>/g, '').replace(/```[\s\S]*?```/g, '')
                .replace(/\\[nrt]/g, ' ').replace(/\s+/g, ' ').trim();

            // Strip filler prefixes
            const fillers = [
                /^(can you )?(please )?(help me )?(write|create|build|fix|update|explain)\s+/i,
                /^(ok|so|now|and),?\s+/i,
            ];
            for (const reg of fillers) text = text.replace(reg, '');

            if (text.length > 3 && !/^(ok|yes|no|continue|next)$/i.test(text.trim()) && !isGenericTitle(text)) {
                text = text.charAt(0).toUpperCase() + text.slice(1);
                return text.length > maxLen ? text.substring(0, maxLen - 3) + '...' : text;
            }
        }
    } catch { /* ignore */ }
    return null;
}

// ─── Global Index Title Extraction ──────────────────────────────────

type GlobalIndexResult = { titleMap: Map<string, string>, stepCounts: Map<string, number> };
const EMPTY_RESULT: GlobalIndexResult = { titleMap: new Map(), stepCounts: new Map() };

/**
 * Parse the raw protobuf bytes from trajectorySummaries into title + stepCount maps.
 */
function parseTrajectorySummaries(decoded: Buffer): GlobalIndexResult {
    const { decodeVarint, skipProtobufField } = require('./protobuf');
    const titleMap = new Map<string, string>();
    const stepCounts = new Map<string, number>();
    let pos = 0;
    while (pos < decoded.length) {
        try {
            const { value: tag, pos: tagEnd } = decodeVarint(decoded, pos);
            if ((tag & 7) !== 2) break;
            const { value: entryLen, pos: entryStart } = decodeVarint(decoded, tagEnd);
            const entry = decoded.subarray(entryStart, entryStart + entryLen);
            pos = entryStart + entryLen;

            let ep = 0, id = '', title = '', stepCount = 0;
            while (ep < entry.length) {
                try {
                    const { value: t, pos: tnext } = decodeVarint(entry, ep);
                    const fn = Math.floor(t / 8);
                    const wt = t & 7;
                    if (wt === 2) {
                        const { value: l, pos: ds } = decodeVarint(entry, tnext);
                        if (fn === 1) {
                            id = entry.subarray(ds, ds + l).toString('utf8');
                        } else if (fn === 2) {
                            const base64Str = entry.subarray(ds, ds + l).toString('utf8');
                            const innerBuf = Buffer.from(base64Str, 'base64');
                            let ip = 0;
                            while (ip < innerBuf.length) {
                                const { value: it, pos: itnext } = decodeVarint(innerBuf, ip);
                                const ifn = Math.floor(it / 8);
                                const iwt = it & 7;
                                if (iwt === 0) {
                                    const { value: val, pos: next } = decodeVarint(innerBuf, itnext);
                                    if (ifn === 2) stepCount = val;
                                    ip = next;
                                } else if (iwt === 2) {
                                    const { value: il, pos: ids } = decodeVarint(innerBuf, itnext);
                                    if (ifn === 1) title = innerBuf.subarray(ids, ids + il).toString('utf8');
                                    ip = ids + il;
                                } else {
                                    ip = skipProtobufField(innerBuf, itnext, iwt);
                                }
                            }
                        }
                        ep = ds + l;
                    } else {
                        ep = skipProtobufField(entry, tnext, wt);
                    }
                } catch { break; }
            }
            if (id) {
                if (title) titleMap.set(id, title);
                if (stepCount > 0) stepCounts.set(id, stepCount);
            }
        } catch { break; }
    }
    return { titleMap, stepCounts };
}

/**
 * Extract conversation IDs, Titles, and Step Counts from the global trajectory summaries.
 * Uses shared db.ts for cross-platform SQLite access (native module + CLI fallback).
 */
export async function getGlobalIndexData(): Promise<GlobalIndexResult> {
    const { dbGet } = require('./db');
    const raw: string | null = await dbGet('antigravityUnifiedStateSync.trajectorySummaries');
    if (!raw) return EMPTY_RESULT;

    try {
        const decoded = Buffer.from(raw, 'base64');
        return parseTrajectorySummaries(decoded);
    } catch { return EMPTY_RESULT; }
}


