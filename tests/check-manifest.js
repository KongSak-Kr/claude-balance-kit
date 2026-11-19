/*
 * manifest.json 검사 : 문법, 필수 항목, 권한이 최소한인지, 가리키는 파일이 실제로 있는지.
 *   node tests/check-manifest.js
 */
'use strict';

const fs = require('node:fs');
const path = require('node:path');

const EXT = path.join(__dirname, '..', 'extension');
const problems = [];
const fail = (msg) => problems.push(msg);

let m;
try {
  m = JSON.parse(fs.readFileSync(path.join(EXT, 'manifest.json'), 'utf8'));
} catch (e) {
  console.error('manifest.json 문법 오류 :', e.message);
  process.exit(1);
}

if (m.manifest_version !== 3) fail('manifest_version 은 3 이어야 함');
for (const k of ['name', 'version', 'description', 'background', 'action', 'options_ui', 'icons']) {
  if (!m[k]) fail('필수 항목 없음 : ' + k);
}
if (!/^\d+(\.\d+){0,3}$/.test(m.version || '')) fail('version 형식 오류 : ' + m.version);

const wantPerms = ['alarms', 'notifications', 'storage', 'tabs'];
const perms = (m.permissions || []).slice().sort();
if (JSON.stringify(perms) !== JSON.stringify(wantPerms)) fail('권한은 ' + wantPerms.join(', ') + ' 만 허용 — 지금 : ' + perms.join(', '));

const wantHosts = ['https://api.anthropic.com/*', 'https://platform.claude.com/*'];
const hosts = (m.host_permissions || []).slice().sort();
if (JSON.stringify(hosts) !== JSON.stringify(wantHosts)) fail('호스트 권한은 두 주소만 허용 — 지금 : ' + hosts.join(', '));
if (m.optional_permissions || m.optional_host_permissions) fail('선택 권한은 쓰지 않음');
if (m.externally_connectable) fail('externally_connectable 은 쓰지 않음');

const files = new Set();
if (m.background && m.background.service_worker) files.add(m.background.service_worker);
if (m.action && m.action.default_popup) files.add(m.action.default_popup);
if (m.options_ui && m.options_ui.page) files.add(m.options_ui.page);
for (const v of Object.values(m.icons || {})) files.add(v);
for (const v of Object.values((m.action && m.action.default_icon) || {})) files.add(v);
for (const cs of m.content_scripts || []) {
  for (const f of cs.js || []) files.add(f);
  for (const u of cs.matches || []) if (!u.startsWith('https://platform.claude.com/')) fail('콘텐츠 스크립트 주소 범위 초과 : ' + u);
}

// HTML 이 불러오는 스크립트·스타일, 서비스 워커의 importScripts 도 확인
for (const html of ['popup.html', 'options.html']) {
  const s = fs.readFileSync(path.join(EXT, html), 'utf8');
  for (const mm of s.matchAll(/<(?:script|link)[^>]+(?:src|href)="([^"]+)"/g)) {
    if (/^https?:/.test(mm[1])) fail(html + ' 에서 외부 파일을 불러옴 : ' + mm[1]);
    else files.add(mm[1]);
  }
}
const bg = fs.readFileSync(path.join(EXT, m.background.service_worker), 'utf8');
for (const mm of bg.matchAll(/importScripts\(([^)]*)\)/g)) {
  for (const f of mm[1].match(/'[^']+'/g) || []) files.add(f.slice(1, -1));
}

for (const f of files) {
  if (!fs.existsSync(path.join(EXT, f))) fail('파일 없음 : extension/' + f);
}

// 외부 주소 사용 점검 : 확장 코드에 허용된 두 주소 외 다른 http(s) 주소로 요청하는 코드가 없는지
const allowed = /^https:\/\/(api\.anthropic\.com|platform\.claude\.com|github\.com)\b/;
for (const f of fs.readdirSync(EXT, { recursive: true })) {
  if (!/\.(js|html)$/.test(f)) continue;
  const s = fs.readFileSync(path.join(EXT, f), 'utf8');
  for (const mm of s.matchAll(/https?:\/\/[^\s'"`)<]+/g)) {
    if (!allowed.test(mm[0])) fail('허용되지 않은 주소 : ' + f + ' → ' + mm[0]);
  }
  if (/\beval\(|new Function\(/.test(s)) fail('eval/new Function 사용 : ' + f);
}

if (problems.length) {
  console.error('manifest 검사 실패 :\n- ' + problems.join('\n- '));
  process.exit(1);
}
console.log('manifest 검사 통과 (파일 ' + files.size + '개 확인)');
