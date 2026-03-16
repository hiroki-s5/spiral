const { app, BrowserWindow, BrowserView, ipcMain, Menu, Notification, nativeImage, Tray, globalShortcut, session, screen, protocol, nativeTheme, dialog } = require('electron');
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
  'no-sandbox', 'disable-setuid-sandbox',  // macOSで必要
]) app.commandLine.appendSwitch(sw);

// 高速化
app.commandLine.appendSwitch('enable-tcp-fast-open');
app.commandLine.appendSwitch('enable-async-dns');
app.commandLine.appendSwitch('dns-prefetch-disable', 'false');
app.commandLine.appendSwitch('aggressive-cache-discard', 'false');

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
const UA     = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/134.0.6998.165 Safari/537.36';
// Slack等のバージョンチェック対策: サービスごとに最新UAを返す
function getUAForUrl(url) {
  // Slack, Notion, Discord等のサービスには常に最新Chrome UAを返す
  const modernUA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/134.0.6998.165 Safari/537.36';
  return modernUA;
}
const MARGIN = 10;
const RADIUS = 12;
const TABBAR_H = 28; // タブ行高さ
const H_TOPZONE  = 78; // タブ28+アドレス26+BM24
let _currentLayout = 'vertical';

// WebViewに注入するCSS（角丸 + スクロール挙動）
// - html に border-radius + clip-path で角丸クリッピング（overflow:hidden はスクロールを殺すので使わない）
// - did-finish-load が複数回発火してもinsertCSSは累積しないので問題なし
const WEBVIEW_CSS = `
  html { border-radius: ${RADIUS}px !important; }
  * { overscroll-behavior: none !important; }
  /* OSがダークモードでもサイトは常にライト表示 */
  :root { color-scheme: light !important; }
  body > div[style*="position: fixed"][style*="bottom"] { display: none !important; }
`;

