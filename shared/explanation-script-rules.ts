import type { VideoScript } from "./video-script";
import { voiceCutRange } from "./video-script";

export function explanationScriptProblems(script: VideoScript): string[] {
  const problems: string[] = [];
  const plans = (script.planning?.concept.scenePlan ?? []).flatMap((scene) =>
    scene.source === "info_clip" && scene.explanation ? [scene.explanation] : [],
  );
  for (const plan of plans) {
    const clips = script.infoClips.filter((clip) => clip.explanation?.id === plan.id);
    if (clips.length !== 1)
      problems.push(`설명 계획 ${plan.id}는 하나의 INFO 클립에 그대로 연결해야 합니다.`);
    for (const clip of clips) {
      const actual = clip.explanation;
      if (!actual) continue;
      const sameEntities =
        actual.entities.length === plan.entities.length &&
        plan.entities.every((entity) =>
          actual.entities.some(
            (item) => item.id === entity.id && item.representation === entity.representation,
          ),
        );
      const sameBeats =
        actual.beats.length === plan.beats.length &&
        plan.beats.every((beat) => actual.beats.some((item) => item.id === beat.id));
      if (!sameEntities || !sameBeats)
        problems.push(`${clip.id}: 기획의 설명 대상·동작 ID와 표현 종류를 유지하세요.`);
    }
  }
  const bindings = new Set<string>();
  for (const [index, voice] of script.voiceover.entries()) {
    const range = voiceCutRange(voice, script.cuts);
    const cuts = range ? script.cuts.slice(range[0], range[1] + 1) : [];
    const visible = script.infoClips.filter((clip) =>
      cuts.some((cut) => cut.source === "veo_clip" && cut.veoClip === clip.id),
    );
    const sync = voice.actionSync;
    if (sync) {
      const clip = visible.find((item) => item.id === sync.clipId);
      const beat = clip?.explanation?.beats.find((item) => item.id === sync.beatId);
      const key = `${sync.clipId}/${sync.beatId}`;
      if (!beat) problems.push(`${index + 1}번째 문장의 설명 동작 ${key}가 해당 컷에 없습니다.`);
      else if (!voice.text.replace(/\s+/g, " ").includes(beat.narrationCue.replace(/\s+/g, " ")))
        problems.push(`${index + 1}번째 문장에 동작 연결 어구 '${beat.narrationCue}'가 없습니다.`);
      if (bindings.has(key)) problems.push(`설명 동작 ${key}를 여러 문장에 중복 연결했습니다.`);
      bindings.add(key);
    }
    for (const callout of voice.callouts) {
      if (!callout.targetId) continue;
      const target = callout.targetId;
      if (
        !visible.some((clip) => clip.explanation?.entities.some((entity) => entity.id === target))
      )
        problems.push(`${index + 1}번째 문장의 설명 표시 대상 ${target}가 화면 계획에 없습니다.`);
    }
  }
  for (const clip of script.infoClips) {
    const explanation = clip.explanation;
    if (plans.length && (!explanation || !plans.some((plan) => plan.id === explanation.id)))
      problems.push(`${clip.id}: 기획에서 정한 설명 계획을 연결하세요.`);
    if (!explanation) continue;
    for (const beat of explanation.beats)
      if (!bindings.has(`${clip.id}/${beat.id}`))
        problems.push(`${clip.id}/${beat.id}: 설명 동작과 내레이션 문장을 연결하세요.`);
  }
  return problems;
}
