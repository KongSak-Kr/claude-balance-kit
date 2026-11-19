#!/bin/bash
# ────────────────────────────────────────────────────────────────────
#  Claude 잔액 키트 — 맥 한 줄 설치
#
#  터미널에 아래 한 줄을 붙여 넣고 엔터 :
#    curl -fsSL https://raw.githubusercontent.com/KongSak-Kr/claude-balance-kit/main/install.sh | bash
#
#  하는 일
#   1. 맥·칩 확인
#   2. Anthropic API 키 입력 → 유효성 확인
#   3. OpenCode 설치(이미 있으면 건너뜀)
#   4. OpenCode 에 키 등록(다른 공급자 키는 그대로 둠)
#   5. (선택) 로그인 시 OpenCode 자동 실행 + 바탕화면 "OpenCode 열기"
#   6. 크롬 확장 파일 내려받기 → ~/ClaudeBalanceKit/extension
#
#  다시 실행하면 "업데이트 모드"로 동작합니다.
#  키는 화면·로그·셸 기록·명령줄 인자 어디에도 남기지 않습니다(set -x 금지).
#
#  자동 검사(CI)용 환경 변수 — 일반 사용자는 쓸 일 없음
#   CBK_NONINTERACTIVE=1  질문 없이 진행     CBK_API_KEY=…   키(비대화 모드)
#   CBK_SKIP_VALIDATE=1   키 확인 요청 생략   CBK_SKIP_OPENCODE=1  OpenCode 설치·등록 생략
#   CBK_AUTOSTART=y|n     자동 실행 여부      CBK_UPDATE_KEY=y|n   업데이트 모드에서 키 재입력
#   CBK_LOCAL_SOURCE=경로 확장 파일을 내려받지 않고 이 폴더에서 복사
#   CBK_NO_OPEN=1         Finder·크롬 창 열지 않음
# ────────────────────────────────────────────────────────────────────
set -euo pipefail

CBK_REPO="${CBK_REPO:-KongSak-Kr/claude-balance-kit}"
CBK_BRANCH="${CBK_BRANCH:-main}"
KIT_DIR="${CBK_KIT_DIR:-$HOME/ClaudeBalanceKit}"
EXT_DIR="$KIT_DIR/extension"
MARKER="$KIT_DIR/.installed"
LA_LABEL="com.claudebalancekit.opencode"
LA_PLIST="$HOME/Library/LaunchAgents/$LA_LABEL.plist"
DESKTOP_DIR="${CBK_DESKTOP_DIR:-$HOME/Desktop}"
SHORTCUT_NAME="OpenCode 열기"
OC_INSTALL_URL="${CBK_OPENCODE_INSTALL_URL:-https://opencode.ai/v2/install}"
OC_CRED_ID="cred_claude_balance_kit"
OC_CRED_LABEL="claude-balance-kit"
ANTHROPIC_VERSION="2026-10-21"
MANUAL_FILE_ENC="%EC%84%A4%EC%B9%98%EC%95%88%EB%82%B4%EC%84%9C.md"
ANCHOR_EXT_ENC="5-%ED%81%AC%EB%A1%AC-%ED%99%95%EC%9E%A5-%EB%93%B1%EB%A1%9D"
V1_WEB_PORT=4096
TOTAL=6

NONINTERACTIVE="${CBK_NONINTERACTIVE:-0}"
NO_OPEN="${CBK_NO_OPEN:-$NONINTERACTIVE}"

TMP_DIR=""
API_KEY=""
OC_BIN=""
OC_MODE="" # v2 | v1 | skip
UPDATE_MODE=0
KEY_CHANGED=0
AUTOSTART_DONE="n"
SUMMARY_DONE=""
SUMMARY_TODO=""

# ── 출력 도우미 ──────────────────────────────────────────────────────
if [ -t 1 ]; then
  B=$'\033[1m'; D=$'\033[2m'; R=$'\033[31m'; G=$'\033[32m'; Y=$'\033[33m'; N=$'\033[0m'
else
  B=""; D=""; R=""; G=""; Y=""; N=""
fi

step() { printf '\n%s[%s/%s] %s%s\n' "$B" "$1" "$TOTAL" "$2" "$N"; }
info() { printf '  %s\n' "$*"; }
ok() { printf '  %s✓%s %s\n' "$G" "$N" "$*"; }
warn() { printf '  %s!%s %s\n' "$Y" "$N" "$*"; }
err() { printf '  %s✗ %s%s\n' "$R" "$*" "$N" >&2; }
die() {
  err "$*"
  printf '\n  설치를 멈췄습니다. 문제를 해결한 뒤 같은 한 줄을 다시 실행해 주세요.\n' >&2
  exit 1
}
add_done() { SUMMARY_DONE="${SUMMARY_DONE}  ✓ $*"$'\n'; }
add_todo() { SUMMARY_TODO="${SUMMARY_TODO}  □ $*"$'\n'; }

