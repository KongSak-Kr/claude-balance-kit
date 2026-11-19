/*
 * Claude 잔액 키트 — 결제 페이지(platform.claude.com/settings/billing) 글자 읽기
 *
 * 원칙
 * - CSS 클래스 이름에 기대지 않는다. 화면에 보이는 글자(innerText)만 쓴다.
 * - "Credit balance" 같은 표시 문구(영어·한국어)를 찾고, 그 바로 아래에서
 *   금액만 단독으로 적힌 줄($12.34)을 잔액으로 본다.
 * - 확실하지 않으면 숫자를 내지 않는다(틀린 숫자보다 "못 읽음"이 낫다).
 *
 * 입력 : 페이지 innerText(줄바꿈 \n, 표 칸 \t) 와 주소
 * 출력 : { status, balance, balanceText, recharges[], latestRecharge }
 *   status : ok | login_required | loading | label_not_found | amount_not_found
 */
(function (root) {
  'use strict';

  const BALANCE_LABELS = [
    'credit balance',
    'credits balance',
    'remaining credit',
    'remaining credits',
    '크레딧 잔액',
    '크레딧 잔고',
    '잔여 크레딧',
    '남은 크레딧',
    '잔액',
  ];

  // 로그인 화면에만 나오는 문구 (2026-11 실제 화면에서 확인한 문구 포함)
  const LOGIN_MARKERS = [
    'continue with google',
    'continue with email',
    'continue with sso',
    'google로 계속',
    'google 계정으로 계속',
    '이메일로 계속',
    'sso로 계속',
  ];

  const LOADING_MARKERS = ['loading', '로드 중', '불러오는 중', '로딩'];

  // 결제 내역에서 "충전(크레딧 구매)" 행으로 볼 문구. 무료·프로모션 크레딧은 제외한다.
  const RECHARGE_MARKERS = [
    'credit grant',
    'credit purchase',
    'credits purchased',
    'prepaid credits',
    'auto-reload',
    'auto reload',
    '크레딧 구매',
    '크레딧 충전',
    '자동 충전',
  ];
  const RECHARGE_EXCLUDE = /(promotional|free credit|프로모션|무료)/i;

  // 금액만 단독으로 있는 줄 : "$12.34", "-$1.00", "US$5", "$1,234.50 USD"
  const AMOUNT_ONLY = /^([-−])?\s*(?:US)?\$\s?([-−])?\s*(\d{1,3}(?:,\d{3})+|\d+)(\.\d+)?\s*(?:USD)?$/;
  // 짧은 줄 맨 앞의 금액 : "$12.34 remaining"
  const AMOUNT_LEAD = /^([-−])?\s*(?:US)?\$\s?([-−])?\s*(\d{1,3}(?:,\d{3})+|\d+)(\.\d+)?(?:\s|$)/;
  // 잔액이 아닌 금액이 섞인 문장(자동 충전 기준, 보너스, 최소 구매액 등)
  const NOT_BALANCE = /(reload|below|top(?:ped)? up|bonus|from|start|minimum|limit|threshold|invoice|due|overdue|promotional|자동|기준|이하|이상|최소|보너스|청구)/i;

  // 잔액 구역이 끝났다고 보는 다음 구역 제목들(이 아래 금액은 잔액이 아님)
  const SECTION_STOP = [
    'invoice history',
    'billing history',
    'payment history',
    'payment method',
    'payment methods',
    'billing address',
    'billing emails',
    'spend limits',
    'promotional credits',
    'current subscription',
    '청구서 내역',
    '결제 내역',
    '결제 수단',
    '청구 주소',
  ];

  const MONTHS = {
    jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6,
    jul: 7, aug: 8, sep: 9, sept: 9, oct: 10, nov: 11, dec: 12,
  };

  function norm(s) {
    return String(s || '')
      .replace(/ /g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
  }

  function labelKey(line) {
    return norm(line).toLowerCase().replace(/[:：]\s*$/, '');
  }

  function toAmount(m) {
    const neg = Boolean(m[1] || m[2]);
    const v = parseFloat(m[3].replace(/,/g, '') + (m[4] || ''));
    if (!Number.isFinite(v)) return null;
    return neg ? -v : v;
  }

  function pad2(n) {
    return (n < 10 ? '0' : '') + n;
  }

  function validDate(y, mo, d) {
    if (!(y >= 2000 && y <= 2100 && mo >= 1 && mo <= 12 && d >= 1 && d <= 31)) return null;
    const dt = new Date(Date.UTC(y, mo - 1, d));
    if (dt.getUTCMonth() !== mo - 1) return null;
    return y + '-' + pad2(mo) + '-' + pad2(d);
  }

  /** 한 줄에서 첫 번째 날짜를 찾아 'YYYY-MM-DD' 로. 없으면 null. */
  function parseDate(text) {
    const s = norm(text);
    let m;
    // 2026-11-03
    if ((m = /(\d{4})-(\d{1,2})-(\d{1,2})/.exec(s))) return validDate(+m[1], +m[2], +m[3]);
    // 2026년 11월 3일
    if ((m = /(\d{4})\s*년\s*(\d{1,2})\s*월\s*(\d{1,2})\s*일/.exec(s))) return validDate(+m[1], +m[2], +m[3]);
    // 2026. 11. 3.
    if ((m = /(\d{4})\.\s*(\d{1,2})\.\s*(\d{1,2})\.?/.exec(s))) return validDate(+m[1], +m[2], +m[3]);
    // Nov 3, 2026 / November 3, 2026
    if ((m = /\b([A-Za-z]{3,9})\.?\s+(\d{1,2}),?\s+(\d{4})\b/.exec(s))) {
      const mo = MONTHS[m[1].slice(0, 4).toLowerCase()] || MONTHS[m[1].slice(0, 3).toLowerCase()];
      if (mo) return validDate(+m[3], mo, +m[2]);
    }
    // 3 Nov 2026
    if ((m = /\b(\d{1,2})\s+([A-Za-z]{3,9})\.?,?\s+(\d{4})\b/.exec(s))) {
      const mo = MONTHS[m[2].slice(0, 4).toLowerCase()] || MONTHS[m[2].slice(0, 3).toLowerCase()];
      if (mo) return validDate(+m[3], mo, +m[1]);
    }
    // 11/03/2026 (미국식 월/일/년)
    if ((m = /\b(\d{1,2})\/(\d{1,2})\/(\d{4})\b/.exec(s))) return validDate(+m[3], +m[1], +m[2]);
    return null;
  }

  function looksLikeLoginUrl(url) {
    if (!url) return false;
    try {
      const u = new URL(url);
      if (u.hostname !== 'platform.claude.com') return /login|signin|sign-in|auth/i.test(u.pathname + u.hostname);
      return /^\/(login|signin|sign-in|auth|oauth)/i.test(u.pathname);
    } catch (e) {
      return false;
    }
  }

  function hasAny(lowerText, markers) {
    for (const m of markers) if (lowerText.indexOf(m) >= 0) return true;
    return false;
  }

  /** 라벨 줄 아래(최대 15줄)에서 잔액 금액을 찾는다. */
  function findBalanceAfter(lines, idx) {
    const end = Math.min(lines.length, idx + 16);
    for (let i = idx + 1; i < end; i++) {
      const key = labelKey(lines[i]);
      // 다른 잔액 라벨이나 다음 구역 제목이 나오면 이 구역은 끝
      if (BALANCE_LABELS.indexOf(key) >= 0 || SECTION_STOP.indexOf(key) >= 0) break;
      // 표의 한 행(칸이 여러 개)은 청구서·크레딧 내역이지 잔액이 아니다
      if (lines[i].split('\t').filter((c) => norm(c)).length > 1) continue;
      const cell = norm(lines[i]);
      let m = AMOUNT_ONLY.exec(cell);
      if (m) return { value: toAmount(m), text: cell, line: i };
      if (cell.length <= 32 && !NOT_BALANCE.test(cell)) {
        m = AMOUNT_LEAD.exec(cell);
        if (m) return { value: toAmount(m), text: cell, line: i };
      }
    }
    return null;
  }

  function findRecharges(rawLines) {
    const found = [];
    for (const line of rawLines) {
      const low = line.toLowerCase();
      if (!hasAny(low, RECHARGE_MARKERS)) continue;
      if (RECHARGE_EXCLUDE.test(line)) continue;
      const date = parseDate(line);
      if (date) found.push({ date: date, text: norm(line).slice(0, 120) });
    }
    found.sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0));
    return found;
  }

  function parseBillingText(text, opts) {
    const url = (opts && opts.url) || '';
    const raw = String(text || '').replace(/\r/g, '');
    const rawLines = raw.split('\n').map((l) => l.replace(/ /g, ' ').trim()).filter(Boolean);
    const lines = rawLines;
    const lower = raw.toLowerCase();

    const loginLike = looksLikeLoginUrl(url) || hasAny(lower, LOGIN_MARKERS);
    const recharges = findRecharges(rawLines);
    const result = {
      status: 'label_not_found',
      balance: null,
      balanceText: null,
      recharges: recharges,
      latestRecharge: recharges.length ? recharges[0].date : null,
    };

    let labelSeen = false;
    let hit = null;
    for (let i = 0; i < lines.length && !hit; i++) {
      if (BALANCE_LABELS.indexOf(labelKey(lines[i])) < 0) continue;
      labelSeen = true;
      hit = findBalanceAfter(lines, i);
    }

    if (hit && hit.value !== null && !looksLikeLoginUrl(url) && !hasAny(lower, LOGIN_MARKERS)) {
      result.status = 'ok';
      result.balance = hit.value;
      result.balanceText = hit.text;
      return result;
    }
    if (loginLike) {
      result.status = 'login_required';
      return result;
    }
    const loading = hasAny(lower, LOADING_MARKERS);
    if (labelSeen) {
      result.status = loading ? 'loading' : 'amount_not_found';
    } else {
      result.status = loading || lines.length < 3 ? 'loading' : 'label_not_found';
    }
    return result;
  }

  const api = { parseBillingText, parseDate, looksLikeLoginUrl, BALANCE_LABELS, LOGIN_MARKERS };
  root.CBK = root.CBK || {};
  root.CBK.billing = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
