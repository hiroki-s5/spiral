// ═══════════════════════════════════════════
//  prompt()代替（Electronではprompt()が動かないため）
// ═══════════════════════════════════════════
function showPrompt(title, defaultVal = '') {
  return new Promise(resolve => {
    const modal = document.getElementById('prompt-modal');
    const input = document.getElementById('prompt-modal-input');
    const titleEl = document.getElementById('prompt-modal-title');
    const confirmBtn = document.getElementById('prompt-modal-confirm');
    const cancelBtn = document.getElementById('prompt-modal-cancel');

    titleEl.textContent = title;
    input.value = defaultVal;
    modal.style.display = 'flex';
    setTimeout(() => { input.focus(); input.select(); }, 40);

    const cleanup = () => { modal.style.display = 'none'; };

    const onConfirm = () => {
      cleanup();
      confirmBtn.removeEventListener('click', onConfirm);
      cancelBtn.removeEventListener('click', onCancel);
      input.removeEventListener('keydown', onKey);
      resolve(input.value.trim() || null);
    };
    const onCancel = () => {
      cleanup();
      confirmBtn.removeEventListener('click', onConfirm);
      cancelBtn.removeEventListener('click', onCancel);
      input.removeEventListener('keydown', onKey);
      resolve(null);
    };
    const onKey = (e) => {
      if (e.key === 'Enter') onConfirm();
      if (e.key === 'Escape') onCancel();
    };
    confirmBtn.addEventListener('click', onConfirm);
    cancelBtn.addEventListener('click', onCancel);
    input.addEventListener('keydown', onKey);
  });
}

// ═══════════════════════════════════════════
//  状態
// ═══════════════════════════════════════════
const S = {
  tabs: [], active: null, dark: false, tabTree: [],
  bookmarks: [],      // スペース0のブックマーク
  bookmarks2: [],     // スペース1のブックマーク（日時指定で消える）
  currentSpace: 0,
  // ワークスペース
  workspaces: [
    { id: 'ws0', name: 'メイン', avatar: 'S', color: '#3478f6', accountEmail: '', tabs: [], bookmarks: [] },
  ],
  activeWorkspace: 0,
  pinnedApps: [],
  layout: 'vertical', // 'vertical' | 'horizontal'
};

// ═══════════════════════════════════════════
//  要素
// ═══════════════════════════════════════════
const sb      = document.getElementById('sb');
const track   = document.getElementById('sb-track');
const trig    = document.getElementById('trig');
const urlDisp = document.getElementById('tb-url');
const overlay = document.getElementById('url-ov');
const urlInp  = document.getElementById('url-inp');
const esc     = s => { const d = document.createElement('div'); d.textContent = s; return d.innerHTML; };

// ═══════════════════════════════════════════
//  サイドバー開閉
// ═══════════════════════════════════════════
let hideT = null;
let _sbOpen = false;

function openSB() {
  if (S.layout === 'horizontal') return; // 水平レイアウト時は無効
  clearTimeout(hideT);
  hideT = null;
  if (_sbOpen) return;
  _sbOpen = true;
  sb.classList.add('open');
  window.browser.sbOpen();
}
function closeSB(delay = 200) {
  if (S.layout === 'horizontal') return; // 水平レイアウト時は無効
  clearTimeout(hideT);
  hideT = setTimeout(() => {
    hideT = null;
    if (!_sbOpen) return;
    _sbOpen = false;
    sb.classList.remove('open');
    window.browser.sbClose();
  }, delay);
}

// ── サイドバーリサイズ ──
(function() {
  const handle = document.getElementById('sb-resize-handle');
  if (!handle) return;
  const MIN_W = 60, MAX_W = 480, DEFAULT_W = 240;
  let dragging = false, startX = 0, startW = 0;

  function applyWidth(w) {
    const sbEl = document.getElementById('sb');
    if (!sbEl) return;
    document.documentElement.style.setProperty('--sb-w', w + 'px');
    sbEl.style.transform = '';
    sbEl.style.width = w + 'px';
    sbEl.style.height = '';
    // DEFAULT_Wより狭い場合はnarrowクラスで横スクロール有効化
    if (w < DEFAULT_W) {
      sbEl.classList.add('narrow');
    } else {
      sbEl.classList.remove('narrow');
      sbEl.style.overflowX = '';
    }
  }

  handle.addEventListener('mousedown', e => {
    e.preventDefault();
    dragging = true;
    startX = e.clientX;
    startW = parseInt(getComputedStyle(document.documentElement).getPropertyValue('--sb-w')) || DEFAULT_W;
    handle.classList.add('dragging');
    document.body.style.cursor = 'ew-resize';
    document.body.style.userSelect = 'none';
  });

  document.addEventListener('mousemove', e => {
    if (!dragging) return;
    const newW = Math.min(MAX_W, Math.max(MIN_W, startW + (e.clientX - startX)));
    applyWidth(newW);
  });

  document.addEventListener('mouseup', () => {
    if (!dragging) return;
    dragging = false;
    handle.classList.remove('dragging');
    document.body.style.cursor = '';
    document.body.style.userSelect = '';
    const w = parseInt(getComputedStyle(document.documentElement).getPropertyValue('--sb-w'));
    try { localStorage.setItem('sb-width', w); } catch(e) {}
  });

  try {
    const saved = localStorage.getItem('sb-width');
    if (saved) applyWidth(parseInt(saved));
  } catch(e) {}
})();

function isModalOpen() {
  return document.getElementById('import-modal').classList.contains('show')
      || document.getElementById('bm2-date-modal').classList.contains('show')
      || document.getElementById('bm1-add-modal').classList.contains('show')
      || document.getElementById('notif-modal').classList.contains('show')
      || document.getElementById('history-modal').classList.contains('show')
      || document.getElementById('download-modal').classList.contains('show')
      || document.getElementById('bm-edit-modal').classList.contains('show')
      || document.getElementById('workspace-modal')?.classList.contains('show')
      || document.getElementById('notif-hub-panel')?.classList.contains('show')
      || document.getElementById('ext-panel')?.classList.contains('show')
      || (document.getElementById('ws-login-modal') !== null)
      || (document.getElementById('prompt-modal')?.style.display === 'flex')
      || (document.getElementById('split-modal')?.style.display === 'flex')
      || (document.getElementById('settings-modal')?.style.display === 'flex')
      || ctxMenu !== null
      || overlay.classList.contains('show');
}

// モーダル開閉状態をmain processに通知（水平レイアウト時のhit-testing制御用）
let _lastModalOpenState = false;
function notifyModalState() {
  const open = isModalOpen();
  if (open !== _lastModalOpenState) {
    _lastModalOpenState = open;
    try { window.browser.send('ui:modal-state', open); } catch {}
  }
}

sb.addEventListener('mouseenter', () => { clearTimeout(hideT); openSB(); });
sb.addEventListener('mouseleave', e => {
  if (isModalOpen()) return;
  if (e.relatedTarget && trig.contains(e.relatedTarget)) return;
  closeSB(350);
});
window.browser.onTrigEnter(() => { openSB(); });
window.browser.onTrigLeave(() => {
  if (isModalOpen()) return;
  closeSB(400);
});

// SB展開中にマウスがuiViewの外に出たら閉じる
document.addEventListener('mouseleave', () => {
  if (!_sbOpen) return;
  if (isModalOpen()) return;
  closeSB(200);
});

document.addEventListener('click', e => {
  // AIパネル内クリックは何もしない（オーバーレイ・×はai.js側で処理済み）
  const aiPanel = document.getElementById('ai-panel');
  if (aiPanel?.contains(e.target)) return;

  // 通常のサイドバー閉じ判定
  if (isModalOpen()) return;
  if (!sb.contains(e.target) && !trig.contains(e.target)) {
    closeSB(100);
  }
});

// ═══════════════════════════════════════════
//  スペース（ペイン）切り替え ※ワークスペース切り替えに統合
// ═══════════════════════════════════════════
function goToSpace(idx, animated = true) {
  // スペースは常に0（pane-0のみ使用）。ワークスペース切り替えはswitchWorkspaceで行う
  S.currentSpace = 0;
  track.style.transform = 'translateX(0)';
  document.querySelectorAll('.sdot').forEach((d, i) => {
    d.classList.toggle('on', i === 0);
  });
}

document.querySelectorAll('.sdot').forEach(d => {
  d.addEventListener('click', () => {
    const idx = +d.dataset.idx;
    if (idx < S.workspaces.length) switchWorkspace(idx);
  });
});

// ═══════════════════════════════════════════
//  2本指スワイプ → ワークスペース切り替え
// ═══════════════════════════════════════════
let swipeAccum = 0;
let swipeTimer = null;

sb.addEventListener('wheel', e => {
  // 縦スクロール優先（deltaYが大きい場合は横スワイプとみなさない）
  if (Math.abs(e.deltaX) < 5) return;
  if (Math.abs(e.deltaY) > Math.abs(e.deltaX) * 2) return;
  e.preventDefault(); e.stopPropagation();
  swipeAccum += e.deltaX;
  clearTimeout(swipeTimer);
  swipeTimer = setTimeout(() => { swipeAccum = 0; }, 400);
  if (swipeAccum > 40 && S.activeWorkspace < S.workspaces.length - 1) {
    swipeAccum = 0; switchWorkspace(S.activeWorkspace + 1);
  } else if (swipeAccum < -40 && S.activeWorkspace > 0) {
    swipeAccum = 0; switchWorkspace(S.activeWorkspace - 1);
  }
}, { passive: false });

let touchStartX = 0;
sb.addEventListener('touchstart', e => { touchStartX = e.touches[0].clientX; }, { passive: true });
sb.addEventListener('touchend', e => {
  const dx = e.changedTouches[0].clientX - touchStartX;
  if (dx > 60 && S.activeWorkspace > 0) switchWorkspace(S.activeWorkspace - 1);
  if (dx < -60 && S.activeWorkspace < S.workspaces.length - 1) switchWorkspace(S.activeWorkspace + 1);
}, { passive: true });

// ═══════════════════════════════════════════
//  URL表示
// ═══════════════════════════════════════════
function updateUrl(url) {
  if (!url) { urlDisp.textContent = '新しいタブ'; updateHUrl(''); return; }
  try {
    const u = new URL(url);
    urlDisp.textContent = u.hostname.replace(/^www\./, '');
  } catch { urlDisp.textContent = url.slice(0, 40); }
  updateHUrl(url);
}

urlDisp.addEventListener('click', () => {
  overlay.classList.add('show');
  const t = S.tabs.find(x => x.id === S.active);
  urlInp.value = t?.url || '';
  setTimeout(() => { urlInp.focus(); urlInp.select(); }, 40);
  sgReset();
  // 履歴を最新に更新
  window.browser.getHistory?.().then(h => { browseHistoryCache = h || []; }).catch(() => {});
});
overlay.addEventListener('click', e => { if (e.target === overlay) { overlay.classList.remove('show'); sgReset(); } });

async function commitUrl(val) {
  const v = (val || urlInp.value).trim();
  overlay.classList.remove('show');
  sgReset();
  if (!v) return;
  if (S.active) await window.browser.navigate(S.active, v);
  else await newTab(v);
}
document.getElementById('url-go-btn').addEventListener('click', () => commitUrl());

// ═══════════════════════════════════════════
//  オートコンプリート（Chrome同等速度）
// ═══════════════════════════════════════════
const sgList   = document.getElementById('suggest-list');
let sgItems    = [];   // { type, label, url, sub }
let sgActive   = -1;   // キーボード選択インデックス
let sgDebounce = null;
let sgAbort    = null; // fetch abort controller

// SVG アイコン
const ICON_SEARCH = `<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="11" cy="11" r="8"/><path d="m21 21-4.35-4.35"/></svg>`;
const ICON_GLOBE  = `<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><path d="M2 12h20M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10A15.3 15.3 0 0 1 12 2z"/></svg>`;
const ICON_HIST   = `<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/></svg>`;
const ICON_BM     = `<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="m19 21-7-5-7 5V5a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2z"/></svg>`;

function sgReset() {
  sgItems = []; sgActive = -1;
  sgList.innerHTML = '';
  sgList.classList.remove('show');
  if (sgAbort) { sgAbort.abort(); sgAbort = null; }
  clearTimeout(sgDebounce);
}

function sgHighlight(text, query) {
  if (!query) return esc(text);
  const idx = text.toLowerCase().indexOf(query.toLowerCase());
  if (idx < 0) return esc(text);
  return esc(text.slice(0, idx)) + '<b>' + esc(text.slice(idx, idx + query.length)) + '</b>' + esc(text.slice(idx + query.length));
}

function sgRender(query) {
  sgList.innerHTML = '';
  sgActive = -1;
  if (sgItems.length === 0) { sgList.classList.remove('show'); return; }
  sgList.classList.add('show');
  sgItems.forEach((item, i) => {
    if (item.type === 'sep') {
      const sep = document.createElement('div');
      sep.className = 'sg-sep'; sgList.appendChild(sep); return;
    }
    const el = document.createElement('div');
    el.className = 'sg-item';
    el.dataset.idx = i;
    const icon = item.type === 'history' ? ICON_HIST : item.type === 'bookmark' ? ICON_BM : item.type === 'url' ? ICON_GLOBE : ICON_SEARCH;
    el.innerHTML = `<span class="sg-icon">${icon}</span><span class="sg-text">${sgHighlight(item.label, query)}</span>${item.sub ? `<span class="sg-sub">${esc(item.sub)}</span>` : ''}`;
    el.addEventListener('mousedown', e => { e.preventDefault(); commitUrl(item.url); });
    el.addEventListener('mouseover', () => { sgSetActive(i); });
    sgList.appendChild(el);
  });
}

function sgSetActive(idx) {
  const els = sgList.querySelectorAll('.sg-item');
  els.forEach(e => e.classList.remove('active'));
  sgActive = idx;
  if (idx >= 0 && idx < sgItems.length) {
    const el = sgList.querySelector(`[data-idx="${idx}"]`);
    if (el) el.classList.add('active');
    urlInp.value = sgItems[idx].url;
  }
}

function isUrl(s) {
  if (s.startsWith('http://') || s.startsWith('https://')) return true;
  if (/^[a-zA-Z0-9-]+\.[a-zA-Z]{2,}(\/|$)/.test(s) && !s.includes(' ')) return true;
  return false;
}

async function sgFetch(query) {
  if (!query || query.length < 1) { sgReset(); return; }

  // ローカル候補（履歴＋ブックマーク）を即時表示
  const localItems = [];
  const q = query.toLowerCase();

  // 履歴から最大4件
  if (typeof browseHistoryCache !== 'undefined') {
    browseHistoryCache.filter(h => h.url?.toLowerCase().includes(q) || h.title?.toLowerCase().includes(q))
      .slice(0, 4).forEach(h => localItems.push({ type: 'history', label: h.title || h.url, url: h.url, sub: new URL(h.url).hostname }));
  }

  // ブックマークから最大3件（重複排除）
  const bmUrls = new Set(localItems.map(x => x.url));
  const allBm = [...(S.bookmarks || []), ...(S.workspaces?.flatMap(w => w.bookmarks || []) || [])];
  allBm.filter(b => (b.url?.toLowerCase().includes(q) || b.name?.toLowerCase().includes(q)) && !bmUrls.has(b.url))
    .slice(0, 3).forEach(b => localItems.push({ type: 'bookmark', label: b.name || b.url, url: b.url }));

  // URL直接入力の場合はローカルのみ
  if (isUrl(query)) {
    sgItems = [{ type: 'url', label: query.startsWith('http') ? query : 'https://' + query, url: query.startsWith('http') ? query : 'https://' + query }];
    if (localItems.length) { sgItems.push({ type: 'sep' }); sgItems.push(...localItems); }
    sgRender(query);
    return;
  }

  // ローカル候補を先に表示
  sgItems = localItems.length ? localItems : [];
  if (sgItems.length) sgRender(query);

  // Google Suggest API（CORS対策でpreloadで取得）
  if (sgAbort) sgAbort.abort();
  sgAbort = new AbortController();
  try {
    const res = await fetch(
      `https://suggestqueries.google.com/complete/search?client=firefox&q=${encodeURIComponent(query)}`,
      { signal: sgAbort.signal }
    );
    if (!res.ok) throw new Error('suggest fail');
    const data = await res.json();
    const suggestions = (data[1] || []).slice(0, 6);
    const searchItems = suggestions.map(s => ({ type: 'search', label: s, url: `https://www.google.com/search?q=${encodeURIComponent(s)}` }));
    // ローカル候補 → セパレーター → Google候補
    sgItems = [...searchItems];
    if (localItems.length) { sgItems.push({ type: 'sep' }); sgItems.push(...localItems); }
    sgRender(query);
  } catch(e) {
    if (e.name === 'AbortError') return;
    // フォールバック：ローカル候補 + 検索候補
    sgItems = [
      { type: 'search', label: query, url: `https://www.google.com/search?q=${encodeURIComponent(query)}` },
      ...localItems
    ];
    sgRender(query);
  }
}

// 履歴キャッシュ（非同期で取得しておく）
let browseHistoryCache = [];
window.browser.getHistory?.().then(h => { browseHistoryCache = h || []; }).catch(() => {});
// ── 入力イベント
urlInp.addEventListener('input', () => {
  const q = urlInp.value.trim();
  clearTimeout(sgDebounce);
  if (!q) { sgReset(); return; }
  // 即時ローカル候補 + 80ms後にAPI
  sgDebounce = setTimeout(() => sgFetch(q), 60);
});

