# instructions/ — 편집 가능한 창작 지시 파일

사용자 결정(2026-10-07): **창작 판단은 앱 안의 편집 가능한 지시 파일로, 계산과 상태는 코드로.** 이 폴더의 파일은 서버가
**생성 호출마다** 읽어 다음 생성부터 바로 반영한다(재시작·빌드 불필요). 파일이 깨지거나 비면 마지막으로 성공한 내용을 그대로 쓰고
경고를 남긴다. 생성 산출물에는 그때 읽은 지시 파일 해시(`instructionsDigest`, sha256 앞 8자리는 이벤트 "지시 파일 xxxxxxxx 적용")와
읽은 시각을 기록한다. 모델 응답 JSON 의 칸 이름(스키마)은 코드에 남는다.

> 상태(2026-10-08, 통합 완료): 로더(`server/instructions.ts`)·임계값(`thresholds.json` → `shared/thresholds.ts` 주입)·골든 테스트
> (`tests/golden/instructions-*.txt`, 61개)·상태 API(`GET /api/instructions`, `server/instructions-status.ts`)·연결 설정 창의 '지시 파일'
> 읽기 전용 카드(`src/InstructionsCard.tsx`)가 있고, **9개 파일(copy-first.md 포함) 모두 코드에 연결됐다**: `server/video-planning.ts`(기획·카피 교정)·
> `server/source-planning.ts`(자료 기획 3종)·`server/script-instructions.ts`(대본)·`server/video-scripts.ts`(AI 검토)·
> `server/copy-instructions.ts`(카피 규칙)·`server/copy-writer.ts`·`server/video-scripts.ts` `sceneFromCopyInstructions`(카피 먼저 흐름 편지 1·2, `copy-first.md`)·`server/flow-instructions.ts`(Flow·Veo·이미지 문장, `flow.md`)가 호출마다
> `loadInstructions()` 로 절을 읽어 조립하고, 규칙 검사 코드는 같은 로드의 임계값(`thresholds()`)을 읽는다. 대본 검토 기록
> (`renders[n].scriptReview.instructionsDigest/instructionsLoadedAt`)과 기획 산출물(`instructions-plan.json`)·이벤트
> ("지시 파일 xxxxxxxx 적용")에 그때 읽은 해시가 남는다(`tests/instructions-wiring.test.ts`·`tests/instructions-flow.test.ts`).
> 서버는 기동 때 한 번 읽어 실패하면 원인을 출력하고 기동을 멈춘다(`server/index.ts`). `bun test tests/instructions-golden.test.ts` 가
> 분리 전 코드(b3ef40a)와 **바이트 단위로 같은** 프롬프트를 만드는지 확인한다.
> 2026-10-08 검토 반영: 코드에 남아 있던 창작 문구 4건(대본 예시 안내 `SCRIPT_SHAPE_EXAMPLE_NOTE`, 다시 쓰기 피드백 머리말
> `SCRIPT_USER_FEEDBACK_PREFIX`, 후기 사용 경계 `SOURCE_VOICE_ROLE_*`, 화면 소스 안내 `PLANNING_CONTEXT_ASSET_NOTE`)을 파일로 옮기고,
> 프롬프트의 리터럴 숫자(실사 컷 5초·설명 컷 보유 1초·무음 0.5초·자막 7자·0.5–2초)를 임계값 토큰으로 묶었다(골든 61개 바이트 동일 유지).

> 2026-10-09 규칙 코드 연결: 새 카피 먼저 장면은 `SCENE_FROM_COPY_HF_RULES`·`HF_REVIEW_RULES`를 사용하고 `infoClips[].labelLayer`에 원본 좌표/시각 계획을 저장한다. Flow의 `VEO_HF_INFO_IMAGE`·`VEO_HF_MOTION`·`HF_LABEL_LAYER_RULES`·`FLOW_INFO_CHECKLIST_HF`도 등록됐다. 새 INFO는 글자 없이 구조 그래픽을 유지하고, `infoLines` 원문은 HyperFrames 인계에 보존한다. 2026-10-10 자동 합성이 연결됐다. 앱은 03 배지·선·앵커를 합성하고 정상 승인·배치/읽기 시간 검사를 유지한다. 설치와 실제 대상 정합 확인은 docs/HYPERFRAMES-EDITING.md를 따른다. 기존 대본은 종전 프롬프트·문구 대조를 유지한다.

## 자주 하는 수정 → 어디를 고치나

| 하고 싶은 일 | 고칠 곳 | 주의 |
|---|---|---|
| 설명 컷(I1~I3)을 3초로 | `thresholds.json` `EXPLAINER_CUT_MAX_SEC` [2, 8] | **hybrid 정책에서만** 컷 길이 상한이다(프롬프트 6곳 토큰 + 코드 hard 검사가 같은 값). immersive·legacy 의 I1~I3 는 8초 Flow 클립(`VEO_CLIP_SEC`, 코드 고정)이라 바꿀 수 없다. 설명 컷이 동작 뒤 머무는 시간은 `EXPLAINER_HOLD_MS`. |
| 한 문장 글자 수 26자 → 30자 | `thresholds.json` `COPY_BEAT_TARGET_CHARS`(목표) / `COPY_BEAT_MAX_CHARS`(상한, 넘으면 hard 거부) | 한 곳으로 끝난다 — 토큰을 쓰는 절: script.md `SCRIPT_PACING_HEAD`, copy.md `KOREAN_COPY_RHYTHM_RULES`·`NATURAL_COPY_RHYTHM_RULES`, review.md `REVIEW_RHYTHM_IMMERSIVE`·`REVIEW_RHYTHM_DEFAULT`(아래 "임계값·파생 토큰을 쓰는 절" 표). 열려 있는 앱 화면의 미리 검사는 새로고침 뒤 새 값을 쓴다. |
| 설명 세계 강조색을 특정 색(예: 파랑·주황)으로 고정 | hybrid.md `EXPLAINER_GRAMMAR` R8 "The two accents come from the brand or its packaging", `HYBRID_PLANNING_RULES` "two brand accent colors (name them once, from the brand or packaging)", `HYBRID_SCRIPT_RULES` TWO ANCHORS "the two brand accent colors (name them)" — 세 문장을 함께 | flow.md `EXPLAINER_COLOR_ACCENT1/2` 는 "첫째/둘째 강조색" **자리말**이라 거기에 색을 적어도 실제 색은 바뀌지 않는다(실제 색 이름은 대본의 `explainerAnchor`). 색 이름은 **영문**(blue, orange …)으로 적어야 코드 검사(`shared/hybrid-script-rules.ts` `COLOR_WORDS`: explainerAnchor 에 영문 색 2개 이상, 아니면 hard 거부)를 통과한다 — 한글 색 이름은 코드가 모른다. 윤곽 강조색 red 는 hybrid.md R3 와 flow.md `EMPHASIS_OUTLINE` 두 곳이다. |
| 콜아웃 문구 금지어(예: "최고", "완벽") | script.md `SCRIPT_CALLOUTS`(생성 지시) + review.md `REVIEW_RULE_14`(검토, 장면 계획·콜아웃 규칙) | **코드 검사 없음**(프롬프트 지시만). 코드 쪽 콜아웃 검사(`shared/script-rules.ts`)는 word 가 문장 어절인지·영문·숫자만 본다. 내레이션 쪽 금지 표현(`CTA_FORBIDDEN`·`META_PHRASES`)은 코드 목록이다. |
| 실사 컷 길이 상한 5초 | `thresholds.json` `CUT_MAX_SEC` [2, 8] | script.md `SCRIPT_SCENES`(`{{maxCutSec}}`, 코드가 정책별로 채움)와 hybrid.md `HYBRID_SCRIPT_RULES` "Live cuts stay within {{CUT_MAX_SEC}} seconds", 코드 hard 검사가 같은 값. `HYBRID_ENDING_IMAGE_MAX_SEC` ≤ `CUT_MAX_SEC` 관계 검사 있음. |
| 자막 글자 수·표시 시간 | `thresholds.json` `CAPTION_LINE_MAX_CHARS`·`CAPTION_MIN_CHARS`·`CAPTION_MIN_MS`·`CAPTION_MAX_MS` | script.md `SCRIPT_CAPTIONS` 의 "7–12 chars"·"0.5–2 seconds" 가 토큰(`{{CAPTION_MIN_SEC}}` = ms/1000)이고 구절 자막 끊기 코드가 같은 값. hybrid.md R7 "captions … last 1–2 seconds" 의 1 은 임계값과 묶이지 않은 리터럴(함께 고칠 것). |
| 비교 장면 '겉은 똑같다 → 속이 드러난다' 순서, 첫 컷 얼굴 반응, 휴대폰 화면 꺼짐, ③④ 비트 정지 사진 제한 | hybrid.md `EXPLAINER_GRAMMAR` R5·R6, `HYBRID_PLANNING_RULES` LIVE/EXPLAINER 문장, `HYBRID_SCRIPT_RULES` BEAT→SOURCE·EXPLAINER SCENES·CUTS, `HYBRID_REVIEW_RULES` (h)(i)(j); flow.md `HYBRID_LIVE_TAIL`·`HYBRID_CLEAN_START_STATE`·`FLOW_HYBRID_EYE_CHECK` | 2026-10-08 추가. 코드 검사(단위 ③, `shared/hybrid-script-rules.ts` hybridProblems): ③④ 문장 아래 정지 연속 2컷 hard·정지 1컷 > `STILL_BEAT_MAX_SEC` hard, 비교 장면 첫 컷 early 아님 hard·둘째 컷 mid 아님 soft, 과정 장면 단계 역순 soft, 비교 장면에 우리 제품 표식(accent1 또는 outline) 없음 soft. 첫 컷 얼굴 반응·휴대폰 화면 꺼짐은 프롬프트·AI 검토만. |
| 이전 대본의 INFO 이미지 글자 규칙(labelLayer 없음) — 줄 수·길이·숫자·그림 스타일 | 줄 수 1~4·24자는 코드(`shared/video-script.ts` HybridInfoClipResponseSchema infoLines), 숫자는 자료에 있는 것만(`shared/script-rules.ts`, hard)·숫자 없으면 soft, 영문 금지(`shared/hybrid-script-rules.ts`), 업로드 대조(`server/flow-import.ts` infoTextProblems); 문구 작성법은 hybrid.md `EXPLAINER_GRAMMAR` R2·`HYBRID_SCRIPT_RULES` EXPLAINER SCENES·TEXT·`HYBRID_REVIEW_RULES` (b), 그림 스타일은 flow.md `HYBRID_OVERLAY_INFOGRAPHIC`·`HYBRID_OVERLAY_LABELS`·`HYBRID_MOTION_LABELS` | 2026-10-08 사용자 결정(인포그래픽은 앱이 아니라 Flow INFO 이미지 안에, 앱은 숫자 선택·글자 대조·자막만). 예전 혼합형 대본(infoLines 없음)은 글자 없음 검사·프롬프트 그대로(골든 hybrid-overlay-notext·hybrid-motion-notext). |
| 새 대본의 Veo/HyperFrames 역할·라벨 계획 | copy-first.md `SCENE_FROM_COPY_HF_RULES`·`HF_REVIEW_RULES`, flow.md `VEO_HF_INFO_IMAGE`·`VEO_HF_MOTION`·`HF_LABEL_LAYER_RULES`·`FLOW_INFO_CHECKLIST_HF` | 좌표·시각·대비·원문 참조 검사는 `shared/hf-label-plan.ts`, 이미지 검사는 `server/flow-import.ts`. 자동 합성·실제 대상 정합·모바일 영상 가독성은 다음 단위다. |
| 검토 규칙 하나를 끄거나 세게 | review.md `REVIEW_RULE_N`(머리말은 아래 review.md 표) | 절을 비우면 로드 오류다 — 끄려면 "N. (no check)" 처럼 한 줄은 남긴다. |

## 파일 형식

- 마크다운. `## KEY` 머리글(대문자·숫자·밑줄) 아래 본문이 한 절이다. 첫 머리글 앞의 글(제목·설명)은 무시한다.
- 절 본문의 **앞뒤 빈 줄은 지우고** 안쪽 줄바꿈은 그대로 둔다. 원문 상수가 끝에 줄바꿈을 두던 자리(IMMERSIVE_SCRIPT_RULES,
  NATURAL_COPY_RHYTHM_RULES)와 앞뒤 공백 한 칸(표의 '주의')은 코드가 붙인다.
- `{{NAME}}`(대문자) 토큰은 로드 때 치환한다: `thresholds.json` 값 → 파생값(`*_RATIO` → `*_PERCENT` = 반올림 퍼센트, `*_MS` → `*_SEC`
  = ms/1000(예: `{{CAPTION_MIN_SEC}}` = 0.5, `{{EXPLAINER_HOLD_SEC}}` = 1), `INFO_GRAPHIC_BAND_BOTTOM_FREE` = 100 − 아래 경계) → 코드 고정
  상수 순. 치환할 수 없는 토큰은 **로드 오류**다.
