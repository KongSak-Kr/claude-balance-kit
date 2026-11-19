# Claude 잔액 키트

맥에서 터미널 한 줄로 설치하는 Anthropic(Claude) 크레딧 잔액 도구입니다.

- **OpenCode** 를 설치하고 Anthropic API 키를 등록합니다(다른 공급자 키는 그대로).
- **크롬 확장** : 툴바 버튼을 누르면 콘솔 결제 페이지에서 잔액을 확인해 보여 주고, 오늘 · 이번 주 · 이번 달 사용액과 최근 충전일, 잔액 부족 알림을 제공합니다.

## 설치 (맥)

```
curl -fsSL https://raw.githubusercontent.com/KongSak-Kr/claude-balance-kit/main/install.sh | bash
```

처음 쓰는 분은 [설치안내서](manual/설치안내서.md)를 그대로 따라 하세요.
삭제 : `bash ~/ClaudeBalanceKit/uninstall.sh`

## 저장소 구조

```
install.sh            맥 한 줄 설치 (bash 3.2 호환, 질문은 /dev/tty, 키는 화면·인자·로그에 남기지 않음)
uninstall.sh          삭제
extension/            크롬 확장 (Manifest V3, 빌드 과정 없음)
  background.js       15분 알람 · 비용 조회 · 잔액 확인 탭 · 배지 · 알림
  content-billing.js  결제 페이지에서 잔액 · 충전 내역 읽기
  popup.*  options.*  팝업 · 설정 화면
  lib/                계산 · 파싱 함수 (단위 테스트 대상)
manual/               설치안내서 · 맥 테스트 체크리스트
docs/확인사항.md       착수 전 공식 문서 확인 결과(출처 포함)
tests/                단위 테스트 · manifest 검사 · 키 유출 검사 · 모의 설치 · 확장 동작 시험
tools/                아이콘 생성 · GitHub 아이디 바꾸기
```

## 개발 · 검사 (윈도우 · 리눅스)

필요 : Node 20 이상(검사용), Git Bash(윈도우). 확장 자체는 Node 없이 동작합니다.

```
node tests/check-manifest.js               # manifest 문법 · 권한 · 파일
TZ=Asia/Seoul node --test tests/*.test.js  # 파싱 · 계산 단위 테스트
bash tests/secret-scan.sh                  # 실제 키 모양 0건 확인
bash tests/sim/run-sim.sh                  # 설치 · 삭제 모의 실행 (가짜 맥 명령)
python3 tests/sim/interactive-sim.py       # curl | bash 대화형 모의 실행 (리눅스 전용)
node tests/e2e/extension-e2e.js            # 크로미움에 확장을 올려 자동 시험 (playwright 필요)
```

윈도우 크롬에서 직접 시험 : `chrome://extensions` → 개발자 모드 → **압축해제된 확장 프로그램을 로드합니다** → 이 저장소의 `extension` 폴더.

맥 검사는 GitHub Actions(`.github/workflows/ci.yml`, macos-latest)에서 shellcheck · 비대화 설치 · 재실행 · 삭제를 자동으로 합니다.

## 처음 올리기 전에

설치 한 줄 등에 들어 있는 임시 아이디를 실제 GitHub 아이디로 바꿉니다(Git Bash) :

```
bash tools/set-github-id.sh 내아이디
```

저장소는 **공개(public)** 여야 합니다(설치 한 줄이 로그인 없이 파일을 받기 때문). 키·개인정보는 절대 넣지 마세요 — `tests/secret-scan.sh` 가 검사합니다.

## 보안

- API 키는 OpenCode 에만 저장되고, 설치 과정에서 화면 · 로그 · 셸 기록 · 명령줄 인자에 남지 않습니다.
- 관리자 키는 크롬 `chrome.storage.local`(이 컴퓨터)에만 저장되고 동기화되지 않습니다.
- 확장은 `api.anthropic.com`(사용액)과 `platform.claude.com`(결제 페이지) 외에는 아무 데도 요청하지 않습니다. 분석 도구 · 원격 로그 없음.
