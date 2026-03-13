const { app, BrowserWindow, BrowserView, ipcMain, Menu, Notification, nativeImage, Tray, globalShortcut } = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');

app.commandLine.appendSwitch('enable-accelerated-2d-canvas');
app.commandLine.appendSwitch('enable-gpu-rasterization');
app.commandLine.appendSwitch('enable-zero-copy');
app.commandLine.appendSwitch('disable-software-rasterizer');
app.commandLine.appendSwitch('disable-blink-features', 'AutomationControlled');
app.commandLine.appendSwitch('disable-features', 'OverscrollHistoryNavigation'); // 戻る/進むスワイプを無効化
// メモリ使用量を全項目400MB以下に抑制
app.commandLine.appendSwitch('force-gpu-mem-available-mb', '400');        // GPU
app.commandLine.appendSwitch('gpu-program-cache-size-kb', '32768');       // GPUキャッシュ 32MB
app.commandLine.appendSwitch('disable-gpu-program-cache');
app.commandLine.appendSwitch('js-flags', '--max-old-space-size=400');     // JSヒープ
app.commandLine.appendSwitch('renderer-process-limit', '4');              // Rendererプロセス数上限
app.commandLine.appendSwitch('max-tiles-for-interest-area', '128');       // タイル数制限
// Googleログイン対策: Electronアプリと判別されないようにする
app.commandLine.appendSwitch('no-sandbox');
app.commandLine.appendSwitch('disable-setuid-sandbox');
app.commandLine.appendSwitch('ignore-certificate-errors');
app.commandLine.appendSwitch('allow-running-insecure-content');

const PEEK = 10;
const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/134.0.6998.89 Safari/537.36';
let mainWindow;
let uiView;
let tray = null;
let forceQuit = false;
let sidebarWidth = 300; // デフォルトサイドバー幅
const webViews = new Map();
let tabIdCounter = 0;
let activeTabId = null;

// バックグラウンド通知用の非表示タブ（tabIdとは別管理）
const bgViews = new Map(); // appKey -> BrowserView

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
    autoUpdater.allowDowngrade = false;
    autoUpdater.allowPrerelease = false;
    // ログを有効化（デバッグ用）
    autoUpdater.logger = require('electron-log');
    autoUpdater.logger.transports.file.level = 'info';

    autoUpdater.on('update-available', info => {
      if (!uiView.webContents.isDestroyed())
        uiView.webContents.send('update:available', { version: info.version });
      // autoDownload=trueでも念のため明示的にダウンロード開始
      autoUpdater.downloadUpdate().catch(err => console.log('download error:', err.message));
    });
    autoUpdater.on('download-progress', progress => {
      if (!uiView.webContents.isDestroyed())
        uiView.webContents.send('update:progress', { percent: Math.floor(progress.percent) });
    });
    autoUpdater.on('update-downloaded', info => {
      if (!uiView.webContents.isDestroyed())
        uiView.webContents.send('update:downloaded', { version: info.version });
    });
    autoUpdater.on('update-not-available', () => {
      if (!uiView.webContents.isDestroyed())
        uiView.webContents.send('update:notAvailable');
    });
    autoUpdater.on('error', err => {
      console.log('updater error:', err.message);
      if (!uiView || uiView.webContents.isDestroyed()) return;
      uiView.webContents.send('update:notAvailable');
    });

    setTimeout(() => autoUpdater.checkForUpdates().catch(() => {}), 30000);

    ipcMain.on('update:install', () => {
      forceQuit = true;
      // 保存待ちをスキップしてすぐインストール
      ipcMain.removeAllListeners('app:save-complete');
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.removeAllListeners('close');
      }
      // 少し待ってからquitAndInstall（UI側の処理が終わるのを待つ）
      setTimeout(() => {
        autoUpdater.quitAndInstall(false, true);
      }, 500);
    });
    ipcMain.handle('update:check', async () => {
      try { await autoUpdater.checkForUpdates(); return { ok: true }; }
      catch(e) { return { error: e.message }; }
    });
  } catch(e) {
    console.log('AutoUpdater unavailable:', e.message);
    ipcMain.handle('update:check', async () => ({ error: 'dev mode' }));
  }
}

