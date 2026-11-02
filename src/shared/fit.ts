/** Fit is shown with one decimal; this is the smallest gap between two cards in a strictly falling list. */
export const FIT_STEP = 0.1;

/** The Fit as shown: one decimal, never a whole-number rounding that would hide a real difference. */
export function roundFit(value: number): number {
  return Math.round(value * 10) / 10;
}

/** The Fit as written on a card, always with one decimal so a list reads 74.6, 74.3, 74.0 and never mixes styles. */
export function formatFit(value: number): string {
  return roundFit(value).toFixed(1);
}