urlInp.addEventListener('keydown', e => {
  const items = sgList.querySelectorAll('.sg-item');
  if (e.key === 'ArrowDown') {
    e.preventDefault();
    let next = sgActive + 1;
    while (next < sgItems.length && sgItems[next].type === 'sep') next++;
    if (next < sgItems.length) sgSetActive(next);
    return;
  }
  if (e.key === 'ArrowUp') {
    e.preventDefault();
    if (sgActive <= 0) { sgActive = -1; urlInp.value = urlInp.dataset.rawVal || urlInp.value; return; }
    let prev = sgActive - 1;
    while (prev > 0 && sgItems[prev].type === 'sep') prev--;
    sgSetActive(prev);
    return;
  }
  if (e.key === 'Enter') {
    if (sgActive >= 0 && sgItems[sgActive]) commitUrl(sgItems[sgActive].url);
    else commitUrl();
    return;
  }
  if (e.key === 'Escape') { overlay.classList.remove('show'); sgReset(); return; }
  // 入力中は rawVal 保存
  urlInp.dataset.rawVal = urlInp.value;
});

// ═══════════════════════════════════════════
//  タブ管理
// ═══════════════════════════════════════════
async function newTab(url) {
  const wsId = S.workspaces[S.activeWorkspace]?.id || 'main';
  const id = await window.browser.createTab(url || 'https://www.google.com', wsId);
  S.tabs.push({ id, title: '読み込み中...', url: url || 'https://www.google.com', fav: null, loading: true });
  await activateTab(id);
  syncTabTree();
  scheduleSave();
}

async function activateTab(id) {
  S.active = id;
  await window.browser.activateTab(id);
  const t = S.tabs.find(x => x.id === id);
  updateUrl(t?.url || '');
  renderTabs();
  updateNav();
}

async function closeTab(id, e) {
  e?.stopPropagation();
  // タブが1つの場合は閉じない
  if (S.tabs.length <= 1) return;
  await window.browser.closeTab(id);
  const idx = S.tabs.findIndex(x => x.id === id);
  S.tabs.splice(idx, 1);
  if (S.active === id) {
    if (S.tabs.length) await activateTab(S.tabs[Math.max(0, idx - 1)].id);
    else { S.active = null; updateUrl(''); }
  }
  renderTabs();
  scheduleSave();
}

// ═══════════════════════════════════════════
//  ファビコン取得
// ═══════════════════════════════════════════
// ═══════════════════════════════════════════
//  ファビコン取得 (Google S2統一)
// ═══════════════════════════════════════════
function s2Url(hostname) {
  return `https://www.google.com/s2/favicons?domain=${encodeURIComponent(hostname)}&sz=32`;
}
function faviconFromUrl(url) {
  try { return s2Url(new URL(url).hostname); } catch { return ''; }
}
// 後方互換
function getFavicon(url) { return faviconFromUrl(url); }
function getFaviconAsync(url, cb) {
  const fav = faviconFromUrl(url);
  if (fav) cb(fav);
}


// ═══════════════════════════════════════════
//  ドラッグ＆ドロップ共通ユーティリティ
// ═══════════════════════════════════════════
const DRAG_SVG = `<svg width="10" height="14" viewBox="0 0 10 14" fill="none"><circle cx="3" cy="2.5" r="1.2" fill="currentColor"/><circle cx="7" cy="2.5" r="1.2" fill="currentColor"/><circle cx="3" cy="7" r="1.2" fill="currentColor"/><circle cx="7" cy="7" r="1.2" fill="currentColor"/><circle cx="3" cy="11.5" r="1.2" fill="currentColor"/><circle cx="7" cy="11.5" r="1.2" fill="currentColor"/></svg>`;
const FOLDER_SVG = `<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/></svg>`;
const ARROW_SVG = `<svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path d="M9 18l6-6-6-6"/></svg>`;

let dragSrc = null; // { type:'bm'|'tab', id, parentArr, index }

// ツリーからidのノードを探し親配列と共に返す
function findNode(tree, id) {
  for (let i = 0; i < tree.length; i++) {
    if (tree[i].id === id) return { node: tree[i], arr: tree, idx: i };
    if (tree[i].type === 'folder' && tree[i].children) {
      const r = findNode(tree[i].children, id);
      if (r) return r;
    }
  }
  return null;
}

// ツリーからノードを削除（移動時）
function removeFromTree(tree, id) {
  for (let i = 0; i < tree.length; i++) {
    if (tree[i].id === id) { tree.splice(i, 1); return true; }
    if (tree[i].type === 'folder' && tree[i].children) {
      if (removeFromTree(tree[i].children, id)) return true;
    }
  }
  return false;
}

// フォルダに子孫としてidを含むか（循環防止）
function containsId(folder, id) {
  if (!folder.children) return false;
  for (const c of folder.children) {
    if (c.id === id) return true;
    if (c.type === 'folder' && containsId(c, id)) return true;
  }
  return false;
}

function setupDrag(rowEl, handleEl, id, getTree, renderFn, dragType) {
  handleEl.draggable = true;
  handleEl.addEventListener('dragstart', e => {
    e.stopPropagation();
    dragSrc = { type: dragType, id };
    rowEl.classList.add('dragging');
    e.dataTransfer.effectAllowed = 'move';
    e.dataTransfer.setData('text/plain', id);
  });
  handleEl.addEventListener('dragend', () => {
    dragSrc = null;
    rowEl.classList.remove('dragging');
    document.querySelectorAll('.drag-over-top,.drag-over-bottom,.drag-over-folder').forEach(x => {
      x.classList.remove('drag-over-top','drag-over-bottom','drag-over-folder');
    });
  });
}

function setupDropTarget(el, id, getTree, renderFn, dragType, isFolder) {
  el.addEventListener('dragover', e => {
    if (!dragSrc || dragSrc.type !== dragType) return;
    if (dragSrc.id === id) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
    el.classList.remove('drag-over-top','drag-over-bottom','drag-over-folder');
    if (isFolder) {
      el.classList.add('drag-over-folder');
    } else {
      const r = el.getBoundingClientRect();
      if (e.clientY < r.top + r.height / 2) el.classList.add('drag-over-top');
      else el.classList.add('drag-over-bottom');
    }
  });
  el.addEventListener('dragleave', () => {
    el.classList.remove('drag-over-top','drag-over-bottom','drag-over-folder');
  });
  el.addEventListener('drop', e => {
    e.preventDefault();
    el.classList.remove('drag-over-top','drag-over-bottom','drag-over-folder');
    if (!dragSrc || dragSrc.type !== dragType || dragSrc.id === id) return;
    const tree = getTree();
    const srcResult = findNode(tree, dragSrc.id);
    const dstResult = findNode(tree, id);
    if (!srcResult || !dstResult) return;
    const srcNode = { ...srcResult.node };
    // フォルダへのドロップ（循環防止）
    if (isFolder) {
      if (srcNode.type === 'folder' && (srcNode.id === id || containsId(srcNode, id))) return;
      removeFromTree(tree, dragSrc.id);
      const dstNode = findNode(tree, id);
      if (!dstNode) return;
      if (!dstNode.node.children) dstNode.node.children = [];
      dstNode.node.children.push(srcNode);
    } else {
      // 上下挿入
      const before = el.classList.contains('drag-over-top');
      removeFromTree(tree, dragSrc.id);
      const dstResult2 = findNode(tree, id);
      if (!dstResult2) return;
      const ins = before ? dstResult2.idx : dstResult2.idx + 1;
      dstResult2.arr.splice(ins, 0, srcNode);
    }
    renderFn();
    scheduleSave();
  });
}

// ═══════════════════════════════════════════
//  ブックマーク（ツリー構造）
// ═══════════════════════════════════════════
// S.bookmarks は { id, type:'item'|'folder', name, url?, fav?, children? }[] のツリー

function renderBMNode(node, container) {
  if (node.type === 'folder') {
    const wrap = document.createElement('div');
    wrap.className = 'folder-item' + (node._open ? ' open' : '');
    wrap.dataset.id = node.id;

    const head = document.createElement('div');
    head.className = 'folder-head';
    const _dh = document.createElement('span');
    _dh.className = 'drag-handle'; _dh.innerHTML = DRAG_SVG;
    const _arr = document.createElement('span');
    _arr.className = 'folder-icon'; _arr.innerHTML = ARROW_SVG;
    const _fn = document.createElement('span');
    _fn.className = 'folder-name'; _fn.textContent = node.name;
    head.appendChild(_dh); head.appendChild(_arr); head.appendChild(_fn);

    head.addEventListener('click', e => {
      if (_dh.contains(e.target)) return;
      node._open = !node._open;
      wrap.classList.toggle('open', !!node._open);
    });
    const folderMenuItems = [
      { label: 'フォルダ名を変更', action: () => promptRename(node, renderBM) },
      { label: 'ブックマークを追加', action: () => openBmAddModal(node.children) },
      { label: 'フォルダを追加', action: () => addFolder(node.children, renderBM) },
      { label: '削除', action: () => { removeFromTree(S.bookmarks, node.id); renderBM(); scheduleSave(); } },
    ];
    head.addEventListener('contextmenu', e => {
      e.preventDefault();
      showContextMenu(e.clientX, e.clientY, folderMenuItems);
    });
    addLongPress(head, (x, y) => showContextMenu(x, y, folderMenuItems));

    setupDrag(wrap, _dh, node.id, () => S.bookmarks, renderBM, 'bm');
    setupDropTarget(head, node.id, () => S.bookmarks, renderBM, 'bm', false);

    const children = document.createElement('div');
    children.className = 'folder-children';
    (node.children || []).forEach(child => renderBMNode(child, children));
    setupDropTarget(children, node.id, () => S.bookmarks, renderBM, 'bm', true);

    wrap.appendChild(head);
    wrap.appendChild(children);
    container.appendChild(wrap);
  } else {
    const d = document.createElement('div');
    d.className = 'bm-item';
    d.dataset.id = node.id;
    const fav = node.url ? faviconFromUrl(node.url) : '';
    const ico = fav ? `<img class="bm-fav" src="${fav}" onerror="this.outerHTML='<div class=bm-fav-ph></div>'">` : '<div class="bm-fav-ph"></div>';
    const _dh2 = document.createElement('span');
    _dh2.className = 'drag-handle'; _dh2.innerHTML = DRAG_SVG;
    const _icoWrap = document.createElement('span');
    _icoWrap.innerHTML = ico;
    const _bn = document.createElement('span');
    _bn.className = 'bm-name'; _bn.textContent = node.name;
    d.appendChild(_dh2);
    if (_icoWrap.firstChild) d.appendChild(_icoWrap.firstChild);
    d.appendChild(_bn);
    d.addEventListener('click', e => {
      if (_dh2.contains(e.target)) return;
      if (node.url) { if (S.active) window.browser.navigate(S.active, node.url); else newTab(node.url); }
    });
    const bmMenuItems = [
      { label: '編集', action: () => openBmEditModal(node, 'bm1') },
      { label: '削除', action: () => { removeFromTree(S.bookmarks, node.id); renderBM(); scheduleSave(); } },
    ];
    d.addEventListener('contextmenu', e => {
      e.preventDefault();
      showContextMenu(e.clientX, e.clientY, bmMenuItems);
    });
    addLongPress(d, (x, y) => showContextMenu(x, y, bmMenuItems));
    setupDrag(d, _dh2, node.id, () => S.bookmarks, renderBM, 'bm');
    setupDropTarget(d, node.id, () => S.bookmarks, renderBM, 'bm', false);
    container.appendChild(d);
  }
}

function renderBM() {
  const el = document.getElementById('bm-list');
  el.innerHTML = '';
  S.bookmarks.forEach(node => renderBMNode(node, el));
  renderHSidebar();
  renderHBmbar();
}
;(function(){
  const _bmList = document.getElementById('bm-list');
  _bmList.addEventListener('contextmenu', e => {
    if (e.target !== _bmList) return;
    e.preventDefault();
    showContextMenu(e.clientX, e.clientY, [
      { label: 'フォルダを作成', action: () => addFolder(S.bookmarks, renderBM) },
      { label: 'ブックマークを追加', action: () => openBmAddModal(S.bookmarks) },
    ]);
  });
})();

function openBmAddModal(targetArr) {
  const modal = document.getElementById('bm1-add-modal');
  document.getElementById('bm1-name-input').value = '';
  document.getElementById('bm1-url-input').value = '';
  modal.classList.add('show');
  modal._targetArr = targetArr || S.bookmarks;
  setTimeout(() => document.getElementById('bm1-name-input').focus(), 40);
}

function addFolder(targetArr, renderFn) {
  showPrompt('フォルダ名を入力してください', '新しいフォルダ').then(name => {
    if (!name) return;
    const arr = targetArr || S.bookmarks;
    arr.push({ id: 'f_' + Date.now(), type: 'folder', name: name.slice(0, 30), children: [], _open: true });
    renderFn();
    scheduleSave();
  });
}

function promptRename(node, renderFn) {
  showPrompt('新しい名前を入力してください', node.name).then(name => {
    if (!name) return;
    node.name = name.slice(0, 30);
    renderFn();
    scheduleSave();
  });
}

// ブックマーク追加モーダル
document.getElementById('bm1-plus-btn').addEventListener('click', () => openBmAddModal(S.bookmarks));
document.getElementById('bm1-folder-btn').addEventListener('click', () => addFolder(S.bookmarks, renderBM));

document.getElementById('bm1-modal-confirm').addEventListener('click', () => {
  const name = document.getElementById('bm1-name-input').value.trim();
  const url  = document.getElementById('bm1-url-input').value.trim();
  if (!url) return;
  let u = url;
  if (!u.startsWith('http://') && !u.startsWith('https://')) u = 'https://' + u;
  const bmName = (name || u).slice(0, 32);
  const targetArr = document.getElementById('bm1-add-modal')._targetArr || S.bookmarks;
  targetArr.push({ id: 'bm_' + Date.now(), type: 'item', name: bmName, url: u, fav: null });
  renderBM();
  scheduleSave();
  document.getElementById('bm1-add-modal').classList.remove('show');
  // ブックマーク追加通知
  showNotifToast('「' + bmName + '」をブックマークに追加しました');
  addHubNotif({ title: 'ブックマーク追加', body: bmName, time: Date.now(), appKey: null });
});

document.getElementById('bm1-modal-cancel').addEventListener('click', () => {
  document.getElementById('bm1-add-modal').classList.remove('show');
});
document.getElementById('bm1-url-input').addEventListener('keydown', e => {
  if (e.key === 'Enter') document.getElementById('bm1-modal-confirm').click();
  if (e.key === 'Escape') document.getElementById('bm1-add-modal').classList.remove('show');
});
document.getElementById('bm1-name-input').addEventListener('keydown', e => {
  if (e.key === 'Escape') document.getElementById('bm1-add-modal').classList.remove('show');
});

// ═══════════════════════════════════════════
//  タブ（ツリー構造 + ドラッグ）
// ═══════════════════════════════════════════
// S.tabTree は { id, type:'tab'|'folder', name?, children? }[]
// 実際のタブ情報は S.tabs に id で参照

if (!S.tabTree) S.tabTree = [];

function renderTabNode(node, container) {
  if (node.type === 'folder') {
    const wrap = document.createElement('div');
    wrap.className = 'tab-folder-item' + (node._open !== false ? ' open' : '');
    wrap.dataset.id = node.id;

    const head = document.createElement('div');
    head.className = 'tab-folder-head';
    const count = countTabsInFolder(node);
    const _tdh = document.createElement('span');
    _tdh.className = 'drag-handle'; _tdh.innerHTML = DRAG_SVG;
    const _tarr = document.createElement('span');
    _tarr.className = 'folder-icon'; _tarr.innerHTML = ARROW_SVG;
    const _tname = document.createElement('span');
    _tname.className = 'tab-title'; _tname.textContent = node.name;
    const _tcnt = document.createElement('span');
    _tcnt.style.cssText = 'font-size:10px;color:var(--textm);margin-right:4px';
    _tcnt.textContent = count;
    head.appendChild(_tdh); head.appendChild(_tarr); head.appendChild(_tname); head.appendChild(_tcnt);

    head.addEventListener('click', e => {
      if (_tdh.contains(e.target)) return;
      node._open = node._open === false ? true : false;
      wrap.classList.toggle('open', node._open !== false);
    });
    head.addEventListener('contextmenu', e => {
      e.preventDefault();
      showContextMenu(e.clientX, e.clientY, [
        { label: 'フォルダ名を変更', action: () => showPrompt('新しい名前', node.name).then(n => { if (n) { node.name = n.slice(0,30); renderTabs(); scheduleSave(); } }) },
        { label: '削除（タブは残す）', action: () => {
          const r = findNode(S.tabTree, node.id);
          if (r) { const flat = flattenTabFolder(node); r.arr.splice(r.idx, 1, ...flat); }
          renderTabs(); scheduleSave();
        }},
      ]);
    });
    setupDrag(wrap, _tdh, node.id, () => S.tabTree, renderTabs, 'tab');
    // フォルダheadへのドロップ → フォルダに入れる
    setupDropTarget(head, node.id, () => S.tabTree, renderTabs, 'tab', true);

    const children = document.createElement('div');
    children.className = 'tab-folder-children';
    (node.children || []).forEach(child => renderTabNode(child, children));
    setupDropTarget(children, node.id, () => S.tabTree, renderTabs, 'tab', true);

    wrap.appendChild(head);
    wrap.appendChild(children);
    container.appendChild(wrap);
  } else {
    // タブノード
    const t = S.tabs.find(x => x.id === node.id);
    if (!t) return;
    const d = document.createElement('div');
    d.className = 'tab-item' + (t.id === S.active ? ' active' : '');
    d.dataset.id = node.id;
    // Google S2で常にfaviconを取得（同期・確実）
    const fav = t.fav || (t.url ? faviconFromUrl(t.url) : '');
    const ico = t.loading ? '<div class="tab-spin"></div>'
      : fav ? `<img class="tab-fav" src="${fav}" onerror="this.outerHTML='<div class=tab-fav-ph></div>'">`
      : '<div class="tab-fav-ph"></div>';
    const canClose = S.tabs.length > 1;
    const _tabdh = document.createElement('span');
    _tabdh.className = 'drag-handle'; _tabdh.innerHTML = DRAG_SVG;
    const _tabIcoWrap = document.createElement('span');
    _tabIcoWrap.innerHTML = ico;
    const _tabTitle = document.createElement('span');
    const _displayTitle = (window.spiralAI && t.smartTitle) ? t.smartTitle : (t.title || 'New Tab');
    _tabTitle.className = 'tab-title'; _tabTitle.textContent = _displayTitle;
    d.appendChild(_tabdh);
    if (_tabIcoWrap.firstChild) d.appendChild(_tabIcoWrap.firstChild);
    d.appendChild(_tabTitle);
    if (canClose) {
      const xBtn = document.createElement('button');
      xBtn.className = 'tab-x'; xBtn.textContent = '×';
      xBtn.addEventListener('click', e => closeTab(t.id, e));
      d.appendChild(xBtn);
    }
    d.addEventListener('click', e => {
      if (_tabdh.contains(e.target)) return;
      if (e.target.classList.contains('tab-x')) return;
      activateTab(t.id);
    });
    setupDrag(d, _tabdh, node.id, () => S.tabTree, renderTabs, 'tab');
    setupDropTarget(d, node.id, () => S.tabTree, renderTabs, 'tab', false);
    container.appendChild(d);
  }
}

