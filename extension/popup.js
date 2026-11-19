/*
 * Claude 잔액 키트 — 팝업
 *
 * 흐름
 * 1. 열리자마자 지난번 잔액을 회색으로 보여 주고 "잔액 확인 중…" 표시
 * 2. 백그라운드에 확인을 요청 → 결제 페이지를 비활성 탭으로 열어 읽고 닫는다
 * 3. 결과가 저장되면(storage 변경) 진한 글씨로 바꾸고 "방금 확인"
 *    팝업을 닫아도 확인은 백그라운드에서 끝까지 진행된다.
 * 4. 1분 안에 다시 누르면 새로 확인하지 않고 저장된 값만 보여 준다.
 */
'use strict';

const C = globalThis.CBK.core;
const $ = (id) => document.getElementById(id);
const KEYS = ['adminKey', 'balance', 'balanceStatus', 'usage', 'recharge', 'settings', 'alert', 'lastCheckAt'];
const CHECK_STALE_MS = 30000; // 30초 넘게 "확인 중"이면 멈춘 것으로 본다

let state = {};
let lastRequest = null; // 백그라운드 응답 { started, reason, waitMs }
let lastRequestAt = 0;
let awaitingResponse = true; // 팝업을 연 직후 백그라운드 응답 전까지는 "확인 중"으로 보여 준다

async function load() {
  state = await chrome.storage.local.get(KEYS);
  state.hasKey = Boolean(state.adminKey);
  delete state.adminKey; // 팝업에서는 키 자체가 필요 없다
  render();
}

function isChecking(now) {
  if (awaitingResponse) return true;
  const st = state.balanceStatus;
  return Boolean(st && st.state === 'checking' && now - (st.startedAt || 0) < CHECK_STALE_MS);
}

function renderBalance(now) {
  const b = state.balance;
  const st = state.balanceStatus || {};
  const checking = isChecking(now);
  const settings = C.normalizeSettings(state.settings);
  const primary = C.primaryOf(b, settings);
  const secondary = C.secondaryOf(b, settings);
  $('balance-label').textContent = b ? primary.label : '잔액';
  const el = $('balance');
  el.textContent = b && typeof primary.value === 'number' ? C.formatUSD(primary.value) : '—';
  const fresh = b && !checking && st.state === 'ok' && st.at === b.measuredAt;
  el.classList.toggle('stale', !fresh);

  const sub = $('balance-sub');
  sub.classList.toggle('hidden', !secondary);
  if (secondary) sub.textContent = secondary.label + ' ' + C.formatUSD(secondary.value);

  // 프로모션 크레딧 만료 안내 (가장 빨리 만료되는 것)
  const note = $('promo-note');
  const promo = b && C.hasPromo(b) ? b.promo : null;
  const showNote = Boolean(promo && promo.nextExpiry);
  note.classList.toggle('hidden', !showNote);
  if (showNote) {
    let t = '프로모션 만료 ' + C.formatDateKeyKo(promo.nextExpiry);
    if (typeof promo.nextExpiryAmount === 'number' && promo.count > 1) t += ' (' + C.formatUSD(promo.nextExpiryAmount) + ')';
    if (promo.count > 1) t += ' · ' + promo.count + '건';
    const days = Math.round((Date.parse(promo.nextExpiry + 'T00:00:00') - C.startOfLocalDay(now)) / C.DAY);
    if (days >= 0 && days <= 30) t += ' · ' + (days === 0 ? '오늘' : days + '일 남음');
    note.textContent = t;
  }

  const when = $('balance-when');
  if (b) {
    const recent = now - b.measuredAt < 60000;
    const src = b.source === 'page' ? ' · 결제 페이지에서 읽음' : '';
    when.textContent = C.formatWhenKo(b.measuredAt, now) + ' 확인 · ' + (recent ? '방금 확인' : C.formatAgoKo(b.measuredAt, now)) + src;
  } else {
    when.textContent = '아직 확인한 잔액이 없습니다.';
  }

  const status = $('balance-status');
  status.className = 'status';
  status.textContent = '';
  if (checking) {
    const sp = document.createElement('span');
    sp.className = 'spinner';
    status.appendChild(sp);
    status.appendChild(document.createTextNode('잔액 확인 중… (결제 페이지 탭이 잠깐 열렸다 닫힙니다)'));
    return;
  }
  if (st.state === 'error') {
    status.classList.add('msg-error');
    status.textContent = C.messageFor(st.code);
    return;
  }
  if (lastRequest && lastRequest.reason === 'recent' && now - lastRequestAt < 10000) {
    status.classList.add('note');
    const sec = Math.max(1, Math.ceil((lastRequest.waitMs || 0) / 1000));
    status.textContent = '1분 안에 이미 확인했습니다. 저장된 값을 보여 드립니다(' + sec + '초 뒤 다시 확인 가능).';
  }
}

