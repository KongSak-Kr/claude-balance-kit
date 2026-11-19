#!/bin/bash
# 저장소 안의 YOUR_GITHUB_ID 를 실제 GitHub 아이디로 바꾼다. (윈도우는 Git Bash 에서 실행)
#   bash tools/set-github-id.sh 내아이디
set -euo pipefail

id="${1:-}"
if ! printf '%s' "$id" | grep -Eq '^[A-Za-z0-9]([A-Za-z0-9-]{0,38})$'; then
  echo "사용법 : bash tools/set-github-id.sh <GitHub 아이디>" >&2
  exit 1
fi

cd "$(dirname "$0")/.."
files="$(grep -rlI --exclude-dir=.git --exclude=set-github-id.sh 'YOUR_GITHUB_ID' . || true)"
if [ -z "$files" ]; then
  echo "바꿀 곳이 없습니다(이미 바꿨을 수 있음)."
  exit 0
fi
printf '%s\n' "$files" | while IFS= read -r f; do
  sed "s/YOUR_GITHUB_ID/$id/g" "$f" >"$f.tmp" && cat "$f.tmp" >"$f" && rm -f "$f.tmp"
  echo "바꿈 : $f"
done
