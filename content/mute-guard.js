// 음소거 대체 (페이지 쪽에서 실행: world MAIN)
// 치지직 플레이어가 영상 요소를 음소거(muted / 볼륨 0)하면 복사하는 소리까지 사라집니다.
// 영상 저장이 켜진 영상(data-chzzk-clip 표시)에 한해, 플레이어의 음소거를 가로채
//   - 플레이어에는 음소거된 것처럼 보이게 하고 (muted·volume 값은 플레이어가 정한 그대로 돌려줌)
//   - 실제 소리 끄기는 크롬 탭 음소거로 대신합니다 (탭 음소거는 녹음에 영향 없음)
// 탭 음소거가 확인된 뒤에만 영상의 실제 소리를 켭니다 (스피커로 소리가 새지 않게).
(() => {
  'use strict';
  if (window.__chzzkClipMuteGuard) return;
  window.__chzzkClipMuteGuard = true;

  const P = HTMLMediaElement.prototype;
  const dM = Object.getOwnPropertyDescriptor(P, 'muted');
  const dV = Object.getOwnPropertyDescriptor(P, 'volume');
  if (!dM || !dV || !dM.set || !dV.set) return;

  let active = false;      // 이 채널의 영상 저장이 켜져 있을 때만
  let tabMuted = false;    // 확장이 탭을 음소거한 상태
  const st = new WeakMap(); // 영상 → 플레이어가 정한 값 { muted, volume, last }
  const targets = new Set();

  const isTarget = el => active && el instanceof HTMLMediaElement && el.hasAttribute('data-chzzk-clip');
  const realMuted = el => dM.get.call(el);
  const realVolume = el => dV.get.call(el);

  function ensure(el) {
    let s = st.get(el);
    if (!s) {
      s = { muted: realMuted(el), volume: realVolume(el), last: realVolume(el) || 1 };
      st.set(el, s);
      targets.add(el);
    }
    return s;
  }
  const wantsSilence = s => s.muted || s.volume === 0;

  // 플레이어가 정한 값을 실제 영상에 반영
  function apply(el) {
    const s = st.get(el);
    if (!s) return;
    if (s.volume > 0) s.last = s.volume;
    if (wantsSilence(s)) {
      if (tabMuted) {
        // 탭이 음소거된 상태 → 영상 소리는 켜 둠 (녹음 유지). 자동재생 정책상 사용자 조작이 있어야 가능
        if (navigator.userActivation && !navigator.userActivation.hasBeenActive) { dM.set.call(el, true); return; }
        dV.set.call(el, s.last);
        dM.set.call(el, false);
      } else {
        dM.set.call(el, true); // 탭 음소거 전까지는 실제로도 음소거
        request(true);
      }
    } else {
      dV.set.call(el, s.volume);
      dM.set.call(el, false);
      if (tabMuted) request(false);
    }
  }

  let pending = null;
  function request(muted) {
    if (pending === muted) return;
    pending = muted;
    document.dispatchEvent(new CustomEvent('chzzk-clip-tab-mute', { detail: !!muted }));
  }

  Object.defineProperty(P, 'muted', {
    configurable: true, enumerable: dM.enumerable,
    get() { const s = isTarget(this) && st.get(this); return s ? s.muted : realMuted(this); },
    set(v) {
      if (!isTarget(this)) return dM.set.call(this, v);
      ensure(this).muted = !!v;
      apply(this);
    }
  });
  Object.defineProperty(P, 'volume', {
    configurable: true, enumerable: dV.enumerable,
    get() { const s = isTarget(this) && st.get(this); return s ? s.volume : realVolume(this); },
    set(v) {
      if (!isTarget(this)) return dV.set.call(this, v);
      const n = Number(v);
      if (!(n >= 0 && n <= 1)) return dV.set.call(this, v); // 잘못된 값은 원래 동작(오류)대로
      ensure(this).volume = n;
      apply(this);
    }
  });

  // 확장(콘텐츠 스크립트)에서 오는 신호
  document.addEventListener('chzzk-clip-config', e => {
    const on = e.detail === true;
    if (on === active) return;
    active = on;
    if (on) {
      for (const el of document.querySelectorAll('video[data-chzzk-clip]')) { ensure(el); apply(el); }
    } else {
      // 끄면 플레이어가 정한 값 그대로 되돌리고 탭 음소거 해제
      for (const el of targets) {
        const s = st.get(el);
        if (s) { dV.set.call(el, s.volume); dM.set.call(el, s.muted); }
        st.delete(el);
      }
      targets.clear();
      if (tabMuted) request(false);
    }
  });
  document.addEventListener('chzzk-clip-tab-muted', e => {
    tabMuted = e.detail === true;
    pending = null;
    for (const el of targets) if (isTarget(el)) apply(el);
  });
})();
