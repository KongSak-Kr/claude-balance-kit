"""install.sh 대화형 흐름 모의 실행 (개발용, 리눅스)

`cat install.sh | bash` 를 가상 터미널(pty) 안에서 돌린다. curl | bash 와 같이 표준입력은 스크립트이고,
질문 답과 키는 /dev/tty 로 들어간다.

  1) 틀린 키 3번 → 실제 api.anthropic.com 이 401 을 돌려주면 "키 오류"로 안내 → 3번째에 멈춤
  2) 키 확인 생략(CBK_SKIP_VALIDATE=1) + 가짜 OpenCode 2.x 로 끝까지 설치

사용 : python3 tests/sim/interactive-sim.py
"""
import os
import pty
import select
import shutil
import subprocess
import sys
import tempfile
import time

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", ".."))
STUBS = os.path.join(ROOT, "tests", "sim", "stubs")
FAKE_KEY = "sk-ant-" + "api03-" + "Z" * 40  # 실제 키 아님 (서버가 401 을 돌려줌)


def make_home(tmp, name, with_v2=False):
    home = os.path.join(tmp, name)
    os.makedirs(os.path.join(home, "bin"))
    os.makedirs(os.path.join(home, "Desktop"))
    for f in ["sw_vers", "open", "pbcopy", "launchctl", "plutil", "osacompile", "sysctl", "osascript"]:
        os.symlink(os.path.join(STUBS, f), os.path.join(home, "bin", f))
    if with_v2:
        os.makedirs(os.path.join(home, ".opencode", "bin"))
        shutil.copy(os.path.join(STUBS, "opencode-v2"), os.path.join(home, ".opencode", "bin", "opencode"))
    return home


def run(home, answers, extra_env=None, timeout=90):
    """answers : [(기다릴 글자, 보낼 글자)] — 기다릴 글자가 화면에 나오면 보낸다."""
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
        if idx < len(answers) and answers[idx][0].encode() in out[-4000:]:
            time.sleep(0.2)
            os.write(fd, answers[idx][1].encode())
            out += ("\n<<보냄 %d>>\n" % idx).encode()
            idx += 1
    _, status = os.waitpid(pid, 0)
    return os.waitstatus_to_exitcode(status), out.decode("utf-8", "replace"), idx


def main():
    tmp = tempfile.mkdtemp()
    fails = 0
    try:
        # 1) 틀린 키 3번
        home = make_home(tmp, "wrongkey")
        code, out, sent = run(home, [("API 키 :", FAKE_KEY + "\n"), ("API 키 :", "hello\n"), ("API 키 :", "sk-ant-" + "admin01-" + "Q" * 30 + "\n")])
        checks = [
            ("세 번 모두 입력 받음", sent == 3),
            ("실제 서버 401 → 키 오류 안내", "키 오류" in out),
            ("형식 오류 안내", "sk-ant-api 로 시작" in out),
            ("관리자 키를 넣으면 안내", "관리자 키(sk-ant-admin…)" in out),
            ("3번 실패 후 멈춤", "3번 실패" in out and code != 0),
            ("화면에 키가 보이지 않음", FAKE_KEY not in out),
        ]
        # 2) 끝까지 설치
        home2 = make_home(tmp, "full", with_v2=True)
        code2, out2, sent2 = run(
            home2,
            [("API 키 :", FAKE_KEY + "\n"), ("바로가기를 만들까요?", "ㅛ\n")],
            {"CBK_SKIP_VALIDATE": "1"},
        )
        creds = open(os.path.join(home2, ".fake-opencode-creds.json")).read() if os.path.exists(os.path.join(home2, ".fake-opencode-creds.json")) else ""
        checks += [
            ("설치 완료(종료 코드 0)", code2 == 0),
            ("한글 자판 'ㅛ' 를 예로 인식", os.path.exists(os.path.join(home2, "Library/LaunchAgents/com.claudebalancekit.opencode.plist"))),
            ("단계 번호 표시", "[3/6] OpenCode 설치" in out2 and "[6/6] 크롬 확장 준비" in out2),
            ("키가 OpenCode 에 등록됨", FAKE_KEY in creds),
            ("화면에 키가 보이지 않음", FAKE_KEY not in out2),
            ("다음에 할 일 체크리스트", "다음에 할 일" in out2 and "관리자 키" in out2),
        ]
        for desc, okay in checks:
            print(("  통과 · " if okay else "  실패 · ") + desc)
            fails += 0 if okay else 1
        if fails:
            print("\n--- 1) 출력 ---\n" + out + "\n--- 2) 출력 ---\n" + out2)
    finally:
        shutil.rmtree(tmp, ignore_errors=True)
    print("대화형 모의 실행 : 실패 %d" % fails)
    sys.exit(1 if fails else 0)


if __name__ == "__main__":
    main()
