import { mkdir, mkdtemp, rename, rm } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import type { FlowImageRequest } from "../shared/flow-images";
import { StudioError } from "./errors";
import { imageInput } from "./provider-image-input";
import { runFfmpeg, runFfprobeJson } from "./render/ffmpeg";

const Dimensions = z.object({
  streams: z.array(z.object({ width: z.number(), height: z.number() })).min(1),
});
export async function saveFlowImageFile(input: {
  readonly directory: string;
  readonly bytes: Uint8Array;
  readonly aspect: FlowImageRequest["aspect"];
  readonly signal: AbortSignal;
}): Promise<Uint8Array> {
  imageInput(input.bytes);
  await mkdir(input.directory, { recursive: true });
  const temporary = await mkdtemp(join(input.directory, "upload-"));
  const source = join(temporary, "source");
  const output = join(temporary, "image.png");
  try {
    await Bun.write(source, input.bytes);
    const options = { signal: input.signal, timeoutMs: 30_000 };
    const info = Dimensions.parse(
      await runFfprobeJson(
        [
          "-v",
          "error",
          "-select_streams",
          "v:0",
          "-show_entries",
          "stream=width,height",
          "-of",
          "json",
          source,
        ],
        input.signal,
        30_000,
      ),
    );
    const size = info.streams[0];
    if (
      !size ||
      Math.min(size.width, size.height) < 256 ||
      Math.max(size.width, size.height) > 8192 ||
      size.width * size.height > 24_000_000
    )
      throw new StudioError(
        "flow_image_dimensions",
        "이미지는 가로·세로 256px 이상, 최대 8192px·2400만 화소 이하여야 합니다.",
        400,
      );
    const expected = input.aspect === "portrait" ? 9 / 16 : 1;
    if (Math.abs(size.width / size.height - expected) > 0.035)
      throw new StudioError(
        "flow_image_aspect",
        `이 이미지의 화면비는 ${input.aspect === "portrait" ? "9:16" : "1:1"}이어야 합니다. Flow에서 화면비를 확인하세요.`,
        400,
      );
    await runFfmpeg(
      ["-v", "error", "-y", "-i", source, "-frames:v", "1", "-update", "1", output],
      options,
    );
    const bytes = new Uint8Array(await Bun.file(output).arrayBuffer());
    imageInput(bytes);
    await rename(output, join(input.directory, "image.png"));
    return bytes;
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
}