// 角丸を強制維持するJS＋プライバシー保護（フィンガープリント対策・SMS OTP無効化）
const WEBVIEW_JS = `(function(){
  // 角丸維持
  function applyRadius() {
    document.documentElement.style.setProperty("border-radius", "${RADIUS}px", "important");
  }
  applyRadius();
  new MutationObserver(applyRadius).observe(document.documentElement, {
    attributes: true, attributeFilter: ["style", "class"]
  });

  // ── フィンガープリント対策 ──
  // Canvasフィンガープリントにわずかなノイズを加える
  try {
    const origGetContext = HTMLCanvasElement.prototype.getContext;
    HTMLCanvasElement.prototype.getContext = function(type, ...args) {
      const ctx = origGetContext.call(this, type, ...args);
      if (!ctx || type !== '2d') return ctx;
      const origGetImageData = ctx.getImageData.bind(ctx);
      ctx.getImageData = function(x, y, w, h) {
        const data = origGetImageData(x, y, w, h);
        // 1ピクセルだけわずかに変えてフィンガープリントを破る
        if (data.data.length > 4) {
          data.data[0] = data.data[0] ^ 1;
        }
        return data;
      };
      return ctx;
    };
  } catch {}

  // AudioContextフィンガープリント対策
  try {
    const origGetChannelData = AudioBuffer.prototype.getChannelData;
    AudioBuffer.prototype.getChannelData = function(ch) {
      const data = origGetChannelData.call(this, ch);
      // ごくわずかなノイズを加える
      if (data.length > 0) data[0] += 0.0000001;
      return data;
    };
  } catch {}

  // WebGL Vendorを汎用値に変更
  try {
    const origGetParam = WebGLRenderingContext.prototype.getParameter;
    WebGLRenderingContext.prototype.getParameter = function(param) {
      if (param === 37445) return 'Google Inc. (Apple)'; // UNMASKED_VENDOR_WEBGL
      if (param === 37446) return 'ANGLE (Apple, ANGLE Metal Renderer: Apple M1, Unspecified Version)';
      return origGetParam.call(this, param);
    };
  } catch {}

  // ── SMS OTP / WebOTP API無効化 ──
  // navigator.credentials.get でotp typeを無効化
  try {
    if (navigator.credentials) {
      const origGet = navigator.credentials.get.bind(navigator.credentials);
      navigator.credentials.get = function(opts) {
        if (opts && opts.otp) {
          return Promise.reject(new DOMException('Not supported', 'NotSupportedError'));
        }
        return origGet(opts);
      };
    }
  } catch {}

  // SMS autocomplete属性のone-time-codeを無効化（オートフィルをブロック）
  try {
    document.addEventListener('DOMContentLoaded', () => {
      document.querySelectorAll('input[autocomplete="one-time-code"]').forEach(el => {
        el.removeAttribute('autocomplete');
      });
      // MutationObserverで動的に追加されるものも対処
      new MutationObserver(mutations => {
        mutations.forEach(m => {
          m.addedNodes.forEach(node => {
            if (node.nodeType === 1) {
              node.querySelectorAll && node.querySelectorAll('input[autocomplete="one-time-code"]').forEach(el => {
                el.removeAttribute('autocomplete');
              });
            }
          });
        });
      }).observe(document.body || document.documentElement, { childList: true, subtree: true });
    }, { once: true });
  } catch {}

  // ── 検索高速化: DNS prefetch ──
  try {
    ['https://www.google.com','https://www.google.co.jp',
     'https://clients1.google.com','https://suggestqueries.google.com',
     'https://www.bing.com','https://duckduckgo.com'].forEach(o => {
      const l = document.createElement('link');
      l.rel = 'dns-prefetch'; l.href = o;
      document.head && document.head.appendChild(l);
    });
  } catch {}
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
  // 水平バー時は異なるオフセット
  const x0 = _currentLayout === 'horizontal' ? H_SIDEBAR_W : MARGIN;
  const y0 = _currentLayout === 'horizontal' ? H_TOPZONE   : MARGIN;
  const totalW = _currentLayout === 'horizontal' ? w - H_SIDEBAR_W : w - MARGIN * 2;
  const totalH = _currentLayout === 'horizontal' ? h - H_TOPZONE - H_BOTTOM_H : h - MARGIN * 2;
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

let mainWindow, uiView, shadowView, aiWindow, dragView, passwordWindow, settingsWindow;
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

const H_SIDEBAR_W = 36; // 左サイドバー幅
const H_BOTTOM_H  = 28; // 下部ツールバー高さ

function layoutWebView(view) {
  const [w, h] = getWH();
  if (_currentLayout === 'horizontal') {
    // 余白なし・ウィンドウ端くっつき
    // topbar: 0〜40px
    // sidebar: left 0〜44px, top 40px〜bottom 40px
    // bottombar: h-40〜h
    const topOffset  = H_TOPZONE;      // 78
    const leftOffset = H_SIDEBAR_W;    // 36
    const viewH = h - topOffset - H_BOTTOM_H; // h-106
    const viewW = w - leftOffset;
    view.setBounds({ x: leftOffset, y: topOffset, width: viewW, height: viewH });
  } else {
    const topOffset = MARGIN;
    const viewH = h - MARGIN - topOffset;
    view.setBounds({ x: MARGIN, y: topOffset, width: w - MARGIN * 2, height: viewH });
  }
}
function layoutUI() {
  if (_currentLayout === 'horizontal') {
    layoutHorizontalUI();
    return;
  }
  // モーダル表示中はuiViewを縮小しない（設定画面などが消えるのを防ぐ）
  if (_modalOpen) return;
  const [, h] = getWH();
  uiView.setBounds({ x: MARGIN, y: MARGIN, width: 24, height: h - MARGIN * 2 });
}
// 水平レイアウト専用：uiViewのサイズをWebViewと重ならない形に設定
// uiViewは全幅・全高だが、setIgnoreMouseEvents(true, {forward:true})で
// UIバー以外のクリックを下のWebViewに転送する
// ※ forward:trueはマウス移動のみ転送・クリックは転送されないため、
//   代わりにuiViewのHTMLでWebViewエリアをpointer-events:noneにしている
//   → しかしBrowserViewレベルではHTML pointer-eventsは無視される
//
// 最終的な解決策：水平時はuiViewをWebViewの「後ろ」に置く
// uiViewはWebView(activeTab)より後ろにしてSetTopBrowserViewしない
// → UIバーの描画はuiViewが担うがzオーダーはWebViewより下
// → UIバーがWebViewの下に隠れるが、UIバーエリアにWebViewは存在しないので見える
function layoutHorizontalUI() {
  const [w, h] = getWH();
  uiView.setBounds({ x: 0, y: 0, width: w, height: h });
  try { uiView.webContents.setIgnoreMouseEvents(false); } catch {}
  // uiViewをzオーダーで最前面にしない（WebViewの後ろに）
  // WebViewはUIバーエリアには配置されていないので、UIバーはuiViewが担当できる
  // WebViewエリア(中央)はWebViewが前面に来てクリックを受け取る
}

function layoutUIExpanded() {
  const [w, h] = getWH();
  if (_currentLayout === 'horizontal') {
    layoutHorizontalUI();
    return;
  }
  uiView.setBounds({ x: MARGIN, y: MARGIN, width: w - MARGIN * 2, height: h - MARGIN * 2 });
  try { uiView.webContents.setIgnoreMouseEvents(false); } catch {}
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
  if (_currentLayout === 'horizontal') {
    // 水平時：WebViewをuiViewより前面に置く
    // UIバーエリアにはWebViewがないので、uiViewが後ろでもUIバーは見えてクリックできる
    // WebViewエリアではWebViewが前面にいてクリックを受け取る
    if (activeTabId) {
      const av = webViews.get(activeTabId);
      if (av) try { mainWindow.setTopBrowserView(av); } catch {}
    }
    if (dragView) try { mainWindow.setTopBrowserView(dragView); } catch {}
    // uiViewはsetTopしない → WebViewより後ろのまま
    try { uiView.webContents.setIgnoreMouseEvents(false); } catch {}
  } else {
    if (dragView) try { mainWindow.setTopBrowserView(dragView); } catch {}
    try { mainWindow.setTopBrowserView(uiView); } catch {}
    try { uiView.webContents.setIgnoreMouseEvents(false); } catch {}
  }
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

// 画像を指定形式で保存
async function saveImageAs(view, srcUrl, format) {
  const { net } = require('electron');
  const mimeMap = { png: 'image/png', jpg: 'image/jpeg', webp: 'image/webp' };
  const extMap  = { png: 'png', jpg: 'jpg', webp: 'webp' };

  // 保存先ダイアログ
  const defaultName = (() => {
    try {
      const u = new URL(srcUrl);
      const base = u.pathname.split('/').pop().replace(/\.[^.]+$/, '') || 'image';
      return base + '.' + extMap[format];
    } catch { return 'image.' + extMap[format]; }
  })();

  const { filePath, canceled } = await dialog.showSaveDialog(mainWindow, {
    title: `${format.toUpperCase()}形式で保存`,
    defaultPath: path.join(os.homedir(), 'Downloads', defaultName),
    filters: [{ name: format.toUpperCase(), extensions: [extMap[format]] }],
  });
  if (canceled || !filePath) return;

  try {
    // 画像をメインプロセスでfetch
    const imageData = await new Promise((resolve, reject) => {
      const https = require(srcUrl.startsWith('https') ? 'https' : 'http');
      const req = https.get(srcUrl, {
        headers: { 'User-Agent': UA, 'Accept': 'image/*,*/*' }
      }, res => {
        // リダイレクト対応
        if (res.statusCode === 301 || res.statusCode === 302) {
          resolve(fetchImage(res.headers.location));
          return;
        }
        const chunks = [];
        res.on('data', c => chunks.push(c));
        res.on('end', () => resolve({ buffer: Buffer.concat(chunks), mime: res.headers['content-type'] || '' }));
      });
      req.on('error', reject);
      req.setTimeout(15000, () => { req.destroy(); reject(new Error('timeout')); });
    });

    const srcBuf = imageData.buffer;

    // nativeImageで読み込んで変換
    const img = nativeImage.createFromBuffer(srcBuf);
    if (img.isEmpty()) throw new Error('画像の読み込みに失敗しました');

    let outBuf;
    if (format === 'png') {
      outBuf = img.toPNG();
    } else if (format === 'jpg') {
      outBuf = img.toJPEG(92);
    } else if (format === 'webp') {
      // WebPはnativeImageでサポートされている場合のみ
      try { outBuf = img.toDataURL('image/webp').replace(/^data:image\/webp;base64,/, ''); outBuf = Buffer.from(outBuf, 'base64'); }
      catch { outBuf = img.toPNG(); } // フォールバック
    }

    fs.writeFileSync(filePath, outBuf);
  } catch(e) {
    dialog.showErrorBox('保存失敗', e.message);
  }
}

// Electron新旧API互換ヘルパー
function wcCanGoBack(wc)    { return wc.navigationHistory?.canGoBack()    ?? wc.canGoBack(); }
function wcCanGoForward(wc) { return wc.navigationHistory?.canGoForward() ?? wc.canGoForward(); }
function wcGoBack(wc)    { if (wcCanGoBack(wc))    { wc.navigationHistory?.goBack()    ?? wc.goBack(); } }
function wcGoForward(wc) { if (wcCanGoForward(wc)) { wc.navigationHistory?.goForward() ?? wc.goForward(); } }
// ── トラッカーブロックリスト ──
// 主要アドトラッカー・スパイウェアドメインのブロックパターン
const TRACKER_PATTERNS = [
  // Google広告・トラッキング
  /\/\/pagead2\.googlesyndication\.com\//, /\/\/www\.google-analytics\.com\/collect/,
  /\/\/analytics\.google\.com\/g\/collect/, /\/\/googletagmanager\.com\/gtm/,
  /\/\/doubleclick\.net\//, /\/\/adservice\.google\./,
  // Meta/Facebook
  /\/\/connect\.facebook\.net\/.*\/fbevents/, /\/\/www\.facebook\.com\/tr/,
  // 主要トラッカー
  /\/\/mc\.yandex\.ru\/metrika/, /\/\/bat\.bing\.com\//,
  /\/\/cdn\.amplitude\.com\/libs\/analytics/, /\/\/api\.amplitude\.com\//,
  /\/\/api\.mixpanel\.com\/track/, /\/\/api2\.mixpanel\.com\//,
  /\/\/[a-z]+\.hotjar\.com\//, /\/\/[a-z]+\.clarity\.ms\//,
  /\/\/[a-z]+\.segment\.io\//, /\/\/[a-z]+\.segment\.com\/v1/,
  /\/\/pixel\.mathtag\.com\//,  /\/\/[a-z]+\.scorecardresearch\.com\//,
  /\/\/sb\.scorecardresearch\.com\//,
];

// フィッシング・マルウェアに使われやすいキーワードパターン
const SUSPICIOUS_URL_PATTERNS = [
  /phishing/i, /malware/i, /virus-alert/i, /your-pc-is-infected/i,
  /free-gift-claim/i, /congratulations.*winner/i, /account.*suspended.*verify/i,
];

function isTrackerUrl(url) {
  return TRACKER_PATTERNS.some(p => p.test(url));
}

function isSuspiciousUrl(url) {
  try {
    const u = new URL(url);
    // IP直打ちアクセス（フィッシングでよく使われる）
    if (/^\d+\.\d+\.\d+\.\d+$/.test(u.hostname)) return true;
    // 不審なキーワード
    if (SUSPICIOUS_URL_PATTERNS.some(p => p.test(url))) return true;
    // 過度に長いサブドメイン（偽装によく使われる）
    const parts = u.hostname.split('.');
    if (parts.some(p => p.length > 40)) return true;
    return false;
  } catch { return false; }
}

function setupSession(ses) {
  ses.setUserAgent(UA);

  // ── 危険なダウンロードをブロック ──
  ses.on('will-download', (_, item) => {
    const dangerousExts = ['.exe','.bat','.cmd','.vbs','.ps1','.sh','.dmg','.pkg','.msi','.deb','.rpm','.jar'];
    const filename = item.getFilename().toLowerCase();
    const isDangerous = dangerousExts.some(ext => filename.endsWith(ext));
    if (isDangerous) {
      // 警告は出さずにそのまま（ユーザーが意図してDLしている可能性）
      // 将来的に確認ダイアログを追加可能
    }
  });

  // ── 証明書エラー処理 ──
  ses.setCertificateVerifyProc((request, callback) => {
    // 自己署名証明書などを厳格に拒否
    if (request.errorCode !== 0) {
      callback(-2); // CERT_INVALID
    } else {
      callback(0);  // OK
    }
  });

  // ── 許可リクエストのデフォルト拒否 ──
  ses.setPermissionRequestHandler((webContents, permission, callback, details) => {
    // 許可する権限のホワイトリスト
    const allowed = ['notifications', 'clipboard-read', 'clipboard-sanitized-write', 'media', 'fullscreen', 'pointerLock'];
    // カメラ・マイクは要求元URLを確認してから許可
    if (['camera', 'microphone'].includes(permission)) {
      const origin = details.requestingUrl ? new URL(details.requestingUrl).origin : '';
      // videoconferenceサービスは許可
      const videoCallDomains = ['zoom.us', 'meet.google.com', 'teams.microsoft.com', 'whereby.com', 'discord.com'];
      const allowed = videoCallDomains.some(d => origin.includes(d));
      return callback(allowed);
    }
    callback(allowed.includes(permission));
  });

  // ── DNS prefetch（接続高速化） ──
  try {
    // resolveProxy: createWindow後に実行されるため、ここでは何もしない
  } catch {}

  // ── HTTPSへの自動アップグレード ──
  ses.webRequest.onBeforeRequest({ urls: ['http://*/*'] }, (details, cb) => {
    const url = details.url;
    // localhostやプライベートIPは除外
    try {
      const u = new URL(url);
      const skip = ['localhost', '127.0.0.1', '0.0.0.0', '::1'].includes(u.hostname)
        || /^(10\.|172\.(1[6-9]|2\d|3[01])\.|192\.168\.)/.test(u.hostname)
        || u.hostname.endsWith('.local');
      if (!skip) {
        return cb({ redirectURL: url.replace(/^http:\/\//, 'https://') });
      }
    } catch {}
    cb({});
  });

  ses.webRequest.onBeforeSendHeaders((details, cb) => {
    // トラッカーをブロック
    if (isTrackerUrl(details.url)) return cb({ cancel: true });

    const h = { ...details.requestHeaders, 'User-Agent': UA };
    delete h['X-Electron-Version'];
    delete h['X-Requested-With'];
    delete h['Electron-Version'];
    delete h['electron-version'];
    h['Sec-CH-UA']                  = '"Chromium";v="134", "Google Chrome";v="134", "Not-A.Brand";v="99"';
    h['Sec-CH-UA-Mobile']           = '?0';
    h['Sec-CH-UA-Platform']         = '"macOS"';
    h['Sec-CH-UA-Platform-Version'] = '"15.3.0"';
    h['Sec-CH-UA-Full-Version']     = '"134.0.6998.165"';
    h['Sec-CH-UA-Full-Version-List']= '"Chromium";v="134.0.6998.165", "Google Chrome";v="134.0.6998.165", "Not-A.Brand";v="99.0.0.0"';
    h['Sec-CH-UA-Arch']             = '"arm"';
    h['Sec-CH-UA-Bitness']          = '"64"';
    h['Sec-CH-UA-Model']            = '""';
    h['Sec-CH-UA-WoW64']            = '?0';
    // トラッキング用パラメータを除去
    try {
      const u = new URL(details.url);
      ['utm_source','utm_medium','utm_campaign','utm_term','utm_content',
       'fbclid','gclid','gclsrc','dclid','msclkid','yclid','_ga','_gl'].forEach(p => u.searchParams.delete(p));
      if (u.href !== details.url) {
        h['_spiral_url_override'] = u.href;
      }
    } catch {}
    // Refererのトリミング（プライバシー保護）
    if (h['Referer']) {
      try {
        const ref = new URL(h['Referer']);
        h['Referer'] = ref.origin + '/';
      } catch {}
    }
    if (!h['Accept-Encoding']) h['Accept-Encoding'] = 'gzip, deflate, br, zstd';
    if (details.url?.includes('google.com') || details.url?.includes('accounts.google')) {
      h['Sec-Fetch-Site'] = h['Sec-Fetch-Site'] || 'same-origin';
      h['Sec-Fetch-Mode'] = h['Sec-Fetch-Mode'] || 'navigate';
      h['Sec-Fetch-Dest'] = h['Sec-Fetch-Dest'] || 'document';
    }
    // Slack/Discord/NotionなどのSPAサービス向け
    const spaServices = ['slack.com','discord.com','notion.so','figma.com','linear.app'];
    if (spaServices.some(d => details.url?.includes(d))) {
      h['Sec-Fetch-Site'] = h['Sec-Fetch-Site'] || 'same-origin';
      h['Sec-Fetch-Mode'] = h['Sec-Fetch-Mode'] || 'navigate';
      h['Sec-Fetch-Dest'] = h['Sec-Fetch-Dest'] || 'document';
      // Electronを隠す
      delete h['X-Electron-Version'];
      delete h['Electron-Version'];
    }
    cb({ requestHeaders: h });
  });

  ses.webRequest.onHeadersReceived((details, cb) => {
    const h = { ...details.responseHeaders };
    delete h['x-frame-options'];
    delete h['X-Frame-Options'];
    if (details.url?.includes('suggestqueries.google.com')) h['access-control-allow-origin'] = ['*'];
    // WebStore: CSPを削除してJS注入を許可
    if (details.url?.includes('chromewebstore.google.com') || details.url?.includes('chrome.google.com/webstore')) {
      delete h['content-security-policy'];
      delete h['Content-Security-Policy'];
      delete h['content-security-policy-report-only'];
    }
    // セキュリティヘッダーを強化
    if (!h['x-content-type-options'])        h['x-content-type-options']        = ['nosniff'];
    if (!h['x-xss-protection'])              h['x-xss-protection']              = ['1; mode=block'];
    if (!h['referrer-policy'])               h['referrer-policy']               = ['strict-origin-when-cross-origin'];
    if (!h['permissions-policy'])            h['permissions-policy']            = ['interest-cohort=(), join-ad-interest-group=(), run-ad-auction=()'];
    cb({ responseHeaders: h });
  });
}

// ── 自動アップデート ──
function setupAutoUpdater() {
  const send = (ch, d) => { if (!uiView?.webContents.isDestroyed()) uiView.webContents.send(ch, d); };
  let autoUpdater;
  try {
    autoUpdater = require('electron-updater').autoUpdater;
  } catch(e) {
    console.log('AutoUpdater unavailable:', e.message);
    ipcMain.handle('update:check', async () => { send('update:notAvailable'); return { ok: true }; });
    return;
  }
  autoUpdater.autoDownload = true;
  autoUpdater.autoInstallOnAppQuit = true;
  try { autoUpdater.logger = require('electron-log'); autoUpdater.logger.transports.file.level = 'info'; } catch {}
  autoUpdater.on('update-available',     info => { send('update:available',  { version: info.version }); autoUpdater.downloadUpdate().catch(() => {}); });
  autoUpdater.on('download-progress',    p    => { send('update:progress',   { percent: Math.floor(p.percent) }); });
  autoUpdater.on('update-downloaded', info => {
    send('update:downloaded', { version: info.version });
    // 5秒後に自動インストール（再起動）
    setTimeout(() => {
      forceQuit = true;
      autoUpdater.quitAndInstall(false, true);
    }, 5000);
  });
  autoUpdater.on('update-not-available', ()   => send('update:notAvailable'));
  autoUpdater.on('error', err => {
    console.log('updater error:', err.message);
    send('update:notAvailable');
  });
  // 起動30秒後に初回チェック
  setTimeout(() => autoUpdater.checkForUpdates().catch(() => {}), 30000);
  // 1時間ごとに定期チェック→新版あれば自動DL・自動インストール
  setInterval(() => autoUpdater.checkForUpdates().catch(() => {}), 60 * 60 * 1000);
  ipcMain.on('update:install', () => {
    forceQuit = true;
    ipcMain.removeAllListeners('app:save-complete');
    mainWindow?.removeAllListeners('close');
    setTimeout(() => autoUpdater.quitAndInstall(false, true), 500);
  });
  ipcMain.handle('update:check', async () => {
    try {
      const result = await autoUpdater.checkForUpdates();
      if (!result?.updateInfo) send('update:notAvailable');
      return { ok: true };
    } catch(e) {
      console.log('update:check error:', e.message);
      send('update:notAvailable');
      return { error: e.message };
    }
  });
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
    webPreferences: { nodeIntegration: false, contextIsolation: true },
  });
  mainWindow.addBrowserView(shadowView);
  layoutShadow();
  // shadow.htmlをdata:URIで直接ロード（ファイルロード失敗を防ぐ）
  // shadowViewはMARGIN帯（10px）だけを塗り、内側（角丸エリア）は透明
  // canvasで描画する元の方式に戻す
  const SHADOW_HTML = `<!DOCTYPE html><html><head><meta charset="UTF-8"><style>
