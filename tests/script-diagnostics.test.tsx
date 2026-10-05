import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { ScriptDiagnostics } from "../src/ScriptDiagnostics";

test("a repaired draft shows its approval reminder until approval is complete", () => {
  const output = renderToStaticMarkup(
    <ScriptDiagnostics
      review={null}
      hardProblems={[]}
      warnings={[]}
      needsFix={true}
      dirty={false}
      approvalComplete={false}
    />,
  );
  expect(output).toContain('role="status"');
});

test("an approved repaired draft no longer renders an approval reminder", () => {
  const output = renderToStaticMarkup(
    <ScriptDiagnostics
      review={null}
      hardProblems={[]}
      warnings={[]}
      needsFix={true}
      dirty={false}
      approvalComplete={true}
    />,
  );
  expect(output).toBe("");
});
