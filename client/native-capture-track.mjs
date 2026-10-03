function browserFactory() {
  const generator = new globalThis.MediaStreamTrackGenerator({ kind: 'video' });
  const writer = generator.writable.getWriter();
  return {
    createTrack: () => generator,
    createFrame: record => new globalThis.VideoFrame(record.payload, {
      format: 'I420', codedWidth: record.width, codedHeight: record.height, timestamp: record.timestampUs,
      // Each IPC frame owns its buffer. Hand it to WebCodecs instead of copying
      // another 3 MiB at 1080p, or 12 MiB at 4K, on every captured frame.
      transfer: record.payload.buffer instanceof ArrayBuffer && record.payload.byteOffset === 0 &&
        record.payload.byteLength === record.payload.buffer.byteLength ? [record.payload.buffer] : [],
      colorSpace: { primaries: 'bt709', transfer: 'bt709', matrix: 'bt709', fullRange: false }
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
          record.payload = null;
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
      const resized = metrics.width !== record.width || metrics.height !== record.height;
      metrics.received += 1;
      metrics.width = record.width;
      metrics.height = record.height;
      metrics.lastTimestampUs = record.timestampUs;
      // A restarted helper reports its size in frames without an explicit
      // resize status. Notify after updating getSettings so SFU does not retain
      // the scale calculated against the old capture dimensions.
      if (resized) onStatus({ type: 'resized', width: record.width, height: record.height });
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
