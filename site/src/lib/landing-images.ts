// Homepage product images: public/landing/<name>-<theme>-<width>.webp, built by scripts/landing-shots.mjs from
// screenshots of the real app. Keep NAMES in step with that script's IMAGES table (widths and CSS-pixel sizes).

type Theme = "light" | "dark";

/** CSS-pixel size of the picture (the shot or its crop), the pixel widths the script writes, and the display widths
 * for `sizes` (measured from landing.css at 1440, 1280, 1024, 768 and 390; landing-images.test.mjs checks the files). */
export const IMAGES = {
  home: { width: 1440, height: 1000, widths: [2400, 1600, 960], sizes: "(min-width: 80rem) 1120px, 92vw" },
  phone: { width: 390, height: 844, widths: [720, 400], sizes: "(min-width: 87rem) 246px, (min-width: 58rem) calc(19vw - 1.125rem), (min-width: 48rem) 158px, (min-width: 24.5rem) 334px, calc(100vw - 3.625rem)" },
  "step-open": { width: 390, height: 423, widths: [720, 400], sizes: "(min-width: 81rem) 328px, (min-width: 64rem) calc((100vw - 7.5rem) / 3 - 4rem), (min-width: 27rem) 328px, calc(100vw - 6.5rem)" },
  "step-connect": { width: 390, height: 470, widths: [720, 400], sizes: "(min-width: 81rem) 328px, (min-width: 64rem) calc((100vw - 7.5rem) / 3 - 4rem), (min-width: 27rem) 328px, calc(100vw - 6.5rem)" },
  "step-steer": { width: 390, height: 403, widths: [720, 400], sizes: "(min-width: 81rem) 328px, (min-width: 64rem) calc((100vw - 7.5rem) / 3 - 4rem), (min-width: 27rem) 328px, calc(100vw - 6.5rem)" },
  "life-todos": { width: 279, height: 310, widths: [558], sizes: "(min-width: 80rem) 279px, (min-width: 64rem) 21vw, 279px" },
  "life-lists": { width: 279, height: 230, widths: [558], sizes: "(min-width: 80rem) 279px, (min-width: 64rem) 21vw, 279px" },
  "work-stream": { width: 743, height: 630, widths: [1486, 760], sizes: "(min-width: 80rem) 580px, (min-width: 64rem) 45vw, 82vw" },
  "work-stream-phone": { width: 390, height: 672, widths: [780, 400], sizes: "(min-width: 29rem) 390px, calc(100vw - 4.5rem)" },
  "trust-shared": { width: 279, height: 146, widths: [558], sizes: "279px" },
} as const;

export type LandingImageName = keyof typeof IMAGES;

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
