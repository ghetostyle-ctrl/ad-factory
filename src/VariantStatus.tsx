import { Check, Image as ImageIcon } from "lucide-react";
import type { CreativeVariant } from "../shared/creative-plan";
import type { Job } from "../shared/schema";

function statusLabel(variant: CreativeVariant | undefined, job: Job): string {
  if (variant?.reviewStatus === "pass") return "이미지 검토 통과";
  const automation = job.automation;
  if (automation) {
    switch (automation.status) {
      case "attention":
        return "처리 결과 확인 필요";
      case "blocked":
        return "설정 대기";
      case "stopped":
        return "자동 운영 중지";
      case "completed":
        return "운영 종료";
      case "queued":
        return "실행 대기";
      case "waiting":
        return "다음 작업 대기";
      case "running": {
        const current = job.creativeVariants.find((item) => item.reviewStatus !== "pass");
        if (variant && current?.id === variant.id) {
          if (automation.phase === "image")
            return variant?.reviewStatus === "revise" ? "이미지 수정 중" : "이미지 제작 중";
          if (automation.phase === "review") return "이미지·카피 검토 중";
        }
        break;
      }
    }
  }
  if (variant?.reviewStatus === "revise") return "이미지 수정 필요";
  return variant?.imageAttempts ? "제작·검토 대기" : "이미지 제작 대기";
}

export function VariantStatus({
  variant,
  job,
}: {
  readonly variant: CreativeVariant | undefined;
  readonly job: Job;
}) {
  return (
    <div className="cluster">
      <span className={`badge badge-${variant?.reviewStatus === "pass" ? "success" : "neutral"}`}>
        {variant?.reviewStatus === "pass" ? <Check size={12} /> : <ImageIcon size={12} />}
        {statusLabel(variant, job)}
      </span>
      <span className="muted small-copy">실제 이미지 생성 {variant?.imageAttempts ?? 0}/2회</span>
    </div>
  );
}
