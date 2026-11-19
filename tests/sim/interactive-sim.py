"""install.sh 대화형(안내 모드) 흐름 모의 실행 (개발용, 리눅스)

`cat install.sh | bash` 를 가상 터미널(pty) 안에서 돌린다. curl | bash 와 같이 표준입력은 스크립트이고,
질문 답과 키는 /dev/tty 로 들어간다. 크롬은 가짜 프로필 파일(Preferences)로 흉내 낸다.

  1) 틀린 키 3번 → 실제 api.anthropic.com 이 401 을 돌려주면 "키 오류"로 안내 → 3번째에 멈춤
  2) 처음 설치 : 안내를 따라 엔터 → 확장 넣기(프로필에 등록 흔적을 만들어 자동 확인) → 핀 고정 확인 → 잔액 확인 안내
  3) 다시 실행(업데이트) : 키 유지 → 새로고침(↻) 안내 → 핀이 이미 있으면 핀 안내 생략
  4) 확장을 못 넣은 경우 : 확인 실패 안내 → s 로 넘어가기

사용 : python3 tests/sim/interactive-sim.py
"""
import hashlib
import json
import os
import pty
import select
import shutil
import sys
import tempfile
import time

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", ".."))
STUBS = os.path.join(ROOT, "tests", "sim", "stubs")
FAKE_KEY = "sk-ant-" + "api03-" + "Z" * 40  # 실제 키 아님 (서버가 401 을 돌려줌)
FAKE_USR_KEY = "sk-ant-" + "usr01-" + "Y" * 40  # 개인 키 모양(가짜)
ENTER = "엔터"


def make_home(tmp, name, with_v2=False):
    home = os.path.join(tmp, name)
    os.makedirs(os.path.join(home, "bin"))
    os.makedirs(os.path.join(home, "Desktop"))
    os.makedirs(os.path.join(home, "Applications", "Google Chrome.app"))  # 크롬이 설치된 것처럼
    for f in ["sw_vers", "open", "pbcopy", "launchctl", "plutil", "osacompile", "sysctl", "osascript"]:
        os.symlink(os.path.join(STUBS, f), os.path.join(home, "bin", f))
    if with_v2:
        os.makedirs(os.path.join(home, ".opencode", "bin"))
        shutil.copy(os.path.join(STUBS, "opencode-v2"), os.path.join(home, ".opencode", "bin", "opencode"))
    return home


def chrome_prefs(home, loaded=False, pinned=False):
    """크롬이 확장을 넣었을 때 남기는 프로필 기록을 흉내 낸다."""
    ext = os.path.realpath(os.path.join(home, "ClaudeBalanceKit", "extension"))
    ext_id = "".join("abcdefghijklmnop"[int(c, 16)] for c in hashlib.sha256(ext.encode()).hexdigest()[:32])
    prefs = {"extensions": {"settings": {}, "pinned_extensions": []}}
    if loaded:
        prefs["extensions"]["settings"][ext_id] = {"path": ext, "location": 4}
    if pinned:
        prefs["extensions"]["pinned_extensions"].append(ext_id)
    d = os.path.join(home, "Library", "Application Support", "Google", "Chrome", "Default")
    os.makedirs(d, exist_ok=True)
    with open(os.path.join(d, "Preferences"), "w") as f:
        f.write(json.dumps(prefs, separators=(",", ":")))  # 크롬처럼 공백 없는 JSON


def run(home, answers, extra_env=None, timeout=150):
    """answers : [(기다릴 글자, 보낼 글자, 보내기 전에 할 일 또는 None)] — 마지막으로 보낸 뒤 새로 나온 글자에서 찾는다."""
    env = dict(os.environ)
    env.update({
        "HOME": home,
        "PATH": os.path.join(home, "bin") + ":" + os.path.join(home, ".opencode", "bin") + ":" + env["PATH"],
        "CBK_ALLOW_NON_MAC": "1",
        "CBK_LOCAL_SOURCE": ROOT,
        "CBK_REPO": "tester/claude-balance-kit",
        "CBK_NO_OPEN": "1",
        "CBK_SIM_LOG": os.path.join(home, "sim.log"),
        "TERM": "dumb",
    })
    env.update(extra_env or {})
    pid, fd = pty.fork()
    if pid == 0:
        os.execvpe("bash", ["bash", "-c", "cat '%s/install.sh' | bash" % ROOT], env)
    out = b""
    mark = 0
    idx = 0
    deadline = time.time() + timeout
    while time.time() < deadline:
        r, _, _ = select.select([fd], [], [], 0.2)
        if r:
            try:
                chunk = os.read(fd, 4096)
            except OSError:
                break
            if not chunk:
                break
            out += chunk
        if idx < len(answers) and answers[idx][0].encode() in out[mark:]:
            time.sleep(0.2)
            if answers[idx][2]:
                answers[idx][2]()
            os.write(fd, answers[idx][1].encode())
            out += ("\n<<보냄 %d>>\n" % idx).encode()
            mark = len(out)
            idx += 1
    _, status = os.waitpid(pid, 0)
    return os.waitstatus_to_exitcode(status), out.decode("utf-8", "replace"), idx