- `{{@KEY}}` 는 다른 절의 본문을 그 자리에 끼운다(치환이 끝난 본문, 순환은 오류).
- `{{name}}`(소문자 포함) 토큰은 호출 시점 값(`seconds`, `imageCount` 등)이라 로드 때 그대로 두고 코드가 `fillSection()` 으로
  채운다. 표의 '호출 시점 토큰'에 없는 소문자 토큰을 쓰면 로드 오류다.
- 절이 하나라도 빠지거나 비면 로드 오류. 같은 KEY 가 두 번 있어도 오류.
- JSON 절(examples.md)은 로드 때 파싱을 검증하고 코드가 `JSON.stringify` 로 끼운다(들여쓰기는 자유, 키 순서는 유지된다).

## 수정 규칙

1. 머리글(`## KEY`)은 바꾸지 않는다. 절을 지우거나 이름을 바꾸면 로드가 실패하고 마지막 성공본이 계속 쓰인다.
2. `{{TOKEN}}` 은 남겨 둔다. 숫자를 바꾸고 싶으면 `thresholds.json` 의 `value` 를 고친다(범위 `min`/`max` 안에서만).
3. 한 번에 한 절만 고치고 저장한다. 저장 후 **다음 생성부터** 반영된다(서버 재시작·빌드 불필요). 진행 중인 생성은 시작할 때 읽은
   본문을 끝까지 쓴다. **열려 있는 앱 화면**의 미리 검사(대본 편집기의 hard/soft 경고, FlowInfoClips 의 띠 %)는 앱 시작 때 받은
   임계값을 계속 쓰므로 **새로고침** 뒤 새 값을 쓴다(카드의 '다시 확인'은 표시만 갱신한다). 서버 쪽 검사(저장·승인·합성)는 바로 새 값이다.
4. 되돌리기는 git(`git diff instructions/`, `git checkout -- instructions/<파일>`). 이 폴더는 git 추적 대상이다.
5. 예전 작업은 자동으로 바뀌지 않는다. 저장된 대본·승인·합성 음성의 해시는 지시 파일과 무관하다(`scriptDigestJson` 에 넣지 않는다).
6. **토큰을 숫자로 덮어쓴 편집은 오류가 아니다**(`{{COPY_BEAT_TARGET_CHARS}}` → `30` 으로 적어도 정상 로드된다). 그러면 프롬프트와
   코드 검사(`thresholds.json` 값)가 조용히 어긋난다. 숫자를 바꾸고 싶으면 `thresholds.json` 만 고치고, 저장 전 `git diff instructions/`
   로 `{{ }}` 가 사라지지 않았는지 본다. 반대로 임계값과 묶이지 않은 리터럴 숫자도 일부 남아 있다(hybrid.md R7 "1–2 seconds",
   `EXPLAINER_GRAMMAR` R7·`HYBRID_SCRIPT_RULES` CUTS 의 "2–" 하한, "8-second" = VEO_CLIP_SEC 코드 고정) — 그 숫자는 절에서 직접 고친다.

## 깨졌을 때 증상과 확인법

- 증상: 지시 파일을 고쳤는데 생성 결과가 그대로다 / 연결 설정 창 '지시 파일' 카드의 배지가 **경고 · 마지막 성공본 사용 중** 또는
  **읽기 실패**다 / 실행 기록의 "지시 파일 xxxxxxxx 적용" 해시가 바뀌지 않는다.
- 확인 1(화면): **연결 설정 → 지시 파일** 카드에서 **다시 확인**을 누른다. 로더가 파일 변경을 다시 보고 결과를 그린다 — 경고 알림에
  한국어 원인("script.md: 절 X 이 없습니다", "토큰을 치환할 수 없습니다: {{Y}}", "임계값 Z = … 가 허용 범위 [a, b] 밖입니다",
  "examples.md: 절 K 은 JSON 이어야 합니다", "thresholds.json: JSON 이 아닙니다"), 성공본의 해시(앞 8자리 + 전체)·마지막 로드 시각,
  파일별 해시·크기·절 수·수정 시각, 임계값 목록이 보인다. 카드는 읽기 전용이다.
- 확인 2(API): `GET http://127.0.0.1:4317/api/instructions`(동일 출처만, 캐시 없음) → `{folder, loaded, digest, loadedAt, checkedAt,
  files[{name, digest, size, modifiedAt}], sections[{file, key, chars, runtime, json}], thresholds{이름: 값}, warnings[]}`.
  절 본문은 보내지 않고 글자 수(`chars`)만 보낸다. `loaded: true` + `warnings` 있음 = 직전 성공본으로 돌고 있다(해시·임계값은 성공본의
  것). `loaded: false` = 성공본이 없다(파일이 없거나 첫 로드부터 실패, `files` 에는 지금 있는 파일만, `sections`·`thresholds` 는 빈 값).
  서버 로그에도 같은 원인이 1회 남는다(`instructions.load_failed`).
- 고치면 다음 요청(다시 확인·다음 생성)에서 경고가 사라지고 해시가 바뀐다. 되돌리기는 git.
- 로더가 오류로 보는 것은 절 누락·중복·빈 절, 치환 못 하는 토큰, 선언 안 된 소문자 토큰, JSON 절 파싱 실패, 임계값 범위·관계 위반뿐이다.
  **토큰을 지운 편집·문장을 바꾼 편집은 오류가 아니다** — 뜻이 어긋났는지는 `git diff instructions/` 와 다음 생성 결과로만 알 수 있다.
- 생성 경로가 연결되면 서버 기동 시 첫 로드 실패는 기동 실패(원인 출력)다(마지막 성공본이 없으므로). 상태 API 는 그 경우에도 500 이
  아니라 `loaded: false` 로 답한다.

## 코드로 남은 값(파일에서 바꿀 수 없음)

- 응답 스키마에 묶인 값: `VIDEO_MIN_SEC` 30 · `VIDEO_MAX_SEC` 60 · `SHOT_MIN_SEC` 0.5 · `VEO_SHOTS_MAX` 4(응답 enum A~D) ·
  `VEO_STORED_SHOTS_MAX` 8 · `VEO_CLIP_SEC` 8(Flow literal) · `STILL_SHOTS_MAX` 14(S1~S14 enum) · `INFO_CLIPS_MAX` 3(I1~I3 enum) ·
  `CUT_GOAL_MAX_CHARS` 40 · `SUBJECTS_MAX` 4 · `CALLOUTS_MAX` 3 · `EXPLAINER_OBJECTS_MAX` 3 · `EXPLAINER_ACTIONS_MAX` 3 ·
  `EXPLAINER_EMPHASIS_MAX` 4 · `CLIP_PHASE_RANGES_MS`(early 0–3000·mid 3000–5500·late 5500–8000, `PHASE_TABLE` 토큰으로 표기만) ·
  콜아웃 word/text/targetId 길이, 문장 4–40개, 문장 60자, graphicLines 4×24자, graphicOrder 2–5, onScreenText 120자, fixedTitle 2×40자,
  disclaimer 240자, 기획 mutedMessage 40자·scenePlan 2–12·lines 4–40·durationSec 30–60.
- 운영 상수: `TIMELINE_MAX_TEMPO` 1.3(Typecast audio_tempo 상한과 묶임) · `CALLOUT_COLORS` 3(테마 accents) · `SILENCE_TRIM_FLOOR_MS`
  30000(= VIDEO_MIN_SEC) · REVIEWED_IMAGE_MAX_ATTEMPTS 2(render-state attempt max) · SCRIPT_MAX_GENERATIONS 3 · INFO_TEXT_MIN_CHARS 2 ·
  Flow 업로드 검증(200MB·4~12초·±200ms·시도 9회) · maxOutputTokens(기획 9000·대본 24000·검토 12000·자료 기획 1400/22000/14000).
- 목록형 규칙(정규식·낱말표): MEMO_ENDING_WORDS, PARTICLE_ENDING, PERSONA_*, NARRATION_TERM_TABLE, PRODUCT_QUANTITY, META_PHRASES,
  CTA_FORBIDDEN, REASON_CONNECTORS, REQUIREMENT_FORMS, LIVE_PROMPT_FORBIDDEN, PERSON/PRODUCT_WORDS, COLOR_WORDS, NUMERIC_SPAN —
  2차 후보. 지금은 코드.
- 모델 호출 중 지시 파일 밖에 남는 프롬프트: `image_review`·`start_image_review`·`clip_review`·`performance_analysis`
  (server/intelligence.ts), `info_text_check`(flow-import), `source_image_reading`(source-image-preview), `media_cut_analysis`
  (media-analysis), 예전 수동 파이프라인 `strategy`·`creative`(server/planning.ts). 판독·검토 프롬프트라 창작 지시가 아니다.
  범위에 넣을지는 사용자 결정.
- `copyRhythmInstruction` 의 `<copy-rhythm-policy id="…">` 래퍼, 대본 JSON SHAPE 줄(스키마 칸 이름; 뒤의 예시 안내는 script.md
  `SCRIPT_SHAPE_EXAMPLE_NOTE`), `explanationPrompt` 의 `<explanation-plan>` JSON, Flow prompts.md 의 문서 골격
  (`shared/flow-export-markdown.ts`), 화면 안내문(`src/FlowInfoClips.tsx`), 이미지 재생성 폴백 `"수정 요청: …"`
  (`server/reviewed-image-production.ts`)은 코드.
- **규칙 검사 메시지와 피드백 머리글은 코드다.** 모델에 되돌려 주는 "영상 대본 규칙 위반: …"(`shared/script-rules.ts` `scriptFeedback`)과
  그 안의 모든 한국어 위반 문구(`shared/script-rules.ts`·`shared/video-script.ts`·`shared/hybrid-script-rules.ts`), 기획 검증 문구
  (`server/source-evidence.ts`)는 코드가 계산해 만든다 — 임계값만 `thresholds.json` 에서 읽는다. 문구를 바꾸려면 그 파일을 고친다.
  (script.md `SCRIPT_FEEDBACK_PREFIX` = "FIX THESE PREVIOUS ISSUES:" 머리말과 `SCRIPT_USER_FEEDBACK_PREFIX` 는 파일.)
- `COLOR_WORDS`(`shared/hybrid-script-rules.ts`)는 **영문 색 이름만** 인정한다: 혼합형 대본의 explainerAnchor 에 영문 색이 2개 미만이면 hard
  거부. 지시 파일에 한글 색 이름을 적어 모델이 한글로 쓰면 거부된다.

## 코드 쪽 연결 지점(구현 단계 메모)

- 로더: `server/instructions.ts` `loadInstructions({root?})` → `{sections, thresholds, digest, loadedAt, files, warnings}` (동기;
  프롬프트 조립 함수가 동기라서). `sectionOf(snapshot, KEY)`, `sectionJson`, `fillSection(text, vars)`, `instructionsStamp`,
  `instructionsEventMessage`. 테스트는 `root` 와 `sections`(작은 등록부)를 주입한다.
- 임계값 주입(있음): 이름·기본값은 `shared/thresholds.ts`(`THRESHOLD_NAMES`·`DEFAULT_THRESHOLDS` = 분리 전 상수·`thresholds()`·
  `setThresholds()`·`resetThresholds()`·`withThresholds()`). 규칙 코드(`shared/script-rules.ts`, `shared/hybrid-script-rules.ts`,
  `shared/render-timeline.ts`(`timelineDefaults()`·`silenceTrimPlan`), `shared/narration-captions.ts`, `shared/copy-polish.ts`
  (`guardCopyEdit`; 규칙 글은 `server/copy-instructions.ts`), `shared/video-script.ts`(`rangeCharLimit`·`narrationProblems`·
  `alignmentProblems`·`videoTargetSeconds` 등))는 브라우저에서도 돌므로 `server/` 를 import 하지 않고 호출 때 `thresholds()` 를 읽는다.
  예전 이름의 상수(`COPY_BEAT_MAX_CHARS`, `CUT_MAX_SEC`, `CAPTION_LEAD_MS` …)는 기본값으로 남아 있다. 서버는 앱의 `instructions/`
  를 읽는 로더(`InstructionsLoader` 의 `apply`, 기본 root 면 참)가 `load()` 마다 `setThresholds(snapshot.thresholds)` 를 부르고,
  생성 호출이 없는 경로(대본 편집·승인 `script-service`, 내레이션 합성 `voice-production`)는 `syncThresholds()` 로 먼저 맞춘다.
  화면은 `src/api.ts` `fetchInstructions()`(앱 시작 때 1회, `GET /api/instructions` 의 `thresholds`)가 같은 값을 주입한다.
  `EXPLAINER_PHASE_SLACK_MS` 와 `EXPLAINER_HOLD_MS` 는 한 값(`EXPLAINER_HOLD_MS`). 테스트 `tests/instructions-flow.test.ts`
  (COPY_BEAT_MAX_CHARS 30 → 35자 문장 거부, 범위 밖 편집은 마지막 성공본 유지).
