#!/bin/bash
# 맥이 아닌 곳(리눅스·윈도우 Git Bash)에서 install.sh / uninstall.sh 흐름을 모의 실행하는 개발용 테스트.
# 맥 전용 명령(osascript, launchctl, open …)과 OpenCode 는 tests/sim/stubs 의 가짜로 바꿔 끼운다.
# 진짜 맥 검사는 GitHub Actions(macos-latest)에서 한다.
#   사용 : bash tests/sim/run-sim.sh
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
STUBS="$ROOT/tests/sim/stubs"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT
PASS=0
FAIL=0

KEY="simkey_$(od -An -tx1 -N12 /dev/urandom | tr -d ' \n')" # 실제 키가 아닌 시험용 문자열

check() {
  local desc="$1"
  shift
  if "$@"; then
    PASS=$((PASS + 1))
    printf '  통과 · %s\n' "$desc"
  else
    FAIL=$((FAIL + 1))
    printf '  실패 · %s\n' "$desc"
  fi
}

new_home() {
  H="$WORK/home-$1"
  mkdir -p "$H/Desktop" "$H/bin"
  for f in sw_vers open pbcopy launchctl plutil osacompile sysctl osascript; do ln -sf "$STUBS/$f" "$H/bin/$f"; done
  export CBK_SIM_LOG="$H/sim.log"
  : >"$CBK_SIM_LOG"
}

run_install() {
  HOME="$H" PATH="$H/bin:$H/.opencode/bin:$PATH" CBK_ALLOW_NON_MAC=1 CBK_NONINTERACTIVE=1 \
    CBK_API_KEY="$KEY" CBK_SKIP_VALIDATE=1 CBK_LOCAL_SOURCE="$ROOT" CBK_REPO="tester/claude-balance-kit" \
    bash "$ROOT/install.sh" >"$H/out.txt" 2>&1
}

run_uninstall() {
  HOME="$H" PATH="$H/bin:$H/.opencode/bin:$PATH" CBK_ALLOW_NON_MAC=1 CBK_NONINTERACTIVE=1 \
    bash "$ROOT/uninstall.sh" >"$H/out-uninstall.txt" 2>&1
}

no_key_in_output() { ! grep -q "$KEY" "$H/out.txt" && ! grep -q "$KEY" "$CBK_SIM_LOG"; }
perm_of() { stat -c '%a' "$1" 2>/dev/null || stat -f '%Lp' "$1"; }

echo "▶ A. OpenCode 없이(CBK_SKIP_OPENCODE=1) 새로 설치"
new_home a
CBK_SKIP_OPENCODE=1 run_install || { cat "$H/out.txt"; exit 1; }
check "확장 manifest 복사됨" test -f "$H/ClaudeBalanceKit/extension/manifest.json"
check "kit-config.js 에 저장소 이름 기록" grep -q "tester/claude-balance-kit" "$H/ClaudeBalanceKit/extension/kit-config.js"
check "설치 기록 파일" grep -q "opencode_mode=skip" "$H/ClaudeBalanceKit/.installed"
check "uninstall.sh 함께 복사" test -x "$H/ClaudeBalanceKit/uninstall.sh"
check "설치안내서 함께 복사" test -f "$H/ClaudeBalanceKit/manual/설치안내서.md"
check "자동 실행은 만들지 않음" test ! -f "$H/Library/LaunchAgents/com.claudebalancekit.opencode.plist"
check "출력에 키 없음" no_key_in_output
check "요약 출력" grep -q "설치 요약" "$H/out.txt"

echo "▶ B. OpenCode 2.x 가 있는 맥에 새로 설치"
new_home b
mkdir -p "$H/.opencode/bin" && cp "$STUBS/opencode-v2" "$H/.opencode/bin/opencode"
run_install || { cat "$H/out.txt"; exit 1; }
check "OpenCode 2.x 로 인식" grep -q "opencode_mode=v2" "$H/ClaudeBalanceKit/.installed"
check "키가 표준입력으로 OpenCode 에 등록됨" grep -q "$KEY" "$H/.fake-opencode-creds.json"
check "등록된 키 이름 claude-balance-kit" grep -q '"label":"claude-balance-kit"' "$H/.fake-opencode-creds.json"
check "auth.json 은 만들지 않음(2.x)" test ! -f "$H/.local/share/opencode/auth.json"
check "LaunchAgent 는 service start" grep -q "<string>service</string>" "$H/Library/LaunchAgents/com.claudebalancekit.opencode.plist"
check "launchctl bootstrap 호출" grep -q "launchctl bootstrap" "$CBK_SIM_LOG"
check "바탕화면 앱 생성" test -f "$H/Desktop/OpenCode 열기.app/Contents/script.txt"
check "바로가기 도우미는 pair 링크 사용" grep -q "pair" "$H/ClaudeBalanceKit/bin/open-opencode.sh"
check "도우미 문법" bash -n "$H/ClaudeBalanceKit/bin/open-opencode.sh"
check "출력에 키 없음" no_key_in_output

echo "▶ C. 같은 컴퓨터에서 다시 실행(업데이트 모드, 키 유지)"
echo "stale" >"$H/ClaudeBalanceKit/extension/old-file.txt"
before="$(cat "$H/.fake-opencode-creds.json")"
CBK_UPDATE_KEY=n run_install || { cat "$H/out.txt"; exit 1; }
check "업데이트 모드 안내" grep -q "업데이트 모드" "$H/out.txt"
check "확장 폴더 내용 교체(예전 파일 사라짐)" test ! -e "$H/ClaudeBalanceKit/extension/old-file.txt"
check "확장 폴더 경로 그대로" test -f "$H/ClaudeBalanceKit/extension/manifest.json"
check "키는 그대로" test "$before" = "$(cat "$H/.fake-opencode-creds.json")"
check "새로고침(↻) 안내" grep -q "새로고침" "$H/out.txt"
check "임시 폴더 남지 않음" test ! -e "$H/ClaudeBalanceKit/.extension.new" -a ! -e "$H/ClaudeBalanceKit/.extension.old"

