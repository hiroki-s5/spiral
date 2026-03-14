const { app, BrowserWindow, BrowserView, ipcMain, Menu, Notification, nativeImage, Tray, globalShortcut, session, screen, protocol } = require('electron');
const path  = require('path');
const fs    = require('fs');
const os    = require('os');
const https  = require('https');
const AdmZip = require('adm-zip');

// ── コマンドラインスイッチ ──
for (const sw of [
  'enable-accelerated-2d-canvas', 'enable-gpu-rasterization', 'enable-zero-copy',
  'disable-software-rasterizer', 'enable-oop-rasterization',
  'enable-gpu-memory-buffer-compositor-resources', 'enable-native-gpu-memory-buffers',
  'memory-pressure-off', 'enable-quic', 'enable-tcp-fast-open',
  'no-sandbox', 'disable-setuid-sandbox',
]) app.commandLine.appendSwitch(sw);

app.commandLine.appendSwitch('js-flags', '--max-old-space-size=1024 --max-semi-space-size=64 --expose-gc');
app.commandLine.appendSwitch('process-per-site');
app.commandLine.appendSwitch('renderer-process-limit', '6');
app.commandLine.appendSwitch('disk-cache-size',  String(256 * 1024 * 1024));
app.commandLine.appendSwitch('media-cache-size', String(64  * 1024 * 1024));
app.commandLine.appendSwitch('quic-version', 'h3');
app.commandLine.appendSwitch('disable-blink-features', 'AutomationControlled');
app.commandLine.appendSwitch('enable-features',  'NetworkServiceInProcess2,ParallelDownloading,PrefetchDNS');
app.commandLine.appendSwitch('disable-features', 'OverscrollHistoryNavigation,IntensiveWakeUpThrottling,NetworkTimeServiceQuerying,TimerThrottlingForBackgroundTabs,AlignWakeUps,DevToolsAvailabilityCheckEnabled');

// ── 定数 ──
const UA     = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/136.0.7103.92 Safari/537.36';
const MARGIN = 10;
const RADIUS = 12;

// WebViewに注入するCSS（角丸 + スクロール挙動）
// - html に border-radius + clip-path で角丸クリッピング（overflow:hidden はスクロールを殺すので使わない）
// - did-finish-load が複数回発火してもinsertCSSは累積しないので問題なし
const WEBVIEW_CSS = `
  html { border-radius: ${RADIUS}px !important; }
  * { overscroll-behavior: none !important; }
  body > div[style*="position: fixed"][style*="bottom"] { display: none !important; }
`;

// 角丸を強制維持するJS（サイトのCSSが上書きしてもMutationObserverで復元）
const WEBVIEW_JS = `(function(){
  function applyRadius() {
    document.documentElement.style.setProperty("border-radius", "${RADIUS}px", "important");
  }
  applyRadius();
  new MutationObserver(applyRadius).observe(document.documentElement, {
    attributes: true, attributeFilter: ["style", "class"]
  });
})();`;

// ── 分割レイアウト ──
let splitIds    = [];   // 表示中の分割タブID配列（空=分割なし）
// 比率は各分割パターンで独立管理
// 2分割: { x: 0〜1 }  (左幅の割合)
// 3分割: { x: 0〜1, y: 0〜1 }  (左幅, 右の上高さの割合)
// 4分割: { x: 0〜1, y: 0〜1 }  (左幅, 上高さの割合)
let splitRatios = { x: 0.5, y: 0.5 };
const GAP = 4;

function calcSplitBounds() {
  const [w, h] = getWH();
  const n = splitIds.length;
  const x0 = MARGIN, y0 = MARGIN;
  const totalW = w - MARGIN * 2, totalH = h - MARGIN * 2;
  const rx = Math.min(0.85, Math.max(0.15, splitRatios.x));
  const ry = Math.min(0.85, Math.max(0.15, splitRatios.y));
  const cw = Math.max(60, Math.floor((totalW - GAP) * rx));
  const rh = Math.max(60, Math.floor((totalH - GAP) * ry));
  const bounds = [];
  if (n === 2) {
    bounds.push({ x: x0,              y: y0, width: cw,              height: totalH });
    bounds.push({ x: x0 + cw + GAP,   y: y0, width: totalW - cw - GAP, height: totalH });
  } else if (n === 3) {
    bounds.push({ x: x0,            y: y0,             width: cw,              height: totalH });
    bounds.push({ x: x0 + cw + GAP, y: y0,             width: totalW - cw - GAP, height: rh });
    bounds.push({ x: x0 + cw + GAP, y: y0 + rh + GAP, width: totalW - cw - GAP, height: totalH - rh - GAP });
  } else { // 4
    bounds.push({ x: x0,            y: y0,            width: cw,              height: rh });
    bounds.push({ x: x0 + cw + GAP, y: y0,            width: totalW - cw - GAP, height: rh });
    bounds.push({ x: x0,            y: y0 + rh + GAP, width: cw,              height: totalH - rh - GAP });
    bounds.push({ x: x0 + cw + GAP, y: y0 + rh + GAP, width: totalW - cw - GAP, height: totalH - rh - GAP });
  }
  return bounds;
}

function layoutSplitViews() {
  const n = splitIds.length;
  if (n < 2) return;
  const bounds = calcSplitBounds();
  splitIds.forEach((id, i) => {
    const v = webViews.get(id);
    if (v && bounds[i]) v.setBounds(bounds[i]);
  });
  updateSepViews();
}

// ── セパレーターView（細いBrowserView方式） ──
const SEP_SIZE = 10; // セパレーターの幅/高さ
let sepViews = []; // 各セパレーターのBrowserView

