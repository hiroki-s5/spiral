const { app, BrowserWindow, BrowserView, ipcMain, Menu, Notification, nativeImage } = require('electron');
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
let activeTabId = null;

// ── 通知設定 ──
let notificationSettings = {
  enabled: true,
  apps: {
    gmail:   { enabled: true,  label: 'Gmail',    url: 'mail.google.com' },
    slack:   { enabled: true,  label: 'Slack',    url: 'app.slack.com' },
    discord: { enabled: true,  label: 'Discord',  url: 'discord.com' },
    chatgpt: { enabled: false, label: 'ChatGPT',  url: 'chat.openai.com' },
    youtube: { enabled: false, label: 'YouTube',  url: 'youtube.com' },
  }
};

const settingsPath = path.join(app.getPath('userData'), 'notification-settings.json');

function loadNotificationSettings() {
  try {
    if (fs.existsSync(settingsPath)) {
      const saved = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
      notificationSettings = Object.assign({}, notificationSettings, saved);
    }
  } catch(e) {}
}

function saveNotificationSettings() {
  try { fs.writeFileSync(settingsPath, JSON.stringify(notificationSettings, null, 2)); } catch(e) {}
}

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

function getAppKeyFromUrl(url) {
  for (const [key, a] of Object.entries(notificationSettings.apps)) {
    if (url.includes(a.url)) return key;
  }
  return null;
}

function sendNativeNotification({ title, body, tabId }) {
  if (!Notification.isSupported()) return;
  const notif = new Notification({
    title, body, silent: false,
    icon: nativeImage.createFromPath(path.join(__dirname, 'assets/icon.png')),
  });
  notif.on('click', () => {
    mainWindow.focus();
    if (tabId && uiView && !uiView.webContents.isDestroyed()) {
      uiView.webContents.send('notif:click', { tabId });
    }
  });
  notif.show();
}

// ── 自動アップデート ──
function setupAutoUpdater() {
  try {
    const { autoUpdater } = require('electron-updater');
    autoUpdater.autoDownload = true;
    autoUpdater.autoInstallOnAppQuit = true;

    autoUpdater.on('update-available', info => {
      if (!uiView.webContents.isDestroyed())
        uiView.webContents.send('update:available', { version: info.version });
    });
    autoUpdater.on('update-downloaded', info => {
      if (!uiView.webContents.isDestroyed())
        uiView.webContents.send('update:downloaded', { version: info.version });
    });
    autoUpdater.on('update-not-available', () => {
      if (!uiView.webContents.isDestroyed())
        uiView.webContents.send('update:notAvailable');
    });
    autoUpdater.on('error', err => console.log('updater error:', err.message));

    setTimeout(() => autoUpdater.checkForUpdates().catch(() => {}), 30000);

    ipcMain.on('update:install', () => autoUpdater.quitAndInstall());
    ipcMain.handle('update:check', async () => {
      try { await autoUpdater.checkForUpdates(); return { ok: true }; }
      catch(e) { return { error: e.message }; }
    });
  } catch(e) {
    console.log('AutoUpdater unavailable:', e.message);
    ipcMain.handle('update:check', async () => ({ error: 'dev mode' }));
  }
}

function createWindow() {
  loadNotificationSettings();

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
  mainWindow.setWindowButtonVisibility(false);

  // セッション共通設定（一度だけ）
  const { session } = require('electron');
  setupSession(session.fromPartition('persist:main'));

  uiView.webContents.loadFile('src/index.html');
  Menu.setApplicationMenu(null);

  // ダウンロード監視
  mainWindow.webContents.session.on('will-download', (event, item) => {
    const entry = { filename: item.getFilename(), url: item.getURL(), totalBytes: item.getTotalBytes(), startedAt: Date.now(), state: 'progressing' };
    downloadHistory.unshift(entry);
    if (downloadHistory.length > 200) downloadHistory = downloadHistory.slice(0, 200);
    saveDownloadHistory();
    item.on('updated', (e, state) => { entry.state = state; entry.receivedBytes = item.getReceivedBytes(); saveDownloadHistory(); });
    item.once('done', (e, state) => {
      entry.state = state; entry.receivedBytes = item.getReceivedBytes();
      entry.totalBytes = item.getTotalBytes(); entry.savedPath = item.getSavePath(); entry.completedAt = Date.now();
      saveDownloadHistory();
      if (uiView && !uiView.webContents.isDestroyed()) uiView.webContents.send('download:done', entry);
    });
  });

  mainWindow.on('resize', () => {    const [w, h] = getWH();
    const b = uiView.getBounds();
    uiView.setBounds({ x: 0, y: 0, width: b.width > PEEK ? w : PEEK, height: h });
    if (activeTabId) {
      const v = webViews.get(activeTabId);
      if (v) layoutWebView(v);
    }
    bringUIToFront();
  });

  uiView.webContents.once('did-finish-load', () => {
    uiView.webContents.send('app:ready');
    uiView.webContents.send('notif:settings', notificationSettings);
  });

  setupAutoUpdater();
}

