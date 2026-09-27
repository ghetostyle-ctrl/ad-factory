import { spawn } from "node:child_process";
import { z } from "zod";
import { StudioError } from "./errors";

const ProbeSchema = z.object({
  format: z.object({ format_name: z.string(), duration: z.string().optional() }),
  streams: z.array(
    z.object({
      codec_type: z.string(),
      duration: z.string().optional(),
      width: z.number().int().positive().optional(),
      height: z.number().int().positive().optional(),
      disposition: z.object({ attached_pic: z.number().optional() }).optional(),
    }),
  ),
});

export async function probeProductionVideo(path: string, extension: string) {
  const { FFPROBE_PATH } = process.env;
  const output = await new Promise<string>((resolve, reject) => {
    const child = spawn(
      FFPROBE_PATH || "ffprobe",
      [
        "-v",
        "error",
        "-protocol_whitelist",
        "file",
        "-show_entries",
        "format=format_name,duration:stream=codec_type,width,height,duration:stream_disposition=attached_pic",
        "-of",
        "json",
        path,
      ],
      { windowsHide: true, shell: false, stdio: ["ignore", "pipe", "ignore"] },
    );
    let text = "";
    let limited = false;
    const timer = setTimeout(() => {
      limited = true;
      child.kill();
    }, 20_000);
    child.stdout.on("data", (chunk: Buffer) => {
      text += chunk.toString();
      if (text.length > 1_000_000) {
        limited = true;
        child.kill();
      }
    });
    child.once("error", () => {
      clearTimeout(timer);
      reject(
        new StudioError(
          "production_probe_unavailable",
          "영상 확인 도구 ffprobe를 실행할 수 없습니다.",
          503,
        ),
      );
    });
    child.once("close", (code) => {
      clearTimeout(timer);
      if (code !== 0 || limited)
        reject(
          new StudioError(
            "production_video_invalid",
            "영상 파일을 확인할 수 없습니다. 정상적인 MP4, MOV, WebM 파일을 선택하세요.",
            400,
          ),
        );
      else resolve(text);
    });
  });
  const measured = ProbeSchema.safeParse(JSON.parse(output));
  if (!measured.success)
    throw new StudioError("production_video_invalid", "영상 정보를 확인할 수 없습니다.", 400);
  const { format, streams } = measured.data;
  const video = streams.find(
    (stream) => stream.codec_type === "video" && stream.disposition?.attached_pic !== 1,
  );
  const durationSec = Number(format.duration ?? video?.duration);
  const supported =
    extension === "webm"
      ? format.format_name.split(",").includes("webm")
      : format.format_name.split(",").includes("mov");
  if (
    !supported ||
    !video?.width ||
    !video.height ||
    !Number.isFinite(durationSec) ||
    durationSec <= 0
  )
    throw new StudioError(
      "production_video_invalid",
      "길이와 화면 크기가 있는 MP4, MOV, WebM 영상만 사용할 수 있습니다.",
      400,
    );
  return {
    durationSec,
    width: video.width,
    height: video.height,
    hasAudio: streams.some((stream) => stream.codec_type === "audio"),
  };
}
