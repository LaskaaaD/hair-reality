/** Maps interview answers to demo-media paths (public/demo-media). */
export function questionOptionImage(questionId: string, value: string): string | null {
  const map: Record<string, Record<string, string>> = {
    chemical: {
      none: "catalog/men/bowl--classic-bowl-cut.jpg",
      lightened: "catalog/men/quiff--classic-quiff.jpg",
      permed: "catalog/men/korean-perm--down-perm.jpg",
      relaxed: "catalog/men/slick-back--classic-slick-back.jpg",
      unknown: "sample-front.jpg",
    },
    naturalState: {
      natural: "sample-front.jpg",
      styled: "style-textured-crop.jpg",
      unknown: "sample-right.jpg",
    },
    strand: {
      fine: "catalog/men/military--high-and-tight.jpg",
      medium: "catalog/men/taper--taper-with-long-top.jpg",
      coarse: "catalog/men/twists--sponge-twists.jpg",
      unknown: "sample-left.jpg",
    },
    presentation: {
      masculine: "youcam/male_textured_crop.jpg",
      feminine: "youcam/female_bobcut_wavy.jpg",
      either: "youcam/all_tousled_waves.jpg",
    },
    stylingMinutes: {
      "5": "style-buzz-taper.jpg",
      "15": "style-side-part.jpg",
      "30": "style-wavy-mid.jpg",
    },
    facialHair: {
      none: "sample-front.jpg",
      stubble: "sample-front.jpg",
      short: "youcam/male_textured_crop.jpg",
      medium: "youcam/male_gray_taper_fade.jpg",
      long: "youcam/male_wavy_undercut.jpg",
    },
  };
  return map[questionId]?.[value] ?? null;
}

export function demoMediaPath(relative: string): string {
  return `/demo-media/${relative}`;
}
