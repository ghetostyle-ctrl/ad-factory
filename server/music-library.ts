import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import type { PolicyBgm } from "../shared/automation";
import { StudioError } from "./errors";

// 로열티프리 BGM 라이브러리. render 단계에서 유료·네트워크 호출 없이 manifest 만 읽어 결정론으로 고른다.
// 트랙 파일은 사용자가 라이선스를 확인해 넣고 manifest 에 출처를 기록한다(저장소에는 양식만).
export const MusicMoodSchema = z.enum(["calm", "warm", "tense", "upbeat"]);
export type MusicMood = z.infer<typeof MusicMoodSchema>;
export const MusicTrackSchema = z
  .object({
    id: z.string().trim().min(1).max(120),
    file: z.string().trim().min(1).max(240),
    mood: MusicMoodSchema,
    bpm: z.number().int().positive().max(300),
    integratedLufs: z.number().finite(),
    license: z
      .object({
        name: z.string().trim().min(1).max(200),
        url: z.string().trim().max(2000).default(""),
        attribution: z.string().trim().max(500).default(""),
      })
      .strict(),
  })
  .strict();
export const MusicManifestSchema = z.array(MusicTrackSchema).max(500);
export type MusicTrack = z.infer<typeof MusicTrackSchema> & { readonly path: string };

export const BUNDLED_BGM_DIR = resolve(fileURLToPath(new URL("../assets/bgm/", import.meta.url)));
// 가설 인식 단계 → 무드. TOFU 는 긴장감, MOFU 는 따뜻함, BOFU 는 경쾌함, 없으면 차분함.
export function moodForRole(decisionRole: string | undefined): MusicMood {
  switch (decisionRole) {
    case "need_awareness":
      return "tense";
    case "comparison":
      return "warm";
    case "final_decision":
      return "upbeat";
    default:
      return "calm";
  }
}
// videoTargetSeconds 와 같은 FNV-1a 해시: 재실행·재개 시 같은 곡이 나온다.
export function fnvIndex(key: string, size: number): number {
  let hash = 2166136261;
  for (const char of key) {
    hash ^= char.charCodeAt(0);
    hash = Math.imul(hash, 16777619) >>> 0;
  }
  return size > 0 ? hash % size : 0;
}

export class MusicLibrary {
  readonly root: string;
  constructor(root?: string) {
    this.root = resolve(root || process.env["BGM_DIR"] || BUNDLED_BGM_DIR);
  }
  // manifest.json 이 없으면 빈 라이브러리. 있는데 형식이 틀리면 오류(조용히 무시하면 원인을 찾기 어렵다).
  list(): MusicTrack[] {
    const manifest = join(this.root, "manifest.json");
    if (!existsSync(manifest)) return [];
    let parsed: unknown;
    try {
      parsed = JSON.parse(readFileSync(manifest, "utf8"));
    } catch {
      throw new StudioError("bgm_manifest", `BGM manifest 를 읽을 수 없습니다: ${manifest}`);
    }
    const result = MusicManifestSchema.safeParse(parsed);
    if (!result.success)
      throw new StudioError(
        "bgm_manifest",
        `BGM manifest 형식이 맞지 않습니다: ${result.error.issues[0]?.message ?? "unknown"}`,
      );
    return result.data.map((track) => ({ ...track, path: join(this.root, track.file) }));
  }
  // 정책에 따라 트랙을 고른다. 후보가 없으면 null(경고로 완성, 실패 아님).
  pick(input: {
    readonly policy: PolicyBgm | undefined;
    readonly decisionRole?: string | undefined;
    readonly jobId: string;
    readonly number: number;
  }): { track: MusicTrack | null; warning: string | null } {
    const policy = input.policy ?? { mode: "auto" };
    if (policy.mode === "none") return { track: null, warning: null };
    const tracks = this.list().filter((track) => existsSync(track.path));
    if (policy.mode === "track") {
      const track = tracks.find((item) => item.id === policy.trackId) ?? null;
      return {
        track,
        warning: track
          ? null
          : `BGM 트랙 '${policy.trackId}' 을 라이브러리에서 찾지 못해 BGM 없이 완성합니다.`,
      };
    }
    if (tracks.length === 0)
      return {
        track: null,
        warning: "BGM 라이브러리가 비어 있어 BGM 없이 완성합니다(assets/bgm/manifest.json 참고).",
      };
    const mood = moodForRole(input.decisionRole);
    const candidates = tracks.filter((track) => track.mood === mood);
    const pool = candidates.length > 0 ? candidates : tracks;
    const track = pool[fnvIndex(`${input.jobId}:${input.number}`, pool.length)] ?? null;
    return {
      track,
      warning:
        candidates.length > 0 || !track
          ? null
          : `'${mood}' 무드 BGM 이 없어 다른 무드(${track.mood}) 트랙을 썼습니다.`,
    };
  }
}
