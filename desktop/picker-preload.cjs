const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('sourcePicker', {
  list: () => ipcRenderer.invoke('picker:list'),
  select: selection => ipcRenderer.send('picker:select', selection)
});