cleanup() {
  API_KEY=""
  if [ -n "$TMP_DIR" ] && [ -d "$TMP_DIR" ]; then rm -rf "$TMP_DIR"; fi
}
trap cleanup EXIT
trap 'printf "\n  중단했습니다.\n" >&2; exit 130' INT TERM

# ── 입력 도우미 (curl | bash 로 실행되면 표준입력이 스크립트이므로 /dev/tty 에서 받는다) ──
have_tty() { (exec </dev/tty) 2>/dev/null; }

lower_trim() { printf '%s' "$1" | tr '[:upper:]' '[:lower:]' | tr -d '[:space:]'; }

# ask_yn "질문" 기본값(y|n) [비대화 모드 답]
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

# 키 입력 : 화면에 보이지 않게(read -s). 결과는 전역 API_KEY 에만 둔다.
read_secret() {
  local k=""
  printf '  %s' "$1" >/dev/tty
  IFS= read -rs k </dev/tty || k=""
  printf '\n' >/dev/tty
  # 붙여 넣을 때 섞인 공백·줄바꿈 제거
  API_KEY="$(printf '%s' "$k" | tr -d '[:space:]')"
  k=""
}

# 시간 제한 실행 (맥에는 timeout 명령이 없다). 표준입력은 그대로 넘긴다.
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

open_quiet() {
  [ "$NO_OPEN" = "1" ] && return 1
  open "$@" >/dev/null 2>&1
}

chrome_installed() {
  [ -d "/Applications/Google Chrome.app" ] && return 0
  [ -d "$HOME/Applications/Google Chrome.app" ] && return 0
  command -v mdfind >/dev/null 2>&1 && [ -n "$(mdfind "kMDItemCFBundleIdentifier == 'com.google.Chrome'" 2>/dev/null | head -n 1)" ]
}

# ── JSON 처리 : 맥 기본 도구(osascript JavaScript)만 사용 ───────────────
# 사용 : printf '%s' "$KEY" | json_auth_edit set 파일    → anthropic 항목만 넣기/바꾸기
#        json_auth_edit remove 파일 </dev/null             → anthropic 항목만 지우기
#        json_auth_edit has 파일 </dev/null                → yes / no 출력
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

json_auth_edit() {
  local mode="$1" file="$2"
  (
    umask 077
    osascript -l JavaScript -e "$JXA_AUTH_EDIT" "$mode" "$file"
  )
}

# ── 1. 컴퓨터 확인 ──────────────────────────────────────────────────
check_machine() {
  step 1 "컴퓨터 확인"
  local os chip ver
  os="$(uname -s)"
  if [ "$os" != "Darwin" ] && [ "${CBK_ALLOW_NON_MAC:-0}" != "1" ]; then
    err "이 설치 프로그램은 맥(macOS) 전용입니다. 지금 컴퓨터 : $os"
    exit 1
  fi
  chip="$(uname -m)"
  if [ "$chip" = "arm64" ]; then
    chip="Apple Silicon (M 시리즈)"
  elif [ "$(sysctl -in sysctl.proc_translated 2>/dev/null || echo 0)" = "1" ]; then
    chip="Apple Silicon (Rosetta 로 실행 중)"
  else
    chip="Intel"
  fi
  ver="$(sw_vers -productVersion 2>/dev/null || echo '?')"
  ok "macOS $ver · $chip"

  if [ "$NONINTERACTIVE" != "1" ] && ! have_tty; then
    die "질문에 답할 터미널을 찾지 못했습니다. 터미널 앱에서 직접 실행해 주세요."
  fi
  command -v curl >/dev/null 2>&1 || die "curl 명령이 없습니다."
  command -v unzip >/dev/null 2>&1 || die "unzip 명령이 없습니다."

  TMP_DIR="$(mktemp -d "${TMPDIR:-/tmp}/cbk.XXXXXX")"
  chmod 700 "$TMP_DIR"

  if [ -f "$MARKER" ] || [ -d "$EXT_DIR" ]; then
    UPDATE_MODE=1
    ok "이미 설치되어 있어 업데이트 모드로 진행합니다."
  fi
}

