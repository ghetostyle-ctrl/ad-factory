import { lazy, Suspense } from "react";
import type { Job, StudioState } from "../shared/schema";
import type { ProjectId } from "../shared/sources";
import { Dialog, Notice } from "./primitives";

const AccountDialog = lazy(() =>
  import("./AccountDialog").then((module) => ({ default: module.AccountDialog })),
);
const CreateJobDialog = lazy(() =>
  import("./CreateJobDialog").then((module) => ({ default: module.CreateJobDialog })),
);
const SettingsDialog = lazy(() =>
  import("./SettingsDialog").then((module) => ({ default: module.SettingsDialog })),
);
export type StudioModal = "create" | "settings" | "account" | "edit" | null;

export function StudioDialogs({
  modal,
  state,
  job,
  projectId,
  onClose,
  onCreated,
  onSaved,
}: {
  readonly modal: StudioModal;
  readonly state: StudioState | null;
  readonly job: Job | null;
  readonly projectId: ProjectId | null;
  readonly onClose: () => void;
  readonly onCreated: (job: Job) => void;
  readonly onSaved: () => void;
}) {
  return (
    <Suspense
      fallback={
        <Dialog title="화면을 준비하고 있어요" onClose={onClose}>
          <Notice>필요한 화면을 불러오고 있습니다…</Notice>
        </Dialog>
      }
    >
      {modal === "create" && (
        <CreateJobDialog
          projects={state?.projects ?? []}
          projectId={projectId}
          onClose={onClose}
          onCreated={onCreated}
        />
      )}
      {modal === "edit" && job && (
        <CreateJobDialog
          job={job}
          projects={state?.projects ?? []}
          projectId={job.projectId}
          onClose={onClose}
          onCreated={onCreated}
        />
      )}
      {modal === "settings" && state && (
        <SettingsDialog config={state.config} onClose={onClose} onSaved={onSaved} />
      )}
      {modal === "account" && job && (
        <AccountDialog job={job} onClose={onClose} onSaved={onSaved} />
      )}
    </Suspense>
  );
}
