#!/usr/bin/env bash
# 저장소 안에 실제 키가 들어갔는지 검사한다.
# - "sk-ant-" 가 나오는 곳을 모두 보여 준다(접두어 확인용 코드·예시 문구는 괜찮음).
# - 접두어 뒤에 긴 문자열이 붙은 "실제 키 모양"이 하나라도 있으면 실패한다.
set -euo pipefail

cd "$(dirname "$0")/.."

echo "· 'sk-ant-' 가 들어간 줄 (예시 문구·접두어 검사 코드)"
grep -rnI --exclude-dir=.git -e 'sk-ant-' . || echo "  (없음)"

echo
echo "· 실제 키 모양 검사"
if grep -rnIE --exclude-dir=.git -e 'sk-ant-[A-Za-z]+[0-9]*-[A-Za-z0-9_-]{20,}' .; then
  echo "실패 : 실제 키처럼 보이는 문자열이 있습니다. 지우고 다시 올리세요." >&2
  exit 1
fi
echo "  통과 : 실제 키 모양 0건"