# ── 2. API 키 ──────────────────────────────────────────────────────
# 결과 : ok | invalid | workspace | billing | network | server | unknown
validate_api_key() {
  local body code msg
  body="$TMP_DIR/models.json"
  # 키를 명령줄 인자로 넘기지 않도록 curl 설정을 표준입력(-K -)으로 전달
  code="$(printf 'header = "x-api-key: %s"\n' "$API_KEY" |
    curl -sS -K - -o "$body" -w '%{http_code}' --max-time 20 \
      -H "anthropic-version: $ANTHROPIC_VERSION" \
      https://api.anthropic.com/v1/models 2>/dev/null)" || code="000"
  msg="$(tr -d '\n' <"$body" 2>/dev/null | head -c 2000 || true)"
  rm -f "$body"
  case "$code" in
    200) echo ok ;;
    401 | 403) echo invalid ;;
    402) echo billing ;;
    400)
      if printf '%s' "$msg" | grep -qi 'credit balance'; then
        echo billing
      elif printf '%s' "$msg" | grep -qi 'not scoped to a workspace'; then
        echo workspace
      else
        echo unknown
      fi
      ;;
    000) echo network ;;
    429 | 5??) echo server ;;
    *) echo unknown ;;
  esac
}

ask_api_key() {
  step 2 "Anthropic API 키"
  if [ "$UPDATE_MODE" = "1" ]; then
    if ! ask_yn "API 키를 새로 입력할까요? (기존 키를 그대로 쓰려면 엔터)" n "${CBK_UPDATE_KEY:-n}"; then
      ok "기존 키를 그대로 둡니다."
      return 0
    fi
  fi

  local attempt=0 result
  while [ "$attempt" -lt 3 ]; do
    attempt=$((attempt + 1))
    if [ "$NONINTERACTIVE" = "1" ]; then
      API_KEY="$(printf '%s' "${CBK_API_KEY:-}" | tr -d '[:space:]')"
      [ -n "$API_KEY" ] || die "비대화 모드에는 CBK_API_KEY 가 필요합니다."
    else
      info "platform.claude.com 에서 복사한 API 키를 붙여 넣고 엔터를 누르세요."
      info "${D}(입력해도 화면에 아무것도 안 보이는 게 정상입니다)${N}"
      read_secret "API 키 : "
    fi

    if [ -z "$API_KEY" ]; then
      warn "입력된 키가 없습니다."
      continue
    fi
    case "$API_KEY" in
      sk-ant-admin*)
        warn "관리자 키(sk-ant-admin…)는 크롬 확장 설정에 넣는 키입니다. 여기에는 API 키(sk-ant-api…)를 넣어 주세요."
        API_KEY=""
        if [ "$NONINTERACTIVE" = "1" ]; then die "API 키 형식이 아닙니다."; fi
        continue
        ;;
      sk-ant-api*) : ;;
      *)
        if [ "${CBK_SKIP_VALIDATE:-0}" != "1" ]; then
          warn "API 키는 sk-ant-api 로 시작합니다. 복사가 덜 되었는지 확인해 주세요."
          API_KEY=""
          if [ "$NONINTERACTIVE" = "1" ]; then die "API 키 형식이 아닙니다."; fi
          continue
        fi
        ;;
    esac
    case "$API_KEY" in
      *[!A-Za-z0-9_-]*)
        warn "키에 쓸 수 없는 글자가 섞여 있습니다. 다시 복사해 주세요."
        API_KEY=""
        if [ "$NONINTERACTIVE" = "1" ]; then die "키 형식 오류"; fi
        continue
        ;;
    esac

    if [ "${CBK_SKIP_VALIDATE:-0}" = "1" ]; then
      warn "키 확인을 건너뜁니다(CBK_SKIP_VALIDATE=1)."
      KEY_CHANGED=1
      return 0
    fi

    info "키 확인 중…"
    result="$(validate_api_key)"
    case "$result" in
      ok)
        ok "키가 확인되었습니다."
        KEY_CHANGED=1
        return 0
        ;;
      billing)
        warn "키는 맞지만 잔액이 없거나 결제 정보에 문제가 있습니다(콘솔 결제 페이지 확인 필요)."
        if ask_yn "그래도 이 키로 계속할까요?" y y; then
          KEY_CHANGED=1
          add_todo "콘솔 결제 페이지(platform.claude.com/settings/billing)에서 크레딧 충전 확인"
          return 0
        fi
        ;;
      invalid)
        warn "키 오류 — 키가 틀렸거나, 삭제·만료된 키입니다. 콘솔에서 새로 만들어 다시 붙여 넣어 주세요."
        ;;
      workspace)
        warn "작업 공간(Workspace)이 정해지지 않은 키입니다. 콘솔에서 키를 만들 때 Workspace 를 하나(예 : Default) 골라 다시 만든 뒤 붙여 넣어 주세요."
        ;;
      network)
        warn "인터넷 문제 — Anthropic 서버에 연결하지 못했습니다. 와이파이를 확인해 주세요."
        ;;
      server)
        warn "Anthropic 서버가 잠시 응답하지 않습니다."
        if ask_yn "키 확인 없이 계속할까요?" n n; then
          KEY_CHANGED=1
          return 0
        fi
        ;;
      *)
        warn "알 수 없는 이유로 키를 확인하지 못했습니다."
        ;;
    esac
    API_KEY=""
    if [ "$NONINTERACTIVE" = "1" ]; then die "키 확인 실패"; fi
    if [ "$attempt" -lt 3 ]; then info "다시 시도합니다 ($attempt/3)."; fi
  done
  die "키 확인에 3번 실패했습니다. 키와 인터넷 연결을 확인한 뒤 다시 실행해 주세요."
}

