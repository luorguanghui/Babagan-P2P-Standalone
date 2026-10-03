const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('babaganDesktop', {
  captureStarted: () => ipcRenderer.send('babagan:capture-started'),
  captureStopped: () => ipcRenderer.send('babagan:capture-stopped'),
  startNativeCapture: options => ipcRenderer.invoke('babagan:native-start', options),
  configureNativeCapture: options => ipcRenderer.invoke('babagan:native-configure', options),
  onPreviewVisibility: callback => {
    const listener = (_event, visible) => callback(visible);
    ipcRenderer.on('babagan:preview-visible', listener);
    return () => ipcRenderer.removeListener('babagan:preview-visible', listener);
  },
  stopNativeCapture: () => ipcRenderer.send('babagan:native-stop'),
  nativeReady: () => ipcRenderer.send('babagan:native-ready'),
  onNativeRecord: callback => {
    const listener = (_event, record) => callback(record);
    ipcRenderer.on('babagan:native-record', listener);
    return () => ipcRenderer.removeListener('babagan:native-record', listener);
  }
});
