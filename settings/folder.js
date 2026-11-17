// 저장 폴더 선택 페이지 (팝업에서 폴더 선택 창을 열면 팝업이 닫히므로 별도 탭)
//   folder.html            → 기본 저장 폴더 (안에 스트리머별 폴더 생성)
//   folder.html?channel=ID → 채널 전용 폴더 (스트리머 폴더 없이 바로 저장)
(() => {
  'use strict';
  const Store = globalThis.ChzzkHandleStore;
  const Channels = globalThis.ChzzkChannels;
  const $ = id => document.getElementById(id);
  const params = new URLSearchParams(location.search);
  const channelId = /^[0-9a-f]{32}$/i.test(params.get('channel') || '') ? params.get('channel') : null;
  const channelName = params.get('name') || '이 채널';

  if (channelId) {
    document.title = `${channelName} 저장 폴더 · cheese-clip`;
    $('title').textContent = `"${channelName}" 채널 저장 폴더`;
    $('lead').textContent = `이 채널만 따로 저장할 폴더를 고릅니다.`;
    $('clear').textContent = '기본 위치로 되돌리기';
  }

  async function refresh() {
    const dir = await Store.get(channelId || undefined).catch(() => null);
    const perm = await Store.permission(dir);
    $('current').textContent = dir ? dir.name : (channelId ? '기본 위치 사용 중' : '선택된 폴더 없음');
    const st = $('state');
    if (!dir) { st.className = 'state'; st.textContent = ''; }
    else if (perm === 'granted') { st.className = 'state ok'; st.textContent = '✓ 사용 가능'; }
    else { st.className = 'state warn'; st.textContent = '권한이 필요합니다.'; }
    $('grant').hidden = !dir || perm === 'granted';
    $('clear').hidden = !dir;
  }

  $('pick').addEventListener('click', async () => {
    if (typeof showDirectoryPicker !== 'function') {
      $('done').textContent = '이 크롬 버전은 폴더 선택을 지원하지 않습니다. 크롬을 업데이트하십시오.';
      return;
    }
    try {
      const old = await Store.get(channelId || undefined).catch(() => null);
      const dir = await showDirectoryPicker({ id: channelId ? 'chzzk-ch' : 'chzzk-clip', mode: 'readwrite', startIn: old || 'videos' });
      await Store.set(dir, channelId || undefined);
      if (channelId) await Channels.update(channelId, { folder: 'custom', name: params.get('name') || undefined });
      else await chrome.storage.sync.set({ saveMode: 'picked' }); // 고르면 바로 '선택한 폴더' 방식으로
      $('done').textContent = `"${dir.name}" 폴더로 정했습니다.`;
    } catch (err) {
      if (err && err.name === 'AbortError') return; // 선택 취소
      $('done').textContent = '폴더를 고르지 못했습니다: ' + ((err && err.message) || err);
    }
    refresh();
  });

  $('grant').addEventListener('click', async () => {
    const dir = await Store.get(channelId || undefined).catch(() => null);
    if (!dir) return;
    try {
      const r = await dir.requestPermission({ mode: 'readwrite' });
      $('done').textContent = r === 'granted' ? '권한을 허용했습니다. 이 탭은 닫아도 됩니다.' : '권한을 허용하지 않았습니다.';
    } catch (err) {
      $('done').textContent = '권한 요청 실패: ' + ((err && err.message) || err);
    }
    refresh();
  });

  $('clear').addEventListener('click', async () => {
    await Store.clear(channelId || undefined);
    if (channelId) {
      await Channels.update(channelId, { folder: null });
      $('done').textContent = '이 채널은 다시 기본 저장 위치를 사용합니다.';
    } else {
      await chrome.storage.sync.set({ saveMode: 'downloads' });
      $('done').textContent = '선택을 해제했습니다. 다운로드/cheese-clip에 저장됩니다.';
    }
    refresh();
  });

  // #grant로 열리면 권한 버튼 강조
  if (location.hash === '#grant') $('grant').classList.add('primary');
  refresh();
})();
