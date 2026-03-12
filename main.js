const { app, BrowserWindow, BrowserView, ipcMain, Menu, dialog } = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');

app.commandLine.appendSwitch('enable-accelerated-2d-canvas');
app.commandLine.appendSwitch('enable-gpu-rasterization');
app.commandLine.appendSwitch('enable-zero-copy');
app.commandLine.appendSwitch('disable-software-rasterizer');

const PEEK = 10;

let mainWindow;
let uiView;
const webViews = new Map();
let tabIdCounter = 0;

function getWH() { return mainWindow.getContentSize(); }

function layoutWebView(view) {
  const [w, h] = getWH();
  view.setBounds({ x: PEEK, y: 0, width: w - PEEK, height: h });
}

function layoutUI() {
  const [w, h] = getWH();
  uiView.setBounds({ x: 0, y: 0, width: PEEK, height: h });
}

function layoutUIExpanded() {
  const [w, h] = getWH();
  uiView.setBounds({ x: 0, y: 0, width: w, height: h });
}

function bringUIToFront() {
  try { mainWindow.setTopBrowserView(uiView); } catch(e) {}
}

// ── 自動アップデート ──
function setupAutoUpdater() {
  try {
    const { autoUpdater } = require('electron-updater');
    autoUpdater.autoDownload = true;
    autoUpdater.autoInstallOnAppQuit = true;

    autoUpdater.on('update-available', (info) => {
      if (uiView && !uiView.webContents.isDestroyed()) {
        uiView.webContents.send('update:available', { version: info.version });
      }
    });

    autoUpdater.on('update-downloaded', (info) => {
      if (uiView && !uiView.webContents.isDestroyed()) {
        uiView.webContents.send('update:downloaded', { version: info.version });
      }
    });

    autoUpdater.on('error', (err) => {
      console.log('AutoUpdater error:', err.message);
    });

    // 起動後30秒後にチェック開始（起動を邪魔しない）
    setTimeout(() => {
      autoUpdater.checkForUpdatesAndNotify().catch(e => console.log('Update check failed:', e.message));
    }, 30000);

    ipcMain.on('update:install', () => {
      autoUpdater.quitAndInstall();
    });
  } catch(e) {
    console.log('AutoUpdater not available in dev mode:', e.message);
  }
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1440, height: 920, minWidth: 800, minHeight: 600,
    titleBarStyle: 'hidden',
    trafficLightPosition: { x: 16, y: 16 },
    backgroundColor: '#f0f1f8',
    title: 'Spiral',
    icon: path.join(__dirname, 'assets/icon.png'),
    webPreferences: { nodeIntegration: false },
  });

  uiView = new BrowserView({
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      backgroundThrottling: false,
    }
  });

  mainWindow.addBrowserView(uiView);
  layoutUI();
  uiView.webContents.loadFile('src/index.html');
  Menu.setApplicationMenu(null);

  mainWindow.on('resize', () => {
    const [w, h] = getWH();
    const b = uiView.getBounds();
    uiView.setBounds({ x: 0, y: 0, width: b.width > PEEK ? w : PEEK, height: h });
    for (const [, v] of webViews) if (v._active) layoutWebView(v);
    bringUIToFront();
  });

  uiView.webContents.once('did-finish-load', () => {
    uiView.webContents.send('app:ready');
  });

  setupAutoUpdater();
}

ipcMain.on('sb:open', () => { layoutUIExpanded(); bringUIToFront(); });
ipcMain.on('sb:close', () => { layoutUI(); bringUIToFront(); });

const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
const OVERLAY_CSS = `body>div[style*="position: fixed"][style*="bottom"]{display:none!important;}`;

ipcMain.handle('tab:create', async (event, url) => {
  const id = ++tabIdCounter;
  const view = new BrowserView({
    webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true, backgroundThrottling: false, userAgent: UA }
  });
  webViews.set(id, view);
  view._active = false;
  const send = (ch, d) => { if (!mainWindow.isDestroyed()) uiView.webContents.send(ch, d); };
  view.webContents.on('did-navigate', (e, u) => send('tab:navigate', { id, url: u, title: view.webContents.getTitle() }));
  view.webContents.on('did-navigate-in-page', (e, u) => send('tab:navigate', { id, url: u, title: view.webContents.getTitle() }));
  view.webContents.on('page-title-updated', (e, t) => send('tab:title', { id, title: t }));
  view.webContents.on('page-favicon-updated', (e, f) => send('tab:favicon', { id, favicon: f[0] }));
  view.webContents.on('did-start-loading', () => send('tab:loading', { id, loading: true }));
  view.webContents.on('did-stop-loading', () => send('tab:loading', { id, loading: false }));
  view.webContents.on('did-finish-load', () => { view.webContents.insertCSS(OVERLAY_CSS).catch(() => {}); });
  view.webContents.setWindowOpenHandler(({ url: u }) => { uiView.webContents.send('app:openUrl', u); return { action: 'deny' }; });
  view.webContents.loadURL(url || 'https://www.google.com');
  return id;
});