*{margin:0;padding:0;pointer-events:none;}
html,body{width:100%;height:100%;overflow:hidden;background:transparent;}
canvas{position:fixed;top:0;left:0;pointer-events:none;}
</style></head><body>
<canvas id="c"></canvas>
<script>
const M=10,R=12;
let dark=false;
function draw(){
  const c=document.getElementById('c');
  const W=window.innerWidth,H=window.innerHeight;
  c.width=W;c.height=H;
  const ctx=c.getContext('2d');
  ctx.clearRect(0,0,W,H);
  const bg=dark?'#1e1e1e':'#ffffff';
  // evenodd: 全画面塗って内側角丸を穴として抜く → MARGIN帯だけ塗られる
  ctx.fillStyle=bg;
  ctx.beginPath();
  ctx.rect(0,0,W,H);
  // 内側角丸パス（反時計回り）
  const x=M,y=M,w=W-M*2,h=H-M*2;
  ctx.moveTo(x+R,y);ctx.lineTo(x+w-R,y);
  ctx.arcTo(x+w,y,x+w,y+R,R);ctx.lineTo(x+w,y+h-R);
  ctx.arcTo(x+w,y+h,x+w-R,y+h,R);ctx.lineTo(x+R,y+h);
  ctx.arcTo(x,y+h,x,y+h-R,R);ctx.lineTo(x,y+R);
  ctx.arcTo(x,y,x+R,y,R);ctx.closePath();
  ctx.fill('evenodd');
  // 枠線
  ctx.strokeStyle=dark?'rgba(255,255,255,0.12)':'rgba(0,0,0,0.12)';
  ctx.lineWidth=1;
  ctx.beginPath();
  ctx.moveTo(x+R,y);ctx.lineTo(x+w-R,y);
  ctx.arcTo(x+w,y,x+w,y+R,R);ctx.lineTo(x+w,y+h-R);
  ctx.arcTo(x+w,y+h,x+w-R,y+h,R);ctx.lineTo(x+R,y+h);
  ctx.arcTo(x,y+h,x,y+h-R,R);ctx.lineTo(x,y+R);
  ctx.arcTo(x,y,x+R,y,R);ctx.closePath();
  ctx.stroke();
}
window.addEventListener('resize',draw);
window.addEventListener('message',e=>{if(e.data&&e.data.dark!==undefined){dark=e.data.dark;draw();}});
draw();
</script>
</body></html>`;
  shadowView.webContents.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(SHADOW_HTML));


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
      if (_currentLayout === 'horizontal') return; // 水平レイアウト時は無効
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
  // フォーカスを失った時はサイドバーの状態をリセット
  mainWindow.on('blur', () => {
    _trigActive = false;
    clearTimeout(_leaveTimer_sb); _leaveTimer_sb = null;
  });
  // 最小化時にリセット
  mainWindow.on('minimize', () => {
    _trigActive = false;
    sbIsOpen = false;
    clearTimeout(_leaveTimer_sb); _leaveTimer_sb = null;
  });
  // 復元時にUIを正しく前面に出す
  mainWindow.on('restore', () => {
    setTimeout(() => {
      layoutUIExpanded();
      bringUIToFront();
      if (activeTabId) {
        const v = webViews.get(activeTabId);
        if (v) layoutWebView(v);
      }
    }, 100);
  });
  // フォーカスが戻った時はUIを前面に
  mainWindow.on('focus', () => {
    setTimeout(() => {
      if (sbIsOpen || !activeTabId) {
        layoutUIExpanded();
      } else {
        layoutUI();
      }
      bringUIToFront();
    }, 50);
  });
  mainWindow.on('close', e => { if (!forceQuit) { e.preventDefault(); mainWindow.hide(); } });
}

// ── サイドバー開閉 ──
let _modalOpen = false; // モーダル表示中フラグ（水平レイアウトのhit-testing制御用）
let _modalKeepFrontInterval = null;

ipcMain.on('ui:modal-state', (_, open) => {
  const wasOpen = _modalOpen;
  _modalOpen = !!open;

  if (_currentLayout === 'horizontal') {
    if (_modalOpen) {
      if (dragView) try { mainWindow.setTopBrowserView(dragView); } catch {}
      try { mainWindow.setTopBrowserView(uiView); } catch {}
      try { uiView.webContents.setIgnoreMouseEvents(false); } catch {}
    } else {
      if (activeTabId) {
        const av = webViews.get(activeTabId);
        if (av) try { mainWindow.setTopBrowserView(av); } catch {}
      }
      if (dragView) try { mainWindow.setTopBrowserView(dragView); } catch {}
    }
  } else {
    // 垂直レイアウト
    if (_modalOpen) {
      // モーダルが開いたら即座に前面化 + インターバルで維持
      layoutUIExpanded();
      bringUIToFront();
      if (!_modalKeepFrontInterval) {
        _modalKeepFrontInterval = setInterval(() => {
          if (!_modalOpen) { clearInterval(_modalKeepFrontInterval); _modalKeepFrontInterval = null; return; }
          bringUIToFront();
        }, 200);
      }
    } else {
      // モーダルが閉じたらインターバル停止
      if (_modalKeepFrontInterval) { clearInterval(_modalKeepFrontInterval); _modalKeepFrontInterval = null; }
      layoutUIExpanded();
      bringUIToFront();
    }
  }
});

ipcMain.on('sb:open', () => {
  sbIsOpen = true;
  layoutUIExpanded();
  bringUIToFront();
  setTimeout(() => mainWindow.setWindowButtonVisibility(true), 200);
});

ipcMain.on('sb:close', () => {
  // モーダルが開いている場合はsb:closeを完全無視
  if (_modalOpen) return;
  sbIsOpen = false;
  _trigActive = false;
  clearTimeout(_leaveTimer_sb);
  _leaveTimer_sb = null;
  _sbCooldown = true;
  setTimeout(() => { _sbCooldown = false; }, 1000);
  setTimeout(() => {
    if (_modalOpen) return;
    if (splitIds.length >= 2) {
      layoutSplitViews();
    } else if (activeTabId) {
      const v = webViews.get(activeTabId);
      if (v) { layoutWebView(v); try { mainWindow.setTopBrowserView(v); } catch {} }
    }
    layoutUI();
    bringUIToFront();
  }, 80);
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
  splitRatios = { x: 0.5, y: 0.5 };
  ids.forEach(id => {
    const v = webViews.get(id);
    if (v) { try { mainWindow.addBrowserView(v); } catch {} }
  });
  layoutSplitViews();
  // 水平レイアウト時: WebViewを正しいz-orderで配置
  if (_currentLayout === 'horizontal') {
    layoutSplitViews();
    // shadowView → splitViews → uiView → dragView の順
    ids.forEach(id => {
      const v = webViews.get(id);
      if (v) { try { mainWindow.addBrowserView(v); mainWindow.setTopBrowserView(v); } catch {} }
    });
    try { mainWindow.setTopBrowserView(uiView); } catch {}
    if (dragView) try { mainWindow.setTopBrowserView(dragView); } catch {}
    // uiViewはマウスイベントを透過させてWebViewをクリック可能に
    try { uiView.webContents.setIgnoreMouseEvents(true, { forward: true }); } catch {}
  } else {
    bringUIToFront();
  }
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
  const x0 = _currentLayout === 'horizontal' ? H_SIDEBAR_W : MARGIN;
  const y0 = _currentLayout === 'horizontal' ? H_TOPZONE   : MARGIN;
  const totalW = _currentLayout === 'horizontal' ? w - H_SIDEBAR_W : w - MARGIN * 2;
  const totalH = _currentLayout === 'horizontal' ? h - H_TOPZONE - H_BOTTOM_H : h - MARGIN * 2;
  if (axis === 'x') {
    splitRatios.x = Math.min(0.85, Math.max(0.15, (relX - x0) / (totalW - GAP)));
  } else {
    splitRatios.y = Math.min(0.85, Math.max(0.15, (relY - y0) / (totalH - GAP)));
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
  // faviconをmainプロセスからfetchしてbase64化するヘルパー
  const fetchFaviconAsBase64 = (favUrl, fallbackS2Url, channel) => {
    const doFetch = (url, depth) => {
      if (depth > 3) { send(channel, { id, favicon: fallbackS2Url }); return; }
      const mod = url.startsWith('https') ? https : require('http');
      mod.get(url, res => {
        if (res.statusCode === 301 || res.statusCode === 302) {
          doFetch(res.headers.location, depth + 1); return;
        }
        const chunks = [];
        res.on('data', c => chunks.push(c));
        res.on('end', () => {
          const buf = Buffer.concat(chunks);
          if (buf.length > 100) {
            const mime = res.headers['content-type']?.split(';')[0] || 'image/png';
            send(channel, { id, favicon: `data:${mime};base64,` + buf.toString('base64') });
          } else {
            send(channel, { id, favicon: fallbackS2Url });
          }
        });
      }).on('error', () => send(channel, { id, favicon: fallbackS2Url }));
    };
    try { doFetch(favUrl, 0); } catch { send(channel, { id, favicon: fallbackS2Url }); }
  };

  view.webContents.on('page-favicon-updated', (_, f) => {
    const fav = f && f[0];
    if (!fav) return;
    try {
      const s2Url = 'https://www.google.com/s2/favicons?domain=' + new URL(view.webContents.getURL()).hostname + '&sz=64';
      fetchFaviconAsBase64(fav, s2Url, 'tab:favicon');
    } catch { send('tab:favicon', { id, favicon: fav }); }
  });
  // did-finish-load時もfaviconが取れていなければS2でフォールバック
  view.webContents.on('did-finish-load', () => {
    const url = view.webContents.getURL();
    if (!url || !url.startsWith('http')) return;
    try {
      const hostname = new URL(url).hostname;
      const s2Url = 'https://www.google.com/s2/favicons?domain=' + hostname + '&sz=64';
      fetchFaviconAsBase64(s2Url, s2Url, 'tab:favicon:fallback');
    } catch {}
  });
  view.webContents.on('did-start-loading',    () => send('tab:loading', { id, loading: true  }));
  view.webContents.on('did-stop-loading',     () => {
    send('tab:loading', { id, loading: false });
    // ページロード完了後にuiViewを最前面に（水平時特に重要）
    if (_currentLayout === 'horizontal') bringUIToFront();
  });

  // 角丸CSS+JS注入
  const injectCSS = () => view.webContents.insertCSS(WEBVIEW_CSS).catch(() => {});
  const injectJS  = () => view.webContents.executeJavaScript(WEBVIEW_JS, true).catch(() => {});

  // Chrome Web Store: 「Chromeに追加」を隠して「Spiralに追加」を表示
  const injectWebStore = () => {
    const url = view.webContents.getURL();
    if (!url.includes('chromewebstore.google.com') && !url.includes('chrome.google.com/webstore')) return;

    view.webContents.insertCSS(`
      /* バナー非表示 */
      [aria-label="アラート"], [aria-label="Alert"], [role="alert"],
      .xX710b, .RT4Zob { display: none !important; }
      /* Chromeに追加ボタン（UywwFc-LgbsSe クラス）をSpiralカラーに上書き */
      .UywwFc-LgbsSe.UywwFc-StrnGf-YYd4I-VtOx3e {
        background: #3478f6 !important;
        color: #fff !important;
        opacity: 1 !important;
        pointer-events: auto !important;
        cursor: pointer !important;
        border-color: #3478f6 !important;
        filter: none !important;
      }
      .UywwFc-LgbsSe.UywwFc-StrnGf-YYd4I-VtOx3e[disabled] {
        background: #3478f6 !important;
        color: #fff !important;
        opacity: 1 !important;
        pointer-events: auto !important;
        cursor: pointer !important;
      }
      .UywwFc-LgbsSe.UywwFc-StrnGf-YYd4I-VtOx3e:hover {
        opacity: 0.85 !important;
      }
    `).catch(() => {});

    view.webContents.executeJavaScript(`
      (function() {
        if (window.__swDone) return;

        function patchBtn(b) {
          if (b._spiralPatched) return;
          b._spiralPatched = true;

          // テキストをSpiralに変更
          var spans = b.querySelectorAll('span[jsname="V67aGc"], span[jsname]');
          var patched = false;
          spans.forEach(function(s) {
            var t = s.textContent.trim();
            if (!patched && (t === 'Chromeに追加' || t === 'Add to Chrome')) {
              s.textContent = 'Spiralに追加';
              patched = true;
            }
          });
          if (!patched) {
            var walker = document.createTreeWalker(b, NodeFilter.SHOW_TEXT);
            var node;
            while ((node = walker.nextNode())) {
              var t = node.textContent.trim();
              if (t === 'Chromeに追加' || t === 'Add to Chrome') {
                node.textContent = 'Spiralに追加';
                break;
              }
            }
          }

          b.removeAttribute('disabled');
          b.removeAttribute('aria-disabled');
          b.removeAttribute('aria-describedby');

          // MutationObserverでdisabled再付与を監視
          b._spiralObs = new MutationObserver(function() {
            b.removeAttribute('disabled');
            b.removeAttribute('aria-disabled');
          });
          b._spiralObs.observe(b, { attributes: true, attributeFilter: ['disabled','aria-disabled'] });

          // クリックをキャプチャフェーズで横取りしてSpiralインストールを実行
          b.addEventListener('click', function(e) {
            e.preventDefault();
            e.stopImmediatePropagation();

            var extId = location.pathname.split('/').filter(Boolean).pop();
            if (!extId || extId.length < 10 || !/^[a-z]+$/.test(extId)) {
              alert('拡張機能IDを取得できませんでした');
              return;
            }
            if (!window.browser || !window.browser.installExtFromStore) {
              alert('インストールAPIが利用できません');
              return;
            }

            // ボタンをインストール中状態に
            b._spiralObs && b._spiralObs.disconnect();
            b.style.setProperty('opacity', '0.7', 'important');
            b.style.setProperty('pointer-events', 'none', 'important');
            var span = b.querySelector('span[jsname="V67aGc"]') || b;
            var origText = span.textContent;
            span.textContent = 'インストール中...';

            window.browser.installExtFromStore(extId).then(function(r) {
              if (r && r.ok) {
                span.textContent = '追加済み ✓';
                b.style.setProperty('background', '#34a853', 'important');
                b.style.setProperty('opacity', '1', 'important');
              } else {
                span.textContent = 'エラー: ' + ((r && r.error) || '不明');
                b.style.setProperty('background', '#ea4335', 'important');
                b.style.setProperty('opacity', '1', 'important');
                b.style.setProperty('pointer-events', 'auto', 'important');
              }
            }).catch(function(err) {
              span.textContent = 'エラー: ' + (err.message || '不明');
              b.style.setProperty('background', '#ea4335', 'important');
              b.style.setProperty('opacity', '1', 'important');
              b.style.setProperty('pointer-events', 'auto', 'important');
            });
          }, true); // キャプチャフェーズ
        }

        function run() {
          // バナー非表示
          document.querySelectorAll('[aria-label="アラート"],[aria-label="Alert"],[role="alert"]').forEach(function(el) {
            el.style.setProperty('display','none','important');
          });
          if (!document.querySelector('h1')) return;

          // クラス名 UywwFc-LgbsSe で直接探す（最も確実）
          var btn = document.querySelector('.UywwFc-LgbsSe.UywwFc-StrnGf-YYd4I-VtOx3e');
          if (!btn) {
            // フォールバック：テキストで探す
            document.querySelectorAll('button').forEach(function(b) {
              if (!btn) {
                var t = (b.textContent||'').trim();
                if (t === 'Chromeに追加' || t === 'Add to Chrome') btn = b;
              }
            });
          }
          if (!btn) return;
          window.__swDone = true;
          patchBtn(btn);
        }

        run();
        [300, 800, 2000].forEach(function(t) { setTimeout(run, t); });

        var obs = new MutationObserver(function() {
          if (window.__swDone) { obs.disconnect(); return; }
          run();
        });
        obs.observe(document.body || document.documentElement, { childList: true, subtree: true });
      })();
    `, true).catch(() => {});
  };
  view.webContents.on('dom-ready', () => {
    injectCSS(); injectJS();
    injectWebStore();
    // OSダークモード無効化が有効なら注入
    if (_forceLight) {
      view.webContents.insertCSS(
        ':root { color-scheme: light !important; } html { color-scheme: light !important; }'
      ).catch(() => {});
    }
    if (_currentLayout === 'horizontal') bringUIToFront();
  });
  view.webContents.on('did-finish-load',      () => {
    injectCSS(); injectJS();
    injectWebStore();
    if (_currentLayout === 'horizontal') bringUIToFront();
  });
  view.webContents.on('did-navigate-in-page', () => {
    injectCSS(); injectJS();
    view.webContents.executeJavaScript('window.__swDone = false;').catch(() => {});
    injectWebStore();
  });


  view.webContents.setWindowOpenHandler(({ url: u, features }) => {
    if (!u || u === 'about:blank' || u === '') return { action: 'allow' };

    // 本物のポップアップのみ新規ウィンドウ許可（通話・ハドル等）
    const isPopup = features?.includes('popup') &&
      (u.includes('/call/') || u.includes('/huddle/') || u.includes('meet.google'));

    if (isPopup) return { action: 'allow' };

    // それ以外は全てSpiralの新タブで開く
    if (u.startsWith('http')) {
      uiView.webContents.send('app:openUrl', u);
    }
    return { action: 'deny' };
  });

  // 右クリックメニュー
  view.webContents.on('context-menu', (_, p) => {
    const items = [
      { label: '戻る',       enabled: wcCanGoBack(view.webContents),    click: () => wcGoBack(view.webContents) },
      { label: '進む',       enabled: wcCanGoForward(view.webContents), click: () => wcGoForward(view.webContents) },
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
      { label: '画像を形式を選んで保存', submenu: [
        { label: 'PNG形式で保存',  click: () => saveImageAs(view, p.srcURL, 'png') },
        { label: 'JPG形式で保存',  click: () => saveImageAs(view, p.srcURL, 'jpg') },
        { label: 'WebP形式で保存', click: () => saveImageAs(view, p.srcURL, 'webp') },
      ]},
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
    // 水平レイアウト時は確実にuiViewを最前面に
    if (_currentLayout === 'horizontal') {
      setTimeout(() => layoutHorizontalUI(), 50);
    }
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
  // 不審なURLは警告ページを表示
  if (isSuspiciousUrl(u)) {
    const encodedUrl = encodeURIComponent(u);
    const warningHtml = `data:text/html;charset=utf-8,${encodeURIComponent(`<!DOCTYPE html>
<html lang="ja"><head><meta charset="utf-8"><title>セキュリティ警告</title>
<style>
body{font-family:-apple-system,sans-serif;background:#1a1a2e;color:#fff;display:flex;align-items:center;justify-content:center;min-height:100vh;margin:0;}
.card{background:#16213e;border-radius:16px;padding:40px;max-width:500px;text-align:center;box-shadow:0 8px 32px rgba(0,0,0,.4);}

h1{color:#ff4757;font-size:22px;margin:0 0 12px;}
p{color:#a4b0be;line-height:1.6;margin:0 0 24px;}
.url{background:#0f3460;padding:10px;border-radius:8px;font-size:12px;word-break:break-all;color:#ffa502;margin-bottom:24px;}
.btn{padding:12px 28px;border-radius:10px;border:none;font-size:14px;font-weight:600;cursor:pointer;margin:0 8px;}
.btn-back{background:#2f3542;color:#fff;}
.btn-proceed{background:#ff4757;color:#fff;}
</style></head><body>
<div class="card">
  <div class="icon"></div>
  <h1>不審なサイトが検出されました</h1>
  <p>このURLはフィッシングサイトやマルウェア配布サイトの特徴を持っています。アクセスする場合は十分注意してください。</p>
  <div class="url">${u}</div>
  <button class="btn btn-proceed" onclick="location.href='${u}'">理解した上でアクセス</button>
</div>
</body></html>`)}`;
    view.webContents.loadURL(warningHtml);
    return u;
  }
  view.webContents.loadURL(u);
  return u;
});

ipcMain.handle('tab:back',        (_, id) => { const v = webViews.get(id); if (v) wcGoBack(v.webContents); });
ipcMain.handle('tab:forward',     (_, id) => { const v = webViews.get(id); if (v) wcGoForward(v.webContents); });
ipcMain.handle('tab:reload',      (_, id) => { webViews.get(id)?.webContents.reload(); });
ipcMain.handle('tab:getUrl',      (_, id) => webViews.get(id)?.webContents.getURL() ?? '');

// キーボードスクロール（矢印キーでスクロール）
ipcMain.handle('tab:set-keyboard-scroll', async (_, id, enabled) => {
  const view = webViews.get(id);
  if (!view || view.webContents.isDestroyed()) return;
  const js = enabled ? `
    if (!window.__spiralKeyScroll__) {
      window.__spiralKeyScroll__ = true;
      document.addEventListener('keydown', function(e) {
        if (['INPUT','TEXTAREA','SELECT'].includes(document.activeElement?.tagName)) return;
        if (e.target?.isContentEditable) return;
        const amount = e.shiftKey ? 300 : 100;
        if (e.key === 'ArrowDown') { e.preventDefault(); window.scrollBy({top: amount, behavior:'smooth'}); }
        if (e.key === 'ArrowUp')   { e.preventDefault(); window.scrollBy({top: -amount, behavior:'smooth'}); }
        if (e.key === 'ArrowRight'){ e.preventDefault(); window.scrollBy({left: amount, behavior:'smooth'}); }
        if (e.key === 'ArrowLeft') { e.preventDefault(); window.scrollBy({left: -amount, behavior:'smooth'}); }
        if (e.key === 'PageDown')  { e.preventDefault(); window.scrollBy({top: window.innerHeight * 0.9, behavior:'smooth'}); }
        if (e.key === 'PageUp')    { e.preventDefault(); window.scrollBy({top: -window.innerHeight * 0.9, behavior:'smooth'}); }
        if (e.key === 'Home')      { e.preventDefault(); window.scrollTo({top: 0, behavior:'smooth'}); }
        if (e.key === 'End')       { e.preventDefault(); window.scrollTo({top: document.body.scrollHeight, behavior:'smooth'}); }
      }, { capture: false });
    }
  ` : `window.__spiralKeyScroll__ = false;`;
  await view.webContents.executeJavaScript(js).catch(() => {});
});

// ── SMS OTP自動入力スキップ ──
// ページ内のOTP入力フィールドをクリアしてautocompleteをブロック
ipcMain.handle('security:clear-otp', async (_, id) => {
  const view = webViews.get(id);
  if (!view || view.webContents.isDestroyed()) return false;
  try {
    await view.webContents.executeJavaScript(`(function(){
      const sels = [
        'input[autocomplete="one-time-code"]',
        'input[name*="otp"]', 'input[name*="sms"]', 'input[name*="code"]',
        'input[id*="otp"]', 'input[id*="sms-code"]', 'input[placeholder*="SMS"]',
        'input[placeholder*="認証コード"]', 'input[placeholder*="verification"]',
      ];
      sels.forEach(s => {
        document.querySelectorAll(s).forEach(el => {
          el.removeAttribute('autocomplete');
          el.setAttribute('autocomplete', 'off');
          el.removeAttribute('name');
        });
      });
      return true;
    })()`);
    return true;
  } catch { return false; }
});

// セキュリティ診断：現在ページのリスク評価
ipcMain.handle('security:diagnose', async (_, id) => {
  const view = webViews.get(id);
  if (!view || view.webContents.isDestroyed()) return null;
  const url = view.webContents.getURL();
  const cert = view.webContents.getOwnerBrowserWindow
    ? null : null; // 証明書情報は別途
  const isHttps = url.startsWith('https://');
  const suspicious = isSuspiciousUrl(url);
  let hostname = '';
  try { hostname = new URL(url).hostname; } catch {}
  return { url, isHttps, suspicious, hostname };
});

// AI用: ページのテキストコンテンツを取得
// ── Chrome拡張機能インストール ──
const EXT_DIR = path.join(app.getPath('userData'), 'extensions');
if (!fs.existsSync(EXT_DIR)) fs.mkdirSync(EXT_DIR, { recursive: true });

// インストール済み拡張をすべてのsessionに読み込む
// 「使用する」ボタンを無効化する拡張機能（バックグラウンドで自動動作するもの）
const BLOCKED_EXTENSION_IDS = new Set([
  'maekfnoeejhpjfkfmdlckioggdcdofpg', // Adblocker for YouTube
]);

// Electronでサポートされない権限リスト
const UNSUPPORTED_PERMISSIONS = [
  'webNavigation', 'webRequest', 'webRequestBlocking',
  'contextMenus', 'notifications', 'background',
  'declarativeContent', 'declarativeNetRequest',
  'declarativeNetRequestWithHostAccess',
  'privacy', 'proxy', 'browsingData', 'bookmarks',
  'history', 'management', 'nativeMessaging',
  'pageCapture', 'platformKeys', 'processes',
  'signedInDevices', 'system.cpu', 'system.memory',
  'system.network', 'system.storage', 'tabCapture',
  'tabGroups', 'topSites', 'tts', 'ttsEngine',
  'unlimitedStorage', 'vpnProvider', 'wallpaper',
  'enterprise.deviceAttributes', 'enterprise.platformKeys',
  'fileBrowserHandler', 'fileSystemProvider',
  'gcm', 'identity', 'idltest', 'login', 'loginScreenStorage',
  'loginScreenUi', 'loginState',
];

function patchExtensionManifest(extPath) {
  try {
    const mPath = path.join(extPath, 'manifest.json');
    if (!fs.existsSync(mPath)) return;
    const m = JSON.parse(fs.readFileSync(mPath, 'utf8'));
    let changed = false;
    // 不明権限を除去
    if (Array.isArray(m.permissions)) {
      const filtered = m.permissions.filter(p => !UNSUPPORTED_PERMISSIONS.includes(p));
      if (filtered.length !== m.permissions.length) { m.permissions = filtered; changed = true; }
    }
    if (Array.isArray(m.optional_permissions)) {
      const filtered = m.optional_permissions.filter(p => !UNSUPPORTED_PERMISSIONS.includes(p));
      if (filtered.length !== m.optional_permissions.length) { m.optional_permissions = filtered; changed = true; }
    }
    // Service WorkerをバックグラウンドページにフォールバックMV2互換に変換
    if (m.manifest_version === 3 && m.background && m.background.service_worker) {
      m.background = { scripts: [m.background.service_worker], persistent: false };
      m.manifest_version = 2;
      changed = true;
    }
    if (changed) {
      const bakPath = mPath + '.bak';
      if (!fs.existsSync(bakPath)) fs.copyFileSync(mPath, bakPath);
      fs.writeFileSync(mPath, JSON.stringify(m, null, 2));
    }
  } catch(e) {}
}

async function loadAllExtensions() {
  const sessions = [session.defaultSession];
  for (const p of ['persist:main', 'persist:ws-main', 'persist:ws-ws0'])
    sessions.push(session.fromPartition(p));
  const dirs = fs.existsSync(EXT_DIR) ? fs.readdirSync(EXT_DIR).map(d => path.join(EXT_DIR, d)).filter(d => fs.statSync(d).isDirectory()) : [];
  for (const extPath of dirs) patchExtensionManifest(extPath);
  for (const ses of sessions)
    for (const extPath of dirs)
      try {
        if (ses.extensions && ses.extensions.loadExtension) {
          await ses.extensions.loadExtension(extPath, { allowFileAccess: true });
        } else if (ses.loadExtension) {
          await ses.loadExtension(extPath, { allowFileAccess: true });
        }
      } catch(e) { /* ignore */ }
}
// 起動時に拡張機能を正式にロード（Google翻訳等が動作するように）
// 旧バージョンで追加されたGoogle翻訳などは1回だけ削除
// デフォルトでインストールする拡張機能IDのリスト
// 削除対象の旧拡張機能
const DEPRECATED_EXTENSION_IDS = [
  'cjpalhdlnbpafiamejdnhcphjbkeiagm', // uBlock Origin
  'kamdcckkgcgmcompadgcnkpggiebafpj', // uBlock
  'ddkjiahejlhfcafbddmgiahcphecmpfh', // 旧拡張
  'ahohgooindjkkjakchgkbjpehcminmdm', // Service worker未対応拡張
  'abefllafeffhoiadldggcalfgbofohfa',  // 旧拡張
  'epcnnfbjfcgphgdmggkamkmgojdagdnn', // uBlock Origin Lite
  'maekfnoeejhpjfkfmdlckioggdcdofpg', // 削除対象拡張機能
  'aapbdbdomjkkjkaonfhkkikfgjllcleb', // Google Translate（旧デフォルト）
  'eimadpbcbfnmbkopoojfekhnkhdbieeh', // Dark Reader（旧デフォルト）
  'bpebmbjklgjejfokjbokmfmpebjmfefj', // 不明拡張
  'jdmlfmnmnkgdoepbihkbllifdpdkpkcl', // 不明拡張
];

app.on('ready', () => {
  // 不要な拡張機能を毎回削除（フラグ不問）
  for (const extId of DEPRECATED_EXTENSION_IDS) {
    const extPath = path.join(EXT_DIR, extId);
    if (fs.existsSync(extPath)) {
      try { fs.rmSync(extPath, { recursive: true, force: true }); } catch {}
    }
  }
  setTimeout(loadAllExtensions, 2000);
});

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

    // インストール後に全sessionで読み込む
    const sessions2 = [session.defaultSession];
    for (const p of ['persist:main', 'persist:ws-main', 'persist:ws-ws0'])
      sessions2.push(session.fromPartition(p));
    for (const ses of sessions2)
      try {
        if (ses.extensions && ses.extensions.loadExtension) {
          await ses.extensions.loadExtension(extPath, { allowFileAccess: true });
        } else if (ses.loadExtension) {
          await ses.loadExtension(extPath, { allowFileAccess: true });
        }
      } catch(e) { /* ignore */ }
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
    const extensions = dirs.map(id => {
      let name = id;
      let icon = null;
      try {
        const manifest = JSON.parse(fs.readFileSync(path.join(EXT_DIR, id, 'manifest.json'), 'utf8'));
        name = manifest.name || id;
        // _locales対応（ja優先→en→default_locale）
        if (name.startsWith('__MSG_')) {
          const msgKey = name.replace(/^__MSG_/, '').replace(/__$/, '');
          const tryLocale = (lang) => {
            try {
              const msgs = JSON.parse(fs.readFileSync(path.join(EXT_DIR, id, '_locales', lang, 'messages.json'), 'utf8'));
              const found = msgs[msgKey] || msgs[msgKey.toLowerCase()] || msgs[Object.keys(msgs).find(k => k.toLowerCase() === msgKey.toLowerCase())];
              return found?.message || null;
            } catch { return null; }
          };
          const defaultLocale = manifest.default_locale || 'en';
          name = tryLocale('ja') || tryLocale('en') || tryLocale(defaultLocale) || id;
        }
        // アイコン
        const icons = manifest.icons || {};
        const iconFile = icons['48'] || icons['32'] || icons['128'] || icons['16'];
        if (iconFile) icon = path.join(EXT_DIR, id, iconFile);
      } catch {}
      return { id, name, icon };
    });
    return { extensions };
  } catch (e) {
    return { extensions: [] };
  }
});

ipcMain.handle('ext:icon', async (_, iconPath) => {
  try {
    if (iconPath && fs.existsSync(iconPath)) {
      const buf = fs.readFileSync(iconPath);
      const ext = path.extname(iconPath).slice(1) || 'png';
      return 'data:image/' + ext + ';base64,' + buf.toString('base64');
    }
  } catch {}
  return null;
});

// ext:toggle: 拡張機能をアクティブタブで動作させる
// Electronではポップアップが動かないため、各拡張機能の機能を直接実装する
ipcMain.handle('ext:toggle', async (_, extId) => {
  try {
    // バックグラウンド自動動作系は「使用する」不要
    if (BLOCKED_EXTENSION_IDS.has(extId)) {
      return { error: 'この拡張機能は自動で動作しています' };
    }

    const manifestPath = path.join(EXT_DIR, extId, 'manifest.json');
    if (!fs.existsSync(manifestPath)) return { error: 'manifest not found' };
    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
    const view = activeTabId ? webViews.get(activeTabId) : null;
    if (!view) return { error: 'no active tab' };

    // Dark Reader: ダークモードCSSを注入/解除
    const isDarkReader = manifest.name?.toLowerCase().includes('dark reader')
      || extId === 'eimadpbcbfnmbkopoojfekhnkhdbieeh';
    if (isDarkReader) {
      const toggled = await view.webContents.executeJavaScript(`
        (function() {
          const existing = document.getElementById('__spiral_dark_reader__');
          if (existing) { existing.remove(); return false; }
          const s = document.createElement('style');
          s.id = '__spiral_dark_reader__';
          s.textContent = \`
            html { filter: invert(90%) hue-rotate(180deg) !important; }
            img, video, canvas, iframe, [style*="background-image"] {
              filter: invert(100%) hue-rotate(180deg) !important;
            }
          \`;
          document.head.appendChild(s);
          return true;
        })()
      `, true).catch(() => false);
      return { ok: true, active: toggled };
    }

    // Google翻訳: 翻訳ページを新タブで開く
    const isGoogleTranslate = manifest.name?.toLowerCase().includes('google translate')
      || extId === 'aapbdbdomjkkjkaonfhkkikfgjllcleb';
    if (isGoogleTranslate) {
      const currentUrl = view.webContents.getURL();
      const translateUrl = `https://translate.google.com/translate?sl=auto&tl=ja&u=${encodeURIComponent(currentUrl)}`;
      if (!uiView?.webContents.isDestroyed()) uiView.webContents.send('app:openUrl', translateUrl);
      return { ok: true };
    }

    // その他: content_scriptsを注入して動かす
    const scripts = manifest.content_scripts || [];
    let injected = false;
    for (const cs of scripts) {
      for (const cssFile of (cs.css || [])) {
        const p = path.join(EXT_DIR, extId, cssFile);
        if (fs.existsSync(p)) {
          const css = fs.readFileSync(p, 'utf8');
          await view.webContents.insertCSS(css).catch(() => {});
          injected = true;
        }
      }
      for (const jsFile of (cs.js || [])) {
        const p = path.join(EXT_DIR, extId, jsFile);
        if (fs.existsSync(p)) {
          const code = fs.readFileSync(p, 'utf8');
          const safeCode = `(function(){try{${code}\n}catch(e){console.warn('[ext] injection error:',e);}})();`;
          await view.webContents.executeJavaScript(safeCode, true).catch(() => {});
          injected = true;
        }
      }
    }
    if (injected) return { ok: true };

    // 何もできなかった場合はoptions_pageを開く
    const optPage = manifest.options_page || manifest.options_ui?.page;
    if (optPage) {
      if (!uiView?.webContents.isDestroyed())
        uiView.webContents.send('app:openUrl', `chrome-extension://${extId}/${optPage}`);
      return { ok: true };
    }
    return { error: 'この拡張機能はElectronでの動作に対応していません' };
  } catch (e) { return { error: e.message }; }
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
ipcMain.handle('tab:canGoBack',   (_, id) => webViews.get(id) ? wcCanGoBack(webViews.get(id).webContents) : false);
ipcMain.handle('tab:canGoForward',(_, id) => webViews.get(id) ? wcCanGoForward(webViews.get(id).webContents) : false);

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
// アトミックな状態保存（一時ファイル→リネームで書き込み中クラッシュを防ぐ）
function saveStateAtomic(state) {
  const tmpPath = appStatePath + '.tmp';
  const backupPath = appStatePath + '.bak';
  try {
    const json = JSON.stringify(state, null, 2);
    // 1. 一時ファイルに書き込む
    fs.writeFileSync(tmpPath, json, 'utf8');
    // 2. 書き込み内容を検証（JSONとして読み直せるか）
    JSON.parse(fs.readFileSync(tmpPath, 'utf8'));
    // 3. 既存ファイルをバックアップ
    if (fs.existsSync(appStatePath)) {
      fs.copyFileSync(appStatePath, backupPath);
    }
    // 4. アトミックにリネーム
    fs.renameSync(tmpPath, appStatePath);
    return true;
  } catch(e) {
    console.error('[SAVE ERROR]', e.message);
    try { if (fs.existsSync(tmpPath)) fs.unlinkSync(tmpPath); } catch {}
    return false;
  }
}

