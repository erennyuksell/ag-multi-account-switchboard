/**
 * Agent State Stream Service
 *
 * ConnectRPC server-streaming client for `StreamAgentStateUpdates`.
 * Provides real-time trajectory updates (generatorMetadata deltas)
 * instead of polling — matching how the AG IDE natively consumes this data.
 *
 * Wire format: ConnectRPC server streaming over HTTP
 *   Request: 5-byte envelope (flags=0x00 + 4-byte BE length) + JSON body
 *   Response: chunked stream of enveloped JSON messages
 *     flags=0x00 → data message
 *     flags=0x02 → end-of-stream trailer
 */

import * as http from 'http';
import { EventEmitter } from 'events';
import { ServerInfo } from '../types';
import { createLogger } from '../utils/logger';

const log = createLogger('AgentStateStream');

const diagPath = '/tmp/ag-ctx-diag.log';
function diag(msg: string) {
    try { require('fs').appendFileSync(diagPath, `[${new Date().toISOString()}] STREAM: ${msg}\n`); } catch {}
}

const SVC_PATH = '/exa.language_server_pb.LanguageServerService/StreamAgentStateUpdates';

/** Reconnection backoff: 1s, 2s, 4s, 8s, max 30s */
const RECONNECT_DELAYS = [1000, 2000, 4000, 8000, 16000, 30000];

export interface StreamGeneratorMeta {
    chatModel?: {
        responseModel?: string;
        usage?: {
            model?: string;
            inputTokens?: string;
            outputTokens?: string;
            apiProvider?: string;
        };
        completionConfig?: {
            maxTokens?: string;
            temperature?: number;
            topK?: string;
            topP?: number;
        };
        chatStartMetadata?: {
            contextWindowMetadata?: {
                estimatedTokensUsed?: number;
                totalTokens?: number;
                tokenBreakdown?: {
                    groups?: Array<{
                        name?: string;
                        numTokens?: number;
                        children?: Array<{ name?: string; numTokens?: number }>;
                    }>;
                };
            };
        };
    };
}

export interface AgentStateUpdate {
    conversationId?: string;
    status?: string;
    mainTrajectoryUpdate?: {
        generatorMetadatasUpdate?: {
            totalLength?: number;
            indices?: number[];
            generatorMetadatas?: StreamGeneratorMeta[];
        };
    };
    creditUsageSummary?: unknown;
}

/**
 * Manages a single ConnectRPC server-streaming connection to LS.
 * Emits 'update' events with parsed AgentStateUpdate payloads.
 * Handles reconnection, conversation switching, and clean shutdown.
 */
export class AgentStateStreamService extends EventEmitter {
    private currentReq: http.ClientRequest | null = null;
    private currentCascadeId: string | null = null;
    private currentServer: ServerInfo | null = null;
    private subscriberId = 0;
    private reconnectAttempt = 0;
    private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
    private destroyed = false;
    private lastEmittedStatus: string | null = null;
    private isWarmup = false; // Skip first status from initial snapshot
    private lastDataTime = 0; // Timestamp of last received data
    private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
    private static readonly HEARTBEAT_INTERVAL = 60_000; // Check every 60s
    private static readonly ZOMBIE_TIMEOUT = 300_000;    // 5 min no data = zombie (idle periods are normal)
    private static readonly SOCKET_TIMEOUT = 300_000;    // 5 min TCP-level timeout for dead connections
    private static readonly MAX_RECONNECT_BEFORE_STALE = 3; // After 3 failures, emit serverStale

    /**
     * Connect to the LS stream for a specific conversation.
     * If already connected to a different conversation, disconnects first.
     */
    connect(serverInfo: ServerInfo, cascadeId: string): void {
        // Same conversation, same server → skip
        if (
            this.currentCascadeId === cascadeId &&
            this.currentServer?.port === serverInfo.port &&
            this.currentReq
        ) {
            diag(`connect: already streaming ${cascadeId.substring(0, 12)}, skip`);
            return;
        }

        // Different conversation or server → reconnect
        this.disconnect();
        this.currentServer = serverInfo;
        this.currentCascadeId = cascadeId;
        this.reconnectAttempt = 0;
        this.isWarmup = true; // Initial snapshot status will be skipped
        this._connect();
    }

