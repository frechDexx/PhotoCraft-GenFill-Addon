import fs from "node:fs";
import path from "node:path";
import sharp from "sharp";
import type { Config } from "./config";
import { generateFill } from "./gemini";
import { clipToCanvas, finishOutput, planRegion, prepareInputs, thumbnail, type Rect } from "./imaging";
import { PhotoCraft, type BridgeCommand } from "./photocraft";

export interface Variant {
  layerId: string | number;
  thumb: string;
  prompt: string;
}

export interface SessionState {
  busy: boolean;
  variants: Variant[];
  active: number;
  selection: Rect | null;
}

type Status = (msg: string, kind?: "info" | "error" | "done") => void;

const SELECTION_CHANNEL = "GenFill Selection";

/**
 * One Generative Fill "set": the variants made for one selection, like the
 * Properties panel in Photoshop. Generating again on the same selection adds
 * to the set; a new selection starts a new one.
 */
export class GenFill {
  private pc: PhotoCraft;
  private state: SessionState = { busy: false, variants: [], active: -1, selection: null };
  private abort: AbortController | null = null;

  constructor(
    private cfg: Config,
    private status: Status,
    private log: (m: string) => void = () => {},
    private bridge?: BridgeCommand,
  ) {
    this.pc = new PhotoCraft(cfg, log, bridge);
  }

  updateConfig(cfg: Config) {
    const reconnect =
      cfg.photocraftDir !== this.cfg.photocraftDir ||
      cfg.controlPort !== this.cfg.controlPort ||
      cfg.controlTokenFile !== this.cfg.controlTokenFile;
    this.cfg = cfg;
    if (reconnect) {
      void this.pc.close();
      this.pc = new PhotoCraft(cfg, this.log, this.bridge);
    }
  }

  get snapshot(): SessionState {
    return { ...this.state, variants: [...this.state.variants] };
  }

  get photocraft() {
    return this.pc;
  }

  cancel() {
    this.abort?.abort();
  }

  async generate(prompt: string): Promise<SessionState> {
    if (this.state.busy) throw new Error("A generation is already running.");
    this.state.busy = true;
    this.abort = new AbortController();
    try {
      return await this.doGenerate(prompt, this.abort.signal);
    } finally {
      this.state.busy = false;
      this.abort = null;
    }
  }