// 状態を読み込む（壊れていたらバックアップから復元）
function loadStateRobust() {
  // メインファイルを試す
  try {
    if (fs.existsSync(appStatePath)) {
      const raw = fs.readFileSync(appStatePath, 'utf8');
      if (raw.trim()) {
        const parsed = JSON.parse(raw);
        // 最低限のデータが存在するか確認
        if (parsed && typeof parsed === 'object') return parsed;
      }
    }
  } catch(e) {
    console.error('[LOAD ERROR] main file:', e.message);
  }
  // バックアップから復元
  const backupPath = appStatePath + '.bak';
  try {
    if (fs.existsSync(backupPath)) {
      const raw = fs.readFileSync(backupPath, 'utf8');
      if (raw.trim()) {
        const parsed = JSON.parse(raw);
        if (parsed && typeof parsed === 'object') {
          console.log('[STATE] Restored from backup');
          // バックアップをメインに復元
          fs.copyFileSync(backupPath, appStatePath);
          return parsed;
        }
      }
    }
  } catch(e) {
    console.error('[LOAD ERROR] backup file:', e.message);
  }
  return null;
}

ipcMain.handle('state:save', (_, state) => {
  return saveStateAtomic(state);
});
ipcMain.handle('state:load', () => {
  return loadStateRobust();
});
ipcMain.handle('state:saveSession', (_, { wsIdx, info }) => {
  try {
    const state = loadStateRobust() || {};
    if (state.workspaces?.[wsIdx]) { state.workspaces[wsIdx].sessionInfo = info; }
    return saveStateAtomic(state);
  } catch { return false; }
});

