const { app, BrowserWindow, BrowserView, ipcMain, Menu, Notification, nativeImage, Tray, globalShortcut, session, screen } = require('electron');
const path  = require('path');
const fs    = require('fs');
const os    = require('os');
const https = require('https');

// ── コマンドラインスイッチ ──
for (const sw of [
  'enable-accelerated-2d-canvas', 'enable-gpu-rasterization', 'enable-zero-copy',
  'disable-software-rasterizer', 'enable-oop-rasterization',
  'enable-gpu-memory-buffer-compositor-resources', 'enable-native-gpu-memory-buffers',
  'memory-pressure-off', 'enable-quic', 'enable-tcp-fast-open',
  'no-sandbox', 'disable-setuid-sandbox', 'ignore-certificate-errors',
  'allow-running-insecure-content',
]) app.commandLine.appendSwitch(sw);

app.commandLine.appendSwitch('js-flags', '--max-old-space-size=1024 --max-semi-space-size=64 --expose-gc');
app.commandLine.appendSwitch('process-per-site');
app.commandLine.appendSwitch('renderer-process-limit', '6');
app.commandLine.appendSwitch('disk-cache-size',  String(256 * 1024 * 1024));
app.commandLine.appendSwitch('media-cache-size', String(64  * 1024 * 1024));
app.commandLine.appendSwitch('quic-version', 'h3');
app.commandLine.appendSwitch('disable-blink-features', 'AutomationControlled');
app.commandLine.appendSwitch('enable-features',  'NetworkServiceInProcess2,ParallelDownloading,PrefetchDNS');
app.commandLine.appendSwitch('disable-features', 'OverscrollHistoryNavigation,IntensiveWakeUpThrottling,NetworkTimeServiceQuerying,TimerThrottlingForBackgroundTabs,AlignWakeUps');

// ── 定数 ──
const UA     = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/134.0.6998.89 Safari/537.36';
const MARGIN = 20;
const RADIUS = 10;

// WebViewに注入するCSS（角丸 + スクロール挙動）
// - html に border-radius + overflow:hidden で角丸クリッピング
// - did-finish-load が複数回発火してもinsertCSSは累積しないので問題なし
const WEBVIEW_CSS = `
  html { border-radius: ${RADIUS}px !important; overflow: hidden !important; }
  * { overscroll-behavior: none !important; }
  body > div[style*="position: fixed"][style*="bottom"] { display: none !important; }
`;

// 角丸を強制維持するJS（サイトのCSSが上書きしてもMutationObserverで復元）
const WEBVIEW_JS = `(function(){
  function applyRadius() {
    document.documentElement.style.setProperty("border-radius", "${RADIUS}px", "important");
    document.documentElement.style.setProperty("overflow", "hidden", "important");
  }
  applyRadius();
  new MutationObserver(applyRadius).observe(document.documentElement, {
    attributes: true, attributeFilter: ["style", "class"]
  });
})();`;

// ── 状態 ──
let mainWindow, uiView, shadowView;
let tray        = null;
let forceQuit   = false;
let sbIsOpen    = false;
let activeTabId = null;
let tabIdCounter = 0;

const webViews = new Map();
const bgViews  = new Map(); // appKey -> BrowserView（バックグラウンド通知用）

// ── 通知設定 ──
const settingsPath = path.join(app.getPath('userData'), 'notification-settings.json');
let notificationSettings = {
  enabled: true,
  apps: {
    gmail:   { enabled: true,  label: 'Gmail',   url: 'mail.google.com' },
    slack:   { enabled: true,  label: 'Slack',   url: 'app.slack.com' },
    discord: { enabled: true,  label: 'Discord', url: 'discord.com' },
    chatgpt: { enabled: false, label: 'ChatGPT', url: 'chat.openai.com' },
    youtube: { enabled: false, label: 'YouTube', url: 'youtube.com' },
  },
};
function loadNotificationSettings() {
  try {
    if (fs.existsSync(settingsPath))
      notificationSettings = { ...notificationSettings, ...JSON.parse(fs.readFileSync(settingsPath, 'utf8')) };
  } catch {}
}
function saveNotificationSettings() {
  try { fs.writeFileSync(settingsPath, JSON.stringify(notificationSettings, null, 2)); } catch {}
}

// ── レイアウトヘルパー ──
function getWH() { return mainWindow.getContentSize(); }

function layoutWebView(view) {
  const [w, h] = getWH();
  view.setBounds({ x: MARGIN, y: MARGIN, width: w - MARGIN * 2, height: h - MARGIN * 2 });
}
function layoutUI() {
  const [, h] = getWH();
  uiView.setBounds({ x: MARGIN, y: MARGIN, width: 24, height: h - MARGIN * 2 });
}
function layoutUIExpanded() {
  const [w, h] = getWH();
  uiView.setBounds({ x: MARGIN, y: MARGIN, width: w - MARGIN * 2, height: h - MARGIN * 2 });
}
function layoutShadow() {
  const [w, h] = getWH();
  shadowView.setBounds({ x: 0, y: 0, width: w, height: h });
}
function bringUIToFront() {
  try { mainWindow.setTopBrowserView(uiView); } catch {}
}

