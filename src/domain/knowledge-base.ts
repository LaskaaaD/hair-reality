import { z } from "zod";
import { styleDocuments } from "./style-data.js";
import { deriveTraits, type StyleTraits } from "./style-traits.js";

const curl = z.enum(["1", "2a", "2b", "2c", "3a", "3b", "3c", "4a", "4b", "4c"]);
const face = z.enum(["oval", "round", "square", "heart", "long"]);

const requirementsSchema = z.object({
  curl: z.array(curl).min(1),
  densityMin: z.number().int().min(1).max(4),
  frontCm: z.number().nullable(),
  topCm: z.number().nullable(),
  sidesCm: z.number().nullable(),
  strand: z.array(z.enum(["fine", "medium", "coarse"])).min(1),
  blunt: z.boolean(),
  needsExtension: z.boolean(),
});

const geometrySchema = z.object({
  addsHeight: z.number().min(0).max(1),
  addsWidth: z.number().min(0).max(1),
  coversForehead: z.number().min(0).max(1),
  softensJaw: z.number().min(0).max(1),
});

const lifestyleSchema = z.object({
  stylingMinutes: z.number().int().min(0).max(60),
  blowdryer: z.boolean(),
  maintenanceWeeks: z.number().int().min(1).max(52),
});

const fitSchema = z.object({
  direction: z.enum(["forward", "side", "back", "any"]),
  cowlick: z.enum(["sensitive", "ok"]),
  hairline: z.enum(["cover", "either", "show"]),
  mass: z.enum(["light", "medium", "heavy"]),
});

const referenceSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("youcam"), templateId: z.string().min(1).max(80) }),
  z.object({ kind: z.literal("brief"), brief: z.string().min(8).max(400) }),
  z.object({ kind: z.literal("asset"), file: z.string().regex(/^[a-z0-9-]+\.jpg$/) }),
]);

const attrsSchema = z.object({
  height: z.number().min(0).max(1),
  width: z.number().min(0).max(1),
  fringeCover: z.number().min(0).max(1),
  sides: z.enum(["scissor", "low-taper", "mid", "high", "skin"]),
  fringeType: z.enum(["none", "curtain", "blunt", "textured", "swept"]),
  cowlickTolerance: z.number().min(0).max(1),
});

export type CutAttrs = z.infer<typeof attrsSchema>;

const variantSchema = z.object({
  id: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9 _-]{0,78}$/),
  title: z.string().min(1).max(80),
  affinity: z.enum(["masculine", "feminine", "either"]).optional(),
  requirements: requirementsSchema.partial().optional(),
  geometry: geometrySchema.partial().optional(),
  compatibility: z.record(face, z.number().min(0).max(1)).optional(),
  lifestyle: lifestyleSchema.partial().optional(),
  bodyHint: z.string().max(180).nullable().optional(),
  beardFullness: z.enum(["none", "light", "medium", "full"]).nullable().optional(),
  colourLevel: z.number().int().min(1).max(10).nullable().optional(),
  swatch: z.string().regex(/^#[0-9A-Fa-f]{6}$/).nullable().optional(),
  preset: z.string().min(1).max(40).nullable().optional(),
  fit: fitSchema.optional(),
  attrs: attrsSchema.optional(),
  reference: referenceSchema,
  stylistScript: z.string().min(8).max(280),
});

const familySchema = z.object({
  id: z.string().regex(/^[a-z0-9-]{1,40}$/),
  service: z.enum(["haircut", "beard", "colour"]),
  affinity: z.enum(["masculine", "feminine", "either"]),
  defaults: z.object({
    requirements: requirementsSchema,
    geometry: geometrySchema,
    compatibility: z.record(face, z.number().min(0).max(1)),
    lifestyle: lifestyleSchema,
    bodyHint: z.string().max(180).nullable(),
    beardFullness: z.enum(["none", "light", "medium", "full"]).nullable(),
    fit: fitSchema.optional(),
  }),
  variants: z.array(variantSchema).min(1),
});

export const styleFileSchema = z.object({
  families: z.array(familySchema).min(1),
});

export type StyleReference = z.infer<typeof referenceSchema>;
export type StyleFit = z.infer<typeof fitSchema>;
const neutralFit: StyleFit = { direction: "any", cowlick: "ok", hairline: "either", mass: "medium" };

export type StyleVariant = {
  key: string;
  id: string;
  familyId: string;
  service: "haircut" | "beard" | "colour";
  title: string;
  affinity: "masculine" | "feminine" | "either";
  requirements: z.infer<typeof requirementsSchema>;
  geometry: z.infer<typeof geometrySchema>;
  compatibility: Partial<Record<z.infer<typeof face>, number>>;
  lifestyle: z.infer<typeof lifestyleSchema>;
  bodyHint: string | null;
  beardFullness: "none" | "light" | "medium" | "full" | null;
  colourLevel: number | null;
  swatch: string | null;
  preset: string | null;
  reference: StyleReference;
  fit: StyleFit;
  /** Real per-cut attributes (masculine catalogue); null when the cut only has family defaults. */
  attrs: CutAttrs | null;
  /** Attributes the hard feasibility filters read, derived from the fields above (see style-traits.ts). */
  traits: StyleTraits;
  stylistScript: string;
};

export function loadStyles(documents: typeof styleDocuments = styleDocuments): StyleVariant[] {
  const files = [documents.haircuts, documents.beards, documents.colours];
  const variants: StyleVariant[] = [];
  const seen = new Set<string>();
  for (const file of files) {
    const parsed = styleFileSchema.parse(file);
    for (const family of parsed.families) {
      for (const variant of family.variants) {
        const key = `${family.service}:${variant.id}`;
        if (seen.has(key)) throw new Error(`Duplicate style key ${key}`);
        seen.add(key);
        const requirements = mergeDefined(family.defaults.requirements, variant.requirements);
        const geometry = mergeDefined(family.defaults.geometry, variant.geometry);
        const fit = variant.fit ?? family.defaults.fit ?? neutralFit;
        variants.push({
          key,
          id: variant.id,
          familyId: family.id,
          service: family.service,
          title: variant.title,
          affinity: variant.affinity ?? family.affinity,
          requirements,
          geometry,
          compatibility: { ...family.defaults.compatibility, ...variant.compatibility },
          lifestyle: mergeDefined(family.defaults.lifestyle, variant.lifestyle),
          bodyHint: variant.bodyHint === undefined ? family.defaults.bodyHint : variant.bodyHint,
          beardFullness: variant.beardFullness === undefined ? family.defaults.beardFullness : variant.beardFullness,
          colourLevel: variant.colourLevel ?? null,
          swatch: variant.swatch ?? null,
          preset: variant.preset ?? null,
          reference: variant.reference,
          fit,
          attrs: variant.attrs ?? null,
          traits: deriveTraits({ requirements, geometry, fit, attrs: variant.attrs ?? null }),
          stylistScript: variant.stylistScript,
        });
      }
    }
  }
  return variants;
}

export function variantsFor(service: StyleVariant["service"], styles: readonly StyleVariant[] = loadStyles()): StyleVariant[] {
  return styles.filter((variant) => variant.service === service);
}

/** Keys that were renamed: Ivy League used to be published as haircut:crew-cut, which read like the plain Crew cut. */
const RENAMED_KEYS: Record<string, string> = { "haircut:crew-cut": "haircut:crew--ivy-league" };

/** The key a stored or recorded id stands for today (a renamed one maps to its new key, any other id is unchanged). */
export function currentKey(key: string): string {
  return RENAMED_KEYS[key] ?? key;
}

export function variantByKey(key: string, styles: readonly StyleVariant[] = loadStyles()): StyleVariant | null {
  const current = currentKey(key);
  return styles.find((variant) => variant.key === current) ?? null;
}

function mergeDefined<T extends object>(base: T, extra: object | undefined): T {
  const next = { ...base };
  if (!extra) return next;
  const record = extra as Record<string, unknown>;
  for (const key of Object.keys(record)) {
    const value = record[key];
    if (value !== undefined) (next as Record<string, unknown>)[key] = value;
  }
  return next;
}
