import { readFileSync } from "node:fs";
import { styleCatalogue } from "../src/domain/catalogue.ts";

const haircuts = styleCatalogue.filter((entry) => entry.service === "haircut");
const beards = styleCatalogue.filter((entry) => entry.service === "beard");
const colours = styleCatalogue.filter((entry) => entry.service === "colour");
if (haircuts.length < 12 || beards.length < 8 || colours.length < 6) {
  console.error("Reviewed catalogue is missing coverage.");
  process.exit(1);
}
if (styleCatalogue.some((entry) => "excludeFace" in entry)) {
  console.error("Face shape must not be a hard exclusion field.");
  process.exit(1);
}
console.log(`Reviewed catalogue ok: ${haircuts.length} haircuts, ${beards.length} beards, ${colours.length} colours.`);
if (process.env.TAG_CATALOGUE_LIVE !== "1") {
  console.log("Live vision tagging stays off. Set TAG_CATALOGUE_LIVE=1 only with a local thumbnail manifest.");
  process.exit(0);
}
try {
  readFileSync(new URL("./catalogue-thumbs/manifest.json", import.meta.url));
} catch {
  console.error("TAG_CATALOGUE_LIVE=1 needs scripts/catalogue-thumbs/manifest.json. No provider call was made.");
  process.exit(1);
}
console.error("Thumbnail manifest found, but this script does not spend OpenAI units until a reviewed prompt is added.");
process.exit(1);
