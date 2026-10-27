import sharp from "sharp";

export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** Aspect ratios the Gemini image models accept. */
export const RATIOS = ["1:1", "2:3", "3:2", "3:4", "4:3", "4:5", "5:4", "9:16", "16:9", "21:9"] as const;

export function ratioValue(r: string): number {
  const [a, b] = r.split(":").map(Number);
  return a / b;
}

export function nearestRatio(w: number, h: number): string {
  const target = Math.log(w / h);
  let best: string = RATIOS[0];
  let bestDist = Infinity;
  for (const r of RATIOS) {
    const d = Math.abs(Math.log(ratioValue(r)) - target);
    if (d < bestDist) {
      bestDist = d;
      best = r;
    }
  }
  return best;
}

const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));

/** Intersect the selection with the canvas. Returns null if nothing is left. */
export function clipToCanvas(sel: Rect, docW: number, docH: number): Rect | null {
  const x0 = clamp(Math.floor(sel.x), 0, docW);
  const y0 = clamp(Math.floor(sel.y), 0, docH);
  const x1 = clamp(Math.ceil(sel.x + sel.w), 0, docW);
  const y1 = clamp(Math.ceil(sel.y + sel.h), 0, docH);
  if (x1 - x0 < 1 || y1 - y0 < 1) return null;
  return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
}

/**
 * Pick the crop that goes to Gemini: the selection plus context, grown towards a
 * supported aspect ratio and kept inside the canvas. Whatever ratio error is left
 * is padded away later (see prepareInputs).
 */
export function planRegion(sel: Rect, docW: number, docH: number, padding: number): { region: Rect; ratio: string } {
  const pad = Math.max(32, Math.round(Math.max(sel.w, sel.h) * padding));
  let x0 = clamp(sel.x - pad, 0, docW);
  let y0 = clamp(sel.y - pad, 0, docH);
  let x1 = clamp(sel.x + sel.w + pad, 0, docW);
  let y1 = clamp(sel.y + sel.h + pad, 0, docH);
  let w = x1 - x0;
  let h = y1 - y0;
  const ratio = nearestRatio(w, h);
  const R = ratioValue(ratio);

  const cx = sel.x + sel.w / 2;
  const cy = sel.y + sel.h / 2;

  if (w / h < R) {
    // too tall: widen if possible, otherwise shorten (but keep the selection inside)
    const wantW = Math.round(h * R);
    if (wantW <= docW) {
      w = wantW;
      x0 = clamp(Math.round(cx - w / 2), 0, docW - w);
    } else {
      w = docW;
      x0 = 0;
      const wantH = Math.round(w / R);
      if (wantH >= sel.h) {
        h = wantH;
        y0 = clamp(Math.round(cy - h / 2), Math.max(0, sel.y + sel.h - h), Math.min(sel.y, docH - h));
      }
    }
  } else if (w / h > R) {
    const wantH = Math.round(w / R);
    if (wantH <= docH) {
      h = wantH;
      y0 = clamp(Math.round(cy - h / 2), 0, docH - h);
    } else {
      h = docH;
      y0 = 0;
      const wantW = Math.round(h * R);
      if (wantW >= sel.w) {
        w = wantW;
        x0 = clamp(Math.round(cx - w / 2), Math.max(0, sel.x + sel.w - w), Math.min(sel.x, docW - w));
      }
    }
  }
  const region = { x: Math.round(x0), y: Math.round(y0), w: Math.round(w), h: Math.round(h) };
  // even sizes keep the layer centre on a whole pixel, so placing never resamples by half a pixel
  if (region.w % 2 === 1) {
    if (region.x + region.w < docW) region.w++;
    else if (region.x > 0) (region.x--, region.w++);
  }
  if (region.h % 2 === 1) {
    if (region.y + region.h < docH) region.h++;
    else if (region.y > 0) (region.y--, region.h++);
  }
  return { region, ratio };
}

export interface Prepared {
  imagePng: Buffer;
  maskPng: Buffer;
  /** Padding (in region pixels) added to reach the exact aspect ratio. */
  pad: { left: number; top: number; right: number; bottom: number };
  region: Rect;
  ratio: string;
}

/** Cut the region from the flattened document and build the matching mask. */
export async function prepareInputs(
  docPng: Buffer,
  region: Rect,
  sel: Rect,
  ratio: string,
  maxSide: number,
): Promise<Prepared> {
  const R = ratioValue(ratio);
  let padW = 0;
  let padH = 0;
  if (region.w / region.h < R) padW = Math.round(region.h * R) - region.w;
  else if (region.w / region.h > R) padH = Math.round(region.w / R) - region.h;
  const pad = {
    left: Math.floor(padW / 2),
    right: Math.ceil(padW / 2),
    top: Math.floor(padH / 2),
    bottom: Math.ceil(padH / 2),
  };
  const fullW = region.w + pad.left + pad.right;
  const fullH = region.h + pad.top + pad.bottom;
  const scale = Math.min(1, maxSide / Math.max(fullW, fullH));
  const outW = Math.max(8, Math.round(fullW * scale));
  const outH = Math.max(8, Math.round(fullH * scale));

  // sharp always applies extend after resize, so pad first and resize in a second pass
  const padded = await sharp(docPng)
    .extract({ left: region.x, top: region.y, width: region.w, height: region.h })
    .removeAlpha()
    .extend({ ...pad, extendWith: "copy" })
    .png()
    .toBuffer();
  const crop = await sharp(padded).resize(outW, outH, { fit: "fill" }).png().toBuffer();

  // mask: white where the selection is (relative to the padded crop), black elsewhere
  const mx = sel.x - region.x + pad.left;
  const my = sel.y - region.y + pad.top;
  const svg = Buffer.from(
    `<svg xmlns="http://www.w3.org/2000/svg" width="${fullW}" height="${fullH}">` +
      `<rect width="100%" height="100%" fill="#000"/>` +
      `<rect x="${mx}" y="${my}" width="${sel.w}" height="${sel.h}" fill="#fff"/></svg>`,
  );
  const mask = await sharp(svg).resize(outW, outH, { fit: "fill" }).flatten({ background: "#000" }).png().toBuffer();

  return { imagePng: crop, maskPng: mask, pad, region, ratio };
}

/** Scale Gemini's answer back to the region, drop the ratio padding, return PNG. */
export async function finishOutput(generated: Buffer, prep: Prepared): Promise<Buffer> {
  const { pad, region } = prep;
  const fullW = region.w + pad.left + pad.right;
  const fullH = region.h + pad.top + pad.bottom;
  const scaled = await sharp(generated)
    .removeAlpha()
    .resize(fullW, fullH, { fit: "fill", kernel: "lanczos3" })
    .png()
    .toBuffer();
  return sharp(scaled)
    .extract({ left: pad.left, top: pad.top, width: region.w, height: region.h })
    .png()
    .toBuffer();
}

export async function thumbnail(png: Buffer, size = 160): Promise<string> {
  const buf = await sharp(png).resize(size, size, { fit: "inside" }).jpeg({ quality: 80 }).toBuffer();
  return `data:image/jpeg;base64,${buf.toString("base64")}`;
}
