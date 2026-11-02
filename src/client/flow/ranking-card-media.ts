import mediaIndex from "../../shared/catalogue-media.generated.json" with { type: "json" };

const catalogueMedia = mediaIndex as Record<string, string | null>;

/** Demo-media path relative to `/demo-media/` for a ranking card key, or null when none applies. */
export function rankingCardDemoFilename(candidateKey: string): string | null {
  if (!candidateKey.startsWith("haircut:")) return null;
  const mapped = catalogueMedia[candidateKey];
  return mapped ?? null;
}

export function allHaircutCatalogueKeys(): string[] {
  return Object.keys(catalogueMedia).filter((key) => key.startsWith("haircut:"));
}
