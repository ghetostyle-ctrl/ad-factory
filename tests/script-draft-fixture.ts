import { AutomationEnrollment } from "../server/automation-enrollment";
import { generateVideoCopy } from "../server/copy-writer";
import { writeVideoScript } from "../server/script-writer";
import { prepareVideoPlanning } from "../server/video-planning";
import { generateVideoScript, reviewVideoScript } from "../server/video-scripts";
import { hfLabelFixture } from "./hf-label-fixture";
import { response } from "./provider-fixtures";
import { planningHttpFixture } from "./video-planning-http-fixture";
import { hybridScriptResponse } from "./video-script-fixture";

export function scriptDraftFixture(mode: "repair" | "overlap" | "second-invalid" | "layout") {
  const fixture = planningHttpFixture();
  new AutomationEnrollment(fixture.store).start(fixture.job.id, {
    mode: "creative",
    imageCount: 1,
    videoCount: 1,
    clipMode: "flow",
    scriptApproval: "auto",
  });
  const base = hybridScriptResponse();
  const value = {
    ...base,
    infoClips: base.infoClips.map((clip) => ({
      ...clip,
      labelLayer: hfLabelFixture(
        clip.infoLines.length,
        clip.objects.map((o) => o.subjectId),
      ),
    })),
  };
  const pristine = structuredClone(value);
  const clip = value.infoClips[0],
    label = clip?.labelLayer.labels[0];
  if (!clip || !label) throw new TypeError("Missing label");
  if (mode === "repair") {
    label.box.x = 0.7;
    label.box.y = 0.8;
    label.startSec = 6.8;
    label.fullSec = 7;
    label.endSec = 8;
  } else if (mode === "layout") {
    clip.infoLines[0] = "라".repeat(24);
  } else {
    clip.infoLines.push("다른 문구");
    clip.labelLayer.labels.push({ ...structuredClone(label), lineIndex: 1 });
  }
  let calls = 0;
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: () => {
      calls++;
      return response(mode === "second-invalid" && calls === 1 ? pristine : value);
    },
  });
  const connection = { baseUrl: "http://127.0.0.1:" + server.port + "/", apiKey: "fixture" };
  const providers = {
    videoPlanning: (task: Parameters<typeof prepareVideoPlanning>[0]) =>
      prepareVideoPlanning(task, fixture.connection),
    videoCopy: (task: Parameters<typeof generateVideoCopy>[0]) =>
      generateVideoCopy(task, fixture.connection),
    videoScript: (...args: Parameters<typeof generateVideoScript>) =>
      generateVideoScript(
        args[0],
        args[1],
        args[2],
        args[3],
        args[4],
        connection,
        args[6],
        args[7],
      ),
    reviewVideoScript: async (task: Parameters<typeof reviewVideoScript>[0]) => {
      const result = await reviewVideoScript(task, fixture.connection);
      return mode === "second-invalid"
        ? {
            ...result,
            value: {
              ...result.value,
              status: "revise" as const,
              summary: "첫 초안을 더 자연스럽게 다듬어 주세요.",
            },
          }
        : result;
    },
  };
  return {
    ...fixture,
    value,
    providers,
    calls: () => calls,
    write: () =>
      writeVideoScript({
        store: fixture.store,
        providers,
        id: fixture.job.id,
        number: 1,
        hypothesis: fixture.hypothesis,
        durationSec: 36,
        signal: fixture.task.signal,
      }),
    close: () => {
      server.stop(true);
      fixture.close();
    },
  };
}
