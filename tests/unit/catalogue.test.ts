import assert from "node:assert/strict";
import { test } from "node:test";
import { catalogueBindingError, catalogueSeed } from "../../src/server/catalogue/inventory.js";
import { targetInputSchema } from "../../src/shared/catalogue.js";

test("the catalogue has verified bindings and rejects invented controls", () => {
  assert.equal(catalogueSeed.filter((entry) => entry.serviceKind === "haircut").length, 12);
  assert.equal(catalogueSeed.filter((entry) => entry.serviceKind === "colour").length, 6);
  assert.equal(catalogueSeed.filter((entry) => entry.serviceKind === "beard").length, 6);
  assert.equal(catalogueSeed.every((entry) => catalogueBindingError(entry) === null), true);
  assert.equal(catalogueSeed.some((entry) => entry.providerReference === "male_short_curly"), true);
  assert.equal(catalogueSeed.some((entry) => entry.providerReference === "all_shaved"), true);
  assert.equal(catalogueSeed.some((entry) => entry.providerReference?.startsWith("synthetic-template-")), false);
  const haircut = catalogueSeed.find((entry) => entry.serviceKind === "haircut");
  assert.ok(haircut);
  assert.equal(catalogueBindingError({ ...haircut, configuration: { template_id: haircut.providerReference ?? "", prompt: "longer" } }), "unsupported control");
  assert.equal(catalogueBindingError({ ...haircut, providerReference: "synthetic-template-demo", configuration: { template_id: "synthetic-template-demo" } }), "template binding");
  const colour = catalogueSeed.find((entry) => entry.serviceKind === "colour");
  assert.ok(colour);
  assert.equal(catalogueBindingError({ ...colour, configuration: { preset: "Not a colour" } }), "colour preset");
  assert.equal(targetInputSchema.safeParse({
    expectedVersion: 1,
    serviceKind: "haircut",
    sourceKind: "catalogue",
    candidateId: "11111111-1111-4111-8111-111111111111",
    confirmed: {},
    unsupported: [],
    proposals: [],
    controls: { prompt: "pixie" },
  }).success, false);
});
