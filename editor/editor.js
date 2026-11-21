// ─────────────────────────────────────────────────────────────
// 교차편집 편집기
//
//   1) 불러오기 : 각 탭이 고정한 버퍼(최대 60초)를 나눠 받기
//   2) 미리보기 : 트랙별 MP4를 <video>로 같은 시계에 맞춰 재생 (큰 화면 = 결과, 오른쪽 = 트랙별)
//   3) 편집     : 숫자키/화면 클릭으로 컷, 경계 끌기, 시작/끝, 되돌리기
//   4) 싱크     : 트랙별 조절, 소리 비교 자동 맞춤
//   5) 내보내기 : export.js
//
// 타임라인 0초 = 가장 먼저 시작한 트랙의 첫 장면 (실제 시각 기준 정렬)
// ─────────────────────────────────────────────────────────────
(() => {
  'use strict';
  const X = globalThis.ChzzkExport;
  const Mux = globalThis.ChzzkMp4Mux;
  const $ = id => document.getElementById(id);
  const COLORS = ['#00ffa3', '#4da3ff', '#ff6b9a', '#ffc23d', '#b48cff'];
  const MAX_OFFSET = 30; // 싱크 조절 범위 ±30초

  const params = new URLSearchParams(location.search);
  const session = params.get('session') || String(Date.now());
  const tabIds = (params.get('tabs') || '').split(',').map(Number).filter(n => Number.isInteger(n) && n >= 0);
  const skipped = Number(params.get('skipped')) || 0;
  // 편집 모드: 탭 하나의 시작/끝만 정해 그 채널 저장 위치에 저장
  const TRIM = params.get('mode') === 'trim';

  const S = {
    tracks: [],
    cuts: [{ t: 0, track: 0 }], // 컷 목록 (각 컷부터 다음 컷 전까지 그 트랙)
    inT: 0, outT: 0,            // 내보낼 범위
    t: 0, L: 0,                 // 재생 위치, 타임라인 길이(초)
    origin: 0,                  // 타임라인 0초의 실제 시각(µs)
    playing: false, clockT0: 0, clockP0: 0,
    sel: -1,                    // 선택한 구간(컷 번호)
    history: [],
    crop: null,                 // 화면 자르기 { x, y, w, h } (16:9 틀 기준 0~1)
    cropRatio: ''               // '' | 'free' | '16:9' | '9:16' | '1:1' | '4:3'
  };

  // ── 도우미 ──
  function fromB64(s) {
    const bin = atob(s);
    const u = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) u[i] = bin.charCodeAt(i);
    return u;
  }
  const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
  function fmt(t) {
    t = Math.max(0, t);
    const m = Math.floor(t / 60), s = t - m * 60;
    return `${m}:${s.toFixed(1).padStart(4, '0')}`;
  }
  // 방송 폴더 이름: 방송제목｜yymmdd (방송 시작일, 없으면 가져온 날)
  function broadcastFolder(tr) {
    const d = new Date(Number(tr.meta.broadcastDate) || Number(session) || Date.now());
    const p = n => String(n).padStart(2, '0');
    return (tr.meta.title ? tr.meta.title + '｜' : '') + `${p(d.getFullYear() % 100)}${p(d.getMonth() + 1)}${p(d.getDate())}`;
  }
  function stampOf(ms) {
    const d = new Date(Number(ms) || Date.now());
    const p = n => String(n).padStart(2, '0');
    return `${p(d.getFullYear() % 100)}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}：${p(d.getMinutes())}：${p(d.getSeconds())}`;
  }
  function setStatus(text, kind = '') {
    const el = $('status');
    el.textContent = text;
    el.className = 'status ' + kind;
  }

  // ── 1) 불러오기 ──
  async function ask(tabId, msg) {
    const r = await chrome.tabs.sendMessage(tabId, msg);
    if (!r || !r.ok) throw new Error((r && r.error) || '탭이 응답하지 않습니다');
    return r;
  }

  async function loadTrack(tabId, onPart) {
    const first = await ask(tabId, { type: 'snapshot-get', session, part: 0 });
    const meta = first.meta;
    const v = [], a = [];
    const take = r => {
      for (const [b, ts, k] of r.video) v.push({ data: fromB64(b), ts, key: !!k });
      for (const [b, ts, d] of r.audio) a.push({ data: fromB64(b), ts, dur: d });
      onPart();
    };
    take(first);
    for (let p = 1; p < meta.parts; p++) take(await ask(tabId, { type: 'snapshot-get', session, part: p }));
    chrome.tabs.sendMessage(tabId, { type: 'snapshot-release', session }).catch(() => {});
    meta.video.descriptionU8 = meta.video.description ? fromB64(meta.video.description) : null;
    if (meta.audio) meta.audio.descriptionU8 = meta.audio.description ? fromB64(meta.audio.description) : null;
    v.sort((x, y) => x.ts - y.ts);
    a.sort((x, y) => x.ts - y.ts);
    const m = meta.audio;
    const silent = m ? await Mux.silentAudioFrame({ codec: m.kind, sampleRate: m.sampleRate, channels: m.channels, bitrate: m.bitrate }) : null;
    return { tabId, meta, name: meta.name, v, a, silent, durUs: meta.durationUs, wallStartUs: meta.wallStartUs, offset: 0, pos: 0, pcm: undefined };
  }

  // 트랙 → 미리보기용 MP4 (재압축 없음)
  function buildPreview(tr) {
    const m = tr.meta;
    const out = Mux.muxMp4({
      video: { codec: m.video.kind, codecString: m.video.codecString, width: m.video.width, height: m.video.height,
               description: m.video.descriptionU8, frameDuration: 1e6 / m.video.fps, color: m.video.color || null,
               samples: tr.v.map(c => ({ data: c.data, timestamp: c.ts, key: c.key })) },
      audio: m.audio && tr.a.length ? {
        codec: m.audio.kind, sampleRate: m.audio.sampleRate, channels: m.audio.channels, bitrate: m.audio.bitrate,
        description: m.audio.descriptionU8,
        samples: Mux.fillAudioGaps(tr.a.map(c => ({ data: c.data, timestamp: c.ts, duration: c.dur })), 0, tr.silent) } : null
    });
    tr.url = URL.createObjectURL(new Blob([out], { type: 'video/mp4' }));
  }

  async function load() {
    if (!tabIds.length) throw new Error('불러올 탭이 없습니다. 치지직 탭에서 영상을 켜고 다시 여십시오.');
    let done = 0;
    const totalHint = tabIds.length;
    const failures = [];
    const results = await Promise.all(tabIds.map(id => loadTrack(id, () => {
      done++;
      $('loadingText').textContent = `탭 ${totalHint}개에서 영상을 가져오는 중… (${done}조각)`;
    }).catch(err => { failures.push(String(err.message || err)); return null; })));
    S.tracks = results.filter(Boolean).slice(0, 5);
    if (!S.tracks.length) throw new Error('영상을 가져오지 못했습니다: ' + (failures[0] || '알 수 없는 오류'));
    // 시작이 빠른 순서로 번호
    S.tracks.sort((x, y) => x.wallStartUs - y.wallStartUs);
    S.tracks.forEach((tr, i) => {
      tr.idx = i; tr.color = COLORS[i];
      tr.isGif = tr.meta.kind === 'gif';
      if (tr.isGif) tr.gifDec = new X.GifTrackDecoder(tr); // WebP 버퍼 트랙
      else buildPreview(tr);
    });
    S.origin = Math.min(...S.tracks.map(t => t.wallStartUs));
    layout();
    S.inT = 0; S.outT = S.L;
    // 처음에는 가장 최근 부분 표시
    S.t = 0;
    return failures;
  }

  // 트랙 위치(초)와 타임라인 길이 재계산
  function layout() {
    const oldL = S.L;
    for (const tr of S.tracks) tr.pos = (tr.wallStartUs - S.origin) / 1e6 + tr.offset;
    S.L = Math.max(0.5, ...S.tracks.map(t => t.pos + t.durUs / 1e6));
    if (S.outT >= oldL - 1e-6 || S.outT > S.L) S.outT = S.L; // 끝을 따로 정하지 않았으면 따라감
    S.inT = clamp(S.inT, 0, Math.max(0, S.outT - 0.5));
    S.t = clamp(S.t, 0, S.L);
    S.cuts = S.cuts.filter((c, i) => i === 0 || c.t < S.L - 1e-3);
  }

  // ── 3) 편집: 컷 목록 ──
  function segIndexAt(t) {
    let k = 0;
    for (let i = 0; i < S.cuts.length; i++) { if (S.cuts[i].t <= t + 1e-6) k = i; else break; }
    return k;
  }
  const trackAt = t => S.cuts[segIndexAt(t)].track;
  function segments() {
    return S.cuts.map((c, i) => ({ start: c.t, end: i + 1 < S.cuts.length ? S.cuts[i + 1].t : S.L, track: c.track, idx: i }))
      .filter(s => s.end > s.start);
  }
  // 정리: 시간순, 가까운 컷·같은 트랙 연속 합치기
  function normalize() {
    S.cuts.sort((a, b) => a.t - b.t);
    const out = [];
    for (const c of S.cuts) {
      const last = out[out.length - 1];
      if (!last) { out.push({ t: 0, track: c.track }); continue; }
      if (c.t >= S.L - 1e-3) continue;
      if (c.t - last.t < 1 / 60) { last.track = c.track; continue; }
      out.push({ t: c.t, track: c.track });
    }
    S.cuts = out.filter((c, i) => i === 0 || c.track !== out[i - 1].track);
    if (S.sel >= S.cuts.length) S.sel = S.cuts.length - 1;
  }

  function snapshotState() {
    return JSON.stringify({ cuts: S.cuts, inT: S.inT, outT: S.outT, offsets: S.tracks.map(t => t.offset), crop: S.crop, cropRatio: S.cropRatio });
  }
  function pushHistory() {
    S.history.push(snapshotState());
    if (S.history.length > 200) S.history.shift();
  }
  function undo() {
    const last = S.history.pop();
    if (!last) return setStatus('더 되돌릴 것이 없습니다');
    const st = JSON.parse(last);
    S.cuts = st.cuts; S.inT = st.inT; S.outT = st.outT;
    S.crop = st.crop || null; S.cropRatio = st.cropRatio || ''; renderCrop();
    st.offsets.forEach((o, i) => { if (S.tracks[i]) { S.tracks[i].offset = o; S.tracks[i].offInput.value = o.toFixed(2); } });
    layout();
    normalize();
    setStatus('되돌렸습니다');
  }

  // 그 순간부터 k번 트랙으로
  function switchAt(t, k) {
    if (k < 0 || k >= S.tracks.length) return;
    pushHistory();
    const i = segIndexAt(t);
    if (Math.abs(S.cuts[i].t - t) < 0.02) S.cuts[i].track = k;
    else S.cuts.splice(i + 1, 0, { t, track: k });
    normalize();
    S.sel = segIndexAt(t);
  }
  // 선택 구간 전체를 k번 트랙으로
  function setSegmentTrack(i, k) {
    if (k < 0 || k >= S.tracks.length || !S.cuts[i]) return;
    pushHistory();
    S.cuts[i].track = k;
    normalize();
  }
  function deleteCut(i) {
    if (i <= 0 || !S.cuts[i]) return setStatus('첫 구간은 지울 수 없습니다.', 'warn');
    pushHistory();
    S.cuts.splice(i, 1);
    normalize();
    S.sel = Math.max(0, i - 1);
    setStatus('컷을 지웠습니다');
  }
  function setOffset(i, v, record = true) {
    const tr = S.tracks[i];
    if (!tr) return;
    if (record) pushHistory();
    tr.offset = Math.round(clamp(v, -MAX_OFFSET, MAX_OFFSET) * 100) / 100;
    tr.offInput.value = tr.offset.toFixed(2);
    layout();
  }

  // ── 화면 자르기 ──
  // 좌표는 큰 미리보기(16:9 틀) 기준 0~1 비율
  const RATIOS = { '16:9': 16 / 9, '9:16': 9 / 16, '1:1': 1, '4:3': 4 / 3 };
  const normRatio = key => (RATIOS[key] ? RATIOS[key] * 9 / 16 : null); // 실제 비율 → 좌표 비율
  const cropAspectNow = () => (S.crop ? (S.crop.w * 16) / (S.crop.h * 9) : 16 / 9);
  const srcHeight = () => Math.max(...S.tracks.map(t => t.meta.video.height || 360));
  function cropLabelText() {
    const c = S.crop, sh = srcHeight();
    const name = S.cropRatio && S.cropRatio !== 'free' ? S.cropRatio + ' · ' : '';
    return `${name}원본 약 ${Math.round(c.w * sh * 16 / 9)}×${Math.round(c.h * sh)}`;
  }
  function setCropRatio(key) {
    pushHistory();
    S.cropRatio = key;
    if (!key) S.crop = null;
    else {
      const nr = normRatio(key);
      if (!nr) S.crop = S.crop || { x: 0.1, y: 0.1, w: 0.8, h: 0.8 };
      else {
        // 현재 틀 가운데 기준, 그 비율로 들어가는 최대 크기(90%)
        let w = 0.9, h = w / nr;
        if (h > 0.9) { h = 0.9; w = h * nr; }
        S.crop = { x: (1 - w) / 2, y: (1 - h) / 2, w, h };
      }
    }
    renderCrop();
  }
  function renderCrop() {
    const box = $('cropBox');
    $('cropRatio').value = S.cropRatio || '';
    $('cropReset').hidden = !S.crop;
    if (!S.crop) { box.hidden = true; $('cropInfo').textContent = ''; return; }
    const c = S.crop;
    box.hidden = false;
    box.style.left = c.x * 100 + '%'; box.style.top = c.y * 100 + '%';
    box.style.width = c.w * 100 + '%'; box.style.height = c.h * 100 + '%';
    $('cropLabel').textContent = cropLabelText();
    $('cropInfo').textContent = '틀을 끌어 이동, 모서리로 크기 조절';
  }
  let cdrag = null;
  $('cropBox').addEventListener('pointerdown', e => {
    if (!S.crop) return;
    pushHistory();
    cdrag = { corner: e.target.dataset ? e.target.dataset.c : null, r: document.querySelector('.program').getBoundingClientRect(),
              sx: e.clientX, sy: e.clientY, start: { ...S.crop } };
    $('cropBox').setPointerCapture(e.pointerId);
    e.preventDefault();
  });
  $('cropBox').addEventListener('pointermove', e => {
    if (!cdrag) return;
    const { r, start, corner } = cdrag;
    const dx = (e.clientX - cdrag.sx) / r.width, dy = (e.clientY - cdrag.sy) / r.height;
    if (!corner) {
      S.crop = { ...start, x: clamp(start.x + dx, 0, 1 - start.w), y: clamp(start.y + dy, 0, 1 - start.h) };
    } else {
      const west = corner.includes('w'), north = corner.includes('n');
      const ax = west ? start.x + start.w : start.x;   // 고정된 반대쪽 모서리
      const ay = north ? start.y + start.h : start.y;
      const px = clamp((west ? start.x : start.x + start.w) + dx, 0, 1);
      const py = clamp((north ? start.y : start.y + start.h) + dy, 0, 1);
      let w = Math.max(0.05, Math.abs(px - ax)), h = Math.max(0.05, Math.abs(py - ay));
      const nr = normRatio(S.cropRatio);
      if (nr) { if (w / h > nr) w = h * nr; else h = w / nr; }
      const maxW = west ? ax : 1 - ax, maxH = north ? ay : 1 - ay;
      if (w > maxW) { w = maxW; if (nr) h = w / nr; }
      if (h > maxH) { h = maxH; if (nr) w = h * nr; }
      S.crop = { x: west ? ax - w : ax, y: north ? ay - h : ay, w, h };
    }
    renderCrop();
  });
  const endCrop = () => { cdrag = null; };
  $('cropBox').addEventListener('pointerup', endCrop);
  $('cropBox').addEventListener('pointercancel', endCrop);
  $('cropRatio').addEventListener('change', () => setCropRatio($('cropRatio').value));
  $('cropReset').addEventListener('click', () => setCropRatio(''));

  // ── 2) 재생 ──
  function play() {
    if (S.t >= S.outT - 0.05 || S.t < S.inT) S.t = S.inT;
    S.playing = true;
    S.clockT0 = S.t;
    S.clockP0 = performance.now();
    $('playBtn').textContent = '❚❚';
  }
  function pause() {
    S.playing = false;
    for (const tr of S.tracks) if (tr.el && !tr.el.paused) tr.el.pause();
    $('playBtn').textContent = '▶';
  }
  function seek(t) {
    S.t = clamp(t, 0, S.L);
    if (S.playing) { S.clockT0 = S.t; S.clockP0 = performance.now(); }
  }

  const prog = $('program');
  const pctx = prog.getContext('2d');
  function drawProgram(act) {
    const tr = S.tracks[act];
    const tau = S.t - tr.pos;
    const inRange = tau >= 0 && tau < tr.durUs / 1e6;
    pctx.fillStyle = '#000';
    pctx.fillRect(0, 0, prog.width, prog.height);
    const el = tr.isGif ? tr.bmp : tr.el;
    const ew = el ? (tr.isGif ? el.width : el.videoWidth) : 0, eh = el ? (tr.isGif ? el.height : el.videoHeight) : 0;
    // 탐색 중에도 마지막 장면을 그려 깜빡임 방지
    if (inRange && el && ew && (tr.isGif || el.readyState >= 1)) {
      const s = Math.min(prog.width / ew, prog.height / eh);
      const w = ew * s, h = eh * s;
      pctx.drawImage(el, (prog.width - w) / 2, (prog.height - h) / 2, w, h);
    } else {
      pctx.fillStyle = '#666';
      pctx.font = '28px system-ui, "Malgun Gothic", sans-serif';
      pctx.textAlign = 'center';
      pctx.fillText(inRange ? '불러오는 중…' : `${act + 1}번(${tr.name})은 이 시점에 영상이 없습니다`, prog.width / 2, prog.height / 2);
    }
    const label = $('progLabel');
    label.textContent = `${act + 1}  ${tr.name}`;
    label.style.color = tr.color;
  }

  function tick(now) {
    if (S.playing) {
      S.t = S.clockT0 + (now - S.clockP0) / 1000;
      if (S.t >= S.outT) { S.t = S.outT; pause(); }
    }
    const act = trackAt(S.t);
    S.tracks.forEach((tr, i) => {
      const el = tr.el;
      const tau = S.t - tr.pos;
      const inRange = tau >= 0 && tau < tr.durUs / 1e6 - 0.03;
      tr.slate.hidden = inRange;
      tr.mon.classList.toggle('active', i === act);
      if (tr.isGif) { if (inRange) showGifFrame(tr, tau); return; } // WebP 트랙은 그림만
      if (S.playing && inRange) {
        if (el.paused) { el.currentTime = tau; el.play().catch(() => {}); }
        else if (!el.seeking && Math.abs(el.currentTime - tau) > 0.3) el.currentTime = tau; // 어긋나면 재조정
      } else {
        if (!el.paused) el.pause();
        if (inRange && !el.seeking && Math.abs(el.currentTime - tau) > 0.02) el.currentTime = tau;
      }
      const muted = !(S.playing && i === act); // 소리는 현재 화면 트랙만
      if (el.muted !== muted) el.muted = muted;
    });
    drawProgram(act);
    drawTimeline();
    $('tNow').textContent = fmt(S.t);
    $('tLen').textContent = fmt(S.L);
    $('rangeInfo').textContent = `범위 ${fmt(S.inT)} ~ ${fmt(S.outT)} (${(S.outT - S.inT).toFixed(1)}초) · 컷 ${segments().filter(s => s.end > S.inT && s.start < S.outT).length - 1}개`;
    if (outMode && S.tracks.length) watchOutput();
    requestAnimationFrame(tick);
  }

  // ── 현재 장면 스크린샷 (원본 해상도 PNG, 화면 자르기 적용) ──
  let shotBusy = false, shotTimer = null;
  function shotNote(text, ms = 3000) {
    const el = $('shotInfo');
    el.textContent = text;
    clearTimeout(shotTimer);
    if (ms) shotTimer = setTimeout(() => { el.textContent = ''; }, ms);
  }
  async function saveScreenshot() {
    if (shotBusy || !S.tracks.length) return;
    if (S.playing) pause();
    const tr = S.tracks[trackAt(S.t)];
    const tau = S.t - tr.pos;
    if (tau < 0 || tau >= tr.durUs / 1e6) return shotNote('이 시점에는 영상이 없습니다.');
    shotBusy = true;
    try {
      let src = tr.isGif ? tr.bmp : tr.el;
      if (!tr.isGif) {
        // 멈춘 위치의 장면이 그려질 때까지 대기
        if (src.seeking || Math.abs(src.currentTime - tau) > 0.05) {
          src.currentTime = tau;
          await new Promise(r => { const t = setTimeout(r, 2000); src.addEventListener('seeked', () => { clearTimeout(t); r(); }, { once: true }); });
        }
        if (src.readyState < 2) throw new Error('장면을 불러오는 중입니다. 잠시 뒤 다시 누르십시오.');
      }
      const ew = tr.isGif ? src && src.width : src.videoWidth, eh = tr.isGif ? src && src.height : src.videoHeight;
      if (!ew || !eh) throw new Error('장면을 불러오는 중입니다. 잠시 뒤 다시 누르십시오.');
      const c = S.crop || { x: 0, y: 0, w: 1, h: 1 };
      const sx = Math.round(c.x * ew), sy = Math.round(c.y * eh);
      const w = Math.max(1, Math.round(c.w * ew)), h = Math.max(1, Math.round(c.h * eh));
      const cv = new OffscreenCanvas(w, h);
      cv.getContext('2d', { alpha: false }).drawImage(src, sx, sy, w, h, 0, 0, w, h);
      const blob = await cv.convertToBlob({ type: 'image/png' });
      // 파일 이름: [스트리머명｜방송제목] 장면 시각.png
      const wall = Number(tr.wallStartUs) / 1000 + tau * 1000;
      const name = `[${tr.name}${tr.meta.title ? '｜' + tr.meta.title : ''}] ${stampOf(wall || session)}.png`;
      shotNote('저장 중…', 0);
      const saved = await X.saveOutput(blob, name, { streamer: tr.name, channelId: tr.meta.channelId, sub: broadcastFolder(tr) });
      shotNote(`저장됨 · ${w}×${h} · ${saved.split('\n')[0]}`, 5000);
    } catch (e) {
      shotNote(String((e && e.message) || e), 4000);
    } finally {
      shotBusy = false;
    }
  }
  $('shotBtn').addEventListener('click', saveScreenshot);

  // WebP 트랙: 현재 장면을 오른쪽 화면에 그리고 큰 화면용으로 보관
  function showGifFrame(tr, tau) {
    const k = tr.gifDec.indexAt(tau * 1e6);
    if (k === tr.shownIdx || tr.loadingIdx === k) return;
    tr.loadingIdx = k;
    createImageBitmap(new Blob([tr.v[k].data], { type: 'image/webp' })).then(bmp => {
      if (tr.loadingIdx !== k) { bmp.close(); return; }
      if (tr.bmp) tr.bmp.close();
      tr.bmp = bmp; tr.shownIdx = k; tr.loadingIdx = -1;
      const c = tr.gifCanvas;
      if (c.width !== bmp.width) { c.width = bmp.width; c.height = bmp.height; }
      c.getContext('2d').drawImage(bmp, 0, 0);
    }).catch(() => { tr.loadingIdx = -1; });
  }

  // ── 오른쪽: 트랙별 화면 + 싱크 ──
  function buildMonitors() {
    const box = $('monitors');
    box.replaceChildren();
    S.tracks.forEach((tr, i) => {
      const m = tr.meta;
      const d = document.createElement('div');
      d.className = 'mon';
      d.style.setProperty('--c', tr.color);
      d.title = `클릭하면 지금 위치부터 ${i + 1}번으로 전환`;
      d.innerHTML = `
        <div class="head"><span class="num">${i + 1}</span><span class="name"></span><span class="meta"></span></div>
        <div class="screen"><video muted playsinline preload="auto"></video><div class="slate">이 시점엔 영상 없음</div></div>
        <div class="sync">싱크 <button type="button" data-d="-0.1" title="0.1초 앞으로(일찍)">−</button>
          <input type="number" step="0.1" value="0.00" aria-label="싱크 조절(초)"> 초
          <button type="button" data-d="0.1" title="0.1초 뒤로(늦게)">+</button></div>`;
      d.querySelector('.name').textContent = tr.name;
      d.querySelector('.meta').textContent = tr.isGif
        ? `WebP 버퍼 · ${m.video.width}px · ${(tr.durUs / 1e6).toFixed(1)}초 · 소리 없음`
        : `${m.video.height}p · ${(tr.durUs / 1e6).toFixed(1)}초${m.audio ? '' : ' · 소리 없음'}`;
      const v = d.querySelector('video');
      if (tr.isGif) {
        // WebP 트랙은 캔버스에 그림
        const c = document.createElement('canvas');
        c.className = 'gifScreen';
        v.replaceWith(c);
        tr.gifCanvas = c;
        tr.el = null;
      } else {
        v.src = tr.url;
        tr.el = v;
      }
      tr.slate = d.querySelector('.slate');
      tr.mon = d;
      tr.offInput = d.querySelector('input');
      d.addEventListener('click', e => { if (e.target.closest('.sync')) return; switchAt(S.t, i); });
      d.querySelectorAll('.sync button').forEach(b => b.addEventListener('click', e => {
        e.stopPropagation();
        setOffset(i, tr.offset + Number(b.dataset.d));
      }));
      tr.offInput.addEventListener('change', () => setOffset(i, Number(tr.offInput.value) || 0));
      tr.offInput.addEventListener('keydown', e => e.stopPropagation());
      box.appendChild(d);
    });
  }

  // ── 타임라인 ──
  const tl = $('timeline');
  const tctx = tl.getContext('2d');
  const G = { padL: 110, padR: 14, ruler: 24, progY: 26, progH: 36, laneY: 72, laneH: 22, laneGap: 6 };
  let tlW = 800;
  function tlHeight() { return G.laneY + S.tracks.length * (G.laneH + G.laneGap) + 6; }
  function resizeTimeline() {
    const dpr = window.devicePixelRatio || 1;
    tlW = tl.parentElement.clientWidth;
    const h = tlHeight();
    tl.width = Math.round(tlW * dpr);
    tl.height = Math.round(h * dpr);
    tl.style.height = h + 'px';
    tctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  }
  const span = () => Math.max(1, tlW - G.padL - G.padR);
  const xOf = t => G.padL + (t / S.L) * span();
  const tOf = x => clamp((x - G.padL) / span() * S.L, 0, S.L);
  const laneTop = i => G.laneY + i * (G.laneH + G.laneGap);

  function drawTimeline() {
    const H = tlHeight();
    const c = tctx;
    c.clearRect(0, 0, tlW, H);
    c.fillStyle = '#1b1b20';
    c.fillRect(0, 0, tlW, H);
    c.font = '12px system-ui, "Malgun Gothic", sans-serif';
    c.textBaseline = 'middle';

    // 눈금
    const step = S.L <= 15 ? 1 : S.L <= 40 ? 2 : 5;
    c.strokeStyle = '#3a3a44'; c.fillStyle = '#9a9aa5'; c.textAlign = 'center';
    for (let s = 0; s <= S.L + 1e-6; s += step) {
      const x = xOf(s);
      c.beginPath(); c.moveTo(x + 0.5, G.ruler - 6); c.lineTo(x + 0.5, H); c.globalAlpha = 0.35; c.stroke(); c.globalAlpha = 1;
      c.fillText(s >= 60 ? fmt(s).replace(/\.0$/, '') : `${s}s`, x, 10);
    }

    // 편집 줄
    c.textAlign = 'left'; c.fillStyle = '#f2f2f4';
    c.fillText('편집 결과', 10, G.progY + G.progH / 2);
    for (const seg of segments()) {
      const x0 = xOf(seg.start), x1 = xOf(seg.end);
      const tr = S.tracks[seg.track];
      c.fillStyle = tr.color; c.globalAlpha = 0.85;
      c.fillRect(x0, G.progY, Math.max(1, x1 - x0), G.progH);
      c.globalAlpha = 1;
      if (seg.idx === S.sel) { c.strokeStyle = '#fff'; c.lineWidth = 2; c.strokeRect(x0 + 1, G.progY + 1, Math.max(1, x1 - x0 - 2), G.progH - 2); c.lineWidth = 1; }
      if (x1 - x0 > 18) {
        c.save(); c.beginPath(); c.rect(x0, G.progY, x1 - x0, G.progH); c.clip();
        c.fillStyle = '#0b0b0d'; c.font = 'bold 12px system-ui, "Malgun Gothic", sans-serif';
        c.fillText(`${seg.track + 1} ${x1 - x0 > 70 ? tr.name : ''}`, x0 + 6, G.progY + G.progH / 2);
        c.restore();
      }
    }
    // 컷 경계 손잡이
    c.fillStyle = '#ffffff';
    S.cuts.forEach((cut, i) => { if (i > 0) c.fillRect(xOf(cut.t) - 1, G.progY - 3, 2, G.progH + 6); });

    // 트랙 줄
    S.tracks.forEach((tr, i) => {
      const y = laneTop(i);
      c.fillStyle = tr.color;
      c.fillText(`${i + 1} ${tr.name}`.slice(0, 14), 10, y + G.laneH / 2);
      const x0 = xOf(Math.max(0, tr.pos)), x1 = xOf(Math.min(S.L, tr.pos + tr.durUs / 1e6));
      c.globalAlpha = 0.3; c.fillRect(x0, y, Math.max(1, x1 - x0), G.laneH); c.globalAlpha = 1;
      c.strokeStyle = tr.color; c.strokeRect(x0 + 0.5, y + 0.5, Math.max(1, x1 - x0) - 1, G.laneH - 1);
      // 편집 결과에 쓰인 부분은 진하게
      for (const seg of segments()) {
        if (seg.track !== i) continue;
        const a = xOf(Math.max(seg.start, tr.pos)), b = xOf(Math.min(seg.end, tr.pos + tr.durUs / 1e6));
        if (b > a) { c.globalAlpha = 0.75; c.fillRect(a, y + 4, b - a, G.laneH - 8); c.globalAlpha = 1; }
      }
      if (tr.offset) {
        c.fillStyle = '#9a9aa5'; c.textAlign = 'right';
        c.fillText(`${tr.offset > 0 ? '+' : ''}${tr.offset.toFixed(2)}s`, tlW - G.padR - 4, y + G.laneH / 2);
        c.textAlign = 'left';
      }
    });

    // 범위 밖은 어둡게
    c.fillStyle = 'rgba(0,0,0,0.55)';
    if (S.inT > 0) c.fillRect(G.padL, G.ruler - 4, xOf(S.inT) - G.padL, H);
    if (S.outT < S.L) c.fillRect(xOf(S.outT), G.ruler - 4, xOf(S.L) - xOf(S.outT), H);
    // 녹화 버튼을 누른 순간 표시
    if (Number.isFinite(S.recMark)) {
      const x = xOf(S.recMark);
      c.fillStyle = '#ff5a5a';
      c.fillRect(x - 0.5, G.ruler - 4, 1, H);
      c.font = '10px system-ui, sans-serif'; c.textAlign = 'left';
      c.fillText('● 녹화', x + 3, G.ruler + 8);
    }
    c.fillStyle = '#00ffa3';
    for (const t of [S.inT, S.outT]) {
      const x = xOf(t);
      c.fillRect(x - 1, G.ruler - 4, 2, H);
      c.beginPath(); c.moveTo(x - 6, G.ruler - 4); c.lineTo(x + 6, G.ruler - 4); c.lineTo(x, G.ruler + 4); c.fill();
    }

    // 재생 위치
    const px = xOf(S.t);
    c.fillStyle = '#ff5a5a';
    c.fillRect(px - 1, 0, 2, H);
    c.beginPath(); c.moveTo(px - 6, 0); c.lineTo(px + 6, 0); c.lineTo(px, 8); c.fill();
  }

  // 타임라인 마우스/터치
  let drag = null;
  function hit(x, y) {
    if (y < G.ruler + 4) {
      if (Math.abs(x - xOf(S.inT)) <= 7) return { mode: 'in' };
      if (Math.abs(x - xOf(S.outT)) <= 7) return { mode: 'out' };
      return { mode: 'scrub' };
    }
    if (y >= G.progY - 4 && y <= G.progY + G.progH + 4) {
      for (let i = 1; i < S.cuts.length; i++) if (Math.abs(x - xOf(S.cuts[i].t)) <= 6) return { mode: 'cut', i };
      return { mode: 'select' };
    }
    for (let i = 0; i < S.tracks.length; i++) {
      const y0 = laneTop(i);
      if (y >= y0 && y <= y0 + G.laneH) {
        const tr = S.tracks[i];
        if (x >= xOf(Math.max(0, tr.pos)) - 4 && x <= xOf(Math.min(S.L, tr.pos + tr.durUs / 1e6)) + 4) return { mode: 'offset', i };
      }
    }
    return { mode: 'scrub' };
  }
  const CURSORS = { in: 'ew-resize', out: 'ew-resize', cut: 'col-resize', offset: 'grab', select: 'pointer', scrub: 'text' };
  tl.addEventListener('pointermove', e => {
    const r = tl.getBoundingClientRect();
    const x = e.clientX - r.left, y = e.clientY - r.top;
    if (!drag) { tl.style.cursor = CURSORS[hit(x, y).mode] || 'default'; return; }
    const t = tOf(x);
    if (drag.mode === 'scrub' || drag.mode === 'select') seek(t);
    else if (drag.mode === 'cut') {
      const prev = S.cuts[drag.i - 1].t, next = drag.i + 1 < S.cuts.length ? S.cuts[drag.i + 1].t : S.L;
      S.cuts[drag.i].t = clamp(t, prev + 1 / 30, next - 1 / 30);
      seek(S.cuts[drag.i].t);
    } else if (drag.mode === 'offset') {
      const tr = S.tracks[drag.i];
      const secPerPx = S.L / span();
      setOffset(drag.i, drag.startOffset + (x - drag.startX) * secPerPx, false);
      tr.offInput.value = tr.offset.toFixed(2);
    } else if (drag.mode === 'in') S.inT = clamp(t, 0, S.outT - 0.5);
    else if (drag.mode === 'out') S.outT = clamp(t, S.inT + 0.5, S.L);
  });
  tl.addEventListener('pointerdown', e => {
    const r = tl.getBoundingClientRect();
    const x = e.clientX - r.left, y = e.clientY - r.top;
    const h = hit(x, y);
    drag = { ...h, startX: x };
    tl.setPointerCapture(e.pointerId);
    if (h.mode === 'scrub') seek(tOf(x));
    else if (h.mode === 'select') { seek(tOf(x)); S.sel = segIndexAt(tOf(x)); }
    else if (h.mode === 'cut') { pushHistory(); S.sel = h.i; }
    else if (h.mode === 'offset') { pushHistory(); drag.startOffset = S.tracks[h.i].offset; tl.style.cursor = 'grabbing'; }
    else if (h.mode === 'in' || h.mode === 'out') pushHistory();
  });
  const endDrag = () => {
    if (drag && drag.mode === 'cut') normalize();
    if (drag && drag.mode === 'offset') setStatus(`${drag.i + 1}번 싱크 ${S.tracks[drag.i].offset.toFixed(2)}초`);
    drag = null;
  };
  tl.addEventListener('pointerup', endDrag);
  tl.addEventListener('pointercancel', endDrag);

  // ── 키보드 ──
  document.addEventListener('keydown', e => {
    if (!$('exportModal').hidden) { if (e.key === 'Escape' && !$('expForm').hidden) closeExport(); return; }
    if (e.target.closest && e.target.closest('input, select, textarea')) return;
    const fps = S.tracks.length ? S.tracks[trackAt(S.t)].meta.video.fps : 30;
    const digit = /^Digit([1-5])$/.exec(e.code);
    if (digit) {
      const k = Number(digit[1]) - 1;
      if (e.shiftKey) setSegmentTrack(S.sel >= 0 ? S.sel : segIndexAt(S.t), k);
      else switchAt(S.t, k);
      e.preventDefault();
      return;
    }
    switch (e.code) {
      case 'Space': S.playing ? pause() : play(); break;
      case 'ArrowLeft': seek(S.t - (e.shiftKey ? 1 : 0.1)); break;
      case 'ArrowRight': seek(S.t + (e.shiftKey ? 1 : 0.1)); break;
      case 'Comma': pause(); seek(S.t - 1 / fps); break;
      case 'Period': pause(); seek(S.t + 1 / fps); break;
      case 'KeyI': setIn(); break;
      case 'KeyP': saveScreenshot(); break;
      case 'KeyO': setOut(); break;
      case 'Home': seek(S.inT); break;
      case 'End': seek(S.outT); break;
      case 'Delete': case 'Backspace': deleteCut(S.sel >= 0 ? S.sel : segIndexAt(S.t)); break;
      case 'KeyZ': if (e.ctrlKey || e.metaKey) { undo(); break; } return;
      default: return;
    }
    e.preventDefault();
  });

  function setIn() { pushHistory(); S.inT = clamp(S.t, 0, S.outT - 0.5); setStatus(`시작을 ${fmt(S.inT)}로 정했습니다`); }
  function setOut() { pushHistory(); S.outT = clamp(S.t, S.inT + 0.5, S.L); setStatus(`끝을 ${fmt(S.outT)}로 정했습니다`); }

  // ── 4) 소리 자동 싱크 ──
  // 소리 크기 변화를 0.01초 단위로 비교해 가장 잘 겹치는 위치 찾기
  function envelope(pcm) {
    const B = 480; // 10ms
    const n = Math.floor(pcm.L.length / B);
    const rms = new Float32Array(n);
    let peak = 0;
    for (let b = 0; b < n; b++) {
      let s = 0;
      for (let j = b * B, end = j + B; j < end; j++) { const v = (pcm.L[j] + pcm.R[j]) * 0.5; s += v * v; }
      rms[b] = Math.sqrt(s / B);
      if (rms[b] > peak) peak = rms[b];
    }
    // 조용한 구간은 바닥값으로 눌러 모든 탭의 공통 끊김이 비교를 망치지 않게 함
    const floor = Math.max(1e-4, peak * 0.05);
    const e = new Float32Array(n);
    for (let b = 0; b < n; b++) e[b] = Math.log(Math.max(floor, rms[b]));
    // 느린 변화(배경 소음) 제거
    const W = 25, out = new Float32Array(n);
    let acc = 0;
    for (let i = 0; i < n; i++) {
      acc += e[i];
      if (i >= 2 * W + 1) acc -= e[i - 2 * W - 1];
      const cnt = Math.min(i + 1, 2 * W + 1);
      const center = i - W;
      if (center >= 0) out[center] = e[center] - acc / cnt;
    }
    return out;
  }
  function bestLag(ref, refPos, trk, trkPos, maxLagSec = 10) {
    const d0 = Math.round((trkPos - refPos) * 100);
    const maxLag = maxLagSec * 100;
    let best = { lag: 0, score: -1 };
    for (let l = -maxLag; l <= maxLag; l++) {
      // l(0.01초)만큼 옮겼을 때 trk[i - d0 - l]이 ref[i]와 같은 순간
      const shift = d0 + l;
      const i0 = Math.max(0, shift), i1 = Math.min(ref.length, trk.length + shift);
      if (i1 - i0 < 500) continue; // 5초 이상 겹쳐야 신뢰
      let xy = 0, xx = 0, yy = 0;
      for (let i = i0; i < i1; i++) { const x = ref[i], y = trk[i - shift]; xy += x * y; xx += x * x; yy += y * y; }
      const score = xy / Math.sqrt(xx * yy + 1e-9);
      if (score > best.score) best = { lag: l / 100, score };
    }
    return best;
  }
  async function autoSync() {
    const list = S.tracks.filter(t => t.meta.audio && t.a.length);
    if (list.length < 2) return setStatus('소리가 있는 트랙이 2개 이상 필요합니다.', 'warn');
    const btn = $('autoSync');
    btn.disabled = true;
    try {
      setStatus('소리 분석 중…');
      for (const tr of list) { await X.decodeTrackAudio(tr); if (tr.pcm) tr.env = tr.env || envelope(tr.pcm); }
      const usable = list.filter(t => t.env);
      const ref = usable[0];
      pushHistory();
      const msgs = [];
      for (const tr of usable.slice(1)) {
        const r = bestLag(ref.env, ref.pos, tr.env, tr.pos);
        if (r.score >= 0.3) {
          setOffset(tr.idx, tr.offset + r.lag, false);
          msgs.push(`${tr.idx + 1}번 ${r.lag >= 0 ? '+' : ''}${r.lag.toFixed(2)}초 (일치도 ${Math.round(r.score * 100)}%)`);
        } else {
          msgs.push(`${tr.idx + 1}번은 비슷한 소리를 찾지 못함 (일치도 ${Math.round(Math.max(0, r.score) * 100)}%)`);
        }
      }
      const silent = S.tracks.filter(t => !list.includes(t)).map(t => `${t.idx + 1}번`);
      if (silent.length) msgs.push(`${silent.join('·')}은 소리가 없어 직접 맞춰야 합니다`);
      setStatus(`${ref.idx + 1}번 기준으로 맞췄습니다: ${msgs.join(' · ')}`, 'ok');
    } catch (err) {
      setStatus('자동 맞추기 실패: ' + (err.message || err), 'warn');
    } finally {
      btn.disabled = false;
    }
  }

  // ── 5) 내보내기 ──
  let exportSignal = null;
  let lastExport = null;
  function exportSegments() {
    return segments()
      .map(s => ({ start: Math.max(s.start, S.inT), end: Math.min(s.end, S.outT), track: s.track }))
      .filter(s => s.end > s.start + 1e-6);
  }
  // 저장 형식: 편집 창의 [영상 | WebP] 토글
  let outMode = 'mp4';
  const isGifFormat = () => outMode === 'gif';
  const gifSpeed = () => Number($('gifSpeed').value) || 1;
  function outputName(segs) {
    const names = [];
    for (const s of segs) { const n = S.tracks[s.track].name; if (!names.includes(n)) names.push(n); }
    let joined = names.join('+');
    if (joined.length > 60) joined = joined.slice(0, 57) + '…';
    // 방송 하나만 쓰면 제목 포함: [스트리머명｜방송제목]
    if (names.length === 1) {
      const title = segs.map(s => S.tracks[s.track].meta && S.tracks[s.track].meta.title).find(Boolean);
      if (title) joined += '｜' + title;
    }
    return `[${joined}] ${stampOf(session)}.${isGifFormat() ? 'webp' : 'mp4'}`;
  }
  // 결과 크기 (export.js와 같은 계산)
  function outSizeText() {
    const gif = isGifFormat();
    return X.outSize(gif ? 'webp' : 'mp4', Number($(gif ? 'gifWidth' : 'expHeight').value), S.crop, cropNative()).join('×');
  }
  // 자른 화면의 결과 크기: 잘라낸 크기 그대로(확대 없음) / 고른 크기에 맞춤
  let cropSizeMode = 'native';
  const cropNative = () => !!S.crop && cropSizeMode === 'native';
  function setCropSize(m) {
    cropSizeMode = m;
    $('cropNative').classList.toggle('on', m === 'native');
    $('cropFit').classList.toggle('on', m === 'fit');
    refreshExportForm();
  }
  $('cropNative').addEventListener('click', () => setCropSize('native'));
  $('cropFit').addEventListener('click', () => setCropSize('fit'));
  // 형식별 입력 칸, 결과 길이, 예상 용량
  function setMode(m) {
    outMode = m;
    $('modeMp4').classList.toggle('on', m === 'mp4');
    $('modeGif').classList.toggle('on', m === 'gif');
    refreshExportForm();
  }
  function refreshExportForm() {
    const gif = isGifFormat();
    $('mp4Opts').hidden = gif; $('gifOpts').hidden = !gif;
    $('cropSize').hidden = !S.crop;
    $('gifQOut').textContent = Number($('gifQ').value).toFixed(2);
    const dur = Math.max(0, S.outT - S.inT);
    const sp = gifSpeed();
    // 배속이면 "범위 → 결과" 길이를 함께 표시
    $('outLen').textContent = gif && sp !== 1
      ? `범위 ${dur.toFixed(1)}초 → 결과 ${(dur / sp).toFixed(1)}초 (${sp}배속)`
      : `${outSizeText()} · ${dur.toFixed(1)}초`;
    clearTimeout(refreshExportForm.t);
    refreshExportForm.t = setTimeout(updateSizeEstimate, 250);
  }
  // 범위·자르기가 바뀌면 다시 계산 (화면 갱신마다 확인)
  let outKey = '';
  function watchOutput() {
    const k = [S.inT.toFixed(2), S.outT.toFixed(2), JSON.stringify(S.crop), exportSegments().map(s => s.track).join()].join('|');
    if (k !== outKey) { outKey = k; refreshExportForm(); }
  }
  // 처음 값: 설정 페이지 (마지막 값 기억 없음)
  async function initOutputForm() {
    const maxH = Math.min(1080, Math.max(...S.tracks.map(t => t.meta.video.height)));
    const sel = $('expHeight');
    sel.replaceChildren();
    for (const h of [...new Set([maxH, 1080, 720, 480])].filter(h => h <= maxH).sort((a, b) => b - a)) {
      const o = document.createElement('option');
      o.value = h; o.textContent = `${h}p`;
      sel.appendChild(o);
    }
    $('expFps').value = S.tracks.some(t => !t.isGif && t.meta.video.fps >= 50) ? '60' : '30';
    const cfg = await chrome.storage.sync.get(globalThis.CHZZK_CLIP_DEFAULTS).catch(() => globalThis.CHZZK_CLIP_DEFAULTS);
    $('gifWidth').value = String([320, 480, 640, 720, 850, 1280, 1920].includes(+cfg.width) ? cfg.width : 480);
    $('gifFps').value = String([8, 10, 12, 15, 20, 24, 30].includes(+cfg.fps) ? cfg.fps : 12);
    $('gifQ').value = String(Math.min(1, Math.max(0.5, Number(cfg.quality) || 0.8)));
    $('gifSpeed').value = '1';
    $('expQuality').value = ['normal', 'high', 'best'].includes(cfg.videoQuality) ? cfg.videoQuality : 'high';
    // 편집은 가져온 버퍼 종류에 맞춰 시작
    setMode(TRIM && S.tracks[0].isGif ? 'gif' : 'mp4');
  }
  // ── 예상 용량 ──
  //   MP4: 가져온 영상의 실제 초당 용량 × 길이 × (결과 화소 / 원본 화소) × 압축 품질 비율
  //   WebP: 현재 장면 한 장을 결과 크기·화질로 실제 압축해 본 크기 × 장 수
  const Q_FACTOR = { normal: 0.6, high: 1, best: 1.5 };
  const BIG = 20 * 1048576;     // WebP: 이보다 크면 노란색 표시
  const BIG_MP4 = 50 * 1048576; // 영상
  let estimateSeq = 0;
  async function updateSizeEstimate() {
    const el = $('expEstimate');
    if (!el) return;
    const seq = ++estimateSeq;
    const segs = exportSegments();
    const dur = Math.max(0, S.outT - S.inT);
    const mb = n => (n >= 1048576 ? (n / 1048576).toFixed(1) + 'MB' : Math.max(1, Math.round(n / 1024)) + 'KB');
    if (!segs.length || !dur) { el.textContent = ''; return; }
    const [ow, oh] = outSizeText().split('×').map(Number);
    if (!isGifFormat()) {
      const fps = Number($('expFps').value) || 30;
      const cfg = await chrome.storage.sync.get(globalThis.CHZZK_CLIP_DEFAULTS).catch(() => globalThis.CHZZK_CLIP_DEFAULTS);
      const q = $('expQuality').value;
      let bytes = 0;
      for (const sg of segs) {
        const tr = S.tracks[sg.track], m = tr.meta;
        const len = sg.end - sg.start;
        let bps;
        if (tr.isGif || !(m.bytes > 0) || !(m.durationUs > 0)) bps = globalThis.CHZZK_VIDEO_BITRATE(oh, fps, q) / 8;
        else {
          const src = m.bytes / (m.durationUs / 1e6);                       // 원본 초당 용량 (소리 포함)
          const px = (ow * oh) / (m.video.width * m.video.height);
          bps = src * Math.min(1.5, Math.max(0.15, px)) * (Q_FACTOR[q] / (Q_FACTOR[cfg.videoQuality] || 1)) * (fps > 30 && m.video.fps <= 30 ? 1.4 : 1);
        }
        bytes += bps * len;
      }
      if (seq === estimateSeq) { el.textContent = `예상 약 ${mb(bytes)}`; el.classList.toggle('big', bytes > BIG_MP4); }
      return;
    }
    // WebP: 한 장 시험 압축
    el.textContent = '예상 용량 계산 중…';
    el.classList.remove('big');
    try {
      const tr = S.tracks[segs[0].track];
      const src = tr.isGif ? tr.bmp : tr.el;
      const c = new OffscreenCanvas(ow, oh), x = c.getContext('2d', { alpha: false });
      x.imageSmoothingQuality = 'high';
      if (src) x.drawImage(src, 0, 0, ow, oh);
      const b = await c.convertToBlob({ type: 'image/webp', quality: Number($('gifQ').value) });
      const frames = Math.ceil(dur / gifSpeed() * (Number($('gifFps').value) || 12));
      const bytes = b.size * frames * 1.05;
      if (seq === estimateSeq) { el.textContent = `예상 약 ${mb(bytes)} (${frames}장)`; el.classList.toggle('big', bytes > BIG); }
    } catch (_) {
      if (seq === estimateSeq) el.textContent = '';
    }
  }
  // 저장하기: 창 없이 바로 만들고 진행 상황만 표시
  function openExport() {
    if (!S.tracks.length) return;
    pause();
    $('exportModal').hidden = false;
    startExport();
  }
  function closeExport() { $('exportModal').hidden = true; }
  async function startExport() {
    await X.preparePermission().catch(() => {}); // 선택 폴더 권한은 버튼을 누른 순간에만 요청 가능
    const segs = exportSegments();
    const gif = isGifFormat();
    $('expTitle').textContent = gif ? 'WebP 저장' : '영상(MP4) 저장';
    $('expForm').hidden = true; $('expDone').hidden = true; $('expProgress').hidden = false;
    $('expFill').style.width = '0%';
    exportSignal = { aborted: false };
    const onProgress = (p, text) => { $('expFill').style.width = (p * 100).toFixed(1) + '%'; $('expStep').textContent = text; };
    try {
      const common = { tracks: S.tracks, segments: segs, inT: S.inT, outT: S.outT, signal: exportSignal, onProgress };
      const res = gif
        ? await X.exportWebp({ ...common, crop: S.crop, cropNative: cropNative(), width: Number($('gifWidth').value), fps: Number($('gifFps').value), quality: Number($('gifQ').value), speed: gifSpeed() })
        : await X.exportProgram({ ...common, crop: S.crop, cropNative: cropNative(), height: Number($('expHeight').value), fps: Number($('expFps').value), quality: $('expQuality').value });
      $('expStep').textContent = '저장 중…';
      const tr0 = S.tracks[0];
      const saved = await X.saveOutput(res.blob, outputName(segs), TRIM ? { streamer: tr0.name, channelId: tr0.meta.channelId, sub: broadcastFolder(tr0) } : undefined);
      const size = res.blob.size >= 1048576 ? (res.blob.size / 1048576).toFixed(1) + 'MB' : Math.round(res.blob.size / 1024) + 'KB';
      $('expResult').textContent = gif
        ? `저장 완료 · ${res.srcSeconds && Math.abs(res.srcSeconds - res.seconds) > 0.05 ? `${res.srcSeconds.toFixed(1)}초 → ` : ''}${res.seconds.toFixed(1)}초 · ${res.width}×${res.height} · ${res.frames}장 · ${size}\n${saved}`
        : `저장 완료 · ${res.seconds.toFixed(1)}초 · ${res.width}×${res.height} · ${size} · ${res.codec}\n${saved}`;
      const v = $('expVideo'), img = $('expImage');
      for (const el of [v, img]) if (el.src) URL.revokeObjectURL(el.src);
      v.hidden = gif; img.hidden = !gif;
      (gif ? img : v).src = URL.createObjectURL(res.blob);
      $('expProgress').hidden = true; $('expDone').hidden = false;
      setStatus('내보내기 완료: ' + saved.split('\n')[0], 'ok');
      lastExport = { saved, size: res.blob.size, codec: res.codec, height: res.height, seconds: res.seconds, frames: res.frames };
    } catch (err) {
      $('expProgress').hidden = true; $('expForm').hidden = false;
      $('expInfo').textContent = '내보내기 실패: ' + (err.message || err);
      lastExport = { error: String(err.message || err) };
    }
  }

  // ── 시작 ──
  $('playBtn').addEventListener('click', () => (S.playing ? pause() : play()));
  $('setIn').addEventListener('click', setIn);
  $('setOut').addEventListener('click', setOut);
  $('undoBtn').addEventListener('click', undo);
  $('autoSync').addEventListener('click', autoSync);
  $('exportBtn').addEventListener('click', openExport);
  $('expCancel').addEventListener('click', closeExport);
  $('expStart').addEventListener('click', startExport);
  $('expAbort').addEventListener('click', () => { if (exportSignal) exportSignal.aborted = true; });
  $('expClose').addEventListener('click', closeExport);
  for (const id of ['expHeight', 'gifWidth', 'expFps', 'gifFps', 'expQuality', 'gifSpeed']) $(id).addEventListener('change', refreshExportForm); // 결과 크기·예상 용량 갱신
  $('gifQ').addEventListener('input', refreshExportForm);
  $('modeMp4').addEventListener('click', e => { setMode('mp4'); e.currentTarget.blur(); });
  $('modeGif').addEventListener('click', e => { setMode('gif'); e.currentTarget.blur(); });
  // 지금 위치부터 5 / 10 / 15초
  document.querySelectorAll('.quick button').forEach(b => b.addEventListener('click', e => {
    const len = Number(b.dataset.len);
    pushHistory();
    S.inT = clamp(S.t, 0, Math.max(0, S.L - 0.5));
    S.outT = Math.min(S.L, S.inT + len);
    setStatus(`범위를 ${fmt(S.inT)}부터 ${(S.outT - S.inT).toFixed(1)}초로 정했습니다`, 'ok');
    e.currentTarget.blur();
  }));
  window.addEventListener('resize', resizeTimeline);

  // ── 소리 싱크 (편집): 소리만 앞뒤로 옮김. 미리보기는 옮긴 소리로 다시 포장 ──
  function setupAudioSync(tr) {
    const box = tr.mon.querySelector('.sync');
    if (tr.isGif || !tr.meta.audio) { box.hidden = true; return; }
    box.replaceChildren();
    const mk = (text, d, title) => {
      const b = document.createElement('button');
      b.type = 'button'; b.textContent = text; b.title = title;
      b.addEventListener('click', e => { e.stopPropagation(); set(tr.audioShiftMs + d); });
      return b;
    };
    const input = document.createElement('input');
    input.type = 'number'; input.step = '10'; input.value = '0';
    input.setAttribute('aria-label', '소리 싱크(ms)');
    input.addEventListener('keydown', e => e.stopPropagation());
    input.addEventListener('change', () => set(Number(input.value) || 0));
    box.append('소리 싱크 ', mk('−0.5초', -500, '소리를 0.5초 앞으로'), mk('−', -50, '소리를 0.05초 앞으로'), input, ' ms ', mk('+', 50, '소리를 0.05초 뒤로'), mk('+0.5초', 500, '소리를 0.5초 뒤로'));
    const hint = document.createElement('div');
    hint.className = 'syncHint';
    hint.textContent = '소리가 빠르면 +, 느리면 −';
    box.after(hint);
    tr.a0 = tr.a;
    tr.audioShiftMs = 0;
    const SYNC_MAX_MS = 5000;
    input.min = String(-SYNC_MAX_MS); input.max = String(SYNC_MAX_MS);
    let timer = null;
    function set(ms) {
      ms = Math.max(-SYNC_MAX_MS, Math.min(SYNC_MAX_MS, Math.round(ms / 10) * 10));
      tr.audioShiftMs = ms;
      input.value = String(ms);
      clearTimeout(timer);
      timer = setTimeout(() => apply(ms), 250);
    }
    function apply(ms) {
      const sh = ms * 1000;
      tr.a = tr.a0.map(c => ({ ...c, ts: c.ts + sh })).filter(c => c.ts >= 0 && c.ts < tr.durUs);
      tr.pcm = undefined; // 내보내기용 소리 다시 풀기
      // 미리보기 다시 포장 (재압축 없음)
      const old = tr.url;
      buildPreview(tr);
      if (tr.el) {
        tr.el.src = tr.url;
        tr.el.currentTime = Math.max(0, S.t - tr.pos);
      }
      if (old) setTimeout(() => URL.revokeObjectURL(old), 1000);
      setStatus(ms ? `소리를 ${Math.abs(ms)}ms ${ms > 0 ? '늦췄습니다' : '앞당겼습니다'}` : '소리 싱크를 원래대로 돌렸습니다', 'ok');
    }
  }

  // 편집 모드: 교차편집 전용 버튼 숨김, 처음 범위는 저장 길이
  async function setupTrimMode(when) {
    const tr = S.tracks[0];
    document.title = `편집 · ${tr.name}`;
    document.querySelector('.title h1').textContent = '편집';
    $('sessionInfo').textContent = `${tr.name} · ${when.toLocaleTimeString('ko-KR')}에 가져온 최근 ${S.L.toFixed(1)}초` +
      (tr.isGif ? ' (WebP 버퍼 · 소리 없음)' : '');
    $('autoSync').hidden = true;
    $('exportBtn').textContent = '저장하기';
    setupAudioSync(tr); // 트랙 하나: 방송 간 싱크 대신 소리↔화면 싱크
    tr.mon.title = '';
    const help = document.querySelector('.help');
    help.replaceChildren(...[
      ['Space', ' 재생/멈춤'], ['I', ' / ', 'O', ' 지금 위치를 시작 / 끝으로'],
      ['←', '', '→', ' 0.1초 (Shift 1초) · , . 한 프레임'], ['Home', ' / ', 'End', ' 시작 / 끝으로 이동'],
      ['', '초록 표시를 끌어 범위 조절 · Ctrl+Z 되돌리기']
    ].map(parts => {
      const span = document.createElement('span');
      parts.forEach((p, i) => {
        if (!p) return;
        if (i % 2 === 0 && p.length <= 5) { const k = document.createElement('kbd'); k.textContent = p; span.appendChild(k); }
        else span.appendChild(document.createTextNode(p));
      });
      return span;
    }));
    const cfg = await chrome.storage.sync.get(globalThis.CHZZK_CLIP_DEFAULTS).catch(() => globalThis.CHZZK_CLIP_DEFAULTS);
    const want = tr.isGif ? Number(cfg.clipSeconds) || 5 : Number(cfg.videoSeconds) || 15;
    S.outT = S.L;
    // 녹화에서 왔으면 녹화 버튼을 누른 순간부터 (그 앞은 끌어서 늘릴 수 있음), 아니면 단축키 저장과 같은 마지막 N초
    const press = tr.meta.recPressUs;
    if (params.get('rec') === '1' && Number.isFinite(press)) { S.recMark = tr.pos + press / 1e6; S.inT = clamp(S.recMark, 0, S.L - 0.5); }
    else S.inT = params.get('rec') === '1' ? 0 : Math.max(0, S.L - want);
    S.t = S.inT;
  }

  (async () => {
    try {
      const failures = await load();
      const when = new Date(Number(session));
      $('sessionInfo').textContent =
        `${when.toLocaleTimeString('ko-KR')}에 가져온 장면 · 트랙 ${S.tracks.length}개 · ${S.L.toFixed(1)}초`;
      buildMonitors();
      if (TRIM) await setupTrimMode(when); // 오른쪽 화면 생성 후 (싱크 칸 숨김)
      await initOutputForm();
      $('loading').hidden = true;
      $('app').hidden = false;
      resizeTimeline();
      const notes = [];
      if (failures.length) notes.push(`${failures.length}개 탭은 가져오지 못했습니다 (${failures[0]})`);
      for (const tr of S.tracks) if (tr.isGif && tr.meta.note) notes.push(`${tr.name}: WebP 버퍼로 열었습니다 (소리 없음, ${tr.meta.note})`);
      if (skipped) notes.push(`영상이 꺼졌거나 준비 안 된 탭 ${skipped}개 제외`);
      // 버퍼링으로 소리 시계를 다시 맞춘 횟수 (확인용, 처음 한 번만 표시)
      const fixes = S.tracks.reduce((n, tr) => n + (tr.meta.syncFixes || 0), 0);
      if (fixes) notes.push(`버퍼링 구간 소리 ${fixes}곳 자동 보정`);
      setStatus(notes.length ? notes.join(' · ') : TRIM
        ? '범위를 정하고 "저장하기"를 누르십시오.'
        : '숫자키 1~5로 화면을 전환합니다.', notes.length ? 'warn' : '');
      requestAnimationFrame(tick);
    } catch (err) {
      $('loadingText').textContent = err.message || String(err);
      document.querySelector('.spinner').hidden = true;
    }
  })();
})();