# ── 3. OpenCode 설치 ───────────────────────────────────────────────
find_opencode() {
  if [ -x "$HOME/.opencode/bin/opencode" ]; then
    OC_BIN="$HOME/.opencode/bin/opencode"
  elif command -v opencode >/dev/null 2>&1; then
    OC_BIN="$(command -v opencode)"
  else
    OC_BIN=""
  fi
}

# 1.x(및 그 이전 0.x)는 키를 auth.json 에, 2.x 는 자체 DB 에 저장한다. 2.x 베타는 0.0.0-beta-… 형식.
detect_oc_mode() {
  local v ver
  v="$(run_limited 30 "$OC_BIN" --version </dev/null 2>/dev/null | head -n 1 || true)"
  ver="$(printf '%s' "$v" | grep -Eo '[0-9]+\.[0-9]+\.[0-9]+[A-Za-z0-9.-]*' | head -n 1 || true)"
  case "$ver" in
    0.0.0-*) OC_MODE="v2" ;;
    0.* | 1.*) OC_MODE="v1" ;;
    *) OC_MODE="v2" ;;
  esac
  if [ "$OC_MODE" = "v1" ]; then
    ok "OpenCode ${ver} — 구버전(1.x). 키는 auth.json 에 저장합니다."
  else
    ok "OpenCode ${ver:-(버전 확인 불가)} — 2.x"
  fi
}

ensure_shell_rc() {
  # OpenCode 설치 프로그램은 셸 설정 파일이 있어야 PATH 를 추가한다. 새 맥에는 ~/.zshrc 가 없을 수 있다.
  case "$(basename "${SHELL:-/bin/zsh}")" in
    zsh) [ -f "${ZDOTDIR:-$HOME}/.zshrc" ] || [ -f "${ZDOTDIR:-$HOME}/.zshenv" ] || touch "${ZDOTDIR:-$HOME}/.zshrc" ;;
    bash) [ -f "$HOME/.bash_profile" ] || [ -f "$HOME/.bashrc" ] || [ -f "$HOME/.profile" ] || touch "$HOME/.bash_profile" ;;
  esac
}

install_opencode() {
  step 3 "OpenCode 설치"
  if [ "${CBK_SKIP_OPENCODE:-0}" = "1" ]; then
    OC_MODE="skip"
    warn "OpenCode 설치를 건너뜁니다(CBK_SKIP_OPENCODE=1)."
    return 0
  fi
  find_opencode
  if [ -n "$OC_BIN" ]; then
    ok "이미 설치되어 있습니다 : $OC_BIN"
    detect_oc_mode
    return 0
  fi

  info "OpenCode 를 공식 설치 프로그램으로 설치합니다(1~2분)…"
  ensure_shell_rc
  local installer="$TMP_DIR/opencode-install.sh"
  curl -fsSL --max-time 60 "$OC_INSTALL_URL" -o "$installer" || die "OpenCode 설치 프로그램을 내려받지 못했습니다(인터넷 확인)."
  bash "$installer" </dev/null || die "OpenCode 설치에 실패했습니다. 위 메시지를 확인해 주세요."
  rm -f "$installer"
  export PATH="$HOME/.opencode/bin:$PATH"
  find_opencode
  [ -n "$OC_BIN" ] || die "OpenCode 를 설치했지만 실행 파일을 찾지 못했습니다."
  ok "설치 완료 : $OC_BIN"
  detect_oc_mode
  info "새로 연 터미널 창부터 opencode 명령을 쓸 수 있습니다(지금 창은 PATH 가 아직 반영되지 않음)."
  add_done "OpenCode 설치 ($OC_BIN)"
}

