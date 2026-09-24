import { build, Platform } from 'electron-builder';
import { mkdir, copyFile, access } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { tmpdir } from 'node:os';
import './prepare.mjs';
const projectDir = fileURLToPath(new URL('../', import.meta.url));
const electronRoot = path.join(projectDir, 'node_modules/electron');
try { await access(path.join(electronRoot, 'dist/electron.exe')); }
catch {
  execFileSync(process.execPath, [path.join(electronRoot, 'install.js')], { cwd: projectDir, stdio: 'inherit' });
  await access(path.join(electronRoot, 'dist/electron.exe'));
}
// Keep native resource editors out of paths with non-ASCII characters.
// Each run has a fresh staging directory so scanners cannot lock prior artifacts.
const staging = path.join(tmpdir(), `babagan-windows-${Date.now()}`);
const artifacts = await build({ targets: Platform.WINDOWS.createTarget(['portable'], 1), projectDir, config: { directories: { output: staging } } });
const output = fileURLToPath(new URL('../releases/', import.meta.url));
await mkdir(output, { recursive: true });
for (const artifact of artifacts) if (artifact.endsWith('.exe')) {
  const target = path.join(output, path.basename(artifact)); await copyFile(artifact, target); console.log(`Built: ${target}`);
}
console.log(`Unpacked executable for verification: ${path.join(staging, 'win-unpacked', 'Babagan P2P.exe')}`);
