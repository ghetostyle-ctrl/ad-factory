import { StudioError } from "./errors";

export function imageInput(bytes: Uint8Array): {
  readonly mimeType: string;
  readonly extension: string;
  readonly dataUrl: string;
} {
  if (bytes.length > 15 * 1024 * 1024)
    throw new StudioError("image_size", "AI 검토 이미지는 15MB 이하여야 합니다.");
  const png = bytes.slice(0, 8).join(",") === "137,80,78,71,13,10,26,10";
  const jpeg = bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255;
  if (!png && !jpeg)
    throw new StudioError("image_format", "AI 검토에 실제 PNG 또는 JPEG 이미지가 필요합니다.");
  const mimeType = png ? "image/png" : "image/jpeg";
  return {
    mimeType,
    extension: png ? "png" : "jpg",
    dataUrl: `data:${mimeType};base64,${Buffer.from(bytes).toString("base64")}`,
  };
}
