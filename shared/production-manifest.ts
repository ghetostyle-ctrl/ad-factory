import { z } from "zod";
import { type ProductionAsset, ProductionAssetSchema } from "./production-assets";
import { ProjectIdSchema } from "./sources";

export const ProductionSourceSnapshotSchema = z.strictObject({
  projectId: ProjectIdSchema,
  projectName: z.string(),
  revision: z.number().int().positive(),
  capturedAt: z.iso.datetime(),
  assets: z.array(ProductionAssetSchema),
});
export type ProductionSourceSnapshot = z.infer<typeof ProductionSourceSnapshotSchema>;

function appliesTo(asset: ProductionAsset, videoNumber: number): boolean {
  const target = asset.settings.targets;
  switch (target.mode) {
    case "all":
      return true;
    case "selected":
      return target.videoNumbers.includes(videoNumber);
  }
}

function directive(asset: ProductionAsset) {
  return {
    assetId: asset.id,
    title: asset.title,
    filename: asset.filename,
    sha256: asset.sha256,
    fileUrl: `/api/projects/${asset.projectId}/production-assets/${asset.id}/file`,
    startSec: asset.settings.startSec,
    endSec: asset.settings.endSec ?? asset.durationSec,
    placement: asset.settings.placement,
    audio: asset.settings.audio,
    notes: asset.settings.notes,
  };
}

export function buildProductionManifest(snapshot: ProductionSourceSnapshot) {
  return {
    schemaVersion: 1,
    status: "awaiting_video_renderer",
    projectId: snapshot.projectId,
    projectName: snapshot.projectName,
    revision: snapshot.revision,
    capturedAt: snapshot.capturedAt,
    videoCount: 10,
    videos: Array.from({ length: 10 }, (_, index) => {
      const videoNumber = index + 1;
      const assets = snapshot.assets.filter((asset) => appliesTo(asset, videoNumber));
      return {
        videoNumber,
        requiredClips: assets.filter((asset) => asset.settings.usage === "required").map(directive),
        optionalClips: assets.filter((asset) => asset.settings.usage === "optional").map(directive),
      };
    }),
  } as const;
}