# ── 4. 키 저장 ─────────────────────────────────────────────────────
oc_data_dir() {
  local d=""
  if [ "$OC_MODE" = "v2" ]; then
    d="$(run_limited 30 "$OC_BIN" debug paths data </dev/null 2>/dev/null | head -n 1 || true)"
  fi
  [ -n "$d" ] && [ -d "$d" ] || d="${XDG_DATA_HOME:-$HOME/.local/share}/opencode"
  printf '%s' "$d"
}

save_key_v1() {
  local dir file stamp
  dir="$(oc_data_dir)"
  file="$dir/auth.json"
  mkdir -p "$dir"
  chmod 700 "$dir" 2>/dev/null || true
  if [ -f "$file" ]; then
    stamp="$(date +%Y%m%d-%H%M%S)"
    cp -p "$file" "$file.bak-$stamp"
    chmod 600 "$file.bak-$stamp"
    ok "기존 auth.json 백업 : $(basename "$file").bak-$stamp"
  fi
  if ! printf '%s' "$API_KEY" | json_auth_edit set "$file" >/dev/null; then
    die "auth.json 을 고치지 못했습니다(파일 형식이 깨졌을 수 있음). 백업 파일을 확인해 주세요."
  fi
  chmod 600 "$file"
  ok "OpenCode(1.x) 키 파일에 anthropic 항목만 저장했습니다(다른 공급자 키는 그대로) : $file"
}

save_key_v2() {
  local list out
  # 이 키트가 예전에 등록한 키가 있으면 먼저 지운다(다른 키는 건드리지 않음)
  run_limited 60 "$OC_BIN" auth logout anthropic "$OC_CRED_ID" </dev/null >/dev/null 2>&1 || true

  # 키는 표준입력으로만 전달(명령줄 인자·파일에 남기지 않음)
  if out="$(printf '[{"id":"%s","integrationID":"anthropic","label":"%s","active":true,"value":{"type":"key","key":"%s"}}]' \
    "$OC_CRED_ID" "$OC_CRED_LABEL" "$API_KEY" | run_limited 120 "$OC_BIN" auth import 2>&1)"; then
    :
  else
    warn "자동 등록에 실패했습니다 : $(printf '%s' "$out" | tail -n 1)"
    return 1
  fi
  run_limited 60 "$OC_BIN" auth switch anthropic "$OC_CRED_ID" </dev/null >/dev/null 2>&1 || true

  list="$(run_limited 60 "$OC_BIN" auth list --format json </dev/null 2>/dev/null || true)"
  if printf '%s' "$list" | grep -q "$OC_CRED_LABEL"; then
    ok "OpenCode 에 Anthropic 키를 등록했습니다(이름 : $OC_CRED_LABEL, 다른 공급자 키는 그대로)."
    return 0
  fi
  warn "등록 결과를 확인하지 못했습니다."
  return 1
}

save_key() {
  step 4 "OpenCode 에 키 저장"
  if [ "$KEY_CHANGED" != "1" ]; then
    ok "키를 바꾸지 않아 건너뜁니다."
    return 0
  fi
  case "$OC_MODE" in
    skip)
      warn "OpenCode 를 건너뛰어 키 저장도 건너뜁니다."
      ;;
    v1)
      save_key_v1
      add_done "OpenCode 에 Anthropic API 키 등록"
      ;;
    v2)
      if save_key_v2; then
        add_done "OpenCode 에 Anthropic API 키 등록"
      elif [ "$NONINTERACTIVE" != "1" ]; then
        info "OpenCode 의 키 입력 화면을 띄웁니다. 같은 API 키를 한 번 더 붙여 넣어 주세요."
        if "$OC_BIN" auth login anthropic --method key </dev/tty >/dev/tty 2>&1; then
          ok "키를 등록했습니다."
          add_done "OpenCode 에 Anthropic API 키 등록"
        else
          warn "키 등록을 마치지 못했습니다."
          add_todo "터미널에서 opencode auth login anthropic --method key 실행 후 API 키 붙여 넣기"
        fi
      else
        die "OpenCode 키 등록 실패"
      fi
      ;;
  esac
  API_KEY=""
}