function countTabsInFolder(folder) {
  let n = 0;
  for (const c of (folder.children || [])) {
    if (c.type === 'folder') n += countTabsInFolder(c);
    else n++;
  }
  return n;
}

function flattenTabFolder(folder) {
  const result = [];
  for (const c of (folder.children || [])) {
    if (c.type === 'folder') result.push(...flattenTabFolder(c));
    else result.push(c);
  }
  return result;
}

// S.tabTree を S.tabs に同期（新しいタブがあれば末尾に追加、削除済みを取り除く）
function syncTabTree() {
  const ids = new Set(S.tabs.map(t => t.id));
  // ツリーから存在しないタブを削除
  function pruneTree(arr) {
    for (let i = arr.length - 1; i >= 0; i--) {
      if (arr[i].type === 'folder') {
        pruneTree(arr[i].children || []);
      } else {
        if (!ids.has(arr[i].id)) arr.splice(i, 1);
      }
    }
  }
  pruneTree(S.tabTree);
  // ツリーに含まれていない新タブを末尾に追加
  function allIdsInTree(arr) {
    const set = new Set();
    function walk(a) { for (const n of a) { if (n.type==='folder') walk(n.children||[]); else set.add(n.id); } }
    walk(arr);
    return set;
  }
  const inTree = allIdsInTree(S.tabTree);
  for (const t of S.tabs) {
    if (!inTree.has(t.id)) S.tabTree.push({ id: t.id, type: 'tab' });
  }
}

function renderTabs() {
  syncTabTree();
  const el = document.getElementById('tabs-list');
  el.innerHTML = '';
  S.tabTree.forEach(node => renderTabNode(node, el));
  // 分割中にタブが消えていたら解除
  if (splitState?.active) {
    const allIds = S.tabs.map(t => t.id);
    if (splitState.ids.some(id => !allIds.includes(id))) doSplitClear();
  }
  updateSplitBtn();
  // 水平レイアウト時は専用タブバーも更新
  renderHTabs();
  // 下部splitボタン同期
  const hSplit = document.getElementById('h-btn-split');
  if (hSplit) { hSplit.disabled = document.getElementById('btn-split')?.disabled; }
}

;(function(){
  const _tabsList = document.getElementById('tabs-list');
  _tabsList.addEventListener('contextmenu', e => {
    if (e.target !== _tabsList) return;
    e.preventDefault();
    showContextMenu(e.clientX, e.clientY, [
      { label: 'フォルダを作成', action: () => {
        showPrompt('フォルダ名を入力してください', '新しいフォルダ').then(name => {
          if (!name) return;
          S.tabTree.push({ id: 'tf_'+Date.now(), type:'folder', name:name.slice(0,30), children:[], _open:true });
          renderTabs(); scheduleSave();
        });
      }},
    ]);
  });

  // タブリスト直下へのドロップ → フォルダから出す（末尾に追加）
  _tabsList.addEventListener('dragover', e => {
    if (!dragSrc || dragSrc.type !== 'tab') return;
    // 子要素の上なら無視（子要素のdropTargetが処理する）
    if (e.target !== _tabsList) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
  });
  _tabsList.addEventListener('drop', e => {
    if (!dragSrc || dragSrc.type !== 'tab') return;
    if (e.target !== _tabsList) return;
    e.preventDefault();
    const srcResult = findNode(S.tabTree, dragSrc.id);
    if (!srcResult) return;
    const srcNode = { ...srcResult.node };
    removeFromTree(S.tabTree, dragSrc.id);
    S.tabTree.push(srcNode);
    renderTabs(); scheduleSave();
  });
})();

// ═══════════════════════════════════════════
//  ブックマーク2（スペース1 - 日時指定で消える）
// ═══════════════════════════════════════════
let bm2TimerInterval = null;

function renderBM2() {
  const el = document.getElementById('bm2-list');
  if (!el) return;
  el.innerHTML = '';
  const now = Date.now();
  // 期限切れを削除
  S.bookmarks2 = S.bookmarks2.filter(b => !b.expiresAt || b.expiresAt > now);

  S.bookmarks2.forEach(b => {
    const d = document.createElement('div'); d.className = 'bm-item';
    let fav = b.fav || (b.url ? getFavicon(b.url) : '');
    const ico = fav ? `<img class="bm-fav" src="${fav}" onerror="this.outerHTML='<div class=bm-fav-ph></div>'">` : '<div class="bm-fav-ph"></div>';
    if (!b.fav && b.url) {
      getFaviconAsync(b.url, (dataUri) => {
        b.fav = dataUri;
        const el = d.querySelector('img.bm-fav, .bm-fav-ph');
        if (el) el.outerHTML = `<img class="bm-fav" src="${dataUri}" onerror="this.outerHTML='<div class=bm-fav-ph></div>'">`;
      });
    }

    let expiryStr = '';
    if (b.expiresAt) {
      const rem = b.expiresAt - now;
      if (rem > 0) {
        const hrs = Math.floor(rem / 3600000);
        const mins = Math.floor((rem % 3600000) / 60000);
        if (hrs >= 1) expiryStr = `あと${hrs}時間で削除`;
        else if (mins > 0) expiryStr = `あと${mins}分で削除`;
        else expiryStr = 'まもなく削除';
      }
    }

    d.innerHTML = `${ico}<div class="bm2-info"><span class="bm-name">${esc(b.name)}</span>${expiryStr ? `<span class="bm2-expiry">${esc(expiryStr)}</span>` : ''}</div>`;
    d.addEventListener('click', () => { if (b.url) { if (S.active) window.browser.navigate(S.active, b.url); else newTab(b.url); } });
    // 右クリックで削除・編集
    d.addEventListener('contextmenu', e => {
      e.preventDefault();
      showContextMenu(e.clientX, e.clientY, [
        { label: '編集', action: () => openBmEditModal(b, 'bm2') },
        { label: '削除', action: () => {
          S.bookmarks2 = S.bookmarks2.filter(x => x.id !== b.id);
          renderBM2();
        }},
        { label: '期限を変更', action: () => openBM2DateModal(b.id) },
      ]);
    });
    el.appendChild(d);
  });

  // タイマー表示更新用
  if (bm2TimerInterval) clearInterval(bm2TimerInterval);
  if (S.bookmarks2.some(b => b.expiresAt)) {
    bm2TimerInterval = setInterval(() => {
      const now2 = Date.now();
      const before = S.bookmarks2.length;
      S.bookmarks2 = S.bookmarks2.filter(b => !b.expiresAt || b.expiresAt > now2);
      if (S.bookmarks2.length !== before || S.currentSpace === 1) renderBM2();
    }, 30000);
  }
}

// ブックマーク２追加ボタン（現在のタブから追加、24時間で自動削除）
document.getElementById('bm2-add-btn').addEventListener('click', async () => {
  if (!S.active) return;
  const url = await window.browser.getUrl(S.active);
  if (!url) return;
  const t = S.tabs.find(x => x.id === S.active);
  const expiresAt = Date.now() + 86400000; // 24時間後
  const bmName = (t?.title || url).slice(0, 32);
  S.bookmarks2.push({ id: 'bm2_' + Date.now(), name: bmName, url, fav: t?.fav || null, expiresAt });
  renderBM2();
  scheduleSave();
  // ブックマーク2追加通知
  showNotifToast('「' + bmName + '」をブックマーク２に追加しました');
  addHubNotif({ title: 'ブックマーク２追加', body: bmName, time: Date.now(), appKey: null });
});

// ═══════════════════════════════════════════
//  ブックマーク2 日時設定モーダル
// ═══════════════════════════════════════════
function openBM2DateModal(bmId) {
  const modal = document.getElementById('bm2-date-modal');
  const input = document.getElementById('bm2-date-input');
  // デフォルト：1日後
  const def = new Date(Date.now() + 86400000);
  input.value = def.toISOString().slice(0, 16);
  modal.classList.add('show');

  const confirmBtn = document.getElementById('bm2-date-confirm');
  const cancelBtn = document.getElementById('bm2-date-cancel');
  const noExpBtn = document.getElementById('bm2-date-noexp');

  const cleanup = () => { modal.classList.remove('show'); };
  const onConfirm = () => {
    const val = input.value;
    if (val) {
      const ts = new Date(val).getTime();
      const bm = S.bookmarks2.find(x => x.id === bmId);
      if (bm) bm.expiresAt = ts;
      renderBM2();
    }
    cleanup();
  };
  const onNoExp = () => {
    const bm = S.bookmarks2.find(x => x.id === bmId);
    if (bm) bm.expiresAt = null;
    renderBM2();
    cleanup();
  };
  const onCancel = () => {
    // キャンセルの場合expiresAtがnullのままの新規追加は削除
    cleanup();
  };

  confirmBtn.onclick = onConfirm;
  cancelBtn.onclick = onCancel;
  noExpBtn.onclick = onNoExp;
}

// ═══════════════════════════════════════════
//  右クリックコンテキストメニュー
// ═══════════════════════════════════════════
let ctxMenu = null;
function showContextMenu(x, y, items) {
  removeContextMenu();
  ctxMenu = document.createElement('div');
  ctxMenu.className = 'ctx-menu';
  items.forEach(item => {
    const btn = document.createElement('button');
    btn.className = 'ctx-item';
    btn.textContent = item.label;
    btn.addEventListener('click', e => {
      e.stopPropagation();
      item.action();
      removeContextMenu();
    });
    ctxMenu.appendChild(btn);
  });
  // いったん画面外に置いてサイズを測ってからクランプ
  ctxMenu.style.left = '-9999px';
  ctxMenu.style.top  = '-9999px';
  document.body.appendChild(ctxMenu);
  const mw = ctxMenu.offsetWidth  || 140;
  const mh = ctxMenu.offsetHeight || 80;
  const cx = Math.min(x, window.innerWidth  - mw - 4);
  const cy = Math.min(y, window.innerHeight - mh - 4);
  ctxMenu.style.left = Math.max(4, cx) + 'px';
  ctxMenu.style.top  = Math.max(4, cy) + 'px';
  setTimeout(() => document.addEventListener('click', removeContextMenu, { once: true }), 50);
}
function removeContextMenu() {
  if (ctxMenu) { ctxMenu.remove(); ctxMenu = null; }
}

// 長押し（500ms）でもコンテキストメニューを出すヘルパー
function addLongPress(el, menuFn) {
  let timer = null;
  let moved = false;
  el.addEventListener('pointerdown', e => {
    if (e.button !== 0) return; // 右クリックはcontextmenuに任せる
    moved = false;
    timer = setTimeout(() => {
      if (!moved) menuFn(e.clientX, e.clientY);
    }, 500);
  });
  el.addEventListener('pointermove', () => { moved = true; if (timer) { clearTimeout(timer); timer = null; } });
  el.addEventListener('pointerup',   () => { if (timer) { clearTimeout(timer); timer = null; } });
  el.addEventListener('pointercancel', () => { if (timer) { clearTimeout(timer); timer = null; } });
}

// ═══════════════════════════════════════════
//  ピンアプリ
// ═══════════════════════════════════════════
function _makePinIcon(url) {
  const wrap = document.createElement('div');
  wrap.className = 'pin-icon';
  if (url) {
    const img = document.createElement('img');
    img.alt = ''; img.style.width = '28px'; img.style.height = '28px';
    img.style.objectFit = 'contain'; img.style.borderRadius = '6px';
    img.src = faviconFromUrl(url);
    img.onerror = () => { img.style.display = 'none'; };
    wrap.appendChild(img);
  }
  return wrap;
}

function renderPins() {
  const el = document.getElementById('pin-grid');
  el.innerHTML = '';
  const apps = S.pinnedApps.filter(p => !p.isAdd);

  apps.forEach((p, i) => {
    const d = document.createElement('div'); d.className = 'pin-item';
    d.appendChild(_makePinIcon(p.url));
    const lbl = document.createElement('div'); lbl.className = 'pin-lbl'; lbl.textContent = p.name;
    d.appendChild(lbl);
    d.addEventListener('click', () => { if (S.active) window.browser.navigate(S.active, p.url); else newTab(p.url); });
    const menuItems = [
      { label: '編集', action: () => openPinEditModal(i) },
      { label: '削除', action: () => { S.pinnedApps.splice(S.pinnedApps.indexOf(p), 1); renderPins(); scheduleSave(); } },
    ];
    d.addEventListener('contextmenu', e => { e.preventDefault(); showContextMenu(e.clientX, e.clientY, menuItems); });
    addLongPress(d, (x, y) => showContextMenu(x, y, menuItems));
    el.appendChild(d);
  });

  // 末尾に常に「＋追加」ボタン
  const add = document.createElement('div'); add.className = 'pin-item';
  const addIcon = document.createElement('div'); addIcon.className = 'pin-icon pin-add-btn'; addIcon.textContent = '+';
  const addLbl = document.createElement('div'); addLbl.className = 'pin-lbl'; addLbl.textContent = '追加';
  add.appendChild(addIcon); add.appendChild(addLbl);
  add.addEventListener('click', () => openPinAddModal());
  el.appendChild(add);
  renderHSidebar();
}

function openPinAddModal() {
  const modal = document.getElementById('bm-edit-modal');
  document.getElementById('bm-edit-name').value = '';
  document.getElementById('bm-edit-url').value  = '';
  modal.classList.add('show');
  setTimeout(() => document.getElementById('bm-edit-url').focus(), 40);
  document.getElementById('bm-edit-confirm').onclick = () => {
    const name = document.getElementById('bm-edit-name').value.trim();
    const url  = document.getElementById('bm-edit-url').value.trim();
    if (!url) return;
    let u = url;
    if (!u.startsWith('http://') && !u.startsWith('https://')) u = 'https://' + u;
    let hostname = '';
    try { hostname = new URL(u).hostname; } catch {}
    S.pinnedApps.push({ name: (name || hostname).slice(0, 20), url: u });
    renderPins(); scheduleSave();
    modal.classList.remove('show');
  };
  document.getElementById('bm-edit-cancel').onclick = () => modal.classList.remove('show');
}

function openPinEditModal(idx) {
  const apps = S.pinnedApps.filter(p => !p.isAdd);
  const p = apps[idx]; if (!p) return;
  const modal = document.getElementById('bm-edit-modal');
  document.getElementById('bm-edit-name').value = p.name || '';
  document.getElementById('bm-edit-url').value  = p.url  || '';
  modal.classList.add('show');
  setTimeout(() => document.getElementById('bm-edit-name').focus(), 40);
  document.getElementById('bm-edit-confirm').onclick = () => {
    const name = document.getElementById('bm-edit-name').value.trim();
    const url  = document.getElementById('bm-edit-url').value.trim();
    if (!url) return;
    let u = url;
    if (!u.startsWith('http://') && !u.startsWith('https://')) u = 'https://' + u;
    const realIdx = S.pinnedApps.indexOf(p);
    if (realIdx >= 0) {
      S.pinnedApps[realIdx].name = (name || u).slice(0, 20);
      S.pinnedApps[realIdx].url  = u;
      S.pinnedApps[realIdx].fav  = null; // faviconキャッシュリセット
    }
    renderPins(); scheduleSave();
    modal.classList.remove('show');
  };
  document.getElementById('bm-edit-cancel').onclick = () => modal.classList.remove('show');
}