  private async doGenerate(prompt: string, signal: AbortSignal): Promise<SessionState> {
    this.status("Connecting to PhotoCraft …");
    await this.pc.connect();

    const rawSel = await this.pc.selectionRect();
    if (!rawSel) throw new Error("No selection. Select an area in PhotoCraft first.");

    const sameSelection =
      this.state.selection &&
      this.state.variants.length > 0 &&
      (["x", "y", "w", "h"] as const).every((k) => Math.abs(this.state.selection![k] - rawSel[k]) < 1);
    if (!sameSelection) this.state = { busy: true, variants: [], active: -1, selection: rawSel };

    // 1. flattened document out of PhotoCraft
    const job = new Date().toISOString().replace(/[:.]/g, "-");
    const relDir = `genfill/${job}`;
    const absDir = path.join(this.cfg.automationRoot, "genfill", job);
    fs.mkdirSync(absDir, { recursive: true });
    this.status("Exporting image …");
    await this.pc.exportPng(`${relDir}/document.png`);
    const docPng = await waitForFile(path.join(absDir, "document.png"), this.cfg.automationRoot);
    const meta = await sharp(docPng).metadata();
    const sel = clipToCanvas(rawSel, meta.width!, meta.height!);
    if (!sel) throw new Error("The selection is outside the canvas.");

    // 2. crop with context + mask for Gemini
    const { region, ratio } = planRegion(sel, meta.width!, meta.height!, this.cfg.contextPadding);
    const prep = await prepareInputs(docPng, region, sel, ratio, this.cfg.maxInputSide);
    fs.writeFileSync(path.join(absDir, "input.png"), prep.imagePng);
    fs.writeFileSync(path.join(absDir, "mask.png"), prep.maskPng);

    // 3. variants in parallel
    const n = this.cfg.variants;
    this.status(`Generating ${n} variant${n > 1 ? "s" : ""} with ${this.cfg.model} …`);
    const offset = this.state.variants.length;
    const results = await Promise.allSettled(
      Array.from({ length: n }, (_, i) =>
        generateFill({
          apiKey: this.cfg.geminiApiKey,
          model: this.cfg.model,
          imagePng: prep.imagePng,
          maskPng: prep.maskPng,
          prompt,
          aspectRatio: ratio,
          imageSize: this.cfg.imageSize || undefined,
          variantIndex: offset + i,
          signal,
        }),
      ),
    );
    const ok = results.filter((r): r is PromiseFulfilledResult<Buffer> => r.status === "fulfilled").map((r) => r.value);
    const errors = results.filter((r): r is PromiseRejectedResult => r.status === "rejected").map((r) => r.reason);
    if (signal.aborted) throw new Error("Cancelled.");
    if (ok.length === 0) throw errors[0] ?? new Error("Gemini returned no images.");

    // 4. back into PhotoCraft: one layer per variant, masked by the selection
    const slug = slugify(prompt) || "Fill";
    await this.pc.saveSelection(SELECTION_CHANNEL);
    try {
      for (let i = 0; i < ok.length; i++) {
        this.status(`Placing variant ${i + 1}/${ok.length} … (please don't click in PhotoCraft)`);
        const png = await finishOutput(ok[i], prep);
        const name = `GenFill ${slug} ${offset + i + 1}.png`;
        fs.writeFileSync(path.join(absDir, name), png);

        // only one variant is visible at a time
        if (this.state.active >= 0) await this.pc.toggleVisibility(this.state.variants[this.state.active].layerId);
        const layerId = await this.pc.placeImage(`${relDir}/${name}`, region.x, region.y, name.replace(/\.png$/, ""));
        try {
          await this.pc.maskFromSelection(layerId, SELECTION_CHANNEL);
        } catch (e) {
          await this.pc.deleteLayer(layerId).catch(() => {});
          throw e;
        }
        this.state.variants.push({ layerId, thumb: await thumbnail(png), prompt });
        this.state.active = this.state.variants.length - 1;
      }
    } finally {
      // leave the user's selection active, then remove the helper channel
      await this.pc.loadSelection(SELECTION_CHANNEL).catch(() => {});
      await this.pc.deleteChannel(SELECTION_CHANNEL);
    }

    const failed = errors.length ? ` (${errors.length} failed: ${errors[0]?.message ?? errors[0]})` : "";
    this.status(`${ok.length} variant${ok.length > 1 ? "s" : ""} ready${failed}.`, "done");
    return this.snapshot;
  }

  /** Show one variant, hide the others. */
  async show(index: number): Promise<SessionState> {
    const v = this.state.variants[index];
    if (!v || index === this.state.active) return this.snapshot;
    if (this.state.active >= 0) await this.pc.toggleVisibility(this.state.variants[this.state.active].layerId);
    await this.pc.toggleVisibility(v.layerId);
    this.state.active = index;
    return this.snapshot;
  }

  /** Keep the visible variant, delete the others, close the set. */
  async keep(): Promise<SessionState> {
    const keepIdx = this.state.active;
    for (let i = this.state.variants.length - 1; i >= 0; i--) {
      if (i !== keepIdx) await this.pc.deleteLayer(this.state.variants[i].layerId);
    }
    this.state = { busy: false, variants: [], active: -1, selection: null };
    this.status("Variant kept.", "done");
    return this.snapshot;
  }

  /** Delete every variant of the set. */
  async discard(): Promise<SessionState> {
    for (let i = this.state.variants.length - 1; i >= 0; i--) {
      await this.pc.deleteLayer(this.state.variants[i].layerId);
    }
    this.state = { busy: false, variants: [], active: -1, selection: null };
    this.status("Variants discarded.", "done");
    return this.snapshot;
  }
}

function slugify(s: string): string {
  return s
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/ß/g, "ss")
    .replace(/[^A-Za-z0-9 _-]+/g, "")
    .trim()
    .replace(/\s+/g, " ")
    .slice(0, 32)
    .trim();
}

async function waitForFile(p: string, root: string, timeoutMs = 20000): Promise<Buffer> {
  const start = Date.now();
  let lastSize = -1;
  while (Date.now() - start < timeoutMs) {
    if (fs.existsSync(p)) {
      const size = fs.statSync(p).size;
      if (size > 0 && size === lastSize) return fs.readFileSync(p);
      lastSize = size;
    }
    await new Promise((r) => setTimeout(r, 150));
  }
  throw new Error(`Export not found: ${p}. Was PhotoCraft started by GenFill with "${root}" as automation root?`);
}
