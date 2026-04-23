/**
 * Minimal protobuf encoding/decoding utilities.
 *
 * These are used to construct and parse the IDE's internal proto messages
 * (UserStatus, USS UpdateRequest, etc.) without requiring a full protobuf
 * library dependency.
 *
 * Wire types: 0=varint, 1=64-bit, 2=length-delimited, 5=32-bit
 */

// ==================== Encoding ====================

/** Encode a raw varint (variable-length integer) */
export function encodeVarInt(v: number): Buffer {
    const bytes: number[] = [];
    while (v > 0x7f) {
        bytes.push((v & 0x7f) | 0x80);
        v >>>= 7;
    }
    bytes.push(v & 0x7f);
    return Buffer.from(bytes);
}

/** Encode a field tag (field number + wire type) */
export function encodeTag(fieldNumber: number, wireType: number): Buffer {
    return encodeVarInt((fieldNumber << 3) | wireType);
}

/** Encode a string/bytes field (wire type 2: length-delimited) */
export function encodeString(fieldNumber: number, value: string): Buffer {
    const buf = Buffer.from(value, 'utf-8');
    return Buffer.concat([encodeTag(fieldNumber, 2), encodeVarInt(buf.length), buf]);
}

/** Encode a varint field (wire type 0) */
export function encodeVarintField(fieldNumber: number, value: number): Buffer {
    return Buffer.concat([encodeTag(fieldNumber, 0), encodeVarInt(value)]);
}

/** Encode a nested message field (wire type 2: length-delimited) */
export function encodeMessage(fieldNumber: number, payload: Buffer): Buffer {
    return Buffer.concat([encodeTag(fieldNumber, 2), encodeVarInt(payload.length), payload]);
}

// ==================== Decoding ====================

/**
 * Decode a single varint from buffer at a given offset.
 * Returns [value, newOffset].
 */
function decodeVarInt(buf: Buffer, offset: number): [number, number] {
    let value = 0;
    let shift = 0;
    while (offset < buf.length) {
        const byte = buf[offset++];
        value |= (byte & 0x7f) << shift;
        shift += 7;
        if (!(byte & 0x80)) break;
    }
    return [value, offset];
}

/** Parsed protobuf field from readFields() */
export interface ProtoField {
    field: number;
    wireType: number;
    varint?: number;
    bytes?: Buffer;
}

/**
 * Parse ALL fields from a protobuf buffer into an array.
 * General-purpose decoder: supports varint (0), 64-bit (1), length-delimited (2), 32-bit (5).
 * Used by tokenBase parsers and context scope parser.
 */
export function readFields(buf: Buffer): ProtoField[] {
    const fields: ProtoField[] = [];
    let offset = 0;
    while (offset < buf.length) {
        const [tag, tagOffset] = decodeVarInt(buf, offset);
        offset = tagOffset;
        const fieldNumber = tag >> 3;
        const wireType = tag & 0x7;

        if (wireType === 0) {
            const [val, valOffset] = decodeVarInt(buf, offset);
            fields.push({ field: fieldNumber, wireType, varint: val });
            offset = valOffset;
        } else if (wireType === 2) {
            const [len, lenOffset] = decodeVarInt(buf, offset);
            offset = lenOffset;
            fields.push({ field: fieldNumber, wireType, bytes: buf.subarray(offset, offset + len) });
            offset += len;
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

/**
 * Extract a length-delimited (wire type 2) proto field by field number.
 * Convenience wrapper around readFields for single-field extraction.
 * Returns the raw bytes of the field value, or null if not found.
 */
export function extractField(buf: Buffer, targetField: number): Buffer | null {
    const fields = readFields(buf);
    const match = fields.find(f => f.field === targetField && f.wireType === 2);
    return match?.bytes ?? null;
}

/**
 * Extract a string field from a protobuf buffer.
 * Convenience wrapper around extractField that decodes UTF-8.
 */
export function extractStringField(buf: Buffer, targetField: number): string {
    const raw = extractField(buf, targetField);
    return raw ? raw.toString('utf-8') : '';
}

