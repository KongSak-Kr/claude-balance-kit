/*
 * Claude 잔액 키트 — 공통 계산 · 형식 · API 도우미
 *
 * 브라우저(확장 페이지·서비스 워커)에서는 globalThis.CBK.core 로,
 * Node(단위 테스트)에서는 require() 로 쓸 수 있게 작성했다. 외부 라이브러리 없음.
 */
(function (root) {
  'use strict';

  // ── 고정 주소 · 헤더 ────────────────────────────────────────────
  const API_BASE = 'https://api.anthropic.com';
  const COST_PATH = '/v1/organizations/analytics/cost';
  const ANTHROPIC_VERSION = '2026-10-21';
  const ANALYTICS_BETA = 'analytics-usage-cost-2026-08-24';
  const BILLING_URL = 'https://platform.claude.com/settings/billing';
  const ADMIN_KEYS_URL = 'https://platform.claude.com/settings/admin-keys';
  const ADMIN_KEY_PREFIX = 'sk-ant-admin';

  const DEFAULT_SETTINGS = Object.freeze({
    primary: 'promo', // 크게 보여 주고 알림 기준으로 쓸 잔액 : promo(프로모션 크레딧, 있으면) | credit(구매한 크레딧)
    alertEnabled: true,
    threshold: 5,
    refreshMinutes: 15,
    manualRechargeDate: null,
  });

  const HOUR = 60 * 60 * 1000;
  const DAY = 24 * HOUR;

  // ── 날짜 구간 (사용자 컴퓨터의 현지 시각 기준) ─────────────────────
  function startOfLocalDay(t) {
    const d = new Date(t);
    d.setHours(0, 0, 0, 0);
    return d.getTime();
  }

  /** 이번 주 시작 = 월요일 0시 */
  function startOfLocalWeek(t) {
    const d = new Date(startOfLocalDay(t));
    const dow = d.getDay(); // 0=일 … 6=토
    const back = dow === 0 ? 6 : dow - 1;
    d.setDate(d.getDate() - back);
    return d.getTime();
  }

  function startOfLocalMonth(t) {
    const d = new Date(startOfLocalDay(t));
    d.setDate(1);
    return d.getTime();
  }

  function floorUtcHour(t) {
    return Math.floor(t / HOUR) * HOUR;
  }

  function isoNoMs(t) {
    return new Date(t).toISOString().replace(/\.\d{3}Z$/, 'Z');
  }

  /**
   * 비용 조회 범위 계산.
   * - 이번 달 · 이번 주 · 오늘, 그리고 (있으면) 마지막 잔액 실측 이후를 한 번에 덮는다.
   * - API 제약 : 시작은 2026-01-01 이후·365일 이내, 한 요청 최대 31일.
   * 반환값이 null 이면 아직 조회할 구간이 없다는 뜻(예 : 1시간 단위로 내림하면 0시간).
   */
  function buildCostRange(opts) {
    const now = opts.now;
    const candidates = [startOfLocalMonth(now), startOfLocalWeek(now)];
    if (opts.measuredAt && now - opts.measuredAt < 30 * DAY) candidates.push(opts.measuredAt);
    let start = floorUtcHour(Math.min.apply(null, candidates));
    const floorLimit = Math.max(Date.UTC(2026, 0, 1), floorUtcHour(now - 31 * DAY + HOUR));
    if (start < floorLimit) start = floorLimit;
    if (floorUtcHour(now) <= start) return null;
    return { startingAt: isoNoMs(start), endingAt: isoNoMs(now) };
  }

  function buildCostUrl(range, page) {
    const params = [
      'starting_at=' + encodeURIComponent(range.startingAt),
      'ending_at=' + encodeURIComponent(range.endingAt),
      'time_bucket_width=1h',
      'limit=1000',
    ];
    if (page) params.push('page=' + encodeURIComponent(page));
    return API_BASE + COST_PATH + '?' + params.join('&');
  }

  function costHeaders(adminKey) {
    return {
      'x-api-key': adminKey,
      'anthropic-version': ANTHROPIC_VERSION,
      'anthropic-beta': ANALYTICS_BETA,
      // 확장(브라우저)에서 직접 부르는 요청이라 필요하다. 출처 : docs/확인사항.md
      'anthropic-dangerous-direct-browser-access': 'true',
    };
  }

  /** 금액 문자열(센트, 소수 6자리) → 숫자(센트) */
  function centsOf(row) {
    if (!row || !row.cost) return 0;
    const v = parseFloat(row.cost.amount);
    return Number.isFinite(v) ? v : 0;
  }

  /**
   * 1시간 단위 비용 행들을 오늘 / 이번 주 / 이번 달 / 실측 이후 로 합산.
   * 금액 단위는 센트.
   */
  function summarizeCost(rows, opts) {
    const now = opts.now;
    const day = startOfLocalDay(now);
    const week = startOfLocalWeek(now);
    const month = startOfLocalMonth(now);
    const since = opts.measuredAt ? floorUtcHour(opts.measuredAt) : null;
    const out = { todayCents: 0, weekCents: 0, monthCents: 0, sinceMeasuredCents: 0 };
    for (const row of rows || []) {
      const t = Date.parse(row.starting_at);
      if (!Number.isFinite(t)) continue;
      const c = centsOf(row);
      if (t >= day) out.todayCents += c;
      if (t >= week) out.weekCents += c;
      if (t >= month) out.monthCents += c;
      if (since !== null && t >= since) out.sinceMeasuredCents += c;
    }
    for (const k of Object.keys(out)) out[k] = Math.round(out[k] * 1e6) / 1e6;
    return out;
  }

  // ── 기준 잔액 · 추정 잔액 · 충전 감지 ─────────────────────────────────
  const KIND_LABEL = { promo: '프로모션 크레딧', credit: '구매한 크레딧' };

  function hasPromo(balance) {
    return Boolean(balance && balance.promo && typeof balance.promo.total === 'number' && balance.promo.count > 0);
  }

  /**
   * 크게 보여 줄 잔액(= 알림 기준). 설정이 promo 이고 프로모션 크레딧이 있으면 그 합계, 아니면 구매한 크레딧.
   * 반환 { kind, label, value }
   */
  function primaryOf(balance, settings) {
    const s = settings || DEFAULT_SETTINGS;
    if (s.primary !== 'credit' && hasPromo(balance)) return { kind: 'promo', label: KIND_LABEL.promo, value: balance.promo.total };
    const v = balance && typeof balance.value === 'number' ? balance.value : null;
    if (v === null && hasPromo(balance)) return { kind: 'promo', label: KIND_LABEL.promo, value: balance.promo.total };
    return { kind: 'credit', label: KIND_LABEL.credit, value: v };
  }

  /** 함께 작게 보여 줄 다른 잔액 (없으면 null) */
  function secondaryOf(balance, settings) {
    const p = primaryOf(balance, settings);
    if (p.kind === 'promo') {
      return balance && typeof balance.value === 'number' ? { kind: 'credit', label: KIND_LABEL.credit, value: balance.value } : null;
    }
    return hasPromo(balance) ? { kind: 'promo', label: KIND_LABEL.promo, value: balance.promo.total } : null;
  }

  /**
   * 마지막 실측 잔액(기준 잔액) − 실측 이후 사용액. 알림 판단용(화면 표시용 아님).
   * 프로모션 크레딧은 해당 모델 사용에 먼저 쓰이므로, 사용액을 모두 빼는 쪽(보수적인 추정)으로 계산한다.
   */
  function estimateBalance(balance, usage, settings) {
    const p = primaryOf(balance, settings);
    if (typeof p.value !== 'number') return null;
    let spent = 0;
    if (usage && usage.forMeasuredAt === balance.measuredAt && typeof usage.sinceMeasuredCents === 'number') {
      spent = usage.sinceMeasuredCents / 100;
    }
    return Math.round((p.value - spent) * 100) / 100;
  }

  /** 새 실측값이 직전 추정값보다 $1 이상 늘었으면 충전으로 본다. */
  function detectRecharge(prevEstimate, measured, minIncrease) {
    if (typeof prevEstimate !== 'number' || typeof measured !== 'number') return false;
    return measured - prevEstimate >= (minIncrease || 1);
  }

  const RECHARGE_SOURCE_LABEL = { auto: '자동 감지', history: '결제 내역', manual: '직접 입력', promo: '프로모션 지급일' };

  /** 세 출처 중 가장 최근 날짜. 같은 날이면 결제 내역 > 직접 입력 > 자동 감지 순. */
  function pickLatestRecharge(recharge, manualDate) {
    const list = [];
    if (recharge && recharge.history && recharge.history.date) list.push({ date: recharge.history.date, source: 'history', rank: 3 });
    if (manualDate) list.push({ date: manualDate, source: 'manual', rank: 2 });
    if (recharge && recharge.promo && recharge.promo.date) list.push({ date: recharge.promo.date, source: 'promo', rank: 1.5 });
    if (recharge && recharge.auto && recharge.auto.date) list.push({ date: recharge.auto.date, source: 'auto', rank: 1 });
    if (!list.length) return null;
    list.sort((a, b) => (a.date === b.date ? b.rank - a.rank : a.date < b.date ? 1 : -1));
    const top = list[0];
    return { date: top.date, source: top.source, sourceLabel: RECHARGE_SOURCE_LABEL[top.source] };
  }

  /** 잔액 부족 판단 : 추정(또는 실측) 잔액이 기준 이하인가 */
  function isLow(value, settings) {
    if (!settings || !settings.alertEnabled) return false;
    if (typeof value !== 'number') return false;
    return value <= Number(settings.threshold);
  }

  // ── 형식 ─────────────────────────────────────────────────────────
  function formatUSD(value) {
    if (typeof value !== 'number' || !Number.isFinite(value)) return '—';
    const neg = value < 0;
    const s = Math.abs(value).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
    return (neg ? '-$' : '$') + s;
  }

  function formatCents(cents) {
    if (typeof cents !== 'number') return '—';
    return formatUSD(cents / 100);
  }

  function pad2(n) {
    return (n < 10 ? '0' : '') + n;
  }

  function localDateKey(t) {
    const d = new Date(t);
    return d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate());
  }

  /** "오늘 14:32" / "어제 09:10" / "11월 3일 14:32" / "2025년 12월 30일 08:00" */
  function formatWhenKo(t, now) {
    if (!t) return '—';
    const d = new Date(t);
    const hm = pad2(d.getHours()) + ':' + pad2(d.getMinutes());
    const today = startOfLocalDay(now);
    if (t >= today) return '오늘 ' + hm;
    if (t >= today - DAY) return '어제 ' + hm;
    const n = new Date(now);
    if (d.getFullYear() === n.getFullYear()) return (d.getMonth() + 1) + '월 ' + d.getDate() + '일 ' + hm;
    return d.getFullYear() + '년 ' + (d.getMonth() + 1) + '월 ' + d.getDate() + '일 ' + hm;
  }

  function formatAgoKo(t, now) {
    if (!t) return '';
    const s = Math.max(0, Math.round((now - t) / 1000));
    if (s < 60) return '방금';
    const m = Math.round(s / 60);
    if (m < 60) return m + '분 전';
    const h = Math.round(m / 60);
    if (h < 48) return h + '시간 전';
    return Math.round(h / 24) + '일 전';
  }

  /** 'YYYY-MM-DD' → '2026년 11월 3일' */
  function formatDateKeyKo(key) {
    const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(key || '');
    if (!m) return '—';
    return Number(m[1]) + '년 ' + Number(m[2]) + '월 ' + Number(m[3]) + '일';
  }

  // ── 오류 분류 ────────────────────────────────────────────────────
  const ERROR_MESSAGES = {
    no_admin_key: '관리자 키가 아직 없습니다. 설정 화면에서 넣어 주세요.',
    admin_key_format: '관리자 키 형식이 아닙니다. sk-ant-admin 으로 시작하는 키를 넣어 주세요.',
    admin_key_invalid: '관리자 키 오류 — 키가 틀렸거나 삭제·만료되었습니다. 설정에서 다시 넣어 주세요.',
    admin_key_forbidden: '관리자 키 권한 부족 — 조직 관리자(admin)가 만든 관리자 키인지 확인해 주세요.',
    cors_blocked: '이 조직은 보안 설정 때문에 브라우저에서 비용 조회를 할 수 없습니다(자세한 내용은 설치안내서 "자주 겪는 문제").',
    not_available: '이 조직에서는 비용 조회 기능을 쓸 수 없습니다(개인 계정이면 조직 설정이 먼저 필요합니다).',
    rate_limited: '요청이 많아 잠시 막혔습니다. 몇 분 뒤 다시 확인해 주세요.',
    server: 'Anthropic 서버가 일시적으로 응답하지 않습니다. 잠시 뒤 다시 확인해 주세요.',
    network: '인터넷 연결을 확인해 주세요.',
    bad_request: '비용 조회 요청이 거절되었습니다(화면 아래 상세 내용 참고).',
    unknown: '알 수 없는 오류가 발생했습니다.',
    // 잔액(결제 페이지) 읽기
    login_required: '콘솔 로그인 필요 — 결제 페이지를 열어 로그인해 주세요.',
    parse_failed: '잔액을 읽지 못함 — 결제 페이지를 한 번 열어 주세요.',
    structure_changed: '잔액을 읽지 못함(화면 구조 변경) — 결제 페이지를 한 번 열어 주세요.',
    timeout: '잔액을 읽지 못함(20초 초과) — 결제 페이지를 한 번 열어 주세요.',
    tab_closed: '확인 중 탭이 닫혀 잔액을 읽지 못했습니다. 다시 확인해 주세요.',
  };

  function classifyApiError(status, bodyText) {
    let type = '';
    let message = '';
    try {
      const j = JSON.parse(bodyText || '');
      if (j && j.error) {
        type = j.error.type || '';
        message = j.error.message || '';
      }
    } catch (e) {
      /* 본문이 JSON 이 아니면 무시 */
    }
    if (status === 0) return 'network';
    if (status === 401 && /CORS requests are not allowed/i.test(message)) return 'cors_blocked';
    if (status === 401 || type === 'authentication_error') return 'admin_key_invalid';
    if (status === 403 || type === 'permission_error') return 'admin_key_forbidden';
    if (status === 404) return 'not_available';
    if (status === 429) return 'rate_limited';
    if (status >= 500) return 'server';
    if (status === 400) return 'bad_request';
    return 'unknown';
  }

  function messageFor(code) {
    return ERROR_MESSAGES[code] || ERROR_MESSAGES.unknown;
  }

  /** 결제 페이지 파싱 결과 상태 → 사용자에게 보여 줄 오류 코드 */
  function balanceErrorCode(parseStatus) {
    switch (parseStatus) {
      case 'login_required':
        return 'login_required';
      case 'label_not_found':
        return 'structure_changed';
      case 'timeout':
        return 'timeout';
      case 'tab_closed':
        return 'tab_closed';
      default:
        return 'parse_failed';
    }
  }

  function normalizeSettings(raw) {
    const s = Object.assign({}, DEFAULT_SETTINGS, raw || {});
    s.primary = s.primary === 'credit' ? 'credit' : 'promo';
    s.alertEnabled = s.alertEnabled !== false;
    const th = Number(s.threshold);
    s.threshold = Number.isFinite(th) && th >= 0 ? th : DEFAULT_SETTINGS.threshold;
    const rm = Number(s.refreshMinutes);
    s.refreshMinutes = [15, 30, 60].indexOf(rm) >= 0 ? rm : DEFAULT_SETTINGS.refreshMinutes;
    if (s.manualRechargeDate && !/^\d{4}-\d{2}-\d{2}$/.test(s.manualRechargeDate)) s.manualRechargeDate = null;
    return s;
  }

  function looksLikeAdminKey(key) {
    return typeof key === 'string' && key.indexOf(ADMIN_KEY_PREFIX) === 0 && /^[A-Za-z0-9_-]{20,}$/.test(key);
  }

  const core = {
    API_BASE,
    COST_PATH,
    ANTHROPIC_VERSION,
    ANALYTICS_BETA,
    BILLING_URL,
    ADMIN_KEYS_URL,
    DEFAULT_SETTINGS,
    HOUR,
    DAY,
    startOfLocalDay,
    startOfLocalWeek,
    startOfLocalMonth,
    floorUtcHour,
    buildCostRange,
    buildCostUrl,
    costHeaders,
    summarizeCost,
    estimateBalance,
    primaryOf,
    secondaryOf,
    hasPromo,
    detectRecharge,
    pickLatestRecharge,
    isLow,
    formatUSD,
    formatCents,
    localDateKey,
    formatWhenKo,
    formatAgoKo,
    formatDateKeyKo,
    classifyApiError,
    messageFor,
    balanceErrorCode,
    normalizeSettings,
    looksLikeAdminKey,
    ERROR_MESSAGES,
  };

  root.CBK = root.CBK || {};
  root.CBK.core = core;
  if (typeof module !== 'undefined' && module.exports) module.exports = core;
})(typeof globalThis !== 'undefined' ? globalThis : this);
