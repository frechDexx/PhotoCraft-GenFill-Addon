import fs from "node:fs";
import path from "node:path";

export interface Config {
  /** Gemini API key from Google AI Studio. Falls back to the GEMINI_API_KEY environment variable. */
  geminiApiKey: string;
  /** Gemini image model id, e.g. gemini-2.5-flash-image ("Nano Banana"). */
  model: string;
  /** Output size for models that support it ("1K", "2K", "4K"). Empty = model default. */
  imageSize: string;
  /** Variants per click (Photoshop uses 3). 1 to 4. */
  variants: number;
  /** Extra context around the selection, as a fraction of the selection's longer side. */
  contextPadding: number;
  /** Longest side of the image sent to Gemini, in pixels. */
  maxInputSide: number;
  /** Global shortcut that opens the prompt bar (Electron accelerator syntax). */
  hotkey: string;
  /** Folder that contains photocraft.exe and photocraft-cli.exe. */
  photocraftDir: string;
  /** Start PhotoCraft (with the control port open) when GenFill starts and PhotoCraft isn't running. */
  launchPhotoCraft: boolean;
  /** Port PhotoCraft's control interface listens on (photocraft --control <port>). */
  controlPort: number;
  /** Token file shared by PhotoCraft and the CLI bridge. Created by PhotoCraft on first start. */
  controlTokenFile: string;
  /** Exchange folder, given to PhotoCraft as automation read AND write root. */
  automationRoot: string;
}

export const APP_DIR = path.resolve(__dirname, "..");
export const CONFIG_PATH = path.join(APP_DIR, "config.json");

const DEFAULTS: Config = {
  geminiApiKey: "",
  model: "gemini-2.5-flash-image",
  imageSize: "",
  variants: 3,
  contextPadding: 0.35,
  maxInputSide: 1536,
  hotkey: "Control+Alt+G",
  photocraftDir: "",
  launchPhotoCraft: true,
  controlPort: 47821,
  controlTokenFile: path.join(APP_DIR, "control-token.txt"),
  automationRoot: path.join(APP_DIR, "exchange"),
};

export const photocraftExe = (cfg: Config) => path.join(cfg.photocraftDir, "photocraft.exe");
export const photocraftCli = (cfg: Config) => path.join(cfg.photocraftDir, "photocraft-cli.exe");

function readFile(): Record<string, unknown> {
  if (!fs.existsSync(CONFIG_PATH)) return {};
  try {
    return JSON.parse(fs.readFileSync(CONFIG_PATH, "utf8"));
  } catch (e) {
    throw new Error(`config.json is not valid JSON: ${(e as Error).message}`);
  }
}

export function loadConfig(): Config {
  const fromFile = readFile() as Partial<Config> & { photocraftCli?: string };
  // configs from 0.1 stored the CLI path instead of the folder
  if (!fromFile.photocraftDir && fromFile.photocraftCli) fromFile.photocraftDir = (fromFile.photocraftCli.includes("\\") ? path.win32 : path).dirname(fromFile.photocraftCli);
  delete fromFile.photocraftCli;

  const cfg: Config = { ...DEFAULTS, ...fromFile };
  if (!cfg.geminiApiKey && process.env.GEMINI_API_KEY) cfg.geminiApiKey = process.env.GEMINI_API_KEY;
  cfg.variants = Math.max(1, Math.min(4, Math.round(Number(cfg.variants) || 3)));
  // relative paths in config.json are relative to the GenFill folder
  cfg.controlTokenFile = path.resolve(APP_DIR, cfg.controlTokenFile || DEFAULTS.controlTokenFile);
  cfg.automationRoot = path.resolve(APP_DIR, cfg.automationRoot || DEFAULTS.automationRoot);
  return cfg;
}

export function saveConfig(patch: Partial<Config>): Config {
  const next = { ...DEFAULTS, ...readFile(), ...patch } as Record<string, unknown>;
  delete next.photocraftCli;
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(next, null, 2), "utf8");
  return loadConfig();
}
