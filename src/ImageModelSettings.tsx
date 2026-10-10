import { useState } from "react";
import { imageModelPresets, type ModelSettings } from "../shared/models";
import { Field, Notice } from "./primitives";
export function ImageModelSettings({ settings }: { readonly settings: ModelSettings }) {
  const [provider, setProvider] = useState(settings.imageProvider ?? "openai");
  const [model, setModel] = useState(settings.imageModel);
  const [quality, setQuality] = useState<string>(settings.imageQuality);
  const extended = model === "gpt-image-2.5-sunburst" || model === "gpt-image-2.5-flare";
  return (
    <section className="stack" aria-label="이미지 제작 방식 선택">
      <h3>이미지 제작</h3>
      <Field label="이미지 제작 방식" help="글쓰기 AI와 별도로 선택하며, 새 작업부터 적용됩니다.">
        <select
          name="imageProvider"
          value={provider}
          onChange={(event) => setProvider(event.target.value === "flow" ? "flow" : "openai")}
        >
          <option value="openai">OpenAI · 자동 생성</option>
          <option value="flow">Google Flow · 제작 후 업로드</option>
        </select>
      </Field>
      {provider === "flow" ? (
        <Notice>
          앱이 대표·카드·정지·시작 이미지의 프롬프트와 참조 이미지를 제공합니다. Flow에서 만든
          결과를 확인하고 작업 화면에 올리면 검토 후 다음 단계로 이어집니다. Flow 화면 조작은 직접
          진행하며 생성 비용은 Flow에서 확인하세요. 설명 컷 CLEAN·INFO는 영상 카드의 기존 업로드
          항목을 사용합니다.
        </Notice>
      ) : (
        <>
          <Field label="이미지 모델 ID" help="프리셋 또는 사용 가능한 모델 ID를 입력하세요.">
            <input
              name="imageModel"
              required
              list="image-models"
              value={model}
              onChange={(event) => {
                const value = event.target.value;
                setModel(value);
                if (
                  !["gpt-image-2.5-sunburst", "gpt-image-2.5-flare"].includes(value) &&
                  ["xhigh", "max"].includes(quality)
                )
                  setQuality("high");
              }}
              autoComplete="off"
              spellCheck={false}
            />
            <datalist id="image-models">
              {imageModelPresets.map((value) => (
                <option key={value} value={value} />
              ))}
            </datalist>
          </Field>
          <Field label="이미지 품질">
            <select
              name="imageQuality"
              value={quality}
              onChange={(event) => setQuality(event.target.value)}
            >
              <option value="auto">자동</option>
              <option value="low">낮음 · low</option>
              <option value="medium">중간 · medium</option>
              <option value="high">높음 · high</option>
              {extended && (
                <>
                  <option value="xhigh">매우 높음 · xhigh</option>
                  <option value="max">최대 · max</option>
                </>
              )}
            </select>
          </Field>
          <p className="muted small-copy">모델 사용 가능 여부는 실제 API 응답으로 확인됩니다.</p>
        </>
      )}
    </section>
  );
}
