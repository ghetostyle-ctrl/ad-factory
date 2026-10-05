# 개발·확장 가이드

## 시작

Fork 후 자신의 저장소를 clone합니다. Bun 1.3.14, FFmpeg/ffprobe를 준비하세요.

```sh
git clone https://github.com/YOUR-ACCOUNT/ad-factory.git
cd ad-factory
bun install --frozen-lockfile
bun run build
bun run start
```

UI 개발: 첫 터미널에서 `bun run dev`, 다른 터미널에서 `bun run dev:ui`. Vite 5173 화면이 로컬 4317 API를 사용합니다. `.env`는 각자 준비하고 `.env.example`만 커밋합니다.

## 구조

| 경로 | 역할 |
|---|---|
| src/ | React 화면과 CSS |
| src/SettingsDialog.tsx | 연결 설정 |
| src/AgentBoard.tsx | 워크플로 표시 |
| shared/ | 공용 Zod 스키마 |
| server/app.ts | Hono API와 로컬 요청 제한 |
| server/store.ts | SQLite 작업 저장 |
| server/project-store.ts | 자료 라이브러리 |
| server/automation.ts | 제작 실행·상태 전환 |
| server/source-planning.ts | 자료 기반 기획 |
| server/source-production.ts | 소재별 이미지 생성·검토 |
| server/video-scripts.ts | 대본·컷·편집 지시 |
| server/video-provider.ts | Veo 요청·조회·다운로드 |
| server/provider-environment.ts | 환경변수·로컬 키 저장 |
| tests/ | 로컬 fixture 기반 검증 |

## 확장

새 연결은 공용 입력/상태 스키마, 서버 자격증명 저장, API 핸들러, 설정 UI를 함께 수정합니다. 키를 State API나 로그에 반환하지 않습니다. 네트워크 요청은 취소·시간 제한·사용 모델 기록을 유지합니다.

새 제작 단계는 외부 작업 ID 저장과 재조회도 구현해야 합니다. 표시만 나누고 상태를 공유하면 독립 워크플로가 되지 않습니다. 이미지·영상 독립 실행과 명시적인 검토 보류 상태가 확장 과제입니다.

## 검증

```sh
bun run check
bun run build
bun test
bun run lint
```

테스트는 임시 DB·로컬 HTTP fixture를 사용하고 일부는 FFmpeg가 필요합니다. 개인 키 없는 clone에서 실행하세요. 공개 시점 결과는 [검증 기록](VALIDATION.md)을 참고하세요. 기존 실패를 삭제하거나 통과로 숨기지 않습니다. 의도적으로 제거한 기능의 테스트만 삭제하며, 그 이유를 검증 기록에 남깁니다.

## 배포

```sh
git archive --format=zip --prefix=ad-factory/ --output=../ad-factory-source.zip HEAD
```

Git에 추적된 파일만 소스 ZIP에 포함합니다. `.env`, DB, 로그, 사용자 자료는 추적하지 않습니다. 현재 EXE 설치본·SaaS는 아닙니다. 본 프로젝트는 MIT, 의존성·외부 서비스는 각각의 조건을 따릅니다.
