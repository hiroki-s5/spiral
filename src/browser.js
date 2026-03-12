// ═══════════════════════════════════════════
//  状態
// ═══════════════════════════════════════════
const S = {
  tabs: [], active: null, dark: false,
  bookmarks: [],      // スペース0のブックマーク
  bookmarks2: [],     // スペース1のブックマーク（日時指定で消える）
  currentSpace: 0,
  // ワークスペース
  workspaces: [
    { id: 'ws0', name: 'メイン', avatar: 'S', color: '#3478f6', accountEmail: '', tabs: [], bookmarks: [] },
  ],
  activeWorkspace: 0,
  pinnedApps: [
    { name:'Slack',   url:'https://app.slack.com' },
    { name:'Gmail',   url:'https://mail.google.com' },
    { name:'Zoom',    url:'https://zoom.us' },
    { name:'Classroom', url:'https://classroom.google.com', isAdd:false },
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

function isModalOpen() {
  return document.getElementById('import-modal').classList.contains('show')
      || document.getElementById('bm2-date-modal').classList.contains('show')
      || document.getElementById('bm1-add-modal').classList.contains('show')
      || document.getElementById('notif-modal').classList.contains('show')
      || document.getElementById('history-modal').classList.contains('show')
      || document.getElementById('download-modal').classList.contains('show')
      || document.getElementById('bm-edit-modal').classList.contains('show')
      || document.getElementById('workspace-modal').classList.contains('show')
      || overlay.classList.contains('show');
}

sb.addEventListener('mouseenter', () => { clearTimeout(hideT); openSB(); });
sb.addEventListener('mouseleave', e => {
  if (isModalOpen()) return; // モーダル開いてる間は閉じない
  if (e.relatedTarget && trig.contains(e.relatedTarget)) return;
  closeSB(300);
});
trig.addEventListener('mouseenter', openSB);
trig.addEventListener('mouseleave', e => {
  if (isModalOpen()) return;
  if (e.relatedTarget && sb.contains(e.relatedTarget)) return;
  closeSB(150);
});
document.addEventListener('click', e => {
  if (isModalOpen()) return;
  if (!sb.contains(e.target) && !trig.contains(e.target)) {
    closeSB(0);
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
  if (Math.abs(e.deltaX) < Math.abs(e.deltaY) * 0.5) return;
  e.preventDefault(); e.stopPropagation();
  swipeAccum += e.deltaX;
  clearTimeout(swipeTimer);
  swipeTimer = setTimeout(() => { swipeAccum = 0; }, 300);
  if (swipeAccum > 60 && S.activeWorkspace < S.workspaces.length - 1) {
    swipeAccum = 0; switchWorkspace(S.activeWorkspace + 1);
  } else if (swipeAccum < -60 && S.activeWorkspace > 0) {
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
    // 右クリックで削除・編集
    d.addEventListener('contextmenu', e => {
      e.preventDefault();
      showContextMenu(e.clientX, e.clientY, [
        { label: '編集', action: () => openBmEditModal(b, 'bm1') },
        { label: '削除', action: () => {
          S.bookmarks = S.bookmarks.filter(x => x.id !== b.id);
          renderBM();
        }},
      ]);
    });
    el.appendChild(d);
  });
}

// tb-bm-add removed

// ブックマーク１ ＋ボタン → 名前・URL入力モーダル
document.getElementById('bm1-plus-btn').addEventListener('click', () => {
  const modal = document.getElementById('bm1-add-modal');
  document.getElementById('bm1-name-input').value = '';
  document.getElementById('bm1-url-input').value = '';
  modal.classList.add('show');
  setTimeout(() => document.getElementById('bm1-name-input').focus(), 40);
});

document.getElementById('bm1-modal-confirm').addEventListener('click', () => {
  const name = document.getElementById('bm1-name-input').value.trim();
  const url  = document.getElementById('bm1-url-input').value.trim();
  if (!url) return;
  let u = url;
  if (!u.startsWith('http://') && !u.startsWith('https://')) u = 'https://' + u;
  S.bookmarks.push({ id: 'bm_' + Date.now(), name: (name || u).slice(0, 32), url: u, fav: null });
  renderBM();
  document.getElementById('bm1-add-modal').classList.remove('show');
});

document.getElementById('bm1-modal-cancel').addEventListener('click', () => {
  document.getElementById('bm1-add-modal').classList.remove('show');
});

// Enterキーでも確定
document.getElementById('bm1-url-input').addEventListener('keydown', e => {
  if (e.key === 'Enter') document.getElementById('bm1-modal-confirm').click();
  if (e.key === 'Escape') document.getElementById('bm1-add-modal').classList.remove('show');
});
document.getElementById('bm1-name-input').addEventListener('keydown', e => {
  if (e.key === 'Escape') document.getElementById('bm1-add-modal').classList.remove('show');
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
  S.bookmarks2.push({ id: 'bm2_' + Date.now(), name: (t?.title || url).slice(0, 32), url, fav: t?.fav || null, expiresAt });
  renderBM2();
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
  S.pinnedApps.forEach((p, idx) => {
    const d = document.createElement('div'); d.className = 'pin-item';
    let iconHtml;
    if (p.isAdd) {
      iconHtml = `<div class="pin-icon" style="font-size:22px;color:var(--text2)">+</div>`;
    } else {
      iconHtml = `<div class="pin-icon"><img src="${getFavicon(p.url)}" alt="" onerror="this.style.display='none'"></div>`;
    }
    d.innerHTML = `${iconHtml}<div class="pin-lbl">${esc(p.name)}</div>`;
    if (!p.isAdd && p.url) d.addEventListener('click', () => { if (S.active) window.browser.navigate(S.active, p.url); else newTab(p.url); });
    if (p.isAdd) d.addEventListener('click', () => newTab());
    // 右クリックで編集・削除
    if (!p.isAdd) {
      d.addEventListener('contextmenu', e => {
        e.preventDefault();
        showContextMenu(e.clientX, e.clientY, [
          { label: '編集', action: () => openPinEditModal(idx) },
          { label: '削除', action: () => { S.pinnedApps.splice(idx, 1); renderPins(); } },
        ]);
      });
    }
    el.appendChild(d);
  });
}

function openPinEditModal(idx) {
  const p = S.pinnedApps[idx];
  const modal = document.getElementById('bm1-add-modal');
  document.getElementById('bm1-modal-title').textContent = 'アプリを編集';
  document.getElementById('bm1-name-input').value = p.name || '';
  document.getElementById('bm1-url-input').value  = p.url  || '';
  modal.classList.add('show');
  setTimeout(() => document.getElementById('bm1-name-input').focus(), 40);

  document.getElementById('bm1-modal-confirm').onclick = () => {
    const name = document.getElementById('bm1-name-input').value.trim();
    const url  = document.getElementById('bm1-url-input').value.trim();
    if (!url) return;
    let u = url;
    if (!u.startsWith('http://') && !u.startsWith('https://')) u = 'https://' + u;
    S.pinnedApps[idx].name = (name || u).slice(0, 20);
    S.pinnedApps[idx].url  = u;
    renderPins();
    modal.classList.remove('show');
    // ボタンのonclickを元に戻す
    document.getElementById('bm1-modal-confirm').onclick = null;
    document.getElementById('bm1-modal-title').textContent = 'ブックマークを追加';
  };
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

// ── アップデート確認ボタン
document.getElementById('btn-check-update').addEventListener('click', async () => {
  const btn = document.getElementById('btn-check-update');
  btn.style.animation = 'sp .65s linear infinite';
  btn.disabled = true;
  await window.browser.checkUpdate();
  setTimeout(() => {
    btn.style.animation = '';
    btn.disabled = false;
  }, 3000);
});

window.browser.onUpdateNotAvailable(() => {
  const btn = document.getElementById('btn-check-update');
  if (btn) { btn.style.animation = ''; btn.disabled = false; }
  // 最新版である旨をアップデートバーで表示
  const bar = document.getElementById('update-bar');
  if (bar) {
    bar.querySelector('.update-msg').textContent = '最新バージョンです';
    document.getElementById('update-install-btn').style.display = 'none';
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
// モーダル外クリックでは閉じない（マウス移動で誤って閉じるのを防ぐ）
// Google signin removed
document.getElementById('btn-settings').addEventListener('click', () => { openSB(); openImportModal(); });

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
//  初期化
// ═══════════════════════════════════════════
renderPins();
renderBM();
renderBM2();
renderTabs();
goToSpace(0, false);

window.browser.onReady(() => newTab('https://www.google.com'));

// ═══════════════════════════════════════════
//  通知設定
// ═══════════════════════════════════════════
let notifSettings = null;

const APP_ICONS = {
  gmail:   'https://www.google.com/s2/favicons?domain=mail.google.com&sz=64',
  slack:   'https://www.google.com/s2/favicons?domain=app.slack.com&sz=64',
  discord: 'https://www.google.com/s2/favicons?domain=discord.com&sz=64',
  chatgpt: 'https://www.google.com/s2/favicons?domain=chat.openai.com&sz=64',
  youtube: 'https://www.google.com/s2/favicons?domain=youtube.com&sz=64',
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
    item.innerHTML = `
      <img class="notif-app-icon" src="${APP_ICONS[key] || ''}" onerror="this.style.display='none'">
      <span class="notif-app-lbl">${app.label}</span>
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

document.getElementById('btn-notif').addEventListener('click', openNotifModal);

// 通知設定を受信
window.browser.onNotifSettings(settings => {
  notifSettings = settings;
});

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
    if (type === 'bm1') renderBM();
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
}

function switchWorkspace(idx) {
  // 現在のタブ・ブックマーク状態を保存
  S.workspaces[S.activeWorkspace].tabs = S.tabs.map(t => ({ ...t }));
  S.workspaces[S.activeWorkspace].bookmarks = [...S.bookmarks];

  S.activeWorkspace = idx;
  const ws = S.workspaces[idx];

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

  // ワークスペース0以外 && 未ログインならログイン画面を表示
  if (idx > 0 && !ws.loggedInEmail) {
    showWorkspaceLogin(idx);
    return;
  }

  // UIを表示してタブ復元
  showWorkspaceUI();

  // タブを全て閉じて新しいワークスペースのタブを復元
  Promise.all([...S.tabs].map(t => window.browser.closeTab(t.id))).then(() => {
    S.tabs = []; S.active = null; updateUrl(''); renderTabs();
    const savedTabs = ws.tabs || [];
    if (savedTabs.length) {
      (async () => {
        for (const t of savedTabs) {
          const id = await window.browser.createTab(t.url);
          S.tabs.push({ id, title: t.title || '読み込み中...', url: t.url, fav: t.fav, loading: true });
        }
        await activateTab(S.tabs[0].id);
      })();
    } else {
      newTab('https://www.google.com');
    }
  });
}

function showWorkspaceLogin(wsIdx) {
  const ws = S.workspaces[wsIdx];
  // メインUIを隠してログイン画面を表示
  document.getElementById('ws-login-screen').style.display = 'flex';
  document.getElementById('ws-main-ui').style.display = 'none';

  const msg = document.getElementById('ws-login-msg');
  msg.textContent = `「${ws.name}」にGoogleアカウントでログインしてください`;

  document.getElementById('ws-login-btn').onclick = () => {
    // Googleログインページをタブで開く
    const loginUrl = 'https://accounts.google.com/signin';
    Promise.all([...S.tabs].map(t => window.browser.closeTab(t.id))).then(async () => {
      S.tabs = []; S.active = null; updateUrl(''); renderTabs();
      const id = await window.browser.createTab(loginUrl);
      S.tabs.push({ id, title: 'Googleログイン', url: loginUrl, fav: null, loading: true });
      await activateTab(id);
    });
    // ログイン検知：myaccount.google.com か mail.google.com に遷移したらログイン完了とみなす
    startLoginWatcher(wsIdx);
  };
}

let loginWatcherTimer = null;
function startLoginWatcher(wsIdx) {
  clearInterval(loginWatcherTimer);
  loginWatcherTimer = setInterval(async () => {
    if (!S.active) return;
    const url = await window.browser.getUrl(S.active);
    // Googleアカウントページ or Gmailに到達したらログイン完了
    if (url && (
      url.includes('myaccount.google.com') ||
      url.includes('mail.google.com') ||
      (url.includes('google.com') && !url.includes('accounts.google.com') && !url.includes('signin'))
    )) {
      clearInterval(loginWatcherTimer);
      const ws = S.workspaces[wsIdx];
      ws.loggedInEmail = url;

      // タイトルからアカウント名取得を試みる
      const activeTab = S.tabs.find(t => t.id === S.active);
      if (activeTab?.title && !activeTab.title.includes('ログイン') && !activeTab.title.includes('Sign in')) {
        ws.name = ws.name; // 変えない
      }

      // アバター表示をGアイコンに
      const avatar = document.getElementById('acct-avatar-0');
      if (avatar) {
        avatar.innerHTML = `<img src="https://www.google.com/s2/favicons?domain=google.com&sz=64" style="width:18px;height:18px;object-fit:contain;">`;
        avatar.style.background = '#fff';
      }

      showWorkspaceUI();
      renderWorkspaceBar();
    }
  }, 1500);
}

function showWorkspaceUI() {
  const loginScreen = document.getElementById('ws-login-screen');
  const mainUI = document.getElementById('ws-main-ui');
  if (loginScreen) loginScreen.style.display = 'none';
  if (mainUI) mainUI.style.display = 'flex';
}

function deleteWorkspace(idx) {
  if (S.workspaces.length <= 1) return;
  S.workspaces.splice(idx, 1);
  const newIdx = Math.min(idx, S.workspaces.length - 1);
  S.activeWorkspace = -1; // force switch
  switchWorkspace(newIdx);
}

function openWorkspaceModal(idx) {
  const modal = document.getElementById('workspace-modal');
  const isNew = idx === -1;
  const ws = isNew ? { name: '', avatar: '🌐', color: '#3478f6', accountEmail: '' } : S.workspaces[idx];

  document.getElementById('ws-modal-title').textContent = isNew ? 'ワークスペースを追加' : 'ワークスペースを編集';
  document.getElementById('ws-name-input').value  = ws.name;

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

  modal.classList.add('show');

  document.getElementById('ws-modal-confirm').onclick = () => {
    const name = document.getElementById('ws-name-input').value.trim() || 'ワークスペース';
    const color = ws.color;
    const avatar = name[0].toUpperCase();

    if (isNew) {
      S.workspaces.push({ id: 'ws' + Date.now(), name, avatar, color, loggedInEmail: null, tabs: [], bookmarks: [] });
    } else {
      S.workspaces[idx].name  = name;
      S.workspaces[idx].avatar = avatar;
      S.workspaces[idx].color = color;
      // 現在のワークスペースなら表示も更新
      if (idx === S.activeWorkspace) {
        const av = document.getElementById('acct-avatar-0');
        const nm = document.getElementById('acct-name-0');
        if (av) { av.textContent = avatar; av.style.borderColor = color; av.style.color = color; av.style.background = color+'22'; }
        if (nm) nm.textContent = name;
      }
    }
    renderWorkspaceBar();
    modal.classList.remove('show');
  };
  document.getElementById('ws-modal-cancel').onclick = () => modal.classList.remove('show');
}

// ワークスペースバーをスペースドットの上に追加
document.addEventListener('DOMContentLoaded', () => {});
renderWorkspaceBar();


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
    const favicon = h.url ? `https://www.google.com/s2/favicons?domain=${encodeURIComponent(new URL(h.url).hostname)}&sz=32` : '';
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
    const stateLabel = d.state === 'completed' ? '✓' : d.state === 'cancelled' ? '✕' : '…';
    const stateColor = d.state === 'completed' ? '#4caf50' : d.state === 'cancelled' ? '#f44336' : 'var(--text2)';
    const size = d.totalBytes > 0 ? (d.totalBytes > 1048576 ? `${(d.totalBytes/1048576).toFixed(1)} MB` : `${(d.totalBytes/1024).toFixed(0)} KB`) : '';
    item.innerHTML = `<div style="font-size:18px;color:${stateColor};flex-shrink:0;width:18px;text-align:center">${stateLabel}</div><div class="history-item-info"><div class="history-item-title">${esc(d.filename||'')}</div><div class="history-item-url">${esc(d.url||'')}${size?' · '+size:''}</div></div><div class="history-item-time">${formatTime(d.startedAt)}</div>`;
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
window.browser.onDownloadDone(entry => { downloadData.unshift(entry); });
