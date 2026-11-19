/*
 * Claude 잔액 키트 — 결제 페이지에서 잔액 · 충전 내역 읽기
 *
 * platform.claude.com 페이지에서만 실행된다(manifest 의 content_scripts).
 * 결제 페이지는 화면이 늦게 채워지므로 최대 15초 동안 0.5초마다 다시 읽는다.
 * 구매 크레딧(Credit balance)과 프로모션 크레딧(Promotional credits 표)은 따로 늦게 그려질 수 있어서,
 * 둘 다 읽히거나 화면 변화가 1.5초 멈출 때까지(최대 6초 더) 기다린 뒤 보낸다.
 * 읽은 결과는 백그라운드로만 보내고, 이 스크립트는 아무 데도 전송하지 않는다.
 */
(function () {
  'use strict';
  if (window.__cbkBillingReader) return;
  window.__cbkBillingReader = true;

  const parse = globalThis.CBK && globalThis.CBK.billing && globalThis.CBK.billing.parseBillingText;
  if (!parse) return;

  const MAX_MS = 15000;
  const TICK_MS = 500;
  const LOGIN_STABLE_MS = 3000; // 로그인 화면이 3초 이상 유지될 때만 "로그인 필요"로 판단
  const SETTLE_MS = 1500; // 화면이 이만큼 안 바뀌면 다 그려진 것으로 본다
  const OK_WAIT_MAX_MS = 6000; // 읽힌 뒤 나머지 구역을 기다리는 최대 시간

  function isBillingPath() {
    return /^\/settings\/billing/.test(location.pathname);
  }

  function isLoginPath() {
    return /^\/(login|signin|sign-in|auth|oauth)/i.test(location.pathname);
  }

  // 결제 페이지도, 로그인 화면도 아니면 할 일이 없다.
  if (!isBillingPath() && !isLoginPath()) return;

  const startedAt = Date.now();
  let loginSince = 0;
  let okSince = 0;
  let lastMutation = Date.now();
  let sent = false;
  let observer = null;
  let timer = null;

  function send(result) {
    if (sent) return;
    sent = true;
    if (observer) observer.disconnect();
    if (timer) clearInterval(timer);
    try {
      chrome.runtime.sendMessage({ type: 'billing-result', url: location.href, result: result }, () => {
        void chrome.runtime.lastError; // 백그라운드가 잠시 꺼져 있어도 오류로 남기지 않음
      });
    } catch (e) {
      /* 확장이 다시 로드된 직후 등 */
    }
  }

  function norm(s) {
    return String(s || '').replace(/\s+/g, ' ').trim();
  }

  // 화면의 표를 { label, headers, rows } 로 읽는다. 클래스 이름이 아니라 표 구조(th/td, role)만 쓴다.
  function readTables() {
    const out = [];
    const tables = document.querySelectorAll('table, [role="table"], [role="grid"]');
    for (const t of tables) {
      const headers = [...t.querySelectorAll('th, [role="columnheader"]')].map((c) => norm(c.textContent));
      const rows = [];
      for (const r of t.querySelectorAll('tr, [role="row"]')) {
        const cells = [...r.children].filter((c) => c.matches('td, [role="cell"], [role="gridcell"]'));
        if (cells.length) rows.push(cells.map((c) => norm(c.textContent)));
      }
      out.push({ label: t.getAttribute('aria-label') || '', headers: headers, rows: rows });
    }
    return out;
  }

  function check() {
    if (sent) return;
    const text = (document.body && document.body.innerText) || '';
    let tables = [];
    try {
      tables = readTables();
    } catch (e) {
      tables = [];
    }
    const r = parse(text, { url: location.href, tables: tables });
    const now = Date.now();
    const elapsed = now - startedAt;

    if (r.status === 'ok') {
      if (!okSince) okSince = now;
      const complete = r.balance !== null && r.promo;
      const settled = now - lastMutation >= SETTLE_MS && now - okSince >= 1000;
      if (complete || settled || now - okSince >= OK_WAIT_MAX_MS || elapsed >= MAX_MS) return send(r);
      return;
    }
    okSince = 0;

    if (r.status === 'login_required') {
      if (!loginSince) loginSince = Date.now();
      if (Date.now() - loginSince >= LOGIN_STABLE_MS) return send(r);
    } else {
      loginSince = 0;
    }

    if (elapsed >= MAX_MS) {
      // 시간 안에 못 읽음. "로딩 중"은 화면 구조 변경과 구분해 둔다.
      return send(r);
    }
  }

  function start() {
    check();
    if (sent) return;
    timer = setInterval(check, TICK_MS);
    let queued = false;
    try {
      // 화면이 바뀔 때마다 바로 읽되, 0.25초에 한 번으로 묶어 부담을 줄인다.
      observer = new MutationObserver(() => {
        lastMutation = Date.now();
        if (queued) return;
        queued = true;
        setTimeout(() => {
          queued = false;
          check();
        }, 250);
      });
      observer.observe(document.documentElement, { childList: true, subtree: true, characterData: true });
    } catch (e) {
      /* 관찰이 안 되면 주기 확인만 사용 */
    }
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', start, { once: true });
  } else {
    start();
  }
})();
