import { lazy, StrictMode, Suspense } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";
import { Notice } from "./primitives";

const Showcase = lazy(() => import("./Showcase").then((module) => ({ default: module.Showcase })));

import "./suite-tokens.css";
import "./tokens.css";
import "./primitives.css";

if (import.meta.env.DEV && import.meta.env.VITE_DISABLE_REACT_DEVTOOLS !== "1") {
  void import("react-grab");
  void import("react-scan");
}
const root = document.getElementById("root");
if (root)
  createRoot(root).render(
    <StrictMode>
      {import.meta.env.DEV && new URLSearchParams(window.location.search).has("showcase") ? (
        <Suspense fallback={<Notice>컴포넌트 화면을 불러오고 있습니다…</Notice>}>
          <Showcase />
        </Suspense>
      ) : (
        <App />
      )}
    </StrictMode>,
  );
