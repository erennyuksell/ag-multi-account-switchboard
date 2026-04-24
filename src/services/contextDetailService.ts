/**
 * ContextDetailService — fetches step content and exports conversation as markdown.
 *
 * Data sources:
 * - GetCascadeTrajectorySteps → step content (user messages, commands, code edits)
 * - ConvertTrajectoryToMarkdown → full conversation markdown export
 */

import { ServerInfo } from '../types';
import { callLsJson } from '../utils/lsClient';
import { createLogger } from '../utils/logger';

const log = createLogger('CtxDetail');

export interface StepContent {
    type: string;
    /** Human-readable label for the step */
    label: string;
    /** Main content text */
    content: string;
    /** Optional secondary content (e.g. command output) */
    output?: string;
    /** Timestamp */
    createdAt?: string;
    /** Token count from modelUsage */
    tokens?: { input: number; output: number };
}

export class ContextDetailService {

    /**
     * Fetch a specific step's content from the trajectory.
     *
     * The `ordinal` is the sequential position of this child within
     * its tokenBreakdown group (Chat Messages). This maps directly
     * to the trajectory steps array, giving us an exact match.
     */
    async getStepContent(
        serverInfo: ServerInfo,
        cascadeId: string,
        stepName: string,
        ordinal: number = -1,
    ): Promise<StepContent | null> {
        try {
            const match = stepName.match(/^(\d+):\s*(.+)$/);
            const stepIndex = match ? parseInt(match[1], 10) : ordinal;
            const targetType = match ? match[2].trim() : stepName;
            const fullType = `CORTEX_STEP_TYPE_${targetType}`;

            // Use step index as step_offset for precise single-step fetch
            const offset = stepIndex >= 0 ? stepIndex : 0;
            const resp = await callLsJson(serverInfo, 'GetCascadeTrajectorySteps', {
                cascade_id: cascadeId,
                step_offset: offset,
            }, 15000);

            const steps = resp?.steps || [];
            if (steps.length === 0) return null;

            let step: any = null;

            // Primary: first step at the requested offset should be our target
            if (steps[0] && (steps[0].type || '').includes(targetType)) {
                step = steps[0];
            }

            // Fallback: search nearby steps (offset might be slightly off)
            if (!step) {
                for (let i = 0; i < Math.min(5, steps.length); i++) {
                    if ((steps[i]?.type || '') === fullType || (steps[i]?.type || '').includes(targetType)) {
                        step = steps[i];
                        break;
                    }
                }
            }

            // Last resort: just use step[0]
            if (!step && steps.length > 0) {
                step = steps[0];
            }

            if (!step) {
                log.warn(`getStepContent: no step for "${stepName}" offset=${offset}`);
                return null;
            }

            return this.parseStep(step);
        } catch (e: any) {
            log.warn('getStepContent failed:', e?.message);
            return null;
        }
    }

    /**
     * Export the conversation as markdown using the LS endpoint.
     */
    async exportAsMarkdown(
        serverInfo: ServerInfo,
        cascadeId: string,
    ): Promise<string | null> {
        try {
            const resp = await callLsJson(serverInfo, 'ConvertTrajectoryToMarkdown', {
                conversationId: cascadeId,
            }, 30000);

            if (resp?.markdown) return resp.markdown;

            // Try alternate response shapes
            if (typeof resp === 'string') return resp;
            if (resp?.result) return resp.result;

            log.warn('exportAsMarkdown: unexpected response shape', Object.keys(resp || {}));
            return null;
        } catch (e: any) {
            log.warn('exportAsMarkdown failed:', e?.message);
            return null;
        }
    }

