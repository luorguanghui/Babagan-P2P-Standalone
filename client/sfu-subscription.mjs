export function createSfuSubscriptionManager({
  connect,
  onTrack = () => {},
  onSubscriber = () => {},
  onError = () => {},
  schedule = setTimeout,
  cancel = clearTimeout,
  retryDelaysMs = [2000, 4000, 8000, 15000]
}) {
  let desired = null, active = null, pending = false, retryTimer = null, generation = 0, failures = 0;
  const samePublication = (a, b) => a?.sessionId === b?.sessionId &&
    a?.videoTrackName === b?.videoTrackName && a?.audioTrackName === b?.audioTrackName;

  function stop() {
    ++generation;
    if (retryTimer != null) cancel(retryTimer);
    retryTimer = null;
    active?.stop();
    active = null;
    desired = null;
    pending = false;
    failures = 0;
    onSubscriber(null);
  }

  async function attempt() {
    if (!desired || pending || active) return;
    const current = generation;
    pending = true;
    try {
      const candidate = await connect({
        sfuInfo: desired,
        onTrack: (track, kind) => { if (current === generation) onTrack(track, kind); }
      });
      if (current !== generation) { candidate.stop(); return; }
      active = candidate;
      failures = 0;
      onSubscriber(candidate);
    } catch (error) {
      if (current !== generation) return;
      onSubscriber(null);
      onError(error);
      const delay = retryDelaysMs[Math.min(failures++, retryDelaysMs.length - 1)];
      retryTimer = schedule(() => {
        retryTimer = null;
        if (current === generation) void attempt();
      }, delay);
    } finally {
      if (current === generation) pending = false;
    }
  }

  return {
    update(sfuInfo) {
      if (!sfuInfo) { stop(); return; }
      if (!samePublication(desired, sfuInfo)) {
        stop();
        desired = { ...sfuInfo };
        void attempt();
      } else if (!pending && !active && retryTimer == null) {
        void attempt();
      }
    },
    stop,
    get pc() { return active?.pc || null; }
  };
}
