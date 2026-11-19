/*
 * 설치 안내서(manual/index.html)를 PDF 로 만든다 (개발용 도구).
 *   node tools/make-manual-pdf.js [저장할 파일]
 */
'use strict';
const path = require('node:path');
const { chromium } = require('playwright');

(async () => {
  const out = process.argv[2] || path.resolve('Claude잔액키트_설치안내서.pdf');
  const browser = await chromium.launch();
  const page = await browser.newPage();
  await page.goto('file://' + path.resolve(__dirname, '..', 'manual', 'index.html'));
  await page.evaluate(() => document.querySelectorAll('details').forEach((d) => (d.open = true))); // 문제 해결 내용 펼치기
  await page.waitForTimeout(500);
  await page.pdf({
    path: out,
    format: 'A4',
    printBackground: true,
    margin: { top: '14mm', bottom: '16mm', left: '12mm', right: '12mm' },
    displayHeaderFooter: true,
    headerTemplate: '<span></span>',
    footerTemplate: '<div style="width:100%;text-align:center;font-size:9px;color:#888"><span class="pageNumber"></span> / <span class="totalPages"></span></div>',
  });
  await browser.close();
  console.log('만듦 :', out);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
