/*
 * 설치안내서 그림 만들기 (개발용 도구) — 만들어진 PNG 는 저장소에 함께 올리므로 사용자는 실행할 필요 없음.
 *
 *   준비 : npm i --no-save playwright && npx playwright install chromium
 *   실행 : node tools/make-manual-images.js
 *
 * - 실제 화면 : 크로미움(한국어)의 확장 프로그램 화면, 이 확장의 팝업 · 설정 화면을 직접 찍고 빨간 테두리로 표시
 * - 예시 그림 : 맥 터미널 · Spotlight · 폴더로 이동 창 · 크롬 핀 메뉴처럼 여기서 찍을 수 없는 화면은 비슷하게 그린 그림
 */
'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { chromium } = require('playwright');

const ROOT = path.resolve(__dirname, '..');
const EXT = path.join(ROOT, 'extension');
const OUT = path.join(ROOT, 'manual', 'img');
const KO_ENV = { ...process.env, LANGUAGE: 'ko', LANG: 'ko_KR.UTF-8', LC_ALL: 'ko_KR.UTF-8' };

// ── 표시(빨간 테두리 + 번호) 그리기 ─────────────────────────────────
async function annotate(browser, pngBuf, cssWidth, marks, outName, crop) {
  const page = await browser.newPage({ deviceScaleFactor: 2 });
  const b64 = pngBuf.toString('base64');
  const c = crop || null;
  if (c) marks = marks.map((m) => ({ ...m, x: m.x - c.x, y: m.y - c.y, bx: m.bx != null ? m.bx - c.x : undefined, by: m.by != null ? m.by - c.y : undefined }));
  const boxes = marks
    .map(
      (m) => `<div class="box" style="left:${m.x - 5}px;top:${m.y - 5}px;width:${m.w + 10}px;height:${m.h + 10}px"></div>` +
        (m.label ? `<div class="badge" style="left:${m.bx != null ? m.bx : m.x - 22}px;top:${m.by != null ? m.by : m.y - 22}px">${m.label}</div>` : ''),
    )
    .join('');
  await page.setContent(`<!doctype html><html><head><style>
    body{margin:0;background:#fff}
    .wrap{position:relative;display:inline-block;padding:22px 26px 22px 56px;background:#eceae4}
    .inner{position:relative;${c ? `width:${c.w}px;height:${c.h}px;` : `width:${cssWidth}px;`}}
    .clip{${c ? `width:${c.w}px;height:${c.h}px;overflow:hidden;` : ''}border-radius:8px;box-shadow:0 6px 20px rgba(0,0,0,.18);background:#fff}
    img{width:${cssWidth}px;display:block;${c ? `margin:-${c.y}px 0 0 -${c.x}px;` : ''}}
    .box{position:absolute;border:3px solid #e0342b;border-radius:10px;box-shadow:0 0 0 3px rgba(255,255,255,.7)}
    .badge{position:absolute;min-width:34px;height:34px;padding:0 6px;border-radius:17px;background:#e0342b;color:#fff;
      font:700 20px/34px -apple-system,"Apple SD Gothic Neo","Noto Sans KR",sans-serif;text-align:center;box-shadow:0 2px 6px rgba(0,0,0,.25)}
  </style></head><body><div class="wrap"><div class="inner"><div class="clip"><img src="data:image/png;base64,${b64}"></div>${boxes}</div></div></body></html>`);
  await page.waitForTimeout(150);
  const el = await page.$('.wrap');
  fs.writeFileSync(path.join(OUT, outName), await el.screenshot());
  await page.close();
  console.log('만듦 :', outName);
}

// 그림자 DOM 안쪽 요소의 위치
async function deepBox(page, pathSel) {
  return page.evaluate((sels) => {
    let node = document;
    for (let i = 0; i < sels.length; i++) {
      const root = node.shadowRoot || node;
      node = root.querySelector(sels[i]);
      if (!node) return null;
    }
    const r = node.getBoundingClientRect();
    return { x: r.x, y: r.y, w: r.width, h: r.height };
  }, pathSel);
}

