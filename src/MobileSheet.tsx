import { ChevronDown, Menu, Plus, Settings2, X } from "lucide-react";
import { type ReactNode, useEffect, useLayoutEffect, useRef, useState } from "react";
import type { Job } from "../shared/schema";
import type { SuiteAppId } from "../shared/suite-apps";
import type { View } from "./agentMeta";
import { Button } from "./primitives";
import { AppSwitcher, JobRows, LaterNav, PrimaryNav } from "./Sidebar";

// 바텀 시트(<dialog>): 아래에서 올라오는 모달. Esc·스크림(어두운 바깥) 누르기로 닫고, 닫히면 열었던 버튼으로 포커스가 돌아간다.
export function MobileSheet({
  label,
  onClose,
  children,
}: {
  readonly label: string;
  readonly onClose: () => void;
  readonly children: ReactNode;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  useLayoutEffect(() => {
    const dialog = ref.current;
    const trigger = document.activeElement;
    dialog?.showModal();
    return () => {
      const ownedFocus =
        dialog?.contains(document.activeElement) || document.activeElement === document.body;
      dialog?.close();
      if (
        ownedFocus &&
        trigger instanceof HTMLElement &&
        trigger.isConnected &&
        !document.querySelector("dialog[open]")
      ) {
        trigger.focus({ preventScroll: true });
      }
    };
  }, []);
  return (
    // biome-ignore lint/a11y/useKeyWithClickEvents: 키보드는 Esc(cancel 이벤트)와 시트 안의 닫기 버튼이 맡고, 바깥 누르기는 마우스·터치 보조다.
    <dialog
      ref={ref}
      className="sheet"
      aria-label={label}
      onCancel={(event) => {
        event.preventDefault();
        onClose();
      }}
      onClick={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <div className="sheet-body">
        <div className="sheet-handle" aria-hidden="true" />
        {children}
      </div>
    </dialog>
  );
}

type AppBarProps = {
  readonly jobs: readonly Job[];
  readonly selectedId: string | null;
  readonly view: View;
  // 앱바에 적을 이름: 작업 화면이면 작업 이름, 그 밖의 화면이면 화면 이름
  readonly title: string;
  readonly onView: (view: View) => void;
  readonly onSelect: (id: string) => void;
  readonly onCreate: () => void;
  readonly onSettings: () => void;
  readonly onOpenApp: (id: SuiteAppId) => void;
  readonly live: boolean;
};
// 모바일(≤760px) 상단 앱바 56px: 타일 · 작업 이름 ⌄(작업 선택 시트) · ≡(메뉴 시트). 넓어지면 CSS 로 숨고 사이드바가 대신한다.
export function MobileAppBar({
  jobs,
  selectedId,
  view,
  title,
  onView,
  onSelect,
  onCreate,
  onSettings,
  onOpenApp,
  live,
}: AppBarProps) {
  const [sheet, setSheet] = useState<"menu" | "jobs" | null>(null);
  const close = () => setSheet(null);
  // 화면이 넓어져 시트가 필요 없어지면 닫는다(태블릿 회전·창 크기 변경).
  useEffect(() => {
    const query = window.matchMedia("(min-width: 761px)");
    const onChange = () => {
      if (query.matches) setSheet(null);
    };
    query.addEventListener("change", onChange);
    return () => query.removeEventListener("change", onChange);
  }, []);
  const pickJob = view === "overview" && jobs.length > 0;
  return (
    <>
      <header className="mobile-appbar">
        <a className="appbar-home" href="/">
          <span className="appbar-tile" aria-hidden="true">
            AD
          </span>
          <span className="sr-only">AD 스위트</span>
        </a>
        {pickJob ? (
          <button
            type="button"
            className="appbar-title"
            aria-haspopup="dialog"
            aria-expanded={sheet === "jobs"}
            onClick={() => setSheet("jobs")}
          >
            <span>{title}</span>
            <ChevronDown size={16} strokeWidth={1.75} aria-hidden="true" />
            <span className="sr-only">작업 선택</span>
          </button>
        ) : (
          <span className="appbar-title is-static">
            <span>{title}</span>
          </span>
        )}
        <button
          type="button"
          className="appbar-icon"
          aria-label="메뉴"
          aria-haspopup="dialog"
          aria-expanded={sheet === "menu"}
          onClick={() => setSheet("menu")}
        >
          <Menu size={20} strokeWidth={1.75} aria-hidden="true" />
        </button>
      </header>
      {sheet === "menu" && (
        <MobileSheet label="메뉴" onClose={close}>
          <AppSwitcher view={view} onView={onView} onOpenApp={onOpenApp} inline onPick={close} />
          <PrimaryNav jobs={jobs} view={view} onView={onView} onPick={close} />
          <button
            type="button"
            className="nav-item"
            onClick={() => {
              close();
              onSettings();
            }}
          >
            <Settings2 size={16} strokeWidth={1.75} aria-hidden="true" />
            <span>연결 설정</span>
          </button>
          <LaterNav view={view} onView={onView} onPick={close} />
          <div className="sheet-heading">
            <span>내 작업</span>
            <button
              type="button"
              aria-label="새 작업 만들기"
              onClick={() => {
                close();
                onCreate();
              }}
            >
              <Plus size={16} strokeWidth={1.75} aria-hidden="true" />
            </button>
          </div>
          <div className="sidebar-jobs">
            <JobRows
              jobs={jobs}
              selectedId={selectedId}
              onSelect={(id) => {
                close();
                onSelect(id);
              }}
            />
          </div>
          <div className="sheet-foot">
            <span className="local-note">
              <span className={live ? "connected" : undefined} />이 컴퓨터에서 실행 중
            </span>
            <Button variant="ghost" onClick={close}>
              <X size={16} strokeWidth={1.75} aria-hidden="true" />
              닫기
            </Button>
          </div>
        </MobileSheet>
      )}
      {sheet === "jobs" && (
        <MobileSheet label="작업 선택" onClose={close}>
          <div className="sheet-heading">
            <span>작업 선택</span>
          </div>
          <div className="sidebar-jobs">
            <JobRows
              jobs={jobs}
              selectedId={selectedId}
              onSelect={(id) => {
                close();
                onSelect(id);
              }}
            />
          </div>
          <div className="sheet-foot">
            <Button
              onClick={() => {
                close();
                onCreate();
              }}
            >
              <Plus size={16} strokeWidth={1.75} aria-hidden="true" />새 작업 만들기
            </Button>
            <Button variant="ghost" onClick={close}>
              <X size={16} strokeWidth={1.75} aria-hidden="true" />
              닫기
            </Button>
          </div>
        </MobileSheet>
      )}
    </>
  );
}
