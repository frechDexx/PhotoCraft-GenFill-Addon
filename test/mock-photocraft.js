// A small stand-in for `photocraft-cli mcp --bridge`, used by `npm run test:e2e`.
// It mimics what the real bridge mode does, including what it refuses:
// placing or replacing contents by path, Smart Object via Copy, and doc_close.
//
// usage: node test/mock-photocraft.js <exchange-root>
"use strict";
const path = require("node:path");
const { McpServer } = require("@modelcontextprotocol/sdk/server/mcp.js");
const { StdioServerTransport } = require("@modelcontextprotocol/sdk/server/stdio.js");
const { z } = require("zod");
const sharp = require("sharp");

const ROOT = process.argv[2];
const AMBIENT = (id) => `app: automation command \`${id}\` uses ambient filesystem paths and is disabled; use capability-scoped document methods`;

let nextId = 100;
let clipboard = null;
// two documents open; the user works in "Untitled-1": a photo (Smart Object) over a white background
const docs = [
  { name: "Other", w: 800, h: 600, hist: 0, sel: null, channels: {},
    layers: [{ id: 1, name: "Background", kind: "Pixel", visible: true, bounds: [0, 0, 800, 600] }] },
  { name: "Untitled-1", w: 2100, h: 1500, hist: 0, sel: [608, 251, 1124, 882], channels: {},
    layers: [
      { id: 3, name: "photo", kind: "SmartObject", visible: true, bounds: [46, 0, 2008, 1500] },
      { id: 2, name: "Background", kind: "Pixel", visible: true, bounds: [0, 0, 2100, 1500] },
    ] },
];
let active = 1;
const D = () => docs[active];

const server = new McpServer({ name: "mock-photocraft", version: "1.0.0" });
const ok = (o) => ({ content: [{ type: "text", text: JSON.stringify(o ?? { ok: true }) }] });
const fail = (t) => ({ isError: true, content: [{ type: "text", text: t }] });

server.tool("doc_inspect", "Document state", {}, async () => {
  const d = D();
  return ok({ name: d.name, width: d.w, height: d.h, canUndo: d.hist > 0, hasSelection: !!d.sel,
    selectionBounds: d.sel, activeLayer: d.layers[0]?.id, layers: d.layers });
});
server.tool("doc_export", "Export", { path: z.string(), format: z.string().optional() }, async (a) => {
  if (a.format) return fail("bridge mode saves with the app's current settings; `format` needs headless mode");
  const abs = path.join(ROOT, a.path);
  await sharp({ create: { width: D().w, height: D().h, channels: 3, background: "#6688aa" } }).png().toFile(abs);
  return ok();
});
server.tool("doc_open", "Open", { path: z.string() }, async (a) => {
  const m = await sharp(path.join(ROOT, a.path)).metadata();
  docs.push({ name: path.basename(a.path), w: m.width, h: m.height, hist: 0, sel: null, channels: {},
    layers: [{ id: nextId++, name: "Background", kind: "Pixel", visible: true, bounds: [0, 0, m.width, m.height] }] });
  active = docs.length - 1;
  return ok({ index: active });
});
server.tool("doc_place", "Place", { path: z.string() }, async () => fail(AMBIENT("file.placeEmbedded")));
server.tool("doc_replace_smart_object", "Replace", { path: z.string(), layer: z.any().optional() }, async () =>
  fail(AMBIENT("layer.smartObjects.replaceContents")));
server.tool("doc_close", "Close", { index: z.number().optional() }, async () =>
  fail("`doc_close` is only available in headless mode (in the GUI use the window/tab UI or control_call)"));
server.tool("ui_menu_invoke", "Menu", { id: z.string() }, async ({ id }) => {
  if (id !== "file.close") return fail(`unknown menu id ${id}`);
  if (D().hist > 0) return fail("mock: a save prompt would block here, the document is modified");
  docs.splice(active, 1);
  active = 0;
  return ok();
});
server.tool("command_list", "Commands", {}, async () => ok([
  ["layer.list", "List Layers"], ["layer.delete", "Delete Layer"], ["layer.hideLayers", "Hide Layers"],
  ["layer.move", "Move Layer"], ["layer.rename", "Rename Layer"], ["layer.select", "Select Layer"],
  ["layer.arrange.bringToFront", "Bring to Front"], ["layer.layerMask.revealSelection", "Reveal Selection"],
  ["select.all", "All"], ["select.saveSelection", "Save Selection"], ["select.loadSelection", "Load Selection"],
  ["channel.delete", "Delete Channel"], ["edit.copy", "Copy"], ["edit.undo", "Undo"],
  ["edit.pasteSpecial.pasteInPlace", "Paste in Place"], ["document.activate", "Activate Document"],
  ["layer.smartObjects.newSmartObjectViaCopy", "New Smart Object via Copy"],
].map(([id, label]) => ({ id, label, enabled: true }))));
server.tool("command_run", "Run", { id: z.string(), params: z.record(z.string(), z.any()).optional() }, async ({ id, params = {} }) => {
  const d = D();
  const L = d.layers.find((l) => String(l.id) === String(params.layer));
  switch (id) {
    case "layer.list": return ok({ layers: d.layers });
    case "layer.smartObjects.newSmartObjectViaCopy": return fail(AMBIENT(id));
    case "select.all": d.hist++; d.sel = [0, 0, d.w, d.h]; return ok();
    case "edit.undo": d.hist = Math.max(0, d.hist - 1); d.sel = null; return ok();
    case "edit.copy": if (!d.sel) return fail("no selection"); clipboard = { w: d.w, h: d.h }; return ok();
    case "document.activate": active = (active + params.offset + docs.length) % docs.length; return ok();
    case "edit.pasteSpecial.pasteInPlace":
      d.sel = null; // like the real app: pasting drops the selection
      d.layers.splice(d.layers.indexOf(d.layers[0]) + 1, 0, { id: nextId++, name: "Layer 1", kind: "Pixel", visible: true, bounds: [0, 0, clipboard.w, clipboard.h] });
      return ok();
    case "select.saveSelection": d.channels[params.name] = d.sel; return ok();
    case "select.loadSelection": if (!d.channels[params.channel]) return fail("no such channel"); d.sel = d.channels[params.channel]; return ok();
    case "channel.delete": delete d.channels[params.channel]; return ok();
    case "layer.select": return ok();
  }
  if (!L) return fail(`no layer ${params.layer} in ${d.name}`);
  switch (id) {
    case "layer.rename": L.name = params.name; return ok();
    case "layer.move": L.bounds = [L.bounds[0] + params.dx, L.bounds[1] + params.dy, L.bounds[2], L.bounds[3]]; return ok();
    case "layer.arrange.bringToFront":
      if (d.layers[0] === L) return fail("app: layer can't move further");
      d.layers.splice(d.layers.indexOf(L), 1); d.layers.unshift(L); return ok();
    case "layer.hideLayers": L.visible = !L.visible; return ok();
    case "layer.delete": d.layers.splice(d.layers.indexOf(L), 1); return ok();
    case "layer.layerMask.revealSelection":
      if (!d.sel) return fail(`app: command \`${id}\` is not available right now: no selection`);
      L.mask = [...d.sel]; return ok();
  }
  return fail(`mock: unknown command ${id}`);
});
// test hook: the whole fake app state
server.tool("mock_state", "Mock state", {}, async () => ok({ docs, active }));

server.connect(new StdioServerTransport());
