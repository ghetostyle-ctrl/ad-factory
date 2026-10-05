# AD FACTORY

제품 자료와 광고 레퍼런스를 모아 광고 이미지와 완성 영상(30~60초 세로 MP4: 대본·내레이션·AI 정지 이미지·Veo 클립·모션그래픽·자막 조립)을 만드는 한국어 로컬 대시보드입니다.

**개발용 베타 공개본**입니다. 각자 API 키를 연결하고 소스를 수정해 사용할 수 있습니다. Windows 설치 실행 파일(EXE)이 아니라 Bun으로 실행하는 소스 배포입니다. 실제 사용 전 [현재 제한 사항](docs/KNOWN-ISSUES.md)을 확인하세요.

## AD 스위트 한 번에 설치 (AD FACTORY · Success AI · 키워드와처)

광고 레퍼런스 수집기 [Success AI](https://github.com/ghetostyle-ctrl/success_ai)와 검색량 트렌드 대시보드 [키워드와처](https://github.com/ghetostyle-ctrl/keyword-watcher)까지 한 폴더(`%USERPROFILE%\ad-suite`)에 받아 준비합니다. [Node.js](https://nodejs.org) 20 이상이 필요하고, Bun은 없으면 자동 설치합니다.

PowerShell에서:

```powershell
iwr https://raw.githubusercontent.com/ghetostyle-ctrl/ad-factory/main/install-suite.ps1 -OutFile "$env:TEMP\install-suite.ps1"; powershell -ExecutionPolicy Bypass -File "$env:TEMP\install-suite.ps1"
```

또는 이 저장소를 받은 뒤 `install-suite.cmd`를 더블클릭합니다. **업데이트도 같은 방법**으로 합니다. 다시 실행하면 이미 받은 앱의 코드만 최신으로 바꾸고(git으로 받았으면 git pull, ZIP이면 새 ZIP으로 교체), API 키(`.env`)·작업 기록·DB·로그는 그대로 둡니다. 켜져 있던 앱은 창을 닫았다 다시 켜면 새 버전이 적용됩니다. 업데이트 없이 실행하려면 `-NoUpdate`를 붙이세요.

설치가 끝나면 바탕화면에 **AD 스위트 실행**(세 앱을 창 없이 한 번에 켜고 AD FACTORY를 브라우저로 열기)과 **AD 스위트 종료** 아이콘이 생깁니다. Windows 로그인 때 자동으로 켜려면 설치 명령 끝에 `-AutoStart`를 붙여 한 번 더 실행하세요(해제: `ad-suite\ad-factory\suite\register-autostart.ps1 -Remove`). API 키는 넣지 않으므로 설치 후 앱마다 본인 키를 연결하세요(키워드와처는 네이버 검색광고 API, AD FACTORY는 연결 설정 화면).

## 다운로드와 실행

[릴리스 다운로드](https://github.com/ghetostyle-ctrl/ad-factory/releases)에서 소스 ZIP을 내려받아 압축을 풉니다. GitHub의 **Code → Download ZIP**으로도 받을 수 있습니다.

1. Windows에서 `start-local.cmd`를 더블클릭합니다.
2. Bun이 없으면 **Bun 1.3.14 자동 설치 → 의존성 설치 → 화면 빌드 → 서버 시작**을 진행합니다. 첫 실행에는 인터넷 연결과 몇 분의 시간이 필요합니다.
3. 자동으로 열린 브라우저에서 **연결 설정**에 본인의 API 키를 저장합니다. 직접 접속할 주소는 `http://127.0.0.1:4317/`입니다.

영상 기능에는 별도로 [FFmpeg](https://ffmpeg.org/download.html) 8.x full 빌드(libass·libx264 포함)의 `ffmpeg`와 `ffprobe`를 설치하고 PATH에 추가해야 합니다. 자막 폰트(Pretendard, OFL)는 저장소에 들어 있습니다.

자동 설치한 Bun은 앱 폴더의 `.runtime/bun`에만 저장됩니다. 기존 Bun이 PATH에 있으면 그대로 사용하며, 관리자 권한이나 시스템 PATH 변경은 필요하지 않습니다. 자동 설치 실패 시 오류 창을 확인하고 다시 실행하세요. 설치 방식: [Bun 공식 안내](https://bun.sh/docs/installation).

터미널에서 직접 실행하려면 Bun을 별도로 설치하거나 `.runtime/bun/bin/bun.exe`를 사용합니다:

```sh
bun install --frozen-lockfile
bun run build
bun run start
```

## 별도 설명서

- [설치·연결·사용 설명서](docs/USER-GUIDE.md)
- [개발·확장 가이드](docs/DEVELOPMENT.md)
- [현재 제한 사항](docs/KNOWN-ISSUES.md)
- [공개본 검증 기록](docs/VALIDATION.md)
- [기여 방법](CONTRIBUTING.md)

## 기능과 연결

| 기능 | 현재 범위 | 필요한 연결 |
|---|---|---|
| 자료 라이브러리 | 제품 자료, 출처 URL, 첨부 자료 보관 | 로컬 저장 |
| 광고 기획 | 자료와 레퍼런스를 바탕으로 카피·타깃·이미지 지시 작성 | OpenAI 또는 별도 설정한 Codex CLI |
| 이미지 제작 | 1~10개 선택, 생성 및 AI 검토 | OpenAI API |
| 영상 기획·대본 | 0~10개 선택. 고객 상황·콘셉트·카피 교정 기록, 문장 아래 컷을 묶은 30~60초 대본, 규칙 검사·AI 검토, **사용자 대본 승인** 후 제작 | 텍스트 공급자 |
| 내레이션 | 문장별 음성 합성, 실측 길이로 타임라인 확정 | Typecast API |
| 화면 소스 | AI 정지 이미지, Veo 시작 이미지, 모션그래픽 | OpenAI API, ffmpeg |
| Veo 클립 | image-to-video 클립(영상당 최대 4개). Veo API 또는 Google Flow 웹 수동 업로드 중 선택 | Gemini API 또는 Google AI Pro(Flow) + ffprobe |
| 완성 영상 | 자막·BGM 덕킹·음량 보정까지 조립한 `video-final-<n>.mp4` | ffmpeg 8.x full |
| Success AI | 별도 앱의 자료 가져오기 또는 JSON 가져오기 | 별도 설치 필요 |

API 사용료는 이용자 본인의 공급자 계정에 청구됩니다. 키가 저장됐다는 표시가 실제 호출 권한·잔액 검증을 의미하지는 않습니다. ChatGPT나 Flow 웹 구독과 API 이용 조건은 각 공급자에서 확인하세요.

현재 자동화의 기본 범위는 **광고 소재 제작**(이미지·완성 영상)입니다. 광고 집행은 기본 범위가 아닙니다. 영상 제작 전 단계(대본 승인)에서 사람이 대본을 확인하며, 한국어 AI 말투 규칙([im-not-ai](https://github.com/epoko77-ai/im-not-ai), MIT에서 광고 카피에 맞는 항목만 발췌)은 카피 교정·대본 검토 단계에만 적용됩니다.

**검증 한계**: 위 영상 제작 흐름은 로컬 fixture 테스트로 검증했고, 실제 모델이 내는 기획·카피 품질, Typecast 음성의 청감, Google Flow 화면 조작 절차는 충분히 검증하지 못했습니다. Flow 사용 절차는 [FLOW-MODE.md](FLOW-MODE.md)를 참고하세요. 이미지·영상 표시 영역은 나뉘어 있지만 실행 상태와 제어는 일부 공유됩니다.

## 내 데이터는 어디에 있나요?

- API 키: 설치 폴더의 `.env` (로컬 평문 파일)
- 프로젝트·작업: `data/studio.sqlite`
- 생성 결과물: `data/artifacts`
- 모델 설정: `data/model-settings.json`

이 저장소에는 제작자의 API 키, 작업 DB, 업로드 자료, 생성 이미지·영상, 실행 로그가 포함되지 않습니다. 앱 서버는 `127.0.0.1`에서 실행되며 로그인과 사용자별 격리가 없는 로컬 사용 용도입니다.

## 자유롭게 개발하기

Fork 후 코드를 수정해 자신의 앱으로 발전시킬 수 있습니다. 개선사항은 Pull Request로 제안해 주세요. 사용·수정·재배포·상업적 이용 조건은 [MIT 라이선스](LICENSE)를 따릅니다. 외부 API, 모델, 의존성, 사용자 업로드 자료에는 각각의 이용 조건이 적용됩니다.

Gemini/Veo 결제 준비: [Gemini API 결제 설명서](docs/GEMINI-BILLING.md)
