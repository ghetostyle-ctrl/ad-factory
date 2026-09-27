import type { ProductionSourceSnapshot } from "../shared/production-manifest";
import { ProductionAssets } from "./production-assets";
import type { ProjectStore } from "./project-store";

export function captureProductionSources(
  library: ProjectStore,
  root: string,
  projectId: string,
): ProductionSourceSnapshot {
  const project = library.getProject(projectId);
  return {
    projectId: project.id,
    projectName: project.name,
    revision: project.revision,
    capturedAt: new Date().toISOString(),
    assets: new ProductionAssets(library, root).list(projectId),
  };
}
