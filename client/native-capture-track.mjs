function browserFactory() {
  const generator = new globalThis.MediaStreamTrackGenerator({ kind: 'video' });
  const writer = generator.writable.getWriter();
  return {
    createTrack: () => generator,
    createFrame: record => new globalThis.VideoFrame(record.payload, {
      format: 'I420', codedWidth: record.width, codedHeight: record.height, timestamp: record.timestampUs
    }),
    writeFrame: frame => writer.write(frame),
    close: () => writer.close().catch(() => {})
  };
}

export function createNativeVideoTrack({ maxQueuedFrames = 4, factory = browserFactory(), onStatus = () => {} } = {}) {
  const track = factory.createTrack();
  const queue = [];
  const metrics = { received: 0, written: 0, dropped: 0, queued: 0, width: null, height: null, lastTimestampUs: null };
  const originalGetSettings = typeof track.getSettings === 'function' ? track.getSettings.bind(track) : () => ({});
  track.getSettings = () => ({
    ...originalGetSettings(),
    width: metrics.width ?? undefined,
    height: metrics.height ?? undefined
  });
  let active = true, draining = false, drainPromise = Promise.resolve();

  function discard(record) {
    metrics.dropped += 1;
    record.payload = null;
  }

  async function drain() {
    if (draining || !active) return drainPromise;
    draining = true;
    drainPromise = (async () => {
      try {
        while (active && queue.length) {
          const record = queue.shift();
          metrics.queued = queue.length;
          const frame = factory.createFrame(record);
          try {
            await factory.writeFrame(frame);
            metrics.written += 1;
          } finally { frame.close(); }
        }
      } finally { draining = false; }
    })();
    return drainPromise;
  }

  return {
    track,
    metrics,
    push(record) {
      if (!active) return;
      if (record.type === 'resize') {
        metrics.width = record.width; metrics.height = record.height;
        onStatus({ type: 'resized', width: record.width, height: record.height });
        return;
      }
      if (record.type === 'ended' || record.type === 'error') {
        onStatus(record);
        this.stop();
        return;
      }
      if (record.type !== 'frame') return;
      metrics.received += 1;
      metrics.width = record.width;
      metrics.height = record.height;
      metrics.lastTimestampUs = record.timestampUs;
      while (queue.length >= maxQueuedFrames) discard(queue.shift());
      queue.push(record);
      metrics.queued = queue.length;
      void drain().catch(error => {
        onStatus({ type: 'error', message: error.message });
        this.stop();
      });
    },
    async flush() { await drainPromise; if (queue.length && active) await drain(); },
    stop() {
      if (!active) return;
      active = false;
      for (const record of queue.splice(0)) discard(record);
      metrics.queued = 0;
      track.stop();
      factory.close?.();
    }
  };
}
