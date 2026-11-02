import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

export type VerifyStep = {
  name: string;
  command: string;
};

export type VerifyResult = {
  ok: boolean;
  exitCode: number;
  failedStep: string | null;
};

export const defaultSteps: readonly VerifyStep[] = [
  { name: "typecheck", command: "npm run typecheck" },
  { name: "lint", command: "npm run lint" },
  { name: "unit tests", command: "npm run test:unit" },
  { name: "integration tests", command: "npm run test:integration" },
  { name: "production build", command: "npm run build" },
  { name: "startup smoke", command: "npm run test:smoke" },
];

export function runSteps(steps: readonly VerifyStep[], cwd = process.cwd()): VerifyResult {
  for (const step of steps) {
    console.log(`\n[verify] ${step.name}`);
    const result = spawnSync(step.command, {
      cwd,
      shell: true,
      encoding: "utf8",
      env: process.env,
    });
    const output = `${result.stdout ?? ""}${result.stderr ?? ""}`;
    if (output) process.stdout.write(output.endsWith("\n") ? output : `${output}\n`);
    if (result.error) {
      console.error(`[verify] ${step.name} failed to start: ${result.error.message}`);
      return { ok: false, exitCode: 1, failedStep: step.name };
    }
    if (result.status !== 0) {
      const exitCode = result.status ?? 1;
      console.error(`[verify] ${step.name} failed with exit code ${exitCode}.`);
      return { ok: false, exitCode, failedStep: step.name };
    }
  }
  console.log("\n[verify] PASS");
  return { ok: true, exitCode: 0, failedStep: null };
}

function main(): void {
  const commandFlag = process.argv.indexOf("--command");
  const steps = commandFlag >= 0
    ? [{ name: "controlled check", command: process.argv[commandFlag + 1] ?? "" }]
    : defaultSteps;
  if (steps.some((step) => step.command.trim() === "")) {
    console.error("[verify] A controlled check needs a command after --command.");
    process.exitCode = 1;
    return;
  }
  const result = runSteps(steps);
  process.exitCode = result.exitCode;
}

const isDirect = process.argv[1] !== undefined
  && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isDirect) main();