// ── バックグラウンド通知タブ ──
// 通知ONのアプリを非表示BrowserViewとして常時バックグラウンドで監視する
function createBackgroundView(appKey, appConf) {
  if (bgViews.has(appKey)) return; // すでに存在

  const view = new BrowserView({
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      backgroundThrottling: false,
      userAgent: UA,
      partition: 'persist:main',
      webSecurity: false,
      sandbox: false,
    }
  });
  bgViews.set(appKey, view);

  // 画面外に配置（ユーザーには見えない）
  mainWindow.addBrowserView(view);
  view.setBounds({ x: -9999, y: 0, width: 1280, height: 900 });

  let lastNotifTitle = '';
  view.webContents.on('page-title-updated', (e, t) => {
    if (!notificationSettings.enabled) return;
    if (!notificationSettings.apps[appKey]?.enabled) return;
    const match = t.match(/^\((\d+)\)\s*(.+)/);
    if (match && t !== lastNotifTitle) {
      lastNotifTitle = t;
      sendNativeNotification({
        title: `${appConf.label} - ${match[1]}件の通知`,
        body: match[2],
        tabId: null, // バックグラウンドタブなのでフォーカス先なし
      });
    }
    if (!match) lastNotifTitle = ''; // 通知が消えたらリセット
  });

  view.webContents.loadURL(`https://${appConf.url}`);
  bringUIToFront();
}

function destroyBackgroundView(appKey) {
  const view = bgViews.get(appKey);
  if (view) {
    try { mainWindow.removeBrowserView(view); } catch(e) {}
    try { view.webContents.destroy(); } catch(e) {}
    bgViews.delete(appKey);
  }
}

// 通知設定に基づいてバックグラウンドタブを同期する
function syncBackgroundViews() {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  for (const [appKey, appConf] of Object.entries(notificationSettings.apps)) {
    const shouldRun = notificationSettings.enabled && appConf.enabled;
    if (shouldRun && !bgViews.has(appKey)) {
      createBackgroundView(appKey, appConf);
    } else if (!shouldRun && bgViews.has(appKey)) {
      destroyBackgroundView(appKey);
    }
  }
}