- Flow·이미지 프롬프트(있음): `flow.md` 의 절은 `server/flow-instructions.ts` `flowTexts(snapshot)`(→ `shared/flow-texts.ts`
  `FLOW_TEXT_KEYS`·`FlowTexts`, 등록부의 flow.md 절 집합과 같아야 함)가 모으고, shared 의 조립 함수(`veo-prompt.ts` `clipPrompt`·
  `cleanKeyframePrompt`, `flow-info-prompts.ts` `hybrid*/immersive*/info*Prompt`, `explanation-prompt.ts` `explanationPrompt`,
  `flow-mode.ts` `buildFlowExport`·`flowChecklist`)는 그 글을 인자로만 받는다(본문 없음, 호출 시점 토큰은 `fillTemplate`).
  서버 wrapper: `flowExportFor(job, n)`(클립 단계 산출물 `flow-export-<n>.json`), `clipPromptFor`(API 모드 Veo), 이미지 모듈의
  `startImagePrompt`·`stillPrompt`·`sceneImagePrompt`·`sourceImagePrompt`(기본 인자 `flowTexts()`). 화면 `src/FlowPanel.tsx` 는
  더 이상 조립하지 않고 `GET /api/jobs/:id/videos/:n/flow-export`(서버가 지금 파일로 조립, `FlowExportPreviewSchema`: 시작
  이미지 전에는 `startImageArtifact` 가 빈 문자열)를 받는다. 지시 파일 밖에 남은 것: 검토 프롬프트(`image_review`·
  `start_image_review`·`clip_review`), 재생성 폴백 `"수정 요청: …"`(`reviewed-image-production.ts`), 번들 문서 골격
  (`flow-export-markdown.ts`), 화면 안내문(`FlowInfoClips.tsx`, 띠 %만 임계값).
- 다이제스트 기록(있음): `renders[n].scriptReview.instructionsDigest/instructionsLoadedAt`(기본 "", `server/script-writer.ts` → `source-production`·`script-service` 이벤트), 기획은 `plan-draft-N.json`·
  `source-plan-auto.json` 옆 작은 artifact `instructions-plan.json`(approvedPlanDigest 가 creativePlan JSON 전체라 안에 넣지 않는다),
  이벤트 "지시 파일 <8자리> 적용".
- 상태 API·카드(있음): `server/instructions-status.ts` `instructionsStatus(options)` 가 `loadInstructions()` 와 같은 root 별 로더
  캐시를 쓰므로 생성이 보는 성공본·경고와 같다(첫 로드 실패도 200 + `loaded: false`, 같은 원인 로그 1회). 라우트는 `server/app.ts`
  `createApp(store, pipeline, engine, { instructions })` 의 `GET /api/instructions`(테스트는 임시 폴더·작은 절 목록 주입), 응답 스키마는
  `shared/instructions-status.ts` `InstructionsStatusSchema`(브라우저 안전, fs 없음), 화면은 `src/InstructionsCard.tsx`
  (`InstructionsCard` 가 가져오고 `InstructionsCardView` 는 순수 표시; 연결 설정 창 모델 설정 아래). 테스트
  `tests/instructions-api.test.ts`·`tests/instructions-card.test.tsx`.

## 어느 파일의 어느 절을 고치면 무엇이 바뀌는가

### planning.md

| 절 | 어디서 쓰임(함수) | 바꾸면 무엇이 달라짐 | 토큰·주의 |
|---|---|---|---|
| `PLANNING_OPENING` | server/video-planning.ts videoPlanningInstructions PLANNING_OPENING | 기획 프롬프트 첫 문단(길이 30–60초 선택·말 속도 안내) | — |
| `PLANNING_TARGET_AND_SOLUTION` | server/video-planning.ts videoPlanningInstructions TARGET_AND_SOLUTION | 타겟·해결 경로(solutionPath) 전개 규칙 | — |
| `PLANNING_AUDIENCE` | server/video-planning.ts videoPlanningInstructions AUDIENCE | 시청자 분석 항목 | — |
| `PLANNING_CONCEPT` | server/video-planning.ts videoPlanningInstructions CONCEPT | 영상 콘셉트 설계 규칙 | — |
| `PLANNING_DECISIONS` | server/video-planning.ts videoPlanningInstructions DECISIONS | viewerChange·mutedMessage·stopReason 결정 규칙 | — |
| `PLANNING_COPY` | server/video-planning.ts videoPlanningInstructions COPY | 기획 단계 카피 초안 규칙(구어체·사실 한정·경쟁 후기 경계) | — |
| `COPY_EDITING_OPENING` | server/video-planning.ts prepareVideoPlanning(video_copy_editing) 첫 문단 | 카피 교정 역할·보존 기준 | — |
| `COPY_EDITING_LINE_RULE` | server/video-planning.ts prepareVideoPlanning(video_copy_editing) 둘째 문단 | 줄 수 고정·수정 기록 형식 | 호출 시점 토큰: {{lineCount}} |
| `COPY_EDITING_RHYTHM_NOTE` | server/video-planning.ts prepareVideoPlanning(video_copy_editing) 끝 문단 | 리듬 교정 허용 범위(줄 분할 금지) | — |
| `SOURCE_PLAN_GUARD` | server/source-planning.ts SourcePlanner.plan guard (reference_structure·source_creative_plan·creative_plan_critique 공통 머리) | 자료 기획 3개 프롬프트의 공통 경계 문장 | — |
| `SOURCE_REFERENCE_STRUCTURE` | server/source-planning.ts SourcePlanner.plan reference_structure | 레퍼런스 구조 관찰 지시(관찰/추정/미확인 분리) | — |
| `SOURCE_CREATIVE_PLAN` | server/source-planning.ts SourcePlanner.plan source_creative_plan | 조각·타겟·고객 질문·설득 사슬·퍼널 신호·카드뉴스 등 기획 본문 | 호출 시점 토큰: {{imageCount}} |
| `SOURCE_PLAN_CRITIQUE` | server/source-planning.ts SourcePlanner.plan creative_plan_critique | 기획 검토 기준(근거·다양성·사슬 a0~f) | 호출 시점 토큰: {{imageCount}} {{singleConceptNote}} |
| `SOURCE_PLAN_CRITIQUE_SINGLE_CONCEPT` | server/source-planning.ts SourcePlanner.plan critique imageCount===1 분기 | 광고안 1개일 때 다양성 요구를 끄는 문장 | 원문은 끝에 공백 한 칸이 있다 — 코드가 붙인다. |
| `SOURCE_PLAN_RETRY_HINT` | server/source-planning.ts SourcePlanner.plan critique revise 뒤 feedback 꼬리 | 사슬이 어느 제품에나 맞는다는 지적을 받았을 때 타겟을 바꾸라는 지시 | — |
| `SOURCE_VOICE_ROLE_COMPETITOR` | server/source-planning.ts SourcePlanner.plan DATA.voices[].role (reviewOf=competitor) | 경쟁 제품 후기의 사용 경계(고객 고통·실패·망설임에만, 우리 증거·비방 금지) | DATA 안의 문장(자료 기획 1회당 후기마다 들어감) |
| `SOURCE_VOICE_ROLE_OWN` | server/source-planning.ts SourcePlanner.plan DATA.voices[].role (reviewOf=own) | 우리 제품 후기의 사용 범위(후기에 있는 내용만 넓혀 쓰기) | — |
| `SOURCE_VOICE_ROLE_UNKNOWN` | server/source-planning.ts SourcePlanner.plan DATA.voices[].role (reviewOf 없음) | 출처 불명 고객 말의 사용 경계(증거·일반화 금지) | — |
| `PLANNING_CONTEXT_ASSET_NOTE` | server/video-planning-context.ts videoPlanningContext visualAssets.note (기획·카피 교정·대본 생성·검토 DATA 공통) | 화면 소스가 AI 생성물이며 생성 포장이 실제 라벨을 재현하지 못한다는 안내 | DATA 안의 문장 |

### script.md

| 절 | 어디서 쓰임(함수) | 바꾸면 무엇이 달라짐 | 토큰·주의 |
|---|---|---|---|
| `SCRIPT_OPENING` | server/script-instructions.ts videoScriptInstructions 첫 줄 | 대본 형식·길이 안내 | 호출 시점 토큰: {{seconds}} |
| `SCRIPT_SHAPE` | server/script-instructions.ts videoScriptInstructions SHAPE | 응답 구조 설명(subjects → 소스 → 문장·컷) | — |
| `SCRIPT_PACING_HEAD` | server/script-instructions.ts videoScriptInstructions PACING 첫 문장 | 한 문장 = 한 호흡(목표·한도 글자 수) | 임계값 토큰: {{COPY_BEAT_TARGET_CHARS}} {{COPY_BEAT_MAX_CHARS}} |
| `SCRIPT_PACING_BEATS_DEFAULT` | server/script-instructions.ts videoScriptInstructions PACING 비트 분리(legacy·hybrid) | 상황·반전·감정을 짧은 문장으로 끊는 지시 | — |
| `SCRIPT_PACING_SPEECH_DEFAULT` | server/script-instructions.ts videoScriptInstructions pacing(legacy·hybrid) | 초당 글자 수 목표와 참고 범위 | — |
| `SCRIPT_PACING_CAPACITY` | server/script-instructions.ts videoScriptInstructions table | 글자 수 → 초 환산표 안내 | 호출 시점 토큰: {{table}} |
| `SCRIPT_PACING_TAIL` | server/script-instructions.ts videoScriptInstructions PACING 끝 | 짧은 문장 + 긴 동작 컷 허용, 채우기 금지 | — |
| `SCRIPT_SCENES` | server/script-instructions.ts videoScriptInstructions SCENES | 컷 정의·길이 상한·분할 기준·goal·효과 목록 | 호출 시점 토큰: {{maxCutSec}} {{explainerCutNote}} |
| `SCRIPT_SUBJECTS` | server/script-instructions.ts videoScriptInstructions SUBJECTS | 등장 대상 선언과 traits 전파 규칙 | 호출 시점 토큰: {{hybridSubjectsNote}} |
| `SCRIPT_CLEAN_KEYFRAMES` | server/script-instructions.ts videoScriptInstructions CLEAN KEYFRAMES | 깨끗한 키프레임 규칙(글자·화살표 금지, 빈 공간) | 호출 시점 토큰: {{cleanBaseClause}} |
| `SCRIPT_CLEAN_BASE_DEFAULT` | server/script-instructions.ts videoScriptInstructions CLEAN KEYFRAMES 비-hybrid 분기 | 설명 컷 cleanPrompt 가 3D 기본 장면일 수 있다는 문장 | — |
| `SCRIPT_CLIP_PLAN` | server/script-instructions.ts videoScriptInstructions CLIP PLAN | 클립 3구간 계획(camera·action) 규칙 | — |
| `SCRIPT_CONTINUITY` | server/script-instructions.ts videoScriptInstructions CONTINUITY | 장면 연속성 규칙 | — |
| `SCRIPT_MATCH_KEY_CONTENT` | server/script-instructions.ts videoScriptInstructions MATCH KEY CONTENT | 말한 사실·숫자가 화면에 있어야 한다는 규칙 | — |
| `SCRIPT_STRUCTURE` | server/script-instructions.ts videoScriptInstructions STRUCTURE | 콘셉트 전개·scenePlan 소스 대응 | 호출 시점 토큰: {{structureHybridNote}} |
| `SCRIPT_CHAIN_RULE` | server/script-instructions.ts videoScriptInstructions chainRule(사슬 있음) | 설득 사슬 ①~⑥·결과·행동 문장 규칙 | — |
| `SCRIPT_NO_CHAIN_RULE` | server/script-instructions.ts videoScriptInstructions chainRule(사슬 없음) | 예전 기획의 chainStep bridge 지시 | — |
| `SCRIPT_OFFER_ALLOWED` | server/script-instructions.ts videoScriptInstructions offerAllowed 참 | 오퍼 문장 허용 조건 | — |
| `SCRIPT_OFFER_NONE` | server/script-instructions.ts videoScriptInstructions offerAllowed 거짓 | 오퍼 지어내기 금지 | — |
| `SCRIPT_VOICE` | server/script-instructions.ts videoScriptInstructions VOICE | 내레이션 말투·영문 금지·인물 금지·CTA | — |
| `AD_CAPTION_DIRECTION_RULES` | server/script-instructions.ts · server/video-scripts.ts sceneFromCopyInstructions | 상황별 실제 서체·핵심어·아이콘 선택 | 대본 원문·순서 보존, 별도 유료 호출 없음 |
| `SCRIPT_CAPTIONS` | server/script-instructions.ts videoScriptInstructions CAPTIONS | 자막 길이·끊기 규칙 | 임계값 토큰: {{CAPTION_MIN_CHARS}} {{CAPTION_LINE_MAX_CHARS}} {{CAPTION_MIN_SEC}} {{CAPTION_MAX_SEC}}(ms/1000) — 구절 자막 끊기 코드와 같은 값 |
| `SCRIPT_CALLOUTS` | server/script-instructions.ts videoScriptInstructions CALLOUTS | 콜아웃 개수·word·text·kind·anchor 규칙. **콜아웃 문구 금지어는 여기(생성)와 `REVIEW_RULE_14`(검토)에 프롬프트 지시로 적는다** | 호출 시점 토큰: {{calloutsHybridNote}} · 코드 검사(shared/script-rules.ts)는 word 가 문장 어절인지·영문·숫자만 본다 — 금지어 목록은 코드에 없다(프롬프트 지시만). |
| `SCRIPT_SNAP_ZOOM` | server/script-instructions.ts videoScriptInstructions SNAP ZOOM | zoom_punch 간격 규칙 | — |
| `SCRIPT_LAYOUT` | server/script-instructions.ts videoScriptInstructions LAYOUT | 고정 제목·면책 규칙 | — |
| `SCRIPT_SOURCES` | server/script-instructions.ts videoScriptInstructions SOURCES | 소스 선택 규칙(veo/still/approved_image/card/project_clip) | 호출 시점 토큰: {{approvedImageRule}} {{projectClipRule}} |
| `SCRIPT_SOURCES_APPROVED_IMAGE_LEGACY` | server/script-instructions.ts videoScriptInstructions SOURCES legacy 분기 | 대표 이미지 1회 이상 필수 | — |
| `SCRIPT_SOURCES_PROJECT_CLIP_YES` | server/script-instructions.ts videoScriptInstructions SOURCES hasClips 참 | 촬영본 우선 사용 | — |
| `SCRIPT_SOURCES_PROJECT_CLIP_NO` | server/script-instructions.ts videoScriptInstructions SOURCES hasClips 거짓 | project_clip 금지 | — |
| `SCRIPT_VEO` | server/script-instructions.ts videoScriptInstructions VEO | 클립 수·프롬프트·비율 상한 | — |
| `SCRIPT_CUT_PHASE` | server/script-instructions.ts videoScriptInstructions CUT PHASE | 컷의 phase 선택 규칙 | 호출 시점 토큰: {{cutPhasePolicyNote}} |
| `SCRIPT_CUT_PHASE_DEFAULT_NOTE` | server/script-instructions.ts videoScriptInstructions CUT PHASE 비-hybrid 분기 | early 구간 8초 전체 허용 문장 | — |
| `SCRIPT_STILLS` | server/script-instructions.ts videoScriptInstructions STILLS | 정지 이미지 선언·재사용 규칙 | — |
| `SCRIPT_GRAPHICS_DEFAULT` | server/script-instructions.ts videoScriptInstructions graphicsRule(legacy·immersive) | 모션그래픽 사용 조건·비율 상한 | — |
| `SCRIPT_INFO_CLIPS_LEGACY` | server/script-instructions.ts videoScriptInstructions infoRule(legacy·immersive, Flow) | 설명 컷(explanation·graphicOrder 방식) 규칙 | — |
| `SCRIPT_INFO_CLIPS_NONE` | server/script-instructions.ts videoScriptInstructions infoRule(API 모드) | 설명 컷 불가 문장 | — |
| `SCRIPT_FIELD_HYGIENE` | server/script-instructions.ts videoScriptInstructions FIELD HYGIENE | 빈 칸 규칙·flowPrompt·editInstructions | — |
| `SCRIPT_REFERENCE_NOTE` | server/script-instructions.ts videoScriptInstructions REFERENCE STRUCTURES | 레퍼런스 예시 사용 경계 | — |
| `SCRIPT_CLOSING` | server/script-instructions.ts videoScriptInstructions 마지막 문장 | 사실 한정·레퍼런스는 증거 아님 | — |
| `SCRIPT_FEEDBACK_PREFIX` | server/script-instructions.ts videoScriptInstructions feedback 꼬리 | 직전 위반을 고치라는 머리말 | 호출 시점 토큰: {{feedback}} |
| `SCRIPT_USER_FEEDBACK_PREFIX` | server/script-writer.ts writeVideoScript userFeedback (다시 쓰기 피드백 머리말, 규칙 위반 feedback 앞에 붙음) | 사용자 피드백을 반드시 반영하라는 머리말 | 호출 시점 토큰: {{feedback}} |
| `SCRIPT_SHAPE_EXAMPLE_NOTE` | server/script-instructions.ts videoScriptInstructions JSON SHAPE 뒤 예시 안내(칸 이름은 코드 고정) | 예시 문장은 모양만이며 숫자·제품 낱말은 FACTS 에서 가져오라는 지시 | 뒤의 예시 JSON 은 examples.md SCENE_PLAN_EXAMPLE_SENTENCE |