async function shotExtensionsPage(withExtension, devMode, height) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cbk-img-'));
  const args = ['--lang=ko'];
  if (withExtension) args.push('--disable-extensions-except=' + EXT, '--load-extension=' + EXT);
  const ctx = await chromium.launchPersistentContext(dir, {
    channel: 'chromium', headless: true, locale: 'ko-KR', env: KO_ENV, args, deviceScaleFactor: 2,
  });
  for (const p of ctx.pages()) if (p.url().includes('options.html')) await p.close();
  const page = await ctx.newPage();
  await page.setViewportSize({ width: 1000, height: height || 300 });
  await page.goto('chrome://extensions');
  await page.waitForTimeout(800);
  if (devMode) {
    await page.evaluate(() => {
      const t = document.querySelector('extensions-manager').shadowRoot.querySelector('extensions-toolbar').shadowRoot.querySelector('#devMode');
      if (!t.checked) t.click();
    });
    await page.waitForTimeout(800);
  }
  // "조직에서 관리하는 브라우저" 안내는 시험용 크로미움에만 나오므로 숨김
  await page.evaluate(() => {
    const walk = (root) => {
      for (const el of root.querySelectorAll('*')) {
        if (el.shadowRoot) walk(el.shadowRoot);
        const own = [...el.childNodes].filter((n) => n.nodeType === 3).map((n) => n.textContent).join('');
        if (own.includes('조직에서') || (el.textContent.includes('관리하는 브라우저') && el.children.length <= 3 && el.textContent.length < 40)) {
          el.style.display = 'none';
          // 건물 아이콘까지 : 아이콘을 함께 품은 가장 가까운 상위 요소를 숨김
          let up = el.parentElement;
          for (let i = 0; up && i < 4; i++, up = up.parentElement) {
            if (up.querySelector('cr-icon, iron-icon')) {
              up.style.display = 'none';
              break;
            }
          }
        }
      }
    };
    walk(document);
    // 남은 건물 모양 아이콘(관리 정책 표시)도 숨김
    const hideIcons = (root) => {
      for (const el of root.querySelectorAll('*')) {
        if (el.shadowRoot) hideIcons(el.shadowRoot);
        const icon = el.getAttribute && (el.getAttribute('icon') || el.getAttribute('iron-icon') || '');
        if (/domain|business|managed/i.test(icon)) el.style.display = 'none';
        if (el.tagName === 'CR-ICON' && !icon) {
          const b = el.getBoundingClientRect();
          if (b.y > 40 && b.x > 300 && b.width > 0) el.style.visibility = 'hidden'; // 가운데 관리 정책 아이콘
        }
      }
    };
    hideIcons(document);
  });
  await page.waitForTimeout(200);
  const buf = await page.screenshot();
  const boxes = {
    devMode: await deepBox(page, ['extensions-manager', 'extensions-toolbar', '#devMode']),
    devModeLabel: await deepBox(page, ['extensions-manager', 'extensions-toolbar', '#devModeLabel']),
    loadUnpacked: await deepBox(page, ['extensions-manager', 'extensions-toolbar', '#loadUnpacked']),
    item: await deepBox(page, ['extensions-manager', 'extensions-item-list', 'extensions-item']),
    reload: await deepBox(page, ['extensions-manager', 'extensions-item-list', 'extensions-item', '#dev-reload-button']),
  };
  await ctx.close();
  fs.rmSync(dir, { recursive: true, force: true });
  return { buf, boxes };
}

function union(a, b) {
  if (!a) return b;
  if (!b) return a;
  const x = Math.min(a.x, b.x), y = Math.min(a.y, b.y);
  return { x, y, w: Math.max(a.x + a.w, b.x + b.w) - x, h: Math.max(a.y + a.h, b.y + b.h) - y };
}

