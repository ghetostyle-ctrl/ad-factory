import { Plus } from "lucide-react";
import { useState } from "react";
import { Button, Dialog, Field, Notice, StatusBadge } from "./primitives";
export function Showcase() {
  const [open, setOpen] = useState(false);
  return (
    <main className="showcase stack">
      <h1>Studio · component states</h1>
      <p className="muted">UI 확인용 화면 · 실제 작업 데이터와 분리됩니다.</p>
      <section className="panel panel-body stack">
        <h2>Actions</h2>
        <div className="cluster">
          <Button variant="primary">
            <Plus size={16} />새 작업 만들기
          </Button>
          <Button>새로고침</Button>
          <Button variant="ghost">설정 보기</Button>
          <Button disabled>게시 승인</Button>
          <Button pending>저장 중</Button>
          <Button variant="danger">작업 중지</Button>
          <Button onClick={() => setOpen(true)}>대화상자 열기</Button>
        </div>
      </section>
      <section className="panel panel-body stack">
        <h2>States</h2>
        <div className="cluster">
          {(
            [
              "idle",
              "queued",
              "running",
              "blocked",
              "review",
              "completed",
              "cancelled",
              "failed",
            ] as const
          ).map((status) => (
            <StatusBadge key={status} status={status} />
          ))}
        </div>
        <Notice>작업을 만들면 실제 실행 기록이 표시됩니다.</Notice>
        <Notice tone="warning">이미지 제작을 위한 연결 또는 완성된 이미지가 필요합니다.</Notice>
        <Notice tone="error">연결할 수 없습니다. 설정을 확인한 후 다시 시도하세요.</Notice>
      </section>
      <section className="panel panel-body stack">
        <h2>Inputs</h2>
        <div className="form-grid">
          <Field label="작업 이름">
            <input placeholder="예: 가을 신제품 캠페인" />
          </Field>
          <Field label="일 예산" help="통화 단위로 입력합니다.">
            <input type="number" placeholder="예산 미정" />
          </Field>
          <Field label="목표">
            <select>
              <option>사이트 방문</option>
              <option>구매 전환</option>
            </select>
          </Field>
          <Field label="오류 상태">
            <input aria-invalid="true" aria-describedby="field-error" defaultValue="1" />
            <small id="field-error">이름은 두 글자 이상 입력하세요.</small>
          </Field>
        </div>
      </section>
      <section className="panel empty-small">
        <h3>아직 생성된 결과물이 없어요</h3>
        <p>에이전트가 작업을 마치면 실제 파일이 이곳에 모입니다.</p>
      </section>
      {open && (
        <Dialog
          title="작업 설정"
          description="Escape 키 또는 닫기 버튼으로 돌아갑니다."
          onClose={() => setOpen(false)}
        >
          <div className="stack">
            <Field label="작업 이름">
              <input placeholder="첫 번째 입력 필드" />
            </Field>
            <Button variant="primary" onClick={() => setOpen(false)}>
              확인
            </Button>
          </div>
        </Dialog>
      )}
    </main>
  );
}