### hybrid.md

| 절 | 어디서 쓰임(함수) | 바꾸면 무엇이 달라짐 | 토큰·주의 |
|---|---|---|---|
| `HYBRID_SCENE_PLAN` | server/video-planning.ts videoPlanningInstructions HYBRID_SCENE_PLAN | 혼합형 기획 scenePlan 규칙 | — |
| `HYBRID_VISUAL_CONTRACT` | server/video-planning.ts videoPlanningInstructions HYBRID_VISUAL_CONTRACT | 혼합형 시각 계약(실사/설명 세계 분리, 엔딩) | "at most 3 seconds" 는 {{HYBRID_ENDING_IMAGE_MAX_SEC}} 토큰으로. |
| `EXPLAINER_GRAMMAR` | server/hybrid-script-instructions.ts EXPLAINER_GRAMMAR | 설명 세계 문법 R1~R9(R2 인포그래픽 라벨 = infoLines·FACTS 숫자만, R8 강조색 출처 = 브랜드·포장, R3 윤곽선 red) | 임계값 토큰: {{EXPLAINER_CUT_MAX_SEC}} {{EXPLAINER_HOLD_SEC}} {{SILENCE_GAP_MAX_SEC}} · **강조색 고정**은 R8 의 "from the brand or packaging" 과 HYBRID_PLANNING_RULES·HYBRID_SCRIPT_RULES 의 같은 문장을 함께 바꾼다(영문 색 이름 — 코드 검사 COLOR_WORDS 가 한글을 모름). 윤곽 red 는 R3 와 flow.md EMPHASIS_OUTLINE 두 곳. R7 "1–2 seconds" 는 리터럴. |
| `HYBRID_PLANNING_RULES` | server/hybrid-script-instructions.ts HYBRID_PLANNING_RULES | 혼합형 기획 explainerScene 규칙(끝에 {{@EXPLAINER_GRAMMAR}}; 강조색 2개를 브랜드·포장에서 고르라는 문장 포함) | 임계값 토큰: {{HYBRID_ENDING_IMAGE_MAX_SEC}} · 강조색 고정은 EXPLAINER_GRAMMAR 의 주의와 같다. |
| `HYBRID_SCRIPT_RULES` | server/hybrid-script-instructions.ts HYBRID_SCRIPT_RULES | 혼합형 제작 계약(비트→소스, 두 기준(TWO ANCHORS 의 강조색 문장), 설명 장면, 컷, 글자, 콜아웃, 엔딩) | 호출 시점 토큰: {{hybridExample}} · 임계값 토큰: {{EXPLAINER_MAX_PERCENT}} {{EXPLAINER_CUT_MAX_SEC}} {{EXPLAINER_HOLD_SEC}} {{CUT_MAX_SEC}} {{HYBRID_ENDING_IMAGE_MAX_SEC}} · 끝 예시 JSON 은 examples.md HYBRID_EXPLAINER_EXAMPLE 을 코드가 stringify 해 채운다. 강조색 고정은 EXPLAINER_GRAMMAR 의 주의와 같다. |
| `HYBRID_REVIEW_RULES` | server/hybrid-script-instructions.ts HYBRID_REVIEW_RULES → server/video-scripts.ts reviewVideoScript 규칙 1c | 검토 규칙 1c(혼합형 계약 위반 a~g) | — |
| `HYBRID_REVIEW_GRAMMAR_INTRO` | server/video-scripts.ts reviewVideoScript 규칙 15(hybrid) 첫 줄 | 설명 세계 문법 검토 지시(뒤에 {{@EXPLAINER_GRAMMAR}} 를 코드가 붙임) | — |
| `HYBRID_INFO_RULE` | server/script-instructions.ts videoScriptInstructions HYBRID_INFO_RULE | 혼합형 INFO CLIPS 절 | — |
| `HYBRID_SCENES_EXPLAINER_NOTE` | server/script-instructions.ts videoScriptInstructions SCENES hybrid 분기 | 설명 컷 2–N초 문장 | 원문 앞에 공백 한 칸 — 코드가 붙인다. |
| `HYBRID_SUBJECTS_NOTE` | server/script-instructions.ts videoScriptInstructions SUBJECTS hybrid 분기 | 설명 물체도 subjects 라는 문장 | — |
| `HYBRID_CLEAN_BASE_CLAUSE` | server/script-instructions.ts videoScriptInstructions CLEAN KEYFRAMES hybrid 분기 | cleanPrompt 가 설명 세계 기본 장면이라는 구절 | — |
| `HYBRID_STRUCTURE_NOTE` | server/script-instructions.ts videoScriptInstructions STRUCTURE hybrid 분기 | graphic 장면 없음 구절 | — |
| `HYBRID_CALLOUTS_NOTE` | server/script-instructions.ts videoScriptInstructions CALLOUTS hybrid 분기 | 콜아웃은 실사 문장에만 | — |
| `HYBRID_SOURCES_APPROVED_IMAGE` | server/script-instructions.ts videoScriptInstructions SOURCES hybrid 분기 | 대표 이미지 선택적·엔딩 N초 이내 | — |
| `HYBRID_CUT_PHASE_NOTE` | server/script-instructions.ts videoScriptInstructions CUT PHASE hybrid 분기 | 설명 컷은 한 구간·8초 보유 금지 | — |
| `HYBRID_GRAPHICS_RULE` | server/script-instructions.ts videoScriptInstructions graphicsRule(hybrid) | 모션그래픽 금지 문장 | — |

### immersive.md

| 절 | 어디서 쓰임(함수) | 바꾸면 무엇이 달라짐 | 토큰·주의 |
|---|---|---|---|
| `IMMERSIVE_SCENE_PLAN` | server/video-planning.ts videoPlanningInstructions IMMERSIVE_SCENE_PLAN | immersive 기획 scenePlan 규칙 | — |
| `IMMERSIVE_VISUAL_CONTRACT` | server/video-planning.ts videoPlanningInstructions IMMERSIVE_VISUAL_CONTRACT | immersive 시각 계약(아이보리·올리브·골드) | — |
| `EXPLANATION_PLANNING_RULES` | server/immersive-script-instructions.ts explanationPlanningRules → video-planning(immersive) | 설명 설계(entities·beats·annotations) 기획 규칙 | — |
| `EXPLANATION_SCRIPT_RULES` | server/immersive-script-instructions.ts explanationScriptRules → 검토 규칙 16, IMMERSIVE_SCRIPT_RULES 포함 | 설명 설계 대본 반영 규칙(actionSync·narrationCue) | — |
| `IMMERSIVE_SCRIPT_RULES` | server/immersive-script-instructions.ts immersiveScriptRules → 대본(immersive)·검토 규칙 15 | 입체 설명 제작 계약(끝에 {{@EXPLANATION_SCRIPT_RULES}}) | 원문은 끝에 줄바꿈 하나가 있다 — 코드가 붙인다. |
| `IMMERSIVE_REVIEW_CONTRACT_INTRO` | server/video-scripts.ts reviewVideoScript 규칙 15(immersive) 첫 줄 | 입체 설명 계약 검토 지시(뒤에 {{@IMMERSIVE_SCRIPT_RULES}}) | — |
| `IMMERSIVE_REVIEW_EXPLANATION` | server/video-scripts.ts reviewVideoScript 규칙 16 | 설명 설계 검토 지시(뒤에 {{@EXPLANATION_SCRIPT_RULES}}) | — |
| `IMMERSIVE_PACING_SPEECH` | server/script-instructions.ts videoScriptInstructions pacing(immersive) | 초당 6–8자 추정 안내 | — |
| `IMMERSIVE_PACING_BEATS` | server/script-instructions.ts videoScriptInstructions PACING 비트(immersive) | 한 사건 한 생각 유지 문장 | — |
| `IMMERSIVE_SOURCES_APPROVED_IMAGE` | server/script-instructions.ts videoScriptInstructions SOURCES immersive 분기 | 대표 이미지 선택적·INFO 엔딩 대체 | — |

### review.md

