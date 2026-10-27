import fs from "node:fs";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { photocraftCli, type Config } from "./config";
import type { Rect } from "./imaging";

interface ToolInfo {
  name: string;
  description?: string;
  inputSchema?: { properties?: Record<string, { description?: string; type?: unknown }> };
}

export interface CommandInfo {
  id: string;
  label: string;
  params?: string;
  enabled?: boolean;
  disabledReason?: string | null;
}

export interface LayerInfo {
  id: string | number;
  name?: string;
  kind?: string;
  bounds: number[] | null;
}

/** How to start the MCP bridge. Defaults to photocraft-cli.exe; tests pass a mock server. */
export interface BridgeCommand {
  command: string;
  args: string[];
}

/**
 * Talks to the running PhotoCraft app through `photocraft-cli mcp --bridge`.
 *
 * Bridge mode (driving the live GUI) is deliberately locked down by PhotoCraft:
 * anything that reads a file by path (Place, Replace Contents, Smart Object via
 * Copy, ...) is refused, and so is doc_close. The only way in for a file is
 * doc_open. Everything below is built from commands that are allowed there.
 * All PhotoCraft-specific names live in this file.
 */
export class PhotoCraft {
  private client: Client | null = null;
  private tools = new Map<string, ToolInfo>();
  private commandCache: CommandInfo[] | null = null;

  constructor(
    private cfg: Config,
    private log: (msg: string) => void = () => {},
    private bridge?: BridgeCommand,
  ) {}

  get connected() {
    return this.client !== null;
  }

  async connect(): Promise<void> {
    if (this.client) return;
    let bridge = this.bridge;
    if (!bridge) {
      const cli = photocraftCli(this.cfg);
      if (!this.cfg.photocraftDir || !fs.existsSync(cli)) {
        throw new Error(`photocraft-cli.exe not found in "${this.cfg.photocraftDir || "(not set)"}". Set the PhotoCraft folder in the settings.`);
      }
      if (!fs.existsSync(this.cfg.controlTokenFile)) {
        throw new Error(
          "Control token missing. PhotoCraft has to be started by GenFill (or start-photocraft.cmd) so its control port is open.",
        );
      }
      bridge = {
        command: cli,
        args: ["mcp", "--bridge", `127.0.0.1:${this.cfg.controlPort}`, "--control-token-file", this.cfg.controlTokenFile],
      };
    }
    const transport = new StdioClientTransport({ command: bridge.command, args: bridge.args, stderr: "pipe" });
    transport.stderr?.on("data", (d: Buffer) => this.log(`[photocraft-cli] ${d.toString().trim()}`));
    const client = new Client({ name: "photocraft-genfill", version: "1.0.0" });
    try {
      await client.connect(transport);
    } catch (e) {
      throw new Error(
        `Cannot reach PhotoCraft on port ${this.cfg.controlPort}. Was it started through GenFill? (${(e as Error).message})`,
      );
    }
    transport.onclose = () => {
      this.client = null;
      this.commandCache = null;
    };
    const { tools } = await client.listTools();
    this.tools = new Map(tools.map((t) => [t.name, t as ToolInfo]));
    this.client = client;
    this.log(`Connected to PhotoCraft (${tools.length} tools).`);
  }

  async close() {
    await this.client?.close().catch(() => {});
    this.client = null;
  }

  /** Call an MCP tool and return its JSON result (structuredContent or parsed text). */
  async tool(name: string, args: Record<string, unknown> = {}): Promise<any> {
    await this.connect();
    const res: any = await this.client!.callTool({ name, arguments: args });
    const text = (res.content ?? [])
      .filter((c: any) => c.type === "text")
      .map((c: any) => c.text)
      .join("\n");
    if (res.isError) throw new Error(`PhotoCraft ${name}: ${text || "error"}`);
    if (res.structuredContent !== undefined) return res.structuredContent;
    if (!text) return res.content;
    try {
      return JSON.parse(text);
    } catch {
      return text;
    }
  }

  async run(id: string, params: Record<string, unknown> = {}): Promise<any> {
    return this.tool("command_run", { id, params });
  }

  async commands(): Promise<CommandInfo[]> {
    if (!this.commandCache) {
      const list = await this.tool("command_list");
      this.commandCache = Array.isArray(list) ? list : (list?.commands ?? []);
    }
    return this.commandCache!;
  }