def main():
    tmp = tempfile.mkdtemp()
    fails = 0
    outs = []
    checks = []
    try:
        # 1) 틀린 키 3번
        home = make_home(tmp, "wrongkey")
        code, out, sent = run(home, [
            ("준비되면 엔터", "\n", None),
            ("API 키 :", FAKE_USR_KEY + "\n", None),
            ("API 키 :", "hello\n", None),
            ("API 키 :", "sk-ant-" + "admin01-" + "Q" * 30 + "\n", None),
        ])
        outs.append(out)
        checks += [
            ("1) 네 번 모두 입력 받음", sent == 4),
            ("1) API 키 만드는 법 안내(Create key)", "Create key" in out),
            ("1) sk-ant-usr 개인 키도 받아서 실제 서버에 확인 → 401 키 오류 안내", "키 오류" in out),
            ("1) 서버가 돌려준 이유 표시", "서버 응답 : HTTP 401" in out),
            ("1) 형식 오류 안내", "sk-ant- 로 시작" in out),
            ("1) 관리자 키를 넣으면 안내", "관리자 키(sk-ant-admin…)" in out),
            ("1) 3번 실패 후 멈춤", "3번 실패" in out and code != 0),
            ("1) 화면에 키가 보이지 않음", FAKE_USR_KEY not in out),
        ]

        # 2) 처음 설치 — 안내를 따라 끝까지
        home2 = make_home(tmp, "full", with_v2=True)
        code2, out2, sent2 = run(home2, [
            ("준비되면 엔터", "\n", None),
            ("API 키 :", FAKE_KEY + "\n", None),
            ("아이콘을 만들까요?", "ㅛ\n", None),
            ("「개발자 모드」 스위치", "\n", None),
            ("「선택」 버튼", "\n", lambda: chrome_prefs(home2, loaded=True)),
            ("핀(압정)", "\n", lambda: chrome_prefs(home2, loaded=True, pinned=True)),
            ("작은 창 맨 위에 잔액", "\n", None),
            ("관리자 키를 넣을까요?", "\n", None),
        ], {"CBK_SKIP_VALIDATE": "1"})
        outs.append(out2)
        creds_path = os.path.join(home2, ".fake-opencode-creds.json")
        creds = open(creds_path).read() if os.path.exists(creds_path) else ""
        checks += [
            ("2) 설치 완료(종료 코드 0)", code2 == 0),
            ("2) 질문에 모두 답함", sent2 == 8),
            ("2) 한글 자판 'ㅛ' 를 예로 인식", os.path.exists(os.path.join(home2, "Library/LaunchAgents/com.claudebalancekit.opencode.plist"))),
            ("2) 단계 번호 표시", "[3/7] OpenCode 설치" in out2 and "[6/7] 크롬 확장 넣기" in out2 and "[7/7]" in out2),
            ("2) 키가 OpenCode 에 등록됨", FAKE_KEY in creds),
            ("2) 화면에 키가 보이지 않음", FAKE_KEY not in out2),
            ("2) 크롬 등록 자동 확인", "크롬에 잘 들어갔어요" in out2),
            ("2) 핀 고정 자동 확인", "툴바에 고정됐어요" in out2),
            ("2) 버튼 이름이 지금 크롬과 같음", "압축해제된 확장 프로그램 로드" in out2),
            ("2) 끝 인사와 쓰는 법", "설치가 끝났어요" in out2 and "$ 아이콘" in out2),
            ("2) OpenCode 설치 문구 숨김(점만 찍음)", "exec $SHELL" not in out2),
        ]

        # 3) 같은 맥에서 다시 실행 — 업데이트
        code3, out3, sent3 = run(home2, [
            ("준비되면 엔터", "\n", None),
            ("API 키를 새로 넣을까요?", "\n", None),
            ("아이콘을 만들까요?", "\n", None),
            ("동그란 화살표(↻)", "\n", None),
        ], {"CBK_SKIP_VALIDATE": "1"})
        outs.append(out3)
        checks += [
            ("3) 업데이트 완료(종료 코드 0)", code3 == 0),
            ("3) 업데이트 모드 안내", "업데이트 모드" in out3),
            ("3) 새로고침 안내", "동그란 화살표(↻)" in out3 and "업데이트를 마쳤어요" in out3),
            ("3) 핀이 이미 있으면 핀 안내 생략", "핀(압정)" not in out3),
            ("3) 키 유지", FAKE_KEY in (open(creds_path).read() if os.path.exists(creds_path) else "")),
        ]

        # 4) 확장을 못 넣은 경우 — 확인 실패 → s 로 넘어가기
        home4 = make_home(tmp, "notloaded")
        code4, out4, sent4 = run(home4, [
            ("준비되면 엔터", "\n", None),
            ("API 키 :", FAKE_KEY + "\n", None),
            ("「개발자 모드」 스위치", "\n", None),
            ("「선택」 버튼", "\n", None),
            ("s = 넘어가기", "s\n", None),
            ("핀(압정)", "\n", None),
            ("작은 창 맨 위에 잔액", "\n", None),
            ("관리자 키를 넣을까요?", "\n", None),
        ], {"CBK_SKIP_VALIDATE": "1", "CBK_SKIP_OPENCODE": "1"}, timeout=200)
        outs.append(out4)
        checks += [
            ("4) 확인 실패 안내", "아직 확인이 안 돼요" in out4),
            ("4) 넘어간 뒤 끝까지 진행", code4 == 0 and "설치가 끝났어요" in out4),
            ("4) 남은 할 일에 확인 항목", "카드가 있는지 확인" in out4),
        ]

        for desc, okay in checks:
            print(("  통과 · " if okay else "  실패 · ") + desc)
            fails += 0 if okay else 1
        if fails:
            for i, o in enumerate(outs, 1):
                print("\n--- %d) 출력 ---\n%s" % (i, o))
    finally:
        shutil.rmtree(tmp, ignore_errors=True)
    print("대화형 모의 실행 : 통과 %d · 실패 %d" % (len(checks) - fails, fails))
    sys.exit(1 if fails else 0)


if __name__ == "__main__":
    main()
