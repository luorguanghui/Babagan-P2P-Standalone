import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createSfuSubscriptionManager } from '../client/sfu-subscription.mjs';

const publication = { sessionId: 'publisher', videoTrackName: 'video' };
const flush = () => new Promise(resolve => setImmediate(resolve));

test('SFU subscription retries a failed video pull without waiting for another roster message', async () => {
  let attempts = 0;
  const scheduled = [];
  const subscriberStates = [];
  const pc = { id: 'receiving-connection' };
  const manager = createSfuSubscriptionManager({
    connect: async () => {
      if (++attempts === 1) throw new Error('empty_track_error');
      return { pc, stop() {} };
    },
    schedule: (callback, delay) => { scheduled.push({ callback, delay }); return scheduled.length; },
    cancel: () => {},
    onSubscriber: subscriber => subscriberStates.push(subscriber),
    onError: () => {}
  });

  manager.update(publication);
  await flush();
  assert.equal(attempts, 1);
  assert.equal(scheduled.length, 1);
  assert.equal(scheduled[0].delay, 2000);
  assert.equal(subscriberStates.length, 2, 'a failed connection clears any track attached before the retry');

  scheduled[0].callback();
  await flush();
  assert.equal(attempts, 2);
  assert.equal(manager.pc, pc);
  manager.stop();
});

test('SFU subscription deduplicates roster updates and closes a late connection after stop', async () => {
  let attempts = 0, resolveConnect, stopped = 0;
  const tracks = [];
  const manager = createSfuSubscriptionManager({
    connect: ({ onTrack }) => { attempts++; tracks.push(onTrack); return new Promise(resolve => { resolveConnect = resolve; }); },
    onTrack: track => tracks.push(track),
    onError: () => {}
  });

  manager.update(publication);
  manager.update({ ...publication });
  assert.equal(attempts, 1);
  manager.stop();
  tracks[0]({ kind: 'video' }, 'video');
  resolveConnect({ pc: {}, stop() { stopped++; } });
  await flush();
  assert.equal(stopped, 1);
  assert.equal(manager.pc, null);
  assert.equal(tracks.length, 1, 'late video tracks are ignored after stop');
});
