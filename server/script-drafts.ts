import { ZodError, z } from "zod";
import type { ArtifactModel } from "../shared/models";
import { SCRIPT_DRAFT_WAIT_PREFIX } from "../shared/script-drafts";
import type { VideoScript } from "../shared/video-script";
import { Artifacts } from "./artifacts";
import { StudioError, WaitingError } from "./errors";
import type { JobStore } from "./store";
import type { TextResponse } from "./text-response";
import type { VideoScriptWritten } from "./video-scripts";

export class ScriptDrafts {
  private readonly assets: Artifacts;
  private readonly suffix: string;
  private captured = false;
  constructor(
    readonly store: JobStore,
    readonly id: string,
    readonly number: number,
  ) {
    this.assets = new Artifacts(store);
    let attempt = 1;
    const names = new Set(store.get(id).artifacts.map((a) => a.name));
    while (
      ["response", "draft", "issues"].some((kind) =>
        names.has("video-script-" + kind + "-" + number + "-" + attempt + ".json"),
      )
    )
      attempt++;
    this.suffix = number + "-" + attempt + ".json";
  }
  readonly capture = async (response: TextResponse): Promise<void> => {
    await this.assets.save(this.id, {
      name: "video-script-response-" + this.suffix,
      kind: "json",
      agentId: "creative",
      content: response.text,
      model: response.model,
    });
    this.captured = true;
  };
  async write(run: () => Promise<VideoScriptWritten>): Promise<VideoScriptWritten> {
    try {
      return await run();
    } catch (error) {
      if (
        !this.captured ||
        !(
          error instanceof ZodError ||
          error instanceof SyntaxError ||
          (error instanceof StudioError && error.code === "hf_label_layout")
        )
      )
        throw error;
      const issues =
        error instanceof ZodError
          ? error.issues.map((issue) => {
              const [field, clip, , , label] = issue.path;
              const location =
                field === "infoClips" && typeof clip === "number"
                  ? "설명 컷 " +
                    (clip + 1) +
                    (typeof label === "number" ? " · 라벨 " + (label + 1) : "")
                  : issue.path.join(".");
              return { path: issue.path.map(String), message: location + ": " + issue.message };
            })
          : [
              {
                path: [],
                message:
                  error instanceof StudioError
                    ? error.message
                    : "대본 응답의 JSON 문법을 읽지 못했습니다.",
              },
            ];
      await this.assets.save(this.id, {
        name: "video-script-issues-" + this.suffix,
        kind: "json",
        agentId: "creative",
        content: JSON.stringify({
          number: this.number,
          responseName: "video-script-response-" + this.suffix,
          issues,
        }),
      });
      const previous = this.store
        .get(this.id)
        .artifacts.some((a) => a.name.startsWith("video-script-draft-" + this.number + "-"));
      throw new WaitingError(
        SCRIPT_DRAFT_WAIT_PREFIX +
          " · 영상 " +
          this.number +
          ". " +
          issues
            .slice(0, 8)
            .map((issue) => issue.message)
            .join(" / ") +
          " 응답 원문을 작업 결과물에 보관했습니다." +
          (previous ? " 이전 대본 초안도 남아 있습니다." : "") +
          " 다시 생성하면 API 비용이 발생합니다.",
        () => false,
      );
    }
  }
  async save(script: VideoScript, model: ArtifactModel): Promise<void> {
    await this.assets.save(this.id, {
      name: "video-script-draft-" + this.suffix,
      kind: "json",
      agentId: "creative",
      content: JSON.stringify(script),
      model,
    });
  }
}

export async function scriptDraftFeedback(
  store: JobStore,
  id: string,
  number: number,
): Promise<string | null> {
  const issue = store
    .get(id)
    .artifacts.findLast((a) => a.name.startsWith("video-script-issues-" + number + "-"));
  if (!issue) return null;
  const saved = z
    .object({ issues: z.array(z.object({ message: z.string() })) })
    .parse(await (await new Artifacts(store).read(id, issue.name)).json());
  return (
    "이전 대본 초안의 형식 오류를 수정하세요. 확정 카피는 그대로 유지하세요: " +
    saved.issues.map((item) => item.message).join(" / ")
  );
}