function getSepHtml(axis) {
  return `<!DOCTYPE html><html><head><meta charset="UTF-8"><style>
*{margin:0;padding:0;}
html,body{width:100%;height:100%;background:transparent;overflow:hidden;}
#sep{
  width:100%;height:100%;
  background:transparent;
  cursor:${axis === 'x' ? 'ew-resize' : 'ns-resize'};
  transition:background .15s;
}
#sep:hover,#sep.dragging{background:rgba(120,120,120,0.4);}
</style></head><body>
<div id="sep"></div>
<script>
const {ipcRenderer} = require('electron');
const sep = document.getElementById('sep');
let dragging = false;
sep.addEventListener('mousedown', e => {
  e.preventDefault();
  dragging = true;
  sep.classList.add('dragging');
  document.body.style.cursor = '${axis === 'x' ? 'ew-resize' : 'ns-resize'}';
  ipcRenderer.send('split:drag-start', '${axis}');
});
document.addEventListener('mousemove', e => {
  if (!dragging) return;
  ipcRenderer.send('split:drag-move', { axis: '${axis}', x: e.screenX, y: e.screenY });
});
document.addEventListener('mouseup', () => {
  if (!dragging) return;
  dragging = false;
  sep.classList.remove('dragging');
  document.body.style.cursor = '';
  ipcRenderer.send('split:drag-end', '${axis}');
});
<\/script></body></html>`;
}

function updateSepViews() {
  // 既存を全削除
  sepViews.forEach(v => {
    try { mainWindow.removeBrowserView(v); } catch {}
    try { v.webContents.destroy(); } catch {}
  });
  sepViews = [];

  if (splitIds.length < 2) return;

  const [w, h] = getWH();
  const bounds = calcSplitBounds();
  const n = splitIds.length;
  const half = Math.floor(SEP_SIZE / 2);

  // 縦セパレーター（全パターン）
  const vx = bounds[0].x + bounds[0].width - half;
  const vy = MARGIN;
  const vh = h - MARGIN * 2;
  addSepView('x', { x: vx, y: vy, width: SEP_SIZE, height: vh });

  // 横セパレーター（3分割・4分割）
  if (n === 3) {
    const hx = bounds[1].x;
    const hy = bounds[1].y + bounds[1].height - half;
    const hw = bounds[1].width;
    addSepView('y', { x: hx, y: hy, width: hw, height: SEP_SIZE });
  } else if (n === 4) {
    const hx = MARGIN;
    const hy = bounds[0].y + bounds[0].height - half;
    const hw = w - MARGIN * 2;
    addSepView('y', { x: hx, y: hy, width: hw, height: SEP_SIZE });
  }

  // WebViewとuiViewの間に挿入（uiViewを最前面に）
  bringUIToFront();
}

function addSepView(axis, b) {
  const v = new BrowserView({
    webPreferences: { nodeIntegration: true, contextIsolation: false },
  });
  mainWindow.addBrowserView(v);
  v.setBounds(b);
  v._sepAxis = axis;
  v._sepBounds = b;
  v.webContents.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(getSepHtml(axis)));
  sepViews.push(v);
}

function destroySepViews() {
  sepViews.forEach(v => {
    try { mainWindow.removeBrowserView(v); } catch {}
    try { v.webContents.destroy(); } catch {}
  });
  sepViews = [];
}


function clearSplitLayout() {
  splitIds.forEach(id => {
    if (id !== activeTabId) {
      const v = webViews.get(id);
      if (v) v.setBounds({ x: -9999, y: 0, width: 1, height: 1 });
    }
  });
  splitIds    = [];
  splitRatios = { x: 0.5, y: 0.5 };
  destroySepViews();
  if (activeTabId) {
    const v = webViews.get(activeTabId);
    if (v) layoutWebView(v);
  }
  if (!uiView?.webContents.isDestroyed()) uiView.webContents.send('split:layout', null);
}

