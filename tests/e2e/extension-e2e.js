/*
 * 크롬 확장 동작 시험 (개발용) — 실제 크로미움에 확장을 올려 자동으로 눌러 본다.
 * 비용 조회 API 와 결제 페이지는 가짜 응답으로 바꿔 끼운다(실제 키·계정 불필요).
 *
 *   준비 : npm i -D playwright && npx playwright install chromium   (이미 있으면 생략)
 *   실행 : node tests/e2e/extension-e2e.js [스크린샷 폴더]
 */
'use strict';

process.env.PW_EXPERIMENTAL_SERVICE_WORKER_NETWORK_EVENTS = '1'; // 서비스 워커 요청도 가로채기
process.env.TZ = process.env.TZ || 'Asia/Seoul';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const assert = require('node:assert/strict');
const { chromium } = require('playwright');

const ROOT = path.resolve(__dirname, '..', '..');
const EXT = path.join(ROOT, 'extension');
const FIX = path.join(ROOT, 'tests', 'fixtures');
const SHOTS = process.argv[2] || path.join(ROOT, 'tests', 'screenshots');
const FAKE_ADMIN_KEY = ['sk', 'ant', 'admin01', 'e2e' + 'x'.repeat(40)].join('-'); // 가짜

// ── 가짜 서버 상태 ─────────────────────────────────────────────────
const mock = {
  api: 'ok', // ok | 401 | 403 | network | 500
  billing: 'ok', // ok | login | changed | loading | hang
  balance: '$42.18',
  delayMs: 800, // 결제 페이지가 금액을 늦게 그리는 시간
  extraSinceCents: 0, // 실측 이후 사용액(센트)
  promo: false, // 프로모션 크레딧 표 넣기
  apiCalls: 0,
  billingLoads: 0,
};

function costRows() {
  const now = Date.now();
  const hour = Math.floor(now / 3600000) * 3600000;
  const rows = [
    { h: hour - 2 * 3600000, c: 120 }, // 두 시간 전
    { h: hour - 30 * 3600000, c: 245 }, // 어제쯤
    { h: hour - 9 * 24 * 3600000, c: 1000 }, // 9일 전(달이 바뀌었으면 제외될 수 있음)
  ];
  if (mock.extraSinceCents) rows.push({ h: hour, c: mock.extraSinceCents });
  return rows.map((r) => ({
    starting_at: new Date(r.h).toISOString().replace('.000Z', 'Z'),
    ending_at: new Date(r.h + 3600000).toISOString().replace('.000Z', 'Z'),
    group: {},
    cost: { currency: 'USD', amount: r.c.toFixed(6), list_amount: r.c.toFixed(6), requests: 3 },
  }));
}

function billingHtml() {
  if (mock.billing === 'login') return fs.readFileSync(path.join(FIX, 'billing-login-real.html'), 'utf8');
  if (mock.billing === 'changed') return fs.readFileSync(path.join(FIX, 'billing-changed.html'), 'utf8');
  if (mock.billing === 'loading') return fs.readFileSync(path.join(FIX, 'billing-loading.html'), 'utf8');
  // 실제 화면처럼 처음엔 "Loading" 이었다가 잠시 뒤 금액이 그려진다
  return `<!doctype html><html><body><main><h1>Billing</h1>
  <section><h2>Credit balance</h2><div>Credits are used by the API, Claude Code, and playground.</div>
  <div id="card">Loading</div>
  <p>Auto-reload is on. Your balance will be topped up to $50.00 when your balance falls below $10.00.</p></section>
  ${mock.promo ? `<section><h2>Promotional credits</h2><div>Promotional credits granted to your organization. All dates are in UTC.</div>
  <table aria-label="Promotional credits"><thead><tr><th>Name</th><th>Remaining balance</th><th>Applies to</th><th>Expires on</th><th>Date granted</th></tr></thead>
  <tbody>
  <tr><td>Startup program</td><td><div><svg width="20" height="20"></svg><span>$37.50 <span>of $50.00</span></span></div></td><td><div style="display:flex;flex-direction:column"><span>Claude Opus 5.5</span><span>API</span></div></td><td>Dec 31, 2099, 23:59 UTC</td><td>Nov 12, 2026</td></tr>
  <tr><td>Promotional credit</td><td><span>$4.25 remaining</span></td><td>All models and products</td><td>Jan 15, 2100, 23:59 UTC</td><td>Oct 10, 2026</td></tr>
  <tr><td>Old bonus</td><td><span>$9.00 <span>of $10.00</span></span></td><td>All models and products</td><td>Jan 1, 2020, 23:59 UTC</td><td>Dec 1, 2019</td></tr>
  </tbody></table></section>` : ''}
  <section><h2>Invoice history</h2><table><tr><td>Nov 3, 2026</td><td>INV-1</td><td>Credit grant</td><td>$50.00</td><td>Paid</td></tr></table></section>
  </main><script>setTimeout(function(){document.getElementById('card').innerHTML='<span>${mock.balance}</span>';}, ${mock.delayMs});</script>
  </body></html>`;
}

