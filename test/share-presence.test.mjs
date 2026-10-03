import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createSharePresence } from '../client/share-presence.mjs';

test('transient sharer disconnect keeps its share active through reconnect rosters', () => {
  let expire, cancelled = false;
  const presence = createSharePresence({ schedule: callback => { expire = callback; return 1; },
    cancel: () => { cancelled = true; }, onExpire: () => assert.fail('reconnected share expired') });
  assert.deepEqual(presence.update('host', [{ id: 'host' }]), { sharer: 'host', recovering: false });
  assert.deepEqual(presence.update(null, []), { sharer: 'host', recovering: true });
  assert.equal(typeof expire, 'function');
  assert.deepEqual(presence.update(null, [{ id: 'host' }]), { sharer: 'host', recovering: true },
    'the peer can rejoin before the share-start message is processed');
  assert.deepEqual(presence.update('host', [{ id: 'host' }]), { sharer: 'host', recovering: false });
  assert.equal(cancelled, true);
});

test('an explicit share stop clears immediately while the sharer stays connected', () => {
  const presence = createSharePresence();
  presence.update('host', [{ id: 'host' }]);
  assert.deepEqual(presence.update(null, [{ id: 'host' }]), { sharer: null, recovering: false });
});

test('a missing sharer expires after its reconnect grace period', () => {
  let expire, expiredId;
  const presence = createSharePresence({ schedule: callback => { expire = callback; return 1; },
    cancel: () => {}, onExpire: id => { expiredId = id; } });
  presence.update('host', [{ id: 'host' }]);
  presence.update(null, []);
  expire();
  assert.equal(expiredId, 'host');
  assert.deepEqual(presence.update(null, []), { sharer: null, recovering: false });
});
