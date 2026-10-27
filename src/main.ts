import { app, BrowserWindow, dialog, globalShortcut, ipcMain, screen, shell } from "electron";
import { execFileSync, spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { APP_DIR, loadConfig, photocraftCli, photocraftExe, saveConfig, type Config } from "./config";
import { listImageModels } from "./gemini";
import { GenFill } from "./genfill";

let cfg: Config = loadConfig();
let win: BrowserWindow | null = null;
const logFile = path.join(APP_DIR, "genfill.log");

function log(msg: string) {
  try {
    fs.appendFileSync(logFile, `${new Date().toISOString()} ${msg}\n`);
  } catch {
    /* logging must never break the app */
  }
}

const send = (channel: string, payload: unknown) => win?.webContents.send(channel, payload);
const status = (msg: string, kind: "info" | "error" | "done" = "info") => {
  log(`[${kind}] ${msg}`);
  send("gf:status", { msg, kind });
};

const genfill = new GenFill(cfg, status, log);

// ---- PhotoCraft process ------------------------------------------------------------------------

function photoCraftRunning(): boolean {
  if (process.platform !== "win32") return false;
  try {
    const out = execFileSync("tasklist", ["/FI", "IMAGENAME eq photocraft.exe", "/NH"], { encoding: "utf8", windowsHide: true });
    return /photocraft\.exe/i.test(out);
  } catch {
    return false;
  }
}

/** Start PhotoCraft with its control port open and the exchange folder as automation root. */
function launchPhotoCraft(): string {
  const exe = photocraftExe(cfg);
  if (!cfg.photocraftDir || !fs.existsSync(exe)) {
    throw new Error("PhotoCraft folder not set or photocraft.exe missing. Open the settings (⋯) and choose the folder.");
  }
  if (photoCraftRunning()) return "PhotoCraft is already running.";
  const root = cfg.automationRoot;
  fs.mkdirSync(root, { recursive: true });
  const child = spawn(
    exe,
    [
      "--control", String(cfg.controlPort),
      "--control-token-file", cfg.controlTokenFile,
      "--automation-read-root", root,
      "--automation-write-root", root,
    ],
    {
      detached: true,
      stdio: "ignore",
      env: { ...process.env, PHOTOCRAFT_AUTOMATION_READ_ROOT: root, PHOTOCRAFT_AUTOMATION_WRITE_ROOT: root },
    },
  );
  child.unref();
  log(`Started PhotoCraft: ${exe}`);
  return "PhotoCraft started.";
}

// ---- window ------------------------------------------------------------------------------------

function createWindow() {
  win = new BrowserWindow({
    width: 560,
    height: 132,
    useContentSize: true,
    frame: false,
    resizable: false,
    alwaysOnTop: true,
    show: false,
    backgroundColor: "#1f1f22",
    title: "Generative Fill",
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      // the bar starts hidden; without this Chromium pauses painting and it shows up blank
      backgroundThrottling: false,
    },
  });
  win.setAlwaysOnTop(true, "floating");
  win.webContents.on("console-message", (e: any) =>
    log(`[ui:${e.level}] ${e.message} (${path.basename(String(e.sourceId ?? ""))}:${e.lineNumber ?? ""})`),
  );
  win.webContents.on("preload-error", (_e, p, err) => log(`[preload] ${p}: ${err?.stack ?? err}`));
  win.webContents.on("before-input-event", (_e, input) => {
    if (input.type === "keyDown" && input.key === "F12") win?.webContents.openDevTools({ mode: "detach" });
  });
  win.loadFile(path.join(APP_DIR, "ui", "index.html"));
  // the launcher passes --hidden: stay invisible until the hotkey is pressed
  win.once("ready-to-show", () => {
    if (!process.argv.includes("--hidden") || !cfg.photocraftDir || !cfg.geminiApiKey) showAtCursor();
  });
  win.on("closed", () => (win = null));
}

function showAtCursor() {
  if (!win) return createWindow();
  const p = screen.getCursorScreenPoint();
  const area = screen.getDisplayNearestPoint(p).workArea;
  const [w, h] = win.getSize();
  const x = Math.min(Math.max(area.x, p.x - Math.round(w / 2)), area.x + area.width - w);
  const y = Math.min(Math.max(area.y, p.y + 24), area.y + area.height - h - 200);
  win.setPosition(x, y);
  win.show();
  win.focus();
  win.webContents.invalidate();
  send("gf:focus", null);
}