// ── 가짜 HTTPS 서버 (api.anthropic.com · platform.claude.com 역할) ──────────
const https = require('node:https');
const { execFileSync } = require('node:child_process');
const hanging = [];

function apiHandler(req, res) {
  mock.apiCalls++;
  const send = (status, obj) => {
    res.writeHead(status, { 'content-type': 'application/json' });
    res.end(JSON.stringify(obj));
  };
  const h = req.headers;
  if (mock.api === 'network') return req.socket.destroy();
  if (h['anthropic-beta'] !== 'analytics-usage-cost-2026-08-24' || !h['x-api-key'] || h['anthropic-version'] !== '2026-10-21') {
    return send(400, { type: 'error', error: { type: 'invalid_request_error', message: 'missing header' } });
  }
  if (!req.url.startsWith('/v1/organizations/analytics/cost?')) return send(404, { type: 'error', error: { type: 'not_found_error', message: req.url } });
  if (mock.api === '401') return send(401, { type: 'error', error: { type: 'authentication_error', message: 'invalid x-api-key' } });
  if (mock.api === '403') return send(403, { type: 'error', error: { type: 'permission_error', message: 'not allowed' } });
  if (mock.api === '500') return send(500, { type: 'error', error: { type: 'api_error', message: 'oops' } });
  const refreshed = new Date(Date.now() - 4 * 3600000).toISOString().replace(/\.\d+Z$/, 'Z');
  return send(200, { data: costRows(), has_more: false, next_page: null, data_refreshed_at: refreshed });
}

function siteHandler(req, res) {
  if (!req.url.startsWith('/settings/billing')) {
    res.writeHead(404);
    return res.end();
  }
  mock.billingLoads++;
  if (mock.billing === 'hang') return hanging.push(res); // 응답하지 않음 → 20초 제한 시험
  res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
  res.end(billingHtml());
}

