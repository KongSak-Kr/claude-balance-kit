/*
 * 단위 테스트 — 외부 패키지 없이 Node 내장 테스트 도구로 실행
 *   TZ=Asia/Seoul node --test tests/
 */
'use strict';

process.env.TZ = 'Asia/Seoul';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const core = require('../extension/lib/core.js');
const billing = require('../extension/lib/billing-parse.js');
const { htmlToText } = require('./html-to-text.js');

const FIX = path.join(__dirname, 'fixtures');
const BILLING_URL = 'https://platform.claude.com/settings/billing';

function fixture(name) {
  return htmlToText(fs.readFileSync(path.join(FIX, name), 'utf8'));
}

// ── 결제 페이지 파싱 ────────────────────────────────────────────────
test('정상 화면 : 잔액과 최근 충전일(결제 내역)을 읽는다', () => {
  const r = billing.parseBillingText(fixture('billing-ok.html'), { url: BILLING_URL });
  assert.equal(r.status, 'ok');
  assert.equal(r.balance, 42.18); // 자동 충전 문장의 $50.00 / $10.00 이 아니라 카드의 금액
  assert.equal(r.latestRecharge, '2026-11-03');
  assert.deepEqual(
    r.recharges.map((x) => x.date),
    ['2026-11-03', '2026-09-12'], // 프로모션 크레딧은 충전으로 보지 않는다
  );
});

test('로그인 화면(실제 화면 샘플) : 숫자 없이 "로그인 필요"', () => {
  const r = billing.parseBillingText(fixture('billing-login-real.html'), { url: BILLING_URL });
  assert.equal(r.status, 'login_required');
  assert.equal(r.balance, null);
});

test('로그인 주소로 넘어간 경우도 "로그인 필요"', () => {
  const r = billing.parseBillingText('Welcome back\nEmail\nPassword', { url: 'https://platform.claude.com/login?returnTo=%2Fsettings%2Fbilling' });
  assert.equal(r.status, 'login_required');
});

test('구조가 바뀐 화면 : 비슷한 금액이 있어도 숫자를 내지 않는다', () => {
  const r = billing.parseBillingText(fixture('billing-changed.html'), { url: BILLING_URL });
  assert.equal(r.status, 'label_not_found');
  assert.equal(r.balance, null);
});

test('잔액 카드가 아직 로딩 중 : loading', () => {
  const r = billing.parseBillingText(fixture('billing-loading.html'), { url: BILLING_URL });
  assert.equal(r.status, 'loading');
  assert.equal(r.balance, null);
});

test('잔액 카드가 아직 로딩 중일 때 아래 결제 내역 표의 금액을 잔액으로 잡지 않는다', () => {
  const text = [
    'Billing',
    'Credit balance',
    'Credits are used by the API, Claude Code, and playground.',
    'Loading',
    'Auto-reload is on. Your balance will be topped up to $50.00 when your balance falls below $10.00.',
    'Invoice history',
    'Nov 3, 2026\tINV-1\tCredit grant\t$50.00\tPaid',
  ].join('\n');
  const r = billing.parseBillingText(text, { url: BILLING_URL });
  assert.equal(r.status, 'loading');
  assert.equal(r.balance, null);
  assert.equal(r.latestRecharge, '2026-11-03');
  // 구역 제목 없이 표만 바로 이어져도 표 행은 건너뛴다
  const r2 = billing.parseBillingText('Credit balance\nLoading\nNov 3, 2026\tCredit grant\t$50.00', { url: BILLING_URL });
  assert.equal(r2.balance, null);
});

test('라벨은 있는데 금액이 없고 로딩도 아님 : amount_not_found', () => {
  const r = billing.parseBillingText('Billing\nCredit balance\nCredits are used by the API.\nBuy credits', { url: BILLING_URL });
  assert.equal(r.status, 'amount_not_found');
  assert.equal(r.balance, null);
});

