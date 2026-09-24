import { test } from 'node:test';
import assert from 'node:assert/strict';
import gateModule from '../desktop/native-frame-gate.cjs';

const { NativeFrameGate } = gateModule;

test('slow renderer receives the newest frame and queue remains bounded', () => {
  const sent = [];
  const gate = new NativeFrameGate(record => sent.push(record));
  gate.push({ type: 'frame', sequence: 1 });
  gate.push({ type: 'frame', sequence: 2 });
  gate.push({ type: 'frame', sequence: 3 });
  assert.deepEqual(sent.map(record => record.sequence), [1]);
  assert.equal(gate.dropped, 1);
  gate.ready();
  assert.deepEqual(sent.map(record => record.sequence), [1, 3]);
  gate.stop();
  gate.ready();
  assert.equal(sent.length, 2);
});
