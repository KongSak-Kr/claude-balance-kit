/*
 * Claude 잔액 키트 — 백그라운드(서비스 워커)
 *
 * 하는 일
 * 1. 사용액 : 설정한 주기(기본 15분) 알람 때만 깨어나 비용 조회 API 를 한 번 부르고 끝난다.
 * 2. 잔액 실측 : 툴바 버튼(팝업)을 눌렀을 때만 결제 페이지를 비활성 탭으로 열어 읽고 바로 닫는다.
 * 3. 부족 알림 : 마지막 실측 잔액 − 실측 이후 사용액 으로 추정해, 기준 이하이면 ! 배지 + 1회 알림.
 *
 * 외부로 나가는 요청은 api.anthropic.com(비용 조회)과 platform.claude.com(결제 페이지 탭) 두 곳뿐이다.
 * 관리자 키는 chrome.storage.local 에만 있고, 로그·콘솔에 찍지 않는다.
 */
'use strict';

importScripts('lib/core.js', 'lib/billing-parse.js');

const C = self.CBK.core;

const ALARM = 'cbk-usage';
const NOTIFY_ID = 'cbk-low-balance';
const CHECK_TIMEOUT_MS = 20000; // 결제 페이지 읽기 최대 20초
const REPEAT_GUARD_MS = 60000; // 1분 안 재확인 막기
const PAGE_LIMIT = 5; // 비용 조회 페이지 최대 5쪽(1쪽 1000행)

const DATE_KEY = /^\d{4}-\d{2}-\d{2}$/;

// ── 저장소 도우미 ──────────────────────────────────────────────────
function get(keys) {
  return chrome.storage.local.get(keys);
}

function set(obj) {
  return chrome.storage.local.set(obj);
}

async function loadSettings() {
  const { settings } = await get('settings');
  return C.normalizeSettings(settings);
}

// ── 알람 ──────────────────────────────────────────────────────────
async function scheduleAlarm() {
  const s = await loadSettings();
  const existing = await chrome.alarms.get(ALARM);
  if (existing && existing.periodInMinutes === s.refreshMinutes) return;
  await chrome.alarms.clear(ALARM);
  await chrome.alarms.create(ALARM, { delayInMinutes: 1, periodInMinutes: s.refreshMinutes });
}

chrome.runtime.onInstalled.addListener(async (details) => {
  await scheduleAlarm();
  await evaluateAlert();
  if (details.reason === 'install') {
    const { adminKey } = await get('adminKey');
    if (!adminKey) chrome.runtime.openOptionsPage();
  }
});

chrome.runtime.onStartup.addListener(async () => {
  await scheduleAlarm();
  await evaluateAlert();
});

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === ALARM) refreshUsage({ force: true });
});

// ── 비용 조회 API ─────────────────────────────────────────────────
function shortDetail(text) {
  try {
    const j = JSON.parse(text);
    if (j && j.error && j.error.message) return String(j.error.message).slice(0, 200);
  } catch (e) {
    /* JSON 아님 */
  }
  return '';
}

async function apiGet(url, adminKey) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 15000);
  try {
    const resp = await fetch(url, {
      method: 'GET',
      headers: C.costHeaders(adminKey),
      signal: ctrl.signal,
      credentials: 'omit',
      cache: 'no-store',
    });
    const text = await resp.text();
    if (!resp.ok) {
      return { ok: false, status: resp.status, code: C.classifyApiError(resp.status, text), detail: shortDetail(text) };
    }
    return { ok: true, json: JSON.parse(text) };
  } catch (e) {
    return { ok: false, status: 0, code: 'network', detail: e && e.name === 'AbortError' ? '응답 시간 초과' : '' };
  } finally {
    clearTimeout(timer);
  }
}

async function fetchCost(adminKey, opts) {
  const range = C.buildCostRange(opts);
  if (!range) return { ok: true, rows: [], dataRefreshedAt: null };
  const rows = [];
  let page = null;
  let refreshed = null;
  for (let i = 0; i < PAGE_LIMIT; i++) {
    const r = await apiGet(C.buildCostUrl(range, page), adminKey);
    if (!r.ok) return r;
    const j = r.json || {};
    if (Array.isArray(j.data)) for (const row of j.data) rows.push(row);
    if (j.data_refreshed_at) refreshed = j.data_refreshed_at;
    if (j.has_more && j.next_page) page = j.next_page;
    else break;
  }
  return { ok: true, rows: rows, dataRefreshedAt: refreshed };
}

