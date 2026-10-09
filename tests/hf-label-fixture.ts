export function hfLabelFixture(count = 1, targets = ["capsule"]) {
  return {
    version: "hyperframes_v1" as const,
    coordinateSpace: "source_1080x1920" as const,
    tracking: "planned" as const,
    veoGraphics: ["Transparent shell contours and structural guides reveal the oil cavity."],
    labels: Array.from({ length: count }, (_, index) => ({
      lineIndex: index,
      role: "primary" as const,
      targetId: targets[index % targets.length] ?? "capsule",
      targetDescription: "The visible oil inside the opened capsule",
      box: {
        x: 0.1,
        y: 0.52 + index * 0.1,
        width: 0.8,
        height: 0.075,
      },
      fontSizePx: 68,
      textColor: "#FFFDF5",
      plateColor: "#3E4A22",
      lineColor: "#243828",
      startSec: 1.5,
      fullSec: 2,
      endSec: 8,
      connector: "line" as const,
      elbow: { x: count === 1 ? 0.75 : 0.26 + index * 0.47, y: 0.59 },
      anchors: [
        { atSec: 0, x: 0.48, y: 0.43 },
        { atSec: 8, x: 0.51, y: 0.42 },
      ],
    })),
  };
}
