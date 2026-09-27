import { ChartNoAxesCombined, Image, Lightbulb, NotebookPen, Send } from "lucide-react";
import type { AgentId } from "../shared/schema";

export const agentMeta = {
  strategy: {
    title: "전략",
    role: "Strategy",
    description: "제품의 강점과 타깃을 광고 전략으로",
    icon: Lightbulb,
  },
  creative: {
    title: "기획",
    role: "Creative",
    description: "메시지, 카피, 이미지 제작 방향 설계",
    icon: NotebookPen,
  },
  production: {
    title: "제작",
    role: "Production",
    description: "기획을 바탕으로 실제 광고 이미지 제작",
    icon: Image,
  },
  deployment: {
    title: "게시",
    role: "Deployment",
    description: "Meta 광고 준비와 게시 전 검토",
    icon: Send,
  },
  analysis: {
    title: "분석",
    role: "Analytics",
    description: "집행된 광고의 실제 성과를 확인",
    icon: ChartNoAxesCombined,
  },
} as const satisfies Record<AgentId, unknown>;

export type View = "overview" | "sources" | "success-ai" | "artifacts" | "review" | "analysis";
