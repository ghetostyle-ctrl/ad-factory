import { expect, test } from "bun:test";
import { ProductionAssetSchema } from "../shared/production-assets";
import {
  buildProductionManifest,
  ProductionSourceSnapshotSchema,
} from "../shared/production-manifest";

const projectId = "75cd9c51-b7ba-45eb-a261-f44ccad732c6";
const clip = ProductionAssetSchema.parse({
  id: "51754b31-fbf3-4dca-acfd-9cd6f2d5a92a",
  projectId,
  title: "제품 사용 장면",
  filename: "사용법.mp4",
  contentType: "video/mp4",
  bytes: 1200,
  sha256: "a".repeat(64),
  durationSec: 12,
  width: 320,
  height: 180,
  hasAudio: true,
  createdAt: "2026-09-26T01:00:00.000Z",
  updatedAt: "2026-09-26T01:00:00.000Z",
  settings: {
    usage: "required",
    startSec: 3,
    endSec: 8,
    placement: "middle",
    targets: { mode: "selected", videoNumbers: [1, 10] },
    audio: "keep",
    notes: "제품 사용하는 손을 보여주세요.",
  },
});
const snapshot = ProductionSourceSnapshotSchema.parse({
  projectId,
  projectName: "제품 프로젝트",
  revision: 3,
  capturedAt: "2026-09-26T02:00:00.000Z",
  assets: [clip],
});

test("routes a required clip only to its selected video numbers", () => {
  // Given: one mandatory clip assigned to videos 1 and 10.
  // When
  const manifest = buildProductionManifest(snapshot);
  // Then
  expect(manifest.videos).toHaveLength(10);
  expect(
    manifest.videos.filter((video) => video.requiredClips.length).map((video) => video.videoNumber),
  ).toEqual([1, 10]);
  expect(manifest.videos[0]?.requiredClips[0]).toMatchObject({
    assetId: clip.id,
    sha256: clip.sha256,
    startSec: 3,
    endSec: 8,
    placement: "middle",
    audio: "keep",
    fileUrl: `/api/projects/${projectId}/production-assets/${clip.id}/file`,
  });
  expect(manifest.status).toBe("awaiting_video_renderer");
});

test("offers a full-length optional clip to every video without making it mandatory", () => {
  // Given
  const input = ProductionSourceSnapshotSchema.parse({
    ...snapshot,
    assets: [{ ...clip, settings: { usage: "optional", targets: { mode: "all" } } }],
  });
  // When
  const manifest = buildProductionManifest(input);
  // Then
  for (const video of manifest.videos) {
    expect(video.requiredClips).toEqual([]);
    expect(video.optionalClips).toHaveLength(1);
    expect(video.optionalClips[0]).toMatchObject({ startSec: 0, endSec: 12, audio: "mute" });
  }
});

test("preserves separate required and optional instructions for the same output", () => {
  // Given
  const optional = ProductionAssetSchema.parse({
    ...clip,
    id: "a2b0d6b7-e8a1-46b4-9ecb-b2f3d3e06c65",
    settings: { usage: "optional" },
  });
  // When
  const manifest = buildProductionManifest({ ...snapshot, assets: [clip, optional] });
  // Then
  expect(manifest.videos[0]?.requiredClips.map((asset) => asset.assetId)).toEqual([clip.id]);
  expect(manifest.videos[0]?.optionalClips.map((asset) => asset.assetId)).toEqual([optional.id]);
  expect(manifest.videos[1]?.requiredClips).toEqual([]);
});