// ── 확장 팝업 · 설정 화면 (실제) ───────────────────────────────────
async function shotExtensionPages(browser) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cbk-img-'));
  const ctx = await chromium.launchPersistentContext(dir, {
    channel: 'chromium', headless: true, locale: 'ko-KR', timezoneId: 'Asia/Seoul', env: KO_ENV, deviceScaleFactor: 2,
    args: ['--lang=ko', '--disable-extensions-except=' + EXT, '--load-extension=' + EXT,
      '--host-resolver-rules=MAP platform.claude.com 127.0.0.1:9, MAP api.anthropic.com 127.0.0.1:9'], // 실제로 나가지 않게
  });
  let sw = ctx.serviceWorkers()[0];
  if (!sw) sw = await ctx.waitForEvent('serviceworker');
  const id = sw.url().split('/')[2];
  const now = Date.now();
  const base = {
    balance: {
      value: 0,
      promo: { total: 41.75, count: 2, nextExpiry: '2026-12-31', nextExpiryAmount: 37.5, latestGranted: '2026-11-12', items: [] },
      measuredAt: now - 40000,
      source: 'button',
    },
    balanceStatus: { state: 'ok', at: now - 40000, source: 'button' },
    lastCheckAt: now,
    recharge: { history: { date: '2026-11-03', seenAt: now }, promo: { date: '2026-11-12', seenAt: now } },
    alert: { low: false, notified: false },
  };

  // 1) 관리자 키 없이 (처음 상태)
  await sw.evaluate((o) => chrome.storage.local.clear().then(() => chrome.storage.local.set(o)), base);
  let p = await ctx.newPage();
  await p.setViewportSize({ width: 340, height: 560 });
  await p.goto(`chrome-extension://${id}/popup.html`);
  await p.waitForTimeout(11000); // "1분 안에 이미 확인" 안내가 사라질 때까지
  fs.writeFileSync(path.join(OUT, 'popup-basic.png'), await p.screenshot({ clip: { x: 0, y: 0, width: 340, height: await p.evaluate(() => document.body.scrollHeight) } }));
  console.log('만듦 : popup-basic.png');
  await p.close();

  // 2) 관리자 키를 넣은 상태 (사용액 표시)
  const refreshed = new Date(now - 4 * 3600000).toISOString();
  await sw.evaluate((o) => chrome.storage.local.set(o), {
    adminKey: ['sk', 'ant', 'admin01', 'x'.repeat(40)].join('-'), // 그림용 가짜 값
    lastCheckAt: Date.now(),
    usage: { todayCents: 120, weekCents: 365, monthCents: 1365, sinceMeasuredCents: 0, forMeasuredAt: base.balance.measuredAt, dataRefreshedAt: refreshed, fetchedAt: now, attemptedAt: now, loading: false, error: null },
  });
  p = await ctx.newPage();
  await p.setViewportSize({ width: 340, height: 560 });
  await p.goto(`chrome-extension://${id}/popup.html`);
  await p.waitForTimeout(11000);
  fs.writeFileSync(path.join(OUT, 'popup-full.png'), await p.screenshot({ clip: { x: 0, y: 0, width: 340, height: await p.evaluate(() => document.body.scrollHeight) } }));
  console.log('만듦 : popup-full.png');
  await p.close();

  // 3) 설정 화면 — 관리자 키 칸 표시
  await sw.evaluate(() => chrome.storage.local.remove(['adminKey', 'keySavedAt']));
  p = await ctx.newPage();
  await p.setViewportSize({ width: 760, height: 1300 });
  await p.goto(`chrome-extension://${id}/options.html`);
  await p.waitForTimeout(600);
  const opt = await p.screenshot({ clip: { x: 0, y: 0, width: 760, height: 980 } });
  const field = await p.evaluate(() => {
    const a = document.getElementById('admin-key').getBoundingClientRect();
    const b = document.getElementById('test-key').getBoundingClientRect();
    return { a: { x: a.x, y: a.y, w: a.width, h: a.height }, b: { x: b.x, y: b.y, w: b.width, h: b.height } };
  });
  await annotate(browser, opt, 760, [
    { ...field.a, label: '1', bx: field.a.x - 54, by: field.a.y },
    { ...field.b, label: '2', bx: field.b.x - 54, by: field.b.y },
  ], 'options-admin-key.png');
  await p.close();
  await ctx.close();
  fs.rmSync(dir, { recursive: true, force: true });
}

// ── 예시 그림 (HTML 로 그림) ────────────────────────────────────────
const FONT = '-apple-system, BlinkMacSystemFont, "Apple SD Gothic Neo", "Noto Sans KR", sans-serif';
const MONO = 'Menlo, "D2Coding", "Noto Sans Mono CJK KR", "DejaVu Sans Mono", monospace';

