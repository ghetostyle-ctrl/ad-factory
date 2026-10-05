# BGM 라이브러리 대장

완성 영상의 배경음악은 이 폴더(또는 `.env` 의 `BGM_DIR`)의 `manifest.json` 에 등록된 트랙 중에서
가설의 인식 단계(TOFU→tense, MOFU→warm, BOFU→upbeat, 없으면 calm)에 맞는 무드를 작업 ID·영상 번호
해시로 결정론적으로 고릅니다(AI·네트워크 호출 없음). 라이브러리가 비어 있으면 'BGM 없음' 경고로
완성합니다(실패 아님).

저장소에는 트랙 파일을 넣지 않습니다. 라이선스를 확인한 로열티프리 음원을 직접 넣고 아래 양식과
`manifest.json` 에 출처를 기록하세요. 믹스는 BGM -14dB 선감쇠 + 내레이션 키 사이드체인 덕킹
(threshold 0.01 · ratio 20 · attack 20ms · release 500ms) + 페이드 0.8초/1.5초, 최종 loudnorm I=-14 LUFS 입니다.

## manifest.json 항목 예시

```json
[
  {
    "id": "calm-01",
    "file": "calm-01.mp3",
    "mood": "calm",
    "bpm": 84,
    "integratedLufs": -18,
    "license": {
      "name": "CC BY 4.0",
      "url": "https://example.com/track",
      "attribution": "Music: Example Artist — Example Track"
    }
  }
]
```

- `mood`: `calm` | `warm` | `tense` | `upbeat` (무드별 최소 1곡 권장, 30~60초 이상 또는 루프 가능)
- `integratedLufs`: 음원 자체의 통합 라우드니스(참고용, 믹스는 선감쇠·덕킹·loudnorm 으로 맞춤)
- `license`: 음원 라이선스 이름·URL·표기 문구. 표기 의무가 있으면 영상 설명란 등에 그대로 옮깁니다.

## 대장

| id | 파일 | 무드 | 출처 URL | 라이선스 | 표기 문구 | 확인일 |
| -- | ---- | ---- | -------- | -------- | --------- | ------ |
| (없음) | | | | | | |
