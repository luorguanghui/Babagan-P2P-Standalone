export function reconcileSharePlayback(element, videoTrack, systemAudioTrack, local, Stream = MediaStream) {
  const desired = [videoTrack, ...(local || !systemAudioTrack ? [] : [systemAudioTrack])];
  const current = element.srcObject?.getTracks() || [];
  if (current.length !== desired.length || current.some((track, index) => track !== desired[index])) {
    element.srcObject = new Stream(desired);
  }
  element.muted = Boolean(local);
}