function terminal(title, lines, width) {
  const body = lines
    .map((l) => {
      if (typeof l === 'string') return `<div>${l || '&nbsp;'}</div>`;
      return `<div class="${l.c}">${l.t || '&nbsp;'}</div>`;
    })
    .join('');
  return `<div class="term" style="width:${width || 760}px">
    <div class="bar"><span class="dot r"></span><span class="dot y"></span><span class="dot g"></span><span class="ttl">${title}</span></div>
    <div class="scr">${body}</div></div>`;
}

const STYLE = `
  body{margin:0;padding:28px;background:#eceae4;font-family:${FONT};}
  .cap{font:600 15px/1.4 ${FONT};color:#5b6570;margin:0 0 10px 4px}
  .term{border-radius:12px;overflow:hidden;box-shadow:0 12px 30px rgba(0,0,0,.25);background:#fff;border:1px solid #c9c9c9}
  .bar{height:30px;background:linear-gradient(#ececec,#d9d9d9);display:flex;align-items:center;padding:0 12px;border-bottom:1px solid #bdbdbd;position:relative}
  .dot{width:12px;height:12px;border-radius:6px;margin-right:8px;display:inline-block}
  .r{background:#ff5f57}.y{background:#febc2e}.g{background:#28c840}
  .ttl{position:absolute;left:0;right:0;text-align:center;font:13px ${FONT};color:#444;pointer-events:none}
  .scr{padding:14px 16px;font:14px/1.6 ${MONO};color:#1d1d1f;white-space:pre-wrap;word-break:break-all}
  .b{font-weight:700}.dim{color:#8a8a8a}.ok{color:#1a7f37}.hl{background:#fff3b0}
  .cursor{display:inline-block;width:9px;height:17px;background:#1d1d1f;vertical-align:-3px}
  .callout{display:inline-block;margin:14px 0 0 4px;padding:8px 14px;border-radius:8px;background:#e0342b;color:#fff;font:600 15px/1.4 ${FONT}}
`;

async function drawing(browser, name, html, width) {
  const page = await browser.newPage({ deviceScaleFactor: 2 });
  await page.setViewportSize({ width: (width || 820) + 56, height: 400 });
  await page.setContent(`<!doctype html><html><head><meta charset="utf-8"><style>${STYLE}</style></head><body><div id="c">${html}</div></body></html>`);
  await page.waitForTimeout(200);
  const el = await page.$('body');
  fs.writeFileSync(path.join(OUT, name), await el.screenshot());
  await page.close();
  console.log('만듦 :', name);
}

const CMD = 'curl -fsSL https://raw.githubusercontent.com/KongSak-Kr/claude-balance-kit/main/install.sh | bash';