ipcMain.handle('tab:activate', async (event, id) => {
  for (const [, v] of webViews) { mainWindow.removeBrowserView(v); v._active = false; }
  const view = webViews.get(id);
  if (view) {
    mainWindow.addBrowserView(view);
    layoutWebView(view);
    view._active = true;
    bringUIToFront();
    uiView.webContents.send('tab:activated', { id });
  }
});

ipcMain.handle('tab:close', async (event, id) => {
  const v = webViews.get(id);
  if (v) { mainWindow.removeBrowserView(v); v.webContents.destroy(); webViews.delete(id); }
});

ipcMain.handle('tab:navigate', async (event, { id, url }) => {
  const view = webViews.get(id); if (!view) return '';
  let u = url.trim();
  if (!u.startsWith('http://') && !u.startsWith('https://')) {
    u = /^[a-zA-Z0-9-]+\.[a-zA-Z]{2,}/.test(u) && !u.includes(' ')
      ? 'https://' + u : 'https://www.google.com/search?q=' + encodeURIComponent(u);
  }
  view.webContents.loadURL(u);
  return u;
});

ipcMain.handle('tab:back', (e, id) => { const v = webViews.get(id); if (v?.webContents.canGoBack()) v.webContents.goBack(); });
ipcMain.handle('tab:forward', (e, id) => { const v = webViews.get(id); if (v?.webContents.canGoForward()) v.webContents.goForward(); });
ipcMain.handle('tab:reload', (e, id) => { webViews.get(id)?.webContents.reload(); });
ipcMain.handle('tab:getUrl', (e, id) => webViews.get(id)?.webContents.getURL() || '');
ipcMain.handle('tab:canGoBack', (e, id) => webViews.get(id)?.webContents.canGoBack() || false);
ipcMain.handle('tab:canGoForward', (e, id) => webViews.get(id)?.webContents.canGoForward() || false);

// ════════════════════════════════════════
//  ブラウザデータインポート
// ════════════════════════════════════════
const home = os.homedir();

const BROWSER_PATHS = {
  chrome: {
    mac: path.join(home, 'Library/Application Support/Google/Chrome/Default'),
    win: path.join(os.homedir(), 'AppData/Local/Google/Chrome/User Data/Default'),
    linux: path.join(home, '.config/google-chrome/Default'),
  },
  edge: {
    mac: path.join(home, 'Library/Application Support/Microsoft Edge/Default'),
    win: path.join(home, 'AppData/Local/Microsoft/Edge/User Data/Default'),
    linux: path.join(home, '.config/microsoft-edge/Default'),
  },
  arc: {
    mac: path.join(home, 'Library/Application Support/Arc/User Data/Default'),
  },
  vivaldi: {
    mac: path.join(home, 'Library/Application Support/Vivaldi/Default'),
    win: path.join(home, 'AppData/Local/Vivaldi/User Data/Default'),
    linux: path.join(home, '.config/vivaldi/Default'),
  },
};

function getPlatformKey() {
  if (process.platform === 'darwin') return 'mac';
  if (process.platform === 'win32') return 'win';
  return 'linux';
}

function detectAvailableBrowsers() {
  const plat = getPlatformKey();
  const available = [];
  for (const [name, paths] of Object.entries(BROWSER_PATHS)) {
    const p = paths[plat];
    if (p && fs.existsSync(p)) available.push({ name, profilePath: p });
  }
  return available;
}

function readChromeBookmarks(profilePath) {
  const bmPath = path.join(profilePath, 'Bookmarks');
  if (!fs.existsSync(bmPath)) return [];
  try {
    const data = JSON.parse(fs.readFileSync(bmPath, 'utf8'));
    const results = [];
    function walk(node) {
      if (node.type === 'url') results.push({ name: node.name, url: node.url });
      if (node.children) node.children.forEach(walk);
    }
    Object.values(data.roots || {}).forEach(walk);
    return results.slice(0, 200);
  } catch { return []; }
}

ipcMain.handle('import:detect', () => detectAvailableBrowsers());

ipcMain.handle('import:bookmarks', async (event, browserName) => {
  const plat = getPlatformKey();
  const profilePath = BROWSER_PATHS[browserName]?.[plat];
  if (!profilePath) return { error: 'パスが見つかりません' };
  const bookmarks = readChromeBookmarks(profilePath);
  return { bookmarks };
});

app.whenReady().then(createWindow);
app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });
