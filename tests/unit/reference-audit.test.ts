import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { loadStyles } from "../../src/domain/knowledge-base.js";
import { allHaircutCatalogueKeys, rankingCardDemoFilename } from "../../src/client/flow/ranking-card-media.js";
import { demoMediaRoot } from "../../src/server/demo/render-cache.js";
import { catalogueReferenceFile } from "../../src/server/demo/reference-photo.js";

/** Top length (cm) each shared portrait or template thumbnail really shows, checked by eye. */
export const PHOTO_TOP_CM: Record<string, [number, number]> = {
  "style-french-crop.jpg": [2, 6], "style-caesar-short.jpg": [2, 5], "style-buzz-taper.jpg": [0, 1], "style-ivy-league.jpg": [2, 6],
  "style-modern-quiff.jpg": [4, 9], "style-side-part.jpg": [4, 9], "style-curtain-medium.jpg": [10, 20], "style-modern-mullet.jpg": [6, 14],
  "style-curly-top-fade.jpg": [4, 9], "style-textured-crop.jpg": [3, 7], "style-bro-flow.jpg": [14, 25], "style-slick-back.jpg": [5, 10],
  "style-pompadour.jpg": [6, 12], "style-man-bun.jpg": [15, 40], "style-low-taper.jpg": [3, 8],
  "youcam/male_wavy_undercut.jpg": [5, 11], "youcam/male_textured_comma.jpg": [8, 15], "youcam/male_gray_taper_fade.jpg": [3, 8],
  "youcam/male_textured_crop.jpg": [3, 8], "youcam/male_short_curly.jpg": [4, 13], "youcam/all_buzz_cut.jpg": [0, 2], "youcam/male_bald.jpg": [0, 1],
  "youcam/all_messy_tapered_fade.jpg": [6, 10], "youcam/all_side_swept_undercut.jpg": [4, 9], "youcam/all_tousled_waves.jpg": [12, 20],
  "youcam/male_tousled_cut.jpg": [4, 9], "youcam/all_hippie_wave.jpg": [25, 60], "youcam/male_afro.jpg": [8, 16], "youcam/all_dreadlocks.jpg": [15, 45],
};

const styles = loadStyles().filter((style) => style.service === "haircut");

test("every linked own photo exists, its folder matches the style's gender, and its length class matches the style", () => {
  const problems: string[] = [];
  for (const key of allHaircutCatalogueKeys()) {
    const file = rankingCardDemoFilename(key);
    const style = styles.find((item) => item.key === key);
    if (!file || !style || file.startsWith("youcam/")) continue;
    if (!existsSync(path.join(demoMediaRoot(), file))) problems.push(`${key}: ${file} missing`);
    if (file.startsWith("catalog/women/") && style.affinity === "masculine") problems.push(`${key}: women photo on masculine style`);
    if (file.startsWith("catalog/men/") && style.affinity === "feminine") problems.push(`${key}: men photo on feminine style`);
    const range = PHOTO_TOP_CM[file];
    const top = style.requirements.topCm;
    if (range && top !== null && (top < range[0] || top > range[1])) problems.push(`${key}: ${file} shows ${range[0]}-${range[1]} cm on top, style needs ${top} cm`);
  }
  assert.deepEqual(problems, []);
});

test("Middle part styles no longer point at a photo of different hair", () => {
  for (const key of ["haircut:curtains--middle-part-short", "haircut:curtains--middle-part-with-taper"]) {
    const style = styles.find((item) => item.key === key);
    if (!style) continue;
    const file = rankingCardDemoFilename(key);
    assert.ok(file === null || !/wavy|tousled_waves/.test(file), key);
    assert.equal(catalogueReferenceFile(style) === "style-wavy-mid.jpg", false);
  }
});

test("Textured Caesar renders from a short choppy fringe, not the blunt classic Caesar photo", () => {
  const style = styles.find((item) => item.key === "haircut:crop--textured-caesar-low-taper");
  assert.ok(style);
  assert.equal(catalogueReferenceFile(style), "catalog/men/crop-textured-caesar-low-taper.jpg");
});
