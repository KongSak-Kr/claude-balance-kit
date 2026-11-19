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

module.exports = { htmlToText };
