# examples.md — 프롬프트에 끼우는 JSON 예시(모양만)

각 절은 JSON 하나다(로드 때 파싱 검증). 코드가 `JSON.stringify` 로 한 줄로 끼우므로 들여쓰기는 자유, 키 순서는 유지된다.
숫자·제품 낱말은 FACTS 에서 가져오라고 프롬프트가 같이 적는다 — 예시 값은 사실이 아니다.

## SCENE_PLAN_EXAMPLE_SENTENCE

{
  "purpose": "mechanism",
  "chainStep": "reason_why",
  "text": "한 캡슐에 600밀리그램을 담아서요.",
  "actionSync": null,
  "callouts": [
    {
      "word": "600밀리그램을",
      "text": "600밀리그램",
      "kind": "label",
      "anchor": "subject",
      "targetId": null
    }
  ],
  "cuts": [
    {
      "len": 3,
      "source": "veo_clip",
      "veoClip": "B",
      "phase": "late",
      "goal": "캡슐 하나에 600밀리그램이 들어 있다",
      "screenComposition": "Close-up: one capsule rests on her palm; the 600mg mark on the amber bottle label behind it is in focus",
      "onScreenText": "한 캡슐 600밀리그램",
      "effect": "zoom_punch",
      "stillId": "",
      "graphicKind": "",
      "graphicLines": []
    }
  ]
}

## HYBRID_EXPLAINER_EXAMPLE

{
  "infoClip": {
    "id": "I1",
    "stage": "mechanism",
    "cleanPrompt": "Clay-white 3D model world under soft daylight: one translucent capsule shell with rounded ends resting on a clay table, empty space around it",
    "infoPrompt": "The same capsule shell split open along its seam with a thin red outline, golden olive oil filling it to the top with a white glow line tracing the rising level; a bold accent arrow points into the open shell with the label 올리브유 100% on a small plate beside it, and a dimension line spans the oil column with the label 엑스트라 버진",
    "infoLines": ["올리브유 100%", "엑스트라 버진"],
    "plan": {
      "early": {
        "camera": "starts low at table level, rises slowly toward the capsule, settles level with it",
        "action": "the capsule shell splits open along its seam"
      },
      "mid": {
        "camera": "orbits a quarter turn around the open shell, keeps it centered",
        "action": "golden oil pours into the open shell"
      },
      "late": {
        "camera": "flies past and settles on a steady three-quarter close-up",
        "action": "the oil level rises until the shell is full and holds"
      }
    },
    "sceneType": "process",
    "objects": [
      {
        "subjectId": "capsule",
        "color": "accent1"
      },
      {
        "subjectId": "oil",
        "color": "accent2"
      }
    ],
    "actions": [
      "The capsule shell splits open along its seam",
      "Golden olive oil pours into the open shell",
      "The oil level rises until the shell is full"
    ],
    "emphasis": [
      {
        "kind": "outline",
        "target": "capsule",
        "afterAction": 0
      },
      {
        "kind": "glow_line",
        "target": "oil",
        "afterAction": 1
      }
    ]
  },
  "sentence": {
    "purpose": "mechanism",
    "chainStep": "reason_why",
    "text": "캡슐 안을 올리브유로만 채웠거든요.",
    "actionSync": null,
    "callouts": [],
    "cuts": [
      {
        "len": 3,
        "source": "veo_clip",
        "veoClip": "I1",
        "phase": "mid",
        "goal": "캡슐 안에 올리브유가 차오른다",
        "screenComposition": "Explainer world: the open capsule shell fills with golden oil as the camera orbits a quarter turn",
        "onScreenText": "캡슐 안은 올리브유",
        "effect": "hard_cut",
        "stillId": "",
        "graphicKind": "",
        "graphicLines": []
      }
    ]
  }
}

## SCRIPT_REFERENCE_EXAMPLES

