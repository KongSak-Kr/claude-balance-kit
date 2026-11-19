/*
 * Claude 잔액 키트 — 설정 화면
 * 관리자 키는 chrome.storage.local 에만 저장한다(sync 사용 안 함).
 */
'use strict';

const C = globalThis.CBK.core;
const $ = (id) => document.getElementById(id);

function manualUrl(anchor) {
  const repo = (globalThis.CBK_KIT && globalThis.CBK_KIT.repo) || '';
  if (!/^[A-Za-z0-9-]+\/[A-Za-z0-9._-]+$/.test(repo) || repo.indexOf('YOUR_') === 0) return null;
  return 'https://github.com/' + repo + '/blob/main/manual/' + encodeURIComponent('설치안내서.md') + '#' + encodeURIComponent(anchor);
}

function setResult(el, kind, text) {
  el.className = 'result ' + (kind === 'ok' ? 'msg-ok' : kind === 'warn' ? 'msg-warn' : kind === 'error' ? 'msg-error' : 'note');
  el.textContent = text;
}

async function loadAll() {
  const { adminKey, settings, keySavedAt } = await chrome.storage.local.get(['adminKey', 'settings', 'keySavedAt']);
  const s = C.normalizeSettings(settings);
  $('alert-enabled').checked = s.alertEnabled;
  $('threshold').value = String(s.threshold);
  $('refresh-minutes').value = String(s.refreshMinutes);
  $('manual-date').value = s.manualRechargeDate || '';
  $('key-saved').textContent = adminKey
    ? '저장된 관리자 키가 있습니다' + (keySavedAt ? ' (' + C.formatWhenKo(keySavedAt, Date.now()) + ' 저장)' : '') + '. 바꾸려면 새 키를 붙여 넣고 연결 확인을 누르세요.'
    : '저장된 관리자 키가 없습니다.';
  $('delete-key').disabled = !adminKey;
}

function send(msg) {
  return new Promise((resolve) => {
    chrome.runtime.sendMessage(msg, (resp) => {
      if (chrome.runtime.lastError) resolve({ ok: false, code: 'unknown', message: '백그라운드와 연결하지 못했습니다. 확장을 새로고침해 보세요.' });
      else resolve(resp);
    });
  });
}

async function testKey() {
  const typed = $('admin-key').value.trim();
  const out = $('key-result');
  let key = typed;
  if (!key) {
    const stored = await chrome.storage.local.get('adminKey');
    key = stored.adminKey || '';
  }
  if (!key) {
    setResult(out, 'error', '관리자 키를 먼저 붙여 넣어 주세요.');
    return;
  }
  if (!C.looksLikeAdminKey(key)) {
    setResult(out, 'error', C.messageFor('admin_key_format'));
    return;
  }
  $('test-key').disabled = true;
  setResult(out, 'note', '연결 확인 중… (비용 조회 API 를 한 번 호출합니다)');
  const r = await send({ type: 'test-connection', key: key });
  $('test-key').disabled = false;
  if (!r || !r.ok) {
    const detail = r && r.detail ? ' — 상세 : ' + r.detail : '';
    const status = r && r.status ? ' [HTTP ' + r.status + ']' : '';
    setResult(out, 'error', ((r && r.message) || C.messageFor('unknown')) + status + detail);
    return;
  }
  if (typed) {
    await chrome.storage.local.set({ adminKey: typed, keySavedAt: Date.now() });
    $('admin-key').value = '';
    $('admin-key').type = 'password';
    $('toggle-key').textContent = '보이기';
  }
  const refreshed = r.dataRefreshedAt ? C.formatWhenKo(Date.parse(r.dataRefreshedAt), Date.now()) + '까지 반영' : '아직 반영된 데이터 없음';
  setResult(
    out,
    'ok',
    '연결됨' + (typed ? ' — 키를 저장했습니다' : '') + '. 이번 달 사용액 ' + C.formatCents(r.monthCents) + ' (' + refreshed + ').',
  );
  await loadAll();
  send({ type: 'key-saved' });
}

async function deleteKey() {
  if (!confirm('저장된 관리자 키를 삭제할까요? 사용액 조회와 부족 알림이 멈춥니다.')) return;
  await chrome.storage.local.remove(['adminKey', 'keySavedAt', 'usage']);
  setResult($('key-result'), 'note', '관리자 키를 삭제했습니다.');
  await loadAll();
  send({ type: 'settings-changed' });
}

async function saveSettings() {
  const th = Number($('threshold').value);
  if (!Number.isFinite(th) || th < 0) {
    setResult($('save-result'), 'error', '알림 기준 금액은 0 이상의 숫자로 넣어 주세요.');
    return;
  }
  const date = $('manual-date').value || null;
  const settings = C.normalizeSettings({
    alertEnabled: $('alert-enabled').checked,
    threshold: th,
    refreshMinutes: Number($('refresh-minutes').value),
    manualRechargeDate: date,
  });
  const { alert } = await chrome.storage.local.get('alert');
  const a = alert || {};
  a.notified = false; // 기준이 바뀌면 다시 알릴 수 있게
  await chrome.storage.local.set({ settings: settings, alert: a });
  await send({ type: 'settings-changed' });
  $('save-result').className = 'note msg-ok';
  $('save-result').textContent = '저장했습니다.';
  setTimeout(() => ($('save-result').textContent = ''), 3000);
}

$('toggle-key').addEventListener('click', () => {
  const input = $('admin-key');
  const show = input.type === 'password';
  input.type = show ? 'text' : 'password';
  $('toggle-key').textContent = show ? '숨기기' : '보이기';
});
$('test-key').addEventListener('click', testKey);
$('admin-key').addEventListener('keydown', (e) => {
  if (e.key === 'Enter') testKey();
});
$('delete-key').addEventListener('click', deleteKey);
$('clear-date').addEventListener('click', () => ($('manual-date').value = ''));
$('save-settings').addEventListener('click', saveSettings);

$('admin-keys-link').href = C.ADMIN_KEYS_URL;
const m = manualUrl('6-관리자-키-받기');
if (m) $('manual-link').href = m;
else $('manual-link').replaceWith(document.createTextNode('설치안내서 6단계(manual/설치안내서.md)'));

loadAll();
