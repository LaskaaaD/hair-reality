import assert from "node:assert/strict";
import { test } from "node:test";
import {
  affectedServiceKinds,
  briefFieldErrors,
  colourHistorySchema,
  preferencesInputSchema,
  prioritiesForService,
} from "../../src/shared/client-brief.js";

const history = {
  naturalColour: { state: "unknown" },
  dyed: "unknown",
  boxDye: "no",
  henna: "no",
  bleach: "yes",
  treatmentDate: { state: "unknown" },
  keratin: "unknown",
  permOrRelaxer: "no",
  reportedDamage: "unknown",
};

test("unknown stays distinct from no and an omitted colour answer is rejected", () => {
  const parsed = colourHistorySchema.parse(history);
  assert.equal(parsed.dyed, "unknown");
  assert.notEqual(parsed.dyed, "no");
  const { dyed: _dyed, ...omitted } = history;
  assert.equal(colourHistorySchema.safeParse(omitted).success, false);
  assert.equal(colourHistorySchema.safeParse({ ...history, treatmentDate: { state: "known", date: "2024-02-31" } }).success, false);
});

test("an extracted suggestion is not a confirmed priority until the client accepts it", () => {
  const proposal = {
    scope: "colour" as const,
    category: "dont_want" as const,
    text: "no bleach",
    confirmed: false as const,
    source: "extraction" as const,
  };
  assert.equal(preferencesInputSchema.safeParse({
    maintenance: "low",
    stylingWillingness: "unspecified",
    goals: [],
    priorities: [{ ...proposal, confirmed: false }],
    proposals: [],
  }).success, false);
  const stored = preferencesInputSchema.parse({
    maintenance: "low",
    stylingWillingness: "moderate",
    goals: ["keep the fringe"],
    priorities: [{ scope: "all", category: "must_keep", text: "keep the length", confirmed: true }],
    proposals: [proposal],
  });
  assert.equal(prioritiesForService("colour", stored).some((item) => item.text === "no bleach"), false);
  assert.equal(prioritiesForService("haircut", stored).map((item) => item.text).join(), "keep the length");
  const confirmed = preferencesInputSchema.parse({
    ...stored,
    priorities: [...stored.priorities, { scope: proposal.scope, category: proposal.category, text: proposal.text, confirmed: true }],
    proposals: [],
  });
  assert.deepEqual(prioritiesForService("colour", confirmed).map((item) => item.text), ["keep the length", "no bleach"]);
  assert.deepEqual(prioritiesForService("haircut", confirmed).map((item) => item.text), ["keep the length"]);
});

test("colour history does not belong on a beard-only consultation and does not stale other services", () => {
  assert.deepEqual(briefFieldErrors(["beard"], colourHistorySchema.parse(history), undefined)?.history, [
    "Colour history applies only when colour is selected.",
  ]);
  const previous = {
    history: null,
    preferences: preferencesInputSchema.parse({
      maintenance: "low",
      stylingWillingness: "low",
      goals: [],
      priorities: [],
      proposals: [],
    }),
  };
  assert.deepEqual(affectedServiceKinds(["haircut", "colour"], previous, { history: colourHistorySchema.parse(history) }), ["colour"]);
  assert.deepEqual(affectedServiceKinds(["haircut", "colour"], previous, {
    preferences: { ...previous.preferences, proposals: [{ scope: "colour", category: "flexible", text: "warmer", confirmed: false, source: "extraction" }] },
  }), []);
});