echo "▶ D. 다시 실행하면서 키 바꾸기"
KEY="simkey_$(od -An -tx1 -N12 /dev/urandom | tr -d ' \n')"
CBK_UPDATE_KEY=y run_install || { cat "$H/out.txt"; exit 1; }
check "새 키로 바뀜" grep -q "$KEY" "$H/.fake-opencode-creds.json"
check "출력에 키 없음" no_key_in_output

echo "▶ E. OpenCode 1.x 가 있는 맥(auth.json 병합)"
new_home e
mkdir -p "$H/.opencode/bin" "$H/.local/share/opencode"
cp "$STUBS/opencode-v1" "$H/.opencode/bin/opencode"
printf '{\n  "openai": { "type": "api", "key": "other-provider-key" }\n}\n' >"$H/.local/share/opencode/auth.json"
run_install || { cat "$H/out.txt"; exit 1; }
AJ="$H/.local/share/opencode/auth.json"
check "anthropic 항목 저장" node -e 'const j=require(process.argv[1]); if(j.anthropic.type!=="api"||j.anthropic.key!==process.argv[2]) process.exit(1)' "$AJ" "$KEY"
check "다른 공급자 키 보존" node -e 'const j=require(process.argv[1]); if(j.openai.key!=="other-provider-key") process.exit(1)' "$AJ"
check "백업 파일 생성" sh -c "ls '$H/.local/share/opencode/' | grep -q 'auth.json.bak-'"
check "auth.json 권한 600" test "$(perm_of "$AJ")" = "600"
check "LaunchAgent 는 web --port 4096" grep -q "<string>4096</string>" "$H/Library/LaunchAgents/com.claudebalancekit.opencode.plist"
check "출력에 키 없음" no_key_in_output

echo "▶ F. 삭제(uninstall.sh) — 키·OpenCode 는 기본값(남김)"
run_uninstall || { cat "$H/out-uninstall.txt"; exit 1; }
check "확장 폴더 삭제" test ! -e "$H/ClaudeBalanceKit"
check "LaunchAgent 삭제" test ! -e "$H/Library/LaunchAgents/com.claudebalancekit.opencode.plist"
check "바탕화면 바로가기 삭제" test ! -e "$H/Desktop/OpenCode 열기.app"
check "키는 남김(기본값)" grep -q anthropic "$AJ"

echo "▶ G. 삭제 — 키도 지우기(1.x auth.json)"
new_home g
mkdir -p "$H/.opencode/bin" "$H/.local/share/opencode"
cp "$STUBS/opencode-v1" "$H/.opencode/bin/opencode"
printf '{ "openai": { "type": "api", "key": "keep" } }\n' >"$H/.local/share/opencode/auth.json"
run_install || { cat "$H/out.txt"; exit 1; }
CBK_REMOVE_KEY=y run_uninstall || { cat "$H/out-uninstall.txt"; exit 1; }
AJ="$H/.local/share/opencode/auth.json"
check "anthropic 항목만 삭제" node -e 'const j=require(process.argv[1]); if("anthropic" in j || j.openai.key!=="keep") process.exit(1)' "$AJ"

echo "▶ H. 삭제 — 키 지우기(2.x)"
new_home h
mkdir -p "$H/.opencode/bin" && cp "$STUBS/opencode-v2" "$H/.opencode/bin/opencode"
run_install || { cat "$H/out.txt"; exit 1; }
CBK_REMOVE_KEY=y run_uninstall || { cat "$H/out-uninstall.txt"; exit 1; }
check "OpenCode 에서 키 이름으로 로그아웃" test ! -f "$H/.fake-opencode-creds.json"

echo "▶ I. 저장소 압축 파일(tar.gz, 한글 파일 이름 포함)을 내려받아 설치 — curl | bash 처럼 표준입력이 스크립트"
new_home i
git -C "$ROOT" archive --format=tar.gz --prefix=claude-balance-kit-main/ HEAD >"$WORK/kit.tar.gz"
# shellcheck disable=SC2002  # curl | bash 처럼 파이프로 넘기려는 것
cat "$ROOT/install.sh" | HOME="$H" PATH="$H/bin:$PATH" CBK_ALLOW_NON_MAC=1 CBK_NONINTERACTIVE=1 \
  CBK_API_KEY="$KEY" CBK_SKIP_VALIDATE=1 CBK_SKIP_OPENCODE=1 CBK_REPO="tester/claude-balance-kit" \
  CBK_ARCHIVE_URL="file://$WORK/kit.tar.gz" bash >"$H/out.txt" 2>&1 || { cat "$H/out.txt"; exit 1; }
check "내려받은 확장 manifest" test -f "$H/ClaudeBalanceKit/extension/manifest.json"
check "한글 이름 설치안내서 그대로" test -f "$H/ClaudeBalanceKit/manual/설치안내서.md"
check "요약까지 끝까지 실행(표준입력을 먹지 않음)" grep -q "설치 요약" "$H/out.txt"

echo
printf '모의 실행 결과 : 통과 %d · 실패 %d\n' "$PASS" "$FAIL"
[ "$FAIL" -eq 0 ]
