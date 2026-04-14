import { createLogger } from '../utils/logger';
import { findLSEndpoints, loadLSCert, callLSEndpoint } from '../utils/lsClient';

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


export class TokenBaseService {

    /** Fetch token base data from the first available LS */
    async fetchTokenBase(): Promise<TokenBaseData | null> {
        try {
            const lsProcesses = await findLSEndpoints();
            if (lsProcesses.length === 0) {
                log.warn('No active LS processes found');
                return null;
            }

            const ca = loadLSCert();
            const endpoint = '/exa.language_server_pb.LanguageServerService/GetTokenBase';

            // Try each LS until one succeeds
            for (const ls of lsProcesses) {
                try {
                    const body = await callLSEndpoint(ls, endpoint, ca);
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
}