test('한국어 화면 : 크레딧 잔액 · 자동 충전 문장은 건너뜀 · 쉼표 금액', () => {
  const r = billing.parseBillingText(fixture('billing-ko.html'), { url: BILLING_URL });
  assert.equal(r.status, 'ok');
  assert.equal(r.balance, 1234.5);
  assert.equal(r.latestRecharge, '2026-10-02');
});

test('음수 잔액', () => {
  const r = billing.parseBillingText(fixture('billing-negative.html'), { url: BILLING_URL });
  assert.equal(r.status, 'ok');
  assert.equal(r.balance, -1.2);
});

test('빈 화면은 loading 으로 본다(아직 그려지기 전)', () => {
  assert.equal(billing.parseBillingText('', { url: BILLING_URL }).status, 'loading');
});

test('날짜 형식 여러 가지', () => {
  const cases = {
    'Nov 3, 2026': '2026-11-03',
    'November 30, 2026': '2026-11-30',
    'Sept 9, 2026': '2026-09-09',
    '3 Nov 2026': '2026-11-03',
    '2026-11-03': '2026-11-03',
    '2026. 11. 3.': '2026-11-03',
    '2026년 1월 15일': '2026-01-15',
    '11/03/2026': '2026-11-03',
    'Feb 30, 2026': null,
    'no date here': null,
  };
  for (const [input, want] of Object.entries(cases)) assert.equal(billing.parseDate(input), want, input);
});

// ── 날짜 구간 · 비용 합산 ───────────────────────────────────────────
test('이번 주는 월요일 0시(현지 시각)부터', () => {
  const now = new Date('2026-11-19T15:00:00+09:00').getTime(); // 목요일
  assert.equal(new Date(core.startOfLocalWeek(now)).toISOString(), '2026-11-15T15:00:00.000Z'); // 11/16(월) 0시 KST
  const sunday = new Date('2026-11-22T10:00:00+09:00').getTime();
  assert.equal(new Date(core.startOfLocalWeek(sunday)).toISOString(), '2026-11-15T15:00:00.000Z');
});

test('비용 조회 범위 : 이번 달·이번 주를 모두 덮고 31일을 넘지 않는다', () => {
  // 12월 2일(수) — 이번 주 월요일이 11월 30일이라 지난달까지 걸친다
  const now = new Date('2026-12-02T10:30:00+09:00').getTime();
  const r = core.buildCostRange({ now: now, measuredAt: null });
  assert.equal(r.startingAt, '2026-11-29T15:00:00Z'); // 11/30 0시 KST
  assert.equal(r.endingAt, '2026-12-02T01:30:00Z');
  // 31일 달의 마지막 날
  const end = new Date('2026-12-31T23:30:00+09:00').getTime();
  const r2 = core.buildCostRange({ now: end, measuredAt: null });
  const span = Date.parse(r2.endingAt) - Date.parse(r2.startingAt);
  assert.ok(span <= 31 * core.DAY, 'span ' + span);
  assert.equal(r2.startingAt, '2026-11-30T15:00:00Z');
});

test('비용 조회 범위 : 오래된 실측 시각은 30일 안쪽만 반영', () => {
  const now = new Date('2026-11-19T12:00:00+09:00').getTime();
  const measured = new Date('2026-10-25T09:10:00+09:00').getTime();
  const r = core.buildCostRange({ now: now, measuredAt: measured });
  assert.equal(r.startingAt, '2026-10-25T00:00:00Z'); // 실측 시각을 1시간 단위로 내림(UTC)
  const veryOld = new Date('2026-08-01T00:00:00+09:00').getTime();
  const r2 = core.buildCostRange({ now: now, measuredAt: veryOld });
  assert.equal(r2.startingAt, '2026-10-31T15:00:00Z'); // 이번 달 시작
});

