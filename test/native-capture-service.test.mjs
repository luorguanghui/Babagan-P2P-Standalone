import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { Buffer } from 'node:buffer';
import { setImmediate } from 'node:timers';
import serviceModule from '../desktop/native-capture-service.cjs';

const { NativeCaptureService } = serviceModule;

function fakeChild() {
  const child = new EventEmitter();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.killCalls = 0;
  child.kill = () => { child.killCalls += 1; child.emit('exit', 0); };
  return child;
}

test('changing quality reconfigures the capture helper and ignores old helper events', () => {
  const children = [fakeChild(), fakeChild()];
  const starts = [], events = [];
  const service = new NativeCaptureService({ helperPath: 'C:/helper/obs-capture.exe',
    spawnProcess: (file, args) => { starts.push(args); return children[starts.length - 1]; },
    sendEvent: event => events.push(event) });
  service.start({ id: 'screen:0:0', kind: 'screen' }, { fps: 60, height: 2160, audio: true });
  assert.throws(() => service.configure({ fps: 999, height: 720 }), /frame rate/);
  assert.equal(children[0].killCalls, 0, 'invalid options must preserve active capture');
  service.configure({ fps: 30, height: 1080 });
  assert.equal(children[0].killCalls, 1);
  assert.equal(service.active, true);
  assert.deepEqual(starts[1].slice(0, 8), ['--source', 'screen:0:0', '--fps', '30', '--height', '1080', '--audio', '1']);
  assert.deepEqual(events, [], 'intentional restart must not end the shared track');
  service.configure({ fps: 30, height: 1080 });
  assert.equal(starts.length, 2, 'unchanged capture options must not restart');
  children[0].emit('error', new Error('late error'));
  assert.deepEqual(events, []);
  service.stop();
});

test('starts a single helper, validates source selection and forwards frame records', async () => {
  const child = fakeChild();
  let spawnArguments;
  const events = [];
  const service = new NativeCaptureService({
    helperPath: 'C:/helper/obs-capture.exe',
    spawnProcess: (file, args) => { spawnArguments = { file, args }; return child; },
    sendEvent: event => events.push(event)
  });
  assert.throws(() => service.start({ id: 'arbitrary:1', kind: 'screen' }, { fps: 60 }), /source/);
  service.start({ id: 'screen:1:0', kind: 'screen' }, { fps: 60 });
  assert.equal(spawnArguments.file, 'C:/helper/obs-capture.exe');
  assert.ok(spawnArguments.args.includes('screen:1:0'));
  assert.throws(() => service.start({ id: 'screen:1:0', kind: 'screen' }, { fps: 60 }), /already/);
  const header = Buffer.alloc(36);
  header.write('BGCF'); header.writeUInt32LE(1, 4); header.writeUInt32LE(1, 8);
  header.writeUInt32LE(1, 12); header.writeUInt32LE(4, 16); header.writeUInt32LE(2, 20);
  header.writeBigUInt64LE(1000n, 24); header.writeUInt32LE(12, 32);
  child.stdout.write(Buffer.concat([header, Buffer.alloc(12)]));
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(events[0].type, 'frame');
  assert.equal(events[0].width, 4);
  service.stop();
  assert.equal(child.killCalls, 1);
});

test('helper exit reports failure and a cancelled capture cannot publish late frames', async () => {
  const child = fakeChild();
  const events = [];
  const service = new NativeCaptureService({ helperPath: 'C:/helper/obs-capture.exe', spawnProcess: () => child, sendEvent: event => events.push(event) });
  service.start({ id: 'screen:0:0', kind: 'screen' }, { fps: 30 });
  child.emit('exit', 3);
  assert.deepEqual(events.at(-1), { type: 'error', message: 'native capture helper exited (3)' });
  assert.equal(service.active, false);
});

test('display mode change restarts helper without ending the shared track', () => {
  const children = [fakeChild(), fakeChild()];
  const events = [];
  let starts = 0;
  const service = new NativeCaptureService({ helperPath: 'C:/helper/obs-capture.exe',
    spawnProcess: () => children[starts++], sendEvent: event => events.push(event) });
  service.start({ id: 'screen:0:0', kind: 'screen' }, { fps: 60 });
  children[0].emit('exit', 20);
  assert.equal(starts, 2);
  assert.equal(service.active, true);
  const late = Buffer.alloc(48);
  late.write('BGCF'); late.writeUInt32LE(1, 4); late.writeUInt32LE(1, 8);
  late.writeUInt32LE(1, 12); late.writeUInt32LE(4, 16); late.writeUInt32LE(2, 20);
  late.writeBigUInt64LE(1000n, 24); late.writeUInt32LE(12, 32);
  children[0].stdout.write(late);
  assert.deepEqual(events, []);
  service.stop();
  assert.equal(children[1].killCalls, 1);
});

test('supports 45 and 50 fps tiers and passes exclude-pid when audio is enabled', () => {
  const child = fakeChild();
  let spawnArgs;
  const service = new NativeCaptureService({
    helperPath: 'C:/helper/obs-capture.exe',
    spawnProcess: (file, args) => { spawnArgs = args; return child; },
    sendEvent: () => {}
  });

  service.start({ id: 'screen:0:0', kind: 'screen' }, { fps: 45, audio: true });
  assert.ok(spawnArgs.includes('45'));
  assert.ok(spawnArgs.includes('--exclude-pid'));
  assert.ok(spawnArgs.includes(String(process.pid)));
  service.stop();

  const child2 = fakeChild();
  let spawnArgs2;
  const service2 = new NativeCaptureService({
    helperPath: 'C:/helper/obs-capture.exe',
    spawnProcess: (file, args) => { spawnArgs2 = args; return child2; },
    sendEvent: () => {}
  });
  service2.start({ id: 'screen:0:0', kind: 'screen' }, { fps: 50, audio: false });
  assert.ok(spawnArgs2.includes('50'));
  assert.ok(!spawnArgs2.includes('--exclude-pid'));
  service2.stop();
});
