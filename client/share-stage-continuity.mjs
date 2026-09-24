export function createShareStageContinuity({ video, hold, empty, topBar, delayMs = 700,
  schedule = setTimeout, cancel = clearTimeout }) {
  let showing = false, pendingEmpty = null, hasSnapshot = false, lastSnapshotAt = -Infinity;
  let resizing = false;
  const context = hold.getContext('2d', { alpha: false });

  function capture(time, force = false) {
    if (!context || video.readyState < 2 || !video.videoWidth || !video.videoHeight) return false;
    if (!force && time - lastSnapshotAt < 250) return false;
    const width = Math.min(960, video.videoWidth);
    const height = Math.max(1, Math.round(width * video.videoHeight / video.videoWidth));
    if (hold.width !== width || hold.height !== height) { hold.width = width; hold.height = height; }
    try {
      context.drawImage(video, 0, 0, width, height);
      hasSnapshot = true;
      lastSnapshotAt = time;
      return true;
    } catch {
      return false;
    }
  }

  function onFrame(time) {
    if (showing) {
      const drawn = capture(time, resizing);
      if (drawn || !resizing) {
        hold.hidden = true;
        resizing = false;
      }
    }
    video.requestVideoFrameCallback?.(onFrame);
  }
  video.requestVideoFrameCallback?.(onFrame);
  const holdPrevious = () => {
    if (showing && hasSnapshot) {
      hold.hidden = false;
      resizing = true;
    }
  };
  video.addEventListener('waiting', holdPrevious);
  video.addEventListener('resize', holdPrevious);
  if (!video.requestVideoFrameCallback) {
    video.addEventListener('timeupdate', () => {
      if (showing) {
        const drawn = capture(globalThis.performance.now(), resizing);
        if (drawn || !resizing) {
          hold.hidden = true;
          resizing = false;
        }
      }
    });
  }

  function reset(onEmpty) {
    onEmpty();
    video.hidden = true;
    hold.hidden = true;
    empty.hidden = false;
    if (topBar) topBar.hidden = true;
  }
  return {
    show() {
      showing = true;
      if (pendingEmpty != null) { cancel(pendingEmpty); pendingEmpty = null; }
      empty.hidden = true;
      video.hidden = false;
      if (hasSnapshot) hold.hidden = false;
      if (topBar) topBar.hidden = false;
    },
    requestEmpty(onEmpty) {
      showing = false;
      if (pendingEmpty != null) return;
      if (hasSnapshot) hold.hidden = false;
      pendingEmpty = schedule(() => {
        pendingEmpty = null;
        if (!showing) reset(onEmpty);
      }, delayMs);
    }
  };
}
