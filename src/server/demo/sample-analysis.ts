import { readFile } from "node:fs/promises";
import path from "node:path";
import { parsePerson, type Person } from "../../domain/person.js";

let cached: Person | null = null;

/** Committed analysis for the sample persona (same shape as live YouCam pipeline output). */
export async function loadSampleAnalysis(): Promise<Person> {
  if (cached) return cached;
  const file = path.join(process.cwd(), "src", "server", "demo", "sample-analysis.json");
  const raw = JSON.parse(await readFile(file, "utf8")) as unknown;
  const person = parsePerson(raw);
  if (!person) {
    throw new Error("sample_analysis_invalid");
  }
  cached = person;
  return person;
}
