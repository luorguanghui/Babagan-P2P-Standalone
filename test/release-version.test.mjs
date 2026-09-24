import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

test('release artifacts and Android manifest display version 1.13', () => {
  const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
  const manifest = readFileSync(new URL('../android/AndroidManifest.xml', import.meta.url), 'utf8');
  assert.equal(pkg.displayVersion, '1.13');
  assert.match(pkg.build.artifactName, /1\.13/);
  assert.match(manifest, /android:versionName="1\.13"/);
});
