/*
 * 테스트용 : HTML → 브라우저 innerText 와 비슷한 글자로 바꾼다.
 * (블록 요소는 줄바꿈, 표 칸은 탭, 인라인 요소는 이어 붙임)
 * 실제 확장은 브라우저의 document.body.innerText 를 쓴다.
 */
'use strict';

const BLOCK = /^(address|article|aside|blockquote|body|dd|details|dialog|div|dl|dt|fieldset|figcaption|figure|footer|form|h[1-6]|header|hr|html|li|main|nav|ol|p|pre|section|summary|table|tbody|tfoot|thead|tr|ul)$/i;

function decode(s) {
  return s
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#x27;|&#39;/g, "'")
    .replace(/&#(\d+);/g, (m, n) => String.fromCharCode(Number(n)));
}

function htmlToText(html) {
  let s = String(html)
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/<(script|style|svg|noscript)\b[\s\S]*?<\/\1>/gi, '');
  s = s.replace(/<\/?([a-zA-Z0-9]+)\b[^>]*>/g, (m, tag) => {
    const t = tag.toLowerCase();
    if (t === 'br') return '\n';
    if (t === 'td' || t === 'th') return m[1] === '/' ? '\t' : '';
    if (BLOCK.test(t)) return '\n';
    return '';
  });
  s = decode(s);
  return s
    .split('\n')
    .map((line) => line.replace(/[ \f\v\r]+/g, ' ').replace(/ *\t */g, '\t').replace(/\t+$/, '').trim())
    .filter(Boolean)
    .join('\n');
}

/** 테스트용 : HTML 의 표를 확장의 content-billing.js 가 만드는 모양({ label, headers, rows })으로 */
function htmlToTables(html) {
  const strip = (x) => decode(x.replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ').trim();
  const out = [];
  for (const m of String(html).matchAll(/<table\b([^>]*)>([\s\S]*?)<\/table>/gi)) {
    const label = (/aria-label="([^"]*)"/i.exec(m[1]) || [])[1] || '';
    const headers = [...m[2].matchAll(/<th\b[^>]*>([\s\S]*?)<\/th>/gi)].map((x) => strip(x[1]));
    const rows = [];
    for (const r of m[2].matchAll(/<tr\b[^>]*>([\s\S]*?)<\/tr>/gi)) {
      const cells = [...r[1].matchAll(/<td\b[^>]*>([\s\S]*?)<\/td>/gi)].map((x) => strip(x[1]));
      if (cells.length) rows.push(cells);
    }
    out.push({ label, headers, rows });
  }
  return out;
}

module.exports = { htmlToText, htmlToTables };