let usageInFlight = null;

async function refreshUsage(opts) {
  const force = Boolean(opts && opts.force);
  if (usageInFlight) return usageInFlight;
  usageInFlight = (async () => {
    const { adminKey, usage, balance } = await get(['adminKey', 'usage', 'balance']);
    const now = Date.now();
    if (!adminKey) {
      await set({ usage: Object.assign({}, usage || {}, { error: { code: 'no_admin_key', at: now } }) });
      return { ok: false, code: 'no_admin_key' };
    }
    const last = usage && (usage.attemptedAt || usage.fetchedAt);
    if (!force && last && now - last < REPEAT_GUARD_MS) return { ok: true, skipped: 'recent' };

    const measuredAt = (balance && balance.measuredAt) || null;
    await set({ usage: Object.assign({}, usage || {}, { attemptedAt: now, loading: true }) });
    const res = await fetchCost(adminKey, { now: now, measuredAt: measuredAt });
    if (!res.ok) {
      await set({
        usage: Object.assign({}, usage || {}, {
          attemptedAt: now,
          loading: false,
          error: { code: res.code, status: res.status, detail: res.detail || '', at: now },
        }),
      });
      return { ok: false, code: res.code };
    }
    const sum = C.summarizeCost(res.rows, { now: now, measuredAt: measuredAt });
    await set({
      usage: Object.assign(sum, {
        forMeasuredAt: measuredAt,
        dataRefreshedAt: res.dataRefreshedAt,
        fetchedAt: now,
        attemptedAt: now,
        loading: false,
        error: null,
      }),
    });
    await evaluateAlert();
    return { ok: true };
  })();
  try {
    return await usageInFlight;
  } finally {
    usageInFlight = null;
  }
}

async function testConnection(key) {
  if (!C.looksLikeAdminKey(key)) return { ok: false, code: 'admin_key_format', message: C.messageFor('admin_key_format') };
  const now = Date.now();
  const res = await fetchCost(key, { now: now, measuredAt: null });
  if (!res.ok) {
    return { ok: false, code: res.code, status: res.status, detail: res.detail || '', message: C.messageFor(res.code) };
  }
  const sum = C.summarizeCost(res.rows, { now: now, measuredAt: null });
  return { ok: true, monthCents: sum.monthCents, dataRefreshedAt: res.dataRefreshedAt };
}

// ── 잔액 실측(결제 페이지 탭) ──────────────────────────────────────
let pending = null; // { tabId, done }

async function currentEstimate() {
  const { balance, usage } = await get(['balance', 'usage']);
  return C.estimateBalance(balance, usage, await loadSettings());
}

// 서비스 워커가 확인 도중 꺼졌다 켜졌다면, 남아 있는 확인용 탭을 정리한다.
(async function cleanupStaleCheckTab() {
  try {
    const { checkTabId } = await chrome.storage.session.get('checkTabId');
    if (checkTabId && !pending) {
      await chrome.storage.session.remove('checkTabId');
      await chrome.tabs.remove(checkTabId).catch(() => {});
      const { balanceStatus } = await get('balanceStatus');
      if (balanceStatus && balanceStatus.state === 'checking') {
        await set({ balanceStatus: { state: 'error', code: 'timeout', at: Date.now() } });
      }
    }
  } catch (e) {
    /* 무시 */
  }
})();

async function checkBalance() {
  const now = Date.now();
  if (pending) return { started: false, reason: 'in_progress' };
  const { lastCheckAt } = await get('lastCheckAt');
  if (lastCheckAt && now - lastCheckAt < REPEAT_GUARD_MS) {
    return { started: false, reason: 'recent', waitMs: REPEAT_GUARD_MS - (now - lastCheckAt) };
  }
  await set({ lastCheckAt: now, balanceStatus: { state: 'checking', startedAt: now } });
  runCheck(); // 팝업이 닫혀도 끝까지 진행되고 결과는 저장된다
  return { started: true };
}

