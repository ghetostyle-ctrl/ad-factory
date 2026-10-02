import { expect, test } from "bun:test";
import { AutomationEnrollment } from "../server/automation-enrollment";
import type { ProductionProviders } from "../server/automation-production";
import { evidencePack } from "../server/evidence-pack";
import { SourceProduction } from "../server/source-production";
import { JobStore } from "../server/store";
import { CreativePlanSchema } from "../shared/creative-plan";
import { ImageReviewSchema } from "../shared/planning";
import { automationPolicy } from "./automation-fixture";
import { creative, passReview, png } from "./provider-fixtures";
import { planningFixture, sourcePlanResponse, sourceStrategy } from "./source-planning-fixture";

test.each([{ ids: ["a-b", "a", "c"] }, { ids: ["a", "a-b", "c"] }])(
  "reuses each approved image after reopening when hypothesis IDs share prefixes: %j",
  async ({ ids }) => {
    // Given
    const fixture = planningFixture();
    let reopened: JobStore | null = null;
    let images = 0;
    const model = {
      provider: "openai",
      requestedModel: "fixture-model",
      effectiveModel: null,
      quality: null,
    } as const;
    const job = fixture.job();
    fixture.store.change(job.id, (draft) => {
      draft.accountId = "act_123";
      draft.selection = { accountId: "act_123", pageId: "456" };
    });
    new AutomationEnrollment(fixture.store).start(job.id, automationPolicy());
    const providers: ProductionProviders = {
      strategy: async () => ({ value: sourceStrategy, model }),
      creative: async () => ({ value: creative, model }),
      image: async () => {
        images++;
        return { value: png, model };
      },
      review: async () => ({ value: ImageReviewSchema.parse(passReview), model }),
      plan: async (current) => {
        if (!current.sourceSnapshot) throw new Error("Fixture requires snapshot");
        const response = sourcePlanResponse(fixture.fact.id);
        return {
          value: CreativePlanSchema.parse({
            ...response,
            hypotheses: response.hypotheses.map((hypothesis, index) => ({
              ...hypothesis,
              id: ids[index],
            })),
            sourceDigest: current.sourceSnapshot.digest,
            sourceCoverage: evidencePack(current.sourceSnapshot).coverage,
            referenceAnalyses: [],
          }),
          model,
        };
      },
    };
    try {
      await new SourceProduction(fixture.store, providers).run(
        job.id,
        sourceStrategy,
        new AbortController().signal,
      );
      const approvedIds = fixture.store
        .get(job.id)
        .creativeVariants.map((variant) => variant.approvedImageId);
      const cardIds = fixture.store
        .get(job.id)
        .creativeVariants.map((variant) => variant.cardImageIds);
      reopened = new JobStore(fixture.store.root);
      // When
      await new SourceProduction(reopened, providers).run(
        job.id,
        sourceStrategy,
        new AbortController().signal,
      );
      // Then
      // 대표 이미지 3장 + 메커니즘 설명형 카드뉴스 2개 × 추가 카드 2장 = 7장, 다시 열어도 새로 만들지 않는다.
      expect(images).toBe(7);
      expect(
        reopened.get(job.id).creativeVariants.map((variant) => variant.approvedImageId),
      ).toEqual(approvedIds);
      expect(reopened.get(job.id).creativeVariants.map((variant) => variant.cardImageIds)).toEqual(
        cardIds,
      );
      expect(cardIds.map((items) => items.length)).toEqual([0, 2, 2]);
    } finally {
      reopened?.close();
      fixture.close();
    }
  },
);
