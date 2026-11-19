/*
 * Claude 잔액 키트 — 결제 페이지(platform.claude.com/settings/billing) 글자 읽기
 *
 * 원칙
 * - CSS 클래스 이름에 기대지 않는다. 화면에 보이는 글자(innerText)만 쓴다.
 * - "Credit balance" 같은 표시 문구(영어·한국어)를 찾고, 그 바로 아래에서
 *   금액만 단독으로 적힌 줄($12.34)을 잔액으로 본다.
 * - 확실하지 않으면 숫자를 내지 않는다(틀린 숫자보다 "못 읽음"이 낫다).
 *
 * 입력 : 페이지 innerText(줄바꿈 \n, 표 칸 \t) 와 주소, (있으면) 페이지의 표들 { label, headers[], rows[][] }
 * 출력 : { status, balance, balanceText, promo, recharges[], latestRecharge }
 *   status : ok | login_required | loading | label_not_found | amount_not_found
 *   balance : "Credit balance"(구매한 크레딧) 금액
 *   promo   : "Promotional credits" 표의 합계 { total, count, nextExpiry, nextExpiryAmount, latestGranted, items[] } 또는 null
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

  // 프로모션 크레딧 구역 (2026-11 실제 화면 : 제목 "Promotional credits",
  // 표 칸 = [Name] · Remaining balance · Applies to · Expires on · Date granted, 남은 금액 칸은 "$12.34 of $50.00" 또는 "$12.34 remaining")
  const PROMO_HEADINGS = ['promotional credits', 'promotional credit', '프로모션 크레딧'];
  const PROMO_HDR = {
    remaining: /remaining|남은|잔여/i,
    expires: /expires|expiry|expiration|만료/i,
    granted: /granted|지급|부여/i,
    scope: /applies|적용/i,
    name: /^(name|이름)\b/i,
  };
  const MONEY_G = /([-−])?\s*(?:US)?\$\s?([-−])?\s*(\d{1,3}(?:,\d{3})+|\d+)(\.\d+)?/g;

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

  function amountsIn(text) {
    const out = [];
    const re = new RegExp(MONEY_G.source, 'g');
    let m;
    while ((m = re.exec(String(text || '')))) {
      const v = toAmount(m);
      if (v !== null) out.push(v);
    }
    return out;
  }

  function round2(v) {
    return Math.round(v * 100) / 100;
  }

  function localDateKey(t) {
    const d = new Date(t);
    return d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate());
  }

  function promoItem(cells, todayKey) {
    const amounts = amountsIn(cells.remaining);
    if (!amounts.length) return null;
    const remaining = amounts[0];
    const granted = /\bof\b|\/|중/.test(cells.remaining || '') && amounts.length > 1 ? amounts[1] : null;
    const expires = parseDate(cells.expires || '');
    const grantedAt = parseDate(cells.granted || '');
    return {
      name: norm(cells.name || '').slice(0, 60) || null,
      remaining: remaining,
      granted: granted,
      expires: expires,
      grantedAt: grantedAt,
      appliesTo: norm(cells.scope || '').slice(0, 80) || null,
      expired: Boolean(expires && todayKey && expires < todayKey),
    };
  }

  function summarizePromo(items) {
    if (!items.length) return null;
    const active = items.filter((x) => !x.expired);
    let total = 0;
    for (const x of active) total += x.remaining;
    const upcoming = active.filter((x) => x.remaining > 0 && x.expires).sort((a, b) => (a.expires < b.expires ? -1 : 1));
    let latestGranted = null;
    for (const x of items) if (x.grantedAt && (!latestGranted || x.grantedAt > latestGranted)) latestGranted = x.grantedAt;
    return {
      total: round2(total),
      count: active.length,
      nextExpiry: upcoming.length ? upcoming[0].expires : null,
      nextExpiryAmount: upcoming.length ? upcoming[0].remaining : null,
      latestGranted: latestGranted,
      items: items.slice(0, 10),
    };
  }

  /** 표(구조)에서 프로모션 크레딧 읽기 — 칸 이름으로 위치를 찾는다(CSS 이름에 기대지 않음) */
  function parsePromoFromTables(tables, todayKey) {
    for (const t of tables || []) {
      const headers = (t.headers || []).map((h) => norm(h));
      const label = norm(t.label || '');
      const idx = (re) => headers.findIndex((h) => re.test(h));
      const rem = idx(PROMO_HDR.remaining);
      if (rem < 0) continue;
      if (headers.some((h) => /invoice|청구서/i.test(h))) continue;
      if (!/promo|프로모션/i.test(label) && idx(PROMO_HDR.expires) < 0) continue;
      const col = { remaining: rem, expires: idx(PROMO_HDR.expires), granted: idx(PROMO_HDR.granted), scope: idx(PROMO_HDR.scope), name: idx(PROMO_HDR.name) };
      const items = [];
      for (const row of t.rows || []) {
        const cell = (k) => (col[k] >= 0 && col[k] < row.length ? row[col[k]] : '');
        const it = promoItem({ remaining: cell('remaining'), expires: cell('expires'), granted: cell('granted'), scope: cell('scope'), name: cell('name') }, todayKey);
        if (it) items.push(it);
      }
      const sum = summarizePromo(items);
      if (sum) return sum;
    }
    return null;
  }

  /** 표 구조를 못 받았을 때 : 글자에서 "Promotional credits" 구역의 "$x of $y" / "$x remaining" 을 읽는다 */
  function parsePromoFromText(lines, todayKey) {
    const start = lines.findIndex((l) => PROMO_HEADINGS.indexOf(labelKey(l)) >= 0);
    if (start < 0) return null;
    const items = [];
    const end = Math.min(lines.length, start + 80);
    for (let i = start + 1; i < end; i++) {
      const key = labelKey(lines[i]);
      if (BALANCE_LABELS.indexOf(key) >= 0 || (SECTION_STOP.indexOf(key) >= 0 && PROMO_HEADINGS.indexOf(key) < 0)) break;
      const line = lines[i];
      if (!/\$\s?\d/.test(line) || !/\bof\b|remaining|남음|남은/i.test(line)) continue;
      const parts = line.split('\t').map(norm);
      const remCell = parts.find((p) => /\$\s?\d/.test(p) && /\bof\b|remaining|남음|남은/i.test(p)) || line;
      let rest = parts.slice(parts.indexOf(remCell) + 1).join(' ');
      if (!parseDate(rest)) rest = rest + ' ' + (lines[i + 1] || '') + ' ' + (lines[i + 2] || '');
      const it = promoItem({ remaining: remCell, expires: rest, granted: '', scope: '', name: parts.indexOf(remCell) > 0 ? parts[0] : '' }, todayKey);
      if (it) items.push(it);
    }
    return summarizePromo(items);
  }

  function parseBillingText(text, opts) {
    const url = (opts && opts.url) || '';
    const raw = String(text || '').replace(/\r/g, '');
    const rawLines = raw.split('\n').map((l) => l.replace(/ /g, ' ').trim()).filter(Boolean);
    const lines = rawLines;
    const lower = raw.toLowerCase();

    const loginLike = looksLikeLoginUrl(url) || hasAny(lower, LOGIN_MARKERS);
    const recharges = findRecharges(rawLines);
    const todayKey = localDateKey((opts && opts.now) || Date.now());
    const promo = (opts && opts.tables && parsePromoFromTables(opts.tables, todayKey)) || parsePromoFromText(lines, todayKey);
    const result = {
      status: 'label_not_found',
      balance: null,
      balanceText: null,
      promo: promo,
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

    const loggedOut = looksLikeLoginUrl(url) || hasAny(lower, LOGIN_MARKERS);
    if (hit && hit.value !== null && !loggedOut) {
      result.status = 'ok';
      result.balance = hit.value;
      result.balanceText = hit.text;
      return result;
    }
    if (promo && !loggedOut) {
      result.status = 'ok'; // 프로모션 크레딧만 읽힌 경우(구매 크레딧 카드는 아직 로딩 중일 수 있음)
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

  const api = { parseBillingText, parseDate, looksLikeLoginUrl, parsePromoFromTables, parsePromoFromText, BALANCE_LABELS, LOGIN_MARKERS };
  root.CBK = root.CBK || {};
  root.CBK.billing = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
