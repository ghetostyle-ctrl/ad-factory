import { useSyncExternalStore } from "react";
import { subscribeToasts, toastSnapshot } from "./toast-store";

// 하단 중앙 토스트 자리. 화면낭독기에는 polite 로 읽힌다. 움직임 줄이기 설정에서는 페이드 없이 바로 나타난다(video-detail.css).
export function Toast() {
  const items = useSyncExternalStore(subscribeToasts, toastSnapshot, toastSnapshot);
  return (
    <div className="toast-host" role="status" aria-live="polite" aria-atomic="false">
      {items.map((item) => (
        <p className="toast" key={item.id}>
          {item.message}
        </p>
      ))}
    </div>
  );
}