// ═══════════════════════════════════════════
//  ナビ
// ═══════════════════════════════════════════
async function updateNav() {
  if (!S.active) return;
  const [b, f] = await Promise.all([window.browser.canGoBack(S.active), window.browser.canGoForward(S.active)]);
  document.getElementById('nb-back').disabled = !b;
  document.getElementById('nb-fwd').disabled = !f;
}

document.getElementById('nb-back').addEventListener('click', () => { if (S.active) window.browser.back(S.active); });
document.getElementById('nb-fwd').addEventListener('click', () => { if (S.active) window.browser.forward(S.active); });
document.getElementById('nb-reload').addEventListener('click', () => { if (S.active) window.browser.reload(S.active); });
document.getElementById('new-tab-row').addEventListener('click', () => newTab());
document.getElementById('tab-folder-btn').addEventListener('click', () => {
  showPrompt('フォルダ名を入力してください', '新しいフォルダ').then(name => {
    if (!name) return;
    S.tabTree.push({ id: 'tf_'+Date.now(), type:'folder', name:name.slice(0,30), children:[], _open:true });
    renderTabs(); scheduleSave();
  });
});
document.getElementById('tb-copy').addEventListener('click', async () => {
  if (!S.active) return;
  const url = await window.browser.getUrl(S.active);
  try { await navigator.clipboard.writeText(url); } catch {}
});
document.getElementById('clear-btn').addEventListener('click', () => {
  S.bookmarks = [];
  renderBM();
  scheduleSave();
});

// ═══════════════════════════════════════════
//  テーマ
// ═══════════════════════════════════════════
document.getElementById('nb-theme').addEventListener('click', () => {
  S.dark = !S.dark;
  document.documentElement.setAttribute('data-theme', S.dark ? 'dark' : 'light');
  document.getElementById('ico-m').style.display = S.dark ? 'none' : '';
  document.getElementById('ico-s').style.display = S.dark ? '' : 'none';
  window.browser.setTheme(S.dark);
  scheduleSave();
});

// ═══════════════════════════════════════════
//  IPC
// ═══════════════════════════════════════════
window.browser.onNavigate(d => {
  const t = S.tabs.find(x => x.id === d.id);
  if (t) {
    t.url = d.url;
    // base64のfaviconが既にある場合は上書きしない
    // ない場合だけS2 URLをセット（後でbase64に置き換わる）
    if (!t.fav || !t.fav.startsWith('data:')) {
      if (d.url && d.url.startsWith('http')) {
        try { t.fav = 'https://www.google.com/s2/favicons?domain=' + new URL(d.url).hostname + '&sz=32'; } catch { t.fav = null; }
      } else {
        t.fav = null;
      }
    }
    if (d.title) t.title = d.title;
    if (d.id === S.active) updateUrl(d.url);
    renderTabs(); updateNav(); scheduleSave();
  }
});
window.browser.onTitle(({ id, title }) => {
  const t = S.tabs.find(x => x.id === id);
  if (t) {
    t.title = title;
    t.smartTitle = "";
    renderTabs();
    if (window.spiralAI) {
      const url = t.url || "";
      window.spiralAI.trySmartTitle(id, url, title);
    }
  }
});
window.browser.onFavicon(({ id, favicon }) => {
  const t = S.tabs.find(x => x.id === id);
  if (t) { t.fav = favicon; renderTabs(); }
});
// did-finish-load時のGoogle S2フォールバック（page-favicon-updatedが来なかった場合）
if (window.browser.onFaviconFallback) {
  window.browser.onFaviconFallback(({ id, favicon }) => {
    const t = S.tabs.find(x => x.id === id);
    // 本物のfavicon(data:)がなければS2 URLをセット
    if (t && (!t.fav || !t.fav.startsWith('data:'))) { t.fav = favicon; renderTabs(); }
  });
}
window.browser.onLoading(({ id, loading }) => {
  const t = S.tabs.find(x => x.id === id);
  if (t) {
    t.loading = loading;
    renderTabs();
  }
});
window.browser.onOpenUrl(url => newTab(url));

// アプリ終了前に即時保存して完了を通知
window.browser.onSaveRequest(() => {
  clearTimeout(saveTimer);
  saveAppState();
  setTimeout(() => window.browser.saveComplete(), 300);
});

// アップデート通知
window.browser.onUpdateAvailable(({ version }) => {
  const bar = document.getElementById('update-bar');
  if (!bar) return;
  document.getElementById('update-version').textContent = version;
  // ダウンロード開始 → プログレスバーを表示、インストールボタンは隠す
  document.getElementById('update-install-btn').style.display = 'none';
  document.getElementById('update-progress-wrap').style.display = '';
  document.getElementById('update-progress-bar').style.width = '0%';
  document.getElementById('update-progress-pct').textContent = '0%';
  bar.querySelector('.update-msg').textContent = `v${version} をダウンロード中...`;
  bar.style.display = 'flex';
});

window.browser.onUpdateProgress(({ percent }) => {
  const wrap = document.getElementById('update-progress-wrap');
  const bar2 = document.getElementById('update-progress-bar');
  const pct  = document.getElementById('update-progress-pct');
  if (wrap) wrap.style.display = '';
  if (bar2) bar2.style.width = percent + '%';
  if (pct)  pct.textContent = percent + '%';
  const msg = document.querySelector('#update-bar .update-msg');
  if (msg) msg.textContent = 'ダウンロード中...';
});

window.browser.onUpdateDownloaded(({ version }) => {
  const bar = document.getElementById('update-bar');
  if (!bar) return;
  bar.style.display = 'flex';
  bar.querySelector('.update-msg').textContent = `v${version} の準備ができました`;
  document.getElementById('update-progress-wrap').style.display = 'none';
  const btn = document.getElementById('update-install-btn');
  btn.style.display = 'inline-block';
  btn.style.visibility = 'visible';
  btn.style.opacity = '1';
  btn.disabled = false;
  btn.textContent = '再起動してインストール';
});

document.getElementById('update-install-btn')?.addEventListener('click', () => {
  const btn = document.getElementById('update-install-btn');
  btn.textContent = '再起動中...';
  btn.disabled = true;
  btn.style.opacity = '0.6';
  window.browser.installUpdate();
});
document.getElementById('update-bar-close')?.addEventListener('click', () => {
  document.getElementById('update-bar').style.display = 'none';
});

// ── アップデート確認ボタン
document.getElementById('btn-check-update').addEventListener('click', async () => {
  const btn = document.getElementById('btn-check-update');
  btn.style.animation = 'sp .65s linear infinite';
  btn.disabled = true;
  const result = await window.browser.checkUpdate();
  // エラーの場合も必ずUIをリセット
  if (result?.error) {
    btn.style.animation = '';
    btn.disabled = false;
    const bar = document.getElementById('update-bar');
    if (bar) {
      bar.querySelector('.update-msg').textContent = '確認に失敗しました: ' + result.error;
      document.getElementById('update-install-btn').style.display = 'none';
      document.getElementById('update-progress-wrap').style.display = 'none';
      bar.style.display = 'flex';
      setTimeout(() => { bar.style.display = 'none'; }, 4000);
    }
  } else {
    // 正常時は最大10秒待ってからリセット（update:notAvailableで早期リセットされる）
    setTimeout(() => {
      btn.style.animation = '';
      btn.disabled = false;
    }, 10000);
  }
});

window.browser.onUpdateNotAvailable(() => {
  const btn = document.getElementById('btn-check-update');
  if (btn) { btn.style.animation = ''; btn.disabled = false; }
  const bar = document.getElementById('update-bar');
  if (bar) {
    bar.querySelector('.update-msg').textContent = '最新バージョンです';
    document.getElementById('update-install-btn').style.display = 'none';
    document.getElementById('update-progress-wrap').style.display = 'none';
    bar.style.display = 'flex';
    setTimeout(() => { bar.style.display = 'none'; }, 3000);
  }
});


// ═══════════════════════════════════════════
//  キーボード
// ═══════════════════════════════════════════
document.addEventListener('keydown', e => {
  const m = e.metaKey || e.ctrlKey;
  if (m && e.key === 't') { e.preventDefault(); newTab(); }
  if (m && e.key === 'w') { e.preventDefault(); if (S.active) closeTab(S.active); }
  if (m && e.key === 'b') { e.preventDefault(); window.browser.openPasswordWindow?.(); }
  if (m && e.key === 'l') { e.preventDefault(); openSB(); overlay.classList.add('show'); sgReset(); window.browser.getHistory?.().then(h => { browseHistoryCache = h || []; }).catch(() => {}); setTimeout(() => { urlInp.focus(); urlInp.select(); }, 40); }
  if (m && e.key === 'r') { e.preventDefault(); if (S.active) window.browser.reload(S.active); }
  if (m && e.key === '[') { e.preventDefault(); if (S.active) window.browser.back(S.active); }
  if (m && e.key === ']') { e.preventDefault(); if (S.active) window.browser.forward(S.active); }
  if (m && e.key >= '1' && e.key <= '9') { const i = +e.key - 1; if (S.tabs[i]) activateTab(S.tabs[i].id); }
  // ズーム
  // ズームはmain.jsのglobalShortcutで処理
});

let zoomIndicatorTimer = null;
function showZoomIndicator(pct) {
  let el = document.getElementById('zoom-indicator');
  if (!el) {
    el = document.createElement('div');
    el.id = 'zoom-indicator';
    el.style.cssText = `
      position:fixed; top:12px; left:50%; transform:translateX(-50%);
      background:var(--card); border:1px solid var(--card-border);
      box-shadow:0 4px 16px rgba(0,0,0,0.18);
      display:flex; align-items:center; gap:4px;
      border-radius:10px; padding:4px 6px;
      z-index:99999; opacity:0; transition:opacity .15s;
      font-family:-apple-system,sans-serif;
    `;
    el.innerHTML = `
      <button id="zoom-out-btn" style="width:28px;height:28px;border:none;background:transparent;color:var(--text2);font-size:16px;cursor:pointer;border-radius:6px;display:flex;align-items:center;justify-content:center;transition:background .1s;">－</button>
      <button id="zoom-reset-btn" style="min-width:52px;height:28px;border:none;background:transparent;color:var(--text);font-size:12px;font-weight:600;cursor:pointer;border-radius:6px;padding:0 6px;transition:background .1s;"></button>
      <button id="zoom-in-btn" style="width:28px;height:28px;border:none;background:transparent;color:var(--text2);font-size:16px;cursor:pointer;border-radius:6px;display:flex;align-items:center;justify-content:center;transition:background .1s;">＋</button>
    `;
    document.body.appendChild(el);

    el.querySelector('#zoom-out-btn').addEventListener('click', () => {
      if (S.active) window.browser.zoomOut(S.active).then(p => updateZoomIndicator(p));
    });
    el.querySelector('#zoom-in-btn').addEventListener('click', () => {
      if (S.active) window.browser.zoomIn(S.active).then(p => updateZoomIndicator(p));
    });
    el.querySelector('#zoom-reset-btn').addEventListener('click', () => {
      if (S.active) window.browser.zoomReset(S.active).then(p => {
        updateZoomIndicator(p);
        // 100%に戻ったら少し待って消す
        clearTimeout(zoomIndicatorTimer);
        zoomIndicatorTimer = setTimeout(() => { el.style.opacity = '0'; }, 800);
      });
    });

    // ホバー中は消えない
    el.addEventListener('mouseenter', () => clearTimeout(zoomIndicatorTimer));
    el.addEventListener('mouseleave', () => {
      zoomIndicatorTimer = setTimeout(() => { el.style.opacity = '0'; }, 800);
    });
  }
  updateZoomIndicator(pct);
}

function updateZoomIndicator(pct) {
  const el = document.getElementById('zoom-indicator');
  if (!el) return;
  const resetBtn = el.querySelector('#zoom-reset-btn');
  if (resetBtn) resetBtn.textContent = pct + '%';
  el.style.opacity = '1';
  clearTimeout(zoomIndicatorTimer);
  zoomIndicatorTimer = setTimeout(() => { el.style.opacity = '0'; }, 2500);
}

// ═══════════════════════════════════════════
//  インポートモーダル
// ═══════════════════════════════════════════
const importModal = document.getElementById('import-modal');
let selectedBrowser = null;

async function openImportModal() {
  importModal.classList.add('show');
  openSB();
  selectedBrowser = null;
  document.getElementById('import-go').disabled = true;
  document.getElementById('import-result').classList.remove('show');

  const bmList = document.getElementById('import-browser-list');
  bmList.innerHTML = '<div style="color:var(--textm);font-size:13px;padding:8px">検出中...</div>';

  const browsers = await window.browser.importDetect();
  if (!browsers.length) {
    bmList.innerHTML = '<div style="color:var(--textm);font-size:13px;padding:8px">対応ブラウザが見つかりませんでした</div>';
    return;
  }
  const icons = { chrome:'https://www.google.com/chrome/static/images/chrome-logo.svg', edge:'https://www.microsoft.com/favicon.ico', arc:'https://arc.net/favicon.ico', vivaldi:'https://vivaldi.com/favicon.ico' };
  bmList.innerHTML = '';
  browsers.forEach(b => {
    const el = document.createElement('button'); el.className = 'import-browser-item';
    el.innerHTML = `<img class="import-browser-icon" src="${icons[b.name]||''}" onerror="this.style.display='none'"><div><div class="import-browser-name">${b.name[0].toUpperCase()+b.name.slice(1)}</div><div class="import-browser-path">${b.profilePath}</div></div>`;
    el.addEventListener('click', () => {
      document.querySelectorAll('.import-browser-item').forEach(x=>x.classList.remove('selected'));
      el.classList.add('selected');
      selectedBrowser = b.name;
      document.getElementById('import-go').disabled = false;
    });
    bmList.appendChild(el);
  });
}

document.getElementById('import-go').addEventListener('click', async () => {
  if (!selectedBrowser) return;
  const btn = document.getElementById('import-go');
  btn.disabled = true; btn.textContent = '同期中...';
  const resEl = document.getElementById('import-result');
  resEl.classList.remove('show');
  let msgs = [];

  // ブックマーク
  const res = await window.browser.importBookmarks(selectedBrowser);
  if (res.error) msgs.push('ブックマーク: ' + res.error);
  else {
    (res.bookmarks||[]).slice(0,50).forEach(b => {
      S.bookmarks.push({ id:'imp_'+Date.now()+Math.random(), name:b.name.slice(0,28), url:b.url, fav:null });
    });
    renderBM();
    msgs.push(` ブックマーク ${(res.bookmarks||[]).length}件`);
  }

  // パスワード自動同期（Keychain）
  const pres = await window.browser.importPasswordsAuto(selectedBrowser);
  if (pres.error) msgs.push('パスワード: ' + pres.error);
  else if (pres.count === 0) msgs.push(`パスワード: 復号できませんでした（DB内 ${pres.total||0}件）Chromeを完全終了してから再試行してください`);
  else msgs.push(` パスワード ${pres.count}件/${pres.total||pres.count}件（⌘B で一覧表示）`);

  resEl.textContent = msgs.join('  ');
  resEl.classList.add('show');
  scheduleSave();
  const hasError = msgs.some(m => !m.startsWith(''));
  setTimeout(() => importModal.classList.remove('show'), hasError ? 6000 : 2500);
  btn.disabled = false; btn.textContent = 'すべて同期';
});
document.getElementById('import-cancel').addEventListener('click', () => importModal.classList.remove('show'));
// モーダル外クリックでは閉じない（マウス移動で誤って閉じるのを防ぐ）
// Google signin removed

// ══════════════════════════════════════════════
//  設定モーダル
// ══════════════════════════════════════════════
function openSettingsModal() {
  _pendingLayout = S.layout; // 現在値をベースに
  document.getElementById('settings-modal').style.display = 'flex';
  switchSettingsPane('general');
  notifyModalState();
}
function closeSettingsModal() {
  document.getElementById('settings-modal').style.display = 'none';
  notifyModalState();
}
async function loadDownloadPane() {
  const statusEl = document.getElementById('dl-ytdlp-status');
  const installBtn = document.getElementById('dl-install-btn');
  if (!statusEl) return;
  statusEl.textContent = '確認中...';
  try {
    const r = await window.browser.ytdlpCheck();
    if (r.available) {
      statusEl.textContent = 'インストール済み';
      statusEl.style.color = '#34c759';
      if (installBtn) installBtn.style.display = 'none';
    } else {
      statusEl.textContent = '未インストール';
      statusEl.style.color = '#ff3b30';
      if (installBtn) installBtn.style.display = '';
    }
  } catch { statusEl.textContent = '確認失敗'; }
}

document.addEventListener('click', async e => {
  // yt-dlp インストール
  if (e.target.id === 'dl-install-btn') {
    e.target.textContent = 'インストール中...';
    e.target.disabled = true;
    const r = await window.browser.ytdlpInstall().catch(() => ({ error: '失敗' }));
    if (r.ok) { loadDownloadPane(); }
    else { e.target.textContent = '失敗'; e.target.disabled = false; }
  }
  // ダウンロード開始
  if (e.target.id === 'dl-start-btn') {
    const url = document.getElementById('dl-url-inp')?.value?.trim();
    const status = document.getElementById('dl-status');
    if (!url) { if (status) status.textContent = 'URLを入力してください'; return; }
    e.target.disabled = true;
    e.target.textContent = '処理中...';
    if (status) status.textContent = 'ダウンロード中...';
    try {
      const r = await window.browser.ytdlpDownload(url, 'best');
      if (r.ok) {
        if (status) status.textContent = 'ダウンロード完了。Downloadsフォルダに保存されました';
        document.getElementById('dl-url-inp').value = '';
      } else {
        if (status) status.textContent = ' エラー: ' + (r.error || '不明なエラー');
      }
    } catch (err) {
      if (status) status.textContent = ' エラー: ' + err.message;
    }
    e.target.disabled = false;
    e.target.textContent = 'ダウンロード';
  }
});