[
  {
    "reference": "zp5sXxrKFQA",
    "pattern": "의심 → 반전 → 제품 특징 → 자기 다짐형 CTA",
    "requires": [
      "제품 특징",
      "실제 사용 맥락"
    ],
    "voicePersona": "conversational",
    "sentences": [
      {
        "purpose": "hook",
        "text": "매번 챙기다 멈췄다면, 이번에는 고르는 기준부터 조금 바꿔보면 어떨까요?",
        "cuts": [
          {
            "len": 0.6,
            "source": "veo_clip",
            "screenComposition": "머뭇거리는 손",
            "onScreenText": "또 미뤘다면"
          },
          {
            "len": 0.7,
            "source": "still_image",
            "screenComposition": "아침 식탁 재구도",
            "onScreenText": "기준을 바꿔요"
          },
          {
            "len": 1.8,
            "source": "approved_image",
            "screenComposition": "승인된 제품 이미지",
            "onScreenText": "다르게 고르기"
          }
        ]
      },
      {
        "purpose": "mechanism",
        "text": "이 제품은 {사실_특징}이라서 {사실_사용법}으로 챙길 수 있어요.",
        "cuts": [
          {
            "len": 1.5,
            "source": "approved_image",
            "screenComposition": "승인 광고 이미지 전체와 {사실_특징} 강조 자막",
            "onScreenText": "{사실_특징}"
          },
          {
            "len": 1.5,
            "source": "motion_graphic",
            "screenComposition": "{사실_사용법} 설명 카드",
            "onScreenText": "{사실_사용법}"
          }
        ]
      }
    ]
  },
  {
    "reference": "2mAps9ECN14",
    "pattern": "궁금증 → 반론 → 원리 설명; 고정 제목/소형 고지/구절 자막의 분리",
    "requires": [
      "입증된 제품 특징",
      "필요한 고지"
    ],
    "fixedTitle": [
      "{자료로_확인된_제목}",
      "{제품명}"
    ],
    "disclaimer": "{실제_필요한_고지_없으면_빈문자열}",
    "sentences": [
      {
        "purpose": "story",
        "text": "이름만 보면 비슷해 보여도, 고를 때 확인할 부분은 따로 있어요.",
        "cuts": [
          {
            "len": 1.5,
            "source": "still_image",
            "screenComposition": "제품이 놓인 생활 공간",
            "onScreenText": "비슷해 보여도"
          },
          {
            "len": 1.5,
            "source": "approved_image",
            "screenComposition": "승인 이미지의 제목과 제품이 함께 보이는 전체 구도",
            "onScreenText": "볼 곳은 따로"
          }
        ]
      },
      {
        "purpose": "mechanism",
        "text": "{사실_성분명}과 {사실_수치}를 확인하고, 내 기준에 맞는지 비교해 보세요.",
        "cuts": [
          {
            "len": 1.4,
            "source": "approved_image",
            "screenComposition": "{사실_성분명} 표기",
            "onScreenText": "{사실_성분명}"
          },
          {
            "len": 1.6,
            "source": "motion_graphic",
            "screenComposition": "{사실_수치} 강조",
            "onScreenText": "{사실_수치}"
          }
        ]
      }
    ]
  },
  {
    "reference": "bP-Q1ZF5nRY",
    "pattern": "질문 → 답 지연 → 확인 가능한 증거 → 조건/링크; 사례나 인물은 만들지 않음",
    "requires": [
      "실제 오퍼 자료가 있는 BOFU",
      "가격과 기간"
    ],
    "sentences": [
      {
        "purpose": "hook",
        "text": "이번 조건은 뭐가 다른 걸까요? 먼저 구성부터 같이 볼게요.",
        "cuts": [
          {
            "len": 1,
            "source": "veo_clip",
            "screenComposition": "제품을 확인하는 손",
            "onScreenText": "이번엔 뭐가 다를까"
          },
          {
            "len": 1.5,
            "source": "approved_image",
            "screenComposition": "승인된 제품 구성",
            "onScreenText": "구성부터 보기"
          }
        ]
      },
      {
        "purpose": "offer",
        "text": "{자료의_가격}에 {자료의_구성}, 적용 기간은 {자료의_기간}이에요.",
        "cuts": [
          {
            "len": 1.5,
            "source": "motion_graphic",
            "screenComposition": "가격과 구성 카드",
            "onScreenText": "{자료의_가격}"
          },
          {
            "len": 1.5,
            "source": "approved_image",
            "screenComposition": "제품 이미지와 기간",
            "onScreenText": "{자료의_기간}"
          }
        ]
      }
    ]
  }
]