    private parseStep(step: any): StepContent {
        const type = (step.type || 'UNKNOWN')
            .replace('CORTEX_STEP_TYPE_', '');
        const meta = step.metadata || {};
        const created = meta.createdAt || '';
        const usage = meta.modelUsage;
        const tokens = usage ? {
            input: parseInt(usage.inputTokens || '0', 10),
            output: parseInt(usage.outputTokens || '0', 10),
        } : undefined;

        switch (type) {
            case 'USER_INPUT': {
                const ui = step.userInput || {};
                return {
                    type,
                    label: '💬 User Input',
                    content: ui.userResponse || ui.items?.[0]?.text || '(empty)',
                    createdAt: created,
                    tokens,
                };
            }
            case 'PLANNER_RESPONSE': {
                const pr = step.plannerResponse || {};
                return {
                    type,
                    label: '🤖 Model Response',
                    content: pr.thinking || pr.response || '(thinking hidden)',
                    createdAt: created,
                    tokens,
                };
            }
            case 'RUN_COMMAND': {
                const rc = step.runCommand || {};
                return {
                    type,
                    label: '▶ Command',
                    content: rc.commandLine || rc.proposedCommandLine || '',
                    output: (rc.combinedOutput?.full || '').substring(0, 2000),
                    createdAt: created,
                    tokens,
                };
            }
            case 'CODE_ACTION': {
                const ca = step.codeAction || step.codeEdit || {};
                const file = ca.filePath || ca.path || '';
                return {
                    type,
                    label: '✏️ Code Edit',
                    content: file ? `File: ${file}` : '(code action)',
                    createdAt: created,
                    tokens,
                };
            }
            case 'VIEW_FILE': {
                const vf = step.viewFile || {};
                return {
                    type,
                    label: '📄 File Read',
                    content: vf.filePath || vf.path || '(file)',
                    createdAt: created,
                    tokens,
                };
            }
            case 'CONVERSATION_HISTORY': {
                const ch = step.conversationHistory || {};
                return {
                    type,
                    label: '📋 Conversation History',
                    content: (ch.content || '(empty)').substring(0, 5000),
                    createdAt: created,
                    tokens,
                };
            }
            case 'KNOWLEDGE_ARTIFACTS': {
                const ka = step.knowledgeArtifacts || {};
                return {
                    type,
                    label: '🧠 Knowledge Artifacts',
                    content: (ka.content || '(empty)').substring(0, 5000),
                    createdAt: created,
                    tokens,
                };
            }
            case 'CHECKPOINT': {
                const cp = step.checkpoint || {};
                return {
                    type,
                    label: '📌 Checkpoint',
                    content: (cp.content || cp.summary || this.extractDeepContent(step) || '(checkpoint)').substring(0, 5000),
                    createdAt: created,
                    tokens,
                };
            }
            case 'EPHEMERAL_MESSAGE': {
                const em = step.ephemeralMessage || {};
                const text = em.content || '';
                if (!text) {
                    return {
                        type,
                        label: '👻 Ephemeral Message',
                        content: '(empty ephemeral)',
                        createdAt: created,
                        tokens,
                    };
                }
                return {
                    type,
                    label: '👻 Ephemeral Message',
                    content: text.substring(0, 3000),
                    createdAt: created,
                    tokens,
                };
            }
            case 'ERROR_MESSAGE': {
                const err = step.errorMessage || step.error || {};
                return {
                    type,
                    label: '⚠️ Error',
                    content: (typeof err === 'string' ? err : err.message || err.content || JSON.stringify(err)).substring(0, 2000),
                    createdAt: created,
                    tokens,
                };
            }
            case 'GREP_SEARCH': {
                const gs = step.grepSearch || {};
                return {
                    type,
                    label: '🔍 Grep Search',
                    content: gs.query || gs.pattern || this.extractDeepContent(step) || '(grep)',
                    output: gs.results ? JSON.stringify(gs.results).substring(0, 2000) : undefined,
                    createdAt: created,
                    tokens,
                };
            }
            case 'COMMAND_STATUS': {
                const cs = step.commandStatus || {};
                return {
                    type,
                    label: '📊 Command Status',
                    content: cs.output || this.extractDeepContent(step) || '(status)',
                    createdAt: created,
                    tokens,
                };
            }
            case 'SEND_COMMAND_INPUT': {
                const sci = step.sendCommandInput || {};
                return {
                    type,
                    label: '⌨️ Send Input',
                    content: sci.input || this.extractDeepContent(step) || '(input)',
                    createdAt: created,
                    tokens,
                };
            }
            case 'LIST_DIRECTORY': {
                const ld = step.listDirectory || {};
                return {
                    type,
                    label: '📁 List Directory',
                    content: ld.directoryPath || ld.path || this.extractDeepContent(step) || '(directory)',
                    createdAt: created,
                    tokens,
                };
            }
            case 'BROWSER_SUBAGENT': {
                const bs = step.browserSubagent || {};
                return {
                    type,
                    label: '🌐 Browser Agent',
                    content: bs.task || bs.url || this.extractDeepContent(step) || '(browser)',
                    createdAt: created,
                    tokens,
                };
            }
            case 'MCP_TOOL': {
                const mc = step.mcpTool || {};
                const toolName = mc.serverName || mc.toolName || meta.toolCall?.name || '';
                return {
                    type,
                    label: `🔧 MCP: ${toolName}`,
                    content: mc.argumentsJson
                        ? JSON.stringify(JSON.parse(mc.argumentsJson), null, 2).substring(0, 2000)
                        : (mc.result || this.extractDeepContent(step) || `MCP Tool: ${toolName}`),
                    output: mc.result ? String(mc.result).substring(0, 2000) : undefined,
                    createdAt: created,
                    tokens,
                };
            }
            default: {
                const toolName = meta.toolCall?.name || meta.toolSummary || '';
                return {
                    type,
                    label: toolName || type,
                    content: meta.toolCall?.argumentsJson
                        ? JSON.stringify(JSON.parse(meta.toolCall.argumentsJson), null, 2).substring(0, 1000)
                        : (this.extractDeepContent(step) || `Step type: ${type}`),
                    createdAt: created,
                    tokens,
                };
            }
        }
    }

    /**
     * Deep content extractor — walks through step object to find the first
     * string value with meaningful content (>20 chars). Used as fallback
     * when specific field mappings don't have the expected structure.
     */
    private extractDeepContent(step: any, maxDepth = 3): string {
        if (!step || maxDepth <= 0) return '';
        for (const key of Object.keys(step)) {
            if (key === 'type' || key === 'status' || key === 'metadata') continue;
            const v = step[key];
            if (typeof v === 'string' && v.length > 20) return v.substring(0, 3000);
            if (v && typeof v === 'object' && !Array.isArray(v)) {
                const deep = this.extractDeepContent(v, maxDepth - 1);
                if (deep) return deep;
            }
        }
        return '';
    }
}
