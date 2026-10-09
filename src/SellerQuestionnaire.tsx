import { type FormEvent, useState } from "react";
import { CreateSourceSchema, type ProjectId, ProjectSourceSchema } from "../shared/sources";
import { api, errorMessage } from "./api";
import { Button, Dialog, Field, Notice } from "./primitives";

// 판매자만 아는 정보를 묻는다(CREATIVE-PLANNING-DESIGN.md 6절). 누가 사는지·불편·망설임은 앱이
// 후기와 레퍼런스에서 먼저 뽑으므로 여기서 묻지 않는다. 모든 칸은 선택이며 답한 칸만 자료로 저장한다.
const factQuestions = [
  {
    name: "intro",
    label: "제품을 한 문장으로 소개해 주세요 (한글 제품명 포함)",
    placeholder: "예: 종근당 퓨어 엑스트라 버진 올리브 오일 캡슐, 한 캡슐 600mg, 30캡슐",
  },
  {
    name: "difference",
    label: "비슷한 제품과 비교해 무엇이 다른가요?",
    placeholder: "예: 제약회사가 제조, 엑스트라 버진 등급만 사용",
  },
  {
    name: "proof",
    label: "그 차이를 보여 줄 근거가 있나요? (원산지, 인증, 시험, 수상, 판매량 등)",
    placeholder: "예: 스페인산 원료, ○○ 인증, 누적 판매 ○만 개",
  },
  {
    name: "usage",
    label: "어떻게 사용(섭취)하나요? (시간, 양, 방법)",
    placeholder: "예: 하루 1회 1캡슐, 물과 함께",
  },
  {
    name: "brand",
    label: "브랜드나 제조사에 대해 말할 수 있는 이야기가 있나요?",
    placeholder: "예: 1941년 설립된 제약회사, GMP 시설에서 제조",
  },
  {
    name: "forbidden",
    label: "광고에서 쓰면 안 되는 표현이 있나요?",
    placeholder: "예: 효능·치료 표현 금지, '최고' 같은 최상급 표현 금지",
  },
] as const;
const categories = {
  general_food: "일반 식품 (효능·기능 표현 불가)",
  functional_food: "건강기능식품 (인정받은 기능 범위 안에서만)",
  cosmetic: "화장품",
  other: "기타 상품",
  unknown: "모름",
} as const;

