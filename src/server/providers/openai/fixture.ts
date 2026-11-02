import { OpenAIClient, type OpenAITransport } from "./client.js";

/**
 * The vision reply recorded in the live v7 run (live-test/report-v7.md, `demo_vision ran=true`): the same values and
 * per-field confidences the model returned for the reference client. cowlickCrown stayed unknown there too.
 */
export const FIXTURE_VISION_REPLY = {
  growthDirection: "forward",
  cowlickFront: true,
  cowlickCrown: null,
  hairline: "average",
  glasses: false,
  lengthCm: 8,
  frontCm: 7,
  topCm: 8,
  sideCm: 3,
  curl: "1",
  diameter: "medium",
  density: 3,
  faceShape: "oval",
  faceRatio: 1.38,
  jaw: "average",
  forehead: "average",
  foreheadWidth: "average",
  ears: "average",
  confidence: 0.76,
  fieldConfidence: {
    growthDirection: 0.74,
    cowlickFront: 0.62,
    cowlickCrown: 0.2,
    hairline: 0.68,
    glasses: 0.99,
    length: 0.78,
    curl: 0.82,
    diameter: 0.56,
    density: 0.88,
    faceShape: 0.67,
    faceRatio: 0.58,
    jaw: 0.64,
    forehead: 0.6,
    foreheadWidth: 0.58,
    ears: 0.71,
  },
} as const;

/** Answers `demo_vision` with the recorded reply, in the Responses API shape, with zero usage so nothing is booked. Any other call is refused, so ranking stays on its deterministic path. */
export function fixtureOpenAITransport(): OpenAITransport {
  return async ({ body }) => {
    const request = JSON.parse(body) as { text?: { format?: { name?: string } } };
    if (request.text?.format?.name !== "demo_vision") return { status: 400, body: "{}" };
    return {
      status: 200,
      body: JSON.stringify({
        status: "completed",
        output: [{ type: "message", content: [{ type: "output_text", text: JSON.stringify(FIXTURE_VISION_REPLY) }] }],
        usage: { input_tokens: 0, output_tokens: 0 },
      }),
    };
  };
}

/** Fixture-mode stand-in for the live client: no network, so a full-flow dry run merges vision exactly like a live one. */
export function createFixtureOpenAIClient(): OpenAIClient {
  return new OpenAIClient(fixtureOpenAITransport(), "fixture");
}
