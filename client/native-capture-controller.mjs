import { createNativeVideoTrack } from './native-capture-track.mjs';
import { createNativeAudioTrack } from './native-audio-track.mjs';

export async function captureNativeScreen(desktop, options, {
  createTrack = createNativeVideoTrack,
  createAudioTrack = createNativeAudioTrack,
  Stream = globalThis.MediaStream,
  onStatus = () => {}
} = {}) {
  if (!desktop?.startNativeCapture || !desktop?.onNativeRecord) throw new Error('当前客户端不支持内置屏幕采集');
  const video = createTrack({ onStatus });
  const audio = options.audio ? createAudioTrack({ onError: error => {
    onStatus({ type: 'error', message: error.message }); stop();
  } }) : null;
  let active = true;
  const unsubscribe = desktop.onNativeRecord(record => {
    if (!active) return;
    if (record.type === 'audio') audio?.push(record);
    else video.push(record);
    if (record.type === 'frame') desktop.nativeReady();
    if (record.type === 'ended' || record.type === 'error') stop();
  });
  function stop() {
    if (!active) return;
    active = false;
    unsubscribe();
    video.stop();
    audio?.stop();
    desktop.stopNativeCapture();
  }
  try {
    const selection = await desktop.startNativeCapture(options);
    if (!selection) {
      const cause = new Error('已取消选择共享屏幕');
      cause.name = 'AbortError';
      throw cause;
    }
    return { stream: new Stream([video.track, ...(audio ? [audio.track] : [])]), selection,
      metrics: { video: video.metrics, audio: audio?.metrics }, stop,
      configure: preferences => active ? desktop.configureNativeCapture(preferences) : Promise.resolve() };
  } catch (error) { stop(); throw error; }
}
