const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('babaganDesktop', {
  captureStarted: () => ipcRenderer.send('babagan:capture-started'),
  captureStopped: () => ipcRenderer.send('babagan:capture-stopped'),
  startNativeCapture: options => ipcRenderer.invoke('babagan:native-start', options),
  stopNativeCapture: () => ipcRenderer.send('babagan:native-stop'),
  nativeReady: () => ipcRenderer.send('babagan:native-ready'),
  onNativeRecord: callback => {
    const listener = (_event, record) => callback(record);
    ipcRenderer.on('babagan:native-record', listener);
    return () => ipcRenderer.removeListener('babagan:native-record', listener);
  }
});
