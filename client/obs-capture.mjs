export function findObsVirtualCamera(devices) {
  return devices.find(device => device.kind === 'videoinput' && /^OBS Virtual Camera$/i.test(device.label?.trim() || ''));
}

export async function captureObsVirtualCamera(mediaDevices, frameRate) {
  const camera = findObsVirtualCamera(await mediaDevices.enumerateDevices());
  if (!camera?.deviceId) throw new Error('未找到 OBS 虚拟摄像头。请在 OBS 点击“启动虚拟摄像头”，然后重试。');
  try {
    const stream = await mediaDevices.getUserMedia({
      video: { deviceId: { exact: camera.deviceId }, frameRate: { ideal: frameRate } },
      audio: false
    });
    if (stream.getVideoTracks()[0]?.readyState === 'live') return stream;
    stream.getTracks().forEach(track => track.stop());
    throw new Error('OBS 虚拟摄像头没有输出实时画面');
  } catch (cause) {
    throw new Error('OBS 虚拟摄像头访问失败。请确认 OBS 已启动虚拟摄像头，且 Windows 允许此应用使用摄像头。', { cause });
  }
}