async function startFakeServers(dir) {
  const key = path.join(dir, 'fake-key.pem');
  const cert = path.join(dir, 'fake-cert.pem');
  execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '1', '-subj', '/CN=platform.claude.com',
    '-addext', 'subjectAltName=DNS:platform.claude.com,DNS:api.anthropic.com', '-keyout', key, '-out', cert], { stdio: 'ignore' });
  const server = https.createServer({ key: fs.readFileSync(key), cert: fs.readFileSync(cert) }, (req, res) => {
    const host = String(req.headers.host || '').split(':')[0];
    if (host === 'api.anthropic.com') return apiHandler(req, res);
    if (host === 'platform.claude.com') return siteHandler(req, res);
    res.writeHead(421);
    res.end();
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  startFakeServers.server = server;
  return server.address().port;
}

// ── 도우미 ───────────────────────────────────────────────────────
async function waitFor(fn, ms, what) {
  const end = Date.now() + (ms || 15000);
  let last;
  while (Date.now() < end) {
    try {
      last = await fn();
      if (last) return last;
    } catch (e) {
      last = e;
    }
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error('시간 초과 : ' + (what || '') + ' (마지막 값 : ' + JSON.stringify(last) + ')');
}

let results = [];
async function step(name, fn) {
  try {
    await fn();
    results.push([true, name]);
    console.log('  통과 · ' + name);
  } catch (e) {
    results.push([false, name]);
    console.log('  실패 · ' + name + '\n         ' + (e && e.message ? e.message.split('\n').slice(0, 6).join('\n         ') : e));
  }
}

(async () => {
  fs.mkdirSync(SHOTS, { recursive: true });
  const userDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cbk-e2e-'));
  const port = await startFakeServers(userDir);
  const context = await chromium.launchPersistentContext(userDir, {
    channel: 'chromium',
    headless: true,
    locale: 'ko-KR',
    timezoneId: 'Asia/Seoul',
    deviceScaleFactor: Number(process.env.CBK_SHOT_SCALE || 1), // 사람이 볼 스크린샷은 2
    args: [
      '--disable-extensions-except=' + EXT,
      '--load-extension=' + EXT,
      // 두 주소를 이 컴퓨터의 가짜 HTTPS 서버로 돌린다(확장이 연 탭의 첫 요청까지 확실히 가로채기 위해)
      '--host-resolver-rules=MAP platform.claude.com 127.0.0.1:' + port + ', MAP api.anthropic.com 127.0.0.1:' + port,
      '--ignore-certificate-errors',
      '--no-proxy-server',
    ],
  });

  // 확장(서비스 워커·확장 페이지)이 보낸 요청의 주소만 모은다. 결제 페이지 자체가 부르는 것은 콘솔 사이트의 몫.
  const hosts = new Set();
  context.on('request', (r) => {
    const u = new URL(r.url());
    if (u.protocol !== 'https:' && u.protocol !== 'http:') return;
    let from = '';
    try {
      from = r.serviceWorker() ? 'sw' : r.frame().url();
    } catch (e) {
      from = '';
    }
    if (from === 'sw' || from.startsWith('chrome-extension://')) hosts.add(u.hostname);
  });

  let sw = context.serviceWorkers()[0];
  if (!sw) sw = await context.waitForEvent('serviceworker');
  const extId = sw.url().split('/')[2];
  const store = (keys) => sw.evaluate((k) => chrome.storage.local.get(k), keys);
  const setStore = (obj) => sw.evaluate((o) => chrome.storage.local.set(o), obj);
  const badge = () => sw.evaluate(() => chrome.action.getBadgeText({}));
  const notifs = () => sw.evaluate(() => chrome.notifications.getAll());
  const billingTabs = () => context.pages().filter((p) => p.url().startsWith('https://platform.claude.com'));

  async function openPopup() {
    const p = await context.newPage();
    await p.setViewportSize({ width: 340, height: 520 });
    await p.goto('chrome-extension://' + extId + '/popup.html');
    return p;
  }
  async function shot(page, name) {
    const buf = await page.screenshot({ fullPage: true });
    fs.writeFileSync(path.join(SHOTS, name), buf);
  }

  console.log('▶ 확장 로드 (ID ' + extId + ')');

  await step('설치 직후 설정 화면이 자동으로 열림', async () => {
    await waitFor(() => context.pages().some((p) => p.url().includes('/options.html')), 8000, 'options 탭');
  });

  await step('15분 사용액 알람 등록', async () => {
    const a = await waitFor(() => sw.evaluate(() => chrome.alarms.get('cbk-usage')), 5000, 'alarm');
    assert.equal(a.periodInMinutes, 15);
  });

  // ── 설정 화면 ──
  const opt = await context.newPage();
  await opt.setViewportSize({ width: 760, height: 1100 });
  await opt.goto('chrome-extension://' + extId + '/options.html');

  await step('관리자 키 형식 오류 안내', async () => {
    await opt.fill('#admin-key', 'not-a-key');
    await opt.click('#test-key');
    await waitFor(async () => (await opt.textContent('#key-result')).includes('관리자 키 형식이 아닙니다'), 5000, '형식 오류');
  });

  await step('연결 확인 실패(401) → 관리자 키 오류, 저장 안 함', async () => {
    mock.api = '401';
    await opt.fill('#admin-key', FAKE_ADMIN_KEY);
    await opt.click('#test-key');
    await waitFor(async () => (await opt.textContent('#key-result')).includes('관리자 키 오류'), 8000, '401 안내');
    assert.equal((await store('adminKey')).adminKey, undefined);
  });

  await step('연결 확인 성공 → 키 저장 · 이번 달 사용액 표시', async () => {
    mock.api = 'ok';
    await opt.fill('#admin-key', FAKE_ADMIN_KEY);
    await opt.click('#test-key');
    await waitFor(async () => (await opt.textContent('#key-result')).includes('연결됨'), 8000, '연결됨');
    const s = await store('adminKey');
    assert.equal(s.adminKey, FAKE_ADMIN_KEY);
    assert.equal(await opt.inputValue('#admin-key'), ''); // 입력 칸 비움
    const sync = await sw.evaluate(() => chrome.storage.sync.get(null));
    assert.deepEqual(sync, {}); // sync 저장소는 쓰지 않음
    await shot(opt, 'options.png');
  });

  await step('설정 저장(기준 $5, 주기 30분 → 알람 주기 변경)', async () => {
    await opt.fill('#threshold', '5');
    await opt.selectOption('#refresh-minutes', '30');
    await opt.click('#save-settings');
    await waitFor(async () => (await opt.textContent('#save-result')).includes('저장했습니다'), 5000, '저장');
    const a = await waitFor(async () => {
      const x = await sw.evaluate(() => chrome.alarms.get('cbk-usage'));
      return x && x.periodInMinutes === 30 ? x : null;
    }, 5000, 'alarm 30');
    assert.equal(a.periodInMinutes, 30);
    await opt.selectOption('#refresh-minutes', '15');
    await opt.click('#save-settings');
  });

  // ── 팝업 : 버튼 눌러 잔액 확인 ──
  await step('팝업 : 지난 값 회색 + "잔액 확인 중…" → 결제 탭 열었다 닫고 진한 글씨 "방금 확인"', async () => {
    const p = await openPopup();
    await waitFor(async () => (await p.textContent('#balance-status')).includes('잔액 확인 중'), 4000, '확인 중 표시');
    assert.ok(await p.$eval('#balance', (el) => el.classList.contains('stale')));
    await shot(p, 'popup-checking.png');
    await waitFor(() => billingTabs().length === 1, 5000, '결제 탭 열림');
    const t = billingTabs()[0];
    // 비활성 탭인지 확인
    const active = await sw.evaluate(async () => (await chrome.tabs.query({ url: 'https://platform.claude.com/*' }))[0].active);
    assert.equal(active, false);
    void t;
    await waitFor(async () => (await p.textContent('#balance')) === '$42.18', 15000, '잔액 표시');
    await waitFor(async () => !(await p.$eval('#balance', (el) => el.classList.contains('stale'))), 3000, '진한 글씨');
    assert.match(await p.textContent('#balance-when'), /방금 확인/);
    await waitFor(() => billingTabs().length === 0, 5000, '결제 탭 닫힘');
    await waitFor(async () => (await p.textContent('#u-today')) !== '—', 8000, '사용액');
    await shot(p, 'popup-ok.png');
    await p.close();
  });

  await step('사용액(오늘/이번 주/이번 달) 과 최근 충전일(결제 내역) 표시', async () => {
    const p = await openPopup();
    await waitFor(async () => (await p.textContent('#u-month')).startsWith('$'), 8000, '이번 달');
    const today = await p.textContent('#u-today');
    assert.ok(['$1.20', '$3.65'].includes(today), 'today=' + today); // 자정 직후면 어제 행이 오늘에 들어갈 수 있음
    assert.equal(await p.textContent('#recharge-date'), '2026년 11월 3일');
    assert.equal(await p.textContent('#recharge-src'), '결제 내역');
    assert.match(await p.textContent('#usage-note'), /4시간/);
    await p.close();
  });

  await step('1분 안에 다시 누르면 새로 확인하지 않고 저장된 값만', async () => {
    const before = mock.billingLoads;
    const p = await openPopup();
    await waitFor(async () => (await p.textContent('#balance-status')).includes('1분 안에 이미 확인'), 5000, '1분 안내');
    assert.equal(await p.textContent('#balance'), '$42.18');
    await new Promise((r) => setTimeout(r, 1500));
    assert.equal(mock.billingLoads, before);
    await p.close();
  });

  await step('팝업을 바로 닫아도 확인은 끝까지 진행되고 저장됨', async () => {
    await setStore({ lastCheckAt: 0 });
    mock.balance = '$40.00';
    const p = await openPopup();
    await waitFor(async () => (await store('balanceStatus')).balanceStatus.state === 'checking', 4000, 'checking');
    await p.close();
    const s = await waitFor(async () => {
      const x = await store(['balance', 'balanceStatus']);
      return x.balanceStatus.state === 'ok' && x.balance.value === 40 ? x : null;
    }, 15000, '팝업 닫은 뒤 저장');
    assert.equal(s.balance.source, 'button');
    await waitFor(() => billingTabs().length === 0, 5000, '결제 탭 닫힘');
  });

  await step('잔액 부족(실측 $3.20) → ! 배지 + 알림 1회', async () => {
    await setStore({ lastCheckAt: 0 });
    mock.balance = '$3.20';
    const p = await openPopup();
    await waitFor(async () => (await p.textContent('#balance')) === '$3.20', 15000, '$3.20');
    await waitFor(async () => (await badge()) === '!', 3000, '배지');
    await waitFor(async () => (await notifs())['cbk-low-balance'], 3000, '알림');
    await waitFor(async () => !(await p.$eval('#low-banner', (el) => el.classList.contains('hidden'))), 3000, '경고 문구');
    await shot(p, 'popup-low.png');
    await p.close();
    // 다시 확인해도 알림은 다시 뜨지 않음
    await sw.evaluate(() => chrome.notifications.clear('cbk-low-balance'));
    const before = (await store('balance')).balance.measuredAt;
    await setStore({ lastCheckAt: 0 });
    const p2 = await openPopup();
    await waitFor(async () => (await store('balance')).balance.measuredAt > before, 15000, '재확인 완료');
    await new Promise((r) => setTimeout(r, 1500));
    assert.equal((await notifs())['cbk-low-balance'], undefined);
    await p2.close();
  });

  await step('충전 감지($3.20 → $53.20) → 자동 감지 충전일 · 배지 해제 · 알림 상태 초기화', async () => {
    await setStore({ lastCheckAt: 0 });
    mock.balance = '$53.20';
    const p = await openPopup();
    await waitFor(async () => (await p.textContent('#balance')) === '$53.20', 15000, '$53.20');
    await waitFor(async () => (await badge()) === '', 3000, '배지 해제');
    const s = await store(['recharge', 'alert']);
    const now = new Date();
    const key = now.getFullYear() + '-' + String(now.getMonth() + 1).padStart(2, '0') + '-' + String(now.getDate()).padStart(2, '0');
    assert.equal(s.recharge.auto.date, key);
    assert.equal(s.alert.notified, false);
    assert.equal(await p.textContent('#recharge-src'), '자동 감지');
    await p.close();
  });

  await step('추정 잔액(실측 $10 − 실측 이후 $6) 이 기준 이하 → 15분 갱신 때 ! 배지', async () => {
    await setStore({ lastCheckAt: 0 });
    mock.balance = '$10.00';
    const p = await openPopup();
    await waitFor(async () => (await p.textContent('#balance')) === '$10.00', 15000, '$10');
    await p.close();
    assert.equal(await badge(), '');
    mock.extraSinceCents = 600;
    await sw.evaluate(() => refreshUsage({ force: true })); // 알람이 부르는 함수와 같음
    await waitFor(async () => (await badge()) === '!', 5000, '추정 배지');
    await waitFor(async () => (await notifs())['cbk-low-balance'], 3000, '추정 알림');
    mock.extraSinceCents = 0;
  });

  // ── 오류 표시 ──
  await step('콘솔 로그인 안 됨 → "콘솔 로그인 필요", 잔액 숫자는 그대로', async () => {
    await setStore({ lastCheckAt: 0 });
    mock.billing = 'login';
    const p = await openPopup();
    await waitFor(async () => (await p.textContent('#balance-status')).includes('콘솔 로그인 필요'), 15000, '로그인 안내');
    assert.equal(await p.textContent('#balance'), '$10.00');
    assert.ok(await p.$eval('#balance', (el) => el.classList.contains('stale')));
    await shot(p, 'popup-login.png');
    await p.close();
  });

  await step('화면 구조 변경 → "잔액을 읽지 못함", 틀린 숫자 표시 안 함', async () => {
    await setStore({ lastCheckAt: 0 });
    mock.billing = 'changed';
    const p = await openPopup();
    await waitFor(async () => (await p.textContent('#balance-status')).includes('잔액을 읽지 못함'), 25000, '구조 변경 안내');
    assert.equal(await p.textContent('#balance'), '$10.00'); // 구조 변경 화면의 $42.18 을 쓰지 않음
    await p.close();
  });

  await step('결제 페이지가 응답 없음 → 20초 뒤 실패 처리 · 탭 닫힘', async () => {
    await setStore({ lastCheckAt: 0 });
    mock.billing = 'hang';
    const p = await openPopup();
    await waitFor(async () => (await p.textContent('#balance-status')).includes('20초 초과'), 26000, '20초 제한');
    await waitFor(() => billingTabs().length === 0, 5000, '탭 닫힘');
    await p.close();
    mock.billing = 'ok';
  });

  await step('관리자 키 오류(401) → 사용액 자리에 "관리자 키 오류"', async () => {
    mock.api = '401';
    await sw.evaluate(() => refreshUsage({ force: true }));
    const p = await openPopup();
    await waitFor(async () => (await p.textContent('#usage-note')).includes('관리자 키 오류'), 5000, '401 안내');
    await shot(p, 'popup-keyerror.png');
    await p.close();
  });

  await step('인터넷 끊김 → "인터넷 연결을 확인"', async () => {
    mock.api = 'network';
    await sw.evaluate(() => refreshUsage({ force: true }));
    const p = await openPopup();
    await waitFor(async () => (await p.textContent('#usage-note')).includes('인터넷 연결'), 5000, '네트워크 안내');
    await p.close();
    mock.api = 'ok';
  });

  await step('사용자가 결제 페이지를 직접 열면 그 화면에서 읽어 저장', async () => {
    mock.balance = '$77.00';
    mock.billing = 'ok';
    const p = await context.newPage();
    await p.goto('https://platform.claude.com/settings/billing');
    const s = await waitFor(async () => {
      const x = await store('balance');
      return x.balance && x.balance.value === 77 ? x : null;
    }, 10000, '직접 연 페이지');
    assert.equal(s.balance.source, 'page');
    await p.close();
  });

  await step('프로모션 크레딧 : 표를 읽어 큰 숫자로, 구매 크레딧은 아래 작게, 만료일 표시', async () => {
    await setStore({ lastCheckAt: 0, recharge: {} }); // 앞 단계의 "자동 감지" 충전일(오늘)을 비워 프로모션 지급일을 확인
    mock.balance = '$0.00';
    mock.promo = true;
    const p = await openPopup();
    await waitFor(async () => (await p.textContent('#balance-label')) === '프로모션 크레딧', 15000, '프로모션 라벨');
    assert.equal(await p.textContent('#balance'), '$41.75'); // 37.50 + 4.25 (2020년에 만료된 $9 는 제외)
    assert.equal(await p.textContent('#balance-sub'), '구매한 크레딧 $0.00');
    assert.match(await p.textContent('#promo-note'), /프로모션 만료 2099년 12월 31일 \(\$37\.50\) · 2건/);
    assert.equal(await p.textContent('#recharge-src'), '프로모션 지급일');
    assert.equal(await p.textContent('#recharge-date'), '2026년 11월 12일');
    const s = await store('balance');
    assert.equal(s.balance.promo.total, 41.75);
    assert.equal(s.balance.value, 0);
    await shot(p, 'popup-promo.png');
    await p.close();
  });

  await step('설정에서 「구매한 크레딧」을 고르면 그쪽이 큰 숫자 · 알림 기준', async () => {
    const o = await context.newPage();
    await o.goto('chrome-extension://' + extId + '/options.html');
    await o.check('input[name="primary"][value="credit"]');
    await o.click('#save-settings');
    await waitFor(async () => (await o.textContent('#save-result')).includes('저장했습니다'), 5000, '저장');
    await o.close();
    const p = await openPopup();
    await waitFor(async () => (await p.textContent('#balance-label')) === '구매한 크레딧', 5000, '구매 라벨');
    assert.equal(await p.textContent('#balance'), '$0.00');
    assert.equal(await p.textContent('#balance-sub'), '프로모션 크레딧 $41.75');
    await waitFor(async () => (await badge()) === '!', 5000, '구매 크레딧 $0 → 부족 배지');
    await p.close();
    // 다시 프로모션으로 되돌리면 $41.75 > $5 라 배지가 사라진다
    const o2 = await context.newPage();
    await o2.goto('chrome-extension://' + extId + '/options.html');
    await o2.check('input[name="primary"][value="promo"]');
    await o2.click('#save-settings');
    await waitFor(async () => (await badge()) === '', 5000, '배지 해제');
    await o2.close();
    mock.promo = false;
  });

  await step('관리자 키 삭제 → 팝업에 "사용액은 선택 기능" 안내', async () => {
    const o = await context.newPage();
    await o.goto('chrome-extension://' + extId + '/options.html');
    o.on('dialog', (d) => d.accept());
    await o.click('#delete-key');
    await waitFor(async () => !(await store('adminKey')).adminKey, 5000, '키 삭제');
    const p = await openPopup();
    await waitFor(async () => !(await p.$eval('#no-key', (el) => el.classList.contains('hidden'))), 5000, '키 없음 안내');
    await p.close();
    await o.close();
  });

  await step('외부 전송 : 두 주소 외 요청 없음', async () => {
    assert.ok(mock.apiCalls > 0);
    const extra = [...hosts].filter((h) => h !== 'api.anthropic.com' && h !== 'platform.claude.com');
    assert.deepEqual(extra, [], '다른 주소 : ' + extra.join(', '));
  });

  await context.close();
  for (const r of hanging) r.destroy();
  startFakeServers.server.close();
  fs.rmSync(userDir, { recursive: true, force: true });
  const failed = results.filter((r) => !r[0]).length;
  console.log('\n확장 동작 시험 : 통과 ' + (results.length - failed) + ' · 실패 ' + failed + ' (스크린샷 : ' + SHOTS + ')');
  process.exit(failed ? 1 : 0);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