// ── 通知 ──
function getAppKeyFromUrl(url) {
  for (const [key, a] of Object.entries(notificationSettings.apps))
    if (url.includes(a.url)) return key;
  return null;
}
function sendNativeNotification({ title, body, tabId }) {
  if (!uiView?.webContents.isDestroyed())
    uiView.webContents.send('notif:hub', { title, body, tabId, time: Date.now() });
  if (!Notification.isSupported()) return;
  const notif = new Notification({
    title, body, silent: false,
    icon: nativeImage.createFromPath(path.join(__dirname, 'assets/icon.png')),
  });
  notif.on('click', () => {
    mainWindow.focus();
    if (tabId && !uiView?.webContents.isDestroyed()) uiView.webContents.send('notif:click', { tabId });
  });
  notif.show();
}

// ── バックグラウンド通知タブ ──
function createBackgroundView(appKey, appConf) {
  if (bgViews.has(appKey)) return;
  const view = new BrowserView({
    webPreferences: {
      contextIsolation: true, nodeIntegration: false, backgroundThrottling: true,
      userAgent: UA, partition: 'persist:main', webSecurity: false, sandbox: false,
    },
  });
  bgViews.set(appKey, view);
  mainWindow.addBrowserView(view);
  view.setBounds({ x: -9999, y: 0, width: 100, height: 100 });
  let lastTitle = '';
  view.webContents.on('page-title-updated', (_, t) => {
    if (!notificationSettings.enabled || !notificationSettings.apps[appKey]?.enabled) return;
    const m = t.match(/^\((\d+)\)\s*(.+)/);
    if (m && t !== lastTitle) { lastTitle = t; sendNativeNotification({ title: `${appConf.label} - ${m[1]}件の通知`, body: m[2], tabId: null }); }
    if (!m) lastTitle = '';
  });
  view.webContents.loadURL(`https://${appConf.url}`);
  bringUIToFront();
}
function destroyBackgroundView(appKey) {
  const view = bgViews.get(appKey);
  if (!view) return;
  try { mainWindow.removeBrowserView(view); } catch {}
  try { view.webContents.destroy(); } catch {}
  bgViews.delete(appKey);
}
function syncBackgroundViews() {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  for (const [key, conf] of Object.entries(notificationSettings.apps)) {
    const should = notificationSettings.enabled && conf.enabled;
    if (should && !bgViews.has(key)) createBackgroundView(key, conf);
    else if (!should && bgViews.has(key)) destroyBackgroundView(key);
  }
}

// ── トレイ（Windows/Linux） ──
function setupTray() {
  if (process.platform === 'darwin') return;
  try {
    tray = new Tray(path.join(__dirname, 'assets/icon.png'));
    tray.setToolTip('Spiral');
    tray.setContextMenu(Menu.buildFromTemplate([
      { label: '開く',  click: () => { mainWindow.show(); mainWindow.focus(); } },
      { type: 'separator' },
      { label: '終了', click: () => { forceQuit = true; app.quit(); } },
    ]));
    tray.on('double-click', () => { mainWindow.show(); mainWindow.focus(); });
  } catch(e) { console.log('Tray setup failed:', e.message); }
}

// ── セッション設定 ──
function setupSession(ses) {
  ses.setUserAgent(UA);
  ses.webRequest.onBeforeSendHeaders((details, cb) => {
    const h = { ...details.requestHeaders, 'User-Agent': UA };
    delete h['X-Electron-Version'];
    delete h['X-Requested-With'];
    h['Sec-CH-UA']          = '"Chromium";v="134", "Google Chrome";v="134", "Not-A.Brand";v="24"';
    h['Sec-CH-UA-Mobile']   = '?0';
    h['Sec-CH-UA-Platform'] = '"macOS"';
    if (!h['Accept-Encoding']) h['Accept-Encoding'] = 'gzip, deflate, br, zstd';
    if (details.url?.includes('google.com')) {
      h['Sec-Fetch-Site'] ??= 'same-origin';
      h['Sec-Fetch-Mode'] ??= 'navigate';
      h['Sec-Fetch-Dest'] ??= 'document';
    }
    cb({ requestHeaders: h });
  });
  ses.webRequest.onHeadersReceived((details, cb) => {
    const h = { ...details.responseHeaders };
    delete h['x-frame-options'];
    delete h['X-Frame-Options'];
    if (details.url?.includes('suggestqueries.google.com')) h['access-control-allow-origin'] = ['*'];
    cb({ responseHeaders: h });
  });
}

