// ═══════════════════════════════════════════════════════════════
//  Spiral AI – DLリネーム機能のみ（パネルUIは別ウィンドウに移行）
// ═══════════════════════════════════════════════════════════════

const GROQ_MODEL = 'llama-3.3-70b-versatile';
const STORAGE_KEY = 'spiral-ai-groq-key';

function getApiKey() {
  try { return localStorage.getItem(STORAGE_KEY) || ''; } catch { return ''; }
}

async function groqCall(userPrompt, systemPrompt) {
  const messages = [];
  if (systemPrompt) messages.push({ role: 'system', content: systemPrompt });
  messages.push({ role: 'user', content: userPrompt });
  const res = await fetch('https://api.groq.com/openai/v1/chat/completions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${getApiKey()}` },
    body: JSON.stringify({ model: GROQ_MODEL, messages, max_tokens: 256, temperature: 0.3 }),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const data = await res.json();
  return data?.choices?.[0]?.message?.content || '';
}

function hookDownloadRename() {
  window.browser.onDownloadDone(async (entry) => {
    try {
      const name = await groqCall(
        `元のファイル名: ${entry.filename}\nURL: ${entry.url || ''}`,
        'ダウンロードファイルの分かりやすい名前を提案。拡張子変えない。半角英数字・日本語・ハイフン・アンダースコアのみ。スペース不可。最大40文字。ファイル名のみ返す。'
      );
      const clean = name.trim().replace(/\s+/g,'_').replace(/[<>:"/\\|?*]/g,'');
      if (clean && clean !== entry.filename) {
        entry.aiName = clean;
        if (typeof renderDownloadList === 'function' &&
            document.getElementById('download-modal')?.classList.contains('show')) {
          renderDownloadList();
        }
      }
    } catch {}
  });
}

// ── AIボタンのスタイル ────────────────────────────────────────
function initAIStyle() {
  const s = document.createElement('style');
  s.textContent = `
#btn-ai { font-weight: 700; font-size: 11px; color: var(--accent); }
#btn-ai.active { background: var(--accent); color: #fff; border-radius: 7px; }
.ai-rename-badge {
  display: inline-block; background: var(--accent); color: #fff;
  font-size: 10px; font-weight: 600; padding: 2px 7px;
  border-radius: 10px; cursor: pointer; margin-left: 6px; vertical-align: middle;
}
.ai-rename-badge:hover { opacity: 0.8; }
`;
  document.head.appendChild(s);
}

window.spiralAI = {
  init: initAIStyle,
  hookDownloadRename,
  trySmartTitle: () => {},
  isOpen: () => false,
};
