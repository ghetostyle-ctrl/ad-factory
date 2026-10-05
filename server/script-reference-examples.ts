// 레퍼런스의 편집 구조만 예시로 쓴다. 중괄호 자리는 현재 작업의 사실 자료로 채워야 한다.
export const SCRIPT_REFERENCE_EXAMPLES = [
  {
    reference: "zp5sXxrKFQA",
    pattern: "의심 → 반전 → 제품 특징 → 자기 다짐형 CTA",
    requires: ["제품 특징", "실제 사용 맥락"],
    voicePersona: "conversational",
    sentences: [
      {
        purpose: "hook",
        text: "매번 챙기다 멈췄다면, 이번에는 고르는 기준부터 조금 바꿔보면 어떨까요?",
        cuts: [
          {
            len: 0.6,
            source: "veo_clip",
            screenComposition: "머뭇거리는 손",
            onScreenText: "또 미뤘다면",
          },
          {
            len: 0.7,
            source: "still_image",
            screenComposition: "아침 식탁 재구도",
            onScreenText: "기준을 바꿔요",
          },
          {
            len: 1.8,
            source: "approved_image",
            screenComposition: "승인된 제품 이미지",
            onScreenText: "다르게 고르기",
          },
        ],
      },
      {
        purpose: "mechanism",
        text: "이 제품은 {사실_특징}이라서 {사실_사용법}으로 챙길 수 있어요.",
        cuts: [
          {
            len: 1.5,
            source: "approved_image",
            screenComposition: "승인 광고 이미지 전체와 {사실_특징} 강조 자막",
            onScreenText: "{사실_특징}",
          },
          {
            len: 1.5,
            source: "motion_graphic",
            screenComposition: "{사실_사용법} 설명 카드",
            onScreenText: "{사실_사용법}",
          },
        ],
      },
    ],
  },
  {
    reference: "2mAps9ECN14",
    pattern: "궁금증 → 반론 → 원리 설명; 고정 제목/소형 고지/구절 자막의 분리",
    requires: ["입증된 제품 특징", "필요한 고지"],
    fixedTitle: ["{자료로_확인된_제목}", "{제품명}"],
    disclaimer: "{실제_필요한_고지_없으면_빈문자열}",
    sentences: [
      {
        purpose: "story",
        text: "이름만 보면 비슷해 보여도, 고를 때 확인할 부분은 따로 있어요.",
        cuts: [
          {
            len: 1.5,
            source: "still_image",
            screenComposition: "제품이 놓인 생활 공간",
            onScreenText: "비슷해 보여도",
          },
          {
            len: 1.5,
            source: "approved_image",
            screenComposition: "승인 이미지의 제목과 제품이 함께 보이는 전체 구도",
            onScreenText: "볼 곳은 따로",
          },
        ],
      },
      {
        purpose: "mechanism",
        text: "{사실_성분명}과 {사실_수치}를 확인하고, 내 기준에 맞는지 비교해 보세요.",
        cuts: [
          {
            len: 1.4,
            source: "approved_image",
            screenComposition: "{사실_성분명} 표기",
            onScreenText: "{사실_성분명}",
          },
          {
            len: 1.6,
            source: "motion_graphic",
            screenComposition: "{사실_수치} 강조",
            onScreenText: "{사실_수치}",
          },
        ],
      },
    ],
  },
  {
    reference: "bP-Q1ZF5nRY",
    pattern: "질문 → 답 지연 → 확인 가능한 증거 → 조건/링크; 사례나 인물은 만들지 않음",
    requires: ["실제 오퍼 자료가 있는 BOFU", "가격과 기간"],
    sentences: [
      {
        purpose: "hook",
        text: "이번 조건은 뭐가 다른 걸까요? 먼저 구성부터 같이 볼게요.",
        cuts: [
          {
            len: 1,
            source: "veo_clip",
            screenComposition: "제품을 확인하는 손",
            onScreenText: "이번엔 뭐가 다를까",
          },
          {
            len: 1.5,
            source: "approved_image",
            screenComposition: "승인된 제품 구성",
            onScreenText: "구성부터 보기",
          },
        ],
      },
      {
        purpose: "offer",
        text: "{자료의_가격}에 {자료의_구성}, 적용 기간은 {자료의_기간}이에요.",
        cuts: [
          {
            len: 1.5,
            source: "motion_graphic",
            screenComposition: "가격과 구성 카드",
            onScreenText: "{자료의_가격}",
          },
          {
            len: 1.5,
            source: "approved_image",
            screenComposition: "제품 이미지와 기간",
            onScreenText: "{자료의_기간}",
          },
        ],
      },
    ],
  },
] as const;