# ── 5. 자동 실행 · 바로가기 ─────────────────────────────────────────
write_open_helper() {
  local helper="$KIT_DIR/bin/open-opencode.sh"
  mkdir -p "$KIT_DIR/bin"
  {
    printf '#!/bin/bash\n'
    printf '# OpenCode 웹 화면을 크롬으로 엽니다(Claude 잔액 키트가 만든 파일).\n'
    printf 'OC=%q\n' "$OC_BIN"
    if [ "$OC_MODE" = "v1" ]; then
      printf 'URL="http://127.0.0.1:%s"\n' "$V1_WEB_PORT"
    else
      cat <<'EOS'
# opencode pair : 한 번 쓰는 접속 링크(5분 유효)를 만들어 주고 끝난다. 링크로 들어가면 30일간 로그인 유지.
OUT="$("$OC" pair </dev/null 2>/dev/null)"
URL="$(printf '%s\n' "$OUT" | grep -Eo 'https?://(127\.0\.0\.1|localhost)[A-Za-z0-9.:/_~%?#=&+-]*/auth/connect/[A-Za-z0-9._~%-]+' | head -n 1)"
if [ -z "$URL" ]; then
  URL="$("$OC" service status </dev/null 2>/dev/null | grep -Eo 'https?://[A-Za-z0-9.:/_-]+' | head -n 1)"
fi
[ -n "$URL" ] || URL="http://127.0.0.1:49374"
EOS
    fi
    cat <<'EOS'
if [ -d "/Applications/Google Chrome.app" ] || [ -d "$HOME/Applications/Google Chrome.app" ]; then
  open -a "Google Chrome" "$URL"
else
  open "$URL"
fi
EOS
  } >"$helper"
  chmod 755 "$helper"
  printf '%s' "$helper"
}

make_shortcut() {
  local helper="$1" app cmd
  app="$DESKTOP_DIR/$SHORTCUT_NAME.app"
  cmd="$DESKTOP_DIR/$SHORTCUT_NAME.command"
  mkdir -p "$DESKTOP_DIR" 2>/dev/null || true
  rm -rf "$app" "$cmd" 2>/dev/null || true
  if command -v osacompile >/dev/null 2>&1 &&
    osacompile -o "$app" -e "do shell script \"/bin/bash \" & quoted form of \"$helper\"" >/dev/null 2>&1; then
    ok "바탕화면에 '$SHORTCUT_NAME' 앱을 만들었습니다(더블클릭하면 크롬으로 열림)."
    return 0
  fi
  {
    printf '#!/bin/bash\n'
    printf '/bin/bash %q\n' "$helper"
  } >"$cmd" 2>/dev/null && chmod 755 "$cmd" && {
    ok "바탕화면에 '$SHORTCUT_NAME.command' 를 만들었습니다(더블클릭하면 크롬으로 열림)."
    return 0
  }
  warn "바탕화면에 바로가기를 만들지 못했습니다(바탕화면 접근 권한 확인)."
  return 1
}

write_launch_agent() {
  mkdir -p "$HOME/Library/LaunchAgents" "$KIT_DIR/logs"
  {
    cat <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>$LA_LABEL</string>
  <key>ProgramArguments</key>
  <array>
    <string>$OC_BIN</string>
EOF
    if [ "$OC_MODE" = "v1" ]; then
      printf '    <string>web</string>\n    <string>--port</string>\n    <string>%s</string>\n    <string>--hostname</string>\n    <string>127.0.0.1</string>\n' "$V1_WEB_PORT"
    else
      printf '    <string>service</string>\n    <string>start</string>\n'
    fi
    cat <<EOF
  </array>
  <key>RunAtLoad</key>
  <true/>
  <key>AbandonProcessGroup</key>
  <true/>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key>
    <string>$(dirname "$OC_BIN"):/usr/local/bin:/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin</string>
  </dict>
  <key>StandardOutPath</key>
  <string>$KIT_DIR/logs/opencode-autostart.log</string>
  <key>StandardErrorPath</key>
  <string>$KIT_DIR/logs/opencode-autostart.log</string>
</dict>
</plist>
EOF
  } >"$LA_PLIST.tmp"
  mv "$LA_PLIST.tmp" "$LA_PLIST"
  chmod 644 "$LA_PLIST"
  if command -v plutil >/dev/null 2>&1 && ! plutil -lint "$LA_PLIST" >/dev/null 2>&1; then
    warn "자동 실행 설정 파일 검사 실패 : $LA_PLIST"
    return 1
  fi
  local uid
  uid="$(id -u)"
  launchctl bootout "gui/$uid/$LA_LABEL" >/dev/null 2>&1 || launchctl unload "$LA_PLIST" >/dev/null 2>&1 || true
  if launchctl bootstrap "gui/$uid" "$LA_PLIST" >/dev/null 2>&1 || launchctl load -w "$LA_PLIST" >/dev/null 2>&1; then
    ok "로그인할 때 OpenCode 가 자동으로 켜지도록 등록했습니다."
  else
    warn "자동 실행을 등록했지만 지금 바로 켜지는 못했습니다(다음 로그인부터 적용)."
  fi
}

