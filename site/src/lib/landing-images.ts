// Homepage product images: public/landing/<name>-<theme>-<width>.webp, built by scripts/landing-shots.mjs from
// screenshots of the real app. Keep NAMES in step with that script's IMAGES table (widths and CSS-pixel sizes).

type Theme = "light" | "dark";

/** CSS-pixel size of the picture (the shot or its crop) and the pixel widths the script writes. */
const IMAGES = {
  home: { width: 1440, height: 1000, widths: [2400, 1600, 960], sizes: "(min-width: 80rem) 1180px, 92vw" },
  phone: { width: 390, height: 844, widths: [720, 400], sizes: "(min-width: 48rem) 264px, 280px" },
  "step-open": { width: 390, height: 400, widths: [720, 400], sizes: "(min-width: 64rem) 330px, (min-width: 40rem) 45vw, 86vw" },
  "step-connect": { width: 390, height: 400, widths: [720, 400], sizes: "(min-width: 64rem) 330px, (min-width: 40rem) 45vw, 86vw" },
  "step-steer": { width: 390, height: 400, widths: [720, 400], sizes: "(min-width: 64rem) 330px, (min-width: 40rem) 45vw, 86vw" },
  "life-todos": { width: 279, height: 310, widths: [558], sizes: "300px" },
  "life-lists": { width: 279, height: 230, widths: [558], sizes: "300px" },
  "work-stream": { width: 743, height: 630, widths: [1486, 760], sizes: "(min-width: 64rem) 620px, 92vw" },
  "trust-shared": { width: 279, height: 146, widths: [558], sizes: "(min-width: 40rem) 360px, 86vw" },
} as const;

export type LandingImageName = keyof typeof IMAGES;

/** Every image the homepage uses, with the pixel widths it expects on disk (landing-images.test.mjs checks the files). */
export const LANDING_IMAGES: { name: LandingImageName; width: number; height: number; widths: readonly number[] }[] =
  (Object.keys(IMAGES) as LandingImageName[]).map((name) => ({ name, width: IMAGES[name].width, height: IMAGES[name].height, widths: IMAGES[name].widths }));

export interface LandingImage {
  width: number;
  height: number;
  sizes: string;
  src: Record<Theme, string>;
  srcset: Record<Theme, string>;
}

const file = (name: string, theme: Theme, width: number) => `/landing/${name}-${theme}-${width}.webp`;

export function landingImage(name: LandingImageName): LandingImage {
  const image = IMAGES[name];
  const set = (theme: Theme) => image.widths.map((width) => `${file(name, theme, width)} ${width}w`).join(", ");
  const fallback = (theme: Theme) => file(name, theme, image.widths[image.widths.length - 1]);
  return {
    width: image.width,
    height: image.height,
    sizes: image.sizes,
    src: { light: fallback("light"), dark: fallback("dark") },
    srcset: { light: set("light"), dark: set("dark") },
  };
}
