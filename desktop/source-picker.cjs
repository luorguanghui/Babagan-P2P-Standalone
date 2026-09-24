const { BrowserWindow, desktopCapturer, ipcMain } = require('electron');
const path = require('node:path');
let active = false;
function chooseSource(parent, audioAllowed, { types = ['screen', 'window'] } = {}) {
  if (active || parent.isDestroyed()) return Promise.resolve(null);
  active = true;
  return new Promise(resolve => {
    let sources = [], done = false;
    const picker = new BrowserWindow({ parent, modal: true, show: false, width: 900, height: 680, minWidth: 600, minHeight: 460, title: '选择共享内容', autoHideMenuBar: true, backgroundColor: '#0e151a', webPreferences: { preload: path.join(__dirname, 'picker-preload.cjs'), sandbox: true, contextIsolation: true, nodeIntegration: false } });
    const authorized = event => !picker.isDestroyed() && event.sender === picker.webContents && event.senderFrame === picker.webContents.mainFrame;
    const finish = result => {
      if (done) return;
      done = true; active = false;
      ipcMain.removeHandler('picker:list'); ipcMain.removeAllListeners('picker:select');
      if (!picker.isDestroyed()) picker.close();
      resolve(result);
    };
    ipcMain.handle('picker:list', async event => {
      if (!authorized(event)) throw new Error('Forbidden');
      sources = await desktopCapturer.getSources({ types, thumbnailSize: { width: 400, height: 225 }, fetchWindowIcons: true });
      return { audioAllowed: Boolean(audioAllowed), sources: sources.filter(s => s.name !== '选择共享内容').map(s => ({ id: s.id, name: s.name, kind: s.id.startsWith('screen:') ? 'screen' : 'window', thumbnail: s.thumbnail.isEmpty() ? null : s.thumbnail.toDataURL(), icon: s.appIcon && !s.appIcon.isEmpty() ? s.appIcon.toDataURL() : null })) };
    });
    ipcMain.on('picker:select', (event, selection) => {
      if (!authorized(event)) return;
      const source = selection && sources.find(s => s.id === selection.id);
      finish(source ? { source, audio: Boolean(audioAllowed && selection.audio) } : null);
    });
    picker.on('closed', () => finish(null));
    picker.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    picker.webContents.on('will-navigate', event => event.preventDefault());
    picker.once('ready-to-show', () => picker.show());
    picker.loadFile(path.join(__dirname, 'picker.html')).catch(() => finish(null));
  });
}
module.exports = { chooseSource };