function registerHotkey() {
  globalShortcut.unregisterAll();
  const ok = globalShortcut.register(cfg.hotkey, () => {
    if (win?.isVisible() && win.isFocused()) win.hide();
    else showAtCursor();
  });
  if (!ok) status(`Shortcut ${cfg.hotkey} is taken by another app. Pick another one in the settings.`, "error");
}

// ---- IPC -----------------------------------------------------------------------------------------

async function guard<T>(fn: () => Promise<T>): Promise<{ ok: true; data: T } | { ok: false; error: string }> {
  try {
    return { ok: true, data: await fn() };
  } catch (e) {
    const msg = (e as Error)?.message ?? String(e);
    status(msg, "error");
    return { ok: false, error: msg };
  }
}

const MASK = "••••";
ipcMain.handle("gf:generate", (_e, prompt: string) => guard(() => genfill.generate(String(prompt ?? ""))));
ipcMain.handle("gf:show", (_e, i: number) => guard(() => genfill.show(Number(i))));
ipcMain.handle("gf:keep", () => guard(() => genfill.keep()));
ipcMain.handle("gf:discard", () => guard(() => genfill.discard()));
ipcMain.handle("gf:cancel", () => guard(async () => genfill.cancel()));
ipcMain.handle("gf:state", () => genfill.snapshot);
ipcMain.handle("gf:config:get", () => ({ ...cfg, geminiApiKey: cfg.geminiApiKey ? MASK + cfg.geminiApiKey.slice(-4) : "" }));
ipcMain.handle("gf:config:set", (_e, patch: Partial<Config>) =>
  guard(async () => {
    if (patch.geminiApiKey?.startsWith(MASK)) delete patch.geminiApiKey;
    cfg = saveConfig(patch);
    genfill.updateConfig(cfg);
    registerHotkey();
    return true;
  }),
);
ipcMain.handle("gf:browse", () =>
  guard(async () => {
    const res = await dialog.showOpenDialog(win!, {
      title: "Choose the folder that contains photocraft.exe",
      properties: ["openDirectory"],
      defaultPath: cfg.photocraftDir || undefined,
    });
    const dir = res.canceled ? "" : res.filePaths[0];
    if (dir && !fs.existsSync(photocraftCli({ ...cfg, photocraftDir: dir }))) {
      throw new Error(`No photocraft-cli.exe in ${dir}`);
    }
    return dir;
  }),
);
ipcMain.handle("gf:launch", () => guard(async () => launchPhotoCraft()));
ipcMain.handle("gf:models", () => guard(() => listImageModels(cfg.geminiApiKey)));
ipcMain.handle("gf:probe", () =>
  guard(async () => {
    const report = await genfill.photocraft.probe();
    const out = path.join(APP_DIR, "probe-report.json");
    fs.writeFileSync(out, JSON.stringify(report, null, 2));
    shell.showItemInFolder(out);
    return out;
  }),
);
ipcMain.handle("gf:resize", (_e, height: number) => {
  if (!win) return;
  const [w] = win.getContentSize();
  win.setContentSize(w, Math.max(80, Math.min(720, Math.round(height))));
});
ipcMain.handle("gf:hide", () => win?.hide());
ipcMain.handle("gf:quit", () => app.quit());

// ---- app lifecycle ---------------------------------------------------------------------------------

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on("second-instance", () => showAtCursor());
  app.whenReady().then(() => {
    fs.mkdirSync(cfg.automationRoot, { recursive: true });
    createWindow();
    registerHotkey();
    log("GenFill started");
    if (cfg.launchPhotoCraft && cfg.photocraftDir) {
      try {
        log(launchPhotoCraft());
      } catch (e) {
        status((e as Error).message, "error");
      }
    }
  });
  app.on("will-quit", () => {
    globalShortcut.unregisterAll();
    void genfill.photocraft.close();
  });
  // keep running in the background when the bar is hidden; quit from the settings
  app.on("window-all-closed", () => {});
}
