export function createStatus(element, schedule = setTimeout, cancel = clearTimeout) {
  let timer;
  let revision = 0;
  return (message, duration = 0) => {
    ++revision;
    if (timer != null) cancel(timer);
    element.textContent = message;
    if (message && duration > 0) {
      const current = revision;
      timer = schedule(() => {
        if (revision === current) element.textContent = '';
        timer = null;
      }, duration);
    } else timer = null;
  };
}
