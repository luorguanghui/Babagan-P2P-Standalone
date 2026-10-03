export function createShareStageContinuity({ video, hold, empty, topBar, delayMs = 700,
  schedule = setTimeout, cancel = clearTimeout }) {
  let showing = false, pendingEmpty = null, hasSnapshot = false;
  let resizing = false, frameRequest = null, suspended = false;
  const context = hold.getContext('2d', { alpha: false });

  function capture() {
    if (!context || video.readyState < 2 || !video.videoWidth || !video.videoHeight) return false;
    const width = Math.min(960, video.videoWidth);
    const height = Math.max(1, Math.round(width * video.videoHeight / video.videoWidth));
    if (hold.width !== width || hold.height !== height) { hold.width = width; hold.height = height; }
    try {
      context.drawImage(video, 0, 0, width, height);
      hasSnapshot = true;
      return true;
    } catch {
      return false;
    }
  }

  function requestFrame() {
    if (showing && !suspended && frameRequest == null) frameRequest = video.requestVideoFrameCallback?.(onFrame) ?? null;
  }
  function stopFrame() {
    if (frameRequest != null) video.cancelVideoFrameCallback?.(frameRequest);
    frameRequest = null;
  }
  function onFrame() {
    frameRequest = null;
    if (showing && !suspended && !video.paused) {
      // Snapshot only at startup or a transition. Periodic drawImage() forces
      // video texture copies and prevents cheap compositor-only playback.
      const drawn = (!hasSnapshot || resizing) ? capture() : false;
      if (drawn || !resizing) {
        hold.hidden = true;
        resizing = false;
      }
      if (resizing || !hasSnapshot) requestFrame();
    }
  }
  const holdPrevious = () => {
    if (showing && !suspended) {
      // waiting/emptied may have already removed the drawable frame. In that
      // case the startup snapshot can be seconds old (and bright white).
      // Leave the browser's last frame alone instead of flashing that snapshot.
      // An already prepared transition must also survive resize placeholders.
      if (!resizing && !capture()) return;
      if (!hasSnapshot) return;
      hold.hidden = false;
      resizing = true;
      requestFrame();
    }
  };
  video.addEventListener('waiting', holdPrevious);
  video.addEventListener('resize', holdPrevious);
  video.addEventListener('pause', holdPrevious);
  video.addEventListener('emptied', holdPrevious);
  video.addEventListener('playing', requestFrame);
  if (!video.requestVideoFrameCallback) {
    video.addEventListener('timeupdate', () => {
      if (showing && !suspended && !video.paused) {
        const drawn = (!hasSnapshot || resizing) ? capture() : false;
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
    hasSnapshot = false;
    resizing = false;
  }
  return {
    hold: holdPrevious,
    setSuspended(value) {
      suspended = Boolean(value);
      if (suspended) { stopFrame(); hold.hidden = true; }
      else requestFrame();
    },
    show() {
      const resuming = !showing;
      showing = true;
      if (pendingEmpty != null) { cancel(pendingEmpty); pendingEmpty = null; }
      empty.hidden = true;
      video.hidden = false;
      if (resuming && hasSnapshot && !suspended) { hold.hidden = false; resizing = true; }
      if (topBar) topBar.hidden = false;
      requestFrame();
    },
    requestEmpty(onEmpty) {
      // Capture once before the caller detaches the old stream.
      if (showing && !suspended && !resizing && !capture()) hasSnapshot = false;
      showing = false;
      stopFrame();
      if (pendingEmpty != null) return;
      if (hasSnapshot) hold.hidden = false;
      pendingEmpty = schedule(() => {
        pendingEmpty = null;
        if (!showing) reset(onEmpty);
      }, delayMs);
    }
  };
}
