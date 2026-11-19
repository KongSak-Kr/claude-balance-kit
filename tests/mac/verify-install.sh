#!/bin/bash
# 맥 전용 : install.sh 실행 뒤 파일 위치 · 권한 · 등록 상태를 확인한다.
#   /bin/bash tests/mac/verify-install.sh [skip-opencode]
set -uo pipefail

KIT="$HOME/ClaudeBalanceKit"
PLIST="$HOME/Library/LaunchAgents/com.claudebalancekit.opencode.plist"
PASS=0
FAIL=0
check() {
  if eval "$2"; then PASS=$((PASS + 1)); echo "  통과 · $1"; else FAIL=$((FAIL + 1)); echo "  실패 · $1"; fi
}
perm() { stat -f '%Lp' "$1"; }

check "확장 manifest" "[ -f '$KIT/extension/manifest.json' ]"
check "확장 manifest JSON 문법" "plutil -convert json -o /dev/null '$KIT/extension/manifest.json' 2>/dev/null || node -e 'JSON.parse(require(\"fs\").readFileSync(\"$KIT/extension/manifest.json\"))'"
check "kit-config.js 에 저장소 기록" "grep -q \"repo: '\" '$KIT/extension/kit-config.js' && ! grep -q \"repo: 'YOUR_\" '$KIT/extension/kit-config.js'"
check "설치 기록 파일" "[ -f '$KIT/.installed' ]"
check "삭제 스크립트" "[ -x '$KIT/uninstall.sh' ]"
check "설치안내서 사본" "[ -f '$KIT/manual/설치안내서.md' ]"
check "임시 폴더 남지 않음" "[ ! -e '$KIT/.extension.new' ] && [ ! -e '$KIT/.extension.old' ]"
check "임시 작업 폴더 정리" "! ls -d \"\${TMPDIR:-/tmp}\"/cbk.* >/dev/null 2>&1"

if [ "${1:-}" != "skip-opencode" ]; then
  OC="$HOME/.opencode/bin/opencode"
  check "OpenCode 실행 파일" "[ -x '$OC' ]"
  check "OpenCode 에 키 등록(claude-balance-kit)" "'$OC' auth list --format json </dev/null 2>/dev/null | grep -q claude-balance-kit"
  check "자동 실행 plist" "[ -f '$PLIST' ] && plutil -lint '$PLIST' >/dev/null"
  check "plist 권한 644" "[ \"\$(perm '$PLIST')\" = 644 ]"
  check "바탕화면 앱" "[ -d \"$HOME/Desktop/OpenCode 열기.app\" ] || [ -f \"$HOME/Desktop/OpenCode 열기.command\" ]"
  check "바로가기 도우미 문법" "/bin/bash -n '$KIT/bin/open-opencode.sh'"
  AJ="$HOME/.local/share/opencode/auth.json"
  if [ -f "$AJ" ]; then check "auth.json 권한 600" "[ \"\$(perm '$AJ')\" = 600 ]"; fi
  launchctl print "gui/$(id -u)/com.claudebalancekit.opencode" >/dev/null 2>&1 && echo "  (참고) launchd 에 등록됨" || echo "  (참고) launchd 등록 확인 불가 — CI 환경 차이일 수 있음"
fi

echo "설치 결과 확인 : 통과 $PASS · 실패 $FAIL"
[ "$FAIL" -eq 0 ]