test('비용 조회 범위 : 조회할 구간이 1시간도 안 되면 null', () => {
  // 11월 1일(일) 0시 10분 KST : 월 시작 = 그 시각, 이번 주 시작 = 10/26(월) → 범위 있음
  const a = new Date('2026-11-01T00:10:00+09:00').getTime();
  assert.ok(core.buildCostRange({ now: a, measuredAt: null }));
  // 2026-06-01 은 월요일 → 월·주 시작이 같고 10분밖에 안 지남
  const b = new Date('2026-06-01T00:10:00+09:00').getTime();
  assert.equal(core.buildCostRange({ now: b, measuredAt: null }), null);
});

test('비용 URL 과 헤더', () => {
  const url = core.buildCostUrl({ startingAt: '2026-11-01T00:00:00Z', endingAt: '2026-11-19T03:00:00Z' }, 'page_abc');
  assert.equal(
    url,
    'https://api.anthropic.com/v1/organizations/analytics/cost?starting_at=2026-11-01T00%3A00%3A00Z&ending_at=2026-11-19T03%3A00%3A00Z&time_bucket_width=1h&limit=1000&page=page_abc',
  );
  const h = core.costHeaders('test-key');
  assert.equal(h['anthropic-version'], '2026-10-21');
  assert.equal(h['anthropic-beta'], 'analytics-usage-cost-2026-08-24');
  assert.equal(h['x-api-key'], 'test-key');
});

test('비용 합산 : 오늘 / 이번 주 / 이번 달 / 실측 이후 (센트)', () => {
  const now = new Date('2026-11-19T15:00:00+09:00').getTime();
  const row = (iso, cents) => ({ starting_at: iso, cost: { currency: 'USD', amount: cents.toFixed(6), list_amount: '0' } });
  const rows = [
    row('2026-11-19T03:00:00Z', 120), // 11/19 12시 KST → 오늘
    row('2026-11-18T14:00:00Z', 30), // 11/18 23시 KST → 어제(이번 주)
    row('2026-11-16T00:00:00Z', 200), // 11/16 9시 KST → 이번 주(월)
    row('2026-11-15T14:00:00Z', 500), // 11/15 23시 KST(일) → 지난주, 이번 달
    row('2026-10-31T14:00:00Z', 999), // 10/31 23시 KST → 지난달
  ];
  const measuredAt = new Date('2026-11-18T22:30:00+09:00').getTime(); // = 13:30Z → 13:00Z 부터
  const s = core.summarizeCost(rows, { now: now, measuredAt: measuredAt });
  assert.equal(s.todayCents, 120);
  assert.equal(s.weekCents, 350);
  assert.equal(s.monthCents, 850);
  assert.equal(s.sinceMeasuredCents, 150);
});

// ── 추정 잔액 · 충전 · 알림 ────────────────────────────────────────
test('추정 잔액 = 실측 잔액 − 실측 이후 사용액 (같은 실측에 대한 값만)', () => {
  const balance = { value: 20, measuredAt: 1000 };
  assert.equal(core.estimateBalance(balance, { sinceMeasuredCents: 1550, forMeasuredAt: 1000 }), 4.5);
  assert.equal(core.estimateBalance(balance, { sinceMeasuredCents: 1550, forMeasuredAt: 999 }), 20);
  assert.equal(core.estimateBalance(null, {}), null);
});

test('충전 감지와 부족 판단', () => {
  assert.equal(core.detectRecharge(3.2, 53.2), true);
  assert.equal(core.detectRecharge(3.2, 3.9), false);
  assert.equal(core.detectRecharge(null, 50), false);
  const s = core.normalizeSettings({});
  assert.equal(core.isLow(5, s), true);
  assert.equal(core.isLow(5.01, s), false);
  assert.equal(core.isLow(1, core.normalizeSettings({ alertEnabled: false })), false);
});

test('최근 충전일 고르기 : 가장 최근 날짜 + 출처', () => {
  const r = core.pickLatestRecharge({ auto: { date: '2026-11-10' }, history: { date: '2026-11-03' } }, '2026-11-05');
  assert.deepEqual(r, { date: '2026-11-10', source: 'auto', sourceLabel: '자동 감지' });
  const same = core.pickLatestRecharge({ auto: { date: '2026-11-03' }, history: { date: '2026-11-03' } }, null);
  assert.equal(same.source, 'history');
  assert.equal(core.pickLatestRecharge({}, null), null);
});