setup_autostart() {
  step 5 "OpenCode 자동 실행 · 바탕화면 바로가기"
  if [ "$OC_MODE" = "skip" ] || [ -z "$OC_BIN" ]; then
    warn "OpenCode 가 없어 건너뜁니다."
    return 0
  fi
  local def="y"
  if [ "$UPDATE_MODE" = "1" ] && [ ! -f "$LA_PLIST" ]; then def="n"; fi
  if ! ask_yn "로그인할 때 OpenCode 를 자동으로 켜고, 바탕화면에 '$SHORTCUT_NAME' 바로가기를 만들까요?" "$def" "${CBK_AUTOSTART:-y}"; then
    ok "건너뜁니다."
    return 0
  fi
  write_launch_agent || true
  local helper
  helper="$(write_open_helper)"
  if make_shortcut "$helper"; then :; fi
  AUTOSTART_DONE="y"
  add_done "로그인 시 OpenCode 자동 실행 + 바탕화면 '$SHORTCUT_NAME'"
}

# ── 6. 크롬 확장 준비 ──────────────────────────────────────────────
fetch_extension() {
  local src_root="" zip new
  if [ -n "${CBK_LOCAL_SOURCE:-}" ]; then
    src_root="$CBK_LOCAL_SOURCE"
    info "확장 파일을 이 폴더에서 복사합니다 : $src_root"
  else
    printf '%s' "$CBK_REPO" | grep -Eq '^[A-Za-z0-9-]+/[A-Za-z0-9._-]+$' || die "저장소 이름 형식 오류 : $CBK_REPO"
    zip="$TMP_DIR/kit.zip"
    info "확장 파일 내려받는 중…"
    curl -fsSL --max-time 120 "https://github.com/$CBK_REPO/archive/refs/heads/$CBK_BRANCH.zip" -o "$zip" ||
      die "확장 파일을 내려받지 못했습니다(인터넷 또는 저장소 주소 확인 : $CBK_REPO)."
    mkdir -p "$TMP_DIR/src"
    unzip -q "$zip" -d "$TMP_DIR/src" || die "내려받은 파일을 풀지 못했습니다."
    rm -f "$zip"
    for d in "$TMP_DIR"/src/*; do
      if [ -f "$d/extension/manifest.json" ]; then src_root="$d"; fi
    done
  fi
  if [ -z "$src_root" ] || [ ! -f "$src_root/extension/manifest.json" ]; then
    die "확장 파일(extension/manifest.json)을 찾지 못했습니다."
  fi

  mkdir -p "$KIT_DIR"
  new="$KIT_DIR/.extension.new"
  rm -rf "$new"
  cp -R "$src_root/extension" "$new"
  printf "// 설치안내서 링크용 저장소 이름 (install.sh 가 씀)\nglobalThis.CBK_KIT = { repo: '%s' };\n" "$CBK_REPO" >"$new/kit-config.js"

  # 경로를 그대로 유지한 채 내용만 바꾼다(경로가 바뀌면 크롬이 다른 확장으로 인식).
  if [ -d "$EXT_DIR" ]; then
    rm -rf "$KIT_DIR/.extension.old"
    mv "$EXT_DIR" "$KIT_DIR/.extension.old"
  fi
  mv "$new" "$EXT_DIR"
  rm -rf "$KIT_DIR/.extension.old"

  # 삭제 스크립트와 설치안내서도 함께 둔다(인터넷 없이 볼 수 있게)
  if [ -f "$src_root/uninstall.sh" ]; then
    cp "$src_root/uninstall.sh" "$KIT_DIR/uninstall.sh"
    chmod 755 "$KIT_DIR/uninstall.sh"
  fi
  if [ -d "$src_root/manual" ]; then
    rm -rf "$KIT_DIR/manual"
    cp -R "$src_root/manual" "$KIT_DIR/manual"
  fi
  cat >"$KIT_DIR/읽어주세요.txt" <<'EOF'
이 폴더(ClaudeBalanceKit)는 크롬 확장 "Claude 잔액 키트"가 쓰는 폴더입니다.

- extension 폴더를 옮기거나 지우면 크롬 확장이 꺼집니다.
- 업데이트 : 터미널에서 설치 한 줄을 다시 실행 → 크롬 확장 화면(chrome://extensions)에서 ↻ 누르기
- 삭제 : 터미널에서  bash ~/ClaudeBalanceKit/uninstall.sh  실행
EOF
}

prepare_extension() {
  step 6 "크롬 확장 준비"
  fetch_extension
  ok "확장 파일 : $EXT_DIR"
  printf '  %s※ 이 폴더를 옮기거나 지우면 크롬 확장이 꺼집니다.%s\n' "$Y" "$N"

  if ! chrome_installed; then
    warn "구글 크롬이 보이지 않습니다. https://www.google.com/chrome 에서 크롬을 설치한 뒤 확장을 등록해 주세요."
  fi

  if [ "$UPDATE_MODE" = "1" ]; then
    add_done "크롬 확장 파일 업데이트 ($EXT_DIR)"
    add_todo "크롬 주소창에 chrome://extensions → 'Claude 잔액 키트' 카드의 새로고침(↻) 누르기"
    if [ "$NO_OPEN" != "1" ]; then
      printf 'chrome://extensions' | pbcopy 2>/dev/null || true
      open_quiet -a "Google Chrome" "chrome://extensions" || true
      info "크롬 확장 화면을 여는 중입니다. 안 열리면 크롬 주소창에 chrome://extensions 를 붙여 넣으세요(복사해 둠)."
    fi
    return 0
  fi

  add_done "크롬 확장 파일 준비 ($EXT_DIR)"
  add_todo "크롬 확장 등록 : chrome://extensions → 개발자 모드 켜기 → '압축해제된 확장 프로그램을 로드합니다' → 홈 폴더 > ClaudeBalanceKit > extension 선택"
  add_todo "퍼즐 아이콘에서 'Claude 잔액 키트' 고정(핀)"
  add_todo "관리자 키(sk-ant-admin…) 받아서 확장 설정 화면에 붙여 넣고 '연결 확인'"
  add_todo "결제 페이지를 한 번 열어 첫 잔액이 읽히는지 확인"

  if [ "$NO_OPEN" != "1" ]; then
    open_quiet "$KIT_DIR" || true
    printf 'chrome://extensions' | pbcopy 2>/dev/null || true
    open_quiet -a "Google Chrome" "chrome://extensions" || true
    case "$CBK_REPO" in
      YOUR_*) : ;; # 아직 실제 아이디로 바꾸지 않은 저장소
      *) open_quiet -a "Google Chrome" "https://github.com/$CBK_REPO/blob/$CBK_BRANCH/manual/$MANUAL_FILE_ENC#$ANCHOR_EXT_ENC" || true ;;
    esac
    info "Finder 에 ClaudeBalanceKit 폴더를 열었습니다."
    info "크롬 확장 화면이 안 열렸다면 크롬 주소창에 chrome://extensions 를 붙여 넣으세요(⌘V, 이미 복사해 둠)."
  fi
}

write_marker() {
  mkdir -p "$KIT_DIR"
  {
    printf 'installed_at=%s\n' "$(date '+%Y-%m-%d %H:%M:%S')"
    printf 'repo=%s\n' "$CBK_REPO"
    printf 'opencode_mode=%s\n' "$OC_MODE"
    printf 'opencode_bin=%s\n' "$OC_BIN"
    printf 'autostart=%s\n' "$AUTOSTART_DONE"
  } >"$MARKER"
}

print_summary() {
  printf '\n%s────────────── 설치 요약 ──────────────%s\n' "$B" "$N"
  printf '%s설치·변경된 것%s\n' "$B" "$N"
  if [ -n "$SUMMARY_DONE" ]; then printf '%s' "$SUMMARY_DONE"; else printf '  (바뀐 것 없음)\n'; fi
  printf '\n%s다음에 할 일%s\n' "$B" "$N"
  if [ -n "$SUMMARY_TODO" ]; then printf '%s' "$SUMMARY_TODO"; else printf '  (없음)\n'; fi
  printf '\n  설치안내서 : %s\n' "$KIT_DIR/manual/설치안내서.md"
  printf '  삭제 : bash %s\n\n' "$KIT_DIR/uninstall.sh"
}

main() {
  printf '%sClaude 잔액 키트 설치%s\n' "$B" "$N"
  check_machine
  ask_api_key
  install_opencode
  save_key
  setup_autostart
  prepare_extension
  write_marker
  print_summary
}

if [ "${CBK_SOURCE_ONLY:-0}" != "1" ]; then
  main "$@"
fi