async function runCheck() {
  const prevEstimate = await currentEstimate();
  let tab;
  try {
    tab = await chrome.tabs.create({ url: C.BILLING_URL, active: false });
  } catch (e) {
    await finishCheck({ status: 'tab_failed' }, prevEstimate, 'button');
    return;
  }
  await chrome.storage.session.set({ checkTabId: tab.id }).catch(() => {});
  const result = await new Promise((resolve) => {
    const timer = setTimeout(() => done({ status: 'timeout' }), CHECK_TIMEOUT_MS);
    function done(r) {
      clearTimeout(timer);
      pending = null;
      resolve(r);
    }
    pending = { tabId: tab.id, done: done };
  });
  await chrome.tabs.remove(tab.id).catch(() => {});
  await chrome.storage.session.remove('checkTabId').catch(() => {});
  await finishCheck(result, prevEstimate, 'button');
}

const money = (v) => (typeof v === 'number' && Number.isFinite(v) ? Math.round(v * 100) / 100 : null);
const dateKey = (v) => (typeof v === 'string' && DATE_KEY.test(v) ? v : null);
const shortText = (v, n) => (typeof v === 'string' && v ? v.slice(0, n) : null);

// 콘텐츠 스크립트가 보낸 값은 모양을 다시 확인해서 저장한다
function cleanPromo(p) {
  if (!p || typeof p !== 'object' || money(p.total) === null) return null;
  const items = Array.isArray(p.items) ? p.items.slice(0, 10) : [];
  return {
    total: money(p.total),
    count: Number.isInteger(p.count) && p.count >= 0 ? p.count : 0,
    nextExpiry: dateKey(p.nextExpiry),
    nextExpiryAmount: money(p.nextExpiryAmount),
    latestGranted: dateKey(p.latestGranted),
    items: items.map((x) => ({
      name: shortText(x && x.name, 60),
      remaining: money(x && x.remaining),
      granted: money(x && x.granted),
      expires: dateKey(x && x.expires),
      grantedAt: dateKey(x && x.grantedAt),
      appliesTo: shortText(x && x.appliesTo, 80),
      expired: Boolean(x && x.expired),
    })),
  };
}

function cleanResult(r) {
  const out = { status: typeof r.status === 'string' ? r.status : 'parse_failed' };
  if (money(r.balance) !== null) out.balance = money(r.balance);
  const promo = cleanPromo(r.promo);
  if (promo) out.promo = promo;
  if (dateKey(r.latestRecharge)) out.latestRecharge = r.latestRecharge;
  return out;
}

async function finishCheck(rawResult, prevEstimate, source) {
  const result = cleanResult(rawResult || {});
  const now = Date.now();
  const settings = await loadSettings();
  const st = await get(['recharge', 'alert']);
  const recharge = st.recharge || {};
  if (result.latestRecharge) recharge.history = { date: result.latestRecharge, seenAt: now };

  if (result.promo && result.promo.latestGranted) recharge.promo = { date: result.promo.latestGranted, seenAt: now };

  if (result.status === 'ok' && (typeof result.balance === 'number' || result.promo)) {
    const alert = st.alert || {};
    const balance = {
      value: typeof result.balance === 'number' ? result.balance : null,
      promo: result.promo || null,
      measuredAt: now,
      source: source,
    };
    const measured = C.primaryOf(balance, settings).value;
    const recharged = C.detectRecharge(prevEstimate, measured, 1);
    if (recharged) {
      recharge.auto = { date: C.localDateKey(now), amount: Math.round((measured - prevEstimate) * 100) / 100 };
    }
    // 충전되었거나 기준보다 많으면 알림 상태 초기화
    if (recharged || !C.isLow(measured, settings)) alert.notified = false;
    await set({
      balance: balance,
      recharge: recharge,
      alert: alert,
      balanceStatus: { state: 'ok', at: now, source: source },
    });
    await evaluateAlert();
    return;
  }

  if (source === 'page') {
    // 사용자가 직접 연 결제 페이지에서 못 읽은 경우 : 충전 내역만 저장하고 상태는 건드리지 않는다.
    await set({ recharge: recharge });
    return;
  }
  await set({
    recharge: recharge,
    balanceStatus: { state: 'error', code: C.balanceErrorCode(result.status), parseStatus: result.status, at: now },
  });
}

async function handleBillingResult(msg, sender) {
  const r = (msg && msg.result) || {};
  if (pending && sender.tab && sender.tab.id === pending.tabId) {
    pending.done(r);
    return;
  }
  // 사용자가 결제 페이지를 직접 연 경우
  if (r.status === 'ok' || r.latestRecharge) {
    await finishCheck(r, await currentEstimate(), 'page');
  }
}

