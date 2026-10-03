const { app, BrowserWindow, protocol, net, session, powerSaveBlocker, ipcMain } = require('electron');
const { chooseSource } = require('./source-picker.cjs');
const { NativeCaptureService } = require('./native-capture-service.cjs');
const { NativeFrameGate } = require('./native-frame-gate.cjs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

// Disable Chromium backgrounding, occlusion calculation, and timer throttling to prevent frame drops when backgrounded/minimized.
app.commandLine.appendSwitch('disable-renderer-backgrounding');
app.commandLine.appendSwitch('disable-background-timer-throttling');
app.commandLine.appendSwitch('disable-backgrounding-occluded-windows');
app.commandLine.appendSwitch('disable-features', 'CalculateNativeWinOcclusion');
// Enable hardware accelerated video encoding for smooth 60fps WebRTC streaming
app.commandLine.appendSwitch('enable-accelerated-video-encode');
app.commandLine.appendSwitch('enable-features', 'VaapiVideoEncoder,PlatformHEVCDecoderSupport');
app.commandLine.appendSwitch('ignore-gpu-blocklist');

// A secure custom scheme serves packaged resources without a local HTTP server.
protocol.registerSchemesAsPrivileged([{ scheme: 'babagan', privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true, stream: true } }]);
const local = url => typeof url === 'string' && url.startsWith('babagan://app/');

let blockerId = null;
const startSuspensionBlocker = () => {
  if (blockerId == null || !powerSaveBlocker.isStarted(blockerId)) {
    blockerId = powerSaveBlocker.start('prevent-app-suspension');
  }
};
const stopSuspensionBlocker = () => {
  if (blockerId != null && powerSaveBlocker.isStarted(blockerId)) {
    powerSaveBlocker.stop(blockerId);
    blockerId = null;
  }
};

