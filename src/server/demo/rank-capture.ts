import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { personSchema, type Person } from "../../domain/person.js";
import type { Answers } from "../../domain/scoring.js";
import { profileFacts, type RankOutcome } from "./llm-rank.js";

/**
 * Everything a recommend call fed into the ranking, so the exact run can be replayed offline:
 * the model's raw answer, the rank path and note, and the merged profile (readings with source and confidence).
 * No photos, no session or user identifiers (the session appears only as a short hash in the file name), no keys or cookies.
 */
export type RankCapture = {
  /** 2 since the stylist-consultation schema (per-criterion scores, side-by-side profile). Version 1 captures still read: their model answer replays reasons only. */
  version: 1 | 2;
  capturedAt: string;
  rankPath: string;
  rankNote: string;
  /** The model's answer text as received, or null when no call completed. */
  rawRank: string | null;
  profile: Person;
  profileFacts: Record<string, unknown>;
  answers: Answers;
  likes: string[];
  /** The one-line barber instruction per style key, as the model wrote it (version 2). */
  tellYourBarber?: Record<string, string>;
};

export const DEFAULT_CAPTURE_DIR = path.join("var", "rank-captures");

export function rankCaptureEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.RANK_CAPTURE === "1";
}

export function buildRankCapture(input: { person: Person; ranking: Pick<RankOutcome, "path" | "note" | "rawAnswer" | "show">; answers: Answers; likes: readonly string[]; now?: Date }): RankCapture {
  return {
    version: 2,
    capturedAt: (input.now ?? new Date()).toISOString(),
    rankPath: input.ranking.path,
    rankNote: input.ranking.note,
    rawRank: input.ranking.rawAnswer ?? null,
    profile: input.person,
    profileFacts: profileFacts(input.person, input.answers),
    answers: input.answers,
    likes: [...input.likes],
    tellYourBarber: Object.fromEntries(input.ranking.show.flatMap((look) => (look.tellYourBarber ? [[look.variant.key, look.tellYourBarber]] : []))),
  };
}

/** Writes `<dir>/<timestamp>-<sessionhash>.json` and returns the path. `var/` is git-ignored. */
export function writeRankCapture(capture: RankCapture, sessionId: string, dir: string = process.env.RANK_CAPTURE_DIR || DEFAULT_CAPTURE_DIR): string {
  mkdirSync(dir, { recursive: true });
  const stamp = capture.capturedAt.replace(/[:.]/g, "-");
  const hash = createHash("sha256").update(sessionId).digest("hex").slice(0, 10);
  const file = path.join(dir, `${stamp}-${hash}.json`);
  writeFileSync(file, `${JSON.stringify(capture, null, 2)}\n`, "utf8");
  return file;
}

export function readRankCapture(file: string): RankCapture {
  const raw = JSON.parse(readFileSync(file, "utf8")) as Partial<RankCapture>;
  const profile = personSchema.safeParse(raw.profile);
  if ((raw.version !== 1 && raw.version !== 2) || !profile.success || !raw.answers || typeof raw.rankPath !== "string") throw new Error(`${file} is not a rank capture (version 1 or 2 expected)`);
  return { ...(raw as RankCapture), profile: profile.data, rawRank: typeof raw.rawRank === "string" ? raw.rawRank : null, likes: raw.likes ?? [] };
}
