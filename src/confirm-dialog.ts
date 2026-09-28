// 브라우저 기본 window.confirm 대신 쓰는 앱 안 확인창.
// 앱 안 브라우저(Claude·Codex 데스크톱 등)나 대화상자 차단 설정에서는 window.confirm 이
// 창 없이 곧바로 false 를 돌려줘 버튼이 아무 반응 없이 끝난다. 네이티브 <dialog> 는 그런 환경에서도 뜬다.
export function confirmDialog(
  message: string,
  { confirmLabel = "확인", danger = false }: { confirmLabel?: string; danger?: boolean } = {},
): Promise<boolean> {
  return new Promise((resolve) => {
    const dialog = document.createElement("dialog");
    dialog.className = "dialog confirm-dialog";
    dialog.setAttribute("aria-label", "확인");
    const body = document.createElement("div");
    body.className = "dialog-body stack";
    const text = document.createElement("p");
    text.textContent = message;
    const actions = document.createElement("div");
    actions.className = "form-actions";
    const cancel = document.createElement("button");
    cancel.type = "button";
    cancel.className = "button button-secondary";
    cancel.textContent = "취소";
    const ok = document.createElement("button");
    ok.type = "button";
    ok.className = `button ${danger ? "button-danger" : "button-primary"}`;
    ok.textContent = confirmLabel;
    actions.append(cancel, ok);
    body.append(text, actions);
    dialog.append(body);
    document.body.append(dialog);

    let settled = false;
    const finish = (value: boolean) => {
      if (settled) return;
      settled = true;
      if (dialog.open) dialog.close();
      dialog.remove();
      resolve(value);
    };
    cancel.addEventListener("click", () => finish(false));
    ok.addEventListener("click", () => finish(true));
    dialog.addEventListener("cancel", (event) => {
      event.preventDefault();
      finish(false);
    });
    dialog.showModal();
    (danger ? cancel : ok).focus();
  });
}