| 절 | 어디서 쓰임(함수) | 바꾸면 무엇이 달라짐 | 토큰·주의 |
|---|---|---|---|
| `REVIEW_OPENING` | server/video-scripts.ts reviewVideoScript 첫 문단 | 검토자 역할·듣고 보는 방식 | — |
| `REVIEW_RETURN_RULE` | server/video-scripts.ts reviewVideoScript 둘째 문단 | pass/revise 응답 규칙 | — |
| `REVIEW_RHYTHM_IMMERSIVE` | server/video-scripts.ts reviewVideoScript 규칙 1b(immersive) | natural_v1 리듬 검토 | 임계값 토큰: {{COPY_BEAT_TARGET_CHARS}} |
| `REVIEW_RHYTHM_DEFAULT` | server/video-scripts.ts reviewVideoScript 규칙 1b(legacy·hybrid) | 짧은 호흡 리듬 검토(약 N자) | "about 26 characters" 는 {{COPY_BEAT_TARGET_CHARS}} 토큰으로. |
| `REVIEW_RULE_1` | server/video-scripts.ts reviewVideoScript 규칙 1 | 검토 규칙 1 — 자연스러운 한국어·메모체 금지·AI 말투(KOREAN AI-TELL RULES 적용) | — |
| `REVIEW_RULE_2` | server/video-scripts.ts reviewVideoScript 규칙 2 | 검토 규칙 2 — 설득(stopReason·mutedMessage·viewerChange·scenePlan·solutionPath 과정, 후크 약화 금지) | — |
| `REVIEW_RULE_3` | server/video-scripts.ts reviewVideoScript 규칙 3 | 검토 규칙 3 — 의도·의미 보존(가설·콘셉트, 카피 교정 이력, 오퍼 허용 조건) | — |
| `REVIEW_RULE_4` | server/video-scripts.ts reviewVideoScript 규칙 4 | 검토 규칙 4 — FACTS 밖 주장 금지(효능·후기·가격·기한·수상·성분·외형) | — |
| `REVIEW_RULE_5` | server/video-scripts.ts reviewVideoScript 규칙 5 | 검토 규칙 5 — 지어낸 인물 이름 금지 | — |
| `REVIEW_RULE_6` | server/video-scripts.ts reviewVideoScript 규칙 6 | 검토 규칙 6 — 출처·ID·예:·FACT 낭독 금지, 내레이션 영문 금지(한글 표기) | — |
| `REVIEW_RULE_7` | server/video-scripts.ts reviewVideoScript 규칙 7 | 검토 규칙 7 — 자막·글줄과 내레이션 일치 | — |
| `REVIEW_RULE_8` | server/video-scripts.ts reviewVideoScript 규칙 8 | 검토 규칙 8 — 같은 사실 3회 이상 반복 금지 | — |
| `REVIEW_RULE_8B` | server/video-scripts.ts reviewVideoScript 규칙 8b | 검토 규칙 8b — 설득 사슬(①~⑥·결과·행동 순서, ⑥은 ⑤에 없는 세부, 사슬 밖 사실 금지, 설명서 말투) | — |
| `REVIEW_RULE_9` | server/video-scripts.ts reviewVideoScript 규칙 9 | 검토 규칙 9 — 핵심 내용 일치(말한 숫자·기능·행사가 그 문장의 컷에 보임) | — |
| `REVIEW_RULE_10` | server/video-scripts.ts reviewVideoScript 규칙 10 | 검토 규칙 10 — 시각 연속성(인물·옷·장소·소품·제품, I1~I3 설명 컷 취급) | — |
| `REVIEW_RULE_11` | server/video-scripts.ts reviewVideoScript 규칙 11 | 검토 규칙 11 — 자연스러운 강조(숫자·질문 자막, 같은 사실 카드 반복 금지, 효과 할당량 없음) | — |
| `REVIEW_RULE_12` | server/video-scripts.ts reviewVideoScript 규칙 12 | 검토 규칙 12 — 소스 정직성(approved_image 는 완성 카드일 수 있음, 없는 라벨 요구 금지) | — |
| `REVIEW_RULE_13` | server/video-scripts.ts reviewVideoScript 규칙 13 | 검토 규칙 13 — 소스 다양성(같은 사진 재노출·유사 정지 이미지) | — |
| `REVIEW_RULE_14` | server/video-scripts.ts reviewVideoScript 규칙 14 | 검토 규칙 14 — 장면 계획·콜아웃(word 가 문장에 있고 text 가 그 순간의 말, 컷 phase↔plan, goal 은 관계·변화, 이미지 프롬프트의 subjects 낱말). **콜아웃 문구 금지어의 검토 자리** | — |

### copy.md

| 절 | 어디서 쓰임(함수) | 바꾸면 무엇이 달라짐 | 토큰·주의 |
|---|---|---|---|
| `KOREAN_COPY_POLISH_RULES` | server/copy-instructions.ts koreanCopyPolishRules (카피 교정·대본 검토) | 한국어 AI 말투 교정 규칙 A~F·GUARDS | — |
| `KOREAN_COPY_RHYTHM_RULES` | server/copy-instructions.ts koreanCopyRhythmRules → copyRhythmInstruction(false) (legacy_rhythm) | 짧은 호흡 리듬 규칙 1~4 + 예시 | 임계값 토큰: {{COPY_BEAT_TARGET_CHARS}} {{COPY_BEAT_MAX_CHARS}} |
| `NATURAL_COPY_RHYTHM_RULES` | server/copy-instructions.ts naturalCopyRhythmRules → copyRhythmInstruction(true) (natural_v1) | 자연 문장 규칙 1~6 | 원문은 끝에 줄바꿈 하나가 있고 26/40 은 토큰으로 — 코드가 붙인다. |

### copy-first.md

카피 먼저 흐름(2026-10-08 사용자 결정 "말 먼저, 그림은 나중, 규칙은 필요한 것만"): 편지 1 이 문장(사슬 단계 + 글)만 쓰고, 앱이 길이를 초당 `NATURAL_CHARS_PER_SEC`자로 추정해
통과시킨 뒤 편지 2 가 확정 문장을 고정 입력으로 받아 컷·장면·Veo 계획·설명 장면·INFO 문구만 쓴다. **혼합형 정책(`hybrid_explainer_v1`)의 새 대본·다시 쓰기에만** 쓰이며
예전 흐름(script.md 등)의 프롬프트·골든은 그대로다. 코드: `server/copy-writer.ts`(편지 1·문장 고정 `pinToCopy`·산출물 `video-copy-<n>-<회차>.json`), `server/video-scripts.ts`
`generateVideoScript` 의 `copyLines` 옵션(편지 2), `server/script-writer.ts`(두 편지를 잇는 흐름·검토 기록), 규칙 검사 `shared/script-rules-v2.ts`(코드). 외부 카피(`POST …/script/rewrite` 본문 `copy`)는 편지 1 을 건너뛴다.

| 절 | 어디서 쓰임(함수) | 바꾸면 무엇이 달라짐 | 토큰·주의 |
|---|---|---|---|
| `COPY_WRITE_RULES` | server/copy-writer.ts generateVideoCopy (편지 1) | 카피라이터 역할 + 규칙 8개(사슬 순서·사실 한정·한 호흡·문장 수와 읽기 시간·requirement 한 문장·구어체·반복·cta 동사) | 임계값 토큰: {{COPY_BEAT_MAX_CHARS}} {{COPY_BEAT_TARGET_CHARS}} {{COPY_LINES_MIN}} {{COPY_LINES_MAX}} {{NATURAL_CHARS_PER_SEC}}. 규칙 8개는 코드(`copyProblems`)도 같은 기준으로 검사하므로 문구만 바꾸면 모델과 검사가 어긋날 수 있다. |
| `COPY_SHAPE_EXAMPLE` | server/copy-writer.ts generateVideoCopy (응답 모양 예시 JSON) | 편지 1 응답 예시 8문장(모양 참고; 숫자·낱말은 FACTS 에서) | JSON 절 — 로드 때 파싱을 검증하고 코드가 `JSON.stringify` 로 끼운다. 키는 `lines[{chainStep, text}]`(코드 고정). |
| `COPY_FEEDBACK_HEAD` | server/copy-writer.ts generateVideoCopy 피드백 머리말 | 카피 다시 쓰기 머리말(규칙 위반 목록 + 추정 발화 초 / 사용자 피드백) | 호출 시점 토큰: {{feedback}} |
| `SCENE_FROM_COPY_RULES` | server/video-scripts.ts sceneFromCopyInstructions (편지 2) | 확정 문장 고정 + 장면 규칙만(두 세계·설명 장면 문법·클립 구간·정지 이미지 합계·첫/마지막 컷 실사·앵커·컷 필드·콜아웃) | 끝에 `{{@EXPLAINER_GRAMMAR}}`(hybrid.md)를 끼운다. 임계값 토큰은 위와 코드 상수(`PHASE_TABLE`·`VEO_SHOTS_MAX` 등). 문장 고정은 프롬프트로 요구하고 어긋나면 코드가 원문으로 되돌려 repairs 에 "N번째 문장을 카피 원문으로 되돌림"을 적는다. 응답 칸 이름(JSON SHAPE)은 코드. |

### flow.md

