/*
 * Claude 잔액 키트 — 결제 페이지에서 잔액 · 충전 내역 읽기
 *
 * platform.claude.com 페이지에서만 실행된다(manifest 의 content_scripts).
 * 결제 페이지는 화면이 늦게 채워지므로 최대 15초 동안 0.5초마다 다시 읽는다.
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

  function check() {
    if (sent) return;
    const text = (document.body && document.body.innerText) || '';
    const r = parse(text, { url: location.href });
    const elapsed = Date.now() - startedAt;

    if (r.status === 'ok') return send(r);

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
