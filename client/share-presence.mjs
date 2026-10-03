export function createSharePresence({ graceMs = 12000, schedule = setTimeout, cancel = clearTimeout,
  onExpire = () => {} } = {}) {
  let active = null, recovering = null, timer = null;

  function clearRecovery() {
    if (timer != null) cancel(timer);
    timer = null;
    recovering = null;
  }

  return {
    update(sharer, peers) {
      if (sharer) {
        clearRecovery();
        active = sharer;
        return { sharer: active, recovering: false };
      }
      if (active && (recovering === active || !peers.some(peer => peer.id === active))) {
        if (recovering !== active) {
          recovering = active;
          const lostId = active;
          timer = schedule(() => {
            if (recovering !== lostId) return;
            timer = null;
            recovering = null;
            active = null;
            onExpire(lostId);
          }, graceMs);
        }
        return { sharer: active, recovering: true };
      }
      clearRecovery();
      active = null;
      return { sharer: null, recovering: false };
    },
    stop() { clearRecovery(); active = null; }
  };
}
