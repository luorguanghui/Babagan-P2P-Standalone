import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Buffer } from 'node:buffer';
import protocol from '../desktop/native-frame-protocol.cjs';

const { NativeFrameParser, HEADER_BYTES, RECORD_TYPE } = protocol;

function record({ type = RECORD_TYPE.frame, sequence = 1, width = 4, height = 2, timestampUs = 1000n, payload = Buffer.alloc(12) } = {}) {
  const header = Buffer.alloc(HEADER_BYTES);
  header.write('BGCF');
  header.writeUInt32LE(1, 4);
  header.writeUInt32LE(type, 8);
  header.writeUInt32LE(sequence, 12);
  header.writeUInt32LE(width, 16);
  header.writeUInt32LE(height, 20);
  header.writeBigUInt64LE(timestampUs, 24);
  header.writeUInt32LE(payload.length, 32);
  return Buffer.concat([header, payload]);
}

test('reassembles split I420 frames and reports source size and timestamp', () => {
  const parser = new NativeFrameParser();
  const frame = record();
  assert.deepEqual(parser.push(frame.subarray(0, 10)), []);
  assert.deepEqual(parser.push(frame.subarray(10, 38)), []);
  const result = parser.push(frame.subarray(38));
  assert.equal(result.length, 1);
  assert.deepEqual({ type: result[0].type, sequence: result[0].sequence, width: result[0].width, height: result[0].height, timestampUs: result[0].timestampUs },
    { type: 'frame', sequence: 1, width: 4, height: 2, timestampUs: 1000 });
  assert.equal(result[0].payload.length, 12);
});

test('rejects malformed and oversized records before allocating their body', () => {
  const badMagic = record(); badMagic.write('FAIL');
  assert.throws(() => new NativeFrameParser().push(badMagic), /magic/);
  const oversized = record(); oversized.writeUInt32LE(65 * 1024 * 1024, 32);
  assert.throws(() => new NativeFrameParser().push(oversized), /payload/);
  const wrongSize = record({ payload: Buffer.alloc(11) });
  assert.throws(() => new NativeFrameParser().push(wrongSize), /I420/);
  const longAudio = record({ type: RECORD_TYPE.audio, width: 48000, height: 2, payload: Buffer.alloc(192_004) });
  assert.throws(() => new NativeFrameParser().push(longAudio.subarray(0, HEADER_BYTES)), /audio/);
});

test('requires increasing frame sequence and timestamp across chunks', () => {
  const parser = new NativeFrameParser();
  parser.push(record({ sequence: 5, timestampUs: 5000n }));
  assert.throws(() => parser.push(record({ sequence: 4, timestampUs: 6000n })), /sequence/);
  const second = new NativeFrameParser();
  second.push(record({ sequence: 5, timestampUs: 5000n }));
  assert.throws(() => second.push(record({ sequence: 6, timestampUs: 4000n })), /timestamp/);
});

test('accepts a resize status followed by the new frame shape', () => {
  const parser = new NativeFrameParser();
  const resize = record({ type: RECORD_TYPE.resize, sequence: 1, width: 8, height: 4, payload: Buffer.alloc(0) });
  const frame = record({ sequence: 2, width: 8, height: 4, timestampUs: 2000n, payload: Buffer.alloc(48) });
  const output = parser.push(Buffer.concat([resize, frame]));
  assert.deepEqual(output.map(item => item.type), ['resize', 'frame']);
  assert.deepEqual(output.map(item => [item.width, item.height]), [[8, 4], [8, 4]]);
});

test('keeps audio and video timestamps on one clock without requiring callback arrival order', () => {
  const parser = new NativeFrameParser();
  const video = record({ sequence: 1, timestampUs: 2000n });
  const audio = record({ type: RECORD_TYPE.audio, sequence: 2, width: 48000, height: 2,
    timestampUs: 1000n, payload: Buffer.alloc(1920) });
  const result = parser.push(Buffer.concat([video, audio]));
  assert.deepEqual(result.map(item => [item.type, item.timestampUs]), [['frame', 2000], ['audio', 1000]]);
});
