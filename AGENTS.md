# AD FACTORY — 연결된 에이전트(Claude Code · Codex) 작업 안내

이 폴더는 AD FACTORY(AD 스위트) 앱이다. 사용자가 이 폴더에서 Claude Code 나 Codex 를 켜 두면, 그 에이전트가 이 문서를 읽고 앱이 사람 손을 기다리는 구간을 대신 이어간다. 대화 맥락은 도구 간에 공유되지 않으므로 결정·진행 상황은 파일(이 문서, 작업 기록, git 커밋)에 남긴다.

## 먼저 읽을 문서

1. [README.md](README.md) — 설치·실행·연결 설정
2. [docs/USER-GUIDE.md](docs/USER-GUIDE.md) — 사용자 흐름
3. [FLOW-MODE.md](FLOW-MODE.md) — Google Flow 에서 Veo 클립·설명 이미지를 만들어 올리는 절차(13절: Veo 3.1 Lite + HyperFrames 분담)
4. [FLOW-AGENT-RUN-BRIEF.md](FLOW-AGENT-RUN-BRIEF.md) — 영상 1편 단위 실행 순서·상한·보고 형식
5. [FLOW-AGENT-BRIEF-VEO-HYPERFRAMES.md](FLOW-AGENT-BRIEF-VEO-HYPERFRAMES.md) — 설명 컷 분담 규칙(INFO 그래픽은 Veo, 글자·라벨판·연결선은 HyperFrames)
6. `instructions/README.md` — 편집 가능한 창작 지시 파일과 임계값

## 구조

- `server/` — Bun + Hono API 서버(기본 `http://127.0.0.1:4317/`, API 문서 `/api/docs`)
- `shared/` — 서버·화면 공용 스키마, `src/` — React 화면, `tests/` — `bun test`
- `instructions/` — 창작 지시 파일(마크다운 절 + `thresholds.json`). 저장 즉시 다음 생성부터 반영
- `data/` — 로컬 DB·결과물·로그. **git 제외, 삭제 금지**
- `.env` — API 키. **내용을 출력·커밋·공유 금지**

## 명령

```sh
bun run start                                   # 서버
bun run flow export <jobId> <영상번호>          # Flow 번들(프롬프트·시작 이미지) 저장
bun run flow import <jobId> <영상번호> <클립ID> <mp4> --model "Veo 3.1 - Lite"
bun run flow import-image <jobId> <영상번호> <I1~I3> clean|info <png>
bun run script show|approve|rewrite <jobId> <영상번호> ["피드백"]
curl -s -H "Origin: http://127.0.0.1:4317" http://127.0.0.1:4317/api/state   # 작업·엔진 상태(JSON)
```

API 호출은 `Origin: http://127.0.0.1:4317` 헤더가 있어야 한다.

## 작업 규칙

- 두 도구를 동시에 돌리지 않는다. 한쪽이 끝나고 커밋한 뒤 넘긴다.
- 유료 호출·Flow 크레딧은 **사용자가 제작을 시작할 때 승인한 범위 안에서만** 쓴다. 새 작업 생성·수량 변경·크레딧 구매는 사용자가 한다.
- 카피·대본·이미지는 앱의 승인 정책대로 사용자가 본다. 에이전트가 대신 승인하지 않고, 길이 때문에 문장을 자르지 않는다.
- 검증하지 않은 것은 "미검증"으로 적는다. 서버를 임의로 재시작하지 않는다.

## Flow 모드 자동 진행 (연결된 에이전트의 몫)

사용자가 제작을 시작한 작업이 **"Flow 클립 업로드 대기"** 가 되면, 그때 연결돼 있는 에이전트(Claude Code 든 Codex 든)가 **묻지 않고** 다음을 한다.

1. `/api/state` 에서 대기 중인 작업·영상 번호와 이미 올라간 클립(`renders[].clips`, 설명 이미지)을 읽는다. 올라간 것은 다시 만들지 않는다.
2. `bun run flow export <jobId> <n>` 으로 번들을 받고, [FLOW-AGENT-RUN-BRIEF.md](FLOW-AGENT-RUN-BRIEF.md) 순서대로 **브라우저(Claude in Chrome 확장 또는 Codex 브라우저 도구)로 Google Flow 를 직접 조작**해 클립을 만들고 `bun run flow import` 로 올린다. 설명 컷은 CLEAN·글자 없는 INFO 이미지를 먼저 올리고(앱이 글자 없음을 검사), 전환 영상은 CLEAN 첫 프레임·INFO 마지막 프레임으로 만든다.
3. 클립이 다 올라가면 앱이 라벨 합성·조립을 하고 다음 영상을 대기에 올린다. 마지막 영상까지 같은 식으로 이어간다.
4. 멈추는 조건은 세 가지뿐이다. 영상당 크레딧 상한(기본 70) 초과, Flow 잔액 60 미만, 앱이 attention 으로 멈춤 또는 에이전트 2회 연속 실패. 그때만 사용자에게 보고하고 선다.
5. 영상이 완성될 때마다 번호·길이·크레딧 전후·눈으로 본 문제를 한 줄로 보고한다.

앱은 이 구간에서 스스로 브라우저를 조작하지 않는다. 에이전트가 켜져 있지 않으면 사용자가 FLOW-MODE.md 대로 직접 올린다.

## 필요한 것

- Google Flow(https://labs.google/fx/tools/flow)에 AI Pro 구독 계정으로 로그인된 Chrome
- Claude Code: Claude in Chrome 확장이 연결된 세션 / Codex: 브라우저 도구가 있는 세션
- 앱 서버가 떠 있고 `bun` 이 설치돼 있을 것
