import { expect, test } from "bun:test";
import { rm } from "node:fs/promises";
import { AutomationEnrollment } from "../server/automation-enrollment";
import { JobStore } from "../server/store";
import { automationPolicy } from "./automation-fixture";
import { providerStore } from "./provider-fixtures";

test.each([
  {
    operation: "image",
    initialStatus: "running",
    expected: "blocked",
    automationStatus: "attention",
  },
  { operation: null, initialStatus: "running", expected: "queued", automationStatus: "queued" },
  {
    operation: "image",
    initialStatus: "attention",
    expected: "blocked",
    automationStatus: "attention",
  },
] as const)(
  "recovers interrupted agent truthfully for $initialStatus / $operation",
  async ({ operation, initialStatus, expected, automationStatus }) => {
    // Given: a persisted in-flight agent plus real completed history, with no worker running.
    const store = providerStore();
    let recovered: JobStore | null = null;
    try {
      const job = store.list()[0];
      if (!job) throw new Error("Fixture job missing");
      store.change(job.id, (draft) => {
        draft.accountId = "act_123";
        draft.selection = { accountId: "act_123", pageId: "456" };
      });
      new AutomationEnrollment(store).start(job.id, automationPolicy());
      store.agent(job.id, "strategy", { status: "completed", action: "Fixture strategy saved" });
      store.agent(job.id, "production", {
        status: "running",
        action: "Fixture image request in flight",
      });
      const before = store.change(job.id, (draft) => {
        if (!draft.automation) throw new Error("Fixture automation missing");
        draft.status = initialStatus === "attention" ? "blocked" : "running";
        draft.automation.status = initialStatus;
        draft.automation.operation = operation;
        draft.automation.imageAttempts = 1;
        if (initialStatus === "attention") draft.automation.nextRunAt = null;
      });
      // When: only persisted-state recovery runs, without invoking an engine or provider.
      recovered = new JobStore(store.root);
      const after = recovered.get(job.id);
      // Then: the stale active display clears while completed history and checkpoints survive.
      expect(after.agents.find((agent) => agent.id === "production")?.status).toBe(expected);
      expect(after.agents.find((agent) => agent.id === "production")?.action).not.toBe(
        before.agents.find((agent) => agent.id === "production")?.action,
      );
      expect(after.agents.find((agent) => agent.id === "strategy")).toEqual(
        before.agents.find((agent) => agent.id === "strategy"),
      );
      expect(after.automation?.status).toBe(automationStatus);
      expect(after.automation?.operation).toBe(operation);
      expect(after.automation?.imageAttempts).toBe(1);
      expect(after.automation?.scopeDigest).toBe(before.automation?.scopeDigest);
      expect(after.artifacts).toEqual(before.artifacts);
      if (initialStatus === "attention") expect(after.automation).toEqual(before.automation);
      if (operation) expect(after.automation?.nextRunAt).toBeNull();
      else expect(after.automation?.nextRunAt).toBe(before.automation?.nextRunAt);
    } finally {
      recovered?.close();
      store.close();
      await rm(store.root, { recursive: true, force: true });
    }
  },
);