| 절 | 어디서 쓰임(함수) | 바꾸면 무엇이 달라짐 | 토큰·주의 |
|---|---|---|---|
| `CLEAN_KEYFRAME_TAIL` | shared/veo-prompt.ts CLEAN_KEYFRAME_TAIL (시작·정지·CLEAN 이미지 꼬리) | 글자·화살표·숫자·라벨 금지와 빈 공간 | — |
| `CLIP_PLAN_TAIL` | shared/veo-prompt.ts CLIP_PLAN_TAIL | 계획 있는 Veo 클립 고정 꼬리 | — |
| `CLIP_LEGACY_TAIL` | shared/veo-prompt.ts LEGACY_TAIL | 계획 없는 예전 클립 꼬리(저장 대본 호환) | — |
| `HYBRID_LIVE_TAIL` | shared/veo-prompt.ts clipPrompt liveAction (texts.HYBRID_LIVE_TAIL, 혼합형 실사 클립) | 실사 클립 꼬리(사람·실제 장소·클레이 모형 아님, 얼굴 프레임 안·휴대폰 화면 꺼짐) | 계약 표의 hybrid.md 에서 flow.md 로 옮김(Flow 글과 함께 읽힘) |
| `EXPLAINER_WORLD` | shared/flow-info-prompts.ts (서버에서만 조립, 화면은 /api/instructions·flow-export 로 받음) EXPLAINER_WORLD | 설명 세계 재질·사람 없음 문장(warm ivory 바닥, 노출 한 단계 낮춤) | — |
| `EXPLAINER_TEXT_RULE` | shared/flow-info-prompts.ts (서버에서만 조립, 화면은 /api/instructions·flow-export 로 받음) EXPLAINER_TEXT_RULE | 설명 세계 글자 금지 문장 | — |
| `EXPLAINER_COLOR_ACCENT1` | shared/flow-info-prompts.ts (서버에서만 조립, 화면은 /api/instructions·flow-export 로 받음) COLOR_WORDS.accent1 | 강조색 1 **자리말**(실제 색 이름은 대본의 explainerAnchor 에서 옴) | 특정 색으로 고정하려면 hybrid.md EXPLAINER_GRAMMAR R8·HYBRID_PLANNING_RULES·HYBRID_SCRIPT_RULES(TWO ANCHORS)의 "from the brand or packaging" 문장을 함께 바꾼다(영문 색 이름). 여기에 색을 적어도 프롬프트 뜻만 어긋난다. |
| `EXPLAINER_COLOR_ACCENT2` | shared/flow-info-prompts.ts (서버에서만 조립, 화면은 /api/instructions·flow-export 로 받음) COLOR_WORDS.accent2 | 강조색 2 자리말(실제 색 이름은 대본의 explainerAnchor 에서 옴) | EXPLAINER_COLOR_ACCENT1 과 같다. |
| `EXPLAINER_COLOR_NEUTRAL` | shared/flow-info-prompts.ts (서버에서만 조립, 화면은 /api/instructions·flow-export 로 받음) COLOR_WORDS.neutral | 중립색 표현 | — |
| `EMPHASIS_COLOR_CODE` | shared/flow-info-prompts.ts (서버에서만 조립, 화면은 /api/instructions·flow-export 로 받음) emphasisText color_code | 색 구분 강조 문장 | 호출 시점 토큰: {{name}} {{color}} |
| `EMPHASIS_OUTLINE` | shared/flow-info-prompts.ts (서버에서만 조립, 화면은 /api/instructions·flow-export 로 받음) emphasisText outline | 빨간 외곽선 강조 문장 | 호출 시점 토큰: {{name}} · 윤곽색 red 는 hybrid.md EXPLAINER_GRAMMAR R3 에도 있다(함께 바꿀 것). |
| `EMPHASIS_GLOW_LINE` | shared/flow-info-prompts.ts (서버에서만 조립, 화면은 /api/instructions·flow-export 로 받음) emphasisText glow_line | 흰 발광선 강조 문장(물체 표면을 따라감, 나선·글자 모양 금지) | 호출 시점 토큰: {{name}} |
| `EMPHASIS_GHOST_OBJECT` | shared/flow-info-prompts.ts (서버에서만 조립, 화면은 /api/instructions·flow-export 로 받음) emphasisText ghost_object | 반투명 비유 물체 강조 문장 | 호출 시점 토큰: {{name}} |
| `HYBRID_CLEAN_OBJECTS` | shared/flow-info-prompts.ts (서버에서만 조립, 화면은 /api/instructions·flow-export 로 받음) hybridCleanPrompt | 물체 목록 머리말 | 호출 시점 토큰: {{objects}} |
| `HYBRID_CLEAN_START_STATE` | shared/flow-info-prompts.ts (서버에서만 조립, 화면은 /api/instructions·flow-export 로 받음) hybridCleanPrompt | 시작 상태·빈 공간·자막 자리 문장(비교 장면은 두 모형이 겉으로 똑같은 상태) | — |
| `HYBRID_ANCHOR_LINE` | shared/flow-info-prompts.ts (서버에서만 조립, 화면은 /api/instructions·flow-export 로 받음) anchorLine | 설명 세계 기준·강조색 소개 줄 | 호출 시점 토큰: {{explainerAnchor}} |
| `HYBRID_OVERLAY_BASE` | shared/flow-info-prompts.ts (서버에서만 조립, 화면은 /api/instructions·flow-export 로 받음) hybridOverlayPrompt | CLEAN 과 같은 장면 유지 문장 | — |
| `HYBRID_OVERLAY_ACTIONS` | shared/flow-info-prompts.ts (서버에서만 조립, 화면은 /api/instructions·flow-export 로 받음) hybridOverlayPrompt | 동작 끝난 상태 머리말 | 호출 시점 토큰: {{actions}} |
| `HYBRID_OVERLAY_EMPHASIS` | shared/flow-info-prompts.ts (서버에서만 조립, 화면은 /api/instructions·flow-export 로 받음) hybridOverlayPrompt | 강조 목록 머리말 | 호출 시점 토큰: {{emphasis}} |
| `HYBRID_OVERLAY_NO_EMPHASIS` | shared/flow-info-prompts.ts (서버에서만 조립, 화면은 /api/instructions·flow-export 로 받음) hybridOverlayPrompt | 강조 없음 문장 | — |
| `HYBRID_OVERLAY_NO_FLAT` | shared/flow-info-prompts.ts (서버에서만 조립, 화면은 /api/instructions·flow-export 로 받음) hybridOverlayPrompt | 평면 그래픽 금지·구도 유지(infoLines 없는 예전 설명 장면) | — |
| `HYBRID_OVERLAY_INFOGRAPHIC` | shared/flow-info-prompts.ts (서버에서만 조립, 화면은 /api/instructions·flow-export 로 받음) hybridOverlayPrompt (infoLines 있는 설명 장면) | 튜토리얼식 인포그래픽 지시(굵은 화살표·치수선·강조 링·큰 한글 라벨·숫자, 중간 띠, 브랜드 2색+빨강) | 임계값 토큰: {{INFO_GRAPHIC_BAND_TOP}} {{INFO_GRAPHIC_BAND_BOTTOM}} · 2026-10-08 사용자 결정(인포그래픽은 앱이 아니라 Flow INFO 이미지 안에). |
| `HYBRID_OVERLAY_LABELS` | shared/flow-info-prompts.ts (서버에서만 조립, 화면은 /api/instructions·flow-export 로 받음) hybridOverlayPrompt (infoLines 있는 설명 장면) | INFO 에 찍을 정확한 문구 머리말(그 밖의 글자 금지) | 호출 시점 토큰: {{infoLines}} · 업로드 대조는 server/flow-import.ts infoTextProblems. |
| `HYBRID_MOTION_OPENING` | shared/flow-info-prompts.ts (서버에서만 조립, 화면은 /api/instructions·flow-export 로 받음) hybridMotionPrompt | CLEAN→INFO 한 샷 문장 | — |
| `HYBRID_MOTION_ACTIONS` | shared/flow-info-prompts.ts (서버에서만 조립, 화면은 /api/instructions·flow-export 로 받음) hybridMotionPrompt | 동작 순서 머리말 | 호출 시점 토큰: {{actions}} |
| `HYBRID_MOTION_EMPHASIS` | shared/flow-info-prompts.ts (서버에서만 조립, 화면은 /api/instructions·flow-export 로 받음) hybridMotionPrompt | 강조 등장 순서 머리말 | 호출 시점 토큰: {{emphasis}} |
| `HYBRID_MOTION_NO_EMPHASIS` | shared/flow-info-prompts.ts (서버에서만 조립, 화면은 /api/instructions·flow-export 로 받음) hybridMotionPrompt | 강조 없음 문장 | — |
| `HYBRID_MOTION_CAMERA` | shared/flow-info-prompts.ts (서버에서만 조립, 화면은 /api/instructions·flow-export 로 받음) hybridMotionPrompt | 카메라 이동·0.4초 정지·페이드 금지·마지막 1초 변형 금지 | — |
| `HYBRID_MOTION_TEXT` | shared/flow-info-prompts.ts (서버에서만 조립, 화면은 /api/instructions·flow-export 로 받음) hybridMotionPrompt | 마지막 프레임까지 글자 금지(뒤에 {{@EXPLAINER_TEXT_RULE}}; infoLines 없는 예전 설명 장면) | — |
| `HYBRID_MOTION_LABELS` | shared/flow-info-prompts.ts (서버에서만 조립, 화면은 /api/instructions·flow-export 로 받음) hybridMotionPrompt (infoLines 있는 설명 장면) | 라벨·숫자가 둘째 구간부터 완성형으로 나타나 끝까지 유지, 그 밖의 글자 금지 | 호출 시점 토큰: {{infoLines}} · "약 3초"는 코드 고정 구간표(CLIP_PHASE_RANGES_MS mid 시작)와 맞춘 리터럴. |
| `HYBRID_MOTION_LENGTH` | shared/flow-info-prompts.ts (서버에서만 조립, 화면은 /api/instructions·flow-export 로 받음) hybridMotionPrompt | 8초·9:16·말 없음 | — |
| `VERTICAL_FRAME` | shared/flow-info-prompts.ts (서버에서만 조립, 화면은 /api/instructions·flow-export 로 받음) "Vertical 9:16." | 세로 비율 문장 | — |
| `IMMERSIVE_PALETTE` | shared/flow-info-prompts.ts (서버에서만 조립, 화면은 /api/instructions·flow-export 로 받음) IMMERSIVE_PALETTE (server/source-image-style.ts 도 사용) | 아이보리·올리브·골드 시각 체계 | — |
| `IMMERSIVE_TEXT_RULE` | shared/flow-info-prompts.ts (서버에서만 조립, 화면은 /api/instructions·flow-export 로 받음) TEXT_RULE | immersive 글자 금지 | — |
| `IMMERSIVE_BAND` | shared/flow-info-prompts.ts (서버에서만 조립, 화면은 /api/instructions·flow-export 로 받음) BAND | 중간 띠(위/아래 %) 문장 | — |
| `IMMERSIVE_INFO_LABELS` | shared/flow-info-prompts.ts (서버에서만 조립, 화면은 /api/instructions·flow-export 로 받음) infoLabelsRule | 완성 라벨 렌더 지시 | 호출 시점 토큰: {{labels}} |
| `IMMERSIVE_CLEAN_DIMENSIONAL` | shared/flow-info-prompts.ts (서버에서만 조립, 화면은 /api/instructions·flow-export 로 받음) immersiveCleanPrompt | 입체 설명 첫 프레임 문장 | — |
| `IMMERSIVE_CLEAN_ESTABLISH` | shared/flow-info-prompts.ts (서버에서만 조립, 화면은 /api/instructions·flow-export 로 받음) immersiveCleanPrompt | 분리·비교 대상 설정 문장 | — |
| `IMMERSIVE_CLEAN_FORM` | shared/flow-info-prompts.ts (서버에서만 조립, 화면은 /api/instructions·flow-export 로 받음) immersiveCleanPrompt | 제품 형태 보존 문장 | — |
| `IMMERSIVE_OVERLAY_BASE` | shared/flow-info-prompts.ts (서버에서만 조립, 화면은 /api/instructions·flow-export 로 받음) immersiveOverlayPrompt | 같은 3D 장면·최종 상태 문장 | — |
| `IMMERSIVE_OVERLAY_CAMERA` | shared/flow-info-prompts.ts (서버에서만 조립, 화면은 /api/instructions·flow-export 로 받음) immersiveOverlayPrompt | 최종 카메라 시점 줄 | 호출 시점 토큰: {{camera}} |
| `IMMERSIVE_OVERLAY_STATE_INTRO` | shared/flow-info-prompts.ts (서버에서만 조립, 화면은 /api/instructions·flow-export 로 받음) immersiveOverlayPrompt | 최종 상태 목록 머리말 | — |
| `IMMERSIVE_OVERLAY_RELATION` | shared/flow-info-prompts.ts (서버에서만 조립, 화면은 /api/instructions·flow-export 로 받음) immersiveOverlayPrompt | 절개·분리·비교·흐름 문장 | — |
| `IMMERSIVE_OVERLAY_IDENTITY` | shared/flow-info-prompts.ts (서버에서만 조립, 화면은 /api/instructions·flow-export 로 받음) immersiveOverlayPrompt | 정체성 유지·혼합 분리 금지 | — |
| `IMMERSIVE_MOTION_OPENING` | shared/flow-info-prompts.ts (서버에서만 조립, 화면은 /api/instructions·flow-export 로 받음) immersiveMotionPrompt | CLEAN→INFO 연속 설명 문장 | — |
| `IMMERSIVE_MOTION_STAGES` | shared/flow-info-prompts.ts (서버에서만 조립, 화면은 /api/instructions·flow-export 로 받음) immersiveMotionPrompt | 단계 애니메이션 머리말 | 호출 시점 토큰: {{stages}} |
| `IMMERSIVE_MOTION_OBJECTS` | shared/flow-info-prompts.ts (서버에서만 조립, 화면은 /api/instructions·flow-export 로 받음) immersiveMotionPrompt | 물체 동작·카메라 조정 문장 | — |
| `IMMERSIVE_MOTION_PRESERVE` | shared/flow-info-prompts.ts (서버에서만 조립, 화면은 /api/instructions·flow-export 로 받음) immersiveMotionPrompt | 제품·재질 보존 문장 | — |
| `IMMERSIVE_MOTION_BEATS` | shared/flow-info-prompts.ts (서버에서만 조립, 화면은 /api/instructions·flow-export 로 받음) immersiveMotionPrompt | 비트 순서·after 상태 유지 | — |
| `IMMERSIVE_MOTION_LABELS` | shared/flow-info-prompts.ts (서버에서만 조립, 화면은 /api/instructions·flow-export 로 받음) immersiveMotionPrompt | 라벨 보존 지시 | 호출 시점 토큰: {{labels}} |
| `IMMERSIVE_MOTION_LENGTH` | shared/flow-info-prompts.ts (서버에서만 조립, 화면은 /api/instructions·flow-export 로 받음) immersiveMotionPrompt | 8초·말 없음 | — |
| `EXPLANATION_CONTRACT_INTRO` | shared/explanation-prompt.ts explanationPrompt 첫 문단 | 설명 계약 사용 지시(뒤에 <explanation-plan> JSON 은 코드) | — |
| `INFO_CLEAN_REFERENCE` | shared/flow-info-prompts.ts (서버에서만 조립, 화면은 /api/instructions·flow-export 로 받음) infoCleanPrompt(예전 R3) | 참조 사진 사용 문장 | — |
| `INFO_CLEAN_FORMAT` | shared/flow-info-prompts.ts (서버에서만 조립, 화면은 /api/instructions·flow-export 로 받음) infoCleanPrompt(예전 R3) | 사진·9:16·로고 없음 | — |
| `INFO_OVERLAY_BASE` | shared/flow-info-prompts.ts (서버에서만 조립, 화면은 /api/instructions·flow-export 로 받음) infoOverlayPrompt(예전 R4) | 원본 사진 유지 문장 | — |
| `INFO_OVERLAY_ORDER_INTRO` | shared/flow-info-prompts.ts (서버에서만 조립, 화면은 /api/instructions·flow-export 로 받음) infoOverlayPrompt(예전 R4) | 그래픽 순서 머리말 | — |
| `INFO_OVERLAY_NO_TEXT` | shared/flow-info-prompts.ts (서버에서만 조립, 화면은 /api/instructions·flow-export 로 받음) infoOverlayPrompt(예전 R4) | ABSOLUTELY NO TEXT | — |
| `INFO_OVERLAY_STYLE` | shared/flow-info-prompts.ts (서버에서만 조립, 화면은 /api/instructions·flow-export 로 받음) infoOverlayPrompt(예전 R4) | 굵고 발광하는 그래픽 스타일 | — |
| `INFO_OVERLAY_BAND` | shared/flow-info-prompts.ts (서버에서만 조립, 화면은 /api/instructions·flow-export 로 받음) infoOverlayPrompt(예전 R4) | 중간 띠 % 문장 | — |
| `INFO_OVERLAY_COLORS` | shared/flow-info-prompts.ts (서버에서만 조립, 화면은 /api/instructions·flow-export 로 받음) infoOverlayPrompt(예전 R4) | 강조색 2~3개·추가 요소 금지 | — |
| `INFO_LINES_BASE` | shared/flow-info-prompts.ts (서버에서만 조립, 화면은 /api/instructions·flow-export 로 받음) legacyInfoOverlayPrompt | infoLines 방식 원본 유지 | — |
| `INFO_LINES_INTRO` | shared/flow-info-prompts.ts (서버에서만 조립, 화면은 /api/instructions·flow-export 로 받음) legacyInfoOverlayPrompt | 지정 문구 머리말 | — |
| `INFO_LINES_STYLE` | shared/flow-info-prompts.ts (서버에서만 조립, 화면은 /api/instructions·flow-export 로 받음) legacyInfoOverlayPrompt | 큰 글자·9:16 | — |
| `INFO_LINES_BAND` | shared/flow-info-prompts.ts (서버에서만 조립, 화면은 /api/instructions·flow-export 로 받음) legacyInfoOverlayPrompt | 중간 띠 % 문장(글자 포함) | — |
| `INFO_MOTION_LEGACY_TAIL` | shared/flow-info-prompts.ts (서버에서만 조립, 화면은 /api/instructions·flow-export 로 받음) infoMotionPrompt(계획 없음) | 저장 motionPrompt 뒤 예전 문장 | — |
| `INFO_MOTION_OPENING` | shared/flow-info-prompts.ts (서버에서만 조립, 화면은 /api/instructions·flow-export 로 받음) infoMotionPrompt(R5) | 첫·마지막 프레임 문장 | — |
| `INFO_MOTION_ORDER` | shared/flow-info-prompts.ts (서버에서만 조립, 화면은 /api/instructions·flow-export 로 받음) infoMotionPrompt(R5) | 그래픽 등장 순서 머리말 | 호출 시점 토큰: {{order}} |
| `INFO_MOTION_CAMERA` | shared/flow-info-prompts.ts (서버에서만 조립, 화면은 /api/instructions·flow-export 로 받음) infoMotionPrompt(R5) | 연속 카메라·0.4초·페이드 금지 | — |
| `INFO_MOTION_TEXT` | shared/flow-info-prompts.ts (서버에서만 조립, 화면은 /api/instructions·flow-export 로 받음) infoMotionPrompt(R5) | 글자 금지·8초·립싱크 없음 | — |
| `START_IMAGE_TAIL` | server/start-image-production.ts startImagePrompt | 시작 이미지 고정 문장(9:16·같은 인물·라벨 보존) | — |
| `STILL_IMAGE_TAIL` | server/still-production.ts stillPrompt | 정지 이미지 고정 문장 | — |
| `SCENE_IMAGE_REFERENCE_1` | server/scene-image-references.ts sceneImagePrompt | 참조 이미지 1 설명 | — |
| `SCENE_IMAGE_REFERENCE_2` | server/scene-image-references.ts sceneImagePrompt(참조 2개) | 참조 이미지 2 설명 | 원문 앞에 공백 한 칸 — 코드가 붙인다. |
| `SCENE_IMAGE_REFERENCE_NONE` | server/scene-image-references.ts sceneImagePrompt(참조 1개) | 참조 2 없을 때 일관성 문장 | 원문 앞에 공백 한 칸 — 코드가 붙인다. |
| `SOURCE_IMAGE_IMMERSIVE_NOTE` | server/source-image-style.ts sourceImagePrompt | immersive 대표 이미지·카드 보정 문장 | — |
| `FLOW_CHECKLIST` | shared/flow-mode.ts CHECKLIST (한 줄 = 한 단계) | Flow 번들 공통 순서 8단계 | 호출 시점 토큰: {{model}} |
| `FLOW_INFO_CHECKLIST_NO_TEXT` | shared/flow-mode.ts INFO_CHECKLIST_NO_TEXT | 글자 없는 설명 컷 순서 | — |
| `FLOW_INFO_CHECKLIST_LINES` | shared/flow-mode.ts INFO_CHECKLIST_LINES | 지정 문구 설명 컷 순서 | — |
| `FLOW_INFO_CHECKLIST_EXPLAINER` | shared/flow-mode.ts INFO_CHECKLIST_EXPLAINER | 혼합형 설명 장면 순서(INFO 글자 = 넣을 문구 대조, 넣을 문구 없는 예전 장면은 글자 없음) | — |
| `FLOW_HYBRID_EYE_CHECK` | shared/flow-mode.ts HYBRID_EYE_CHECK | 눈으로 확인할 항목 | — |