function renderUsage(now) {
  const u = state.usage || {};
  const noKey = !state.hasKey;
  $('no-key').classList.toggle('hidden', !noKey);
  $('usage-rows').classList.toggle('hidden', noKey);
  const note = $('usage-note');
  note.className = 'note';
  if (noKey) {
    note.textContent = '';
    return;
  }
  const has = typeof u.monthCents === 'number';
  $('u-today').textContent = has ? C.formatCents(u.todayCents) : '—';
  $('u-week').textContent = has ? C.formatCents(u.weekCents) : '—';
  $('u-month').textContent = has ? C.formatCents(u.monthCents) : '—';
  $('usage-rows').classList.toggle('loading', Boolean(u.loading));

  if (u.error) {
    note.className = 'msg-error';
    note.textContent = C.messageFor(u.error.code) + (u.error.detail ? ' (' + u.error.detail + ')' : '');
    return;
  }
  if (u.loading && !has) {
    note.textContent = '사용액 불러오는 중…';
    return;
  }
  if (!has) {
    note.textContent = '';
    return;
  }
  const lag = '비용 데이터는 보통 4시간(최대 24시간) 늦게 반영됩니다.';
  note.textContent = u.dataRefreshedAt
    ? C.formatWhenKo(Date.parse(u.dataRefreshedAt), now) + '까지 반영됨 · ' + lag
    : '아직 반영된 비용 데이터가 없습니다. ' + lag;
}

function renderRecharge() {
  const settings = C.normalizeSettings(state.settings);
  const r = C.pickLatestRecharge(state.recharge, settings.manualRechargeDate);
  $('recharge-date').textContent = r ? C.formatDateKeyKo(r.date) : '—';
  $('recharge-src').textContent = r ? r.sourceLabel : '설정에서 직접 입력 가능';
}

function renderBanner() {
  const settings = C.normalizeSettings(state.settings);
  const low = state.alert && state.alert.low && settings.alertEnabled;
  const el = $('low-banner');
  el.classList.toggle('hidden', !low);
  if (low) {
    const label = C.primaryOf(state.balance, settings).label;
    el.textContent =
      '추정 ' + label + '이 기준(' + C.formatUSD(settings.threshold) + ') 이하일 수 있습니다. 결제 페이지에서 잔액과 충전 여부를 확인해 보세요.';
  }
}

function render() {
  const now = Date.now();
  renderBanner();
  renderBalance(now);
  renderUsage(now);
  renderRecharge();
  $('recheck').disabled = isChecking(now);
}

function requestCheck() {
  awaitingResponse = true;
  render();
  chrome.runtime.sendMessage({ type: 'check-now' }, (resp) => {
    awaitingResponse = false;
    if (chrome.runtime.lastError) {
      render();
      return;
    }
    lastRequest = resp && resp.balance;
    lastRequestAt = Date.now();
    render();
  });
}

function openOptions() {
  chrome.runtime.openOptionsPage();
  window.close();
}

$('recheck').addEventListener('click', requestCheck);
$('open-billing').addEventListener('click', () => {
  chrome.tabs.create({ url: C.BILLING_URL, active: true });
  window.close();
});
$('open-options').addEventListener('click', openOptions);
$('open-options-2').addEventListener('click', openOptions);

chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'local') load();
});

setInterval(render, 1000); // "방금 확인", "n분 전" 같은 글자 갱신

load().then(requestCheck);