async function loadVpnSettings() {
  try {
    const s = await window.browser.getProxy();
    document.getElementById('vpn-enabled-chk').checked = !!s.enabled;
    document.getElementById('vpn-host-inp').value = s.host || '127.0.0.1';
    document.getElementById('vpn-port-inp').value = s.port || 1080;
    document.getElementById('vpn-user-inp').value = s.user || '';
    document.getElementById('vpn-pass-inp').value = s.pass || '';
  } catch {}
}
document.addEventListener('click', async e => {
  if (e.target.id !== 'vpn-save-btn') return;
  const s = {
    enabled: document.getElementById('vpn-enabled-chk').checked,
    host: document.getElementById('vpn-host-inp').value.trim() || '127.0.0.1',
    port: parseInt(document.getElementById('vpn-port-inp').value) || 1080,
    user: document.getElementById('vpn-user-inp').value.trim(),
    pass: document.getElementById('vpn-pass-inp').value,
  };
  const status = document.getElementById('vpn-status');
  status.textContent = '適用中...';
  try {
    await window.browser.setProxy(s);
    status.textContent = s.enabled ? '有効化しました' : '無効化しました';
    setTimeout(() => { status.textContent = ''; }, 3000);
  } catch {
    status.textContent = '保存に失敗しました';
  }
});

function switchSettingsPane(pane) {
  document.querySelectorAll('.settings-nav-btn').forEach(b => b.classList.toggle('active', b.dataset.pane === pane));
  document.querySelectorAll('.settings-pane').forEach(p => p.style.display = 'none');
  document.getElementById('settings-pane-' + pane).style.display = '';
  // ダウンロードペイン表示時にyt-dlp状態を確認
  if (pane === 'download') loadDownloadPane();
  document.getElementById('settings-pane-title').textContent =
    pane === 'general' ? '一般' : pane === 'network' ? 'ネットワーク' : pane === 'download' ? 'ダウンロード' : '詳細設定';
  if (pane === 'network') loadVpnSettings();
}

function applyLayout(layout) {
  if (layout === 'horizontal') {
    document.body.classList.add('layout-horizontal');
    initHorizontalUI();
  } else {
    document.body.classList.remove('layout-horizontal');
  }
  document.getElementById('layout-vertical').classList.toggle('active', layout !== 'horizontal');
  document.getElementById('layout-horizontal').classList.toggle('active', layout === 'horizontal');
}

// ══════════════════════════════════════════════
//  水平レイアウト UI
// ══════════════════════════════════════════════
function renderHWorkspaces() {
  const area = document.getElementById('h-ws-area');
  if (!area) return;
  area.innerHTML = '';
  S.workspaces.forEach((ws, i) => {
    const btn = document.createElement('button');
    btn.className = 'h-ws-btn' + (i === S.activeWorkspace ? ' active' : '');
    btn.style.background = ws.color || '#888';
    btn.title = ws.name;
    btn.textContent = ws.avatar?.[0] || ws.name?.[0] || String(i + 1);
    btn.addEventListener('click', () => switchWorkspace(i));
    btn.addEventListener('contextmenu', e => {
      e.preventDefault();
      showContextMenu(e.clientX, e.clientY, [
        { label: '編集', action: () => openWorkspaceModal(i) },
        ...(S.workspaces.length > 1 ? [{ label: '削除', action: () => deleteWorkspace(i) }] : []),
      ]);
    });
    area.appendChild(btn);
  });
  // ＋追加ボタン
  const addBtn = document.createElement('button');
  addBtn.className = 'h-ws-add-btn';
  addBtn.title = 'ワークスペースを追加';
  addBtn.textContent = '+';
  addBtn.addEventListener('click', () => openWorkspaceModal(-1));
  area.appendChild(addBtn);
}

function renderHTabs() {
  if (S.layout !== 'horizontal') return;
  const wrap = document.getElementById('h-tabs-wrap');
  if (!wrap) return;
  wrap.innerHTML = '';
  S.tabs.forEach(t => {
    const d = document.createElement('button');
    d.className = 'h-tab-item' + (t.id === S.active ? ' active' : '');
    const icoHtml = t.loading
      ? '<span class="h-tab-spin"></span>'
      : '<img class="h-tab-fav" onerror="this.remove()">';
    d.innerHTML = `${icoHtml}<span class="h-tab-title">${esc(t.smartTitle || t.title || 'New Tab')}</span><button class="h-tab-x" data-id="${esc(t.id)}">×</button>`;
    // faviconを非同期で取得してセット
    if (!t.loading) {
      const img = d.querySelector('img.h-tab-fav');
      if (img) {
        const favUrl = t.fav || (t.url ? faviconFromUrl(t.url) : '');
        if (favUrl) {
          if (favUrl.startsWith('data:')) {
            img.src = favUrl;
          } else {
            window.browser.fetchFavicon(favUrl).then(dataUri => {
              if (dataUri && img.isConnected) img.src = dataUri;
              else if (img.isConnected) img.remove();
            }).catch(() => { if (img.isConnected) img.remove(); });
          }
        } else {
          img.remove();
        }
      }
    }

    d.addEventListener('click', e => {
      if (e.target.classList.contains('h-tab-x')) { closeTab(t.id, e); return; }
      activateTab(t.id);
    });
    wrap.appendChild(d);
  });
}

function renderHBmbar() {
  if (S.layout !== 'horizontal') return;
  const bar = document.getElementById('h-bmbar');
  if (!bar) return;
  bar.innerHTML = '';
  function addBmItems(tree) {
    tree.forEach(node => {
      if (node.type === 'folder') { addBmItems(node.children || []); return; }
      if (!node.url) return;
      const d = document.createElement('button');
      d.className = 'h-bm-item';
      d.title = node.name || node.url;
      const img = document.createElement('img');
      img.src = faviconFromUrl(node.url);
      img.onerror = () => { img.style.display = 'none'; };
      const span = document.createElement('span');
      span.textContent = node.name || '';
      d.appendChild(img); d.appendChild(span);
      d.addEventListener('click', () => { if (S.active) window.browser.navigate(S.active, node.url); else newTab(node.url); });
      bar.appendChild(d);
    });
  }
  addBmItems(S.bookmarks || []);
}

function renderHSidebar() {
  if (S.layout !== 'horizontal') return;
  const sb = document.getElementById('h-sidebar');
  if (!sb) return;
  sb.innerHTML = '';
  // ピンサイトのみ（左サイドバーはアイコンのみ）
  (S.pinnedApps || []).forEach(app => {
    if (!app.url) return;
    const d = document.createElement('div');
    d.className = 'h-sidebar-icon';
    d.title = app.name || app.url;
    const img = document.createElement('img');
    img.src = faviconFromUrl(app.url);
    img.onerror = () => { img.style.display = 'none'; };
    d.appendChild(img);
    d.addEventListener('click', () => { if (S.active) window.browser.navigate(S.active, app.url); else newTab(app.url); });
    sb.appendChild(d);
  });
}

function updateHUrl(url) {
  const el = document.getElementById('h-url-disp');
  if (!el) return;
  try { el.textContent = new URL(url).hostname || url; } catch { el.textContent = url || ''; }
}

function initHorizontalUI() {
  const bind = (id, fn) => { const el = document.getElementById(id); if (el && !el._bound) { el._bound = true; el.addEventListener('click', fn); } };

  // ナビボタン（アドレス行）
  bind('h-back',   () => { if (S.active) window.browser.goBack(S.active); });
  bind('h-fwd',    () => { if (S.active) window.browser.goForward(S.active); });
  bind('h-reload', () => { if (S.active) window.browser.reload(S.active); });

  // アドレスバークリック
  bind('h-url-disp', () => openUrlOverlay());

  // ダークモード
  const hTheme = document.getElementById('h-theme');
  if (hTheme && !hTheme._bound) {
    hTheme._bound = true;
    hTheme.addEventListener('click', () => {
      S.dark = !S.dark;
      document.documentElement.setAttribute('data-theme', S.dark ? 'dark' : 'light');
      document.getElementById('ico-m').style.display = S.dark ? 'none' : '';
      document.getElementById('ico-s').style.display = S.dark ? '' : 'none';
      document.getElementById('h-ico-m').style.display = S.dark ? 'none' : '';
      document.getElementById('h-ico-s').style.display = S.dark ? '' : 'none';
      window.browser.setTheme(S.dark);
      scheduleSave();
    });
  }

  // New Tab
  bind('h-newtab-btn', () => newTab());

  // 下部ツールバー
  bind('h-btn-bm',       () => document.getElementById('btn-quick-bm').click());
  bind('h-btn-history',  () => document.getElementById('btn-history').click());
  bind('h-btn-download', () => document.getElementById('btn-download').click());
  bind('h-btn-notif',    () => document.getElementById('btn-notif').click());
  bind('h-btn-ai',       () => document.getElementById('btn-ai').click());
  bind('h-btn-settings', () => openSettingsModal());
  bind('h-btn-split',    () => document.getElementById('btn-split').click());

  renderHTabs();
  renderHSidebar();
  renderHBmbar();
  renderHWorkspaces();
}

function setLayout(layout) {
  // 選択状態だけ更新（まだ適用しない）
  _pendingLayout = layout;
  document.getElementById('layout-vertical').classList.toggle('active', layout !== 'horizontal');
  document.getElementById('layout-horizontal').classList.toggle('active', layout === 'horizontal');
}

let _pendingLayout = null; // ✕を押すまで保留

// 設定モーダルのイベント
document.getElementById('settings-close-btn').addEventListener('click', () => {
  // ✕を押した時に初めてレイアウトを適用
  if (_pendingLayout !== null && _pendingLayout !== S.layout) {
    S.layout = _pendingLayout;
    applyLayout(S.layout);
    window.browser.setLayout(S.layout);
    scheduleSave();
  }
  _pendingLayout = null;
  closeSettingsModal();
});
document.getElementById('settings-modal').addEventListener('click', e => {
  if (e.target === document.getElementById('settings-modal')) {
    // 外クリックでは変更を破棄
    _pendingLayout = null;
    closeSettingsModal();
  }
});
document.querySelectorAll('.settings-nav-btn').forEach(btn => {
  btn.addEventListener('click', () => switchSettingsPane(btn.dataset.pane));
});
document.getElementById('settings-import-btn').addEventListener('click', () => {
  closeSettingsModal();
  openImportModal();
});

// 設定ボタン
document.getElementById('btn-settings').addEventListener('click', () => { openSB(); openSettingsModal(); });

// ── ワンタッチブックマーク
document.getElementById('btn-quick-bm').addEventListener('click', async () => {
  if (!S.active) return;
  const url   = await window.browser.getUrl(S.active);
  const title = S.tabs.find(t => t.id === S.active)?.title || url;
  if (!url || !url.startsWith('http')) return;

  // 既に登録済みか確認
  if (S.bookmarks.some(b => b.url === url)) {
    showNotifToast('既にブックマーク済みです');
    return;
  }

  S.bookmarks.push({ id: 'bm_' + Date.now(), type: 'item', name: title.slice(0, 20), url });
  renderBM();
  showNotifToast('ブックマークに追加しました');
});

function showNotifToast(msg) {
  let toast = document.getElementById('bm-toast');
  if (!toast) {
    toast = document.createElement('div');
    toast.id = 'bm-toast';
    toast.style.cssText = `
      position:fixed;bottom:60px;left:50%;transform:translateX(-50%);
      background:var(--text);color:var(--panel);
      font-size:12px;padding:6px 14px;border-radius:20px;
      z-index:9999;opacity:0;transition:opacity .2s;pointer-events:none;
      white-space:nowrap;
    `;
    document.body.appendChild(toast);
  }
  toast.textContent = msg;
  toast.style.opacity = '1';
  clearTimeout(toast._t);
  toast._t = setTimeout(() => { toast.style.opacity = '0'; }, 1800);
}

// addHubNotif はhubPanel/hubNotifs初期化後に定義（後述）
function addHubNotif(n) {
  // hubNotifs/hubPanelはこの関数が呼ばれる前に必ず初期化済み（イベントハンドラ経由のため問題なし）
  if (typeof hubNotifs === 'undefined') return;
  hubNotifs.unshift(n);
  if (hubNotifs.length > 50) hubNotifs = hubNotifs.slice(0, 50);
  if (typeof hubPanel !== 'undefined') {
    if (!hubPanel.classList.contains('show')) {
      hubUnread++;
      updateHubBadge();
    }
    if (hubPanel.classList.contains('show')) renderHubList();
  }
}



// ── フッター: 履歴
document.getElementById('btn-history').addEventListener('click', () => {
  openHistoryModal();
});

// ── フッター: ダウンロード
document.getElementById('btn-download').addEventListener('click', () => {
  openDownloadModal();
  closeSB(0);
});

// ═══════════════════════════════════════════
//  タブ分割
// ═══════════════════════════════════════════
let splitState = { active: false, ids: [] }; // フロント側の分割状態

// タブ数が変わるたびにボタンの有効/無効を更新
function updateSplitBtn() {
  const btn = document.getElementById('btn-split');
  if (!btn) return;
  if (splitState.active) {
    btn.classList.add('active');
    btn.disabled = false;
  } else {
    btn.classList.remove('active');
    btn.disabled = S.tabs.length < 2;
  }
}

// 分割実行（ids配列をそのまま渡す）
async function applySplit(ids) {
  await window.browser.setSplit(ids);
  splitState = { active: true, ids };
  updateSplitBtn();
}

// 分割解除
async function doSplitClear() {
  await window.browser.clearSplit();
  splitState = { active: false, ids: [] };
  updateSplitBtn();
}

function openSplitModal() {
  // 分割中なら即解除して終了
  if (splitState.active) {
    doSplitClear();
    return;
  }

  const modal    = document.getElementById('split-modal');
  const stepCount = document.getElementById('split-step-count');
  const stepTabs  = document.getElementById('split-step-tabs');
  const activeBar = document.getElementById('split-active-bar');
  const okBtn     = document.getElementById('split-ok-btn');
  const clearBtn  = document.getElementById('split-clear-btn');

  clearBtn.style.display = 'none';
  okBtn.style.display    = 'none';
  stepCount.style.display = '';
  stepTabs.style.display  = 'none';
  activeBar.style.display = 'none';

  let chosenN = 0;
  let selectedIds = [];

  document.querySelectorAll('.split-n-btn').forEach(b => {
    // タブ数に応じてボタンを無効化
    const n = parseInt(b.dataset.n);
    b.disabled = S.tabs.length < n;
    b.style.opacity = S.tabs.length < n ? '0.35' : '1';
    b.classList.remove('selected');
  });

  modal.style.display = 'flex';
  openSB();

  // 分割数ボタン
  document.querySelectorAll('.split-n-btn').forEach(btn => {
    btn.onclick = () => {
      if (btn.disabled) return;
      chosenN = parseInt(btn.dataset.n);
      document.querySelectorAll('.split-n-btn').forEach(b => b.classList.remove('selected'));
      btn.classList.add('selected');

      // タブを上から順にchosenN個自動選択（アクティブを先頭に）
      const otherTabs = S.tabs.filter(t => t.id !== S.active);
      selectedIds = [S.active, ...otherTabs.slice(0, chosenN - 1).map(t => t.id)];

      if (S.tabs.length < 5) {
        // 4個以下: 即実行
        modal.style.display = 'none';
        applySplit(selectedIds);
      } else {
        // 5個以上: タブ選択UIを表示
        showTabStep();
      }
    };
  });

  function showTabStep() {
    stepCount.style.display = 'none';
    stepTabs.style.display  = '';
    activeBar.style.display = '';
    okBtn.style.display     = '';
    renderTabStep();
  }

  function renderTabStep() {
    const prompt  = document.getElementById('split-tab-prompt');
    const list    = document.getElementById('split-tab-list');
    const selList = document.getElementById('split-selected-list');

    const remaining = chosenN - selectedIds.length;
    prompt.textContent = remaining > 0
      ? `あと${remaining}個のタブを選択してください`
      : `${chosenN}個のタブが選択されました`;

    // 選択可能タブ一覧（アクティブ以外）
    list.innerHTML = '';
    S.tabs.forEach(t => {
      if (t.id === S.active) return;
      const isSelected = selectedIds.includes(t.id);
      const row = document.createElement('div');
      row.className = 'split-tab-row' + (isSelected ? ' selected' : '');
      const fav = t.fav || (t.url ? getFavicon(t.url) : '');
      row.innerHTML = `
        ${fav ? `<img src="${fav}" onerror="this.style.display='none'">` : '<div style="width:14px;height:14px;flex-shrink:0;"></div>'}
        <span>${esc(t.title || t.url || '新しいタブ')}</span>
        ${isSelected ? '<span class="split-tag"></span>' : ''}
      `;
      row.addEventListener('click', () => {
        if (isSelected) {
          selectedIds = selectedIds.filter(id => id !== t.id);
        } else {
          if (selectedIds.length >= chosenN) return;
          selectedIds.push(t.id);
        }
        renderTabStep();
      });
      list.appendChild(row);
    });

    // 選択済みタブ表示
    selList.innerHTML = '';
    selectedIds.forEach((id, i) => {
      const t = S.tabs.find(x => x.id === id);
      if (!t) return;
      const fav = t.fav || (t.url ? getFavicon(t.url) : '');
      const row = document.createElement('div');
      row.style.cssText = 'display:flex;align-items:center;gap:6px;padding:4px 8px;border-radius:6px;background:var(--card);font-size:12px;color:var(--text2);';
      row.innerHTML = `
        <span style="font-size:10px;color:var(--textm);min-width:12px;">${i + 1}</span>
        ${fav ? `<img src="${fav}" style="width:12px;height:12px;border-radius:2px;" onerror="this.style.display='none'">` : ''}
        <span style="flex:1;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">${esc(t.title || t.url || '新しいタブ')}</span>
        ${id === S.active ? '<span style="font-size:10px;color:var(--accent);">現在</span>' : ''}
      `;
      selList.appendChild(row);
    });

    okBtn.disabled = selectedIds.length < chosenN;
    okBtn.style.opacity = selectedIds.length < chosenN ? '0.5' : '1';
  }

  okBtn.onclick = async () => {
    if (selectedIds.length < chosenN) return;
    modal.style.display = 'none';
    await applySplit(selectedIds);
  };
}

