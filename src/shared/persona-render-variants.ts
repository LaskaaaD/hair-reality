/** Same-face demo renders: shared crop box, per-style tuning so previews differ while staying aligned. */
export type PersonaRenderVariant = {
  position: string;
  zoom: number;
  saturation?: number;
  brightness?: number;
};

export const PERSONA_RENDER_VARIANTS: Record<string, PersonaRenderVariant> = {
  "haircut:male_short_curly": { position: "attention", zoom: 1, saturation: 1.05 },
  "haircut:male_textured_crop": { position: "top", zoom: 1.12, saturation: 0.92 },
  "haircut:messy-taper": { position: "right top", zoom: 1.1, brightness: 0.96 },
  "haircut:bro-flow": { position: "left", zoom: 1.06, saturation: 1.08 },
  "haircut:side-swept-fringe": { position: "left top", zoom: 1.14, saturation: 0.9 },
  "haircut:textured-fringe": { position: "top", zoom: 1.16, brightness: 1.04 },
  "haircut:comma-fringe": { position: "attention", zoom: 1.18, saturation: 1.1 },
  "haircut:male_tousled_cut": { position: "right", zoom: 1.08 },
  "haircut:male_wavy_undercut": { position: "left", zoom: 1.1, saturation: 0.88 },
  "haircut:male_textured_comma": { position: "attention", zoom: 1.15, brightness: 0.98 },
  "haircut:male_gray_taper_fade": { position: "top", zoom: 1.2, saturation: 0.85 },
  "haircut:male_afro": { position: "attention", zoom: 1.02, saturation: 1.12 },
};
