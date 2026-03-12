// ═══════════════════════════════════════════
//  状態
// ═══════════════════════════════════════════
const S = {
  tabs: [], active: null, dark: false,
  bookmarks: [],      // スペース0のブックマーク
  bookmarks2: [],     // スペース1のブックマーク（日時指定で消える）
  currentSpace: 0,
  pinnedApps: [
    { name:'Slack',   url:'https://app.slack.com' },
    { name:'Gmail',   url:'https://mail.google.com' },
    { name:'Zoom',    url:'https://zoom.us' },
    { name:'+',       url:'', isAdd:true },
    { name:'Gemini',  url:'https://gemini.google.com' },
    { name:'ChatGPT', url:'https://chat.openai.com' },
    { name:'Drive',   url:'https://drive.google.com' },
    { name:'YouTube', url:'https://youtube.com' },
  ],
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

function openSB() {
  clearTimeout(hideT);
  sb.classList.add('open');
  window.browser.sbOpen();
}
function closeSB(delay = 280) {
  clearTimeout(hideT);
  hideT = setTimeout(() => {
    sb.classList.remove('open');
    window.browser.sbClose();
  }, delay);
}

sb.addEventListener('mouseenter', () => { clearTimeout(hideT); openSB(); });
sb.addEventListener('mouseleave', e => {
  if (e.relatedTarget && trig.contains(e.relatedTarget)) return;
  closeSB(300);
});
trig.addEventListener('mouseenter', openSB);
trig.addEventListener('mouseleave', e => {
  if (e.relatedTarget && sb.contains(e.relatedTarget)) return;
  closeSB(150);
});
document.addEventListener('click', e => {
  if (!sb.contains(e.target) && !trig.contains(e.target) && !overlay.contains(e.target)
      && !document.getElementById('import-modal').contains(e.target)
      && !document.getElementById('bm2-date-modal').contains(e.target)) {
    closeSB(0);
  }
});

// ═══════════════════════════════════════════
//  スペース（ペイン）切り替え
// ═══════════════════════════════════════════
function goToSpace(idx, animated = true) {
  S.currentSpace = idx;
  if (!animated) track.style.transition = 'none';
  track.style.transform = `translateX(${-idx * 100}%)`;
  if (!animated) setTimeout(() => track.style.transition = '', 20);
  document.querySelectorAll('.sdot').forEach((d, i) => {
    d.classList.toggle('on', i === idx);
  });
}

document.querySelectorAll('.sdot').forEach(d => {
  d.addEventListener('click', () => goToSpace(+d.dataset.idx));
});

// ═══════════════════════════════════════════
//  2本指スワイプ
// ═══════════════════════════════════════════
let swipeAccum = 0;
let swipeTimer = null;

sb.addEventListener('wheel', e => {
  if (Math.abs(e.deltaX) < Math.abs(e.deltaY) * 0.5) return;
  e.preventDefault(); e.stopPropagation();
  swipeAccum += e.deltaX;
  clearTimeout(swipeTimer);
  swipeTimer = setTimeout(() => { swipeAccum = 0; }, 300);
  if (swipeAccum > 60 && S.currentSpace === 0) { swipeAccum = 0; goToSpace(1); }
  else if (swipeAccum < -60 && S.currentSpace === 1) { swipeAccum = 0; goToSpace(0); }
}, { passive: false });

let touchStartX = 0;
sb.addEventListener('touchstart', e => { touchStartX = e.touches[0].clientX; }, { passive: true });
sb.addEventListener('touchend', e => {
  const dx = e.changedTouches[0].clientX - touchStartX;
  if (dx > 60 && S.currentSpace === 1) goToSpace(0);
  if (dx < -60 && S.currentSpace === 0) goToSpace(1);
}, { passive: true });

// ═══════════════════════════════════════════
//  URL表示
// ═══════════════════════════════════════════
function updateUrl(url) {
  if (!url) { urlDisp.textContent = '新しいタブ'; return; }
  try {
    const u = new URL(url);
    urlDisp.textContent = u.hostname.replace(/^www\./, '');
  } catch { urlDisp.textContent = url.slice(0, 40); }
}

urlDisp.addEventListener('click', () => {
  overlay.classList.add('show');
  const t = S.tabs.find(x => x.id === S.active);
  urlInp.value = t?.url || '';
  setTimeout(() => { urlInp.focus(); urlInp.select(); }, 40);
});
overlay.addEventListener('click', e => { if (e.target === overlay) overlay.classList.remove('show'); });

async function commitUrl() {
  const v = urlInp.value.trim();
  overlay.classList.remove('show');
  if (!v) return;
  if (S.active) await window.browser.navigate(S.active, v);
  else await newTab(v);
}
document.getElementById('url-go-btn').addEventListener('click', commitUrl);
urlInp.addEventListener('keydown', e => {
  if (e.key === 'Enter') commitUrl();
  if (e.key === 'Escape') overlay.classList.remove('show');
});

// ═══════════════════════════════════════════
//  タブ管理
// ═══════════════════════════════════════════
async function newTab(url) {
  const id = await window.browser.createTab(url || 'https://www.google.com');
  S.tabs.push({ id, title: '読み込み中...', url: url || 'https://www.google.com', fav: null, loading: true });
  await activateTab(id);
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
}

function renderTabs() {
  const el = document.getElementById('tabs-list');
  el.innerHTML = '';
  const onlyOne = S.tabs.length <= 1;
  S.tabs.forEach(t => {
    const d = document.createElement('div');
    d.className = 'tab-item' + (t.id === S.active ? ' active' : '');
    let fav = t.fav || (t.url ? getFavicon(t.url) : '');
    const ico = t.loading ? '<div class="tab-spin"></div>'
      : fav ? `<img class="tab-fav" src="${fav}" onerror="this.outerHTML='<div class=tab-fav-ph></div>'">`
      : '<div class="tab-fav-ph"></div>';
    // タブが1つなら×ボタンを非表示
    const xStyle = onlyOne ? 'style="display:none"' : '';
    d.innerHTML = `${ico}<span class="tab-title">${esc(t.title || 'New Tab')}</span><button class="tab-x" ${xStyle}>✕</button>`;
    d.addEventListener('click', () => activateTab(t.id));
    d.querySelector('.tab-x').addEventListener('click', e => closeTab(t.id, e));
    el.appendChild(d);
  });
}

// ═══════════════════════════════════════════
//  ファビコン取得
// ═══════════════════════════════════════════
function getFavicon(url) {
  try {
    const u = new URL(url);
    return `https://www.google.com/s2/favicons?domain=${u.hostname}&sz=64`;
  } catch { return ''; }
}

// ═══════════════════════════════════════════
//  ブックマーク（スペース0）
// ═══════════════════════════════════════════
function renderBM() {
  const el = document.getElementById('bm-list');
  el.innerHTML = '';
  S.bookmarks.forEach(b => {
    const d = document.createElement('div'); d.className = 'bm-item';
    const fav = b.fav || (b.url ? getFavicon(b.url) : '');
    const ico = fav ? `<img class="bm-fav" src="${fav}" onerror="this.outerHTML='<div class=bm-fav-ph></div>'">` : '<div class="bm-fav-ph"></div>';
    d.innerHTML = `${ico}<span class="bm-name">${esc(b.name)}</span>`;
    d.addEventListener('click', () => { if (b.url) { if (S.active) window.browser.navigate(S.active, b.url); else newTab(b.url); } });
    // 右クリックで削除
    d.addEventListener('contextmenu', e => {
      e.preventDefault();
      showContextMenu(e.clientX, e.clientY, [
        { label: '削除', action: () => {
          S.bookmarks = S.bookmarks.filter(x => x.id !== b.id);
          renderBM();
        }},
      ]);
    });
    el.appendChild(d);
  });
}

document.getElementById('tb-bm-add').addEventListener('click', async () => {
  if (!S.active) return;
  const url = await window.browser.getUrl(S.active);
  if (!url) return;
  const t = S.tabs.find(x => x.id === S.active);
  S.bookmarks.push({ id: 'bm_' + Date.now(), name: (t?.title || url).slice(0, 28), url, fav: t?.fav || null });
  renderBM();
});

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
    const fav = b.fav || (b.url ? getFavicon(b.url) : '');
    const ico = fav ? `<img class="bm-fav" src="${fav}" onerror="this.outerHTML='<div class=bm-fav-ph></div>'">` : '<div class="bm-fav-ph"></div>';

    let expiryStr = '';
    if (b.expiresAt) {
      const rem = b.expiresAt - now;
      if (rem > 0) {
        const hrs = Math.floor(rem / 3600000);
        const mins = Math.floor((rem % 3600000) / 60000);
        if (hrs > 24) expiryStr = `${Math.floor(hrs/24)}日後に削除`;
        else if (hrs > 0) expiryStr = `${hrs}時間後に削除`;
        else expiryStr = `${mins}分後に削除`;
      }
    }

    d.innerHTML = `${ico}<div class="bm2-info"><span class="bm-name">${esc(b.name)}</span>${expiryStr ? `<span class="bm2-expiry">${esc(expiryStr)}</span>` : ''}</div>`;
    d.addEventListener('click', () => { if (b.url) { if (S.active) window.browser.navigate(S.active, b.url); else newTab(b.url); } });
    // 右クリックで削除
    d.addEventListener('contextmenu', e => {
      e.preventDefault();
      showContextMenu(e.clientX, e.clientY, [
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

// ブックマーク2追加ボタン
document.getElementById('bm2-add-btn').addEventListener('click', async () => {
  if (!S.active) return;
  const url = await window.browser.getUrl(S.active);
  if (!url) return;
  const t = S.tabs.find(x => x.id === S.active);
  const tempId = 'bm2_' + Date.now();
  S.bookmarks2.push({ id: tempId, name: (t?.title || url).slice(0, 28), url, fav: t?.fav || null, expiresAt: null });
  renderBM2();
  openBM2DateModal(tempId);
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
  ctxMenu.style.left = x + 'px';
  ctxMenu.style.top = y + 'px';
  document.body.appendChild(ctxMenu);
  setTimeout(() => document.addEventListener('click', removeContextMenu, { once: true }), 50);
}
function removeContextMenu() {
  if (ctxMenu) { ctxMenu.remove(); ctxMenu = null; }
}

// ═══════════════════════════════════════════
//  ピンアプリ
// ═══════════════════════════════════════════
function renderPins() {
  const el = document.getElementById('pin-grid');
  el.innerHTML = '';
  S.pinnedApps.forEach(p => {
    const d = document.createElement('div'); d.className = 'pin-item';
    let iconHtml;
    if (p.isAdd) {
      iconHtml = `<div class="pin-icon" style="font-size:22px;color:var(--text2)">+</div>`;
    } else {
      iconHtml = `<div class="pin-icon"><img src="${getFavicon(p.url)}" alt="" onerror="this.style.display='none'"></div>`;
    }
    d.innerHTML = `${iconHtml}<div class="pin-lbl">${esc(p.name)}</div>`;
    if (!p.isAdd && p.url) d.addEventListener('click', () => { if (S.active) window.browser.navigate(S.active, p.url); else newTab(p.url); });
    // ＋ボタンは新しいタブを開く
    if (p.isAdd) d.addEventListener('click', () => newTab());
    el.appendChild(d);
  });
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
document.getElementById('tb-copy').addEventListener('click', async () => {
  if (!S.active) return;
  const url = await window.browser.getUrl(S.active);
  try { await navigator.clipboard.writeText(url); } catch {}
});
document.getElementById('tidy-btn').addEventListener('click', () => {
  S.tabs.sort((a, b) => a.title.localeCompare(b.title, 'ja')); renderTabs();
});
document.getElementById('clear-btn').addEventListener('click', async () => {
  for (const t of [...S.tabs]) await window.browser.closeTab(t.id);
  S.tabs = []; S.active = null; updateUrl(''); renderTabs(); newTab();
});

// ═══════════════════════════════════════════
//  テーマ
// ═══════════════════════════════════════════
document.getElementById('nb-theme').addEventListener('click', () => {
  S.dark = !S.dark;
  document.documentElement.setAttribute('data-theme', S.dark ? 'dark' : 'light');
  document.getElementById('ico-m').style.display = S.dark ? 'none' : '';
  document.getElementById('ico-s').style.display = S.dark ? '' : 'none';
});

// ═══════════════════════════════════════════
//  IPC
// ═══════════════════════════════════════════
window.browser.onNavigate(d => {
  const t = S.tabs.find(x => x.id === d.id);
  if (t) {
    t.url = d.url;
    if (d.title) t.title = d.title;
    if (d.id === S.active) updateUrl(d.url);
    renderTabs(); updateNav();
  }
});
window.browser.onTitle(({ id, title }) => { const t = S.tabs.find(x => x.id === id); if (t) { t.title = title; renderTabs(); } });
window.browser.onFavicon(({ id, favicon }) => { const t = S.tabs.find(x => x.id === id); if (t) { t.fav = favicon; renderTabs(); } });
window.browser.onLoading(({ id, loading }) => { const t = S.tabs.find(x => x.id === id); if (t) { t.loading = loading; renderTabs(); } });
window.browser.onOpenUrl(url => newTab(url));

// アップデート通知
window.browser.onUpdateAvailable(({ version }) => {
  const bar = document.getElementById('update-bar');
  if (bar) {
    document.getElementById('update-version').textContent = version;
    bar.style.display = 'flex';
  }
});
window.browser.onUpdateDownloaded(({ version }) => {
  const bar = document.getElementById('update-bar');
  if (bar) {
    bar.querySelector('.update-msg').textContent = `v${version} ダウンロード完了 — 再起動してインストール`;
    document.getElementById('update-install-btn').style.display = '';
  }
});
document.getElementById('update-install-btn')?.addEventListener('click', () => {
  window.browser.installUpdate();
});
document.getElementById('update-bar-close')?.addEventListener('click', () => {
  document.getElementById('update-bar').style.display = 'none';
});

// ═══════════════════════════════════════════
//  キーボード
// ═══════════════════════════════════════════
document.addEventListener('keydown', e => {
  const m = e.metaKey || e.ctrlKey;
  if (m && e.key === 't') { e.preventDefault(); newTab(); }
  if (m && e.key === 'w') { e.preventDefault(); if (S.active) closeTab(S.active); }
  if (m && e.key === 'l') { e.preventDefault(); openSB(); overlay.classList.add('show'); setTimeout(() => { urlInp.focus(); urlInp.select(); }, 40); }
  if (m && e.key === 'r') { e.preventDefault(); if (S.active) window.browser.reload(S.active); }
  if (m && e.key === '[') { e.preventDefault(); if (S.active) window.browser.back(S.active); }
  if (m && e.key === ']') { e.preventDefault(); if (S.active) window.browser.forward(S.active); }
  if (m && e.key >= '1' && e.key <= '9') { const i = +e.key - 1; if (S.tabs[i]) activateTab(S.tabs[i].id); }
});

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
  btn.disabled = true; btn.textContent = 'インポート中...';
  const res = await window.browser.importBookmarks(selectedBrowser);
  const resEl = document.getElementById('import-result');
  if (res.error) {
    resEl.textContent = 'エラー: ' + res.error; resEl.classList.add('show');
  } else {
    (res.bookmarks||[]).slice(0,50).forEach(b => {
      S.bookmarks.push({ id:'imp_'+Date.now()+Math.random(), name:b.name.slice(0,28), url:b.url, fav:null });
    });
    renderBM();
    resEl.textContent = `✓ ${(res.bookmarks||[]).length}件のブックマークをインポートしました`;
    resEl.classList.add('show');
    setTimeout(() => importModal.classList.remove('show'), 1800);
  }
  btn.disabled = false; btn.textContent = 'インポート';
});
document.getElementById('import-cancel').addEventListener('click', () => importModal.classList.remove('show'));
importModal.addEventListener('click', e => { if (e.target===importModal) importModal.classList.remove('show'); });
document.getElementById('google-signin-btn').addEventListener('click', () => {
  importModal.classList.remove('show');
  newTab('https://accounts.google.com/signin/chrome/sync');
});
document.getElementById('btn-settings').addEventListener('click', openImportModal);

// ═══════════════════════════════════════════
//  初期化
// ═══════════════════════════════════════════
renderPins();
renderBM();
renderBM2();
renderTabs();
goToSpace(0, false);

window.browser.onReady(() => newTab('https://www.google.com'));