  /** Find a command id: first a known id, then by menu label. */
  async resolve(ids: string[], labels: RegExp[]): Promise<string> {
    const cmds = await this.commands();
    for (const id of ids) if (cmds.some((c) => c.id === id)) return id;
    for (const re of labels) {
      const hit = cmds.find((c) => re.test(c.label ?? ""));
      if (hit) return hit.id;
    }
    throw new Error(`PhotoCraft command not found (${ids.join(", ")}). Run "Test connection" and check probe-report.json.`);
  }

  // ---- document ---------------------------------------------------------------------------

  async inspect(): Promise<any> {
    return this.tool("doc_inspect");
  }

  async selectionRect(): Promise<Rect | null> {
    return findSelectionRect(await this.inspect());
  }

  async activeDocName(): Promise<string | undefined> {
    const st = await this.inspect();
    return typeof st?.name === "string" ? st.name : undefined;
  }

  /** Export the flattened document as PNG below the automation root. The extension picks the format. */
  async exportPng(relPath: string): Promise<void> {
    // bridge mode rejects an explicit `format`
    await this.tool("doc_export", { path: relPath });
  }

  /** Cycle through the tabs until the document called `name` is active. */
  async activateDocument(name: string, maxTabs = 20) {
    for (let i = 0; i < maxTabs; i++) {
      if ((await this.activeDocName()) === name) return;
      await this.run("document.activate", { offset: 1 });
    }
    throw new Error(`Could not get back to document "${name}".`);
  }

  // ---- layers -------------------------------------------------------------------------------

  async layerList(): Promise<LayerInfo[]> {
    const res = await this.run("layer.list", { flat: true });
    return Array.isArray(res) ? res : (res?.layers ?? []);
  }

  /**
   * Put a PNG from the exchange folder into the active document as a new layer whose
   * top-left corner sits at (x, y). Done the way you would by hand, since bridge mode
   * only lets files in through doc_open: open the PNG, Select All, Copy, undo back to
   * a clean state, close it through the menu, switch back, Paste in Place, move.
   */
  async placeImage(relPath: string, x: number, y: number, name: string): Promise<string | number> {
    const target = await this.activeDocName();
    if (!target) throw new Error("No active document in PhotoCraft.");
    const before = new Set((await this.layerList()).map((l) => String(l.id)));

    await this.tool("doc_open", { path: relPath });
    const helper = await this.activeDocName();
    if (!helper || helper === target) throw new Error("PhotoCraft could not open the generated image.");

    try {
      await this.run(await this.resolve(["select.all"], [/^All$/i, /^Select All$/i]), {});
      await this.run(await this.resolve(["edit.copy"], [/^Copy$/i]), {});
    } finally {
      // undo the selection so the helper is unmodified and closes without a save prompt
      for (let i = 0; i < 5; i++) {
        const st = await this.inspect();
        if (st?.name !== helper || !st?.canUndo) break;
        await this.run("edit.undo", {});
      }
      if ((await this.activeDocName()) === helper) await this.tool("ui_menu_invoke", { id: "file.close" });
    }
    await this.activateDocument(target);

    await this.run(await this.resolve(["edit.pasteSpecial.pasteInPlace"], [/^Paste in Place$/i]), {});
    const added = (await this.layerList()).filter((l) => !before.has(String(l.id)));
    if (added.length !== 1) throw new Error(`Pasted layer not found unambiguously (${added.length} new layers).`);
    const layer = added[0];
    await this.renameLayer(layer.id, name);
    await this.bringToFront(layer.id);

    const now = (await this.layerList()).find((l) => String(l.id) === String(layer.id));
    const b = now?.bounds ?? layer.bounds ?? null;
    this.log(`Pasted layer ${layer.id}: bounds=${JSON.stringify(b)} target=[${x},${y}]`);
    if (b && (Math.round(b[0]) !== Math.round(x) || Math.round(b[1]) !== Math.round(y))) {
      const move = await this.resolve(["layer.move"], [/^Move Layer$/i]);
      await this.run(move, { layer: layer.id, dx: Math.round(x - b[0]), dy: Math.round(y - b[1]) });
    }
    return layer.id;
  }