export function SellerQuestionnaire({
  projectId,
  onClose,
  onSaved,
}: {
  readonly projectId: ProjectId;
  readonly onClose: () => void;
  readonly onSaved: () => void;
}) {
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    const text = (name: string) => String(data.get(name) ?? "").trim();
    const category = text("category") as keyof typeof categories;
    const lines = [
      ...factQuestions.flatMap((question) =>
        text(question.name) ? [`■ ${question.label}\n${text(question.name)}`] : [],
      ),
      ...(category && category !== "unknown"
        ? [
            `■ 제품 분류\n${categories[category]}${text("approvedFunction") ? ` · 인정 기능: ${text("approvedFunction")}` : ""}`,
          ]
        : []),
    ];
    const reviews = text("reviews")
      .split(/\n\s*\n/)
      .map((item) => item.trim())
      .filter(Boolean);
    const photos = data
      .getAll("photos")
      .filter((item): item is File => item instanceof File && item.size > 0);
    const drafts = [
      ...(lines.length || photos.length
        ? [
            {
              kind: "product_fact",
              title: "판매자 질문지",
              content: lines.join("\n\n") || "실제 제품·포장 사진",
            },
          ]
        : []),
      ...(text("offer")
        ? [{ kind: "offer", title: "가격·혜택 (판매자 입력)", content: text("offer") }]
        : []),
      ...reviews.map((content, index) => ({
        kind: "review",
        title: `${text("reviewOf") === "competitor" ? "경쟁 제품" : "우리 제품"} 후기 ${index + 1}`,
        content,
        reviewOf: text("reviewOf") === "competitor" ? "competitor" : "own",
      })),
    ];
    if (drafts.length === 0) {
      setError("답한 질문이 없습니다. 아는 것만 채워도 됩니다.");
      return;
    }
    const parsed = drafts.map((draft) => CreateSourceSchema.safeParse(draft));
    const invalid = parsed.find((item) => !item.success);
    if (invalid && !invalid.success) {
      setError(invalid.error.issues[0]?.message ?? "입력 내용을 확인해 주세요.");
      return;
    }
    setPending(true);
    setError(null);
    try {
      const path = `projects/${projectId}/sources`;
      for (const [index, item] of parsed.entries()) {
        if (!item.success) continue;
        const saved = ProjectSourceSchema.parse(await api.post(path, { json: item.data }).json());
        if (index === 0 && item.data.kind === "product_fact")
          for (const photo of photos) {
            const upload = new FormData();
            upload.append("files", photo);
            await api.post(`${path}/${saved.id}/files`, { body: upload }).json();
          }
      }
      onSaved();
      onClose();
    } catch (cause) {
      setError(await errorMessage(cause));
    } finally {
      setPending(false);
    }
  };
  return (
    <Dialog title="판매자 질문지" onClose={onClose} wide>
      <form
        className="stack"
        onSubmit={(event) => {
          void submit(event);
        }}
      >
        <Notice>
          아는 것만 채우세요. 누가 사는지·불편·망설임은 앱이 후기와 레퍼런스에서 먼저 찾습니다. 답은
          제품 사실·가격·혜택·고객 후기 자료로 저장되고, 저장 뒤에도 자료 목록에서 고칠 수 있습니다.
        </Notice>
        {factQuestions.map((question) => (
          <Field key={question.name} label={question.label}>
            <textarea
              name={question.name}
              rows={2}
              maxLength={3000}
              placeholder={question.placeholder}
            />
          </Field>
        ))}
        <div className="form-grid">
          <Field label="제품 분류" help="효능을 말할 수 있는지가 여기서 정해집니다.">
            <select name="category" defaultValue="unknown">
              {Object.entries(categories).map(([value, label]) => (
                <option key={value} value={value}>
                  {label}
                </option>
              ))}
            </select>
          </Field>
          <Field label="인정받은 기능 (건강기능식품만)">
            <input
              name="approvedFunction"
              maxLength={500}
              placeholder="예: 혈중 콜레스테롤 개선에 도움"
            />
          </Field>
        </div>
        <Field label="지금 진행 중인 가격·혜택 (선택)" help="종료일이 있으면 함께 적어 주세요.">
          <textarea name="offer" rows={2} maxLength={3000} placeholder="예: 10월 31일까지 2+1" />
        </Field>
        <Field
          label="고객 후기 붙여넣기 (선택)"
          help="후기 사이를 빈 줄로 띄우면 여러 건으로 나눠 저장합니다."
        >
          <textarea name="reviews" rows={5} maxLength={20000} />
        </Field>
        <Field
          label="붙여넣은 후기는 누구의 후기인가요?"
          help="경쟁 제품 후기는 고객의 불편·실패 경험·바라는 점을 찾는 데만 쓰고, 우리 상품의 후기로 쓰지 않습니다."
        >
          <select name="reviewOf" defaultValue="own">
            <option value="own">우리 제품 후기</option>
            <option value="competitor">경쟁 제품 후기</option>
          </select>
        </Field>
        <Field
          label="실제 제품·포장 사진 (선택)"
          help="AI가 포장을 상상해서 그리지 않도록 실제 모습을 보관합니다."
        >
          <input name="photos" type="file" accept="image/png,image/jpeg,image/webp" multiple />
        </Field>
        {error && <Notice tone="error">{error}</Notice>}
        <div className="form-actions">
          <Button onClick={onClose} disabled={pending}>
            취소
          </Button>
          <Button type="submit" variant="primary" pending={pending}>
            저장
          </Button>
        </div>
      </form>
    </Dialog>
  );
}