async function drawings(browser) {
  await drawing(browser, 'spotlight.png', `
    <div style="width:640px;margin:20px auto;border-radius:14px;background:rgba(246,246,246,.97);box-shadow:0 18px 40px rgba(0,0,0,.28);overflow:hidden;border:1px solid #ccc">
      <div style="display:flex;align-items:center;padding:14px 18px;font:26px ${FONT};color:#222">
        <span style="font-size:24px;color:#888;margin-right:12px">⌕</span>터미널<span class="cursor" style="height:26px;margin-left:2px"></span></div>
      <div style="border-top:1px solid #ddd;padding:10px 14px;display:flex;align-items:center;background:#2f6fde;color:#fff;font:17px ${FONT}">
        <span style="width:34px;height:34px;border-radius:8px;background:#1d1d1f;color:#fff;display:inline-flex;align-items:center;justify-content:center;font:13px ${MONO};margin-right:12px">&gt;_</span>
        터미널 <span style="margin-left:auto;font-size:14px;opacity:.85">응용 프로그램</span></div>
    </div>
    <div style="text-align:center"><span class="callout">⌘ + 스페이스 → 터미널 입력 → return(엔터)</span></div>`, 700);

  await drawing(browser, 'terminal-paste.png', terminal('사용자 — zsh — 80×24', [
    { c: '', t: `Last login: Thu Nov 19 10:02:11 on console` },
    { c: 'hl', t: `me@MacBook ~ % ${CMD}` },
    '',
    { c: 'b', t: 'Claude 잔액 키트 설치를 시작합니다' },
    '',
    '  · 10분쯤 걸려요. 아래에 나오는 안내를 위에서부터 하나씩 따라 하면 돼요.',
    '  · 「엔터」를 누르라고 나오면 키보드 오른쪽의 return(엔터) 키를 누르세요.',
    '',
    { c: 'b', t: '  ▶ 준비되면 엔터를 누르세요. <span class="cursor"></span>' },
  ]) + '<span class="callout">노란 줄처럼 붙여 넣고 return(엔터) → 안내가 나오면 시작이에요</span>');

  await drawing(browser, 'terminal-key.png', terminal('사용자 — zsh — 80×24', [
    { c: 'b', t: '[2/7] Anthropic API 키' },
    '',
    '  OpenCode 가 Claude 를 쓰려면 「API 키」가 필요해요. 크롬에서 하나 만들어 주세요.',
    '',
    '   ① 크롬에 Anthropic 「API keys」 화면을 열었어요. (로그인 화면이 나오면 먼저 로그인)',
    '   ② 오른쪽 위 「Create key」 버튼을 누르세요.',
    '   ③ 이름(Name) 칸에 OpenCode 라고 쓰세요.',
    '   ④ Workspace 를 고르는 칸이 있으면 「Default」 를 고르세요.',
    '   ⑤ 「Add」 버튼을 누르세요.',
    '   ⑥ sk-ant- 로 시작하는 긴 키가 나오면 옆의 「Copy」 를 누르세요.',
    '   ⑦ 이 터미널 창을 한 번 누르고 ⌘V(붙여넣기) → 엔터',
    { c: 'dim', t: '      붙여 넣어도 화면에 아무것도 안 보이는 게 정상이에요(비밀번호처럼 숨겨져요).' },
    '',
    { c: 'hl', t: '  API 키 : <span class="cursor"></span>' },
  ]) + '<span class="callout">⌘V 를 눌러도 글자가 안 보이는 게 정상! 그대로 return(엔터)</span>');

  await drawing(browser, 'terminal-wait.png', terminal('사용자 — zsh — 80×24', [
    '  ▶ 다 했으면 이 터미널 창을 한 번 누르고 엔터(return)를 누르세요.',
    '  크롬에 들어갔는지 확인하는 중....',
    { c: 'ok', t: '  ✓ 크롬에 잘 들어갔어요!' },
  ], 760) + '<span class="callout">크롬에서 할 일을 마치면 터미널로 돌아와 return(엔터)</span>');

  await drawing(browser, 'terminal-done.png', terminal('사용자 — zsh — 80×24', [
    { c: 'b', t: '────────────── 설치가 끝났어요 ──────────────' },
    '',
    '  · 잔액 보기      : 크롬 주소창 오른쪽 청록색 $ 아이콘을 누르세요',
    '  · OpenCode 쓰기  : 바탕화면의 「OpenCode 열기」 아이콘을 두 번 누르세요',
    '  · 업데이트      : 이번과 같은 한 줄을 다시 붙여 넣기',
    '',
    '  이 터미널 창은 이제 닫아도 돼요.',
  ]));

  await drawing(browser, 'goto-folder.png', `
    <div style="width:720px;border-radius:12px;background:#f6f6f6;border:1px solid #bbb;box-shadow:0 14px 34px rgba(0,0,0,.25);overflow:hidden">
      <div style="height:40px;background:#e9e9e9;border-bottom:1px solid #cfcfcf;display:flex;align-items:center;padding:0 14px;font:14px ${FONT};color:#555">압축해제된 확장 프로그램 디렉터리를 선택하세요.</div>
      <div style="height:200px;position:relative;background:#fff">
        <div style="position:absolute;left:110px;top:24px;width:480px;border-radius:10px;background:#fbfbfb;border:1px solid #c8c8c8;box-shadow:0 8px 24px rgba(0,0,0,.2);padding:14px 16px">
          <div style="font:600 14px ${FONT};color:#333;margin-bottom:8px">폴더로 이동 :</div>
          <div style="border:3px solid #e0342b;border-radius:6px;padding:6px 8px;font:15px ${MONO};background:#fff">/Users/me/ClaudeBalanceKit/extension<span class="cursor" style="height:16px"></span></div>
        </div>
      </div>
      <div style="height:54px;border-top:1px solid #d5d5d5;display:flex;align-items:center;justify-content:flex-end;padding:0 16px;gap:10px;font:14px ${FONT}">
        <span style="padding:5px 16px;border-radius:6px;background:#fff;border:1px solid #c5c5c5">취소</span>
        <span style="padding:5px 16px;border-radius:6px;background:#2f6fde;color:#fff;outline:3px solid #e0342b;outline-offset:3px">선택</span>
      </div>
    </div>
    <div><span class="callout">⌘+Shift+G → ⌘V → return(엔터) → 「선택」</span></div>`, 740);

  await drawing(browser, 'pin.png', `
    <div style="width:720px;border-radius:12px;background:#fff;border:1px solid #c9c9c9;box-shadow:0 12px 30px rgba(0,0,0,.22);overflow:hidden">
      <div style="height:46px;background:#f1f3f4;display:flex;align-items:center;padding:0 12px;gap:10px;border-bottom:1px solid #dadce0">
        <div style="flex:1;height:30px;border-radius:15px;background:#fff;border:1px solid #dadce0;font:14px ${FONT};color:#5f6368;display:flex;align-items:center;padding:0 14px">platform.claude.com/settings/billing</div>
        <span style="width:30px;height:30px;border-radius:15px;display:inline-flex;align-items:center;justify-content:center;font-size:19px;outline:3px solid #e0342b;outline-offset:2px">🧩</span>
        <span style="width:30px;height:30px;border-radius:15px;background:#e8eaed"></span>
      </div>
      <div style="position:relative;height:190px">
        <div style="position:absolute;right:14px;top:8px;width:330px;border-radius:10px;background:#fff;box-shadow:0 6px 20px rgba(0,0,0,.25);padding:10px 0;font:14px ${FONT};color:#202124">
          <div style="padding:6px 16px;font-weight:600">확장 프로그램</div>
          <div style="display:flex;align-items:center;padding:10px 16px;background:#f1f3f4">
            <span style="display:inline-flex;align-items:center;justify-content:center;width:24px;height:24px;border-radius:6px;background:#2f5d62;color:#fff;font:700 15px ${FONT};margin-right:12px;flex:none">$</span>
            Claude 잔액 키트
            <span style="margin-left:auto;font-size:18px;outline:3px solid #e0342b;outline-offset:3px;border-radius:4px">📌</span>
          </div>
          <div style="padding:10px 16px;color:#5f6368">확장 프로그램 관리</div>
        </div>
      </div>
    </div>
    <div><span class="callout">퍼즐 조각 → 「Claude 잔액 키트」 옆 핀(압정)</span></div>`, 740);
}