  /** Generated content belongs on top of the stack, like in Photoshop. */
  async bringToFront(layer: string | number) {
    try {
      await this.run("layer.select", { layer, mode: "replace" });
      await this.run(await this.resolve(["layer.arrange.bringToFront"], [/^Bring to Front$/i]), { layer });
    } catch (e) {
      // "can't move further" just means it is already on top
      if (!/can't move further/i.test((e as Error).message)) this.log(`Bring to front failed: ${(e as Error).message}`);
    }
  }

  async renameLayer(layer: string | number, name: string) {
    try {
      await this.run(await this.resolve(["layer.rename"], [/^Rename Layer$/i]), { layer, name });
    } catch (e) {
      this.log(`Rename failed: ${(e as Error).message}`);
    }
  }

  /** PhotoCraft's Hide Layers shows the layers instead when they are all hidden already. */
  async toggleVisibility(layer: string | number) {
    await this.run(await this.resolve(["layer.hideLayers"], [/^Hide Layers$/i]), { layer });
  }

  async deleteLayer(layer: string | number) {
    await this.run(await this.resolve(["layer.delete"], [/^Delete Layer$/i]), { layer });
  }

  // ---- selection and masks --------------------------------------------------------------------

  /** Keep the user's selection safe as an alpha channel (Paste in Place drops the selection). */
  async saveSelection(channel: string) {
    await this.run("select.saveSelection", { name: channel });
  }

  async loadSelection(channel: string) {
    await this.run("select.loadSelection", { channel });
  }

  async deleteChannel(channel: string) {
    try {
      await this.run("channel.delete", { channel });
    } catch (e) {
      this.log(`Channel "${channel}" not deleted: ${(e as Error).message}`);
    }
  }

  /** Load the saved selection and turn it into the layer's mask (Layer > Layer Mask > Reveal Selection). */
  async maskFromSelection(layer: string | number, channel: string) {
    await this.loadSelection(channel);
    await this.run(await this.resolve(["layer.layerMask.revealSelection"], [/^Reveal Selection$/i]), { layer });
  }

  // ---- diagnostics ------------------------------------------------------------------------------

  async probe(): Promise<any> {
    await this.connect();
    const cmds = await this.commands();
    const wanted =
      /^(layer\.(list|duplicate|delete|hideLayers|move|rename|select|arrange)|layer\.layerMask|select\.|edit\.(copy|undo|paste)|document\.|channel\.delete)/;
    const safe = async (fn: () => Promise<any>) => {
      try {
        return await fn();
      } catch (e) {
        return { error: (e as Error).message };
      }
    };
    const inspect = await safe(() => this.inspect());
    return {
      when: new Date().toISOString(),
      tools: [...this.tools.values()].map((t) => ({ name: t.name, args: t.inputSchema?.properties ?? {} })),
      commands: cmds.filter((c) => wanted.test(c.id)),
      inspect,
      detected: { document: inspect?.name ?? null, selection: findSelectionRect(inspect) },
    };
  }
}

// ---- tolerant parsing of doc_inspect ---------------------------------------------------------

function rectFrom(v: any): Rect | null {
  if (!v) return null;
  if (Array.isArray(v) && v.length === 4 && v.every((n) => typeof n === "number")) {
    const [x, y, w, h] = v;
    return w > 0 && h > 0 ? { x, y, w, h } : null;
  }
  if (typeof v === "object") {
    if (typeof v.x === "number" && typeof v.y === "number") {
      const w = v.width ?? v.w;
      const h = v.height ?? v.h;
      if (typeof w === "number" && typeof h === "number" && w > 0 && h > 0) return { x: v.x, y: v.y, w, h };
    }
    const l = v.left ?? v.x0;
    const t = v.top ?? v.y0;
    const r = v.right ?? v.x1;
    const b = v.bottom ?? v.y1;
    if ([l, t, r, b].every((n) => typeof n === "number") && r > l && b > t) return { x: l, y: t, w: r - l, h: b - t };
    for (const k of ["bounds", "rect", "bbox", "box"]) {
      const inner = rectFrom(v[k]);
      if (inner) return inner;
    }
  }
  return null;
}

/** PhotoCraft reports `hasSelection` and `selectionBounds: [x, y, w, h]`; other shapes are accepted too. */
export function findSelectionRect(state: any): Rect | null {
  const seen = new Set<any>();
  const walk = (node: any): Rect | null => {
    if (!node || typeof node !== "object" || seen.has(node)) return null;
    seen.add(node);
    if (node.hasSelection === false) return null;
    for (const [k, v] of Object.entries(node)) {
      if (/^selection(bounds|rect)?$/i.test(k)) {
        if (v === null || v === false) return null;
        if (typeof v === "object" && (v as any).empty === true) return null;
        const r = rectFrom(v);
        if (r) return r;
      }
    }
    for (const [k, v] of Object.entries(node)) {
      if (/^(layers|children|history)$/i.test(k)) continue;
      const r = walk(v);
      if (r) return r;
    }
    return null;
  };
  return walk(state);
}
