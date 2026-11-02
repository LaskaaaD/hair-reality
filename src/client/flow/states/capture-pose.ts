/** Head-pose checks for the guided camera. Pure functions over MediaPipe face landmarks so they can be tested without a camera. */

export type PoseLandmark = { x: number; y: number; z: number };
export type PoseTarget = "front" | "left" | "right" | "down";

export type PoseMetrics = {
  /** Degrees, positive when the person turns toward their own left. */
  yaw: number;
  /** Degrees, positive when the chin tips down. */
  pitch: number;
  /** Degrees of head tilt toward a shoulder. */
  roll: number;
  centerX: number;
  centerY: number;
  /** Chin-to-hairline distance as a share of the frame height. */
  heightShare: number;
};

export type PoseVerdict = { ok: boolean; message: string };

const RIGHT_CHEEK = 234;
const LEFT_CHEEK = 454;
const FOREHEAD = 10;
const CHIN = 152;
const RIGHT_EYE_OUTER = 33;
const LEFT_EYE_OUTER = 263;

const DEGREES = 180 / Math.PI;

/**
 * `matrix` is MediaPipe's 4x4 facial transformation matrix (column-major). Its rotation is a steadier read of the head angle than
 * landmark depth, which under-reads a chin tipped toward the screen, so it wins when present.
 */
export function measurePose(
  landmarks: readonly PoseLandmark[],
  frameWidth: number,
  frameHeight: number,
  matrix?: ArrayLike<number> | null,
): PoseMetrics | null {
  const rightCheek = landmarks[RIGHT_CHEEK];
  const leftCheek = landmarks[LEFT_CHEEK];
  const forehead = landmarks[FOREHEAD];
  const chin = landmarks[CHIN];
  const rightEye = landmarks[RIGHT_EYE_OUTER];
  const leftEye = landmarks[LEFT_EYE_OUTER];
  if (!rightCheek || !leftCheek || !forehead || !chin || !rightEye || !leftEye || frameWidth <= 0 || frameHeight <= 0) return null;
  // Landmark x and z share one scale (frame width); y is rescaled so angles are not squashed by the frame's aspect ratio.
  const tall = frameHeight / frameWidth;
  const yaw = Math.atan2(leftCheek.z - rightCheek.z, leftCheek.x - rightCheek.x) * DEGREES;
  const pitch = Math.atan2(chin.z - forehead.z, (chin.y - forehead.y) * tall) * DEGREES;
  const roll = Math.atan2((leftEye.y - rightEye.y) * tall, leftEye.x - rightEye.x) * DEGREES;
  const angles = matrix && matrix.length >= 16 ? anglesFromMatrix(matrix) : null;
  return {
    yaw: angles?.yaw ?? yaw,
    pitch: angles?.pitch ?? pitch,
    roll: angles?.roll ?? roll,
    centerX: (rightCheek.x + leftCheek.x) / 2,
    centerY: (forehead.y + chin.y) / 2,
    heightShare: Math.abs(chin.y - forehead.y),
  };
}

function anglesFromMatrix(matrix: ArrayLike<number>): { yaw: number; pitch: number; roll: number } | null {
  const at = (row: number, column: number) => matrix[column * 4 + row] ?? Number.NaN;
  const scale = Math.hypot(at(0, 0), at(1, 0), at(2, 0));
  if (!Number.isFinite(scale) || scale === 0) return null;
  const pitch = Math.asin(Math.max(-1, Math.min(1, -at(1, 2) / scale))) * DEGREES;
  const yaw = Math.atan2(at(0, 2), at(2, 2)) * DEGREES;
  const roll = Math.atan2(at(1, 0), at(1, 1)) * DEGREES;
  return Number.isFinite(pitch) && Number.isFinite(yaw) && Number.isFinite(roll) ? { yaw, pitch, roll } : null;
}

export function judgePose(target: PoseTarget, metrics: PoseMetrics, brightness: number): PoseVerdict {
  // Limits follow photos YouCam accepted for hair type and density: front pitch 7 degrees, sides 27 and 34, crowns 29 and 33.
  const minHeight = target === "down" ? 0.18 : 0.3;
  const maxHeight = target === "down" ? 0.7 : 0.44;
  if (metrics.heightShare < minHeight) return fail("Move a little closer");
  if (metrics.heightShare > maxHeight) return fail("Move back a little, your whole head must fit");
  const lenient = target === "down";
  if (Math.abs(metrics.centerX - 0.5) > (lenient ? 0.2 : 0.12) || Math.abs(metrics.centerY - 0.5) > (lenient ? 0.28 : 0.16)) return fail("Centre your face in the oval");
  if (brightness < 55) return fail("Find more light, face a window or lamp");
  if (brightness > 225) return fail("Too bright, avoid direct light on the lens");
  if (Math.abs(metrics.roll) > (lenient ? 12 : 7)) return fail("Keep your head level, don't tilt it to a shoulder");

  if (target === "front") {
    if (metrics.yaw > 7) return fail("Turn slightly to your right, look straight at the lens");
    if (metrics.yaw < -7) return fail("Turn slightly to your left, look straight at the lens");
    if (metrics.pitch > 8) return fail("Look at the camera lens, not the screen. Raise your chin a little");
    if (metrics.pitch < -8) return fail("Lower your chin a little");
  } else if (target === "left" || target === "right") {
    const turn = target === "left" ? metrics.yaw : -metrics.yaw;
    const side = target === "left" ? "left" : "right";
    if (turn < 0) return fail(`Turn your head to your ${side}`);
    if (turn < 26) return fail(`Keep turning to your ${side}`);
    if (turn > 55) return fail("Come back a little, not that far");
    if (Math.abs(metrics.pitch) > 10) return fail(metrics.pitch > 0 ? "Raise your chin a little" : "Lower your chin a little");
  } else {
    if (Math.abs(metrics.yaw) > 16) return fail("Face the camera, only tip your chin down");
    if (metrics.pitch < 26) return fail("Tip your chin down so the top of your head shows");
    if (metrics.pitch > 55) return fail("Raise your chin a little");
  }
  return { ok: true, message: "Hold still" };
}

export const TARGET_PROMPTS: Record<PoseTarget, string> = {
  front: "Look straight at the camera",
  left: "Turn your head to your left",
  right: "Turn your head to your right",
  down: "Tip your chin down, show the top of your head",
};

function fail(message: string): PoseVerdict {
  return { ok: false, message };
}