// 확인용 탭이 로그인 화면(다른 주소)으로 넘어가거나 닫히면 바로 결과를 정한다.
chrome.tabs.onUpdated.addListener((tabId, info) => {
  if (!pending || tabId !== pending.tabId || !info.url) return;
  const url = info.url;
  if (url.indexOf(C.BILLING_URL) === 0) return;
  if (self.CBK.billing.looksLikeLoginUrl(url)) pending.done({ status: 'login_required' });
});

chrome.tabs.onRemoved.addListener((tabId) => {
  if (pending && tabId === pending.tabId) pending.done({ status: 'tab_closed' });
});

// ── 배지 · 알림 ───────────────────────────────────────────────────
// 여러 곳(사용액 갱신·잔액 확인·설정 변경)에서 동시에 불려도 한 번에 하나씩 처리해 알림이 겹치지 않게 한다.
let alertChain = Promise.resolve();
function evaluateAlert() {
  alertChain = alertChain.then(evaluateAlertNow, evaluateAlertNow);
  return alertChain;
}

async function evaluateAlertNow() {
  const settings = await loadSettings();
  const { balance, usage, alert } = await get(['balance', 'usage', 'alert']);
  const a = alert || {};
  const est = C.estimateBalance(balance, usage, settings);
  const low = C.isLow(est, settings);
  const label = C.primaryOf(balance, settings).label;
  if (low) {
    await chrome.action.setBadgeBackgroundColor({ color: '#C62828' });
    if (chrome.action.setBadgeTextColor) await chrome.action.setBadgeTextColor({ color: '#FFFFFF' });
    await chrome.action.setBadgeText({ text: '!' });
    await chrome.action.setTitle({ title: 'Claude 잔액 — 잔액 부족 가능성, 눌러서 확인' });
    if (!a.notified) {
      a.notified = true;
      a.notifiedAt = Date.now();
      await chrome.notifications
        .create(NOTIFY_ID, {
          type: 'basic',
          iconUrl: 'icons/icon128.png',
          title: 'Claude 잔액 부족 알림',
          message:
            '추정 ' + label + '이 기준(' + C.formatUSD(settings.threshold) + ') 이하입니다. 툴바의 잔액 버튼을 눌러 실제 잔액을 확인해 보세요.',
          priority: 1,
        })
        .catch(() => {}); // 운영체제 알림이 꺼져 있어도 배지는 남는다
    }
  } else {
    await chrome.action.setBadgeText({ text: '' });
    await chrome.action.setTitle({ title: 'Claude 잔액 확인' });
  }
  a.low = low;
  await set({ alert: a });
}

chrome.notifications.onClicked.addListener((id) => {
  if (id !== NOTIFY_ID) return;
  chrome.notifications.clear(id);
  chrome.tabs.create({ url: C.BILLING_URL, active: true });
});

// ── 메시지 ───────────────────────────────────────────────────────
function fromExtensionPage(sender) {
  return sender && sender.id === chrome.runtime.id && typeof sender.url === 'string' && sender.url.indexOf(chrome.runtime.getURL('')) === 0;
}

function fromBillingSite(sender) {
  return sender && sender.id === chrome.runtime.id && typeof sender.url === 'string' && sender.url.indexOf('https://platform.claude.com/') === 0;
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg || typeof msg.type !== 'string') return false;

  if (msg.type === 'billing-result') {
    if (fromBillingSite(sender)) handleBillingResult(msg, sender);
    return false;
  }

  if (!fromExtensionPage(sender)) return false;

  switch (msg.type) {
    case 'check-now':
      checkBalance().then((b) => sendResponse({ balance: b }));
      refreshUsage({ force: false });
      return true;
    case 'refresh-usage':
      refreshUsage({ force: Boolean(msg.force) }).then(sendResponse);
      return true;
    case 'test-connection':
      testConnection(String(msg.key || '')).then(sendResponse);
      return true;
    case 'settings-changed':
      Promise.all([scheduleAlarm(), evaluateAlert()]).then(() => sendResponse({ ok: true }));
      return true;
    case 'key-saved':
      refreshUsage({ force: true }).then(sendResponse);
      return true;
    default:
      return false;
  }
});
