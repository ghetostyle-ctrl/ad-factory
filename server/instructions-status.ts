import { createHash } from "node:crypto";
import { readFileSync, statSync } from "node:fs";
import { basename, join } from "node:path";
import type { InstructionsFileStatus, InstructionsStatus } from "../shared/instructions-status";
import {
  defaultInstructionsRoot,
  INSTRUCTION_SECTIONS,
  InstructionsError,
  type InstructionsOptions,
  loadInstructions,
  type SectionSpec,
  THRESHOLDS_FILE,
} from "./instructions";
import { logger } from "./logger";

// GET /api/instructions 가 돌려주는 읽기 전용 상태(D6). 생성 경로와 같은 로더(root 별 캐시)를 쓰므로
// 마지막 성공본·경고가 생성이 보는 것과 같다. 첫 로드부터 실패한 경우에도 500 이 아니라 loaded=false 와 원인을 돌려준다.
const logged = new Set<string>();
// 같은 원인은 서버 로그에 1회만 남긴다(상태 조회가 반복돼도 로그가 쌓이지 않도록).
function warnOnce(message: string): void {
  if (logged.has(message)) return;
  logged.add(message);
  logger.warn({ reason: message }, "instructions.load_failed");
}
// 로드가 실패했을 때도 지금 폴더에 있는 파일은 보여 준다(어느 파일이 빠졌는지 알 수 있도록).
function presentFiles(root: string, specs: readonly SectionSpec[]): InstructionsFileStatus[] {
  const names = [THRESHOLDS_FILE, ...new Set(specs.map((spec) => spec.file))];
  const files: InstructionsFileStatus[] = [];
  for (const name of names) {
    try {
      const path = join(root, name);
      const stat = statSync(path);
      files.push({
        name,
        digest: createHash("sha256").update(readFileSync(path)).digest("hex"),
        size: stat.size,
        modifiedAt: new Date(stat.mtimeMs).toISOString(),
      });
    } catch {
      // 없는 파일은 목록에서 빠지고 warnings 가 이름을 말한다.
    }
  }
  return files;
}
export function instructionsStatus(
  options: InstructionsOptions = {},
  now: () => Date = () => new Date(),
): InstructionsStatus {
  const root = options.root ?? defaultInstructionsRoot();
  const specs = options.sections ?? INSTRUCTION_SECTIONS;
  const checkedAt = now().toISOString();
  const folder = basename(root);
  try {
    const snapshot = loadInstructions({ onWarning: warnOnce, ...options, root });
    return {
      folder,
      loaded: true,
      digest: snapshot.digest,
      loadedAt: snapshot.loadedAt,
      checkedAt,
      files: snapshot.files.map((file) => ({
        name: file.name,
        digest: file.digest,
        size: file.size,
        modifiedAt: new Date(file.mtimeMs).toISOString(),
      })),
      sections: specs.map((spec) => ({
        file: spec.file,
        key: spec.key,
        chars: snapshot.sections.get(spec.key)?.length ?? 0,
        runtime: [...(spec.runtime ?? [])],
        json: spec.json === true,
      })),
      thresholds: { ...snapshot.thresholds },
      thresholdDetails: Object.fromEntries(
        Object.entries(snapshot.thresholdEntries).map(([name, entry]) => [name, { ...entry }]),
      ),
      warnings: [...snapshot.warnings],
    };
  } catch (error) {
    const problems =
      error instanceof InstructionsError ? error.problems : [(error as Error).message];
    warnOnce(`지시 파일을 읽지 못했습니다(성공본 없음): ${problems.join(" / ")}`);
    return {
      folder,
      loaded: false,
      digest: null,
      loadedAt: null,
      checkedAt,
      files: presentFiles(root, specs),
      sections: [],
      thresholds: {},
      thresholdDetails: {},
      warnings: [...problems],
    };
  }
}
