// Opt-in package check. Set BABAGAN_EXE to an unpacked Windows executable.
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
const require = createRequire(import.meta.url);
const { _electron } = require('@playwright/test');
const packaged = process.env.BABAGAN_EXE;
const executablePath = packaged || require('electron');
const projectRoot = fileURLToPath(new URL('../', import.meta.url));
const env = { ...process.env, BABAGAN_SMOKE: '1' };
delete env.ELECTRON_RUN_AS_NODE;
const app = await _electron.launch({ executablePath, args: packaged ? [] : [projectRoot], env });
try {
  const page = await app.firstWindow();
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  const state = await page.evaluate(() => ({
    secure: isSecureContext,
    hasRoomCap: Boolean(document.querySelector('#upload-ceiling')),
    quality1080: document.querySelector('#quality option[value="1080"]')?.textContent,
    nativeCapture: typeof window.babaganDesktop?.startNativeCapture
  }));
  assert.equal(state.secure, true);
  assert.equal(state.hasRoomCap, false);
  assert.match(state.quality1080, /15 Mbps/);
  assert.equal(state.nativeCapture, 'function');
  assert.deepEqual(errors, []);
  console.log('Packaged desktop startup and standalone UI: PASS');
} finally { await app.close(); }
