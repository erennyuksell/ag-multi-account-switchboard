import * as https from 'https';
import * as fs from 'fs';
import { LS_CERT_PATHS, LS_PROCESS_GREP } from '../constants';
import { createLogger } from '../utils/logger';
import { exec } from 'child_process';
import { promisify } from 'util';
import * as path from 'path';

const execAsync = promisify(exec);
const log = createLogger('TokenBase');

// ==================== Types ====================

/** Single tool/item within a category */
export interface TokenItem {
    name: string;
    tokens: number;
    /** Sub-tools (for MCP servers) */
    tools?: Array<{ name: string; tokens: number }>;
}

/** Token category (Rules, Skills, Workflows, MCP Tools) */
export interface TokenCategory {
    name: string;
    totalTokens: number;
    items: TokenItem[];
}

/** Full GetTokenBase response */
export interface TokenBaseData {
    categories: TokenCategory[];
    totalTokens: number;
    remainingBudget: number;
    customizationBudget: number;
    usedPercent: number;
}

// ==================== Protobuf Decoders ====================

function decodeVarint(buf: Buffer, offset: number): { value: number; offset: number } {
    let result = 0, shift = 0;
    while (offset < buf.length) {
        const byte = buf[offset++];
        result |= (byte & 0x7F) << shift;
        if (!(byte & 0x80)) break;
        shift += 7;
    }
    return { value: result, offset };
}

interface ProtoField {
    field: number;
    wireType: number;
    varint?: number;
    bytes?: Buffer;
}

function readFields(buf: Buffer): ProtoField[] {
    const fields: ProtoField[] = [];
    let offset = 0;
    while (offset < buf.length) {
        const tag = decodeVarint(buf, offset);
        offset = tag.offset;
        const fieldNumber = tag.value >> 3;
        const wireType = tag.value & 0x7;

        if (wireType === 0) {
            const val = decodeVarint(buf, offset);
            fields.push({ field: fieldNumber, wireType, varint: val.value });
            offset = val.offset;
        } else if (wireType === 2) {
            const len = decodeVarint(buf, offset);
            offset = len.offset;
            fields.push({ field: fieldNumber, wireType, bytes: buf.slice(offset, offset + len.value) });
            offset += len.value;
        } else if (wireType === 5) {
            offset += 4;
        } else if (wireType === 1) {
            offset += 8;
        } else {
            break;
        }
    }
    return fields;
}

function getString(f: ProtoField): string {
    return f.bytes?.toString('utf-8') || '';
}

// ==================== Response Parser ====================

function parseMcpTool(buf: Buffer): { name: string; tokens: number } {
    const fields = readFields(buf);
    return {
        name: fields.find(f => f.field === 1)?.bytes?.toString('utf-8') || '?',
        tokens: fields.find(f => f.field === 3)?.varint || 0,
    };
}

function parseItem(buf: Buffer): TokenItem {
    const fields = readFields(buf);
    const name = fields.find(f => f.field === 1)?.bytes?.toString('utf-8') || '?';
    const tokens = fields.find(f => f.field === 3)?.varint || 0;

    // MCP servers have sub-tools in field 2
    const tools = fields
        .filter(f => f.field === 2 && f.bytes)
        .map(f => parseMcpTool(f.bytes!));

    return { name, tokens, tools: tools.length > 0 ? tools : undefined };
}

function parseCategory(buf: Buffer): TokenCategory {
    const fields = readFields(buf);
    const name = fields.find(f => f.field === 1)?.bytes?.toString('utf-8') || '?';
    const totalTokens = fields.find(f => f.field === 4)?.varint || 0;

    const items = fields
        .filter(f => f.field === 5 && f.bytes)
        .map(f => parseItem(f.bytes!));

    return { name, totalTokens, items };
}

