/** The English reason a failed try-on shows in the UI, so a failed render never ends in a generic error. */
export const RENDER_TIMEOUT_REASON = "The render took too long. Try again or pick another style.";

const PHOTO_ERRORS: readonly { match: RegExp; reason: string }[] = [
  { match: /error_no_face/, reason: "No face was found in your front photo. Retake it facing the camera with your hair and face in frame." },
  { match: /error_face_angle|error_pose/, reason: "Your front photo is turned too far for a try-on. Retake it looking straight at the camera." },
  { match: /error_insufficient_lighting/, reason: "Your front photo is too dark for a try-on. Retake it in brighter light." },
  { match: /error_face_position/, reason: "Your face sits too close to the edge or too small in the front photo. Retake it with your head centred." },
  { match: /error_below_min_image_size|error_exceed_max_image_size|error_mismatch_image_size|exceed_max_filesize/, reason: "Your front photo has a size the try-on cannot use. Retake it or upload another one." },
];

/**
 * Maps a failed YouCam job to one plain sentence. `detail` is the stage that failed (for example `file_put_transport_TypeError`),
 * `providerError` the task error YouCam returned, and `code` our own classification.
 */
export function renderFailureReason(input: { code: string; detail?: string | null; providerError?: string | null }): string {
  const text = `${input.providerError ?? ""} ${input.detail ?? ""}`;
  const photo = PHOTO_ERRORS.find((entry) => entry.match.test(text));
  if (photo) return photo.reason;
  if (/file_put_|file_init_/.test(text)) return "The try-on service could not receive the photo because of a network error. Try this style again.";
  switch (input.code) {
    case "INVALID_PHOTO":
      return "The try-on service did not accept the photo or the style picture. Retake your front photo or pick another style.";
    case "RETAKE_REQUIRED":
      return "The try-on service could not read your front photo. Retake it facing the camera.";
    case "PROVIDER_RATE_LIMIT":
      return "The try-on service is busy right now. Try this style again in a minute.";
    case "PROVIDER_AUTH":
    case "PROVIDER_QUOTA":
      return "Try-ons are unavailable right now. Please try again later.";
    case "PROVIDER_RESPONSE_INVALID":
      return "The try-on service sent back something we could not read. Try this style again.";
    case "UNSUPPORTED_CONFIGURATION":
      return "This style cannot be previewed on a photo. Choose another style for a try-on.";
    case "SUBMISSION_UNCERTAIN":
      return "We could not confirm the try-on request reached the service, so it was not sent again. Try this style again.";
    case "RESULT_EXPIRED":
      return "The finished render could not be saved before it expired. Try this style again.";
    default:
      return "The try-on service could not be reached. Try this style again in a moment.";
  }
}
