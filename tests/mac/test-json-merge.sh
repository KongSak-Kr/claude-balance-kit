#!/bin/bash
# 맥 전용 : install.sh 의 auth.json 병합(osascript JavaScript)을 실제로 시험한다.
#   /bin/bash tests/mac/test-json-merge.sh
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
# shellcheck source=/dev/null
CBK_SOURCE_ONLY=1 source "$ROOT/install.sh"
set +e

T="$(mktemp -d)"
F="$T/auth.json"
PASS=0
FAIL=0
KEYA="test-key-a-$RANDOM$RANDOM"
KEYB="test-key-b-$RANDOM$RANDOM"

check() {
  if eval "$2"; then PASS=$((PASS + 1)); echo "  통과 · $1"; else FAIL=$((FAIL + 1)); echo "  실패 · $1"; fi
}
js() { node -e "const j=JSON.parse(require('fs').readFileSync('$F','utf8')); process.exit(($1)?0:1)"; }
perm() { stat -f '%Lp' "$1"; }

echo "▶ 파일이 없을 때 set"
printf '%s' "$KEYA" | json_auth_edit set "$F" >/dev/null
check "새 파일 생성 · anthropic 만 있음" "js 'Object.keys(j).length===1 && j.anthropic.type===\"api\" && j.anthropic.key===\"$KEYA\"'"
check "새 파일 권한 600" "[ \"\$(perm \"$F\")\" = 600 ]"

echo "▶ 다른 공급자 키가 있을 때 set"
printf '{\n  "openai": {"type":"api","key":"keep-me"},\n  "anthropic": {"type":"api","key":"old"}\n}\n' >"$F"
printf '%s' "$KEYB" | json_auth_edit set "$F" >/dev/null
check "anthropic 만 바뀜" "js 'j.anthropic.key===\"$KEYB\"'"
check "openai 보존" "js 'j.openai.key===\"keep-me\"'"
check "has → yes" "[ \"\$(json_auth_edit has \"$F\" </dev/null)\" = yes ]"

echo "▶ remove"
check "remove → ok" "[ \"\$(json_auth_edit remove \"$F\" </dev/null)\" = ok ]"
check "anthropic 만 삭제" "js '!(\"anthropic\" in j) && j.openai.key===\"keep-me\"'"
check "다시 remove → absent" "[ \"\$(json_auth_edit remove \"$F\" </dev/null)\" = absent ]"
check "has → no" "[ \"\$(json_auth_edit has \"$F\" </dev/null)\" = no ]"

echo "▶ 깨진 JSON 은 고치지 않음"
printf '{ this is not json' >"$F"
# shellcheck disable=SC2034  # 아래 check 의 eval 문자열 안에서 씀
before="$(cat "$F")"
if printf '%s' "$KEYA" | json_auth_edit set "$F" >/dev/null 2>&1; then r=0; else r=1; fi
check "실패로 끝남" "[ $r = 1 ]"
check "원본 그대로" "[ \"\$(cat \"$F\")\" = \"\$before\" ]"

echo "▶ 키가 출력에 나오지 않음"
out="$(printf '%s' "$KEYA" | json_auth_edit set "$T/new.json" 2>&1)"
check "출력은 ok 뿐" "[ \"$out\" = ok ]"

rm -rf "$T"
echo "auth.json 병합 시험 : 통과 $PASS · 실패 $FAIL"
[ "$FAIL" -eq 0 ]