let mainWindow, uiView, shadowView, aiWindow, dragView;
let tray        = null;
let forceQuit   = false;
let sbIsOpen    = false;
let _trigActive = false;
let _leaveTimer_sb = null;
let _sbCooldown = false; // sb:close後の再トリガークールダウン
let activeTabId = null;
let _aiPanelOpen = false;
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
  const topOffset = MARGIN;
  const viewH = h - MARGIN - topOffset;
  view.setBounds({ x: MARGIN, y: topOffset, width: w - MARGIN * 2, height: viewH });
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
function layoutDragView() {
  const [w] = getWH();
  // 上のMARGIN帯（10px）だけをドラッグ可能にする
  if (dragView) dragView.setBounds({ x: 0, y: 0, width: w, height: MARGIN });
}
function bringUIToFront() {
  // dragViewをuiViewの直下に置き、uiViewを最前面に
  if (dragView) try { mainWindow.setTopBrowserView(dragView); } catch {}
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
      userAgent: UA, partition: 'persist:main', webSecurity: true, sandbox: false,
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
    // Electronの痕跡を全て削除
    delete h['X-Electron-Version'];
    delete h['X-Requested-With'];
    delete h['Electron-Version'];
    delete h['electron-version'];
    // Chromeとして振る舞うためのヘッダーを設定
    h['Sec-CH-UA']                  = '"Chromium";v="136", "Google Chrome";v="136", "Not-A.Brand";v="24"';
    h['Sec-CH-UA-Mobile']           = '?0';
    h['Sec-CH-UA-Platform']         = '"macOS"';
    h['Sec-CH-UA-Platform-Version'] = '"15.0.0"';
    h['Sec-CH-UA-Full-Version']     = '"136.0.7103.92"';
    h['Sec-CH-UA-Arch']             = '"arm"';
    h['Sec-CH-UA-Bitness']          = '"64"';
    h['Sec-CH-UA-Model']            = '""';
    if (!h['Accept-Encoding']) h['Accept-Encoding'] = 'gzip, deflate, br, zstd';
    if (details.url?.includes('google.com') || details.url?.includes('accounts.google')) {
      h['Sec-Fetch-Site'] = h['Sec-Fetch-Site'] || 'same-origin';
      h['Sec-Fetch-Mode'] = h['Sec-Fetch-Mode'] || 'navigate';
      h['Sec-Fetch-Dest'] = h['Sec-Fetch-Dest'] || 'document';
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

  // dragView: 上部ドラッグ用の透明View（uiViewが幅24pxに縮んでいる間もウィンドウ移動できるように）
  dragView = new BrowserView({
    backgroundColor: '#00000000',
    webPreferences: { nodeIntegration: false, contextIsolation: true },
  });
  mainWindow.addBrowserView(dragView);
  layoutDragView();
  dragView.webContents.loadURL('data:text/html,<style>html,body{margin:0;width:100%;height:100%;background:transparent;-webkit-app-region:drag;-webkit-user-select:none;}</style>');
  try { mainWindow.setTopBrowserView(uiView); } catch {}

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
    if (splitIds.length >= 2) {
      layoutSplitViews();
    } else if (activeTabId) {
      const v = webViews.get(activeTabId);
      if (v) layoutWebView(v);
    }
    layoutShadow();
    layoutDragView();
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
  // ENTER: 左端30px以内に入ったら即開く
  // LEAVE: サイドバー幅（280px）+ 余裕（40px）を超えるまで閉じない（ヒステリシス）
  const SB_CLOSE_THRESHOLD = MARGIN + 280 + 40; // サイドバー幅+余裕
  const LEAVE_DELAY = 400; // msec
  const trigPoll = setInterval(() => {
    if (!mainWindow || mainWindow.isDestroyed()) { clearInterval(trigPoll); return; }
    if (!mainWindow.isVisible() || mainWindow.isMinimized()) return;
    const cursor = screen.getCursorScreenPoint();
    const bounds = mainWindow.getBounds();
    const relX   = cursor.x - bounds.x;
    const relY   = cursor.y - bounds.y;
    const inWin  = relX >= 0 && relX <= bounds.width && relY >= 0 && relY <= bounds.height;
    const atLeft = inWin && relX <= MARGIN + 20;
    // サイドバーが開いている間はSB_CLOSE_THRESHOLDまで許容
    const inSBArea = inWin && relX <= SB_CLOSE_THRESHOLD;
    if (atLeft && !_trigActive && !_sbCooldown) {
      clearTimeout(_leaveTimer_sb); _leaveTimer_sb = null;
      _trigActive = true;
      if (!sbIsOpen && activeTabId) { layoutUIExpanded(); bringUIToFront(); uiView.webContents.send('trig:enter'); }
    } else if (_trigActive && !inSBArea) {
      // SBエリア外に出たら遅延付きでleave
      if (!_leaveTimer_sb) {
        _leaveTimer_sb = setTimeout(() => {
          _leaveTimer_sb = null;
          // タイマー発火時点でまだSBエリア外かチェック
          const c2 = screen.getCursorScreenPoint();
          const b2 = mainWindow.getBounds();
          const rx2 = c2.x - b2.x;
          const ry2 = c2.y - b2.y;
          const inWin2 = rx2 >= 0 && rx2 <= b2.width && ry2 >= 0 && ry2 <= b2.height;
          if (!inWin2 || rx2 > SB_CLOSE_THRESHOLD) {
            _trigActive = false;
            if (!sbIsOpen && activeTabId) { layoutUI(); uiView.webContents.send('trig:leave'); }
          }
        }, LEAVE_DELAY);
      }
    } else if (_trigActive && inSBArea) {
      // SBエリア内に戻ったらタイマーキャンセル
      clearTimeout(_leaveTimer_sb); _leaveTimer_sb = null;
    }
  }, 16);
  // AIパネルの開閉状態をrendererから受け取る



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
  // 閉じた直後は_trigActiveをリセットして即再トリガー可能に
  // ただし閉じた操作でそのまま左端にいる場合の誤再展開を防ぐため1秒クールダウン
  _trigActive = false;
  clearTimeout(_leaveTimer_sb);
  _leaveTimer_sb = null;
  // 1秒間は再展開しない（閉じた直後に誤って再展開されるのを防ぐ）
  _sbCooldown = true;
  setTimeout(() => { _sbCooldown = false; }, 1000);
  if (splitIds.length >= 2) {
    layoutSplitViews();
  } else if (activeTabId) {
    const v = webViews.get(activeTabId);
    if (v) { layoutWebView(v); try { mainWindow.setTopBrowserView(v); } catch {} }
  }
  layoutUI();
  bringUIToFront();
});

// ── 分割 IPC ──
ipcMain.handle('split:set', (_, ids) => {
  splitIds.forEach(id => {
    if (!ids.includes(id) && id !== activeTabId) {
      const v = webViews.get(id);
      if (v) v.setBounds({ x: -9999, y: 0, width: 1, height: 1 });
    }
  });
  splitIds    = ids;
  splitRatios = { x: 0.5, y: 0.5 }; // リセット
  ids.forEach(id => {
    const v = webViews.get(id);
    if (v) { try { mainWindow.addBrowserView(v); } catch {} }
  });
  layoutSplitViews();
  bringUIToFront();
  return { ok: true };
});

ipcMain.handle('split:resize', (_, { x, y }) => {
  if (x !== undefined) splitRatios.x = Math.min(0.85, Math.max(0.15, x));
  if (y !== undefined) splitRatios.y = Math.min(0.85, Math.max(0.15, y));
  layoutSplitViews();
  return { ok: true };
});