// レイアウト切り替え → WebViewの位置を再計算
let _uiTopInterval = null;

ipcMain.handle('layout:set', (_, layout) => {
  _currentLayout = layout;
  if (layout === 'horizontal') {
    sbIsOpen = false;
    _trigActive = false;
    clearTimeout(_leaveTimer_sb); _leaveTimer_sb = null;
    layoutUIExpanded();
    try { mainWindow.setWindowButtonPosition({ x: 8, y: 6 }); } catch {}
    // 水平時：uiViewをUIバー領域のみに縮小してWebViewエリアと重ならないようにする
    // これによりsetIgnoreMouseEventsやポーリング不要でクリックが確実にWebViewに届く
    if (_uiTopInterval) { clearInterval(_uiTopInterval); _uiTopInterval = null; }
    layoutHorizontalUI();
    // WebViewを前面に（uiViewはWebViewの後ろに）
    if (activeTabId) {
      const av = webViews.get(activeTabId);
      if (av) try { mainWindow.setTopBrowserView(av); } catch {}
    }
    if (dragView) try { mainWindow.setTopBrowserView(dragView); } catch {}
  } else {
    if (activeTabId) {
      const v = webViews.get(activeTabId);
      if (v) layoutWebView(v);
    }
    layoutUI();
    try { mainWindow.setWindowButtonPosition({ x: 9, y: 2 }); } catch {}
    // 垂直時：マウスイベント復元
    if (_uiTopInterval) { clearInterval(_uiTopInterval); _uiTopInterval = null; }
    try { uiView.webContents.setIgnoreMouseEvents(false); } catch {}
  }
  webViews.forEach(v => layoutWebView(v));
  bringUIToFront();
  return true;
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
    return { ok: true, count: passwords.length, total: rows.length };
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
  if (shadowView && !shadowView.webContents.isDestroyed()) {
    shadowView.setBackgroundColor(dark ? '#1e1e1e' : '#ffffff');
    shadowView.webContents.executeJavaScript(
      `window.postMessage({dark: ${dark}}, '*');`
    ).catch(() => {});
  }
  mainWindow.setBackgroundColor('#00000000');
  mainWindow.setVibrancy(null);
  // WebViewにcolor-schemeを注入してサイトの強制ダーク化を防ぐ
  const colorSchemeCSS = dark
    ? ':root { color-scheme: dark !important; }'
    : ':root { color-scheme: light !important; }';
  for (const [, v] of webViews) {
    if (!v.webContents.isDestroyed()) {
      v.webContents.insertCSS(colorSchemeCSS).catch(() => {});
    }
  }
});