(async () => {
  fs.mkdirSync(OUT, { recursive: true });
  const browser = await chromium.launch();

  // 확장 프로그램 화면 (실제)
  let s = await shotExtensionsPage(false, false, 160);
  const dm = union(s.boxes.devModeLabel, s.boxes.devMode);
  await annotate(browser, s.buf, 1000, [{ ...dm, label: '1', bx: dm.x - 52, by: dm.y - 2 }], 'ext-devmode.png', { x: 520, y: 0, w: 480, h: 110 });
  s = await shotExtensionsPage(false, true, 170);
  await annotate(browser, s.buf, 1000, [{ ...s.boxes.loadUnpacked, label: '2', bx: s.boxes.loadUnpacked.x - 50, by: s.boxes.loadUnpacked.y + 4 }], 'ext-load-unpacked.png', { x: 0, y: 0, w: 560, h: 140 });
  s = await shotExtensionsPage(true, true, 470);
  const cardCrop = { x: 0, y: 150, w: 620, h: 320 };
  await annotate(browser, s.buf, 1000, [{ ...s.boxes.item, label: '✓', bx: s.boxes.item.x - 50, by: s.boxes.item.y }], 'ext-card.png', cardCrop);
  await annotate(browser, s.buf, 1000, [{ ...s.boxes.reload, label: '↻', bx: s.boxes.reload.x - 46, by: s.boxes.reload.y }], 'ext-reload.png', cardCrop);

  await shotExtensionPages(browser);
  await drawings(browser);
  await browser.close();
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
