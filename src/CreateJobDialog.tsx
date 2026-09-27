import { ArrowRight, FileText } from "lucide-react";
import type { FormEvent } from "react";
import { useEffect, useRef, useState } from "react";
import type { Job } from "../shared/schema";
import { CreateJobSchema } from "../shared/schema";
import { type Project, ProjectDetailSchema, type ProjectId } from "../shared/sources";
import { api, errorMessage, postJob } from "./api";
import { Button, Dialog, Field, Notice } from "./primitives";

export function CreateJobDialog({
  job,
  projects,
  projectId,
  onClose,
  onCreated,
}: {
  readonly job?: Job;
  readonly projects: readonly Project[];
  readonly projectId: ProjectId | null;
  readonly onClose: () => void;
  readonly onCreated: (job: Job) => void;
}) {
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [selectedProject, setSelectedProject] = useState(projectId ?? "");
  const [name, setName] = useState(job?.name ?? "");
  const [productUrl, setProductUrl] = useState(job?.productUrl ?? "");
  const [productDescription, setProductDescription] = useState(job?.productDescription ?? "");
  const [prefillNotice, setPrefillNotice] = useState<string | null>(null);
  const lastPrefill = useRef({ name: "", productUrl: "" });
  useEffect(() => {
    if (job) return;
    if (!selectedProject) {
      const previous = lastPrefill.current;
      setName((current) => (current === previous.name ? "" : current));
      setProductUrl((current) => (current === previous.productUrl ? "" : current));
      lastPrefill.current = { name: "", productUrl: "" };
      setPrefillNotice(null);
      return;
    }
    const controller = new AbortController();
    void api
      .get(`projects/${selectedProject}`, { signal: controller.signal })
      .json()
      .then((value) => {
        if (controller.signal.aborted) return;
        const detail = ProjectDetailSchema.parse(value);
        const facts = detail.sources.filter(
          (source) =>
            source.kind === "product_fact" &&
            source.status === "eligible" &&
            source.contentStatus === "content" &&
            (!source.expiresAt || Date.parse(source.expiresAt) > Date.now()),
        );
        const fact = facts.find((source) => source.url) ?? facts[0];
        const references = detail.sources.filter(
          (source) =>
            source.kind === "reference" &&
            source.status === "eligible" &&
            source.contentStatus === "content",
        );
        const next = {
          name: `${detail.project.name} 광고 작업`,
          productUrl: fact?.url ?? "",
        };
        const previous = lastPrefill.current;
        setName((current) => (!current.trim() || current === previous.name ? next.name : current));
        setProductUrl((current) =>
          !current.trim() || current === previous.productUrl ? next.productUrl : current,
        );
        lastPrefill.current = next;
        setPrefillNotice(
          fact
            ? `사용 가능한 제품 사실 ${facts.length}건 · 광고 레퍼런스 ${Math.min(references.length, 5)}건을 참고합니다.`
            : "이 프로젝트에 사용 가능한 제품 사실이 없습니다. 자료 라이브러리에 제품 정보를 먼저 등록해 주세요.",
        );
      })
      .catch(async (cause: unknown) => {
        if (!controller.signal.aborted) setPrefillNotice(await errorMessage(cause));
      });
    return () => controller.abort();
  }, [selectedProject, job]);
  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    const parsed = CreateJobSchema.safeParse({
      name: data.get("name"),
      projectId: selectedProject || null,
      productUrl: data.get("productUrl"),
      productDescription: selectedProject ? "" : data.get("productDescription"),
      audience: selectedProject ? "" : data.get("audience"),
      ...(job && {
        objective: job.objective,
        dailyBudget: job.dailyBudget,
        currency: job.currency,
        country: job.country,
      }),
    });
    if (!parsed.success) {
      setError(
        selectedProject
          ? "작업 이름과 실제 광고 도착 페이지 URL을 확인해 주세요."
          : "입력 내용을 확인해 주세요. 제품 설명은 20자, 고객 설명은 5자 이상 필요합니다.",
      );
      return;
    }
    setPending(true);
    setError(null);
    try {
      const payload = job
        ? parsed.data
        : {
            name: parsed.data.name,
            projectId: parsed.data.projectId,
            productUrl: parsed.data.productUrl,
            productDescription: parsed.data.productDescription,
            audience: parsed.data.audience,
          };
      onCreated(await postJob(job ? `jobs/${job.id}/brief` : "jobs", payload));
    } catch (cause) {
      setError(await errorMessage(cause));
    } finally {
      setPending(false);
    }
  };
  return (
    <Dialog
      title={job ? "작업 브리프 수정" : "새 소재 작업"}
      description="프로젝트 자료를 분석해 광고안마다 다른 타깃·상황·메시지를 설계합니다."
      onClose={onClose}
      wide
    >
      <form
        className="stack"
        onSubmit={(event) => {
          void submit(event);
        }}
      >
        <div className="form-kicker">
          <FileText size={16} />
          <span>작업 브리프</span>
          <span className="muted">상품 자료 · 소재 기획·제작</span>
        </div>
        <Field
          label="사용할 프로젝트 자료"
          help="자료 라이브러리에서 제품 사실·후기·혜택·광고 레퍼런스를 먼저 모을 수 있습니다."
        >
          <select
            value={selectedProject}
            onChange={(event) => setSelectedProject(event.target.value)}
          >
            <option value="">프로젝트 없이 브리프만 사용</option>
            {projects.map((project) => (
              <option key={project.id} value={project.id}>
                {project.name} · 버전 {project.revision}
              </option>
            ))}
          </select>
        </Field>
        {selectedProject && (
          <Notice>
            저장 시 프로젝트 자료 버전을 고정합니다. 자동 운영을 시작하면 에이전트가 내 상품의
            확인된 정보와 광고 레퍼런스의 관측 구조를 분석해 소재별 타깃 오디언스와 상황을
            설계합니다. 이 단계에서는 광고 계정·예산·게시 설정을 하지 않습니다. {prefillNotice}
          </Notice>
        )}
        <Field label="작업 이름 (필수)">
          <input
            name="name"
            required
            minLength={2}
            maxLength={120}
            value={name}
            onChange={(event) => setName(event.target.value)}
            placeholder="예: 가을 신제품 첫 캠페인"
            autoComplete="off"
          />
        </Field>
        <Field label="상품 페이지 URL (필수)" help="상품 자료를 확인하는 데 사용합니다.">
          <input
            name="productUrl"
            type="url"
            required
            value={productUrl}
            onChange={(event) => setProductUrl(event.target.value)}
            placeholder="https://your-store.com/products/…"
          />
        </Field>
        {!selectedProject && (
          <>
            <Field
              label="제품 설명"
              help="프로젝트 없이 만들 때만 직접 입력합니다. 확인된 사실을 20자 이상 적어 주세요."
            >
              <textarea
                name="productDescription"
                required
                minLength={20}
                maxLength={12000}
                value={productDescription}
                onChange={(event) => setProductDescription(event.target.value)}
                placeholder="어떤 제품인가요? 고객이 알아야 할 특징과 차별점을 적어주세요."
              />
            </Field>
            <Field label="타깃 고객">
              <textarea
                name="audience"
                className="textarea-short"
                required
                minLength={5}
                maxLength={4000}
                defaultValue={job?.audience}
                placeholder="누구에게 필요한 제품인가요? 관심사, 상황, 구매 이유를 적어주세요."
              />
            </Field>
          </>
        )}
        <Notice>
          작업을 만든 뒤 소재 자동 제작을 시작하면 자료 분석, 소재별 타깃·상황·메시지 설계, 이미지
          제작과 검토를 진행합니다. Meta 광고 등록이나 집행은 시작하지 않습니다.
        </Notice>
        {job && (
          <Notice tone="warning">
            브리프를 수정하면 기존 전략·기획·생성 이미지가 초기화됩니다. 직접 업로드한 이미지는
            유지됩니다. 선택한 프로젝트의 현재 자료 버전을 다시 저장하며, 자동 운영을 시작한 작업은
            수정할 수 없습니다.
          </Notice>
        )}
        {error && <Notice tone="error">{error}</Notice>}
        <div className="form-actions">
          <Button onClick={onClose} disabled={pending}>
            취소
          </Button>
          <Button type="submit" variant="primary" pending={pending}>
            {job ? "수정 내용 저장" : "작업 만들기"} <ArrowRight size={16} />
          </Button>
        </div>
      </form>
    </Dialog>
  );
}