app.whenReady().then(async () => {
  protocol.handle('babagan', request => {
    const url = new URL(request.url);
    if (url.hostname !== 'app') return new Response('Forbidden', { status: 403 });
    const filename = path.basename(decodeURIComponent(url.pathname)) || 'index.html';
    if (!/^[a-zA-Z0-9._-]+$/.test(filename)) return new Response('Not found', { status: 404 });
    return net.fetch(pathToFileURL(path.join(__dirname, '../www', filename)).href);
  });
  const win = new BrowserWindow({
    show: process.env.BABAGAN_SMOKE !== '1',
    width: 1260,
    height: 860,
    minWidth: 380,
    minHeight: 580,
    backgroundColor: '#0e151a',
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
      backgroundThrottling: false,
      additionalArguments: ['--disable-features=CalculateNativeWinOcclusion']
    }
  });
  win.webContents.setBackgroundThrottling(false);
  win.webContents.setFrameRate(60);
  // Keep capture timers running, but stop the muted preview when another app
  // (for example a game) owns the foreground. backgroundThrottling:false makes
  // document.hidden unreliable, so report native window visibility explicitly.
  const updatePreviewVisibility = () => {
    if (!win.isDestroyed()) win.webContents.send('babagan:preview-visible',
      win.isVisible() && !win.isMinimized() && win.isFocused());
  };
  for (const name of ['focus', 'blur', 'minimize', 'restore', 'show', 'hide']) win.on(name, updatePreviewVisibility);
  win.webContents.on('did-finish-load', updatePreviewVisibility);
  const runtime = app.isPackaged ? path.join(process.resourcesPath, 'native-capture') : path.join(__dirname, '../native/runtime');
  const nativeHelper = path.join(runtime, 'bin/64bit/babagan-capture.exe');
  let nativeService = null, nativeGate = null, nativeEpoch = 0, nativeStarting = false;
  const authorizedNative = event => event.sender === win.webContents &&
    event.senderFrame === win.webContents.mainFrame && local(win.webContents.getURL());
  const stopNative = () => {
    ++nativeEpoch;
    nativeService?.stop(); nativeService = null;
    nativeGate?.stop(); nativeGate = null;
  };
  ipcMain.handle('babagan:native-start', async (event, options) => {
    if (!authorizedNative(event)) throw new Error('Forbidden');
    if (nativeService?.active || nativeStarting) throw new Error('采集已启动');
    nativeStarting = true;
    const epoch = ++nativeEpoch;
    try {
      const choice = await chooseSource(win, false, { types: ['screen'] });
      if (!choice || epoch !== nativeEpoch || win.isDestroyed()) return null;
      nativeGate = new NativeFrameGate(record => {
        if (!win.isDestroyed() && epoch === nativeEpoch) win.webContents.send('babagan:native-record', record);
      }, { maxInFlight: 2 });
      nativeService = new NativeCaptureService({ helperPath: nativeHelper, sendEvent: record => nativeGate?.push(record) });
      nativeService.start({ id: choice.source.id, kind: 'screen' }, options);
      return { sourceId: choice.source.id, sourceName: choice.source.name };
    } finally { nativeStarting = false; }
  });
  ipcMain.on('babagan:native-ready', event => { if (authorizedNative(event)) nativeGate?.ready(); });
  ipcMain.handle('babagan:native-configure', (event, options) => {
    if (!authorizedNative(event)) throw new Error('Forbidden');
    nativeService?.configure(options);
  });
  ipcMain.on('babagan:native-stop', event => { if (authorizedNative(event)) stopNative(); });
  ipcMain.on('babagan:capture-started', event => { if (authorizedNative(event)) startSuspensionBlocker(); });
  ipcMain.on('babagan:capture-stopped', event => { if (authorizedNative(event)) stopSuspensionBlocker(); });
  win.webContents.on('ipc-message', (event, channel) => {
    if (event.senderFrame !== win.webContents.mainFrame) return;
    if (channel === 'babagan:capture-started') startSuspensionBlocker();
    if (channel === 'babagan:capture-stopped') stopSuspensionBlocker();
  });
  win.webContents.on('did-start-navigation', () => { stopSuspensionBlocker(); stopNative(); });
  win.webContents.on('enter-html-full-screen', () => win.setFullScreen(true));
  win.webContents.on('leave-html-full-screen', () => win.setFullScreen(false));

  session.defaultSession.setPermissionCheckHandler((_wc, permission, origin) => local(origin + '/') && ['media', 'display-capture', 'clipboard-sanitized-write', 'fullscreen'].includes(permission));
  session.defaultSession.setPermissionRequestHandler((wc, permission, callback, details) => callback(local(wc.getURL()) && ['media', 'display-capture', 'clipboard-sanitized-write', 'fullscreen'].includes(permission) && (permission !== 'media' || details.isMainFrame !== false)));
  session.defaultSession.setDisplayMediaRequestHandler(async (request, callback) => {
    let responded = false;
    const respond = result => {
      if (responded) return;
      responded = true;
      try {
        if (result && result.video) callback(result);
        else callback();
      } catch {
        try { callback(); } catch { /* request was already cancelled */ }
      }
    };
    if (!local(request.securityOrigin + '/')) { respond(null); return; }
    try {
      const selection = await chooseSource(win, request.audioRequested);
      if (!selection || win.isDestroyed()) { respond(null); return; }
      respond({ video: selection.source, ...(selection.audio ? { audio: 'loopback' } : {}) });
    } catch { respond(null); }
  });
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  win.webContents.on('will-navigate', (event, url) => { if (!local(url)) event.preventDefault(); });
  win.on('closed', () => { stopSuspensionBlocker(); stopNative(); ipcMain.removeHandler('babagan:native-start'); ipcMain.removeHandler('babagan:native-configure'); });
  await win.loadURL('babagan://app/index.html');
});
app.on('window-all-closed', () => {
  stopSuspensionBlocker();
  app.quit();
});
