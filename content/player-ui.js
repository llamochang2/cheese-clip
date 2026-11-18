// 치지직 화면 안 조작: 재생바 버튼(스크린샷·녹화)과 키 하나짜리 단축키
//   재생바를 찾으면 그 안에 버튼을 넣고, 못 찾으면 영상 위 오른쪽 아래에 떠 있는 버튼을 씀
//   키 단축키는 이 탭을 보고 있을 때만 작동 (입력창에 쓰는 중이거나 Ctrl·Alt와 함께 누르면 무시)
(() => {
  'use strict';
  if (window.__chzzkClipPlayerUi) return;
  window.__chzzkClipPlayerUi = true;

  const DEFAULTS = globalThis.CHZZK_CLIP_DEFAULTS;
  const shared = () => globalThis.__chzzkClipShared;
  const vclip = () => globalThis.__chzzkVideoClip;
  let cfg = { pageKeyShot: DEFAULTS.pageKeyShot, pageKeyRec: DEFAULTS.pageKeyRec, playerButtons: DEFAULTS.playerButtons };

  chrome.storage.sync.get(cfg).then(s => { cfg = s; refresh(); });
  chrome.storage.onChanged.addListener((ch, area) => {
    if (area !== 'sync') return;
    let hit = false;
    for (const k of Object.keys(cfg)) if (ch[k]) { cfg[k] = ch[k].newValue; hit = true; }
    if (hit) refresh();
  });

  const shot = () => { const s = shared(); if (s && s.screenshot) s.screenshot(); };
  const rec = () => { const v = vclip(); if (v && v.toggleRec) v.toggleRec(); };
  const recording = () => { const v = vclip(); return !!(v && v.isRecording && v.isRecording()); };
  const videoOn = () => { const s = shared(); return !!(s && s.getChannel().video); };

  // ── 키 하나 단축키 ──
  const typing = el => {
    for (let e = el; e; e = e.parentElement || (e.getRootNode && e.getRootNode().host)) {
      if (e.isContentEditable) return true;
      const t = e.tagName;
      if (t === 'INPUT' || t === 'TEXTAREA' || t === 'SELECT') return true;
    }
    return false;
  };
  window.addEventListener('keydown', e => {
    if (e.repeat || e.ctrlKey || e.altKey || e.metaKey || e.isComposing) return;
    const act = e.code && e.code === cfg.pageKeyShot ? shot : e.code && e.code === cfg.pageKeyRec ? rec : null;
    if (!act) return;
    if (typing(e.composedPath()[0] || document.activeElement)) return;
    if (!(shared() && shared().getVideo())) return;
    e.preventDefault();
    e.stopImmediatePropagation(); // 플레이어의 같은 키 동작보다 먼저
    act();
  }, true);

  // ── 버튼 ──
  const keyLabel = code => !code ? '' : code.replace(/^Key/, '').replace(/^Digit/, '').replace(/^Numpad/, '숫자판 ');
  const ICON_SHOT = '<svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linejoin="round"><path d="M4 8.5A1.5 1.5 0 0 1 5.5 7h2.2l1.4-2h5.8l1.4 2h2.2A1.5 1.5 0 0 1 20 8.5v9a1.5 1.5 0 0 1-1.5 1.5h-13A1.5 1.5 0 0 1 4 17.5z"/><circle cx="12" cy="12.8" r="3.4"/></svg>';
  const ICON_REC = '<svg viewBox="0 0 24 24" width="22" height="22"><circle cx="12" cy="12" r="6.5" fill="none" stroke="currentColor" stroke-width="1.9"/><circle class="dot" cx="12" cy="12" r="3.6" fill="currentColor"/></svg>';
  const STYLE = `
    .cc-btn { display: inline-flex; align-items: center; justify-content: center; width: 40px; height: 40px; padding: 0;
              border: 0; background: transparent; color: #fff; cursor: pointer; flex: none; }
    .cc-btn.on { color: #ff4d4d; }
    .cc-btn.on .dot { animation: cc-blink 1s steps(2, start) infinite; }
    @keyframes cc-blink { to { visibility: hidden; } }`;

  function makeButtons() {
    shared_ = []; // 새 버튼에는 아직 클래스가 없음
    const s = document.createElement('button');
    s.type = 'button'; s.className = 'cc-btn cc-shot'; s.innerHTML = ICON_SHOT;
    s.addEventListener('click', e => { e.preventDefault(); e.stopPropagation(); shot(); });
    const r = document.createElement('button');
    r.type = 'button'; r.className = 'cc-btn cc-rec'; r.innerHTML = ICON_REC;
    r.addEventListener('click', e => { e.preventDefault(); e.stopPropagation(); rec(); setTimeout(paint, 200); });
    return [s, r];
  }
  let btns = null;     // [스크린샷, 녹화]
  let float = null;    // 떠 있는 버튼 (재생바를 못 찾았을 때)
  let barStyle = null; // 재생바에 넣을 때 쓰는 style

  function paint() {
    if (!btns) return;
    const [s, r] = btns;
    const k1 = keyLabel(cfg.pageKeyShot), k2 = keyLabel(cfg.pageKeyRec);
    s.title = s.ariaLabel = '스크린샷' + (k1 ? ` (${k1})` : '');
    r.hidden = !videoOn();
    const on = recording();
    r.classList.toggle('on', on);
    r.title = r.ariaLabel = (on ? '녹화 종료' : '녹화 시작') + (k2 ? ` (${k2})` : '');
  }

  // 재생바 찾기: 치지직 플레이어(pzp)의 오른쪽 버튼 묶음 → 없으면 전체화면 버튼이 있는 줄
  function findBar(video) {
    const root = video.closest('[class*="pzp"]') || video.parentElement && video.parentElement.parentElement || document;
    const bar = root.querySelector('[class*="bottom-buttons-right"]') || document.querySelector('.pzp-pc__bottom-buttons-right');
    if (bar) return bar;
    const scope = root === document ? document : root;
    for (const b of scope.querySelectorAll('button[aria-label], button[title]')) {
      const label = (b.getAttribute('aria-label') || '') + ' ' + (b.getAttribute('title') || '');
      if (/전체\s*화면|fullscreen/i.test(label) && b.parentElement) return b.parentElement;
    }
    return null;
  }

  function placeInBar(bar) {
    if (float) { float.host.remove(); float = null; }
    if (!barStyle) {
      barStyle = document.createElement('style');
      barStyle.textContent = STYLE;
    }
    if (!barStyle.isConnected) (document.head || document.documentElement).appendChild(barStyle);
    if (!btns) btns = makeButtons();
    if (btns[0].parentNode !== bar || bar.firstChild !== btns[0]) bar.prepend(btns[0], btns[1]);
    inBar = bar;
    adoptBarClass(bar);
  }

  // 재생바가 숨을 때 같이 숨기: 치지직 버튼들이 공통으로 쓰는 클래스를 확장 버튼에도 붙임
  //   치지직은 재생바를 숨길 때 버튼마다 그 클래스로 투명하게 만듦
  let inBar = null, shared_ = [];
  function adoptBarClass(bar) {
    const own = [...bar.children].filter(el => el.tagName === 'BUTTON' && !el.classList.contains('cc-btn'));
    let common = own.length >= 2 ? [...own[0].classList] : [];
    for (const el of own.slice(1)) common = common.filter(c => el.classList.contains(c));
    if (common.join(' ') === shared_.join(' ')) return;
    for (const b of btns) { b.classList.remove(...shared_); b.classList.add(...common); }
    shared_ = common;
  }

  function placeFloating(video) {
    inBar = null;
    if (!float) {
      const host = document.createElement('div');
      host.attachShadow({ mode: 'open' }).innerHTML = `<style>${STYLE}
        .wrap { position: fixed; z-index: 2147483646; display: flex; gap: 4px; padding: 2px; border-radius: 22px;
                background: rgba(0,0,0,.55); opacity: 0; transition: opacity .2s; pointer-events: none; }
        .wrap.show { opacity: 1; pointer-events: auto; }</style><div class="wrap"></div>`;
      if (btns) btns.forEach(b => b.remove());
      btns = makeButtons();
      host.shadowRoot.querySelector('.wrap').append(...btns);
      float = { host, wrap: host.shadowRoot.querySelector('.wrap'), timer: null };
      // 영상 위에서 마우스를 움직이면 잠시 표시
      const show = () => {
        float.wrap.classList.add('show');
        clearTimeout(float.timer);
        float.timer = setTimeout(() => float && float.wrap.classList.remove('show'), 2500);
      };
      float.show = show;
      document.addEventListener('mousemove', e => {
        const v = shared() && shared().getVideo();
        if (!float || !v) return;
        const r = v.getBoundingClientRect();
        if (e.clientX >= r.left && e.clientX <= r.right && e.clientY >= r.top && e.clientY <= r.bottom) show();
      }, { passive: true });
    }
    const parent = document.fullscreenElement || document.body || document.documentElement;
    if (float.host.parentNode !== parent) parent.appendChild(float.host);
    const r = video.getBoundingClientRect();
    Object.assign(float.wrap.style, { right: Math.max(8, window.innerWidth - r.right + 12) + 'px', bottom: Math.max(8, window.innerHeight - r.bottom + 64) + 'px' });
    if (recording()) float.show(); // 녹화 중에는 계속 보이게
  }

  function removeAll() {
    if (btns) btns.forEach(b => b.remove());
    if (float) { float.host.remove(); float = null; btns = null; }
  }

  function refresh() {
    const s = shared();
    const video = s && s.getVideo();
    if (!cfg.playerButtons || !video || !video.isConnected) { removeAll(); return; }
    const bar = findBar(video);
    if (bar) placeInBar(bar); else placeFloating(video);
    paint();
  }

  setInterval(refresh, 1000);
  document.addEventListener('fullscreenchange', () => setTimeout(refresh, 50));
})();
