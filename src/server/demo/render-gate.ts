/**
 * The owner's rule: YouCam try-ons only run behind a ranking the OpenAI model actually produced.
 * Any other path (deterministic fallback after an error, timeout, "call uncertain", missing model,
 * guardrail rejection, or no ranking yet) pauses live renders instead of spending YouCam units.
 */
export type RenderGateRefusal = { status: 409; code: "RANKING_NOT_LLM"; message: string };

export const RANKING_NOT_LLM_MESSAGE = "Personal ranking is unavailable right now, so try-ons are paused. Please try again.";

/** Reads the rank path saved with the session's recommendation. Anything but an explicit "llm" is not llm. */
export function savedRankPath(recommendation: unknown): "llm" | "fallback" {
  if (!recommendation || typeof recommendation !== "object") return "fallback";
  return (recommendation as { rankPath?: unknown }).rankPath === "llm" ? "llm" : "fallback";
}

/** Null when a live YouCam render may start; a refusal otherwise. Fixture renders never reach YouCam, so they pass. */
export function liveRenderGate(input: { live: boolean; recommendation: unknown }): RenderGateRefusal | null {
  if (!input.live) return null;
  if (savedRankPath(input.recommendation) === "llm") return null;
  return { status: 409, code: "RANKING_NOT_LLM", message: RANKING_NOT_LLM_MESSAGE };
}