document.getElementById('btn-split').addEventListener('click', () => {
  openSplitModal();
});

document.getElementById('split-cancel-btn').addEventListener('click', () => {
  document.getElementById('split-modal').style.display = 'none';
});

document.getElementById('split-modal').addEventListener('click', e => {
  if (e.target === document.getElementById('split-modal'))
    document.getElementById('split-modal').style.display = 'none';
});

document.getElementById('split-clear-btn').addEventListener('click', async () => {
  await doSplitClear();
  document.getElementById('split-modal').style.display = 'none';
});

// タブが閉じられたり増えたときに分割状態・ボタンを更新
window.browser.onActivated(() => updateSplitBtn());
window.browser.onLoading(() => updateSplitBtn());


// ═══════════════════════════════════════════
//  初期化
// ═══════════════════════════════════════════
renderPins();
renderBM();
renderBM2();
renderTabs();
goToSpace(0, false);

// ── 状態の自動保存 ──
function saveAppState() {
  function serializeBMTree(arr) {
    return (arr||[]).map(n => n.type === 'folder'
      ? { id: n.id, type: 'folder', name: n.name, _open: n._open, children: serializeBMTree(n.children||[]) }
      : { id: n.id, type: 'item', name: n.name, url: n.url, fav: n.fav }
    );
  }
  function serializeTabTree(arr) {
    return (arr||[]).map(n => n.type === 'folder'
      ? { id: n.id, type: 'folder', name: n.name, _open: n._open, children: serializeTabTree(n.children||[]) }
      : { id: n.id, type: 'tab' }
    );
  }
  const state = {
    workspaces: S.workspaces.map((ws, i) => ({
      ...ws,
      tabs: i === S.activeWorkspace
        ? S.tabs.filter(t => t.url && t.url.startsWith('http')).map(t => ({ title: t.title, url: t.url, fav: t.fav }))
        : (ws.tabs||[]).filter(t => t.url && t.url.startsWith('http')).map(t => ({ title: t.title, url: t.url, fav: t.fav })),
      bookmarks: i === S.activeWorkspace ? serializeBMTree(S.bookmarks) : serializeBMTree(ws.bookmarks||[]),
      tabTree: i === S.activeWorkspace ? serializeTabTree(S.tabTree||[]) : serializeTabTree(ws.tabTree||[]),
    })),
    activeWorkspace: S.activeWorkspace,
    bookmarks2: S.bookmarks2,
    pinnedApps: S.pinnedApps,
    dark: S.dark,
    layout: S.layout || 'vertical',
  };
  window.browser.saveAppState(state);
}

let saveTimer = null;
function scheduleSave() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(saveAppState, 800);
}

window.browser.onReady(async () => {
  const saved = await window.browser.loadAppState();
  if (saved) {
    if (saved.dark !== undefined) {
      S.dark = saved.dark;
      document.documentElement.setAttribute('data-theme', S.dark ? 'dark' : 'light');
      document.getElementById('ico-m').style.display = S.dark ? 'none' : '';
      document.getElementById('ico-s').style.display = S.dark ? '' : 'none';
      window.browser.setTheme(S.dark);
    }
    if (saved.layout) {
      S.layout = saved.layout;
      applyLayout(S.layout);
      window.browser.setLayout(S.layout);
    }
    if (saved.pinnedApps && saved.pinnedApps.length) {
      // 旧デフォルトアプリ（Slack/Gmail等）を自動で除去
      const OLD_DEFAULTS = ['https://app.slack.com','https://mail.google.com','https://zoom.us','https://classroom.google.com','https://gemini.google.com','https://chat.openai.com','https://drive.google.com','https://youtube.com'];
      S.pinnedApps = saved.pinnedApps.filter(p => !OLD_DEFAULTS.includes(p.url));
      renderPins();
    }
    if (saved.bookmarks2 && saved.bookmarks2.length) { S.bookmarks2 = saved.bookmarks2; renderBM2(); }
    if (saved.workspaces && saved.workspaces.length) {
      S.workspaces = saved.workspaces;
      const wsIdx = saved.activeWorkspace || 0;
      S.activeWorkspace = wsIdx;
      const ws = S.workspaces[wsIdx];
      S.bookmarks = ws.bookmarks ? ws.bookmarks.slice() : [];
      renderBM();
      renderWorkspaceBar();
  renderHWorkspaces();

      const savedTabs = (ws.tabs || []).filter(function(t) { return t.url && t.url.startsWith('http'); });
      if (savedTabs.length) {
        for (const t of savedTabs) {
          const id = await window.browser.createTab(t.url, S.workspaces[S.activeWorkspace]?.id || 'main');
          S.tabs.push({ id: id, title: t.title || '読み込み中...', url: t.url, fav: t.fav || null, loading: true });
        }
        // tabTree復元: フラット順でidをマッピング
        if (ws.tabTree && ws.tabTree.length) {
          let flatIdx = 0;
          function remapTreeFlat(arr) {
            return arr.map(n => {
              if (n.type === 'folder') return { ...n, children: remapTreeFlat(n.children||[]) };
              const tab = S.tabs[flatIdx++];
              return { id: tab ? tab.id : n.id, type: 'tab' };
            });
          }
          S.tabTree = remapTreeFlat(ws.tabTree);
        } else {
          S.tabTree = S.tabs.map(t => ({ id: t.id, type: 'tab' }));
        }
        renderTabs();
        await activateTab(S.tabs[0].id);
        return;
      }
    }
  }
  newTab('https://www.google.com');
});

// ═══════════════════════════════════════════
//  通知設定
// ═══════════════════════════════════════════
let notifSettings = null;

const APP_ICONS = {
  gmail:   'https://www.google.com/s2/favicons?domain=mail.google.com&sz=32',
  slack:   'https://www.google.com/s2/favicons?domain=app.slack.com&sz=32',
  discord: 'https://www.google.com/s2/favicons?domain=discord.com&sz=32',
  chatgpt: 'https://www.google.com/s2/favicons?domain=chat.openai.com&sz=32',
  youtube: 'https://www.google.com/s2/favicons?domain=youtube.com&sz=32',
};

function renderNotifModal() {
  if (!notifSettings) return;
  const masterToggle = document.getElementById('notif-master-toggle');
  masterToggle.checked = notifSettings.enabled;

  const list = document.getElementById('notif-app-list');
  list.innerHTML = '';
  Object.entries(notifSettings.apps).forEach(([key, app]) => {
    const item = document.createElement('div');
    item.className = 'notif-app-item';
    const iconSrc = APP_ICONS[key] || (() => { try { return `https://www.google.com/s2/favicons?domain=${new URL(app.url).hostname}&sz=32`; } catch { return ''; } })();
    const isCustom = app.custom === true;
    item.innerHTML = `
      <img class="notif-app-icon" src="${iconSrc}" onerror="this.style.display='none'">
      <span class="notif-app-lbl">${app.label}</span>
      ${isCustom ? `<button class="notif-app-remove" data-remove="${key}" title="削除">✕</button>` : ''}
      <label class="toggle">
        <input type="checkbox" data-key="${key}" ${app.enabled ? 'checked' : ''} ${!notifSettings.enabled ? 'disabled' : ''}>
        <span class="toggle-slider"></span>
      </label>
    `;
    list.appendChild(item);
  });

  // マスタートグルで全アプリのdisabled制御
  masterToggle.onchange = () => {
    notifSettings.enabled = masterToggle.checked;
    list.querySelectorAll('input[data-key]').forEach(el => el.disabled = !notifSettings.enabled);
    saveNotifSettings();
  };

  list.addEventListener('change', e => {
    const key = e.target.dataset.key;
    if (key && notifSettings.apps[key]) {
      notifSettings.apps[key].enabled = e.target.checked;
      saveNotifSettings();
    }
  });

  list.addEventListener('click', e => {
    const key = e.target.dataset.remove;
    if (key && notifSettings.apps[key]?.custom) {
      delete notifSettings.apps[key];
      saveNotifSettings();
      renderNotifModal();
    }
  });
}

async function saveNotifSettings() {
  await window.browser.saveNotifSettings(notifSettings);
}

function openNotifModal() {
  document.getElementById('notif-modal').classList.add('show');
  openSB();
  renderNotifModal();
}

document.getElementById('notif-close-btn').addEventListener('click', () => {
  document.getElementById('notif-modal').classList.remove('show');
});

