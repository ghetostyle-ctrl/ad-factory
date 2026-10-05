import { expect, test } from "bun:test";
import { graphicBackgrounds, type RenderCutInput } from "../server/render/graphic-background";
import type { TimelineCut } from "../shared/render-timeline";

function input(
  sourceRef: TimelineCut["sourceRef"],
  path: string | null,
  digest: string,
): RenderCutInput {
  return {
    sourcePath: path,
    sourceDigest: digest,
    cut: {
      index: 0,
      startMs: 0,
      endMs: 1200,
      purpose: "mechanism",
      source: "motion_graphic",
      effect: "hard_cut",
      onScreenText: "",
      caption: null,
      graphicKind: "number",
      graphicLines: ["600mg"],
      sourceRef,
    },
  };
}

test("graphics continue only an adjacent photograph and reset after videos or text cards", () => {
  const graphic = () => input({ kind: "graphic" }, null, "none");
  const first = input(
    { kind: "still", stillId: "S1", artifactName: "photo-1.png", offsetIndex: 0 },
    "photo-1.png",
    "photo-one",
  );
  const second = input(
    { kind: "still", stillId: "S2", artifactName: "photo-2.png", offsetIndex: 0 },
    "photo-2.png",
    "photo-two",
  );
  const source = [
    graphic(),
    first,
    graphic(),
    input({ kind: "image", artifactName: "card.png" }, "card.png", "text-card"),
    input({ kind: "veo", clipId: "A", offsetMs: 0, padMs: 0 }, "clip.mp4", "video"),
    graphic(),
    second,
    graphic(),
  ];
  const result = graphicBackgrounds(source);
  expect(
    result
      .filter((item) => item.cut.sourceRef.kind === "graphic")
      .map((item) => [item.sourcePath, item.sourceDigest]),
  ).toEqual([
    [null, "none"],
    ["photo-1.png", "photo-one"],
    [null, "none"],
    ["photo-2.png", "photo-two"],
  ]);
  expect(result[1]).toBe(first);
  expect(result[6]).toBe(second);
  expect(source[0]?.sourcePath).toBeNull();
});

test("graphic backgrounds count toward the four-second image budget including later cuts", () => {
  const photo = () =>
    input(
      { kind: "still", stillId: "S1", artifactName: "photo.png", offsetIndex: 0 },
      "photo.png",
      "same-pixels",
    );
  const graphic = () => input({ kind: "graphic" }, null, "none");
  const source = [photo(), graphic(), graphic(), photo()];
  const result = graphicBackgrounds(source);
  expect(result.map((item) => item.sourcePath)).toEqual([
    "photo.png",
    "photo.png",
    null,
    "photo.png",
  ]);
  expect(result[1]?.sourceDigest).toBe("same-pixels");
  expect(result[2]?.sourceDigest).toBe("none");
  expect(source[1]?.sourcePath).toBeNull();
});

test("different still IDs with identical pixels share the same background exposure budget", () => {
  const source = [
    input(
      { kind: "still", stillId: "S1", artifactName: "one.png", offsetIndex: 0 },
      "one.png",
      "same-pixels",
    ),
    input({ kind: "graphic" }, null, "none"),
    input(
      { kind: "still", stillId: "S2", artifactName: "two.png", offsetIndex: 0 },
      "two.png",
      "same-pixels",
    ),
    input({ kind: "graphic" }, null, "none"),
  ];
  const result = graphicBackgrounds(source);
  expect(result[1]?.sourcePath).toBe("one.png");
  expect(result[3]).toMatchObject({ sourcePath: null, sourceDigest: "none" });
});

test("a leading graphic has a solid background when no earlier photograph exists", () => {
  const result = graphicBackgrounds([input({ kind: "graphic" }, null, "none")]);
  expect(result[0]).toMatchObject({ sourcePath: null, sourceDigest: "none" });
});
