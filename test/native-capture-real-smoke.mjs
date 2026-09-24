import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { NativeFrameParser } from '../desktop/native-frame-protocol.cjs';

const runtime = process.env.BABAGAN_NATIVE_RUNTIME || fileURLToPath(new URL('../native/runtime/', import.meta.url));
const helper = path.join(runtime, 'bin/64bit/babagan-capture.exe');
const parser = new NativeFrameParser();
const child = spawn(helper, ['--source', 'screen:0:0', '--fps', '60', '--height', '1080', '--seconds', '5'], {
  cwd: runtime, stdio: ['ignore', 'pipe', 'pipe']
});
let frames = 0, nonBlack = 0, lastTimestamp = -1, stderr = '';
child.stdout.on('data', bytes => {
  for (const record of parser.push(bytes)) {
    if (record.type !== 'frame') continue;
    assert.ok(record.timestampUs > lastTimestamp);
    lastTimestamp = record.timestampUs;
    frames++;
    if (frames % 30 === 0 && record.payload.some((value, index) => index < record.width * record.height && value > 18)) nonBlack++;
  }
});
child.stderr.on('data', bytes => { stderr += bytes.toString(); });
const exitCode = await new Promise((resolve, reject) => {
  child.on('error', reject);
  child.on('exit', resolve);
});
assert.equal(exitCode, 0, stderr);
assert.ok(frames >= 285, `captured ${frames} frames`);
assert.ok(nonBlack >= 8, `only ${nonBlack} non-black samples`);
console.log({ frames, nonBlack });