function parseTokenBaseResponse(buf: Buffer): TokenBaseData {
    const fields = readFields(buf);

    // field 3 = groups wrapper, field 4 = remainingBudget, field 5 = customizationBudget
    const groupsWrapper = fields.find(f => f.field === 3 && f.bytes);
    const remainingBudget = fields.find(f => f.field === 4)?.varint || 0;
    const customizationBudget = fields.find(f => f.field === 5)?.varint || 0;

    let categories: TokenCategory[] = [];
    let totalTokens = 0;

    if (groupsWrapper?.bytes) {
        const wrapperFields = readFields(groupsWrapper.bytes);
        categories = wrapperFields
            .filter(f => f.field === 1 && f.bytes)
            .map(f => parseCategory(f.bytes!));
        totalTokens = wrapperFields.find(f => f.field === 2)?.varint || 0;
    }

    const usedPercent = customizationBudget > 0
        ? Math.min(100, Math.round((totalTokens / customizationBudget) * 100))
        : 0;

    return { categories, totalTokens, remainingBudget, customizationBudget, usedPercent };
}

// ==================== Service ====================

export class TokenBaseService {

    /** Fetch token base data from the first available LS */
    async fetchTokenBase(): Promise<TokenBaseData | null> {
        try {
            const lsProcesses = await this.findLS();
            if (lsProcesses.length === 0) {
                log.warn('No active LS processes found');
                return null;
            }

            const ca = this.loadCert();

            // Try each LS until one succeeds
            for (const ls of lsProcesses) {
                try {
                    const body = await this.callEndpoint(ls, ca);
                    const data = parseTokenBaseResponse(body);
                    log.info(`Token base fetched: ${data.totalTokens}/${data.customizationBudget} tokens (${data.usedPercent}% used, ${data.categories.length} categories)`);
                    return data;
                } catch (e: any) {
                    log.warn(`LS port ${ls.port} failed:`, e?.message);
                }
            }

            return null;
        } catch (e: any) {
            log.error('fetchTokenBase failed:', e?.message);
            return null;
        }
    }

    private async findLS(): Promise<Array<{ port: number; csrf: string }>> {
        try {
            const { stdout } = await execAsync(`ps aux | grep "${LS_PROCESS_GREP}" | grep -v grep`, { timeout: 5000 });
            return stdout.trim().split('\n').filter(Boolean).map(line => {
                const port = line.match(/--https_server_port\s+(\d+)/)?.[1];
                const csrf = line.match(/--csrf_token\s+([\w-]+)/)?.[1];
                return port && csrf ? { port: +port, csrf } : null;
            }).filter((x): x is { port: number; csrf: string } => x !== null);
        } catch {
            return [];
        }
    }

    private loadCert(): Buffer | undefined {
        const dynamicPath = path.join(path.dirname(require.main?.filename || ''), '..', 'languageServer', 'cert.pem');
        for (const p of [dynamicPath, ...LS_CERT_PATHS]) {
            try { return fs.readFileSync(p); } catch { /* next */ }
        }
        return undefined;
    }

    private callEndpoint(ls: { port: number; csrf: string }, ca?: Buffer): Promise<Buffer> {
        return new Promise((resolve, reject) => {
            const req = https.request({
                hostname: 'localhost',
                port: ls.port,
                path: '/exa.language_server_pb.LanguageServerService/GetTokenBase',
                method: 'POST',
                headers: {
                    'Content-Type': 'application/proto',
                    'Connect-Protocol-Version': '1',
                    'x-codeium-csrf-token': ls.csrf,
                    'Content-Length': '0',
                },
                ...(ca ? { ca, rejectUnauthorized: true } : { rejectUnauthorized: false }),
            }, (res) => {
                const chunks: Buffer[] = [];
                res.on('data', (c: Buffer) => chunks.push(c));
                res.on('end', () => {
                    const body = Buffer.concat(chunks);
                    res.statusCode === 200 ? resolve(body) : reject(new Error(`HTTP ${res.statusCode}`));
                });
            });
            req.on('error', reject);
            req.setTimeout(10000, () => req.destroy(new Error('timeout')));
            req.end();
        });
    }
}