// ── システムダークモード無効化 ──
let _forceLight = false;

ipcMain.handle('theme:disable-system-dark', (_, val) => {
  _forceLight = val;
  // WebViewには触れない（フリーズの原因）
  // 代わりにWEBVIEW_CSSを通じて新規ロード時に適用
  return { ok: true };
});

// ── トリガー（IPC経由） ──
ipcMain.on('trig:enter', () => {
  if (_currentLayout === 'horizontal') return;
  if (!sbIsOpen && activeTabId) { layoutUIExpanded(); bringUIToFront(); uiView.webContents.send('trig:enter'); }
});
ipcMain.on('trig:leave', () => {
  if (_currentLayout === 'horizontal') return;
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
  aiWindow.webContents.once('did-finish-load', () => {
    // 現在のページ情報をAIウィンドウに送る
    if (activeTabId) {
      const v = webViews.get(activeTabId);
      if (v && !v.webContents.isDestroyed()) {
        aiWindow.webContents.send('ai:page-context', {
          url:   v.webContents.getURL(),
          title: v.webContents.getTitle(),
        });
      }
    }
  });
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

// ── 設定ウィンドウ ──
// 設定ウィンドウで保存を押した時にmain windowのレイアウトを更新
ipcMain.on('settings:apply', (_, state) => {
  // ファイルに保存
  try { fs.writeFileSync(appStatePath, JSON.stringify(state, null, 2)); } catch {}
  // main windowのuiViewに状態変更を通知
  if (!uiView?.webContents.isDestroyed()) {
    uiView.webContents.send('settings:applied', state);
  }
});

// 設定ウィンドウ
ipcMain.on('settings:open', () => {
  if (settingsWindow && !settingsWindow.isDestroyed()) {
    settingsWindow.focus();
    return;
  }
  // _modalOpenは使わない（バグの原因）
  // UIを展開して前面に出すだけ
  layoutUIExpanded();
  bringUIToFront();
  const mb = mainWindow.getBounds();
  settingsWindow = new BrowserWindow({
    width: 680,
    height: 540,
    x: Math.round(mb.x + (mb.width  - 680) / 2),
    y: Math.round(mb.y + (mb.height - 540) / 2),
    titleBarStyle: 'hiddenInset',
    trafficLightPosition: { x: 12, y: 2 },
    backgroundColor: '#232323',
    transparent: false,
    roundedCorners: true,
    hasShadow: true,
    title: '設定',
    resizable: false,
    fullscreenable: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      backgroundThrottling: false,
    },
  });

  settingsWindow.loadFile('src/settings-window.html');

  settingsWindow.on('closed', () => {
    settingsWindow = null;
    setTimeout(() => {
      try { uiView.webContents.setIgnoreMouseEvents(false); } catch {}
      if (sbIsOpen) {
        layoutUIExpanded();
      } else {
        layoutUI();
      }
      bringUIToFront();
      if (activeTabId) {
        const v = webViews.get(activeTabId);
        if (v) layoutWebView(v);
      }
      try { mainWindow.focus(); } catch {}
    }, 150);
  });
});

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
// ── パスワードウィンドウ ──
function createPasswordWindow() {
  if (passwordWindow && !passwordWindow.isDestroyed()) {
    passwordWindow.show();
    passwordWindow.focus();
    return;
  }
  const mb = screen.getPrimaryDisplay().workAreaSize;
  const w = 520, h = 600;
  passwordWindow = new BrowserWindow({
    width: w,
    height: h,
    x: Math.round((mb.width - w) / 2),
    y: Math.round((mb.height - h) / 2),
    titleBarStyle: 'hidden',
    backgroundColor: '#1e1e1e',
    transparent: false,
    roundedCorners: true,
    hasShadow: true,
    title: 'パスワード一覧',
    alwaysOnTop: true,
    resizable: true,
    frame: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload-password.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  passwordWindow.setWindowButtonVisibility(false);
  passwordWindow.loadFile('src/password-window.html');
  passwordWindow.on('closed', () => { passwordWindow = null; });
}

ipcMain.on('passwords:open-window', () => { createPasswordWindow(); });

ipcMain.handle('pw-win:get-active-tab', () => activeTabId);

// ── パスワードCRUDヘルパー ──
function _pwPath() { return path.join(app.getPath('userData'), 'passwords.json'); }
function _loadPw()  {
  try { return fs.existsSync(_pwPath()) ? JSON.parse(fs.readFileSync(_pwPath(), 'utf8')) : []; }
  catch { return []; }
}
function _savePw(list) {
  try { fs.writeFileSync(_pwPath(), JSON.stringify(list, null, 2)); } catch {}
}

ipcMain.handle('passwords:get-all', async () => {
  try {
    const passwords = _loadPw();
    const lhPath = path.join(app.getPath('userData'), 'login-history.json');
    const loginHistory = fs.existsSync(lhPath) ? JSON.parse(fs.readFileSync(lhPath, 'utf8')) : [];
    return { passwords, loginHistory };
  } catch (e) { return { passwords: [], loginHistory: [], error: e.message }; }
});

ipcMain.handle('passwords:save', (_, entry) => {
  const list = _loadPw();
  if (entry.id) {
    const idx = list.findIndex(p => p.id === entry.id);
    if (idx >= 0) { list[idx] = { ...list[idx], ...entry, updatedAt: Date.now() }; }
    else           { list.unshift({ ...entry, updatedAt: Date.now() }); }
  } else {
    list.unshift({ ...entry, id: 'pw_' + Date.now(), createdAt: Date.now(), updatedAt: Date.now() });
  }
  _savePw(list);
  return true;
});

ipcMain.handle('passwords:delete', (_, id) => {
  _savePw(_loadPw().filter(p => p.id !== id));
  return true;
});

// ── ログイン履歴 ──
const loginHistoryPath = path.join(app.getPath('userData'), 'login-history.json');
let loginHistory = [];
function loadLoginHistory() {
  try { if (fs.existsSync(loginHistoryPath)) loginHistory = JSON.parse(fs.readFileSync(loginHistoryPath, 'utf8')); }
  catch { loginHistory = []; }
}
function saveLoginHistory() {
  try { fs.writeFileSync(loginHistoryPath, JSON.stringify(loginHistory, null, 2)); } catch {}
}
loadLoginHistory();

// 自動監視による保存は無効化（手動入力のみ）
ipcMain.handle('login-history:save', () => false);

ipcMain.handle('login-history:get', () => loginHistory);

ipcMain.handle('login-history:delete', (_, id) => {
  loginHistory = loginHistory.filter(e => e.id !== id);
  saveLoginHistory();
  return true;
});

ipcMain.handle('login-history:save-manual', (_, entry) => {
  if (entry.id) {
    const idx = loginHistory.findIndex(e => e.id === entry.id);
    if (idx >= 0) { loginHistory[idx] = { ...loginHistory[idx], ...entry, updatedAt: Date.now() }; }
    else           { loginHistory.unshift({ ...entry, updatedAt: Date.now() }); }
  } else {
    loginHistory.unshift({ ...entry, id: 'lh_' + Date.now(), createdAt: Date.now(), loginAt: Date.now() });
  }
  saveLoginHistory();
  return true;
});

ipcMain.handle('login-history:clear', () => {
  loginHistory = [];
  saveLoginHistory();
  return true;
});

// 自動ログイン：対象タブのURLに遷移してcredentialを注入
ipcMain.handle('login-history:auto-login', async (_, { tabId, entry }) => {
  const view = webViews.get(tabId);
  if (!view) return { error: 'tab not found' };
  try {
    // URLの検証・正規化
    let targetUrl = entry.url || '';
    if (!targetUrl) return { error: 'URLが登録されていません。ログイン情報を編集してURLを追加してください。' };
    if (!targetUrl.startsWith('http://') && !targetUrl.startsWith('https://')) {
      targetUrl = 'https://' + targetUrl;
    }
    try { new URL(targetUrl); } catch {
      return { error: '無効なURL: ' + targetUrl };
    }
    // まずURLに遷移
    await view.webContents.loadURL(targetUrl);
    // ページロード完了を待つ（最大8秒）
    await new Promise(resolve => {
      const done = () => resolve();
      view.webContents.once('did-finish-load', done);
      setTimeout(done, 8000);
    });
    // フォームに入力
    if (entry.email || entry.password) {
      await view.webContents.executeJavaScript(`(function(){
        const userSel = 'input[type="email"],input[type="text"][name*="user"],input[type="text"][name*="email"],input[type="text"][name*="login"],input[autocomplete*="username"],input[autocomplete*="email"]';
        const passSel = 'input[type="password"]';
        function fill(el, val) {
          if (!el) return;
          const nativeSet = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
          nativeSet.call(el, val);
          el.dispatchEvent(new Event('input',  { bubbles: true }));
          el.dispatchEvent(new Event('change', { bubbles: true }));
        }
        fill(document.querySelector(userSel), ${JSON.stringify(entry.email || '')});
        fill(document.querySelector(passSel), ${JSON.stringify(entry.password || '')});
      })()`);
    }
    return { ok: true };
  } catch (e) { return { error: e.message }; }
});

// AIウィンドウが開いたときページ情報を送る
ipcMain.on('ai:open-url', (_, url) => {
  if (url && uiView && !uiView.webContents.isDestroyed()) {
    uiView.webContents.send('app:openUrl', url);
  }
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
    return (text||'').replace(/[ \t]{3,}/g,' ').replace(/\n{4,}/g,'\n\n').trim().slice(0,8000);
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
// Googleなどに「Electron製」と検出されないようにアプリ名を偽装
// ※ app.setVersion() によるバージョン偽装は electron-updater の Semver 検証を
//   破壊するため削除。Chrome偽装は UA と Sec-CH-UA ヘッダーで十分。
app.name = 'Google Chrome';

// web-contents-created: 不要なブロックを除去（内部View破損防止）

// ── セッションレベルのDNS prefetch（起動時に主要サイトをキャッシュ） ──
const PREFETCH_HOSTS = [
  'www.google.com', 'www.google.co.jp', 'clients1.google.com',
  'suggestqueries.google.com', 'www.bing.com', 'duckduckgo.com',
  'www.wikipedia.org', 'github.com',
];

app.whenReady().then(() => {
  // macOSのシステムダークモードがWebViewに強制適用されるのを防ぐ
  // Spiralは独自テーマを持つため、Webコンテンツはlight固定にする
  nativeTheme.themeSource = 'light';
  loadHistory();
  loadDownloadHistory();
  createWindow();
  // BrowserView追加時のMaxListeners警告を抑制
  process.setMaxListeners(50);
});

app.on('window-all-closed', () => { if (process.platform !== 'darwin' || forceQuit) app.quit(); });
// faviconをmain process経由でfetch → dataURIで返す（uiViewのfile://制限を回避）
// ── 拡張機能 全削除 ──
ipcMain.handle('ext:clear-all', async () => {
  try {
    if (fs.existsSync(EXT_DIR)) {
      const dirs = fs.readdirSync(EXT_DIR);
      for (const d of dirs) {
        const p = path.join(EXT_DIR, d);
        if (fs.statSync(p).isDirectory()) fs.rmSync(p, { recursive: true, force: true });
      }
    }
    return { ok: true };
  } catch (e) { return { error: e.message }; }
});

// ── 動画ダウンロード (yt-dlp) ──
const { exec, execFile } = require('child_process');
const ytdlpPaths = [
  '/usr/local/bin/yt-dlp', '/opt/homebrew/bin/yt-dlp',
  '/usr/bin/yt-dlp', path.join(os.homedir(), '.local/bin/yt-dlp'),
];
function findYtDlp() {
  for (const p of ytdlpPaths) { try { if (fs.existsSync(p)) return p; } catch {} }
  try { execSync('which yt-dlp'); return 'yt-dlp'; } catch {}
  return null;
}
function autoInstallYtDlp() {
  if (findYtDlp()) return;
  exec('brew install yt-dlp', err => {
    if (!err) return;
    exec('pip3 install yt-dlp --break-system-packages', () => {});
  });
}
app.whenReady().then(() => setTimeout(autoInstallYtDlp, 5000));
ipcMain.handle('ytdlp:check', async () => {
  const p = findYtDlp();
  return { available: !!p, path: p };
});
ipcMain.handle('ytdlp:install', async () => {
  return new Promise(resolve => {
    exec('brew install yt-dlp', (err, stdout, stderr) => {
      if (err) {
        exec('pip3 install yt-dlp --break-system-packages', (err2) => {
          resolve(err2 ? { error: err2.message } : { ok: true });
        });
      } else resolve({ ok: true });
    });
  });
});
ipcMain.handle('ytdlp:download', async (_, { url, quality }) => {
  const ytdlp = findYtDlp();
  if (!ytdlp) return { error: 'yt-dlpが見つかりません。インストールしてください。' };
  const dlDir = app.getPath('downloads');
  // ffmpegが使えるかチェック（マージに必要）
  const ffmpegAvailable = (() => {
    try { execSync('which ffmpeg'); return true; } catch { return false; }
  })();

  let args;
  if (ffmpegAvailable) {
    // ffmpegあり: 最高画質でダウンロードしてmp4にマージ
    args = [
      '-f', 'bestvideo+bestaudio/best',
      '--merge-output-format', 'mp4',
      '-o', path.join(dlDir, '%(title)s.%(ext)s'),
      url
    ];
  } else {
    // ffmpegなし: 最初から1ファイルで完結するフォーマットを選ぶ
    args = [
      '-f', 'best[ext=mp4]/best[ext=webm]/best',
      '-o', path.join(dlDir, '%(title)s.%(ext)s'),
      url
    ];
  }

  return new Promise(resolve => {
    execFile(ytdlp, args, { timeout: 300000 }, (err, stdout, stderr) => {
      if (err) {
        // フォールバック: シンプルなbestで再試行
        execFile(ytdlp, ['-f', 'best', '-o', path.join(dlDir, '%(title)s.%(ext)s'), url],
          { timeout: 300000 }, (err2, stdout2, stderr2) => {
            if (err2) resolve({ error: stderr2 || err2.message });
            else resolve({ ok: true, out: stdout2 });
          });
      } else resolve({ ok: true, out: stdout });
    });
  });
});

// ── プロキシ設定（ProtonVPN SOCKS5等） ──
const proxySettingsPath = path.join(app.getPath('userData'), 'proxy-settings.json');
function loadProxySettings() {
  try { if (fs.existsSync(proxySettingsPath)) return JSON.parse(fs.readFileSync(proxySettingsPath, 'utf8')); } catch {}
  return { enabled: false, host: '127.0.0.1', port: 1080, user: '', pass: '' };
}
function saveProxySettings(s) {
  try { fs.writeFileSync(proxySettingsPath, JSON.stringify(s, null, 2)); } catch {}
}
async function applyProxySettings(s) {
  const sessions = [session.defaultSession];
  for (const p of ['persist:main', 'persist:ws-main', 'persist:ws-ws0'])
    sessions.push(session.fromPartition(p));
  const proxyRules = s.enabled ? `socks5://${s.host}:${s.port}` : '';
  for (const ses of sessions) {
    await ses.setProxy({ proxyRules, proxyBypassRules: '<local>' }).catch(() => {});
    if (s.enabled && s.user) {
      ses.on('login', (_, authInfo, cb) => {
        if (authInfo.isProxy) cb(s.user, s.pass || '');
        else cb('', '');
      });
    }
  }
}
// 起動時にプロキシ設定を復元
app.whenReady().then(() => applyProxySettings(loadProxySettings()));

ipcMain.handle('proxy:get', () => loadProxySettings());
ipcMain.handle('proxy:set', async (_, s) => {
  saveProxySettings(s);
  await applyProxySettings(s);
  return { ok: true };
});


// Chrome Web Storeから拡張機能をインストール
ipcMain.handle('ext:install-from-store', async (_, extId) => {
  if (!extId) return { error: 'Extension ID が不明です' };
  const extDir = path.join(app.getPath('userData'), 'extensions', extId);
  const downloadUrl = `https://clients2.google.com/service/update2/crx?response=redirect&prodversion=134.0.6998.165&acceptformat=crx3&x=id%3D${extId}%26installsource%3Dondemand%26uc`;
  const crxPath = extDir + '.crx';
  try {
    if (!fs.existsSync(path.dirname(crxPath))) fs.mkdirSync(path.dirname(crxPath), { recursive: true });
    // CRXダウンロード（リダイレクト対応）
    await new Promise((resolve, reject) => {
      function download(url, redirects) {
        if (redirects > 5) return reject(new Error('too many redirects'));
        const mod = url.startsWith('https') ? require('https') : require('http');
        mod.get(url, { headers: { 'User-Agent': UA } }, res => {
          if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
            return download(res.headers.location, redirects + 1);
          }
          const file = fs.createWriteStream(crxPath);
          res.pipe(file);
          file.on('finish', () => { file.close(); resolve(); });
          file.on('error', reject);
        }).on('error', reject).setTimeout(30000, function() { this.destroy(); reject(new Error('timeout')); });
      }
      download(downloadUrl, 0);
    });
    // CRXヘッダーをスキップしてZIPを解凍
    if (!fs.existsSync(extDir)) fs.mkdirSync(extDir, { recursive: true });
    const crxBuf = fs.readFileSync(crxPath);
    let zipOffset = 0;
    // CRXマジックバイト確認: Cr24
    if (crxBuf[0] === 0x43 && crxBuf[1] === 0x72 && crxBuf[2] === 0x32 && crxBuf[3] === 0x34) {
      const version = crxBuf.readUInt32LE(4);
      if (version === 3) {
        // CRX3: magic(4) + version(4) + header_size(4) + header_data(header_size) + zip
        const headerSize = crxBuf.readUInt32LE(8);
        zipOffset = 12 + headerSize;
      } else if (version === 2) {
        // CRX2: magic(4) + version(4) + pubkey_len(4) + sig_len(4) + pubkey + sig + zip
        const pubkeyLen = crxBuf.readUInt32LE(8);
        const sigLen = crxBuf.readUInt32LE(12);
        zipOffset = 16 + pubkeyLen + sigLen;
      }
    }
    // ZIPシグネチャを探して正確なオフセットを見つける
    if (zipOffset === 0 || crxBuf[zipOffset] !== 0x50 || crxBuf[zipOffset+1] !== 0x4B) {
      // PK signature (0x50 0x4B) を線形探索
      for (let i = zipOffset; i < Math.min(crxBuf.length - 1, 65536); i++) {
        if (crxBuf[i] === 0x50 && crxBuf[i+1] === 0x4B) {
          zipOffset = i;
          break;
        }
      }
    }
    const AdmZip2 = require('adm-zip');
    const zip = new AdmZip2(crxBuf.slice(zipOffset));
    zip.extractAllTo(extDir, true);
    try { fs.unlinkSync(crxPath); } catch {}
    // ロード
    const ses = session.fromPartition('persist:main');
    let ext;
    if (ses.extensions && ses.extensions.loadExtension) {
      ext = await ses.extensions.loadExtension(extDir, { allowFileAccess: true });
    } else if (ses.loadExtension) {
      ext = await ses.loadExtension(extDir, { allowFileAccess: true });
    } else {
      throw new Error('拡張機能ロードAPIが見つかりません');
    }
    if (uiView && !uiView.webContents.isDestroyed()) uiView.webContents.send('ext:installed', { name: ext.name, id: ext.id });
    return { ok: true, name: ext.name };
  } catch(e) {
    try { if (fs.existsSync(crxPath)) fs.unlinkSync(crxPath); } catch {}
    return { error: e.message };
  }
});

// 電話番号取得（main process経由でCORS回避）
ipcMain.handle('phone:get-numbers', async (_, country) => {
  const https = require('https');
  const countryMap = {
    us: 'united-states', uk: 'united-kingdom', sweden: 'sweden',
    canada: 'canada', finland: 'finland', netherlands: 'netherlands', france: 'france'
  };
  const c = countryMap[country] || country;
  const urls = [
    `https://smsreceivefree.com/country/${c}/`,
    `https://receivesms.cc/`,
    `https://tempsmss.com/`,
  ];
  for (const url of urls) {
    try {
      const html = await new Promise((resolve, reject) => {
        const req = https.get(url, {
          headers: { 'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/134.0.6998.165 Safari/537.36', 'Accept': 'text/html' }
        }, res => {
          let data = '';
          res.on('data', d => { data += d; });
          res.on('end', () => resolve(data));
        });
        req.on('error', reject);
        req.setTimeout(8000, () => { req.destroy(); reject(new Error('timeout')); });
      });
      const matches = [...html.matchAll(/\+[1-9][\d\s\-]{6,14}/g)];
      const numbers = [...new Set(matches.map(m => m[0].replace(/[\s\-]/g, '')))].filter(n => n.length >= 8 && n.length <= 16).slice(0, 12);
      if (numbers.length > 0) return { ok: true, numbers };
    } catch {}
  }
  return { ok: false, numbers: [] };
});

ipcMain.handle('phone:get-sms', async (_, number) => {
  const https = require('https');
  const clean = number.replace(/[^\d+]/g, '');
  const urls = [
    `https://smsreceivefree.com/info/${encodeURIComponent(number)}/`,
    `https://receivesms.cc/sms/${encodeURIComponent(clean)}/`,
  ];
  for (const url of urls) {
    try {
      const html = await new Promise((resolve, reject) => {
        const req = https.get(url, {
          headers: { 'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/134.0.6998.165 Safari/537.36' }
        }, res => {
          let data = '';
          res.on('data', d => { data += d; });
          res.on('end', () => resolve(data));
        });
        req.on('error', reject);
        req.setTimeout(8000, () => { req.destroy(); reject(new Error('timeout')); });
      });
      // テーブル行からSMSを抽出
      const messages = [];
      const rowRe = /<tr[^>]*>([\s\S]*?)<\/tr>/gi;
      let rowMatch;
      while ((rowMatch = rowRe.exec(html)) !== null) {
        const row = rowMatch[1];
        const tds = [...row.matchAll(/<td[^>]*>([\s\S]*?)<\/td>/gi)].map(m => m[1].replace(/<[^>]+>/g, '').trim());
        if (tds.length >= 2 && tds[1] && tds[1].length > 1) {
          messages.push({ from: tds[0] || '', text: tds[1] || '', time: tds[2] || '' });
        }
      }
      if (messages.length > 0) return { ok: true, messages };
    } catch {}
  }
  return { ok: true, messages: [] };
});

ipcMain.handle('favicon:fetch', async (_, url) => {
  return new Promise((resolve) => {
    try {
      const { net } = require('electron');
      const req = net.request({ url, session: session.defaultSession });
      const chunks = [];
      req.on('response', (res) => {
        if (res.statusCode !== 200) { resolve(''); return; }
        res.on('data', c => chunks.push(c));
        res.on('end', () => {
          const buf = Buffer.concat(chunks);
          const ct = (Array.isArray(res.headers['content-type'])
            ? res.headers['content-type'][0]
            : res.headers['content-type']) || 'image/x-icon';
          resolve('data:' + ct.split(';')[0].trim() + ';base64,' + buf.toString('base64'));
        });
        res.on('error', () => resolve(''));
      });
      req.on('error', () => resolve(''));
      req.end();
    } catch { resolve(''); }
  });
});

app.on('activate', () => { if (mainWindow) { mainWindow.show(); mainWindow.focus(); } else createWindow(); });
app.on('before-quit', e => {
  if (forceQuit || !uiView || uiView.webContents.isDestroyed()) return;
  e.preventDefault();
  forceQuit = true;
  uiView.webContents.send('app:save-before-quit');
  const t = setTimeout(() => app.quit(), 2000);
  ipcMain.once('app:save-complete', () => { clearTimeout(t); app.quit(); });
});
