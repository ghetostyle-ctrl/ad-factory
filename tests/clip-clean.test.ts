import { expect, test } from "bun:test";
import { cleanCrop, cropFilter, parseCropdetect } from "../server/render/clip-clean";

const log = `[Parsed_cropdetect_0] x1:0 x2:719 y1:99 y2:1179 w:720 h:1080 x:0 y:100 pts:1 t:1.0 limit:0.094118 crop=720:1080:0:100
[Parsed_cropdetect_0] x1:0 x2:719 y1:99 y2:1179 w:720 h:1080 x:0 y:100 pts:2 t:1.1 limit:0.094118 crop=720:1080:0:100`;

test("cropdetect 로그에서 마지막 영역을 읽는다", () => {
  expect(parseCropdetect(log)).toEqual({ w: 720, h: 1080, x: 0, y: 100 });
  expect(parseCropdetect("아무 것도 없음")).toBeNull();
});

test("위아래 검은 띠가 있으면 띠만 자르고 워터마크 구간은 따로 자르지 않는다", () => {
  const crop = cleanCrop(
    { width: 720, height: 1280 },
    { w: 720, h: 1080, x: 0, y: 100 },
    { watermark: true },
  );
  expect(crop).toEqual({ x: 0, y: 100, w: 720, h: 1080 });
  expect(cropFilter(crop)).toBe("crop=720:1080:0:100");
});

test("검은 띠가 없는 Flow 클립은 아래쪽 워터마크 구간(7%)을 자른다", () => {
  const crop = cleanCrop(
    { width: 720, height: 1280 },
    { w: 720, h: 1280, x: 0, y: 0 },
    { watermark: true },
  );
  expect(crop).toEqual({ x: 0, y: 0, w: 720, h: 1190 });
  const none = cleanCrop({ width: 720, height: 1280 }, null, { watermark: false });
  expect(none).toEqual({ x: 0, y: 0, w: 720, h: 1280 });
});

test("프레임마다 흔들리는 검출값은 중앙값으로 누른다", () => {
  const rows = [
    "crop=720:1192:0:88",
    "crop=720:1080:0:100",
    "crop=720:1080:0:100",
    "crop=720:1080:0:100",
    "crop=720:1280:0:0",
  ].join("\n");
  expect(parseCropdetect(rows)).toEqual({ w: 720, h: 1080, x: 0, y: 100 });
});