document.getElementById('notif-add-btn').addEventListener('click', () => {
  const input = document.getElementById('notif-add-url');
  let url = input.value.trim().replace(/^https?:\/\//, '').replace(/\/$/, '');
  if (!url) return;
  const key = 'custom_' + url.replace(/[^a-z0-9]/gi, '_');
  if (notifSettings.apps[key]) { input.value = ''; return; }
  const label = url.split('/')[0]; // ドメイン部分をラベルに
  notifSettings.apps[key] = { enabled: true, label, url, custom: true };
  saveNotifSettings();
  input.value = '';
  renderNotifModal();
});

// 通知ハブ
const hubPanel = document.getElementById('notif-hub-panel');
const hubList  = document.getElementById('notif-hub-list');
const hubBadge = document.getElementById('notif-badge');
let hubNotifs  = [];
let hubUnread  = 0;

function updateHubBadge() {
  if (hubUnread > 0) {
    hubBadge.style.display = 'flex';
    hubBadge.textContent = hubUnread > 9 ? '9+' : hubUnread;
  } else {
    hubBadge.style.display = 'none';
  }
}

function renderHubList() {
  if (hubNotifs.length === 0) {
    hubList.innerHTML = '<div class="notif-hub-empty">通知はありません</div>';
    return;
  }
  hubList.innerHTML = '';
  hubNotifs.forEach((n, idx) => {
    const d = document.createElement('div');
    d.className = 'notif-hub-item';
    const timeStr = new Date(n.time).toLocaleTimeString('ja-JP', { hour: '2-digit', minute: '2-digit' });
    const iconSrc = n.appKey ? (APP_ICONS[n.appKey] || '') : '';
    d.innerHTML = `
      <div class="notif-hub-item-top">
        ${iconSrc ? `<img class="notif-hub-app" src="${iconSrc}" onerror="this.style.display='none'">` : ''}
        <span class="notif-hub-item-title">${esc(n.title)}</span>
        <span class="notif-hub-item-time">${timeStr}</span>
      </div>
      ${n.body ? `<div class="notif-hub-item-body">${esc(n.body)}</div>` : ''}
    `;
    if (n.tabId && S.tabs.find(t => t.id === n.tabId)) {
      d.addEventListener('click', () => { activateTab(n.tabId); closeHubPanel(); });
    }
    hubList.appendChild(d);
  });
}

function closeHubPanel() {
  hubPanel.classList.remove('show');
  hubUnread = 0;
  updateHubBadge();
}

document.getElementById('notif-hub-close').addEventListener('click', closeHubPanel);
document.getElementById('notif-hub-clear').addEventListener('click', () => {
  hubNotifs = [];
  hubUnread = 0;
  updateHubBadge();
  renderHubList();
});

// ベルボタン：長押しで設定、普通クリックでハブ
let notifBtnTimer = null;
const btnNotif = document.getElementById('btn-notif');
btnNotif.addEventListener('mousedown', () => {
  notifBtnTimer = setTimeout(() => {
    notifBtnTimer = null;
    openNotifModal();
  }, 600);
});
btnNotif.addEventListener('mouseup', () => {
  if (notifBtnTimer) {
    clearTimeout(notifBtnTimer);
    notifBtnTimer = null;
    // ハブのトグル
    if (hubPanel.classList.contains('show')) {
      closeHubPanel();
    } else {
      hubPanel.classList.add('show');
      openSB();
    }
  }
});
btnNotif.addEventListener('mouseleave', () => {
  if (notifBtnTimer) { clearTimeout(notifBtnTimer); notifBtnTimer = null; }
});

// main.jsから通知ハブへ
window.browser.onNotifHub(n => {
  hubNotifs.unshift(n);
  if (hubNotifs.length > 50) hubNotifs = hubNotifs.slice(0, 50);
  if (!hubPanel.classList.contains('show')) {
    hubUnread++;
    updateHubBadge();
  }
  if (hubPanel.classList.contains('show')) renderHubList();
});

// 通知設定を受信
window.browser.onNotifSettings(settings => {
  notifSettings = settings;
});

// main.jsからのズーム変更通知でUIを表示
window.browser.onZoomChanged(pct => showZoomIndicator(pct));

// 通知クリックでタブをアクティブに
window.browser.onNotifClick(({ tabId }) => {
  if (S.tabs.find(t => t.id === tabId)) activateTab(tabId);
});

// 起動時に設定を取得
window.browser.getNotifSettings().then(settings => {
  notifSettings = settings;
});

// ═══════════════════════════════════════════
//  ブックマーク編集モーダル
// ═══════════════════════════════════════════
function openBmEditModal(bm, type) {
  const modal = document.getElementById('bm-edit-modal');
  document.getElementById('bm-edit-name').value = bm.name || '';
  document.getElementById('bm-edit-url').value  = bm.url  || '';
  modal.classList.add('show');
  setTimeout(() => document.getElementById('bm-edit-name').focus(), 40);

  document.getElementById('bm-edit-confirm').onclick = () => {
    const name = document.getElementById('bm-edit-name').value.trim();
    const url  = document.getElementById('bm-edit-url').value.trim();
    if (!url) return;
    let u = url;
    if (!u.startsWith('http://') && !u.startsWith('https://')) u = 'https://' + u;
    bm.name = (name || u).slice(0, 32);
    bm.url  = u;
    if (type === 'bm1') { renderBM(); scheduleSave(); }
    else renderBM2();
    modal.classList.remove('show');
  };
  document.getElementById('bm-edit-cancel').onclick = () => modal.classList.remove('show');
}

// ═══════════════════════════════════════════
//  ワークスペース
// ═══════════════════════════════════════════
function renderWorkspaceBar() {
  const bar = document.getElementById('ws-bar');
  if (!bar) return;
  bar.innerHTML = '';
  S.workspaces.forEach((ws, i) => {
    const btn = document.createElement('button');
    btn.className = 'ws-dot-btn' + (i === S.activeWorkspace ? ' active' : '');
    btn.title = ws.name;
    btn.style.background = i === S.activeWorkspace ? ws.color : 'var(--card-border)';
    btn.textContent = ws.avatar[0] || ws.name[0];
    btn.addEventListener('click', () => switchWorkspace(i));
    btn.addEventListener('contextmenu', e => {
      e.preventDefault();
      showContextMenu(e.clientX, e.clientY, [
        { label: '編集', action: () => openWorkspaceModal(i) },
        ...(S.workspaces.length > 1 ? [{ label: '削除', action: () => deleteWorkspace(i) }] : []),
      ]);
    });
    bar.appendChild(btn);
  });
  // ＋追加ボタン
  const addBtn = document.createElement('button');
  addBtn.className = 'ws-dot-btn ws-add';
  addBtn.title = 'ワークスペースを追加';
  addBtn.textContent = '+';
  addBtn.addEventListener('click', () => openWorkspaceModal(-1));
  bar.appendChild(addBtn);

  // space-dotsも非表示にする（ワークスペースバーが代替）
  const spaceDots = document.getElementById('space-dots');
  if (spaceDots) spaceDots.style.display = 'none';

  // pane-1も非表示（ワークスペースで代替）
  const pane1 = document.getElementById('pane-1');
  if (pane1) pane1.style.display = 'none';

  // 現在のワークスペース色をaccentに反映
  const currentWs = S.workspaces[S.activeWorkspace];
  if (currentWs) {
    document.documentElement.style.setProperty('--accent', currentWs.color);
    document.documentElement.style.setProperty('--accent-s', currentWs.color + '22');
    document.documentElement.style.setProperty('--spin', currentWs.color);
  }
}

function switchWorkspace(idx) {
  // 現在のタブ・ブックマーク状態を保存（有効なインデックスのときのみ）
  if (S.activeWorkspace >= 0 && S.activeWorkspace < S.workspaces.length) {
    S.workspaces[S.activeWorkspace].tabs = S.tabs.map(t => ({ ...t }));
    S.workspaces[S.activeWorkspace].bookmarks = JSON.parse(JSON.stringify(S.bookmarks));
    S.workspaces[S.activeWorkspace].tabTree = JSON.parse(JSON.stringify(S.tabTree||[]));
  }

  S.activeWorkspace = idx;
  const ws = S.workspaces[idx];

  // アクセントカラーをワークスペース色に変更
  document.documentElement.style.setProperty('--accent', ws.color);
  document.documentElement.style.setProperty('--accent-s', ws.color + '22');
  document.documentElement.style.setProperty('--spin', ws.color);

  // アカウント表示を更新
  const avatar = document.getElementById('acct-avatar-0');
  const name   = document.getElementById('acct-name-0');
  if (avatar) {
    avatar.textContent = ws.avatar[0] || ws.name[0];
    avatar.style.borderColor = ws.color;
    avatar.style.color = ws.color;
    avatar.style.background = ws.color + '22';
  }
  if (name) name.textContent = ws.name;

  // ブックマーク復元
  S.bookmarks = ws.bookmarks ? [...ws.bookmarks] : [];
  renderBM();
  renderWorkspaceBar();
  renderHWorkspaces();

  // ログイン強制なし・直接タブ切り替え
  _doSwitchWorkspaceTabs(idx, ws);
  scheduleSave();
}

function _doSwitchWorkspaceTabs(idx, ws) {
  // タブを全て閉じて新しいワークスペースのタブを復元
  const prevTabs = [...S.tabs];
  S.tabs = []; S.active = null; updateUrl(''); renderTabs();
  Promise.all(prevTabs.map(t => window.browser.closeTab(t.id))).then(() => {
    const savedTabs = (ws.tabs || []).filter(t => t.url && t.url.startsWith('http'));
    if (savedTabs.length) {
      (async () => {
        for (const t of savedTabs) {
          const id = await window.browser.createTab(t.url, S.workspaces[idx]?.id || 'main');
          S.tabs.push({ id, title: t.title || '読み込み中...', url: t.url, fav: t.fav, loading: true });
        }
        if (ws.tabTree && ws.tabTree.length) {
          let fi = 0;
          function remapFlat(arr) {
            return arr.map(n => n.type==='folder' ? {...n,children:remapFlat(n.children||[])} : { id: (S.tabs[fi++]||S.tabs[S.tabs.length-1]).id, type:'tab' });
          }
          S.tabTree = remapFlat(ws.tabTree);
        } else {
          S.tabTree = S.tabs.map(t => ({ id: t.id, type: 'tab' }));
        }
        S.bookmarks = ws.bookmarks ? JSON.parse(JSON.stringify(ws.bookmarks)) : [];
        renderBM();
        renderTabs();
        await activateTab(S.tabs[0].id);
      })();
    } else {
      S.tabTree = [];
      S.bookmarks = ws.bookmarks ? JSON.parse(JSON.stringify(ws.bookmarks)) : [];
      renderBM();
      newTab('https://www.google.com');
    }
  });
}

// ワークスペースログインモーダル（サイドバー内オーバーレイ）
let loginWatcherTimer = null;

function showWsLoginModal(wsIdx) {
  const ws = S.workspaces[wsIdx];
  let modal = document.getElementById('ws-login-modal');
  if (!modal) {
    modal = document.createElement('div');
    modal.id = 'ws-login-modal';
    modal.style.cssText = 'position:absolute;inset:0;z-index:9000;background:var(--panel);display:flex;flex-direction:column;align-items:center;justify-content:center;gap:16px;padding:28px;text-align:center;';
    document.getElementById('sb').appendChild(modal);
  }

  const GSVG = '<svg width="32" height="32" viewBox="0 0 48 48"><path d="M44.5 20H24v8.5h11.8C34.7 33.9 30.1 37 24 37c-7.2 0-13-5.8-13-13s5.8-13 13-13c3.1 0 5.9 1.1 8.1 2.9l6.4-6.4C34.6 4.1 29.6 2 24 2 11.8 2 2 11.8 2 24s9.8 22 22 22c11 0 21-8 21-22 0-1.3-.2-2.7-.5-4z" fill="#FFC107"/><path d="M6.3 14.7l7.4 5.4C15.5 16 19.5 13 24 13c3.1 0 5.9 1.1 8.1 2.9l6.4-6.4C34.6 4.1 29.6 2 24 2 16.3 2 9.7 7.4 6.3 14.7z" fill="#FF3D00"/><path d="M24 46c5.5 0 10.5-1.9 14.3-5.1l-6.6-5.6C29.7 36.8 27 37.5 24 37.5c-6 0-10.7-4-12.3-9.5L4.2 33.6C7.6 40.9 15.2 46 24 46z" fill="#4CAF50"/><path d="M44.5 20H24v8.5h11.8c-.7 2.8-2.4 5.1-4.7 6.7l6.6 5.6C42 37.5 45 31.3 45 24c0-1.3-.2-2.7-.5-4z" fill="#1976D2"/></svg>';
  const btnStyle = 'display:flex;align-items:center;gap:8px;padding:10px 18px;border-radius:11px;border:1px solid var(--card-border);background:var(--card);cursor:pointer;font-size:13px;font-weight:500;color:var(--text);font-family:inherit;width:100%;justify-content:center;';

  const sessionInfo = ws.sessionInfo;
  if (sessionInfo && sessionInfo.loggedIn) {
    const loginDate = sessionInfo.loginAt ? new Date(sessionInfo.loginAt).toLocaleDateString('ja-JP', { month:'short', day:'numeric' }) : '';
    modal.innerHTML = GSVG +
      '<div style="font-size:13px;font-weight:600;color:var(--text);line-height:1.6;">' + esc(ws.name) + '</div>' +
      '<div style="font-size:11px;color:var(--text2);">前回ログインしたアカウントの情報が保存されています' + (loginDate ? '（' + loginDate + '）' : '') + '</div>' +
      '<button id="ws-login-resume-btn" style="' + btnStyle + '">このままログインする</button>' +
      '<button id="ws-login-new-btn" style="background:transparent;border:none;color:var(--text2);font-size:12px;cursor:pointer;font-family:inherit;padding:4px;">別のアカウントでログインする</button>';
    modal.style.display = 'flex';
    document.getElementById('ws-login-resume-btn').addEventListener('click', () => {
      ws.loggedInEmail = sessionInfo.loginUrl || 'https://mail.google.com';
      hideWsLoginModal();
      _doSwitchWorkspaceTabs(wsIdx, ws);
      scheduleSave();
    });
    document.getElementById('ws-login-new-btn').addEventListener('click', () => {
      ws.sessionInfo = null; ws.loggedInEmail = null;
      showWsLoginModal(wsIdx);
    });
    return;
  }

  modal.innerHTML = GSVG +
    '<div style="font-size:13px;font-weight:600;color:var(--text);line-height:1.6;">' + esc(ws.name) + '<br>Googleアカウントでログインしてください</div>' +
    '<div style="font-size:11px;color:var(--text2);">ログイン後、専用のタブ・ブックマークが使えます</div>' +
    '<button id="ws-login-go-btn" style="' + btnStyle + '">Googleでログイン</button>' +
    '<button id="ws-login-skip-btn" style="background:transparent;border:none;color:var(--text2);font-size:12px;cursor:pointer;font-family:inherit;padding:4px;">ログインせずに使う</button>';
  modal.style.display = 'flex';

  document.getElementById('ws-login-skip-btn').addEventListener('click', () => {
    ws.loggedInEmail = 'skipped';
    hideWsLoginModal();
    _doSwitchWorkspaceTabs(wsIdx, ws);
    scheduleSave();
  });

  document.getElementById('ws-login-go-btn').addEventListener('click', async () => {
    const m = document.getElementById('ws-login-modal');
    m.innerHTML =
      '<div style="font-size:13px;font-weight:600;color:var(--text);">ログイン中...</div>' +
      '<div style="font-size:11px;color:var(--text2);line-height:1.6;">Googleアカウントでログインしてください<br>ログイン完了後、自動でワークスペースが切り替わります</div>' +
      '<div style="width:32px;height:32px;border:3px solid var(--card-border);border-top-color:var(--accent);border-radius:50%;animation:sp .65s linear infinite;"></div>' +
      '<button id="ws-login-cancel-btn" style="background:transparent;border:none;color:var(--text2);font-size:12px;cursor:pointer;font-family:inherit;padding:4px;">キャンセル（ワークスペース0に戻る）</button>';
    document.getElementById('ws-login-cancel-btn').addEventListener('click', () => {
      clearInterval(loginWatcherTimer);
      hideWsLoginModal();
      switchWorkspace(0);
    });
    const id = await window.browser.createTab('https://accounts.google.com/signin', S.workspaces[wsIdx]?.id || 'main');
    S.tabs.push({ id, title: 'Googleログイン', url: 'https://accounts.google.com/signin', fav: null, loading: true });
    renderTabs();
    await activateTab(id);
    startLoginWatcher(wsIdx);
  });
}

function hideWsLoginModal() {
  const modal = document.getElementById('ws-login-modal');
  if (modal) modal.remove();
}

function startLoginWatcher(wsIdx) {
  clearInterval(loginWatcherTimer);
  loginWatcherTimer = setInterval(async () => {
    if (!S.active) return;
    const url = await window.browser.getUrl(S.active);
    if (url && url.includes('google.com') && !url.includes('accounts.google.com')) {
      clearInterval(loginWatcherTimer);
      // ページタイトルからメールアドレスを取得できないのでURLドメインから推測
      // 実際のメール取得はGoogle API不要 ─ セッション確立を確認できればOK
      S.workspaces[wsIdx].loggedInEmail = url;
      S.workspaces[wsIdx].sessionInfo = { loggedIn: true, loginUrl: url, loginAt: Date.now() };
      window.browser.saveSessionInfo(wsIdx, S.workspaces[wsIdx].sessionInfo);
      hideWsLoginModal();
      scheduleSave();
      _doSwitchWorkspaceTabs(wsIdx, S.workspaces[wsIdx]);
    }
  }, 1500);
}

function deleteWorkspace(idx) {
  if (S.workspaces.length <= 1) return;
  // 削除前に現在の状態を保存しないようにS.activeWorkspaceを一時退避
  const prevActive = S.activeWorkspace;
  S.workspaces.splice(idx, 1);
  const newIdx = Math.min(idx > 0 ? idx - 1 : 0, S.workspaces.length - 1);
  // 削除後のインデックスに強制移動（保存スキップのため一旦無効値に）
  S.activeWorkspace = -1;
  switchWorkspace(newIdx);
}

function openWorkspaceModal(idx) {
  const modal = document.getElementById('workspace-modal');
  const isNew = idx === -1;
  const ws = isNew ? { name: '', avatar: 'W', color: '#3478f6', tabs: [], bookmarks: [] } : S.workspaces[idx];

  document.getElementById('ws-modal-title').textContent = isNew ? 'ワークスペースを追加' : 'ワークスペースを編集';
  document.getElementById('ws-name-input').value = ws.name;

  // カラー選択
  const colors = ['#3478f6','#34c759','#ff9500','#ff3b30','#af52de','#00bcd4','#795548','#607d8b'];
  const colorPicker = document.getElementById('ws-color-picker');
  colorPicker.innerHTML = '';
  colors.forEach(c => {
    const btn = document.createElement('button');
    btn.className = 'ws-color-swatch' + (ws.color === c ? ' selected' : '');
    btn.style.background = c;
    btn.addEventListener('click', () => {
      colorPicker.querySelectorAll('.ws-color-swatch').forEach(b => b.classList.remove('selected'));
      btn.classList.add('selected');
      ws.color = c;
    });
    colorPicker.appendChild(btn);
  });
  if (!colors.includes(ws.color)) ws.color = colors[0];

  // Googleアカウントセクション（編集時のみ表示）
  const accountSection = document.getElementById('ws-account-section');
  if (isNew) {
    accountSection.style.display = 'none';
  } else {
    accountSection.style.display = 'block';
    _updateWsAccountUI(ws);

    const loginBtn = document.getElementById('ws-login-btn');
    const newLoginBtn = loginBtn.cloneNode(true);
    loginBtn.parentNode.replaceChild(newLoginBtn, loginBtn);
    newLoginBtn.addEventListener('click', async () => {
      modal.classList.remove('show');
      const loginTabId = await window.browser.createTab('https://accounts.google.com/signin', ws.id || 'main');
      S.tabs.push({ id: loginTabId, title: 'Googleログイン', url: 'https://accounts.google.com/signin', fav: null, loading: true });
      renderTabs();
      await activateTab(loginTabId);
      const watchTimer = setInterval(async () => {
        const url = await window.browser.getUrl(loginTabId).catch(() => '');
        if (url && url.includes('google.com') && !url.includes('accounts.google.com')) {
          clearInterval(watchTimer);
          if (idx >= 0 && idx < S.workspaces.length) {
            S.workspaces[idx].loggedInEmail = url;
            S.workspaces[idx].sessionInfo = { loggedIn: true, loginUrl: url, loginAt: Date.now() };
          }
          scheduleSave();
          showNotifToast('Googleアカウントでログインしました');
        }
      }, 1500);
    });

    const logoutBtn = document.getElementById('ws-account-logout-btn');
    const newLogoutBtn = logoutBtn.cloneNode(true);
    logoutBtn.parentNode.replaceChild(newLogoutBtn, logoutBtn);
    newLogoutBtn.addEventListener('click', () => {
      if (idx >= 0) {
        S.workspaces[idx].loggedInEmail = null;
        S.workspaces[idx].sessionInfo = null;
      }
      scheduleSave();
      _updateWsAccountUI(S.workspaces[idx] || ws);
    });
  }

  modal.classList.add('show');

  const confirmBtn = document.getElementById('ws-modal-confirm');
  const newConfirmBtn = confirmBtn.cloneNode(true);
  confirmBtn.parentNode.replaceChild(newConfirmBtn, confirmBtn);

  const cancelBtn = document.getElementById('ws-modal-cancel');
  const newCancelBtn = cancelBtn.cloneNode(true);
  cancelBtn.parentNode.replaceChild(newCancelBtn, cancelBtn);

  newConfirmBtn.addEventListener('click', () => {
    const name = document.getElementById('ws-name-input').value.trim() || 'ワークスペース';
    const color = ws.color;
    const avatar = name[0].toUpperCase();

    if (isNew) {
      S.workspaces.push({ id: 'ws' + Date.now(), name, avatar, color, tabs: [], bookmarks: [] });
      renderWorkspaceBar();
  renderHWorkspaces();
      modal.classList.remove('show');
      switchWorkspace(S.workspaces.length - 1);
    } else {
      S.workspaces[idx].name  = name;
      S.workspaces[idx].avatar = avatar;
      S.workspaces[idx].color = color;
      if (idx === S.activeWorkspace) {
        const av = document.getElementById('acct-avatar-0');
        const nm = document.getElementById('acct-name-0');
        if (av) { av.textContent = avatar; av.style.borderColor = color; av.style.color = color; av.style.background = color+'22'; }
        if (nm) nm.textContent = name;
      }
      renderWorkspaceBar();
  renderHWorkspaces();
      modal.classList.remove('show');
    }
    scheduleSave();
  });
  newCancelBtn.addEventListener('click', () => modal.classList.remove('show'));
}

function _updateWsAccountUI(ws) {
  const icon = document.getElementById('ws-account-icon');
  const label = document.getElementById('ws-account-label');
  const loginBtn = document.getElementById('ws-login-btn');
  const logoutBtn = document.getElementById('ws-account-logout-btn');
  if (!icon || !label) return;
  if (ws.sessionInfo?.loggedIn || ws.loggedInEmail) {
    const loginDate = ws.sessionInfo?.loginAt
      ? new Date(ws.sessionInfo.loginAt).toLocaleDateString('ja-JP', { month:'short', day:'numeric' }) : '';
    icon.textContent = '';
    icon.style.background = '#34c75922';
    icon.style.color = '#34c759';
    label.textContent = 'ログイン済み' + (loginDate ? '（' + loginDate + '）' : '');
    label.style.color = 'var(--text)';
    if (loginBtn) loginBtn.style.display = 'none';
    if (logoutBtn) logoutBtn.style.display = '';
  } else {
    icon.textContent = '?';
    icon.style.background = 'var(--card-border)';
    icon.style.color = 'var(--text2)';
    label.textContent = '未ログイン';
    label.style.color = 'var(--text2)';
    if (loginBtn) loginBtn.style.display = 'flex';
    if (logoutBtn) logoutBtn.style.display = 'none';
  }
}

// ワークスペースバーをスペースドットの上に追加
document.addEventListener('DOMContentLoaded', () => {});
renderWorkspaceBar();
  renderHWorkspaces();


// ═══════════════════════════════════════════
//  履歴モーダル
// ═══════════════════════════════════════════
let historyData = [];

function formatTime(ts) {
  const d = new Date(ts), now = new Date(), diffMin = Math.floor((now - d) / 60000);
  if (diffMin < 1) return 'たった今';
  if (diffMin < 60) return `${diffMin}分前`;
  const diffH = Math.floor(diffMin / 60);
  if (diffH < 24) return `${diffH}時間前`;
  return d.toLocaleDateString('ja-JP', { month: 'short', day: 'numeric' });
}

function renderHistoryList(filter = '') {
  const el = document.getElementById('history-list');
  const items = filter ? historyData.filter(h => h.title?.includes(filter) || h.url?.includes(filter)) : historyData;
  if (!items.length) { el.innerHTML = '<div class="history-empty">履歴がありません</div>'; return; }
  el.innerHTML = '';
  items.forEach(h => {
    const d = document.createElement('div'); d.className = 'history-item';
    const favicon = h.url ? (() => { try { return `https://www.google.com/s2/favicons?domain=${new URL(h.url).hostname}&sz=32`; } catch { return ''; } })() : '';
    d.innerHTML = `<img class="history-item-icon" src="${favicon}" onerror="this.style.display='none'"><div class="history-item-info"><div class="history-item-title">${esc(h.title||h.url||'')}</div><div class="history-item-url">${esc(h.url||'')}</div></div><div class="history-item-time">${formatTime(h.visitedAt)}</div><button class="history-item-del">✕</button>`;
    d.addEventListener('click', e => { if (e.target.classList.contains('history-item-del')) return; closeHistoryModal(); if (S.active) window.browser.navigate(S.active, h.url); else newTab(h.url); });
    d.querySelector('.history-item-del').addEventListener('click', e => { e.stopPropagation(); const i = historyData.indexOf(h); if (i >= 0) historyData.splice(i, 1); renderHistoryList(document.getElementById('history-search').value); });
    el.appendChild(d);
  });
}

async function openHistoryModal() {
  historyData = await window.browser.getHistory();
  document.getElementById('history-modal').classList.add('show');
  document.getElementById('history-search').value = '';
  renderHistoryList(); openSB();
}
function closeHistoryModal() { document.getElementById('history-modal').classList.remove('show'); }

document.getElementById('history-close-btn').addEventListener('click', closeHistoryModal);
document.getElementById('history-modal').addEventListener('click', e => { if (e.target === document.getElementById('history-modal')) closeHistoryModal(); });
document.getElementById('history-clear-btn').addEventListener('click', async () => { await window.browser.clearHistory(); historyData = []; renderHistoryList(); });
document.getElementById('history-search').addEventListener('input', e => renderHistoryList(e.target.value));

// ═══════════════════════════════════════════
//  ダウンロード履歴モーダル
// ═══════════════════════════════════════════
let downloadData = [];

function renderDownloadList() {
  const el = document.getElementById('download-list');
  if (!downloadData.length) { el.innerHTML = '<div class="history-empty">ダウンロード履歴がありません</div>'; return; }
  el.innerHTML = '';
  downloadData.forEach(d => {
    const item = document.createElement('div'); item.className = 'history-item';
    const stateLabel = d.state === 'completed' ? '' : d.state === 'cancelled' ? '✕' : '…';
    const stateColor = d.state === 'completed' ? '#4caf50' : d.state === 'cancelled' ? '#f44336' : 'var(--text2)';
    const size = d.totalBytes > 0 ? (d.totalBytes > 1048576 ? `${(d.totalBytes/1048576).toFixed(1)} MB` : `${(d.totalBytes/1024).toFixed(0)} KB`) : '';
    item.innerHTML = `<div style="font-size:18px;color:${stateColor};flex-shrink:0;width:18px;text-align:center">${stateLabel}</div><div class="history-item-info"><div class="history-item-title">${esc(d.filename||'')}${d.aiName ? `<span class="ai-rename-badge" title="クリックでコピー">✦ ${esc(d.aiName)}</span>` : ''}</div><div class="history-item-url">${esc(d.url||'')}${size?' · '+size:''}</div></div><div class="history-item-time">${formatTime(d.startedAt)}</div>`;
    // AIリネームバッジのクリックイベント
    if (d.aiName) {
      const badge = item.querySelector('.ai-rename-badge');
      if (badge) badge.addEventListener('click', e => {
        e.stopPropagation();
        navigator.clipboard.writeText(d.aiName).then(() => {
          badge.textContent = ' コピー済み';
          setTimeout(() => { badge.textContent = `✦ ${d.aiName}`; }, 1500);
        });
      });
    }
    el.appendChild(item);
  });
}

async function openDownloadModal() {
  downloadData = await window.browser.getDownloadHistory();
  document.getElementById('download-modal').classList.add('show');
  renderDownloadList(); openSB();
}
function closeDownloadModal() { document.getElementById('download-modal').classList.remove('show'); }

document.getElementById('download-close-btn').addEventListener('click', closeDownloadModal);
document.getElementById('download-modal').addEventListener('click', e => { if (e.target === document.getElementById('download-modal')) closeDownloadModal(); });
document.getElementById('download-clear-btn').addEventListener('click', async () => { await window.browser.clearDownloadHistory(); downloadData = []; renderDownloadList(); });
window.browser.onDownloadDone(entry => {
  downloadData.unshift(entry);
  // AIリネーム提案（パネルが開いていれば即時反映）
  if (window.spiralAI && document.getElementById('download-modal')?.classList.contains('show')) {
    renderDownloadList();
  }
});


// ═══════════════════════════════════════════
//  Spiral AI 初期化
// ═══════════════════════════════════════════
(function initSpiralAI() {
  if (!window.spiralAI) return;

  // AI初期化
  window.spiralAI.init();

  // AIボタン
  const btnAI = document.getElementById('btn-ai');
  if (btnAI) {
    btnAI.addEventListener('click', () => {
      window.browser.openAIWindow();
      btnAI.classList.add('active');
    });
  }

  // ダウンロードリネームフック
  window.spiralAI.hookDownloadRename();

  // AIウィンドウが閉じられたらボタンのactiveを外す
  window.browser.onAIWindowClosed(() => {
    document.getElementById('btn-ai')?.classList.remove('active');
  });
})();




// ══════════════════════════════════════════════════════
//  オートフィル
// ══════════════════════════════════════════════════════
const autofillBanner = document.getElementById('autofill-banner');
const autofillList   = document.getElementById('autofill-list');
let _autofillPending = null; // { url, user, pass, inputUser, inputPass }

document.getElementById('autofill-close')?.addEventListener('click', () => {
  autofillBanner.style.display = 'none';
  _autofillPending = null;
});

// ページ遷移時にパスワードフォームを検出してバナーを出す
window.browser.onNavigate(async ({ url }) => {
  if (!url || !url.startsWith('http')) return;
  autofillBanner.style.display = 'none';
  _autofillPending = null;
  if (!window.browser.getPasswords) return;
  const { passwords } = await window.browser.getPasswords();
  if (!passwords || !passwords.length) return;

  // URLのhostnameで絞り込み
  let hostname = '';
  try { hostname = new URL(url).hostname.replace(/^www\./, ''); } catch { return; }
  const matches = passwords.filter(p => {
    try { return new URL(p.url).hostname.replace(/^www\./, '').includes(hostname) || hostname.includes(new URL(p.url).hostname.replace(/^www\./,'')); } catch { return false; }
  });
  if (!matches.length) return;

  // バナーを表示
  const domainEl = document.getElementById('autofill-domain');
  if (domainEl) domainEl.textContent = hostname;
  autofillList.innerHTML = '';
  matches.slice(0, 5).forEach(pw => {
    const item = document.createElement('button');
    item.style.cssText = [
      'display:flex;align-items:center;gap:10px;',
      'padding:9px 10px;border-radius:10px;border:none;',
      'background:transparent;cursor:pointer;width:100%;text-align:left;',
      'transition:background .1s;',
    ].join('');
    item.onmouseenter = () => item.style.background = 'var(--hover)';
    item.onmouseleave = () => item.style.background = 'transparent';
    // アバター（ユーザー名の頭文字）
    const initial = (pw.user || '?')[0].toUpperCase();
    item.innerHTML = `
      <div style="width:32px;height:32px;border-radius:8px;background:linear-gradient(135deg,#6d4aff,#9c6fff);
        display:flex;align-items:center;justify-content:center;flex-shrink:0;
        font-size:13px;font-weight:700;color:#fff;">${initial}</div>
      <div style="flex:1;min-width:0;">
        <div style="font-size:13px;font-weight:500;color:var(--text);
          overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">${pw.user}</div>
        <div style="font-size:11px;color:var(--text2);letter-spacing:.05em;">--------</div>
      </div>
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="var(--text2)" stroke-width="2"
        style="flex-shrink:0;opacity:.5;"><path d="M5 12h14M12 5l7 7-7 7"/></svg>`;
    item.addEventListener('click', async () => {
      const tabId = S.active;
      if (!tabId) return;
      await window.browser.fillCredentials?.(tabId, pw.user, pw.pass);
      autofillBanner.style.display = 'none';
      // 入力成功のフィードバック
      item.style.background = 'var(--accent-s)';
    });
    autofillList.appendChild(item);
  });
  autofillBanner.style.display = 'block';
  // 12秒後に自動で消える
  clearTimeout(window._autofillTimer);
  window._autofillTimer = setTimeout(() => { autofillBanner.style.display = 'none'; }, 12000);
});



// ══════════════════════════════════════════════
//  拡張機能パネル
// ══════════════════════════════════════════════
const extPanel    = document.getElementById('ext-panel');
const extList     = document.getElementById('ext-list');
const extCtxMenu  = document.getElementById('ext-ctx-menu');
let _extCtxId     = null;

// パネル開閉
// 水平レイアウトの拡張機能ボタンも同じ動作
function openExtPanel() {
  renderExtPanel();
  extPanel.classList.add('show');
  notifyModalState();
}
function closeExtPanel() {
  extPanel.classList.remove('show');
  notifyModalState();
}

['btn-ext', 'h-btn-ext'].forEach(btnId => {
  document.getElementById(btnId)?.addEventListener('click', e => {
    e.stopPropagation();
    if (extPanel.classList.contains('show')) { closeExtPanel(); return; }
    openExtPanel();
  });
});

document.getElementById('ext-panel-close')?.addEventListener('click', closeExtPanel);

document.addEventListener('click', e => {
  const ids = ['btn-ext', 'h-btn-ext'];
  if (extPanel.classList.contains('show') &&
      !extPanel.contains(e.target) &&
      !ids.includes(e.target.id)) {
    closeExtPanel();
  }
  if (extCtxMenu.style.display !== 'none' && !extCtxMenu.contains(e.target)) {
    extCtxMenu.style.display = 'none';
  }
});

// 「使用する」ボタンを無効化する拡張機能（自動動作系）
const BLOCKED_EXT_IDS = new Set([
  'maekfnoeejhpjfkfmdlckioggdcdofpg', // Adblocker for YouTube
]);

async function renderExtPanel() {
  extList.innerHTML = '<div style="padding:8px 10px;font-size:11px;color:var(--text2);">読み込み中...</div>';
  const r = await window.browser.getExtensions().catch(() => ({ extensions: [] }));
  const exts = r.extensions || [];
  if (!exts.length) {
    extList.innerHTML = '<div style="padding:8px 10px;font-size:11px;color:var(--text2);">インストール済みの拡張機能はありません</div>';
    return;
  }
  extList.innerHTML = '';
  exts.forEach(ext => {
    // 旧形式（stringのID）との互換
    const id   = typeof ext === 'string' ? ext : ext.id;
    const name = typeof ext === 'string' ? id  : (ext.name || id);
    const icon = typeof ext === 'string' ? null : ext.icon;
    const row = document.createElement('div');
    row.style.cssText = 'display:flex;align-items:center;gap:10px;padding:8px 10px;border-radius:8px;cursor:default;';
    row.onmouseenter = () => row.style.background = 'var(--hover)';
    row.onmouseleave = () => row.style.background = '';
    // アイコン要素
    const iconEl = document.createElement('div');
    iconEl.style.cssText = 'width:28px;height:28px;border-radius:7px;background:var(--card-border);display:flex;align-items:center;justify-content:center;flex-shrink:0;overflow:hidden;';
    if (icon) {
      window.browser.getExtIcon(icon).then(dataUri => {
        if (dataUri) {
          iconEl.innerHTML = `<img src="${dataUri}" style="width:24px;height:24px;border-radius:5px;object-fit:contain;">`;
        }
      }).catch(() => {});
    } else {
      iconEl.innerHTML = `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="var(--text2)" stroke-width="2"><path d="M20.5 11H19V7a2 2 0 0 0-2-2h-4V3.5A2.5 2.5 0 0 0 10.5 1 2.5 2.5 0 0 0 8 3.5V5H4a2 2 0 0 0-2 2v3.8h1.5A2.5 2.5 0 0 1 6 13.3 2.5 2.5 0 0 1 3.5 16H2V20a2 2 0 0 0 2 2h4v-1.5A2.5 2.5 0 0 1 10.5 18a2.5 2.5 0 0 1 2.5 2.5V22h4a2 2 0 0 0 2-2v-4h1.5a2.5 2.5 0 0 0 0-5z"/></svg>`;
    }
    row.appendChild(iconEl);
    const nameEl = document.createElement('span');
    nameEl.style.cssText = 'flex:1;font-size:13px;font-weight:500;color:var(--text);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;';
    nameEl.title = name;
    nameEl.textContent = name;
    row.appendChild(nameEl);
    const menuBtn = document.createElement('button');
    menuBtn.className = 'ext-menu-btn';
    menuBtn.dataset.id = id;
    menuBtn.style.cssText = 'width:24px;height:24px;border-radius:5px;background:transparent;border:none;color:var(--text2);cursor:pointer;display:flex;align-items:center;justify-content:center;font-size:16px;font-weight:700;letter-spacing:1px;';
    menuBtn.title = 'メニュー';
    menuBtn.textContent = '...';
    row.appendChild(menuBtn);
    extList.appendChild(row);
  });
}

// 3点メニュー
extList.addEventListener('click', e => {
  const btn = e.target.closest('.ext-menu-btn');
  if (!btn) return;
  e.stopPropagation();
  _extCtxId = btn.dataset.id;
  const r = btn.getBoundingClientRect();
  const isBlocked = BLOCKED_EXT_IDS.has(_extCtxId);
  extCtxMenu.innerHTML = `
    <button class="ext-ctx-item" data-action="use" ${isBlocked ? 'disabled' : ''} style="
      display:block;width:100%;padding:10px 16px;border:none;background:transparent;
      color:${isBlocked ? 'var(--textm)' : 'var(--text)'};font-size:13px;font-family:inherit;
      cursor:${isBlocked ? 'not-allowed' : 'pointer'};text-align:left;opacity:${isBlocked ? '0.4' : '1'};
    ">使用する${isBlocked ? '（自動で動作中）' : ''}</button>
    <div style="border-top:1px solid var(--panel-border);margin:2px 0;"></div>
    <button class="ext-ctx-item" data-action="remove" style="
      display:block;width:100%;padding:10px 16px;border:none;background:transparent;
      color:#ff3b30;font-size:13px;font-family:inherit;cursor:pointer;text-align:left;
    ">削除</button>`;
  extCtxMenu.style.display = 'block';
  extCtxMenu.style.left = (r.right + 4) + 'px';
  extCtxMenu.style.top  = r.top + 'px';
  // ホバー
  extCtxMenu.querySelectorAll('.ext-ctx-item').forEach(el => {
    el.onmouseenter = () => el.style.background = 'var(--hover)';
    el.onmouseleave = () => el.style.background = 'transparent';
  });
});
extCtxMenu.addEventListener('click', async e => {
  const item = e.target.closest('.ext-ctx-item');
  if (!item || !_extCtxId) return;
  if (item.disabled) return;
  extCtxMenu.style.display = 'none';
  if (item.dataset.action === 'use') {
    closeExtPanel();
    const r = await window.browser.toggleExtension(_extCtxId).catch(() => ({ error: '失敗' }));
    if (r.error) {
      // コンテンツスクリプトが注入できない場合はオプションページを開く
      newTab(`chrome-extension://${_extCtxId}/`);
    }
  } else if (item.dataset.action === 'remove') {
    await window.browser.uninstallExtension(_extCtxId);
    renderExtPanel();
  }
});

// URLからext IDを抽出してインストール
document.getElementById('ext-install-btn')?.addEventListener('click', async () => {
  const inp = document.getElementById('ext-install-url');
  const status = document.getElementById('ext-install-status');
  const url = inp?.value?.trim();
  if (!url) return;
  // Web Store URL から ID を抽出
  // https://chromewebstore.google.com/detail/xxx/EXTID
  // https://chrome.google.com/webstore/detail/xxx/EXTID
  let extId = null;
  const m = url.match(/\/([a-z]{32})(?:[\/?]|$)/);
  if (m) extId = m[1];
  else if (/^[a-z]{32}$/.test(url)) extId = url;
  if (!extId) { status.textContent = '有効なURLまたはIDを入力してください'; return; }
  const btn = document.getElementById('ext-install-btn');
  btn.disabled = true; btn.textContent = '追加中...';
  status.textContent = 'インストール中...';
  const r = await window.browser.installExtension(extId).catch(() => ({ error: '失敗' }));
  btn.disabled = false; btn.textContent = '追加';
  if (r.ok || r.extId) {
    status.textContent = 'インストールしました（再起動後に有効）';
    inp.value = '';
    renderExtPanel();
  } else {
    status.textContent = 'エラー: ' + (r.error || 'インストール失敗');
  }
});

// ── モーダル開閉の一括監視（水平レイアウト時のhit-testing制御用） ──
// classList.add/remove('show') と style.display の両方に対応
(function() {
  const modalIds = [
    'import-modal', 'bm2-date-modal', 'bm1-add-modal', 'notif-modal',
    'history-modal', 'download-modal', 'bm-edit-modal', 'workspace-modal',
    'notif-hub-panel', 'prompt-modal', 'split-modal', 'settings-modal', 'ext-panel',
  ];
  const observer = new MutationObserver(() => notifyModalState());
  modalIds.forEach(id => {
    const el = document.getElementById(id);
    if (el) observer.observe(el, { attributes: true, attributeFilter: ['class', 'style'] });
  });
  // overlay も監視
  if (overlay) observer.observe(overlay, { attributes: true, attributeFilter: ['class'] });
})();


