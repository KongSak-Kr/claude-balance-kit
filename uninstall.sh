#!/bin/bash
# ────────────────────────────────────────────────────────────────────
#  Claude 잔액 키트 — 삭제
#
#  터미널에서 둘 중 하나 :
#    bash ~/ClaudeBalanceKit/uninstall.sh
#    curl -fsSL https://raw.githubusercontent.com/KongSak-Kr/claude-balance-kit/main/uninstall.sh | bash
#
#  지우는 것 : 로그인 시 자동 실행, 바탕화면 "OpenCode 열기", ~/ClaudeBalanceKit 폴더(확장 파일)
#  물어보고 지우는 것 : OpenCode 에 저장된 Anthropic 키, OpenCode 자체
#  크롬에 등록된 확장은 크롬 확장 화면에서 직접 "삭제"를 눌러야 합니다.
#
#  자동 검사(CI)용 : CBK_NONINTERACTIVE=1, CBK_REMOVE_KEY=y|n(기본 n), CBK_REMOVE_OPENCODE=y|n(기본 n)
# ────────────────────────────────────────────────────────────────────
set -euo pipefail

KIT_DIR="${CBK_KIT_DIR:-$HOME/ClaudeBalanceKit}"
MARKER="$KIT_DIR/.installed"
LA_LABEL="com.claudebalancekit.opencode"
LA_PLIST="$HOME/Library/LaunchAgents/$LA_LABEL.plist"
DESKTOP_DIR="${CBK_DESKTOP_DIR:-$HOME/Desktop}"
SHORTCUT_NAME="OpenCode 열기"
OC_CRED_ID="cred_claude_balance_kit"
TOTAL=5
NONINTERACTIVE="${CBK_NONINTERACTIVE:-0}"
NO_OPEN="${CBK_NO_OPEN:-$NONINTERACTIVE}"

OC_BIN=""
OC_MODE=""

if [ -t 1 ]; then
  B=$'\033[1m'; R=$'\033[31m'; G=$'\033[32m'; Y=$'\033[33m'; N=$'\033[0m'
else
  B=""; R=""; G=""; Y=""; N=""
fi
step() { printf '\n%s[%s/%s] %s%s\n' "$B" "$1" "$TOTAL" "$2" "$N"; }
info() { printf '  %s\n' "$*"; }
ok() { printf '  %s✓%s %s\n' "$G" "$N" "$*"; }
warn() { printf '  %s!%s %s\n' "$Y" "$N" "$*"; }
err() { printf '  %s✗ %s%s\n' "$R" "$*" "$N" >&2; }

have_tty() { (exec </dev/tty) 2>/dev/null; }
lower_trim() { printf '%s' "$1" | tr '[:upper:]' '[:lower:]' | tr -d '[:space:]'; }

ask_yn() {
  local q="$1" def="$2" auto="${3:-}" ans hint
  if [ "$NONINTERACTIVE" = "1" ]; then
    ans="${auto:-$def}"
    [ "$(lower_trim "$ans")" = "y" ]
    return
  fi
  if [ "$def" = "y" ]; then hint="[Y/n]"; else hint="[y/N]"; fi
  while :; do
    printf '  %s %s ' "$q" "$hint" >/dev/tty
    IFS= read -r ans </dev/tty || ans=""
    ans="$(lower_trim "$ans")"
    [ -z "$ans" ] && ans="$def"
    case "$ans" in
      y | yes | ㅛ | 예 | 네) return 0 ;;
      n | no | ㅜ | 아니오 | 아니요) return 1 ;;
      *) printf '  y(예) 또는 n(아니오)로 답해 주세요.\n' >/dev/tty ;;
    esac
  done
}

run_limited() {
  local secs="$1" pid watcher rc=0
  shift
  "$@" <&0 &
  pid=$!
  (
    sleep "$secs"
    kill -TERM "$pid" 2>/dev/null
  ) </dev/null >/dev/null 2>&1 &
  watcher=$!
  wait "$pid" || rc=$?
  kill "$watcher" 2>/dev/null || true
  wait "$watcher" 2>/dev/null || true
  return "$rc"
}