// セパレーターBrowserViewからのドラッグ
let _sepDragging = null;
ipcMain.on('split:drag-start', (_, axis) => { _sepDragging = axis; });
ipcMain.on('split:drag-end',   ()         => { _sepDragging = null; updateSepViews(); });
ipcMain.on('split:drag-move',  (_, { axis, x, y }) => {
  if (!_sepDragging) return;
  const [w, h] = getWH();
  const winBounds = mainWindow.getBounds();
  const relX = x - winBounds.x;
  const relY = y - winBounds.y;
  const totalW = w - MARGIN * 2;
  const totalH = h - MARGIN * 2;
  if (axis === 'x') {
    splitRatios.x = Math.min(0.85, Math.max(0.15, (relX - MARGIN) / (totalW - GAP)));
  } else {
    splitRatios.y = Math.min(0.85, Math.max(0.15, (relY - MARGIN) / (totalH - GAP)));
  }
  // WebViewだけ即時更新（sepViewsはdrag-endで更新してちらつき防止）
  const bounds = calcSplitBounds();
  splitIds.forEach((id, i) => {
    const v = webViews.get(id);
    if (v && bounds[i]) v.setBounds(bounds[i]);
  });
  // sepViewsの位置もリアルタイム更新
  const half = Math.floor(SEP_SIZE / 2);
  sepViews.forEach(sv => {
    if (sv._sepAxis === 'x') {
      sv.setBounds({ x: bounds[0].x + bounds[0].width - half, y: MARGIN, width: SEP_SIZE, height: h - MARGIN * 2 });
    } else {
      const n = splitIds.length;
      if (n === 3) {
        sv.setBounds({ x: bounds[1].x, y: bounds[1].y + bounds[1].height - half, width: bounds[1].width, height: SEP_SIZE });
      } else {
        sv.setBounds({ x: MARGIN, y: bounds[0].y + bounds[0].height - half, width: w - MARGIN * 2, height: SEP_SIZE });
      }
    }
  });
});

ipcMain.handle('split:clear', () => {
  clearSplitLayout();
  bringUIToFront();
  return { ok: true };
});


ipcMain.handle('tab:create', async (_, payload) => {
  const url          = typeof payload === 'string' ? payload : (payload?.url ?? null);
  const partitionKey = (typeof payload === 'object' && payload?.partition) ? payload.partition : 'main';
  const partition    = `persist:ws-${partitionKey}`;
  setupSession(session.fromPartition(partition));

  const id   = ++tabIdCounter;
  const view = new BrowserView({
    backgroundColor: '#00000000',
    webPreferences: {
      contextIsolation: false, nodeIntegration: false, backgroundThrottling: true,
      userAgent: UA, partition, webSecurity: true, sandbox: false,
      preload: path.join(__dirname, 'stealth-preload.js'),
      spellcheck: false, disableBlinkFeatures: 'AutomationControlled', navigateOnDragDrop: false,
    },
  });
  webViews.set(id, view);
  view._active = false;
  view._url    = '';

  // webContents単位でもUAを明示的にセット（session設定より優先される）
  view.webContents.setUserAgent(UA);
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
  view.webContents.on('page-favicon-updated', (_, f) => {
    const fav = f && f[0];
    if (fav) send('tab:favicon', { id, favicon: fav });
  });
  // did-finish-load時もfaviconが取れていなければgoogle S2でフォールバック
  view.webContents.on('did-finish-load', () => {
    const url = view.webContents.getURL();
    if (!url || !url.startsWith('http')) return;
    try {
      const hostname = new URL(url).hostname;
      const fallback = 'https://www.google.com/s2/favicons?domain=' + hostname + '&sz=64';
      send('tab:favicon:fallback', { id, favicon: fallback });
    } catch {}
  });
  view.webContents.on('did-start-loading',    () => send('tab:loading', { id, loading: true  }));
  view.webContents.on('did-stop-loading',     () => send('tab:loading', { id, loading: false }));

  // 角丸CSS+JS注入: 複数タイミングで注入し、MutationObserverで上書きを防ぐ
  const injectCSS = () => view.webContents.insertCSS(WEBVIEW_CSS).catch(() => {});
  const injectJS  = () => view.webContents.executeJavaScript(WEBVIEW_JS, true).catch(() => {});
  view.webContents.on('dom-ready',            () => { injectCSS(); injectJS(); });
  view.webContents.on('did-finish-load',      () => { injectCSS(); injectJS(); });
  view.webContents.on('did-navigate-in-page', () => { injectCSS(); injectJS(); });


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
    // 分割表示中のタブは画面外に飛ばさない
    if (vid !== id && !splitIds.includes(vid)) {
      v.setBounds({ x: -9999, y: 0, width: 1, height: 1 });
      try { v.webContents.setBackgroundThrottling(true); } catch {}
    }
  }
  const view = webViews.get(id);
  if (view) {
    // 分割中は全体を再レイアウト、通常はアクティブタブのみ
    if (splitIds.length >= 2) {
      layoutSplitViews();
    } else {
      layoutWebView(view);
    }
    view._active = true;
    activeTabId  = id;
    try { view.webContents.setBackgroundThrottling(false); } catch {}
    if (sbIsOpen) layoutUIExpanded(); else layoutUI();
    bringUIToFront();
  }
  uiView.webContents.send('tab:activated', { id });
});

