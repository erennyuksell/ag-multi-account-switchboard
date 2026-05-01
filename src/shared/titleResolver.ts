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
                    if (/[a-zA-Z]/.test(text) && text.length > 3) {
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
