import { EventEmitter } from 'events';
import * as http from 'http';
import { ServerInfo } from '../types';
import { createLogger } from '../utils/logger';
import { LS_SERVICE_PATH } from '../constants';

const log = createLogger('LiveStream');

/**
 * Ultra-lightweight stream — only extracts totalLength for live context window offset.
 * No reconnect, no heartbeat, no zombie detection.
 * USS trajectorySummaries is the primary signal; this is a real-time offset hint.
 */
export class LiveStream extends EventEmitter {
    private req: http.ClientRequest | null = null;
    private buffer = Buffer.alloc(0);
    private destroyed = false;
    private cascadeId: string | null = null;

    connect(server: ServerInfo, cascadeId: string): void {
        this.disconnect();
        this.cascadeId = cascadeId;
        this.destroyed = false;

        const subId = `ag-live-${Date.now()}`;
        const bodyObj = { conversationId: cascadeId, subscriberId: subId };
        const jsonBuf = Buffer.from(JSON.stringify(bodyObj), 'utf8');

        // ConnectRPC envelope: 1-byte tag (0x00) + 4-byte big-endian length + JSON payload
        const envelope = Buffer.alloc(5 + jsonBuf.length);
        envelope.writeUInt8(0x00, 0);
        envelope.writeUInt32BE(jsonBuf.length, 1);
        jsonBuf.copy(envelope, 5);

        log.diag(`connect port=${server.port} cascade=${cascadeId.substring(0, 12)}`);

        const req = http.request({
            hostname: '127.0.0.1',
            port: server.port,
            path: `${LS_SERVICE_PATH}/StreamAgentStateUpdates`,
            method: 'POST',
            headers: {
                'Content-Type': 'application/connect+json',
                'Connect-Protocol-Version': '1',
                'X-Codeium-Csrf-Token': server.csrfToken,
                'Content-Length': String(envelope.length),
            },
        }, (res) => {
            if (this.destroyed) { res.destroy(); return; }
            if (res.statusCode !== 200) {
                log.diag(`HTTP ${res.statusCode}`);
                return;
            }
            log.diag('stream OPEN');

            let totalBytes = 0;
            let firstChunk = true;
            res.on('data', (chunk: Buffer) => {
                if (this.destroyed) { res.destroy(); return; }
                totalBytes += chunk.length;
                if (firstChunk) {
                    firstChunk = false;
                    // Dump first 200 chars for debugging
                    const preview = chunk.subarray(5).toString('utf8').substring(0, 300);
                    log.diag(`first chunk: ${chunk.length}b tag=${chunk[0]} len=${chunk.readUInt32BE(1)} preview=${preview}`);
                }
                this.buffer = Buffer.concat([this.buffer, chunk]);
                this.parseFrames();
            });

            res.on('end', () => log.diag(`stream ended (${totalBytes} bytes received, buf=${this.buffer.length})`));
            res.on('error', (err) => log.diag(`error: ${err.message}`));
        });

        req.on('error', (err) => log.diag(`req error: ${err.message}`));
        req.write(envelope);
        req.end();
        this.req = req;
    }

    disconnect(): void {
        this.req?.destroy();
        this.req = null;
        this.buffer = Buffer.alloc(0);
    }

    destroy(): void {
        this.destroyed = true;
        this.disconnect();
        this.removeAllListeners();
    }

    private parseFrames(): void {
        while (this.buffer.length >= 5) {
            const tag = this.buffer.readUInt8(0);
            const len = this.buffer.readUInt32BE(1);
            if (this.buffer.length < 5 + len) break;

            const payload = this.buffer.subarray(5, 5 + len);
            this.buffer = this.buffer.subarray(5 + len);

            // tag 0x02 = end-of-stream trailer, skip
            if (tag !== 0x00) continue;

            try {
                const parsed = JSON.parse(payload.toString('utf8'));
                const update = parsed.update || parsed;
                const totalLength = update?.mainTrajectoryUpdate?.generatorMetadatasUpdate?.totalLength;

                if (totalLength && totalLength > 0 && this.cascadeId) {
                    this.emit('totalLength', {
                        totalLength,
                        conversationId: this.cascadeId,
                    });
                }
            } catch { /* malformed frame, skip */ }
        }
    }
}