    /** Disconnect from the current stream (full reset for conversation switch) */
    disconnect(): void {
        // Invalidate any pending callbacks from the current connection
        this.subscriberId++;
        if (this.reconnectTimer) {
            clearTimeout(this.reconnectTimer);
            this.reconnectTimer = null;
        }
        if (this.currentReq) {
            this.currentReq.destroy();
            this.currentReq = null;
        }
        this.currentCascadeId = null;
        this.currentServer = null;
        // Only clear on full disconnect — reconnects preserve status to prevent false-IDLE
        this.lastEmittedStatus = null;
        this._stopHeartbeat();
    }

    /** Full shutdown — no reconnection */
    destroy(): void {
        this.destroyed = true;
        this._stopHeartbeat();
        this.disconnect();
        this.removeAllListeners();
    }

    get isConnected(): boolean {
        return this.currentReq !== null;
    }

    get activeCascadeId(): string | null {
        return this.currentCascadeId;
    }

    // ── Internal ──

    private _connect(): void {
        const server = this.currentServer;
        const cascadeId = this.currentCascadeId;
        if (!server || !cascadeId || this.destroyed) return;

        const connId = ++this.subscriberId;
        const subId = `ag-panel-${connId}-${Date.now()}`;
        const shortId = cascadeId.substring(0, 12);
        diag(`_connect: port=${server.port} cascade=${shortId} sub=${subId}`);

        // Staleness check: if subscriberId changed, this connection is abandoned
        const isStale = () => this.subscriberId !== connId || this.destroyed;

        // Build ConnectRPC envelope: 5-byte header + JSON body
        const bodyJson = JSON.stringify({
            conversationId: cascadeId,
            subscriberId: subId,
        });
        const bodyBuf = Buffer.from(bodyJson, 'utf8');
        const envelope = Buffer.alloc(5 + bodyBuf.length);
        envelope.writeUInt8(0x00, 0);          // flags: no compression
        envelope.writeUInt32BE(bodyBuf.length, 1); // message length
        bodyBuf.copy(envelope, 5);

        const req = http.request({
            hostname: '127.0.0.1',
            port: server.port,
            path: SVC_PATH,
            method: 'POST',
            headers: {
                'Content-Type': 'application/connect+json',
                'Connect-Protocol-Version': '1',
                'X-Codeium-Csrf-Token': server.csrfToken,
                'Content-Length': envelope.length,
            },
        }, (res) => {
            if (isStale()) { res.destroy(); return; }

            if (res.statusCode !== 200) {
                diag(`_connect: HTTP ${res.statusCode} — will retry`);
                log.info(`Stream: HTTP ${res.statusCode}`);
                if (!isStale()) this._scheduleReconnect();
                return;
            }

            diag(`_connect: stream OPEN port=${server.port}`);
            this.reconnectAttempt = 0; // reset on successful connect
            this.lastDataTime = Date.now();
            this._startHeartbeat();

            // TCP-level timeout: detects silently dead connections (sleep/wake)
            res.socket?.setTimeout(AgentStateStreamService.SOCKET_TIMEOUT, () => {
                diag(`SOCKET TIMEOUT: TCP idle ${AgentStateStreamService.SOCKET_TIMEOUT / 1000}s — forcing reconnect`);
                res.destroy();
            });

            let chunks: Buffer[] = [];
            let chunkLen = 0;

            res.on('data', (chunk: Buffer) => {
                if (isStale()) { res.destroy(); return; }
                chunks.push(chunk);
                chunkLen += chunk.length;
                const combined = Buffer.concat(chunks, chunkLen);
                const remaining = this._parseEnvelopes(combined);
                chunks = remaining.length > 0 ? [Buffer.from(remaining)] : [];
                chunkLen = remaining.length;
            });

            res.on('end', () => {
                diag('stream ended');
                this.currentReq = null;
                if (!isStale()) this._scheduleReconnect();
            });

            res.on('error', (err) => {
                diag(`stream error: ${err.message}`);
                this.currentReq = null;
                if (!isStale()) this._scheduleReconnect();
            });
        });

        req.on('error', (err) => {
            diag(`req error: ${err.message}`);
            this.currentReq = null;
            // ECONNREFUSED = LS port changed (restart). After N failures, signal stale server.
            if ((err as any).code === 'ECONNREFUSED' && this.reconnectAttempt >= AgentStateStreamService.MAX_RECONNECT_BEFORE_STALE) {
                diag(`SERVER STALE: ${this.reconnectAttempt} reconnects failed with ECONNREFUSED — requesting fresh server info`);
                this.emit('serverStale', { cascadeId: this.currentCascadeId });
                return; // Don't schedule more reconnects — wait for external connect() with fresh info
            }
            if (!isStale()) this._scheduleReconnect();
        });

        req.write(envelope);
        req.end();
        this.currentReq = req;
    }