// ── 오류 분류 · 형식 · 설정 ────────────────────────────────────────
test('오류 분류', () => {
  const body = (type, message) => JSON.stringify({ type: 'error', error: { type: type, message: message } });
  assert.equal(core.classifyApiError(401, body('authentication_error', 'invalid x-api-key')), 'admin_key_invalid');
  assert.equal(core.classifyApiError(401, body('authentication_error', 'CORS requests are not allowed for this Organization because of its settings')), 'cors_blocked');
  assert.equal(core.classifyApiError(403, body('permission_error', 'nope')), 'admin_key_forbidden');
  assert.equal(core.classifyApiError(404, ''), 'not_available');
  assert.equal(core.classifyApiError(429, ''), 'rate_limited');
  assert.equal(core.classifyApiError(529, ''), 'server');
  assert.equal(core.classifyApiError(0, ''), 'network');
  assert.equal(core.classifyApiError(400, body('invalid_request_error', 'bad')), 'bad_request');
  assert.match(core.messageFor('admin_key_invalid'), /관리자 키 오류/);
  assert.match(core.messageFor('login_required'), /콘솔 로그인 필요/);
  assert.match(core.messageFor('parse_failed'), /잔액을 읽지 못함/);
});

test('파싱 상태 → 화면 오류 코드', () => {
  assert.equal(core.balanceErrorCode('login_required'), 'login_required');
  assert.equal(core.balanceErrorCode('label_not_found'), 'structure_changed');
  assert.equal(core.balanceErrorCode('amount_not_found'), 'parse_failed');
  assert.equal(core.balanceErrorCode('loading'), 'parse_failed');
  assert.equal(core.balanceErrorCode('timeout'), 'timeout');
});

test('금액 · 날짜 표시', () => {
  assert.equal(core.formatUSD(1234.5), '$1,234.50');
  assert.equal(core.formatUSD(-1.2), '-$1.20');
  assert.equal(core.formatCents(31002.5), '$310.03');
  assert.equal(core.formatDateKeyKo('2026-11-03'), '2026년 11월 3일');
  const now = new Date('2026-11-19T15:00:00+09:00').getTime();
  assert.equal(core.formatWhenKo(new Date('2026-11-19T09:05:00+09:00').getTime(), now), '오늘 09:05');
  assert.equal(core.formatWhenKo(new Date('2026-11-18T23:59:00+09:00').getTime(), now), '어제 23:59');
  assert.equal(core.formatWhenKo(new Date('2026-11-03T08:00:00+09:00').getTime(), now), '11월 3일 08:00');
  assert.equal(core.formatAgoKo(now - 30 * 1000, now), '방금');
  assert.equal(core.formatAgoKo(now - 5 * 60 * 1000, now), '5분 전');
});

test('설정 기본값과 보정', () => {
  assert.deepEqual(core.normalizeSettings(undefined), { alertEnabled: true, threshold: 5, refreshMinutes: 15, manualRechargeDate: null });
  const s = core.normalizeSettings({ threshold: '-3', refreshMinutes: 7, manualRechargeDate: 'yesterday' });
  assert.equal(s.threshold, 5);
  assert.equal(s.refreshMinutes, 15);
  assert.equal(s.manualRechargeDate, null);
});

test('관리자 키 모양 검사(값 자체는 가짜)', () => {
  const fake = ['sk', 'ant', 'admin01', 'x'.repeat(30)].join('-');
  assert.equal(core.looksLikeAdminKey(fake), true);
  const api = ['sk', 'ant', 'api03', 'x'.repeat(30)].join('-');
  assert.equal(core.looksLikeAdminKey(api), false);
  assert.equal(core.looksLikeAdminKey(fake + ' '), false);
});
