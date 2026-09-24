import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { NativeFrameParser } from '../desktop/native-frame-protocol.cjs';

const runtime = fileURLToPath(new URL('../native/runtime/', import.meta.url));
const child = spawn(path.join(runtime, 'bin/64bit/babagan-capture.exe'),
  ['--source', 'screen:0:0', '--fps', '60', '--height', '1080', '--seconds', '5', '--audio', '1'],
  { cwd: runtime, stdio: ['ignore', 'pipe', 'pipe'] });
const parser = new NativeFrameParser();
let video = 0, audio = 0, firstVideo = null, firstAudio = null, lastVideo = null, lastAudio = null, stderr = '';
child.stdout.on('data', chunk => {
  for (const record of parser.push(chunk)) {
    if (record.type === 'frame') { video++; firstVideo ??= record.timestampUs; lastVideo = record.timestampUs; }
    if (record.type === 'audio') { audio++; firstAudio ??= record.timestampUs; lastAudio = record.timestampUs; }
  }
});
child.stderr.on('data', chunk => { stderr += chunk.toString(); });
const exit = await new Promise((resolve, reject) => { child.on('error', reject); child.on('exit', resolve); });
assert.equal(exit, 0, stderr);
assert.ok(video >= 285, `video records: ${video}`);
assert.ok(audio >= 100, `audio records: ${audio}`);
assert.ok(Math.abs((lastVideo - firstVideo) - (lastAudio - firstAudio)) < 250_000, 'audio/video clocks diverged');
console.log({ video, audio, firstVideo, firstAudio, lastVideo, lastAudio });
