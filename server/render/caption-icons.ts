import type { CaptionIcon } from "../../shared/caption-direction";
import { assColor, assDialogue } from "./ass-primitives";

const paths = {
  leaf: "m 10 78 b 8 33 42 10 91 8 b 95 60 72 91 27 89 l 12 97 7 91 68 29 61 28 10 78",
  drop: "m 50 3 b 38 28 13 47 13 67 b 13 106 88 106 88 67 b 88 47 62 28 50 3",
  capsule:
    "m 11 52 l 52 11 b 73 -10 109 27 89 48 l 48 89 b 26 111 -11 74 11 52 m 25 51 l 49 75 79 45 b 90 34 65 10 55 21 l 25 51",
  bottle:
    "m 34 4 l 66 4 66 19 60 19 60 29 b 79 35 83 43 83 58 l 83 92 b 83 97 78 99 72 99 l 28 99 b 22 99 17 97 17 92 l 17 58 b 17 43 21 35 40 29 l 40 19 34 19 34 4 m 29 56 l 29 81 71 81 71 56 29 56",
  store:
    "m 8 30 l 20 6 80 6 92 30 92 40 85 46 85 95 15 95 15 46 8 40 8 30 m 28 52 l 28 82 47 82 47 52 28 52 m 58 52 l 58 75 75 75 75 52 58 52",
  clock:
    "m 50 3 b 114 3 114 97 50 97 b -14 97 -14 3 50 3 m 50 15 b 1 15 1 85 50 85 b 99 85 99 15 50 15 m 46 24 l 54 24 54 46 74 59 69 67 46 51 46 24",
  coin: "m 50 3 b 114 3 114 97 50 97 b -14 97 -14 3 50 3 m 50 14 b 2 14 2 86 50 86 b 98 86 98 14 50 14 m 26 31 l 36 31 41 57 47 37 54 37 60 57 65 31 75 31 65 73 57 73 50 52 43 73 35 73 26 31",
} as const satisfies Record<Exclude<CaptionIcon, "none">, string>;
const slash = String.fromCharCode(92);
export function captionIconEvent(input: {
  readonly icon: CaptionIcon;
  readonly x: number;
  readonly y: number;
  readonly size: number;
  readonly color: string;
  readonly startMs: number;
  readonly endMs: number;
}): string[] {
  if (input.icon === "none") return [];
  const t = (name: string, value: string | number = "") => `${slash}${name}${value}`;
  return [
    assDialogue({
      startMs: input.startMs,
      endMs: input.endMs,
      style: "Caption",
      layer: 1,
      text: `{${t("an7")}${t("pos", `(${Math.round(input.x)},${Math.round(input.y)})`)}${t("p1")}${t("bord", 3)}${t("shad", 1)}${t("fscx", input.size)}${t("fscy", input.size)}${t("c", `${assColor(input.color)}&`)}${t("3c", "&HF5FDFF&")}${t("fad", "(100,0)")}}${paths[input.icon]}{${t("p0")}}`,
    }),
  ];
}