# shellcheck disable=SC2016  # JavaScript 코드라 $ 를 셸이 풀면 안 된다
JXA_AUTH_EDIT='
ObjC.import("Foundation");
function run(argv) {
  var mode = argv[0], path = argv[1];
  var fm = $.NSFileManager.defaultManager;
  var data = {};
  if (fm.fileExistsAtPath(path)) {
    var s = $.NSString.stringWithContentsOfFileEncodingError(path, $.NSUTF8StringEncoding, null);
    var txt = (s && !s.isNil()) ? s.js : "";
    if (txt.replace(/\s/g, "") !== "") data = JSON.parse(txt);
    if (typeof data !== "object" || data === null || Array.isArray(data)) throw new Error("auth.json is not a JSON object");
  }
  if (mode === "has") return Object.prototype.hasOwnProperty.call(data, "anthropic") ? "yes" : "no";
  if (mode === "set") {
    var d = $.NSFileHandle.fileHandleWithStandardInput.readDataToEndOfFile;
    var key = $.NSString.alloc.initWithDataEncoding(d, $.NSUTF8StringEncoding).js.replace(/\s/g, "");
    if (!key) throw new Error("empty key");
    data.anthropic = { type: "api", key: key };
  } else if (mode === "remove") {
    if (!Object.prototype.hasOwnProperty.call(data, "anthropic")) return "absent";
    delete data.anthropic;
  } else {
    throw new Error("unknown mode");
  }
  var out = $(JSON.stringify(data, null, 2) + "\n");
  if (!out.writeToFileAtomicallyEncodingError(path, true, $.NSUTF8StringEncoding, null)) throw new Error("write failed");
  return "ok";
}'

marker_value() {
  [ -f "$MARKER" ] || return 0
  grep -E "^$1=" "$MARKER" | head -n 1 | cut -d= -f2- || true
}

find_opencode() {
  OC_BIN="$(marker_value opencode_bin)"
  if [ -z "$OC_BIN" ] || [ ! -x "$OC_BIN" ]; then
    if [ -x "$HOME/.opencode/bin/opencode" ]; then
      OC_BIN="$HOME/.opencode/bin/opencode"
    elif command -v opencode >/dev/null 2>&1; then
      OC_BIN="$(command -v opencode)"
    else
      OC_BIN=""
    fi
  fi
  OC_MODE="$(marker_value opencode_mode)"
  if [ -n "$OC_BIN" ] && { [ -z "$OC_MODE" ] || [ "$OC_MODE" = "skip" ]; }; then
    case "$(run_limited 30 "$OC_BIN" --version </dev/null 2>/dev/null | grep -Eo '[0-9]+\.[0-9]+\.[0-9]+[A-Za-z0-9.-]*' | head -n 1 || true)" in
      0.0.0-*) OC_MODE="v2" ;;
      0.* | 1.*) OC_MODE="v1" ;;
      *) OC_MODE="v2" ;;
    esac
  fi
}

remove_autostart() {
  step 1 "로그인 시 자동 실행 해제"
  if [ -f "$LA_PLIST" ]; then
    launchctl bootout "gui/$(id -u)/$LA_LABEL" >/dev/null 2>&1 || launchctl unload "$LA_PLIST" >/dev/null 2>&1 || true
    rm -f "$LA_PLIST"
    ok "해제했습니다."
  else
    ok "등록된 것이 없습니다."
  fi
}

remove_shortcut() {
  step 2 "바탕화면 바로가기 삭제"
  local removed=0
  if [ -e "$DESKTOP_DIR/$SHORTCUT_NAME.app" ]; then
    rm -rf "$DESKTOP_DIR/$SHORTCUT_NAME.app"
    removed=1
  fi
  if [ -e "$DESKTOP_DIR/$SHORTCUT_NAME.command" ]; then
    rm -f "$DESKTOP_DIR/$SHORTCUT_NAME.command"
    removed=1
  fi
  if [ "$removed" = "1" ]; then ok "'$SHORTCUT_NAME' 를 지웠습니다."; else ok "바로가기가 없습니다."; fi
}

