const { Buffer } = require('node:buffer');

const HEADER_BYTES = 36;
const RECORD_TYPE = Object.freeze({ frame: 1, resize: 2, ended: 3, error: 4, audio: 5 });
const TYPE_NAME = new Map(Object.entries(RECORD_TYPE).map(([name, value]) => [value, name]));

class NativeFrameParser {
  constructor({ maxPayloadBytes = 64 * 1024 * 1024 } = {}) {
    this.maxPayloadBytes = maxPayloadBytes;
    this.header = Buffer.alloc(HEADER_BYTES);
    this.headerUsed = 0;
    this.payload = null;
    this.payloadUsed = 0;
    this.pending = null;
    this.lastSequence = 0;
    this.lastTimestampUs = new Map();
  }

  parseHeader() {
    if (this.header.toString('ascii', 0, 4) !== 'BGCF') throw new Error('invalid native frame magic');
    if (this.header.readUInt32LE(4) !== 1) throw new Error('unsupported native frame version');
    const type = TYPE_NAME.get(this.header.readUInt32LE(8));
    if (!type) throw new Error('unknown native record type');
    const sequence = this.header.readUInt32LE(12);
    const width = this.header.readUInt32LE(16);
    const height = this.header.readUInt32LE(20);
    const time = this.header.readBigUInt64LE(24);
    const length = this.header.readUInt32LE(32);
    if (length > this.maxPayloadBytes) throw new Error('native frame payload too large');
    if (time > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error('native timestamp exceeds safe range');
    const timestampUs = Number(time);
    if (sequence <= this.lastSequence) throw new Error('native frame sequence moved backwards');
    if (timestampUs < (this.lastTimestampUs.get(type) ?? -1)) throw new Error('native frame timestamp moved backwards');
    if (type === 'frame') {
      if (!width || !height || width > 16384 || height > 16384 || width % 2 || height % 2 ||
          length !== width * height * 3 / 2) throw new Error('invalid I420 frame size');
    } else if (type === 'audio') {
      if (width !== 48000 || height !== 2 || !length || length > 192_000 || length % 4) throw new Error('invalid stereo PCM audio record');
    } else if (length !== 0) {
      throw new Error('status record has unexpected payload');
    }
    this.pending = { type, sequence, width, height, timestampUs, length };
    this.payload = Buffer.allocUnsafe(length);
    this.payloadUsed = 0;
  }

  finish(output) {
    output.push({ ...this.pending, payload: this.payload });
    this.lastSequence = this.pending.sequence;
    this.lastTimestampUs.set(this.pending.type, this.pending.timestampUs);
    this.pending = null;
    this.payload = null;
    this.payloadUsed = 0;
    this.headerUsed = 0;
  }

  push(chunk) {
    const output = [];
    let offset = 0;
    while (offset < chunk.length) {
      if (!this.pending) {
        const bytes = Math.min(HEADER_BYTES - this.headerUsed, chunk.length - offset);
        chunk.copy(this.header, this.headerUsed, offset, offset + bytes);
        this.headerUsed += bytes;
        offset += bytes;
        if (this.headerUsed < HEADER_BYTES) continue;
        this.parseHeader();
        if (this.pending.length === 0) { this.finish(output); continue; }
      }
      const bytes = Math.min(this.pending.length - this.payloadUsed, chunk.length - offset);
      chunk.copy(this.payload, this.payloadUsed, offset, offset + bytes);
      this.payloadUsed += bytes;
      offset += bytes;
      if (this.payloadUsed === this.pending.length) this.finish(output);
    }
    return output;
  }
}

module.exports = { NativeFrameParser, HEADER_BYTES, RECORD_TYPE };