    /**
     * Parse ConnectRPC enveloped messages from a buffer.
     * Returns remaining unparsed bytes.
     */
    private _parseEnvelopes(buffer: Buffer): Buffer {
        this.lastDataTime = Date.now(); // Track activity for zombie detection
        while (buffer.length >= 5) {
            const flags = buffer.readUInt8(0);
            const msgLen = buffer.readUInt32BE(1);

            if (buffer.length < 5 + msgLen) break; // incomplete

            const msgBody = buffer.slice(5, 5 + msgLen);
            buffer = buffer.slice(5 + msgLen);

            if (flags === 0x02) {
                // End-of-stream trailer — ignore
                continue;
            }

            try {
                const parsed = JSON.parse(msgBody.toString('utf8'));
                const update: AgentStateUpdate = parsed.update || parsed;
                this._handleUpdate(update);
            } catch (err) {
                diag(`parse error: ${(err as Error).message}`);
            }
        }
        return buffer;
    }

    /** Process a single AgentStateUpdate */
    private _handleUpdate(update: AgentStateUpdate): void {
        const gmu = update.mainTrajectoryUpdate?.generatorMetadatasUpdate;

        if (gmu) {
            const metas = gmu.generatorMetadatas || [];
            const withChatModel = metas.filter(m => m?.chatModel).length;
            const withTokens = metas.filter(m => m?.chatModel?.chatStartMetadata?.contextWindowMetadata?.estimatedTokensUsed).length;
            if (metas.length > 0) {
                diag(`DELTA: entries=${metas.length} totalLen=${gmu.totalLength} withChat=${withChatModel} withTokens=${withTokens} indices=${(gmu.indices || []).slice(-3).join(',')}`);
            }
            // Always emit totalLength so ContextWindowService can override stale API count
            if ((gmu.totalLength ?? 0) > 0 && update.conversationId) {
                this.emit('metaCount', {
                    totalLength: gmu.totalLength,
                    conversationId: update.conversationId,
                });
            }
        }

        // Status transitions only (deduplicated: IDLE → RUNNING → IDLE)
        if (update.status && update.status !== this.lastEmittedStatus) {
            // Skip the very first status from initial snapshot (always IDLE, even if model is running)
            if (this.isWarmup) {
                this.isWarmup = false;
                this.lastEmittedStatus = update.status;
                diag(`STATUS (warmup, skip): ${update.status} for ${update.conversationId?.substring(0, 12)}`);
                return;
            }
            this.lastEmittedStatus = update.status;
            diag(`STATUS: ${update.status} for ${update.conversationId?.substring(0, 12)}`);
            this.emit('statusChange', {
                status: update.status,
                conversationId: update.conversationId,
            });
        }
    }

    /** Schedule reconnection with exponential backoff */
    private _scheduleReconnect(): void {
        if (this.destroyed || !this.currentCascadeId) return;

        const delay = RECONNECT_DELAYS[
            Math.min(this.reconnectAttempt, RECONNECT_DELAYS.length - 1)
        ];
        this.reconnectAttempt++;

        diag(`reconnect in ${delay}ms (attempt ${this.reconnectAttempt})`);
        this.reconnectTimer = setTimeout(() => {
            this.reconnectTimer = null;
            this.isWarmup = true; // Skip initial snapshot status on reconnect too
            this._connect();
        }, delay);
    }

    /** Start heartbeat timer to detect zombie connections (e.g. after sleep/wake) */
    private _startHeartbeat(): void {
        this._stopHeartbeat();
        this.heartbeatTimer = setInterval(() => {
            if (this.destroyed || !this.currentReq) {
                this._stopHeartbeat();
                return;
            }
            const elapsed = Date.now() - this.lastDataTime;
            if (elapsed > AgentStateStreamService.ZOMBIE_TIMEOUT) {
                diag(`HEARTBEAT: zombie detected (${Math.round(elapsed / 1000)}s no data) — forcing reconnect`);
                // Save before disconnect (which nullifies these)
                const server = this.currentServer;
                const cascadeId = this.currentCascadeId;
                this.disconnect();
                if (server && cascadeId) {
                    this.currentServer = server;
                    this.currentCascadeId = cascadeId;
                    this.isWarmup = true;
                    this._connect();
                }
            }
        }, AgentStateStreamService.HEARTBEAT_INTERVAL);
    }

    /** Stop heartbeat timer */
    private _stopHeartbeat(): void {
        if (this.heartbeatTimer) {
            clearInterval(this.heartbeatTimer);
            this.heartbeatTimer = null;
        }
    }
}