ipcMain.on('sb:open', () => { layoutUIExpanded(); bringUIToFront(); mainWindow.setWindowButtonVisibility(true); });
ipcMain.on('sb:close', () => { layoutUI(); bringUIToFront(); mainWindow.setWindowButtonVisibility(false); });

const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/133.0.0.0 Safari/537.36';

// セッション共通設定（一度だけ実行）
function setupSession(ses) {
  ses.setUserAgent(UA);
  ses.webRequest.onBeforeSendHeaders((details, callback) => {
    const headers = { ...details.requestHeaders };
    headers['User-Agent'] = UA;
    delete headers['X-Electron-Version'];
    callback({ requestHeaders: headers });
  });
}

ipcMain.handle('tab:create', async (event, url) => {
  const id = ++tabIdCounter;
  const view = new BrowserView({
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      backgroundThrottling: false,
      userAgent: UA,
      partition: 'persist:main',
      webSecurity: false,
    }
  });
  webViews.set(id, view);
  view._active = false;
  view._url = '';

  const send = (ch, d) => {
    if (mainWindow && !mainWindow.isDestroyed() && !uiView.webContents.isDestroyed())
      uiView.webContents.send(ch, d);
  };

  view.webContents.on('did-navigate', (e, u) => {
    view._url = u;
    send('tab:navigate', { id, url: u, title: view.webContents.getTitle() });
    if (u && u.startsWith('http')) addHistory({ url: u, title: view.webContents.getTitle() || u });
  });
  view.webContents.on('did-navigate-in-page', (e, u) => {
    view._url = u;
    send('tab:navigate', { id, url: u, title: view.webContents.getTitle() });
    if (u && u.startsWith('http')) addHistory({ url: u, title: view.webContents.getTitle() || u });
  });
  view.webContents.on('page-title-updated', (e, t) => {
    send('tab:title', { id, title: t });
    // 通知検知
    if (notificationSettings.enabled) {
      const appKey = getAppKeyFromUrl(view._url || '');
      if (appKey && notificationSettings.apps[appKey]?.enabled) {
        const match = t.match(/^\((\d+)\)\s*(.+)/);
        if (match) {
          sendNativeNotification({
            title: `${notificationSettings.apps[appKey].label} - ${match[1]}件の通知`,
            body: match[2], tabId: id,
          });
        }
      }
    }
  });
  view.webContents.on('page-favicon-updated', (e, f) => send('tab:favicon', { id, favicon: f[0] }));
  view.webContents.on('did-start-loading', () => send('tab:loading', { id, loading: true }));
  view.webContents.on('did-stop-loading', () => send('tab:loading', { id, loading: false }));
  view.webContents.on('did-finish-load', () => {
    view.webContents.insertCSS(`body>div[style*="position: fixed"][style*="bottom"]{display:none!important;}`).catch(() => {});
  });
  view.webContents.setWindowOpenHandler(({ url: u }) => {
    uiView.webContents.send('app:openUrl', u);
    return { action: 'deny' };
  });

  const targetUrl = url || 'https://www.google.com';
  view._url = targetUrl;
  // 最初から画面外にaddしておく（tab:activateでboundsを設定する）
  mainWindow.addBrowserView(view);
  view.setBounds({ x: -9999, y: 0, width: 1, height: 1 });
  bringUIToFront();
  view.webContents.loadURL(targetUrl);
  return id;
});

ipcMain.handle('tab:activate', async (event, id) => {
  for (const [vid, v] of webViews) {
    v._active = false;
    if (vid !== id) {
      v.setBounds({ x: -9999, y: 0, width: 1, height: 1 });
    }
  }
  const view = webViews.get(id);
  if (view) {
    layoutWebView(view);
    view._active = true;
    activeTabId = id;
  }
  bringUIToFront();
  uiView.webContents.send('tab:activated', { id });
});

ipcMain.handle('tab:close', async (event, id) => {
  const v = webViews.get(id);
  if (v) {
    try { mainWindow.removeBrowserView(v); } catch(e) {}
    v.webContents.destroy();
    webViews.delete(id);
    if (activeTabId === id) activeTabId = null;
  }
});

ipcMain.handle('tab:navigate', async (event, { id, url }) => {
  const view = webViews.get(id);
  if (!view) return '';
  let u = url.trim();
  if (!u.startsWith('http://') && !u.startsWith('https://')) {
    u = /^[a-zA-Z0-9-]+\.[a-zA-Z]{2,}/.test(u) && !u.includes(' ')
      ? 'https://' + u
      : 'https://www.google.com/search?q=' + encodeURIComponent(u);
  }
  view.webContents.loadURL(u);
  return u;
});

