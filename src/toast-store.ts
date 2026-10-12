// 토스트 스토어: 복사·저장·승인처럼 짧게 알리고 사라지는 결과 메시지. toast("메시지") 하나로 어디서든 부른다.
// 표시는 <Toast /> 가 한 곳(App)에서 맡는다. 오류처럼 사라지면 안 되는 안내는 토스트로 쓰지 않는다.
export type ToastItem = { readonly id: number; readonly message: string };

const TOAST_MS = 4000;
let items: readonly ToastItem[] = [];
let nextId = 1;
const listeners = new Set<() => void>();
const timers = new Map<number, ReturnType<typeof setTimeout>>();

function emit() {
  for (const listener of listeners) listener();
}
export function dismissToast(id: number) {
  const timer = timers.get(id);
  if (timer !== undefined) clearTimeout(timer);
  timers.delete(id);
  items = items.filter((item) => item.id !== id);
  emit();
}
export function toast(message: string) {
  const id = nextId++;
  // 같은 메시지가 연달아 오면 하나만 남긴다(복사 버튼을 여러 번 눌렀을 때).
  for (const item of items) if (item.message === message) dismissToast(item.id);
  items = [...items, { id, message }].slice(-3);
  timers.set(
    id,
    setTimeout(() => dismissToast(id), TOAST_MS),
  );
  emit();
}
export function subscribeToasts(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}
export function toastSnapshot(): readonly ToastItem[] {
  return items;
}
