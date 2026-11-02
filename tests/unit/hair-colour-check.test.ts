import assert from "node:assert/strict";
import { test } from "node:test";
import sharp from "sharp";
import { compareHairColour, needsRecolour } from "../../src/server/demo/hair-colour-check.js";

const WIDTH = 384;
const HEIGHT = 512;
const WALL = "#D9D5CC";
const SKIN = "#E0B08F";

/** A head on a plain wall: skin face, a hair cap on top (colour and height given), dark clothes below. */
async function portrait(hair: string, hairHeight = 120): Promise<Buffer> {
  const rect = (x: number, y: number, w: number, h: number, fill: string) =>
    `<rect x="${x}" y="${y}" width="${w}" height="${h}" fill="${fill}"/>`;
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${WIDTH}" height="${HEIGHT}">`
    + rect(0, 0, WIDTH, HEIGHT, WALL)
    + rect(120, 250 - hairHeight + 100, 144, 230, SKIN)
    + rect(110, 80 + 100 - hairHeight, 164, hairHeight + 60, hair)
    + rect(0, 440, WIDTH, 72, "#151515")
    + `</svg>`;
  return sharp(Buffer.from(svg)).jpeg({ quality: 92 }).toBuffer();
}

async function decide(user: string, render: string) {
  const comparison = await compareHairColour(await portrait(user), await portrait(render, 150));
  return { comparison, recolour: needsRecolour(comparison) };
}

test("black over dark brown is a drastic mismatch", async () => {
  const { comparison, recolour } = await decide("#4F4035", "#1A1816");
  assert.ok(comparison);
  assert.equal(recolour, true, `dE ${comparison.dE.toFixed(1)} dL ${comparison.dL.toFixed(1)}`);
});

test("copper red over brown is a drastic mismatch", async () => {
  const { recolour } = await decide("#4F4035", "#B45A28");
  assert.equal(recolour, true);
});

test("a slightly lighter or darker brown is left alone", async () => {
  assert.equal((await decide("#4F4035", "#5A4A3E")).recolour, false);
  assert.equal((await decide("#4F4035", "#453A30")).recolour, false);
  assert.equal((await decide("#4F4035", "#4F4035")).recolour, false);
});

test("the measured user colour is the hair, not the wall or the skin", async () => {
  const comparison = await compareHairColour(await portrait("#4F4035"), await portrait("#1A1816", 150));
  assert.ok(comparison);
  assert.match(comparison.user.hex, /^#[0-9A-F]{6}$/);
  const [r, g, b] = [1, 3, 5].map((i) => Number.parseInt(comparison.user.hex.slice(i, i + 2), 16));
  assert.ok(Math.abs(r! - 0x4f) < 24 && Math.abs(g! - 0x40) < 24 && Math.abs(b! - 0x35) < 24, comparison.user.hex);
});

test("no decision when the render changed no hair", async () => {
  const same = await portrait("#4F4035");
  assert.equal(await compareHairColour(same, same), null);
  assert.equal(needsRecolour(null), false);
});
