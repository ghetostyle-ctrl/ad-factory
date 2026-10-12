import type { AgentId, Job } from "../shared/schema";
import { FilesTab } from "./FilesTab";

// 파일 탭(UI v2 ⑥-A). App 이 쓰는 이름과 props 는 그대로 두고 본문은 FilesTab 이 그린다.
export function Artifacts({
  job,
  filter,
  onRefresh,
}: {
  readonly job: Job | null;
  readonly filter: AgentId | null;
  readonly onRefresh: () => void;
}) {
  return <FilesTab job={job} filter={filter} onRefresh={onRefresh} />;
}