### examples.md

| 절 | 어디서 쓰임(함수) | 바꾸면 무엇이 달라짐 | 토큰·주의 |
|---|---|---|---|
| `SCENE_PLAN_EXAMPLE_SENTENCE` | server/script-instructions.ts videoScriptInstructions SCENE_PLAN_EXAMPLE_SENTENCE (JSON SHAPE 뒤 예시) | 대본 예시 문장 1개 | JSON 절(코드가 JSON.stringify) |
| `HYBRID_EXPLAINER_EXAMPLE` | server/hybrid-script-instructions.ts hybridExplainerExample → HYBRID_SCRIPT_RULES {{hybridExample}} | 혼합형 설명 장면·문장 예시 | JSON 절(코드가 JSON.stringify) |
| `SCRIPT_REFERENCE_EXAMPLES` | server/script-instructions.ts scriptReferenceExamples (REFERENCE STRUCTURES 뒤) | 레퍼런스 구조 예시 3개(JSON 배열) | JSON 절(코드가 JSON.stringify) |

### thresholds.json

| 이름 | 값 | 범위 | 설명 |
|---|---|---|---|
| `COPY_BEAT_TARGET_CHARS` | 34 | [10, 60] | 한 문장(한 호흡) 목표 글자 수. 프롬프트 PACING·리듬 규칙·대본 soft 경고·검토 규칙 1b 가 같이 쓴다. |
| `COPY_BEAT_MAX_CHARS` | 40 | [20, 80] | 한 문장 글자 수 상한. 넘으면 대본 hard 거부. |
| `COPY_CHANGE_WARNING_RATE` | 0.5 | [0, 1] | 카피 교정으로 내레이션이 이 비율 넘게 바뀌면 요약에 경고(되돌리지는 않음). |
| `NARRATION_MIN_CHARS_PER_SEC` | 8.5 | [3, 15] | 느린 문장 경고 기준(초당 글자 수 하한). 프롬프트 참고 범위의 아래쪽. |
| `NARRATION_TARGET_CHARS_PER_SEC` | 10 | [3, 15] | 프롬프트가 안내하는 초당 글자 수 목표(legacy·hybrid). |
| `NARRATION_MAX_CHARS_PER_SEC` | 12.6 | [4, 20] | 컷 범위 안 글자 수 상한(rangeCharLimit)과 문장당 시간표(minSentenceSec)의 기준. |
| `NARRATION_MIN_SENTENCE_CHARS` | 4 | [1, 10] | 이보다 짧은 내레이션 문장은 거부. |
| `VOICE_GAP_SEC` | 0.15 | [0, 1] | 문장 사이 최소 간격(초). 렌더 타임라인 gapMs 와 rangeCharLimit 가 같은 값을 쓴다. |
| `CUT_MAX_SEC` | 5 | [2, 8] | 실사 컷 길이 상한(legacy·hybrid, hard). immersive 는 VEO_CLIP_SEC(코드 고정 8). 프롬프트: script.md SCRIPT_SCENES({{maxCutSec}} 로 코드가 채움)·hybrid.md HYBRID_SCRIPT_RULES "Live cuts stay within {{CUT_MAX_SEC}} seconds". |
| `EXPLAINER_CUT_MAX_SEC` | 4 | [2, 8] | 설명 컷(I1~I3) 길이 상한(hybrid hard). 프롬프트 R7·INFO CLIPS·검토 규칙 15 가 같이 쓴다. |
| `EXPLAINER_MAX_RATIO` | 0.5 | [0, 1] | 설명 컷 시간 합계의 영상 대비 상한(hybrid soft). 프롬프트는 퍼센트({{EXPLAINER_MAX_PERCENT}})로 적는다. |
| `EXPLAINER_HOLD_MS` | 1000 | [0, 3000] | 설명 컷이 마지막 동작 뒤 머무는 최대 시간(ms). 조립(silenceTrim)과 대본 규칙 EXPLAINER_PHASE_SLACK_MS 가 같은 값. 프롬프트는 초({{EXPLAINER_HOLD_SEC}}: hybrid.md R9·HYBRID_SCRIPT_RULES CUTS "at most 1 second")로 적는다. |
| `HYBRID_ENDING_IMAGE_MAX_SEC` | 3 | [1, 8] | 혼합형 엔딩에서 승인 이미지가 차지할 수 있는 최대 초. 기획·대본·검토 프롬프트와 규칙이 같이 쓴다. |
| `NATURAL_CHARS_PER_SEC` | 5.5 | [4, 8] | 카피 먼저 흐름(2026-10-08)의 말 속도(초당 글자 수, Typecast 자연 속도 실측). 카피 길이 추정·30~60초 사전 검사·장면 컷 배분·문장-컷 길이 검사(`shared/script-rules-v2.ts`)가 같은 값. 예전 흐름의 `NARRATION_MAX_CHARS_PER_SEC`(12.6)와 별개. |
| `COPY_LINES_MIN` | 6 | [4, 12] | 카피 먼저 흐름의 문장 수 하한(영상 1편). |
| `COPY_LINES_MAX` | 10 | [6, 16] | 카피 먼저 흐름의 문장 수 상한(영상 1편). 50초 기준 8~10문장. |
| `STILL_BEAT_MAX_SEC` | 3 | [1, 5] | 혼합형에서 진짜 원인·해결 조건(③④) 문장 아래 정지 이미지 한 컷의 최대 초(연속 두 컷은 길이와 무관하게 거부). 프롬프트 토큰(hybrid.md HYBRID_PLANNING_RULES·HYBRID_SCRIPT_RULES·HYBRID_REVIEW_RULES)과 `shared/hybrid-script-rules.ts` hard 검사가 같은 값. |
| `SILENCE_GAP_MAX_MS` | 500 | [0, 2000] | 문장 사이 무음 상한(ms). 범위 밖의 말 없는 컷을 다음 문장 앞에서 이만큼까지 줄인다. 프롬프트는 초({{SILENCE_GAP_MAX_SEC}}: hybrid.md R9 "under 0.5 seconds")로 적는다. |
| `SILENCE_TRIM_MIN_CUT_MS` | 1000 | [0, 3000] | 무음 줄이기가 남겨 두는 컷 최소 길이(ms). |
| `TIMELINE_SLACK_MS` | 300 | [0, 1000] | 문장이 컷 창을 이만큼 넘는 것은 초과로 보지 않는다(ms). |
| `TIMELINE_MAX_SPREAD_MS` | 500 | [0, 2000] | 남은 초과를 뒤따르는 컷 하나에 얹을 수 있는 최대치(ms). |
| `TIMELINE_MAX_EXTEND_MS` | 3000 | [0, 10000] | 영상 1편의 총 연장 상한(ms). |
| `MOTION_GRAPHIC_MAX_RATIO` | 0.4 | [0, 1] | 모션그래픽 컷 시간 합계의 영상 대비 상한(legacy·immersive). 프롬프트는 퍼센트로 적는다. |
| `VEO_MAX_RATIO` | 0.5 | [0, 1] | Veo 컷 시간 합계의 영상 대비 상한. 프롬프트는 퍼센트로 적는다. |
| `VEO_HINT_RATIO` | 0.45 | [0, 1] | Veo 컷 시간 권장 비율(현재 프롬프트 미참조, 코드 상수 보존). |
| `STILL_MAX_SEC` | 4 | [1, 10] | 정지 이미지 한 장이 채우는 컷 시간 합계 상한(초, soft). |
| `SILENT_CUTS_MAX` | 2 | [0, 10] | 말 없는 컷 허용 개수(앞·사이·끝, 마지막 cta 컷 예외). |
| `SCENE_HOLD_SEC` | 2 | [0, 5] | 짧은 문장 뒤 동작·장면을 볼 여유(초). 느린 문장 경고에만 쓴다. |
| `CAPTION_LINE_MAX_CHARS` | 12 | [6, 30] | 자막 한 줄 최대 글자 수(프롬프트 script.md SCRIPT_CAPTIONS "7–12 chars" 의 12·구절 자막 끊기). |
| `CAPTION_MIN_CHARS` | 7 | [1, 20] | 구절 자막 최소 글자 수(프롬프트 SCRIPT_CAPTIONS "7–12 chars" 의 7·구절 자막 끊기). |
| `CAPTION_MIN_MS` | 500 | [100, 3000] | 구절 자막 최소 표시 시간(ms). 프롬프트는 초({{CAPTION_MIN_SEC}}: SCRIPT_CAPTIONS "every 0.5–2 seconds")로 적는다. hybrid.md R7 "1–2 seconds" 의 1 은 묶이지 않은 리터럴. |
| `CAPTION_MAX_MS` | 2000 | [500, 6000] | 구절 자막 최대 표시 시간(ms). 프롬프트는 초({{CAPTION_MAX_SEC}}: SCRIPT_CAPTIONS·hybrid.md R7 의 2 는 리터럴)로 적는다. |
| `CAPTION_LEAD_MS` | 200 | [0, 1000] | 자막이 말보다 먼저 뜨는 시간(ms). |
| `VERIFY_FEEDBACK_MAX` | 16 | [4, 50] | 다음 생성에 돌려주는 규칙 위반 수 상한. |
| `NEAR_DUPLICATE_RATIO` | 0.75 | [0.5, 1] | 거의 같은 문장 판정(글자 bigram 자카드) 기준. |
| `NEAR_DUPLICATE_MIN_BIGRAMS` | 6 | [2, 20] | 이보다 bigram 이 적은 짧은 문장은 중복 비교에서 제외. |
| `SUBJECT_KEY_WORD_MIN_CHARS` | 4 | [2, 10] | subjects traits 에서 이미지 프롬프트와 대조하는 낱말의 최소 길이. |
| `VIDEO_SHORT_MAX_SEC` | 40 | [30, 60] | 같은 광고안의 첫 영상(짧은 버전) 목표 길이 상한(초). 하한은 VIDEO_MIN_SEC(코드 고정 30). |
| `VIDEO_LONG_MIN_SEC` | 45 | [30, 60] | 같은 광고안의 두 번째 영상(긴 버전) 목표 길이 하한(초). 상한은 VIDEO_MAX_SEC(코드 고정 60). |
| `INFO_GRAPHIC_BAND_TOP` | 20 | [0, 50] | 예전·immersive INFO 그래픽을 두는 중간 띠의 위 경계(화면 높이 %). |
| `INFO_GRAPHIC_BAND_BOTTOM` | 65 | [50, 100] | 중간 띠의 아래 경계(화면 높이 %). 아래 여백은 100−이 값({{INFO_GRAPHIC_BAND_BOTTOM_FREE}}). |

