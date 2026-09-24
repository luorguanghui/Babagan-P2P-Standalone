function browserAudioFactory() {
  const generator = new globalThis.MediaStreamTrackGenerator({ kind: 'audio' });
  const writer = generator.writable.getWriter();
  return {
    createTrack: () => generator,
    createAudio: record => new globalThis.AudioData({
      format: 's16', sampleRate: 48000, numberOfFrames: record.payload.length / 4,
      numberOfChannels: 2, timestamp: record.timestampUs, data: record.payload
    }),
    writeAudio: block => writer.write(block),
    close: () => writer.close().catch(() => {})
  };
}

export function createNativeAudioTrack({ maxQueuedBlocks = 8, factory = browserAudioFactory(), onError = () => {} } = {}) {
  const track = factory.createTrack();
  const queue = [];
  const metrics = { received: 0, written: 0, dropped: 0, queued: 0, lastTimestampUs: null };
  let active = true, draining = false, drainPromise = Promise.resolve();
  async function drain() {
    if (draining || !active) return drainPromise;
    draining = true;
    drainPromise = (async () => {
      try {
        while (active && queue.length) {
          const record = queue.shift();
          metrics.queued = queue.length;
          const block = factory.createAudio(record);
          try { await factory.writeAudio(block); metrics.written++; }
          finally { block.close(); }
        }
      } finally { draining = false; }
    })();
    return drainPromise;
  }
  return {
    track, metrics,
    push(record) {
      if (!active || record.type !== 'audio') return;
      metrics.received++;
      metrics.lastTimestampUs = record.timestampUs;
      while (queue.length >= maxQueuedBlocks) { queue.shift(); metrics.dropped++; }
      queue.push(record);
      metrics.queued = queue.length;
      void drain().catch(error => { onError(error); this.stop(); });
    },
    async flush() { await drainPromise; if (queue.length && active) await drain(); },
    stop() {
      if (!active) return;
      active = false;
      metrics.dropped += queue.length;
      queue.length = 0;
      metrics.queued = 0;
      track.stop();
      factory.close?.();
    }
  };
}
