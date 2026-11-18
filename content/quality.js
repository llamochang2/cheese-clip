// 플레이어 화질 고정: WebP나 영상을 켠 채널에서 1080p(없으면 가장 높은 화질)로 맞추고, 내려가면 다시 올림
(() => {
  'use strict';
  if (window.__chzzkClipQuality) return;
  window.__chzzkClipQuality = true;

  const ITEM = 'li.pzp-ui-setting-quality-item';
  const CHECKED = 'pzp-ui-setting-pane-item--checked';
  const TARGET = 1080;
  const CHECK_MS = 5000;     // 확인 주기
  const COOLDOWN_MS = 15000; // 다시 바꾸기까지 최소 간격

  const shared = () => globalThis.__chzzkClipShared;
  let enabled = globalThis.CHZZK_CLIP_DEFAULTS.lockQuality;
  let lastApply = 0;

  chrome.storage.sync.get({ lockQuality: enabled }).then(s => { enabled = s.lockQuality; check(); });
  chrome.storage.onChanged.addListener((ch, area) => {
    if (area === 'sync' && ch.lockQuality) { enabled = ch.lockQuality.newValue; lastApply = 0; check(); }
  });

  const label = el => (el.textContent || '').replace(/\s+/g, ' ').trim();
  const heightOf = text => (/^(\d{3,4})p/.exec(text) || [])[1] | 0; // '자동'은 0

  // 목표 항목: 1080p로 시작하는 항목, 없으면 해상도가 가장 높은 항목
  function pick(items) {
    let best = null;
    for (const el of items) {
      const t = label(el);
      if (t.startsWith(TARGET + 'p')) return el;
      const h = heightOf(t);
      if (h && (!best || h > heightOf(label(best)))) best = el;
    }
    return best;
  }

  // 치지직 화질 항목은 클릭이 아니라 Enter 키 입력으로 바뀜 (메뉴를 열지 않아도 됨)
  function activate(el) {
    el.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', bubbles: true, cancelable: true }));
    setTimeout(() => { if (el.isConnected && !el.classList.contains(CHECKED)) el.click(); }, 250);
  }

  const adPlaying = () => !!document.querySelector('button.btn_skip, a.btn_advertiser');

  function check() {
    const s = shared();
    if (!enabled || !s || !s.getVideo() || adPlaying()) return;
    const ch = s.getChannel();
    if (!ch.id || !(ch.gif || ch.video)) return;
    const items = [...document.querySelectorAll(ITEM)];
    if (!items.length) return;
    const target = pick(items);
    if (!target || target.classList.contains(CHECKED)) return;
    // 같은 이름의 항목이 여러 개일 때(중복 목록) 이미 선택된 것이면 그대로 둠
    const current = items.find(el => el.classList.contains(CHECKED));
    if (current && label(current) === label(target)) return;
    if (Date.now() - lastApply < COOLDOWN_MS) return;
    lastApply = Date.now();
    activate(target);
  }

  setInterval(check, CHECK_MS);
  setTimeout(check, 1500);
})();