### 임계값·파생 토큰을 쓰는 절(값 하나를 바꾸면 함께 바뀌는 프롬프트 자리)

`thresholds.json` 의 값은 코드 검사와 아래 절의 토큰 자리에 같이 들어간다. 목록에 없는 임계값은 코드 검사·조립에서만 쓴다
(`COPY_CHANGE_WARNING_RATE`, `NARRATION_MIN_SENTENCE_CHARS`, `VOICE_GAP_SEC`, `SILENCE_TRIM_MIN_CUT_MS`, `TIMELINE_*`, `STILL_MAX_SEC`,
`SILENT_CUTS_MAX`, `SCENE_HOLD_SEC`, `CAPTION_LEAD_MS`, `VERIFY_FEEDBACK_MAX`, `NEAR_DUPLICATE_*`, `SUBJECT_KEY_WORD_MIN_CHARS`,
`VIDEO_SHORT_MAX_SEC`, `VIDEO_LONG_MIN_SEC`, `VEO_HINT_RATIO`(미참조)).

| 토큰 | 쓰는 절 |
|---|---|
| `{{COPY_BEAT_TARGET_CHARS}}` | script.md SCRIPT_PACING_HEAD · copy.md KOREAN_COPY_RHYTHM_RULES · NATURAL_COPY_RHYTHM_RULES · review.md REVIEW_RHYTHM_IMMERSIVE · REVIEW_RHYTHM_DEFAULT · copy-first.md COPY_WRITE_RULES |
| `{{COPY_BEAT_MAX_CHARS}}` | script.md SCRIPT_PACING_HEAD · copy.md KOREAN_COPY_RHYTHM_RULES · NATURAL_COPY_RHYTHM_RULES · copy-first.md COPY_WRITE_RULES |
| `{{NATURAL_CHARS_PER_SEC}}` `{{COPY_LINES_MIN}}` `{{COPY_LINES_MAX}}` | copy-first.md COPY_WRITE_RULES(길이 안내) · SCENE_FROM_COPY_RULES(NATURAL_CHARS_PER_SEC 만, 문장별 컷 시간) |
| `{{NARRATION_MIN/TARGET/MAX_CHARS_PER_SEC}}` | script.md SCRIPT_PACING_SPEECH_DEFAULT |
| `{{CUT_MAX_SEC}}` | hybrid.md HYBRID_SCRIPT_RULES(실사 컷) · script.md SCRIPT_SCENES 는 호출 시점 `{{maxCutSec}}`(legacy·hybrid 에 이 값, immersive 에 VEO_CLIP_SEC) · copy-first.md SCENE_FROM_COPY_RULES |
| `{{EXPLAINER_CUT_MAX_SEC}}` | hybrid.md EXPLAINER_GRAMMAR · HYBRID_SCRIPT_RULES · HYBRID_REVIEW_GRAMMAR_INTRO · HYBRID_INFO_RULE · HYBRID_SCENES_EXPLAINER_NOTE · HYBRID_CUT_PHASE_NOTE · copy-first.md SCENE_FROM_COPY_RULES |
| `{{STILL_BEAT_MAX_SEC}}` | hybrid.md HYBRID_PLANNING_RULES · HYBRID_SCRIPT_RULES(BEAT → SOURCE) · HYBRID_REVIEW_RULES (i) |
| `{{EXPLAINER_MAX_PERCENT}}` (← EXPLAINER_MAX_RATIO) | hybrid.md HYBRID_SCRIPT_RULES |
| `{{EXPLAINER_HOLD_SEC}}` (← EXPLAINER_HOLD_MS) | hybrid.md EXPLAINER_GRAMMAR R9 · HYBRID_SCRIPT_RULES CUTS |
| `{{SILENCE_GAP_MAX_SEC}}` (← SILENCE_GAP_MAX_MS) | hybrid.md EXPLAINER_GRAMMAR R9 |
| `{{HYBRID_ENDING_IMAGE_MAX_SEC}}` | hybrid.md HYBRID_VISUAL_CONTRACT · HYBRID_PLANNING_RULES · HYBRID_SCRIPT_RULES · HYBRID_REVIEW_RULES · HYBRID_SOURCES_APPROVED_IMAGE · copy-first.md SCENE_FROM_COPY_RULES |
| `{{MOTION_GRAPHIC_MAX_PERCENT}}` (← MOTION_GRAPHIC_MAX_RATIO) | script.md SCRIPT_GRAPHICS_DEFAULT |
| `{{VEO_MAX_PERCENT}}` (← VEO_MAX_RATIO) | script.md SCRIPT_VEO · hybrid.md HYBRID_SCRIPT_RULES(혼합형에는 이 상한을 적용하지 않는다는 안내; 코드도 `shared/script-rules.ts` 에서 isHybrid 면 건너뜀) |
| `{{CAPTION_MIN_CHARS}}` `{{CAPTION_LINE_MAX_CHARS}}` `{{CAPTION_MIN_SEC}}` `{{CAPTION_MAX_SEC}}` | script.md SCRIPT_CAPTIONS |
| `{{INFO_GRAPHIC_BAND_TOP}}` `{{INFO_GRAPHIC_BAND_BOTTOM}}` `{{INFO_GRAPHIC_BAND_BOTTOM_FREE}}` | flow.md IMMERSIVE_BAND · INFO_OVERLAY_BAND · INFO_LINES_BAND · HYBRID_OVERLAY_INFOGRAPHIC(위·아래 경계만) |
| 코드 고정 토큰 | `{{VIDEO_MIN_SEC}}`·`{{VIDEO_MAX_SEC}}` planning.md PLANNING_OPENING·PLANNING_COPY, script.md SCRIPT_OPENING · `{{SHOT_MIN_SEC}}`·`{{CUT_GOAL_MAX_CHARS}}` SCRIPT_SCENES · `{{SUBJECTS_MAX}}` SCRIPT_SUBJECTS · `{{PHASE_TABLE}}`·`{{VEO_CLIP_SEC}}` SCRIPT_CLIP_PLAN(·SCRIPT_VEO·SCRIPT_CUT_PHASE_DEFAULT_NOTE) · `{{CALLOUTS_MAX}}` SCRIPT_CALLOUTS · `{{VEO_SHOTS_MAX}}` SCRIPT_VEO · `{{STILL_SHOTS_MAX}}` SCRIPT_STILLS · `{{INFO_CLIPS_MAX}}` SCRIPT_INFO_CLIPS_LEGACY, hybrid.md HYBRID_PLANNING_RULES·HYBRID_INFO_RULE · `{{EXPLAINER_OBJECTS/ACTIONS/EMPHASIS_MAX}}` HYBRID_PLANNING_RULES · copy-first.md COPY_WRITE_RULES(`VIDEO_MIN_SEC`·`VIDEO_MAX_SEC`)·SCENE_FROM_COPY_RULES(`VIDEO_MIN_SEC`·`VIDEO_MAX_SEC`·`SHOT_MIN_SEC`·`INFO_CLIPS_MAX`·`VEO_SHOTS_MAX`·`VEO_CLIP_SEC`·`PHASE_TABLE`·`STILL_SHOTS_MAX`·`SUBJECTS_MAX`·`CUT_GOAL_MAX_CHARS`·`CALLOUTS_MAX`) |

### 코드 고정 토큰

| 이름 | 값 |
|---|---|
| `VIDEO_MIN_SEC` | 30 |
| `VIDEO_MAX_SEC` | 60 |
| `SHOT_MIN_SEC` | 0.5 |
| `VEO_SHOTS_MAX` | 4 |
| `VEO_STORED_SHOTS_MAX` | 8 |
| `VEO_CLIP_SEC` | 8 |
| `STILL_SHOTS_MAX` | 14 |
| `INFO_CLIPS_MAX` | 3 |
| `CUT_GOAL_MAX_CHARS` | 40 |
| `SUBJECTS_MAX` | 4 |
| `CALLOUTS_MAX` | 3 |
| `EXPLAINER_OBJECTS_MAX` | 3 |
| `EXPLAINER_ACTIONS_MAX` | 3 |
| `EXPLAINER_EMPHASIS_MAX` | 4 |
| `CALLOUT_COLORS` | 3 |
| `TIMELINE_MAX_TEMPO` | 1.3 |
| `PHASE_TABLE` | early 0–3s, mid 3–5.5s, late 5.5–8s |

## 골든 파일(동작 불변 검사)

`tests/golden/instructions-*.txt` 는 b3ef40a 코드가 만든 프롬프트다. `tests/instructions-golden.test.ts` 가 새 코드의 출력과
바이트 단위로 비교한다. 파일 갱신은 사용자 결정으로만: `GOLDEN_UPDATE=1 bun test tests/instructions-golden.test.ts`.

주의 — 골든의 뜻은 첫 의도적 편집 뒤에 바뀐다. 테스트는 저장소의 **살아 있는** `instructions/` 를 읽으므로, 지시 파일을 의도적으로
고치는 첫 순간부터 골든은 실패하고(정상), `GOLDEN_UPDATE=1` 로 다시 쓰면 그 뒤의 골든은 "b3ef40a 출력"이 아니라 "직전 지시 파일의
출력"(= 코드 조립 경로가 바뀌지 않았다는 검사)을 뜻한다. b3ef40a 와 다시 대조하려면: `git worktree add <스크래치> b3ef40a` 에서 예전
시그니처(`clipPrompt(clip, {liveAction})`, `infoCleanPrompt(clip, anchor, immersive, explainer)`, `buildFlowExport(job, n)`,
`KOREAN_COPY_*` 상수)로 같은 입력 61개를 만들어 `cmp` 한다(2026-10-08 검토가 이 절차로 61/61 동일을 확인했다). 다른 선택지는 골든
입력을 `git show <첫 커밋>:instructions/<파일>` 로 고정한 사본 폴더(`root` 주입)로 돌리는 것인데, b3ef40a 에는 `instructions/` 가 없어
첫 커밋 뒤부터 가능하다.

| 묶음 | 파일 | 입력 |
|---|---|---|
| 대본 프롬프트 | script-legacy-api · script-legacy-flow-feedback · script-legacy-nochain · script-legacy-nochain-offer · script-immersive-flow · script-immersive-api-clips-feedback · script-hybrid-flow · script-hybrid-api-feedback | `videoScriptInstructions`, 가설 = sourcePlanResponse 1번 |
| 기획·교정 | planning-immersive · planning-hybrid · copy-editing-hybrid · copy-editing-immersive | `videoPlanningInstructions`, `prepareVideoPlanning`(HTTP 픽스처, DATA 앞부분) |
| 검토 | review-legacy · review-immersive · review-immersive-explanation · review-hybrid | `reviewVideoScript`(HTTP 픽스처, DATA 앞부분) |
| 자료 기획 | source-reference-structure · source-creative-plan · source-plan-critique | `SourcePlanner.plan`(HTTP 픽스처, DATA 앞부분) |
| 카피 | copy-polish-rules · copy-rhythm-rules · copy-natural-rules · copy-rhythm-legacy · copy-rhythm-natural | 상수·`copyRhythmInstruction` |
| Veo·CLEAN | veo-clip-plan · veo-clip-plan-live · veo-clip-legacy · veo-clip-legacy-live · clean-keyframe-tail · clean-keyframe-prompt | `clipPrompt`, `cleanKeyframePrompt` |
| 혼합형 설명 | hybrid-clean/overlay/motion-process · hybrid-clean/overlay/motion-comparison · hybrid-overlay-ghost · hybrid-overlay-no-emphasis · hybrid-motion-bare | `hybridCleanPrompt` 등, 픽스처 I1·I2 |
| immersive 설명 | immersive-clean/overlay/motion-explanation · immersive-clean/overlay/motion-plain · explanation-prompt | 설명 설계 있음/없음 |
| 예전 설명 컷 | legacy-info-clean · legacy-info-overlay · legacy-info-overlay-lines · legacy-info-motion · legacy-info-motion-noplan | R3/R4/infoLines/R5/계획 없음 |
| 이미지 | image-start · image-still · image-scene-ref-0/1/2 · image-source-immersive | `startImagePrompt`, `stillPrompt`, `sceneImagePrompt`, `sourceImagePrompt` |
| Flow 번들 | flow-bundle-legacy-info · flow-bundle-legacy-graphic-order · flow-bundle-immersive · flow-bundle-hybrid | `flowExportMarkdown(buildFlowExport(...))`, 작업 ID 는 `<jobId>` |
