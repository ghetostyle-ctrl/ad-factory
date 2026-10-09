import type { VideoPlanning } from "../shared/video-planning";

export function fixtureVideoPlanning(): VideoPlanning {
  return {
    audience: {
      viewer: "출근 전에 음료를 챙겨 나가는 직장인",
      situation: "현관에서 가방을 닫기 직전, 텀블러를 어디에 넣을지 망설이는 순간",
      trigger: "노트북 옆에 음료를 넣어야 해서 뚜껑을 한 번 더 살펴본다.",
      currentApproach: "가방 밖에서 손으로 들고 가거나 따로 봉투에 넣는다.",
      friction: "짐이 많을 때 손이 하나 더 필요하다.",
      concern: "가방 안에서 내용물이 쏟아질까 걱정한다.",
      desiredChange: "출근 준비 중 확인할 내용을 쉽게 파악하고 싶다.",
      purchaseBarrier: "사진만으로는 뚜껑 구조와 가방에 들어가는 크기를 알기 어렵다.",
      proofNeeded: "뚜껑을 여닫는 실제 동작과 가방 옆에 놓은 크기 비교",
      awareness: "solution_aware",
      evidence: [
        { sourceId: "voice-1", observation: "고객 문의에서 가방에 넣을 때의 크기를 물었다." },
      ],
      assumptions: ["출근 직전이 중요한 선택 순간이라는 해석은 기획 가설이다."],
      unknowns: ["실제 누수 성능 자료가 없어 새지 않는다고 단정하지 않는다."],
    },
    concept: {
      idea: "현관에서 가방을 닫기 전, 텀블러의 크기와 뚜껑을 차례로 살펴본다.",
      viewerQuestion: "매일 쓰는 가방에 어떻게 넣고 다닐 수 있을까?",
      openingScene: "한 손에는 가방, 다른 손에는 텀블러를 든 채 잠시 멈춘다.",
      development: [
        "실제 사용 상황을 보여준다.",
        "뚜껑 동작을 끝까지 보여준다.",
        "가방 옆에서 크기를 비교한다.",
      ],
      payoff: "내가 들고 다니는 방식에 필요한 확인 기준을 얻는다.",
      proofScene: "확인된 제품 치수와 실제 뚜껑 구조를 보여주는 장면",
      ctaIntent: "제품 정보에서 치수와 사용 방법을 확인한다.",
      referenceNotes: "제공된 레퍼런스의 행동 중심 전개만 참고한 테스트 기획이다.",
      viewerChange: "가방에 넣을지 손에 들지 고민하던 아침에 한 번에 결정할 수 있다.",
      mutedMessage: "내 가방에 들어가는지 먼저 보세요",
      stopReason: "가방과 텀블러를 양손에 들고 현관에서 멈칫하는 손이 바로 보인다.",
      scenePlan: [
        {
          scene: "현관에서 멈칫하는 손",
          source: "generated",
          reason: "실제 촬영본이 없어 상황 장면을 생성한다.",
          explanation: null,
        },
        {
          scene: "뚜껑을 끝까지 닫는 동작",
          source: "generated",
          reason: "동작이 설득력이라 영상 클립으로 만든다.",
          explanation: null,
        },
        {
          scene: "용량 500mL 카드",
          source: "graphic",
          reason: "확인된 숫자를 글자로 보여 준다.",
          explanation: null,
        },
      ],
    },
    copy: {
      voicePersona: "conversational",
      lines: [
        {
          text: "가방은 다 챙겼는데, 텀블러는 어디에 넣을지 고민되시죠?",
          screenText: "가방에 넣기 전 확인",
        },
        {
          text: "먼저 뚜껑을 여닫는 모습부터 천천히 살펴보세요.",
          screenText: "뚜껑은 어떻게 닫힐까?",
        },
        { text: "오백밀리리터를 담을 수 있어요.", screenText: "용량 500mL" },
        {
          text: "내 가방에 맞는 크기인지 제품 정보에서 확인해 보세요.",
          screenText: "내 가방과 크기 비교",
        },
      ],
    },
    copyReview: {
      status: "revised",
      summary: "작업용 메모와 번역체를 시청자에게 말하는 표현으로 바꿨습니다.",
      edits: [
        {
          lineIndex: 0,
          field: "screenText",
          before: "사용성 확인",
          after: "가방에 넣기 전 확인",
          reason: "무엇을 확인하는지 드러나도록 구체화했습니다.",
        },
        {
          lineIndex: 2,
          field: "narration",
          before: "오백밀리리터의 수용이 가능합니다.",
          after: "오백밀리리터를 담을 수 있어요.",
          reason: "명사 중심 번역체를 자연스러운 구어체로 바꿨습니다.",
        },
      ],
    },
  };
}