remove_key() {
  step 3 "OpenCode 에 저장된 Anthropic 키"
  if [ -z "$OC_BIN" ]; then
    ok "OpenCode 가 없어 건너뜁니다."
    return 0
  fi
  if ! ask_yn "이 키트가 OpenCode 에 넣은 Anthropic API 키를 지울까요? (다른 공급자 키는 그대로)" n "${CBK_REMOVE_KEY:-n}"; then
    ok "키를 그대로 둡니다."
    return 0
  fi
  if [ "$OC_MODE" = "v2" ]; then
    if run_limited 60 "$OC_BIN" auth logout anthropic "$OC_CRED_ID" </dev/null >/dev/null 2>&1; then
      ok "OpenCode 에서 키(claude-balance-kit)를 지웠습니다."
    else
      warn "지울 키를 찾지 못했습니다. 남은 키는  opencode auth list  로 확인할 수 있습니다."
    fi
    return 0
  fi
  local file="${XDG_DATA_HOME:-$HOME/.local/share}/opencode/auth.json" stamp res
  if [ ! -f "$file" ]; then
    ok "키 파일이 없습니다."
    return 0
  fi
  stamp="$(date +%Y%m%d-%H%M%S)"
  cp -p "$file" "$file.bak-$stamp"
  chmod 600 "$file.bak-$stamp"
  if res="$(umask 077 && osascript -l JavaScript -e "$JXA_AUTH_EDIT" remove "$file" </dev/null)"; then
    chmod 600 "$file"
    if [ "$res" = "absent" ]; then ok "anthropic 항목이 원래 없습니다."; else ok "auth.json 에서 anthropic 항목만 지웠습니다(백업 : auth.json.bak-$stamp)."; fi
  else
    warn "auth.json 을 고치지 못했습니다. 파일은 그대로입니다."
  fi
}

remove_opencode() {
  step 4 "OpenCode 프로그램"
  if [ -z "$OC_BIN" ]; then
    ok "설치되어 있지 않습니다."
    return 0
  fi
  if ! ask_yn "OpenCode 자체도 지울까요? (대화 기록·설정은 OpenCode 가 남겨 둡니다)" n "${CBK_REMOVE_OPENCODE:-n}"; then
    ok "OpenCode 는 그대로 둡니다."
    return 0
  fi
  if [ "$OC_MODE" = "v2" ]; then
    run_limited 120 "$OC_BIN" uninstall --force </dev/null || warn "opencode uninstall 이 오류를 냈습니다."
  fi
  case "$OC_BIN" in
    "$HOME/.opencode/bin/"*)
      rm -f "$OC_BIN"
      ok "OpenCode 실행 파일을 지웠습니다 ($OC_BIN)."
      info "셸 설정 파일(~/.zshrc 등)의 'export PATH=…/.opencode/bin…' 한 줄은 남아 있어도 문제없습니다."
      ;;
    */homebrew/* | /usr/local/*)
      warn "Homebrew 로 설치된 OpenCode 입니다. 터미널에서  brew uninstall opencode  로 지워 주세요."
      ;;
    *)
      warn "OpenCode 위치($OC_BIN)를 확인해 직접 지워 주세요."
      ;;
  esac
}

remove_folder() {
  step 5 "확장 폴더 삭제"
  if [ -d "$KIT_DIR" ]; then
    rm -rf "$KIT_DIR"
    ok "$KIT_DIR 를 지웠습니다."
  else
    ok "폴더가 없습니다."
  fi
  printf '\n%s마지막으로 할 일%s\n' "$B" "$N"
  info "크롬 주소창에 chrome://extensions 를 열고 'Claude 잔액 키트' 카드의 [삭제] 를 눌러 주세요."
  if [ "$NO_OPEN" != "1" ]; then
    printf 'chrome://extensions' | pbcopy 2>/dev/null || true
    open -a "Google Chrome" "chrome://extensions" >/dev/null 2>&1 || true
    info "(주소를 복사해 두었습니다. 크롬 주소창에 ⌘V)"
  fi
  printf '\n'
}

main() {
  printf '%sClaude 잔액 키트 삭제%s\n' "$B" "$N"
  if [ "$(uname -s)" != "Darwin" ] && [ "${CBK_ALLOW_NON_MAC:-0}" != "1" ]; then
    err "맥(macOS) 전용입니다."
    exit 1
  fi
  if [ "$NONINTERACTIVE" != "1" ] && ! have_tty; then
    err "질문에 답할 터미널을 찾지 못했습니다. 터미널 앱에서 직접 실행해 주세요."
    exit 1
  fi
  find_opencode
  remove_autostart
  remove_shortcut
  remove_key
  remove_opencode
  remove_folder
}

main "$@"