ipcMain.handle('tab:back',       (e, id) => { const v = webViews.get(id); if (v?.webContents.canGoBack()) v.webContents.goBack(); });
ipcMain.handle('tab:forward',    (e, id) => { const v = webViews.get(id); if (v?.webContents.canGoForward()) v.webContents.goForward(); });
ipcMain.handle('tab:reload',     (e, id) => { webViews.get(id)?.webContents.reload(); });
ipcMain.handle('tab:getUrl',     (e, id) => webViews.get(id)?.webContents.getURL() || '');
ipcMain.handle('tab:canGoBack',  (e, id) => webViews.get(id)?.webContents.canGoBack() || false);
ipcMain.handle('tab:canGoForward',(e,id) => webViews.get(id)?.webContents.canGoForward() || false);

// ── 通知設定 ──
ipcMain.handle('notif:getSettings',  () => notificationSettings);
ipcMain.handle('notif:saveSettings', (e, s) => { notificationSettings = s; saveNotificationSettings(); return true; });

// ── ブラウザ内履歴 ──
const historyPath = path.join(app.getPath('userData'), 'browse-history.json');
let browseHistory = [];
function loadHistory() {
  try { if (fs.existsSync(historyPath)) browseHistory = JSON.parse(fs.readFileSync(historyPath, 'utf8')); } catch(e) { browseHistory = []; }
}
function saveHistory() {
  try { fs.writeFileSync(historyPath, JSON.stringify(browseHistory, null, 2)); } catch(e) {}
}
function addHistory(entry) {
  if (browseHistory.length > 0 && browseHistory[0].url === entry.url) return;
  browseHistory.unshift({ ...entry, visitedAt: Date.now() });
  if (browseHistory.length > 1000) browseHistory = browseHistory.slice(0, 1000);
  saveHistory();
}
ipcMain.handle('history:get', () => browseHistory);
ipcMain.handle('history:clear', () => { browseHistory = []; saveHistory(); return true; });
ipcMain.handle('history:add', (e, entry) => { addHistory(entry); return true; });

// ── ダウンロード履歴 ──
const downloadHistoryPath = path.join(app.getPath('userData'), 'download-history.json');
let downloadHistory = [];
function loadDownloadHistory() {
  try { if (fs.existsSync(downloadHistoryPath)) downloadHistory = JSON.parse(fs.readFileSync(downloadHistoryPath, 'utf8')); } catch(e) { downloadHistory = []; }
}
function saveDownloadHistory() {
  try { fs.writeFileSync(downloadHistoryPath, JSON.stringify(downloadHistory, null, 2)); } catch(e) {}
}
app.whenReady().then(() => { loadHistory(); loadDownloadHistory(); });
ipcMain.handle('download:getHistory', () => downloadHistory);
ipcMain.handle('download:clearHistory', () => { downloadHistory = []; saveDownloadHistory(); return true; });

// ── ブラウザインポート ──
const home = os.homedir();
const BROWSER_PATHS = {
  chrome:  { mac: path.join(home, 'Library/Application Support/Google/Chrome/Default'), win: path.join(home, 'AppData/Local/Google/Chrome/User Data/Default'), linux: path.join(home, '.config/google-chrome/Default') },
  edge:    { mac: path.join(home, 'Library/Application Support/Microsoft Edge/Default'), win: path.join(home, 'AppData/Local/Microsoft/Edge/User Data/Default'), linux: path.join(home, '.config/microsoft-edge/Default') },
  arc:     { mac: path.join(home, 'Library/Application Support/Arc/User Data/Default') },
  vivaldi: { mac: path.join(home, 'Library/Application Support/Vivaldi/Default'), win: path.join(home, 'AppData/Local/Vivaldi/User Data/Default'), linux: path.join(home, '.config/vivaldi/Default') },
};
function getPlatformKey() { return process.platform === 'darwin' ? 'mac' : process.platform === 'win32' ? 'win' : 'linux'; }
function detectAvailableBrowsers() {
  const plat = getPlatformKey();
  return Object.entries(BROWSER_PATHS)
    .filter(([, paths]) => paths[plat] && fs.existsSync(paths[plat]))
    .map(([name, paths]) => ({ name, profilePath: paths[plat] }));
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
  const profilePath = BROWSER_PATHS[browserName]?.[getPlatformKey()];
  if (!profilePath) return { error: 'パスが見つかりません' };
  return { bookmarks: readChromeBookmarks(profilePath) };
});

app.whenReady().then(createWindow);
app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });
