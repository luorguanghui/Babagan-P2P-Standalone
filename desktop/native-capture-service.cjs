const { spawn } = require('node:child_process');
const { NativeFrameParser } = require('./native-frame-protocol.cjs');

const SOURCE_ID = /^screen:\d+:\d+$/;

class NativeCaptureService {
  constructor({ helperPath, spawnProcess = spawn, sendEvent }) {
    this.helperPath = helperPath;
    this.spawnProcess = spawnProcess;
    this.sendEvent = sendEvent;
    this.active = false;
    this.child = null;
    this.token = 0;
  }

  start(selection, { fps = 60, height = 1080, audio = false } = {}) {
    if (this.active) throw new Error('native capture already active');
    if (!selection || !SOURCE_ID.test(selection.id) || selection.kind !== 'screen' ||
        !selection.id.startsWith(`${selection.kind}:`)) throw new Error('invalid capture source');
    if (![15, 30, 45, 50, 60].includes(fps)) throw new Error('invalid capture frame rate');
    if (![720, 1080, 1440, 2160].includes(height)) throw new Error('invalid capture height');
    if (typeof audio !== 'boolean') throw new Error('invalid capture audio option');
    const token = ++this.token;
    this.active = true;
    this.restarts = 0;
    this.restartWindowAt = Date.now();
    this.spawnChild(selection, { fps, height, audio }, token);
  }

  spawnChild(selection, { fps, height, audio }, token) {
    const args = ['--source', selection.id, '--fps', String(fps), '--height', String(height), '--audio', audio ? '1' : '0'];
    if (audio) args.push('--exclude-pid', String(process.pid));
    const child = this.spawnProcess(this.helperPath, args, {
      cwd: require('node:path').resolve(this.helperPath, '../../..'),
      stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true
    });
    const parser = new NativeFrameParser();
    this.child = child;
    child.stdout.on('data', bytes => {
      if (!this.active || token !== this.token || this.child !== child) return;
      try { for (const record of parser.push(bytes)) this.sendEvent(record); }
      catch (error) { this.sendEvent({ type: 'error', message: error.message }); this.stop(); }
    });
    child.stderr.on('data', () => { /* binary protocol uses stdout; diagnostics stay local */ });
    child.on('error', error => {
      if (!this.active || token !== this.token || this.child !== child) return;
      this.sendEvent({ type: 'error', message: error.message });
      this.stop();
    });
    child.on('exit', code => {
      if (!this.active || token !== this.token || this.child !== child) return;
      if (code === 20) {
        if (Date.now() - this.restartWindowAt > 15_000) { this.restartWindowAt = Date.now(); this.restarts = 0; }
        if (++this.restarts <= 5) {
          this.spawnChild(selection, { fps, height, audio }, token);
          return;
        }
      }
      this.active = false;
      this.child = null;
      if (code !== 0) this.sendEvent({ type: 'error', message: `native capture helper exited (${code})` });
      else this.sendEvent({ type: 'ended' });
    });
  }

  stop() {
    ++this.token;
    if (!this.active) return;
    this.active = false;
    const child = this.child;
    this.child = null;
    if (child?.exitCode == null) child?.kill();
  }
}

module.exports = { NativeCaptureService };
