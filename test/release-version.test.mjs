import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

test('release artifacts and Android manifest display version 1.19', () => {
  const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
  const lock = JSON.parse(readFileSync(new URL('../package-lock.json', import.meta.url), 'utf8'));
  const manifest = readFileSync(new URL('../android/AndroidManifest.xml', import.meta.url), 'utf8');
  assert.equal(pkg.version, '1.0.19');
  assert.equal(pkg.displayVersion, '1.19');
  assert.equal(lock.version, pkg.version);
  assert.equal(lock.packages[''].version, pkg.version);
  assert.match(pkg.build.artifactName, /1\.19/);
  assert.match(manifest, /android:versionCode="22"/);
  assert.match(manifest, /android:versionName="1\.19"/);
});