// ── 自動アップデート ──
function setupAutoUpdater() {
  try {
    const { autoUpdater } = require('electron-updater');
    autoUpdater.autoDownload = true;
    autoUpdater.autoInstallOnAppQuit = true;
    autoUpdater.logger = require('electron-log');
    autoUpdater.logger.transports.file.level = 'info';
    const send = (ch, d) => { if (!uiView?.webContents.isDestroyed()) uiView.webContents.send(ch, d); };
    autoUpdater.on('update-available',     info => { send('update:available',  { version: info.version }); autoUpdater.downloadUpdate().catch(() => {}); });
    autoUpdater.on('download-progress',    p    => { send('update:progress',   { percent: Math.floor(p.percent) }); });
    autoUpdater.on('update-downloaded',    info => { send('update:downloaded', { version: info.version }); });
    autoUpdater.on('update-not-available', ()   => send('update:notAvailable'));
    autoUpdater.on('error', err => { console.log('updater error:', err.message); send('update:notAvailable'); });
    setTimeout(() => autoUpdater.checkForUpdates().catch(() => {}), 30000);
    ipcMain.on('update:install', () => {
      forceQuit = true;
      ipcMain.removeAllListeners('app:save-complete');
      mainWindow?.removeAllListeners('close');
      setTimeout(() => autoUpdater.quitAndInstall(false, true), 500);
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

// ── ウィンドウ作成 ──
function createWindow() {
  loadNotificationSettings();

  mainWindow = new BrowserWindow({
    width: 960 + MARGIN * 2, height: 720 + MARGIN * 2,
    minWidth: 600 + MARGIN * 2, minHeight: 400 + MARGIN * 2,
    titleBarStyle: 'hidden',
    trafficLightPosition: { x: 9, y: 2 },
    backgroundColor: '#00000000',
    transparent: true,
    roundedCorners: true,
    hasShadow: false,
    title: 'Spiral',
    center: true,
    icon: path.join(__dirname, 'assets/icon.png'),
    webPreferences: { nodeIntegration: false },
  });

  // shadowView: 最背面。MARGIN領域をウィンドウ背景色で塗り、内側を角丸で抜く
  shadowView = new BrowserView({
    backgroundColor: '#ffffff',
    webPreferences: { nodeIntegration: true, contextIsolation: false },
  });
  mainWindow.addBrowserView(shadowView);
  layoutShadow();
  shadowView.webContents.loadFile('src/shadow.html');
  shadowView.webContents.once('did-finish-load', () => shadowView.webContents.send('theme:changed', false));


  // uiView: UI本体
  uiView = new BrowserView({
    backgroundColor: '#00000000',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      backgroundThrottling: false,
    },
  });
  mainWindow.addBrowserView(uiView);
  layoutUIExpanded();
  mainWindow.setWindowButtonVisibility(true);

  for (const p of ['persist:main', 'persist:ws-main', 'persist:ws-ws0'])
    setupSession(session.fromPartition(p));
  setupSession(session.defaultSession);

  uiView.webContents.loadFile('src/index.html');
  Menu.setApplicationMenu(null);

  // ダウンロード監視
  mainWindow.webContents.session.on('will-download', (_, item) => {
    const entry = { filename: item.getFilename(), url: item.getURL(), totalBytes: item.getTotalBytes(), startedAt: Date.now(), state: 'progressing' };
    downloadHistory.unshift(entry);
    if (downloadHistory.length > 200) downloadHistory.length = 200;
    saveDownloadHistory();
    item.on('updated', (_, state) => { entry.state = state; entry.receivedBytes = item.getReceivedBytes(); saveDownloadHistory(); });
    item.once('done', (_, state) => {
      Object.assign(entry, { state, receivedBytes: item.getReceivedBytes(), totalBytes: item.getTotalBytes(), savedPath: item.getSavePath(), completedAt: Date.now() });
      saveDownloadHistory();
      if (!uiView?.webContents.isDestroyed()) uiView.webContents.send('download:done', entry);
    });
  });

  // リサイズ
  mainWindow.on('resize', () => {
    if (sbIsOpen || !activeTabId) layoutUIExpanded(); else layoutUI();
    if (activeTabId) { const v = webViews.get(activeTabId); if (v) layoutWebView(v); }
    layoutShadow();
    bringUIToFront();
  });

  uiView.webContents.once('dom-ready', () => {
    uiView.webContents.send('app:ready');
    uiView.webContents.send('notif:settings', notificationSettings);
  });

  // ズームショートカット
  const ZOOM_STEPS = [0.25, 0.33, 0.5, 0.67, 0.75, 0.8, 0.9, 1.0, 1.1, 1.25, 1.5, 1.75, 2.0, 2.5, 3.0];
  const doZoom = (type) => {
    if (!activeTabId) return;
    const v = webViews.get(activeTabId);
    if (!v) return;
    const cur = v.webContents.getZoomFactor();
    const next = type === 'in'  ? (ZOOM_STEPS.find(z => z > cur + 0.01) ?? ZOOM_STEPS.at(-1))
               : type === 'out' ? ([...ZOOM_STEPS].reverse().find(z => z < cur - 0.01) ?? ZOOM_STEPS[0])
               : 1.0;
    v.webContents.setZoomFactor(next);
    if (!uiView.webContents.isDestroyed()) uiView.webContents.send('zoom:changed', Math.round(next * 100));
  };
  globalShortcut.register('CommandOrControl+=',    () => doZoom('in'));
  globalShortcut.register('CommandOrControl+Plus', () => doZoom('in'));
  globalShortcut.register('CommandOrControl+-',    () => doZoom('out'));
  globalShortcut.register('CommandOrControl+0',    () => doZoom('reset'));

  // DevToolsショートカット
  const toggleDevTools = () => {
    if (!uiView?.webContents.isDestroyed()) {
      if (uiView.webContents.isDevToolsOpened()) uiView.webContents.closeDevTools();
      else uiView.webContents.openDevTools({ mode: 'detach' });
    }
  };
  for (const wc of [uiView.webContents, mainWindow.webContents]) {
    wc.on('before-input-event', (_, input) => {
      if (input.type !== 'keyDown') return;
      if (input.key === 'F12') toggleDevTools();
      if (input.key === 'i' && input.meta && input.alt) toggleDevTools();
    });
  }

  uiView.webContents.on('context-menu', e => e.preventDefault());
  setupAutoUpdater();
  setupTray();

  // サイドバートリガー（マウス座標ポーリング）
  let _trigActive = false;
  const trigPoll = setInterval(() => {
    if (!mainWindow || mainWindow.isDestroyed()) { clearInterval(trigPoll); return; }
    if (!mainWindow.isVisible() || mainWindow.isMinimized()) return;
    const cursor = screen.getCursorScreenPoint();
    const bounds = mainWindow.getBounds();
    const relX   = cursor.x - bounds.x;
    const relY   = cursor.y - bounds.y;
    const inWin  = relX >= 0 && relX <= bounds.width && relY >= 0 && relY <= bounds.height;
    const atLeft = inWin && relX <= MARGIN + 20;
    if (atLeft && !_trigActive) {
      _trigActive = true;
      if (!sbIsOpen && activeTabId) { layoutUIExpanded(); bringUIToFront(); uiView.webContents.send('trig:enter'); }
    } else if (!atLeft && _trigActive) {
      _trigActive = false;
      if (!sbIsOpen && activeTabId) { layoutUI(); uiView.webContents.send('trig:leave'); }
    }
  }, 16);

  uiView.webContents.once('did-finish-load', () => setTimeout(syncBackgroundViews, 2000));
  mainWindow.on('close', e => { if (!forceQuit) { e.preventDefault(); mainWindow.hide(); } });
}

// ── サイドバー開閉 ──
ipcMain.on('sb:open', () => {
  sbIsOpen = true;
  layoutUIExpanded();
  bringUIToFront();
  setTimeout(() => mainWindow.setWindowButtonVisibility(true), 200);
});
ipcMain.on('sb:close', () => {
  sbIsOpen = false;
  if (activeTabId) {
    const v = webViews.get(activeTabId);
    if (v) { layoutWebView(v); try { mainWindow.setTopBrowserView(v); } catch {} }
  }
  layoutUI();
  bringUIToFront();
});

// ── タブ管理 ──
ipcMain.handle('tab:create', async (_, payload) => {
  const url          = typeof payload === 'string' ? payload : (payload?.url ?? null);
  const partitionKey = (typeof payload === 'object' && payload?.partition) ? payload.partition : 'main';
  const partition    = `persist:ws-${partitionKey}`;
  setupSession(session.fromPartition(partition));

  const id   = ++tabIdCounter;
  const view = new BrowserView({
    backgroundColor: '#00000000',
    webPreferences: {
      contextIsolation: true, nodeIntegration: false, backgroundThrottling: true,
      userAgent: UA, partition, webSecurity: false, sandbox: false,
      preload: path.join(__dirname, 'stealth-preload.js'),
      spellcheck: false, disableBlinkFeatures: 'AutomationControlled', navigateOnDragDrop: false,
    },
  });
  webViews.set(id, view);
  view._active = false;
  view._url    = '';

  const send = (ch, d) => { if (!mainWindow?.isDestroyed() && !uiView.webContents.isDestroyed()) uiView.webContents.send(ch, d); };

  view.webContents.on('did-navigate',         (_, u) => { view._url = u; send('tab:navigate', { id, url: u, title: view.webContents.getTitle() }); if (u?.startsWith('http')) addHistory({ url: u, title: view.webContents.getTitle() || u }); });
  view.webContents.on('did-navigate-in-page', (_, u) => { view._url = u; send('tab:navigate', { id, url: u, title: view.webContents.getTitle() }); if (u?.startsWith('http')) addHistory({ url: u, title: view.webContents.getTitle() || u }); });
  view.webContents.on('page-title-updated',   (_, t) => {
    send('tab:title', { id, title: t });
    if (notificationSettings.enabled) {
      const key = getAppKeyFromUrl(view._url || '');
      if (key && notificationSettings.apps[key]?.enabled) {
        const m = t.match(/^\((\d+)\)\s*(.+)/);
        if (m) sendNativeNotification({ title: `${notificationSettings.apps[key].label} - ${m[1]}件の通知`, body: m[2], tabId: id });
      }
    }
  });
  view.webContents.on('page-favicon-updated', (_, f) => send('tab:favicon', { id, favicon: f[0] }));
  view.webContents.on('did-start-loading',    () => send('tab:loading', { id, loading: true  }));
  view.webContents.on('did-stop-loading',     () => send('tab:loading', { id, loading: false }));

  // 角丸CSS+JS注入: 複数タイミングで注入し、MutationObserverで上書きを防ぐ
  const injectCSS = () => view.webContents.insertCSS(WEBVIEW_CSS).catch(() => {});
  const injectJS  = () => view.webContents.executeJavaScript(WEBVIEW_JS, true).catch(() => {});
  view.webContents.on('dom-ready',            () => { injectCSS(); injectJS(); });
  view.webContents.on('did-finish-load',      () => { injectCSS(); injectJS(); });
  view.webContents.on('did-navigate-in-page', () => { injectCSS(); injectJS(); });

  // ステルス注入（dom-readyのみ）
  view.webContents.on('dom-ready', () => {
    view.webContents.executeJavaScript(`(function(){
      try {
        Object.defineProperty(navigator, 'webdriver', { get: () => undefined, configurable: true });
        if (!window.chrome) window.chrome = {
          app: { isInstalled: false },
          runtime: { onMessage: { addListener(){} }, sendMessage(){} },
          csi(){}, loadTimes(){},
        };
        window.chrome.webstore = {
          install(url, ok, fail) {
            var m = [window.location.href, url||''].map(s=>s.match(/\\/([a-z]{32})(?:[\\/?]|$)/)).find(Boolean);
            if (!m) { fail?.('Extension ID not found'); return; }
            window._spiralInstallExt(m[1]).then(r=>r?.error?fail?.(r.error):ok?.()).catch(e=>fail?.(String(e)));
          },
          onInstallStageChanged: { addListener(){} },
          onDownloadProgress:    { addListener(){} },
        };
        if (!navigator.plugins.length) Object.defineProperty(navigator, 'plugins',   { get: () => [1,2,3,4,5] });
        Object.defineProperty(navigator, 'languages', { get: () => ['ja-JP','ja','en-US','en'] });
      } catch {}
    })();`, true).catch(() => {});
  });

  view.webContents.setWindowOpenHandler(({ url: u }) => { uiView.webContents.send('app:openUrl', u); return { action: 'deny' }; });

  // 右クリックメニュー
  view.webContents.on('context-menu', (_, p) => {
    const items = [
      { label: '戻る',       enabled: view.webContents.canGoBack(),    click: () => view.webContents.goBack() },
      { label: '進む',       enabled: view.webContents.canGoForward(), click: () => view.webContents.goForward() },
      { label: '再読み込み', click: () => view.webContents.reload() },
      { type: 'separator' },
    ];
    if (p.linkURL) items.push(
      { label: 'リンクを新しいタブで開く', click: () => uiView.webContents.send('app:openUrl', p.linkURL) },
      { label: 'リンクのURLをコピー',      click: () => require('electron').clipboard.writeText(p.linkURL) },
      { type: 'separator' },
    );
    if (p.hasImageContents) items.push(
      { label: '画像を新しいタブで開く', click: () => uiView.webContents.send('app:openUrl', p.srcURL) },
      { label: '画像のURLをコピー',      click: () => require('electron').clipboard.writeText(p.srcURL) },
      { label: '画像を保存',             click: () => view.webContents.downloadURL(p.srcURL) },
      { type: 'separator' },
    );
    if (p.selectionText) items.push(
      { label: 'コピー', role: 'copy' },
      { label: `"${p.selectionText.slice(0,20)}${p.selectionText.length>20?'…':''}" をGoogle検索`, click: () => uiView.webContents.send('app:openUrl', `https://www.google.com/search?q=${encodeURIComponent(p.selectionText)}`) },
      { type: 'separator' },
    );
    if (p.isEditable) items.push(
      { label: '切り取り', role: 'cut',   enabled: p.editFlags.canCut },
      { label: 'コピー',   role: 'copy',  enabled: p.editFlags.canCopy },
      { label: '貼り付け', role: 'paste', enabled: p.editFlags.canPaste },
      { type: 'separator' },
    );
    items.push(
      { label: 'ページのURLをコピー', click: () => require('electron').clipboard.writeText(view.webContents.getURL()) },
      { label: '名前を付けて保存', click: () => view.webContents.savePage(path.join(os.homedir(), 'Downloads', (view.webContents.getTitle()||'page')+'.html'), 'HTMLComplete').catch(()=>{}) },
      { type: 'separator' },
      { label: 'デベロッパーツール', click: () => view.webContents.openDevTools({ mode: 'detach' }) },
    );
    Menu.buildFromTemplate(items).popup({ window: mainWindow });
  });

  mainWindow.addBrowserView(view);
  view.setBounds({ x: -9999, y: 0, width: 1, height: 1 });
  view._url = url || 'https://www.google.com';
  bringUIToFront();
  view.webContents.loadURL(view._url, { extraHeaders: 'Cache-Control: max-age=0\n' });
  return id;
});

ipcMain.handle('tab:activate', async (_, id) => {
  for (const [vid, v] of webViews) {
    v._active = false;
    if (vid !== id) { v.setBounds({ x: -9999, y: 0, width: 1, height: 1 }); try { v.webContents.setBackgroundThrottling(true); } catch {} }
  }
  const view = webViews.get(id);
  if (view) {
    layoutWebView(view);
    view._active = true;
    activeTabId  = id;
    try { view.webContents.setBackgroundThrottling(false); } catch {}
    layoutUI();
    bringUIToFront();
  }
  uiView.webContents.send('tab:activated', { id });
});

ipcMain.handle('tab:close', async (_, id) => {
  const v = webViews.get(id);
  if (!v) return;
  try { mainWindow.removeBrowserView(v); } catch {}
  v.webContents.destroy();
  webViews.delete(id);
  if (activeTabId === id) { activeTabId = null; layoutUIExpanded(); bringUIToFront(); }
  if (global.gc) try { global.gc(); } catch {}
});

ipcMain.handle('tab:navigate', async (_, { id, url }) => {
  const view = webViews.get(id);
  if (!view) return '';
  let u = url.trim();
  if (!u.startsWith('http://') && !u.startsWith('https://'))
    u = /^[a-zA-Z0-9-]+\.[a-zA-Z]{2,}/.test(u) && !u.includes(' ')
      ? 'https://' + u
      : 'https://www.google.com/search?q=' + encodeURIComponent(u);
  view.webContents.loadURL(u);
  return u;
});

ipcMain.handle('tab:back',        (_, id) => { const v = webViews.get(id); if (v?.webContents.canGoBack())    v.webContents.goBack(); });
ipcMain.handle('tab:forward',     (_, id) => { const v = webViews.get(id); if (v?.webContents.canGoForward()) v.webContents.goForward(); });
ipcMain.handle('tab:reload',      (_, id) => { webViews.get(id)?.webContents.reload(); });
ipcMain.handle('tab:getUrl',      (_, id) => webViews.get(id)?.webContents.getURL() ?? '');
ipcMain.handle('tab:canGoBack',   (_, id) => webViews.get(id)?.webContents.canGoBack()    ?? false);
ipcMain.handle('tab:canGoForward',(_, id) => webViews.get(id)?.webContents.canGoForward() ?? false);

const ZOOM_STEPS = [0.25, 0.33, 0.5, 0.67, 0.75, 0.8, 0.9, 1.0, 1.1, 1.25, 1.5, 1.75, 2.0, 2.5, 3.0];
const zoomApply = (id, next) => { const v = webViews.get(id); if (!v) return 100; v.webContents.setZoomFactor(next); return Math.round(next * 100); };
ipcMain.handle('tab:zoomIn',    (_, id) => { const v = webViews.get(id); if (!v) return 100; const c = v.webContents.getZoomFactor(); return zoomApply(id, ZOOM_STEPS.find(z=>z>c+0.01)??ZOOM_STEPS.at(-1)); });
ipcMain.handle('tab:zoomOut',   (_, id) => { const v = webViews.get(id); if (!v) return 100; const c = v.webContents.getZoomFactor(); return zoomApply(id, [...ZOOM_STEPS].reverse().find(z=>z<c-0.01)??ZOOM_STEPS[0]); });
ipcMain.handle('tab:zoomReset', (_, id) => zoomApply(id, 1.0));
ipcMain.handle('tab:getZoom',   (_, id) => { const v = webViews.get(id); return v ? Math.round(v.webContents.getZoomFactor()*100) : 100; });

// ── 通知設定 ──
ipcMain.handle('notif:getSettings',  ()     => notificationSettings);
ipcMain.handle('notif:saveSettings', (_, s) => { notificationSettings = s; saveNotificationSettings(); syncBackgroundViews(); return true; });

// ── 状態保存 ──
const appStatePath = path.join(app.getPath('userData'), 'app-state.json');
ipcMain.handle('state:save', (_, state) => {
  try { fs.writeFileSync(appStatePath, JSON.stringify(state, null, 2)); return true; }
  catch(e) { console.error('[SAVE ERROR]', e.message); return false; }
});
ipcMain.handle('state:load', () => {
  try { if (fs.existsSync(appStatePath)) return JSON.parse(fs.readFileSync(appStatePath, 'utf8')); }
  catch(e) { console.error('[LOAD ERROR]', e.message); }
  return null;
});
ipcMain.handle('state:saveSession', (_, { wsIdx, info }) => {
  try {
    const state = fs.existsSync(appStatePath) ? JSON.parse(fs.readFileSync(appStatePath, 'utf8')) : {};
    if (state.workspaces?.[wsIdx]) { state.workspaces[wsIdx].sessionInfo = info; fs.writeFileSync(appStatePath, JSON.stringify(state, null, 2)); }
    return true;
  } catch { return false; }
});

// ── 履歴 ──
const historyPath = path.join(app.getPath('userData'), 'browse-history.json');
let browseHistory = [];
function loadHistory()     { try { if (fs.existsSync(historyPath)) browseHistory = JSON.parse(fs.readFileSync(historyPath, 'utf8')); } catch { browseHistory = []; } }
function saveHistory()     { try { fs.writeFileSync(historyPath, JSON.stringify(browseHistory, null, 2)); } catch {} }
function addHistory(entry) {
  if (browseHistory[0]?.url === entry.url) return;
  browseHistory.unshift({ ...entry, visitedAt: Date.now() });
  if (browseHistory.length > 1000) browseHistory.length = 1000;
  saveHistory();
}
ipcMain.handle('history:get',   ()     => browseHistory);
ipcMain.handle('history:clear', ()     => { browseHistory = []; saveHistory(); return true; });
ipcMain.handle('history:add',   (_, e) => { addHistory(e); return true; });

// ── ダウンロード履歴 ──
const downloadHistoryPath = path.join(app.getPath('userData'), 'download-history.json');
let downloadHistory = [];
function loadDownloadHistory() { try { if (fs.existsSync(downloadHistoryPath)) downloadHistory = JSON.parse(fs.readFileSync(downloadHistoryPath, 'utf8')); } catch { downloadHistory = []; } }
function saveDownloadHistory() { try { fs.writeFileSync(downloadHistoryPath, JSON.stringify(downloadHistory, null, 2)); } catch {} }
ipcMain.handle('download:getHistory',   () => downloadHistory);
ipcMain.handle('download:clearHistory', () => { downloadHistory = []; saveDownloadHistory(); return true; });

// ── ブラウザインポート ──
const home = os.homedir();
const BROWSER_PATHS = {
  chrome:  { mac: `${home}/Library/Application Support/Google/Chrome/Default`,  win: `${home}/AppData/Local/Google/Chrome/User Data/Default`,  linux: `${home}/.config/google-chrome/Default` },
  edge:    { mac: `${home}/Library/Application Support/Microsoft Edge/Default`, win: `${home}/AppData/Local/Microsoft/Edge/User Data/Default`, linux: `${home}/.config/microsoft-edge/Default` },
  arc:     { mac: `${home}/Library/Application Support/Arc/User Data/Default` },
  vivaldi: { mac: `${home}/Library/Application Support/Vivaldi/Default`,        win: `${home}/AppData/Local/Vivaldi/User Data/Default`,        linux: `${home}/.config/vivaldi/Default` },
};
function getPlatformKey() { return process.platform === 'darwin' ? 'mac' : process.platform === 'win32' ? 'win' : 'linux'; }
function detectAvailableBrowsers() {
  const p = getPlatformKey();
  return Object.entries(BROWSER_PATHS).filter(([,v])=>v[p]&&fs.existsSync(v[p])).map(([name,v])=>({ name, profilePath: v[p] }));
}
function readChromeBookmarks(profilePath) {
  const bmPath = path.join(profilePath, 'Bookmarks');
  if (!fs.existsSync(bmPath)) return [];
  try {
    const results = [];
    function walk(n) { if (n.type==='url') results.push({ name: n.name, url: n.url }); n.children?.forEach(walk); }
    Object.values(JSON.parse(fs.readFileSync(bmPath, 'utf8')).roots ?? {}).forEach(walk);
    return results.slice(0, 200);
  } catch { return []; }
}
ipcMain.handle('import:detect',    ()           => detectAvailableBrowsers());
ipcMain.handle('import:bookmarks', (_, browser) => {
  const p = BROWSER_PATHS[browser]?.[getPlatformKey()];
  return p ? { bookmarks: readChromeBookmarks(p) } : { error: 'パスが見つかりません' };
});

// ── 拡張機能 ──
const extensionsDir    = path.join(app.getPath('userData'), 'extensions');
const loadedExtensions = new Set();

function httpsGet(url) {
  return new Promise((resolve, reject) => {
    https.get(url, { headers: { 'User-Agent': UA } }, res => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) return resolve(httpsGet(res.headers.location));
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end',  () => resolve(Buffer.concat(chunks)));
      res.on('error', reject);
    }).on('error', reject);
  });
}
function extractZipFromCrx(buf) {
  if (buf[0] === 0x50 && buf[1] === 0x4B) return buf;
  const magic = buf.slice(0,4).toString('ascii');
  const ver   = buf.readUInt32LE(4);
  if (magic === 'Cr24') {
    if (ver === 2) { const pk = buf.readUInt32LE(8), sk = buf.readUInt32LE(12); return buf.slice(16 + pk + sk); }
    if (ver === 3) return buf.slice(12 + buf.readUInt32LE(8));
  }
  if (magic === 'CrX3') return buf.slice(12 + buf.readUInt32LE(8));
  return null;
}
function extractZip(zipBuf, destDir) {
  return new Promise((resolve, reject) => {
    try { const Z = require('adm-zip'); new Z(zipBuf).extractAllTo(destDir, true); resolve(); }
    catch(e) { reject(e); }
  });
}
async function loadExtensionToAllSessions(extDir, extId) {
  const sessions = [];
  for (const p of ['persist:main','persist:ws-main']) try { sessions.push(session.fromPartition(p)); } catch {}
  try {
    const state = JSON.parse(fs.readFileSync(appStatePath, 'utf8'));
    for (const ws of (state.workspaces ?? [])) if (ws.id) try { sessions.push(session.fromPartition(`persist:ws-${ws.id}`)); } catch {}
  } catch {}
  for (const ses of sessions) try { await ses.loadExtension(extDir, { allowFileAccess: true }); } catch(e) { console.log('loadExtension error:', e.message); }
  loadedExtensions.add(extId);
}
async function downloadAndInstallExtension(extId) {
  if (!fs.existsSync(extensionsDir)) fs.mkdirSync(extensionsDir, { recursive: true });
  const extDir = path.join(extensionsDir, extId);
  if (fs.existsSync(extDir) && fs.existsSync(path.join(extDir, 'manifest.json'))) {
    if (!loadedExtensions.has(extId)) await loadExtensionToAllSessions(extDir, extId);
    return { ok: true, cached: true };
  }
  const crxUrls = [
    `https://clients2.google.com/service/update2/crx?response=redirect&prodversion=136.0.0.0&acceptformat=crx3,crx2&x=id%3D${extId}%26installsource%3Dondemand%26uc`,
    `https://clients2.google.com/service/update2/crx?response=redirect&prodversion=134.0.0.0&acceptformat=crx3&x=id%3D${extId}%26installsource%3Dondemand%26uc`,
    `https://extension-updates.googleapis.com/service/update2/crx?response=redirect&os=mac&arch=arm64&prodversion=136.0.0.0&x=id%3D${extId}%26installsource%3Dondemand%26uc`,
  ];
  let crxBuf = null;
  for (const url of crxUrls) {
    try { const b = await httpsGet(url); if (b.length > 100) { crxBuf = b; break; } } catch(e) { console.warn('[EXT] failed:', url, e.message); }
  }
  if (!crxBuf) throw new Error('CRX download failed');
  const zip = extractZipFromCrx(crxBuf);
  if (!zip) throw new Error('CRX parse failed');
  fs.mkdirSync(extDir, { recursive: true });
  await extractZip(zip, extDir);
  await loadExtensionToAllSessions(extDir, extId);
  return { ok: true };
}

ipcMain.handle('ext:install', async (_, extId) => {
  try { await downloadAndInstallExtension(extId); uiView?.webContents.send('ext:installed', { extId }); return { ok: true }; }
  catch(e) { console.log('Extension install error:', e.message); return { error: e.message }; }
});
ipcMain.handle('ext:openPopup', async (_, extId) => {
  try {
    const ses = session.fromPartition('persist:ws-main');
    const ext = ses.getAllExtensions().find(e => e.id === extId);
    if (!ext) return { error: '拡張機能が見つかりません' };
    const popup = new BrowserWindow({
      width: 380, height: 520, resizable: true, parent: mainWindow, modal: false,
      webPreferences: { session: ses, nodeIntegration: false, contextIsolation: true },
      titleBarStyle: 'hiddenInset', title: ext.name,
    });
    popup.loadURL(`chrome-extension://${extId}/${ext.manifest.action?.default_popup ?? ext.manifest.browser_action?.default_popup ?? 'popup.html'}`);
    popup.once('ready-to-show', () => popup.show());
    return { ok: true };
  } catch(e) { return { error: e.message }; }
});
function resolveExtMessage(extDir, str) {
  if (!str?.startsWith('__MSG_')) return str;
  const key = str.replace(/^__MSG_/, '').replace(/__$/, '');
  const localesDir = path.join(extDir, '_locales');
  if (!fs.existsSync(localesDir)) return str;
  for (const loc of [...new Set(['en','ja',...fs.readdirSync(localesDir)])]) {
    try { const msgs = JSON.parse(fs.readFileSync(path.join(localesDir, loc, 'messages.json'), 'utf8')); const e = msgs[key]??msgs[key.toLowerCase()]; if (e?.message) return e.message; } catch {}
  }
  return key;
}
ipcMain.handle('ext:list', () => {
  try {
    if (!fs.existsSync(extensionsDir)) return [];
    return fs.readdirSync(extensionsDir).map(id => {
      const extDir = path.join(extensionsDir, id);
      if (!fs.existsSync(path.join(extDir, 'manifest.json'))) return null;
      try { const m = JSON.parse(fs.readFileSync(path.join(extDir,'manifest.json'),'utf8')); return { id, name: resolveExtMessage(extDir,m.name)||id, version: m.version||'', description: resolveExtMessage(extDir,m.description)||'' }; }
      catch { return { id, name: id, version: '', description: '' }; }
    }).filter(Boolean);
  } catch { return []; }
});
ipcMain.handle('ext:uninstall', async (_, extId) => {
  try {
    if (!extId || !/^[a-z]{32}$/.test(extId)) return { error: '無効なID' };
    const extDir = path.join(extensionsDir, extId);
    if (!fs.existsSync(extDir)) return { error: '拡張機能が見つかりません' };
    const sessions = [session.defaultSession];
    for (const p of ['persist:main','persist:ws-main']) try { sessions.push(session.fromPartition(p)); } catch {}
    try {
      const state = JSON.parse(fs.readFileSync(appStatePath,'utf8'));
      for (const ws of (state.workspaces??[])) if (ws.id) try { sessions.push(session.fromPartition(`persist:ws-${ws.id}`)); } catch {}
    } catch {}
    for (const ses of sessions) try { if (ses.getAllExtensions().find(e=>e.id===extId)) await ses.removeExtension(extId); } catch(e) { console.log('removeExtension error:', e.message); }
    loadedExtensions.delete(extId);
    fs.rmSync(extDir, { recursive: true, force: true });
    return { ok: true };
  } catch(e) { return { error: e.message }; }
});

// ── テーマ ──
ipcMain.on('theme:set', (_, dark) => {
  shadowView?.webContents.send('theme:changed', dark);
  // shadowViewの背景色もテーマに合わせて切り替え
  if (shadowView) shadowView.setBackgroundColor(dark ? '#1e1e1e' : '#ffffff');
  mainWindow.setBackgroundColor('#00000000');
  mainWindow.setVibrancy(null);
});

// ── トリガー（IPC経由） ──
ipcMain.on('trig:enter', () => { if (!sbIsOpen && activeTabId) { layoutUIExpanded(); bringUIToFront(); uiView.webContents.send('trig:enter'); } });
ipcMain.on('trig:leave', () => { if (!sbIsOpen && activeTabId) { layoutUI(); uiView.webContents.send('trig:leave'); } });

// ── アプリライフサイクル ──
app.whenReady().then(() => { loadHistory(); loadDownloadHistory(); createWindow(); });
// 起動時に既存の拡張機能を再読み込み
app.whenReady().then(async () => {
  if (!fs.existsSync(extensionsDir)) return;
  for (const d of fs.readdirSync(extensionsDir)) {
    const extDir = path.join(extensionsDir, d);
    if (fs.existsSync(path.join(extDir,'manifest.json'))) await loadExtensionToAllSessions(extDir, d).catch(()=>{});
  }
});

// デフォルト拡張機能: 初回起動時に未インストールのものだけDL&インストール
const DEFAULT_EXTENSIONS = [
  'ddkjiahejlhfcafbddmgiahcphecmpfh',
  'eimadpbcbfnmbkopoojfekhnkhdbieeh',
  'aapbdbdomjkkjkaonfhkkikfgjllcleb',
  'cofdbpoegempjloogbagkncekinflcnj',
  'abefllafeffhoiadldggcalfgbofohfa',
];
app.whenReady().then(async () => {
  for (const extId of DEFAULT_EXTENSIONS) {
    const extDir = path.join(extensionsDir, extId);
    if (fs.existsSync(path.join(extDir, 'manifest.json'))) continue; // 既にインストール済み
    console.log('[DEFAULT EXT] installing:', extId);
    await downloadAndInstallExtension(extId).catch(e => console.warn('[DEFAULT EXT] failed:', extId, e.message));
  }
});

app.on('window-all-closed', () => { if (process.platform !== 'darwin' || forceQuit) app.quit(); });
app.on('activate', () => { if (mainWindow) { mainWindow.show(); mainWindow.focus(); } else createWindow(); });
app.on('before-quit', e => {
  if (forceQuit || !uiView || uiView.webContents.isDestroyed()) return;
  e.preventDefault();
  forceQuit = true;
  uiView.webContents.send('app:save-before-quit');
  const t = setTimeout(() => app.quit(), 2000);
  ipcMain.once('app:save-complete', () => { clearTimeout(t); app.quit(); });
});