ipcMain.handle('tab:close', async (_, id) => {
  const v = webViews.get(id);
  if (!v) return;
  // 分割中にこのタブが含まれていたら分割解除
  if (splitIds.includes(id)) clearSplitLayout();
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

// AI用: ページのテキストコンテンツを取得
// ── Chrome拡張機能インストール ──
const EXT_DIR = path.join(app.getPath('userData'), 'extensions');
if (!fs.existsSync(EXT_DIR)) fs.mkdirSync(EXT_DIR, { recursive: true });

// インストール済み拡張をすべてのsessionに読み込む
async function loadAllExtensions() {
  const sessions = [session.defaultSession];
  for (const p of ['persist:main', 'persist:ws-main', 'persist:ws-ws0'])
    sessions.push(session.fromPartition(p));
  const dirs = fs.existsSync(EXT_DIR) ? fs.readdirSync(EXT_DIR).map(d => path.join(EXT_DIR, d)).filter(d => fs.statSync(d).isDirectory()) : [];
  for (const ses of sessions)
    for (const extPath of dirs)
      await ses.loadExtension(extPath, { allowFileAccess: true }).catch(() => {});
}
app.on('ready', () => setTimeout(loadAllExtensions, 2000));

ipcMain.handle('ext:install', async (_, extId) => {
  try {
    // Chrome Web Store から CRX をダウンロード
    const crxUrl = `https://clients2.google.com/service/update2/crx?response=redirect&prodversion=136.0.0.0&acceptformat=crx3&x=id%3D${extId}%26uc`;
    const crxPath = path.join(EXT_DIR, extId + '.crx');
    await new Promise((resolve, reject) => {
      const file = fs.createWriteStream(crxPath);
      const request = (url, depth = 0) => {
        if (depth > 5) { reject(new Error('Too many redirects')); return; }
        https.get(url, res => {
          if (res.statusCode === 301 || res.statusCode === 302) {
            request(res.headers.location, depth + 1);
          } else if (res.statusCode === 200) {
            res.pipe(file);
            file.on('finish', () => { file.close(); resolve(); });
          } else {
            reject(new Error('HTTP ' + res.statusCode));
          }
        }).on('error', reject);
      };
      request(crxUrl);
    });

    // CRX3 ヘッダーをスキップしてZIP部分を抽出
    const crxBuf = fs.readFileSync(crxPath);
    let zipStart = 0;
    const magic = crxBuf.readUInt32LE(0);
    if (magic === 0x43723234) { // 'Cr24' little-endian
      const version = crxBuf.readUInt32LE(4);
      if (version === 3) {
        // CRX3: magic(4) + version(4) + header_size(4) + proto_header(header_size) + zip
        const headerSize = crxBuf.readUInt32LE(8);
        zipStart = 12 + headerSize;
      } else if (version === 2) {
        // CRX2: magic(4) + version(4) + pubkey_len(4) + sig_len(4) + pubkey + sig + zip
        const pubKeyLen = crxBuf.readUInt32LE(8);
        const sigLen    = crxBuf.readUInt32LE(12);
        zipStart = 16 + pubKeyLen + sigLen;
      }
    }
    // ZIPマジックバイト(PK\x03\x04)を探してzipStartを補正
    const PK = Buffer.from([0x50, 0x4B, 0x03, 0x04]);
    let pkOffset = crxBuf.indexOf(PK, zipStart);
    if (pkOffset === -1) pkOffset = crxBuf.indexOf(PK, 0);
    if (pkOffset !== -1 && pkOffset >= zipStart) zipStart = pkOffset;
    const zipBuf = crxBuf.slice(zipStart);
    const extPath = path.join(EXT_DIR, extId);
    if (!fs.existsSync(extPath)) fs.mkdirSync(extPath, { recursive: true });
    const zip = new AdmZip(zipBuf);
    zip.extractAllTo(extPath, true);
    fs.unlinkSync(crxPath);

    // 全sessionに読み込む
    const sessions = [session.defaultSession];
    for (const p of ['persist:main', 'persist:ws-main', 'persist:ws-ws0'])
      sessions.push(session.fromPartition(p));
    for (const ses of sessions)
      await ses.loadExtension(extPath, { allowFileAccess: true }).catch(() => {});

    if (!uiView?.webContents.isDestroyed()) uiView.webContents.send('ext:installed', { extId });
    return { ok: true };
  } catch (e) {
    return { error: e.message };
  }
});

ipcMain.handle('ext:uninstall', async (_, extId) => {
  try {
    const extPath = path.join(EXT_DIR, extId);
    if (fs.existsSync(extPath)) fs.rmSync(extPath, { recursive: true, force: true });
    return { ok: true };
  } catch (e) {
    return { error: e.message };
  }
});

ipcMain.handle('ext:list', async () => {
  try {
    const dirs = fs.existsSync(EXT_DIR)
      ? fs.readdirSync(EXT_DIR).filter(d => fs.statSync(path.join(EXT_DIR, d)).isDirectory())
      : [];
    return { extensions: dirs };
  } catch (e) {
    return { extensions: [] };
  }
});

ipcMain.handle('ext:openPopup', async (_, extId) => {
  // 将来実装
  return { ok: false, error: 'not implemented' };
});

// ── オートフィル（パスワード注入） ──
ipcMain.handle('tab:fillCredentials', async (_, { id, user, pass }) => {
  const view = webViews.get(id);
  if (!view) return { error: 'tab not found' };
  try {
    await view.webContents.executeJavaScript(`(function(){
      try {
        // ユーザー名フィールドを探す
        const userSel = 'input[type="email"],input[type="text"][name*="user"],input[type="text"][name*="email"],input[type="text"][name*="login"],input[autocomplete*="username"],input[autocomplete*="email"]';
        const passSel = 'input[type="password"]';
        function fill(el, val) {
          if (!el) return;
          const nativeSet = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
          nativeSet.call(el, val);
          el.dispatchEvent(new Event('input',   { bubbles: true }));
          el.dispatchEvent(new Event('change',  { bubbles: true }));
          el.dispatchEvent(new Event('keydown', { bubbles: true }));
          el.dispatchEvent(new Event('keyup',   { bubbles: true }));
        }
        const userEl = document.querySelector(userSel);
        const passEl = document.querySelector(passSel);
        fill(userEl, ${JSON.stringify(user)});
        fill(passEl, ${JSON.stringify(pass)});
      } catch(e) { console.error('autofill error:', e); }
    })();`);
    return { ok: true };
  } catch (e) { return { error: e.message }; }
});

ipcMain.handle('tab:getPageText', async (_, id) => {
  const view = webViews.get(id);
  if (!view) return '';
  try {
    const text = await view.webContents.executeJavaScript(`(function() {
      try {
        const clone = document.cloneNode(true);
        clone.querySelectorAll('script,style,noscript,nav,footer,header,aside,[role="navigation"],[aria-hidden="true"]').forEach(el => el.remove());
        return (clone.body || clone.documentElement)?.innerText || '';
      } catch(e) { return document.body?.innerText || ''; }
    })()`);
    return (text || '').replace(/[ \t]{3,}/g, ' ').replace(/\n{4,}/g, '\n\n').trim().slice(0, 5000);
  } catch { return ''; }
});
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

// ── パスワードCSVインポート ──
// ── パスワード自動同期（Chrome Keychain復号） ──
const { execSync } = require('child_process');

async function readChromePasswords(browser) {
  try {
    const profilePath = BROWSER_PATHS[browser]?.[getPlatformKey()];
    if (!profilePath) return { error: 'ブラウザが見つかりません' };
    const loginDataPath = path.join(profilePath, 'Login Data');
    if (!fs.existsSync(loginDataPath)) return { error: 'Login Dataが見つかりません' };

    // ChromeのKeychainからマスターキーを取得
    let masterKey;
    try {
      const keychainService = browser === 'chrome' ? 'Chrome Safe Storage' :
                              browser === 'edge'   ? 'Microsoft Edge Safe Storage' :
                              browser === 'arc'    ? 'Arc Safe Storage' :
                              browser === 'vivaldi'? 'Vivaldi Safe Storage' : 'Chrome Safe Storage';
      const result = execSync(
        `security find-generic-password -s "${keychainService}" -w 2>/dev/null`,
        { encoding: 'utf8', timeout: 5000 }
      ).trim();
      // PBKDF2でAESキーを導出（Chromeと同じ方法）
      const crypto = require('crypto');
      masterKey = crypto.pbkdf2Sync(result, 'saltysalt', 1003, 16, 'sha1');
    } catch (e) {
      return { error: 'Keychainアクセスに失敗しました。macOSの許可ダイアログでアクセスを許可してください。' };
    }

    // Login DataをコピーしてSQLiteで読む（sql.js使用）
    let initSqlJs;
    try { initSqlJs = require('sql.js'); } catch { return { error: 'sql.jsが必要です' }; }
    const tmpPath = path.join(app.getPath('temp'), 'spiral_logindata_tmp');
    fs.copyFileSync(loginDataPath, tmpPath);
    const SQL = await initSqlJs();
    const dbBuf = fs.readFileSync(tmpPath);
    const db = new SQL.Database(dbBuf);
    const result = db.exec('SELECT origin_url, username_value, password_value FROM logins WHERE blacklisted_by_user = 0');
    db.close();
    fs.unlinkSync(tmpPath);
    const rows = result.length ? result[0].values.map(r => ({
      origin_url: r[0], username_value: r[1], password_value: Buffer.from(r[2])
    })) : [];

    // パスワードを復号
    const crypto = require('crypto');
    const passwords = [];
    for (const row of rows) {
      try {
        const pwBuf = Buffer.from(row.password_value);
        // v10/v11プレフィックス（3バイト）をスキップ
        if (pwBuf.slice(0, 3).toString() !== 'v10' && pwBuf.slice(0, 3).toString() !== 'v11') continue;
        const iv = Buffer.alloc(16, ' '); // ChromeはIVをスペースで埋める
        const encrypted = pwBuf.slice(3);
        const decipher = crypto.createDecipheriv('aes-128-cbc', masterKey, iv);
        const decrypted = Buffer.concat([decipher.update(encrypted), decipher.final()]);
        passwords.push({
          url:  row.origin_url,
          user: row.username_value,
          pass: decrypted.toString('utf8'),
        });
      } catch {}
    }

    // userData/passwords.jsonに保存
    const pwPath = path.join(app.getPath('userData'), 'passwords.json');
    let existing = [];
    try { existing = JSON.parse(fs.readFileSync(pwPath, 'utf8')); } catch {}
    const merged = [...existing];
    for (const pw of passwords) {
      const dup = merged.findIndex(e => e.url === pw.url && e.user === pw.user);
      if (dup >= 0) merged[dup] = pw; else merged.push(pw);
    }
    fs.writeFileSync(pwPath, JSON.stringify(merged, null, 2));
    return { ok: true, count: passwords.length };
  } catch (e) { return { error: e.message }; }
}

ipcMain.handle('import:passwords:auto', async (_, browser) => readChromePasswords(browser));

ipcMain.handle('import:passwords:csv', async (_, csvText) => {
  try {
    const lines = csvText.split('\n').filter(l => l.trim());
    const headers = lines[0].toLowerCase().split(',').map(h => h.trim().replace(/"/g,''));
    const nameIdx = headers.findIndex(h => h.includes('name') || h.includes('title'));
    const urlIdx  = headers.findIndex(h => h.includes('url') || h.includes('origin'));
    const userIdx = headers.findIndex(h => h.includes('user') || h.includes('login') || h.includes('email'));
    const passIdx = headers.findIndex(h => h.includes('pass'));
    if (urlIdx === -1 || userIdx === -1 || passIdx === -1) return { error: '対応していない形式です' };
    const passwords = [];
    for (let i = 1; i < lines.length; i++) {
      // CSVのクォート対応
      const cols = [];
      let cur = '', inQ = false;
      for (const ch of lines[i]) {
        if (ch === '"') { inQ = !inQ; }
        else if (ch === ',' && !inQ) { cols.push(cur); cur = ''; }
        else cur += ch;
      }
      cols.push(cur);
      if (cols.length <= Math.max(urlIdx, userIdx, passIdx)) continue;
      passwords.push({
        name: nameIdx >= 0 ? cols[nameIdx]?.trim() : '',
        url:  cols[urlIdx]?.trim(),
        user: cols[userIdx]?.trim(),
        pass: cols[passIdx]?.trim(),
      });
    }
    // userData/passwords.jsonに保存
    const pwPath = path.join(app.getPath('userData'), 'passwords.json');
    let existing = [];
    try { existing = JSON.parse(fs.readFileSync(pwPath, 'utf8')); } catch {}
    // 重複除去（url+userの組み合わせ）
    const merged = [...existing];
    for (const pw of passwords) {
      const dup = merged.findIndex(e => e.url === pw.url && e.user === pw.user);
      if (dup >= 0) merged[dup] = pw; else merged.push(pw);
    }
    fs.writeFileSync(pwPath, JSON.stringify(merged, null, 2));
    return { ok: true, count: passwords.length };
  } catch (e) { return { error: e.message }; }
});

ipcMain.handle('import:passwords:get', async () => {
  try {
    const pwPath = path.join(app.getPath('userData'), 'passwords.json');
    const passwords = fs.existsSync(pwPath) ? JSON.parse(fs.readFileSync(pwPath, 'utf8')) : [];
    return { passwords };
  } catch { return { passwords: [] }; }
});

// ── Cookieインポート（Chrome → Spiral セッション同期） ──
ipcMain.handle('import:cookies', async (_, browser) => {
  try {
    const profilePath = BROWSER_PATHS[browser]?.[getPlatformKey()];
    if (!profilePath) return { error: 'ブラウザが見つかりません' };
    const cookiePath = path.join(profilePath, 'Cookies');
    if (!fs.existsSync(cookiePath)) return { error: 'Cookieファイルが見つかりません（Chromeを終了してから試してください）' };
    // Cookieファイルをコピーして読む（ロック回避、sql.js使用）
    let initSqlJs;
    try { initSqlJs = require('sql.js'); } catch { return { error: 'sql.jsが必要です' }; }
    const tmpPath = path.join(app.getPath('temp'), 'spiral_cookies_tmp');
    fs.copyFileSync(cookiePath, tmpPath);
    const SQL = await initSqlJs();
    const dbBuf = fs.readFileSync(tmpPath);
    const db = new SQL.Database(dbBuf);
    const result = db.exec('SELECT host_key, name, value, path, expires_utc, is_secure, is_httponly, samesite FROM cookies LIMIT 5000');
    db.close();
    fs.unlinkSync(tmpPath);
    const rows = result.length ? result[0].values.map(r => ({
      host_key: r[0], name: r[1], value: r[2], path: r[3],
      expires_utc: r[4], is_secure: r[5], is_httponly: r[6], samesite: r[7]
    })) : [];
    // Spiralのセッションにセット
    const ses = session.fromPartition('persist:ws-main');
    let count = 0;
    for (const row of rows) {
      try {
        const url = (row.is_secure ? 'https://' : 'http://') + row.host_key.replace(/^\./, '');
        await ses.cookies.set({
          url, name: row.name, value: row.value || '',
          domain: row.host_key, path: row.path || '/',
          secure: !!row.is_secure, httpOnly: !!row.is_httponly,
          expirationDate: row.expires_utc ? (row.expires_utc / 1000000 - 11644473600) : undefined,
        });
        count++;
      } catch {}
    }
    return { ok: true, count };
  } catch (e) { return { error: e.message }; }
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
ipcMain.on('trig:enter', () => {
  if (!sbIsOpen && activeTabId) { layoutUIExpanded(); bringUIToFront(); uiView.webContents.send('trig:enter'); }
});
ipcMain.on('trig:leave', () => {
  if (!sbIsOpen && activeTabId) { layoutUI(); uiView.webContents.send('trig:leave'); }
});

// ── AI APIキー管理 ─────────────────────────────────────────────
const AI_KEY_PATH = path.join(app.getPath('userData'), 'ai-key.json');

function loadEnvKey() {
  const envPaths = [
    path.join(__dirname, '.env'),                        // ソースと同じ場所（開発・ビルド後両対応）
    path.join(path.dirname(app.getPath('exe')), '.env'), // .appと同じ場所
    path.join(app.getPath('userData'), '.env'),          // ~/Library/Application Support/Spiral/
    path.join(process.cwd(), '.env'),
  ];
  for (const p of envPaths) {
    try {
      if (fs.existsSync(p)) {
        const lines = fs.readFileSync(p, 'utf8').split('\n');
        for (const line of lines) {
          const m = line.match(/^\s*GROQ_API_KEY\s*=\s*(.+)\s*$/);
          if (m) return m[1].trim().replace(/^["']|["']$/g, '');
        }
      }
    } catch {}
  }
  return '';
}

function loadAIKey() {
  // 1. ai-key.json（UIで保存したキー）を優先
  try {
    if (fs.existsSync(AI_KEY_PATH)) {
      const d = JSON.parse(fs.readFileSync(AI_KEY_PATH, 'utf8'));
      if (d.key) return d.key;
    }
  } catch {}
  // 2. .env ファイルから自動読み込み
  const envKey = loadEnvKey();
  if (envKey) {
    saveAIKey(envKey); // 次回のために ai-key.json にも保存
    return envKey;
  }
  return '';
}

function saveAIKey(key) {
  try { fs.writeFileSync(AI_KEY_PATH, JSON.stringify({ key })); } catch {}
}
ipcMain.handle('ai:get-api-key', () => loadAIKey());
ipcMain.handle('ai:set-api-key', (_, key) => { saveAIKey(key); return true; });

// ── AI ウィンドウ ──────────────────────────────────────────────
function createAIWindow() {
  if (aiWindow && !aiWindow.isDestroyed()) {
    aiWindow.show();
    aiWindow.focus();
    return;
  }
  const [mw, mh] = mainWindow.getContentSize();
  const mb = mainWindow.getBounds();
  const w = 360, h = mh - MARGIN * 2;
  aiWindow = new BrowserWindow({
    width: w,
    height: h,
    x: mb.x + mb.width - w - 12,
    y: mb.y + 12,
    minWidth: 300,
    minHeight: 400,
    titleBarStyle: 'hidden',
    backgroundColor: '#1e1e1e',
    transparent: false,
    roundedCorners: true,
    hasShadow: true,
    title: 'Spiral AI',
    alwaysOnTop: true,
    resizable: true,
    frame: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload-ai.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  aiWindow.setWindowButtonVisibility(false);
  aiWindow.loadFile('src/ai-window.html');
  aiWindow.on('closed', () => {
    aiWindow = null;
    if (!uiView?.webContents.isDestroyed()) uiView.webContents.send('ai:window-closed');
  });
  // メインウィンドウに追従
  mainWindow.on('move', () => {
    if (!aiWindow || aiWindow.isDestroyed()) return;
    const b = mainWindow.getBounds();
    const [aw] = aiWindow.getSize();
    aiWindow.setPosition(b.x + b.width - aw - 12, b.y + 12);
  });
  mainWindow.on('resize', () => {
    if (!aiWindow || aiWindow.isDestroyed()) return;
    const b = mainWindow.getBounds();
    const [,mh2] = mainWindow.getContentSize();
    const [aw] = aiWindow.getSize();
    aiWindow.setSize(aw, mh2 - MARGIN * 2);
    aiWindow.setPosition(b.x + b.width - aw - 12, b.y + 12);
  });
}

ipcMain.on('ai:open-window', () => {
  createAIWindow();
});
ipcMain.on('ai:move-window', (_, { dx, dy }) => {
  if (!aiWindow || aiWindow.isDestroyed()) return;
  const [x, y] = aiWindow.getPosition();
  aiWindow.setPosition(x + dx, y + dy);
});

ipcMain.on('ai:close-window', () => {
  if (aiWindow && !aiWindow.isDestroyed()) aiWindow.close();
});
// AI→メインへのページテキスト要求
ipcMain.handle('ai:get-page-text', async () => {
  if (!activeTabId) return '';
  const view = webViews.get(activeTabId);
  if (!view) return '';
  try {
    const text = await view.webContents.executeJavaScript(`(function(){
      try {
        const clone = document.cloneNode(true);
        clone.querySelectorAll('script,style,noscript,nav,footer,header,aside').forEach(el=>el.remove());
        return (clone.body||clone.documentElement)?.innerText||'';
      } catch(e){ return document.body?.innerText||''; }
    })()`);
    return (text||'').replace(/[ \t]{3,}/g,' ').replace(/\n{4,}/g,'\n\n').trim().slice(0,5000);
  } catch { return ''; }
});
// AI→メインへのURL・タイトル要求
ipcMain.handle('ai:get-page-info', () => {
  if (!activeTabId) return { url: '', title: '' };
  const view = webViews.get(activeTabId);
  if (!view) return { url: '', title: '' };
  return { url: view.webContents.getURL(), title: view.webContents.getTitle() };
});

// 解答欄の情報を取得
ipcMain.handle('ai:get-input-fields', async () => {
  if (!activeTabId) return [];
  const view = webViews.get(activeTabId);
  if (!view) return [];
  try {
    return await view.webContents.executeJavaScript(`(function() {
      const inputs = [];
      const selectors = [
        'input[type="text"]', 'input[type="number"]', 'input[type="email"]',
        'input:not([type])', 'textarea', '[contenteditable="true"]',
      ];
      const blacklist = /search|query|q\b|username|password|email|login|name|phone|tel|zip|address|url|mail/i;
      document.querySelectorAll(selectors.join(',')).forEach((el, i) => {
        if (el.offsetParent === null) return; // 非表示
        if (el.disabled || el.readOnly) return;
        const label =
          document.querySelector('label[for="'+el.id+'"]')?.textContent?.trim()
          || el.placeholder || el.name || el.id || '';
        if (blacklist.test(label + el.name + el.id)) return;
        // 周辺テキスト（問題文）を取得
        const parent = el.closest('p,div,li,td,form,section') || el.parentElement;
        const context = parent?.innerText?.replace(/\s+/g,' ').trim().slice(0,200) || '';
        inputs.push({ index: i, label, context, tag: el.tagName.toLowerCase(), id: el.id, name: el.name });
      });
      return inputs.slice(0, 20);
    })()`);
  } catch { return []; }
});

// 解答を入力欄に自動入力
ipcMain.handle('ai:fill-answers', async (_, answers) => {
  if (!activeTabId) return false;
  const view = webViews.get(activeTabId);
  if (!view) return false;
  try {
    const answersJson = JSON.stringify(answers);
    const script = '(function() {' +
      'var answersData = ' + answersJson + ';' +
      'var selectors = ["input[type=\"text\"]","input[type=\"number\"]","input[type=\"email\"]","input:not([type])","textarea","[contenteditable=\"true\"]"];' +
      'var allInputs = Array.from(document.querySelectorAll(selectors.join(","))).filter(function(el){ return el.offsetParent !== null && !el.disabled && !el.readOnly; });' +
      'answersData.forEach(function(item) {' +
        'var el = allInputs[item.index];' +
        'if (!el) return;' +
        'if (el.getAttribute("contenteditable")) { el.textContent = item.value; }' +
        'else { try { var d = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype,"value") || Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype,"value"); if(d && d.set) d.set.call(el, item.value); else el.value = item.value; } catch(e) { el.value = item.value; } }' +
        'el.dispatchEvent(new Event("input",{bubbles:true}));' +
        'el.dispatchEvent(new Event("change",{bubbles:true}));' +
        'el.style.backgroundColor = "rgba(52,120,246,0.15)";' +
      '});' +
    '})()';
    await view.webContents.executeJavaScript(script);
    return true;
  } catch { return false; }
});

// ── アプリライフサイクル ──
// Googleなどに「Electron製」と検出されないようにアプリ名・バージョンを偽装
app.name = 'Google Chrome';
try { app.setVersion('136.0.7103.92'); } catch {}

app.whenReady().then(() => {
  loadHistory();
  loadDownloadHistory();
  createWindow();
  // BrowserView追加時のMaxListeners警告を抑制
  process.setMaxListeners(50);
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