// ── システムトレイ（Windows/Linux用） ──
function setupTray() {
  if (process.platform === 'darwin') return; // macはDockがあるので不要
  try {
    tray = new Tray(path.join(__dirname, 'assets/icon.png'));
    tray.setToolTip('Spiral');
    const menu = Menu.buildFromTemplate([
      { label: '開く', click: () => { mainWindow.show(); mainWindow.focus(); } },
      { type: 'separator' },
      { label: '終了', click: () => { forceQuit = true; app.quit(); } },
    ]);
    tray.setContextMenu(menu);
    tray.on('double-click', () => { mainWindow.show(); mainWindow.focus(); });
  } catch(e) {
    console.log('Tray setup failed:', e.message);
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
  // メインプロセスのメモリ上限400MB
  if (mainWindow.webContents.session) {
    mainWindow.webContents.session.setPreloads([]);
  }

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
  // ワークスペース0のセッションも設定
  setupSession(session.fromPartition('persist:ws-main'));
  setupSession(session.fromPartition('persist:ws-ws0'));

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

  uiView.webContents.once('dom-ready', () => {
    console.log('[READY] sending app:ready to uiView');
    uiView.webContents.send('app:ready');
    uiView.webContents.send('notif:settings', notificationSettings);
  });

  // ズームのグローバルショートカット（WebViewにフォーカスがあっても効く）
  const doZoom = (type) => {
    if (!activeTabId) return;
    const v = webViews.get(activeTabId);
    if (!v) return;
    let pct;
    if (type === 'in') {
      const cur = v.webContents.getZoomFactor();
      const next = ZOOM_STEPS.find(z => z > cur + 0.01) || ZOOM_STEPS[ZOOM_STEPS.length - 1];
      v.webContents.setZoomFactor(next);
      pct = Math.round(next * 100);
    } else if (type === 'out') {
      const cur = v.webContents.getZoomFactor();
      const next = [...ZOOM_STEPS].reverse().find(z => z < cur - 0.01) || ZOOM_STEPS[0];
      v.webContents.setZoomFactor(next);
      pct = Math.round(next * 100);
    } else {
      v.webContents.setZoomFactor(1.0);
      pct = 100;
    }
    if (!uiView.webContents.isDestroyed()) uiView.webContents.send('zoom:changed', pct);
  };
  globalShortcut.register('CommandOrControl+=', () => doZoom('in'));
  globalShortcut.register('CommandOrControl+Plus', () => doZoom('in'));
  globalShortcut.register('CommandOrControl+-', () => doZoom('out'));
  globalShortcut.register('CommandOrControl+0', () => doZoom('reset'));

  // OSネイティブのコンテキストメニューを無効化（UIのカスタム右クリックメニューを正しく動作させるため）
  uiView.webContents.on('context-menu', (e) => {
    e.preventDefault();
  });

  setupAutoUpdater();

  // トレイ設定（Windows/Linux）
  setupTray();

  // バックグラウンド通知タブを起動
  uiView.webContents.once('did-finish-load', () => {
    setTimeout(() => syncBackgroundViews(), 2000);
  });

  // ウィンドウを「閉じる」ときはアプリを終了せず非表示にする
  // → バックグラウンドタブが生き続けるので通知が届く
  mainWindow.on('close', (e) => {
    if (!forceQuit) {
      e.preventDefault();
      mainWindow.hide();
      // macではDockアイコンのバッジ等を維持するためにhideのみ
    }
  });
}

ipcMain.on('sb:open', () => { layoutUIExpanded(); bringUIToFront(); mainWindow.setWindowButtonVisibility(true); });
ipcMain.on('sb:close', () => { layoutUI(); bringUIToFront(); mainWindow.setWindowButtonVisibility(false); });

// セッション共通設定
function setupSession(ses) {
  ses.setUserAgent(UA);
  ses.webRequest.onBeforeSendHeaders((details, callback) => {
    const headers = { ...details.requestHeaders };
    headers['User-Agent'] = UA;
    delete headers['X-Electron-Version'];
    delete headers['X-Requested-With'];
    headers['Sec-CH-UA'] = '"Chromium";v="134", "Google Chrome";v="134", "Not-A.Brand";v="24"';
    headers['Sec-CH-UA-Mobile'] = '?0';
    headers['Sec-CH-UA-Platform'] = '"macOS"';
    if (details.url && details.url.includes('google.com')) {
      if (!headers['Sec-Fetch-Site']) headers['Sec-Fetch-Site'] = 'same-origin';
      if (!headers['Sec-Fetch-Mode']) headers['Sec-Fetch-Mode'] = 'navigate';
      if (!headers['Sec-Fetch-Dest']) headers['Sec-Fetch-Dest'] = 'document';
    }
    callback({ requestHeaders: headers });
  });
  ses.webRequest.onHeadersReceived((details, callback) => {
    const headers = { ...details.responseHeaders };
    delete headers['x-frame-options'];
    delete headers['X-Frame-Options'];
    callback({ responseHeaders: headers });
  });
}

ipcMain.handle('tab:create', async (event, payload) => {
  // payloadは { url, partition } または後方互換で文字列(url)
  const url = typeof payload === 'string' ? payload : (payload?.url || null);
  const partitionKey = (typeof payload === 'object' && payload?.partition) ? payload.partition : 'main';
  const sessionPartition = `persist:ws-${partitionKey}`;

  // セッションが初回作成の場合はsetupSessionを適用（UA偽装など）
  setupSession(session.fromPartition(sessionPartition));

  const id = ++tabIdCounter;
  const view = new BrowserView({
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      backgroundThrottling: true,
      userAgent: UA,
      partition: sessionPartition,
      webSecurity: false,
      sandbox: false,
      preload: path.join(__dirname, 'stealth-preload.js'),
      spellcheck: false,
      enableBlinkFeatures: '',
      disableBlinkFeatures: 'AutomationControlled',
      navigateOnDragDrop: false,
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
  // dom-ready: stealth + chrome.webstore API注入（統合版）
  view.webContents.on('dom-ready', () => {
    view.webContents.executeJavaScript(`
      (function() {
        try {
          Object.defineProperty(navigator, 'webdriver', { get: () => undefined, configurable: true });
          if (!window.chrome) {
            window.chrome = {
              app: { isInstalled: false, InstallState:{DISABLED:'disabled',INSTALLED:'installed',NOT_INSTALLED:'not_installed'}, RunningState:{CANNOT_RUN:'cannot_run',READY_TO_RUN:'ready_to_run',RUNNING:'running'} },
              runtime: { PlatformOs:{MAC:'mac',WIN:'win',ANDROID:'android',CROS:'cros',LINUX:'linux',OPENBSD:'openbsd'}, onMessage:{addListener:function(){}}, sendMessage:function(){} },
              csi: function(){}, loadTimes: function(){}
            };
          }
          // chrome.webstore APIを注入 → Chromeウェブストアの「追加」ボタンを機能させる
          window.chrome.webstore = {
            install: function(url, successCb, failureCb) {
              var extId = '';
              var sources = [window.location.href, url || ''];
              for (var i = 0; i < sources.length; i++) {
                var m = sources[i].match(/\/([a-z]{32})(?:[\/?]|$)/);
                if (m) { extId = m[1]; break; }
              }
              if (!extId) { if (failureCb) failureCb('Extension ID not found'); return; }
              window._spiralInstallExt(extId)
                .then(function(r) { if (r && r.error) { if (failureCb) failureCb(r.error); } else { if (successCb) successCb(); } })
                .catch(function(e) { if (failureCb) failureCb(String(e)); });
            },
            onInstallStageChanged: { addListener: function(){} },
            onDownloadProgress: { addListener: function(){} },
          };
          if (navigator.plugins.length === 0) {
            Object.defineProperty(navigator, 'plugins', { get: () => [1,2,3,4,5] });
          }
          Object.defineProperty(navigator, 'languages', { get: () => ['ja-JP','ja','en-US','en'] });
        } catch(e) {}
      })();
    `, true).catch(() => {});
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

const ZOOM_STEPS = [0.25, 0.33, 0.5, 0.67, 0.75, 0.8, 0.9, 1.0, 1.1, 1.25, 1.5, 1.75, 2.0, 2.5, 3.0];
ipcMain.handle('tab:zoomIn', (e, id) => {
  const v = webViews.get(id); if (!v) return 1;
  const cur = v.webContents.getZoomFactor();
  const next = ZOOM_STEPS.find(z => z > cur + 0.01) || ZOOM_STEPS[ZOOM_STEPS.length - 1];
  v.webContents.setZoomFactor(next);
  return Math.round(next * 100);
});
ipcMain.handle('tab:zoomOut', (e, id) => {
  const v = webViews.get(id); if (!v) return 1;
  const cur = v.webContents.getZoomFactor();
  const next = [...ZOOM_STEPS].reverse().find(z => z < cur - 0.01) || ZOOM_STEPS[0];
  v.webContents.setZoomFactor(next);
  return Math.round(next * 100);
});
ipcMain.handle('tab:zoomReset', (e, id) => {
  const v = webViews.get(id); if (!v) return 100;
  v.webContents.setZoomFactor(1.0);
  return 100;
});
ipcMain.handle('tab:getZoom', (e, id) => {
  const v = webViews.get(id); if (!v) return 100;
  return Math.round(v.webContents.getZoomFactor() * 100);
});

// ── 通知設定 ──
ipcMain.handle('notif:getSettings',  () => notificationSettings);
ipcMain.handle('notif:saveSettings', (e, s) => { notificationSettings = s; saveNotificationSettings(); syncBackgroundViews(); return true; });

// ── アプリ状態の永続化（ワークスペース・タブ） ──
const appStatePath = path.join(app.getPath('userData'), 'app-state.json');
ipcMain.handle('state:save', (e, state) => {
  try {
    const tabs = state?.workspaces?.[0]?.tabs || [];
    console.log('[SAVE] tabs count:', tabs.length, '| urls:', tabs.map(t => t.url).join(', '));
    fs.writeFileSync(appStatePath, JSON.stringify(state, null, 2)); return true;
  } catch(err) { console.error('[SAVE ERROR]', err.message); return false; }
});
ipcMain.handle('state:load', () => {
  console.log('[LOAD] called, path:', appStatePath);
  try {
    if (fs.existsSync(appStatePath)) {
      const data = JSON.parse(fs.readFileSync(appStatePath, 'utf8'));
      const tabs = data?.workspaces?.[0]?.tabs || [];
      console.log('[LOAD] tabs count:', tabs.length, '| urls:', tabs.map(t => t.url).join(', '));
      return data;
    } else {
      console.log('[LOAD] no save file found at:', appStatePath);
    }
  } catch(e) { console.error('[LOAD ERROR]', e.message); }
  console.log('[LOAD] returning null');
  return null;
});
// セッション情報だけを即時上書き保存（ログイン完了直後に呼ばれる）
ipcMain.handle('state:saveSession', (e, { wsIdx, info }) => {
  try {
    let state = {};
    if (fs.existsSync(appStatePath)) state = JSON.parse(fs.readFileSync(appStatePath, 'utf8'));
    if (state.workspaces && state.workspaces[wsIdx]) {
      state.workspaces[wsIdx].sessionInfo = info;
      fs.writeFileSync(appStatePath, JSON.stringify(state, null, 2));
    }
    return true;
  } catch(e) { return false; }
});

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
// ── Chrome拡張機能インストール ──
const https = require('https');
const extensionsDir = path.join(app.getPath('userData'), 'extensions');
const loadedExtensions = new Set();

function httpsGet(url) {
  return new Promise((resolve, reject) => {
    https.get(url, { headers: { 'User-Agent': UA } }, res => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        return resolve(httpsGet(res.headers.location));
      }
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => resolve(Buffer.concat(chunks)));
      res.on('error', reject);
    }).on('error', reject);
  });
}

async function downloadAndInstallExtension(extId) {
  const { session } = require('electron');
  if (!fs.existsSync(extensionsDir)) fs.mkdirSync(extensionsDir, { recursive: true });

  const extDir = path.join(extensionsDir, extId);

  // 既にインストール済みなら再読み込みするだけ
  if (fs.existsSync(extDir) && fs.existsSync(path.join(extDir, 'manifest.json'))) {
    if (!loadedExtensions.has(extId)) {
      await loadExtensionToAllSessions(extDir, extId);
    }
    return { ok: true, cached: true };
  }

  // CRXをダウンロード（複数エンドポイントを試行）
  const crxUrls = [
    `https://clients2.google.com/service/update2/crx?response=redirect&prodversion=136.0.0.0&acceptformat=crx3,crx2&x=id%3D${extId}%26installsource%3Dondemand%26uc`,
    `https://clients2.google.com/service/update2/crx?response=redirect&prodversion=134.0.0.0&acceptformat=crx3&x=id%3D${extId}%26installsource%3Dondemand%26uc`,
    `https://extension-updates.googleapis.com/service/update2/crx?response=redirect&os=mac&arch=arm64&prodversion=136.0.0.0&x=id%3D${extId}%26installsource%3Dondemand%26uc`,
  ];
  let crxBuf = null;
  for (const url of crxUrls) {
    try {
      const buf = await httpsGet(url);
      console.log('[EXT] download size:', buf.length, 'first4:', buf.slice(0,4).toString('hex'));
      if (buf.length > 100) { crxBuf = buf; break; }
    } catch(e) { console.warn('[EXT] url failed:', url, e.message); }
  }
  if (!crxBuf) throw new Error('CRX download failed');

  // CRX3形式を解析してZIPを取り出す
  const zip = extractZipFromCrx(crxBuf);
  if (!zip) throw new Error('CRX parse failed');

  // ZIPを解凍
  fs.mkdirSync(extDir, { recursive: true });
  await extractZip(zip, extDir);

  await loadExtensionToAllSessions(extDir, extId);
  return { ok: true };
}

function extractZipFromCrx(buf) {
  // raw ZIP (PK header)
  if (buf[0] === 0x50 && buf[1] === 0x4B) return buf;

  // magicをビッグエンディアン文字列として比較（"Cr24" or "CrX3"）
  const magicStr = buf.slice(0, 4).toString('ascii');
  const version  = buf.readUInt32LE(4);
  console.log('[CRX] magic:', magicStr, 'version:', version, 'first16:', buf.slice(0,16).toString('hex'));

  if (magicStr === 'Cr24') {
    if (version === 2) {
      // CRX2: [magic4][version4][pubkeyLen4][sigLen4][pubkey][sig][zip]
      const pubKeyLen = buf.readUInt32LE(8);
      const sigLen    = buf.readUInt32LE(12);
      const offset    = 16 + pubKeyLen + sigLen;
      console.log('[CRX2] pubKeyLen:', pubKeyLen, 'sigLen:', sigLen, 'offset:', offset);
      return buf.slice(offset);
    }
    if (version === 3) {
      // CRX3形式（magic=Cr24でもversion=3のケース）
      // [magic4][version4][headerSize4][header...][zip]
      const headerSize = buf.readUInt32LE(8);
      const offset     = 12 + headerSize;
      console.log('[CRX3/Cr24] headerSize:', headerSize, 'offset:', offset);
      return buf.slice(offset);
    }
  }

  if (magicStr === 'CrX3') {
    const headerSize = buf.readUInt32LE(8);
    const offset     = 12 + headerSize;
    console.log('[CRX3] headerSize:', headerSize, 'offset:', offset);
    return buf.slice(offset);
  }

  console.log('[CRX] unknown format, magic:', magicStr, buf.slice(0,4).toString('hex'));
  return null;
}

function extractZip(zipBuf, destDir) {
  return new Promise((resolve, reject) => {
    try {
      const AdmZip = require('adm-zip');
      const zip = new AdmZip(zipBuf);
      zip.extractAllTo(destDir, true);
      resolve();
    } catch(e) { reject(e); }
  });
}

async function loadExtensionToAllSessions(extDir, extId) {
  const { session } = require('electron');
  const sessions = [];
  // 既存の全セッションに読み込む
  try { sessions.push(session.fromPartition('persist:main')); } catch(e){}
  try { sessions.push(session.fromPartition('persist:ws-main')); } catch(e){}
  // 保存済みワークスペースのセッションも
  try {
    if (fs.existsSync(path.join(app.getPath('userData'), 'app-state.json'))) {
      const state = JSON.parse(fs.readFileSync(path.join(app.getPath('userData'), 'app-state.json'), 'utf8'));
      for (const ws of (state.workspaces || [])) {
        if (ws.id) { try { sessions.push(session.fromPartition(`persist:ws-${ws.id}`)); } catch(e){} }
      }
    }
  } catch(e) {}
  for (const ses of sessions) {
    try { await ses.loadExtension(extDir, { allowFileAccess: true }); } catch(e) { console.log('loadExtension error:', e.message); }
  }
  loadedExtensions.add(extId);
}

// 起動時に既存の拡張機能を再読み込み
app.whenReady().then(async () => {
  if (!fs.existsSync(extensionsDir)) return;
  const dirs = fs.readdirSync(extensionsDir);
  for (const d of dirs) {
    const extDir = path.join(extensionsDir, d);
    if (fs.existsSync(path.join(extDir, 'manifest.json'))) {
      await loadExtensionToAllSessions(extDir, d).catch(() => {});
    }
  }
});

ipcMain.handle('ext:openPopup', async (event, extId) => {
  try {
    const { session } = require('electron');
    const ses = session.fromPartition('persist:ws-main');
    const ext = ses.getAllExtensions().find(e => e.id === extId);
    if (!ext) return { error: '拡張機能が見つかりません' };
    const popupUrl = `chrome-extension://${extId}/${ext.manifest.action?.default_popup || ext.manifest.browser_action?.default_popup || 'popup.html'}`;
    // アクティブなタブで拡張機能のpopupをBrowserWindowで開く
    const popup = new BrowserWindow({
      width: 380, height: 520,
      resizable: true,
      parent: mainWindow,
      modal: false,
      webPreferences: {
        session: ses,
        nodeIntegration: false,
        contextIsolation: true,
      },
      titleBarStyle: 'hiddenInset',
      title: ext.name,
    });
    popup.loadURL(popupUrl);
    popup.once('ready-to-show', () => popup.show());
    return { ok: true };
  } catch(e) {
    console.log('ext:openPopup error:', e.message);
    return { error: e.message };
  }
});

ipcMain.handle('ext:install', async (event, extId) => {
  try {
    await downloadAndInstallExtension(extId);
    if (uiView && !uiView.webContents.isDestroyed()) {
      uiView.webContents.send('ext:installed', { extId });
    }
    return { ok: true };
  } catch(e) {
    console.log('Extension install error:', e.message);
    return { error: e.message };
  }
});

// i18nメッセージキー（__MSG_xxx__）を実際の文字列に解決
function resolveExtMessage(extDir, str) {
  if (!str || !str.startsWith('__MSG_')) return str;
  const key = str.replace(/^__MSG_/, '').replace(/__$/, '');
  // en → ja → 最初に見つかったロケールの順で試す
  const localesDir = path.join(extDir, '_locales');
  if (!fs.existsSync(localesDir)) return str;
  const tryLocales = ['en', 'ja'];
  const allLocales = fs.readdirSync(localesDir);
  for (const extra of allLocales) if (!tryLocales.includes(extra)) tryLocales.push(extra);
  for (const locale of tryLocales) {
    const msgPath = path.join(localesDir, locale, 'messages.json');
    if (!fs.existsSync(msgPath)) continue;
    try {
      const msgs = JSON.parse(fs.readFileSync(msgPath, 'utf8'));
      const entry = msgs[key] || msgs[key.toLowerCase()];
      if (entry && entry.message) return entry.message;
    } catch {}
  }
  return key; // キーをそのまま返す
}

ipcMain.handle('ext:list', () => {
  try {
    if (!fs.existsSync(extensionsDir)) return [];
    return fs.readdirSync(extensionsDir).map(id => {
      const extDir = path.join(extensionsDir, id);
      const manifestPath = path.join(extDir, 'manifest.json');
      if (!fs.existsSync(manifestPath)) return null;
      try {
        const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
        const name = resolveExtMessage(extDir, manifest.name) || id;
        const description = resolveExtMessage(extDir, manifest.description) || '';
        return { id, name, version: manifest.version || '', description };
      } catch { return { id, name: id, version: '', description: '' }; }
    }).filter(Boolean);
  } catch { return []; }
});

ipcMain.handle('import:detect', () => detectAvailableBrowsers());
ipcMain.handle('import:bookmarks', async (event, browserName) => {
  const profilePath = BROWSER_PATHS[browserName]?.[getPlatformKey()];
  if (!profilePath) return { error: 'パスが見つかりません' };
  return { bookmarks: readChromeBookmarks(profilePath) };
});

app.whenReady().then(createWindow);
app.on('window-all-closed', () => {
  // ウィンドウが全部閉じても（非表示でも）アプリは終了しない
  // macは元々Dockが残るので問題なし
  // Windows/Linuxではforcequitフラグで制御
  if (process.platform !== 'darwin' && !forceQuit) return;
  if (forceQuit) app.quit();
});
app.on('activate', () => {
  // macでDockアイコンクリック時にウィンドウを再表示
  if (mainWindow) {
    mainWindow.show();
    mainWindow.focus();
  } else {
    createWindow();
  }
});
// Cmd+Q などで明示的に終了する場合 → UIに保存を要求してから終了
app.on('before-quit', (e) => {
  if (forceQuit) return; // アップデート時はスキップ
  if (!uiView || uiView.webContents.isDestroyed()) return;
  e.preventDefault();
  forceQuit = true;
  // UIに保存を要求
  uiView.webContents.send('app:save-before-quit');
  // 保存完了を待つ（最大2秒）
  const timeout = setTimeout(() => app.quit(), 2000);
  ipcMain.once('app:save-complete', () => {
    clearTimeout(timeout);
    app.quit();
  });
});
