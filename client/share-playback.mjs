export function reconcileSharePlayback(element, videoTrack, systemAudioTrack, local, Stream = MediaStream, beforeChange = () => {}) {
  const desired = [videoTrack, ...(local || !systemAudioTrack ? [] : [systemAudioTrack])];
  const current = element.srcObject?.getTracks() || [];
  if (current.includes(videoTrack)) {
    // Audio can arrive after video or be replaced on reconnection. Changing
    // srcObject resets the video pipeline too, exposing a playback placeholder.
    for (const track of current) if (!desired.includes(track)) element.srcObject.removeTrack(track);
    for (const track of desired) if (!current.includes(track)) element.srcObject.addTrack(track);
    element.muted = Boolean(local);
    return false;
  }
  const changed = current.length !== desired.length || current.some((track, index) => track !== desired[index]);
  if (changed) {
    beforeChange();
    element.srcObject = new Stream(desired);
  }
  element.muted = Boolean(local);
  return changed;
}

// Pausing the muted local sink stops texture conversion/compositing; its source
// track continues to feed WebRTC. Remote playback also carries meeting audio.
export function setSharePreviewVisibility(element, local, visible) {
  if (local && !visible) {
    element.pause();
    element.hidden = true;
    return false;
  }
  element.hidden = false;
  return true;
}
