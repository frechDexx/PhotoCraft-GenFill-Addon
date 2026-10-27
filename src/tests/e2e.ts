// End-to-end test of the full flow against test/mock-photocraft.js and a fake Gemini.
// Run with: npm run test:e2e
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import sharp from "sharp";
import { APP_DIR, type Config } from "../config";
import { GenFill } from "../genfill";

(async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "genfill-e2e-"));
  const cfg: Config = {
    geminiApiKey: "test-key", model: "fake-image-model", imageSize: "", variants: 3, contextPadding: 0.35,
    maxInputSide: 1024, hotkey: "", photocraftDir: "", launchPhotoCraft: false, controlPort: 0,
    controlTokenFile: "", automationRoot: root,
  };

  // fake Gemini: an image in the requested ratio; the second call of the run fails like a rate limit
  let calls = 0;
  (globalThis as any).fetch = async (url: string, init: any) => {
    calls++;
    const body = JSON.parse(init.body);
    assert.match(url, /fake-image-model:generateContent$/);
    assert.equal(body.contents[0].parts.length, 3, "prompt, image and mask");
    const [a, b] = String(body.generationConfig.imageConfig.aspectRatio).split(":").map(Number);
    if (calls === 2) return new Response(JSON.stringify({ error: { message: "quota" } }), { status: 429 });
    const png = await sharp({ create: { width: 1024, height: Math.round((1024 * b) / a), channels: 3, background: "#cc3333" } }).png().toBuffer();
    return new Response(JSON.stringify({ candidates: [{ content: { parts: [{ inlineData: { mimeType: "image/png", data: png.toString("base64") } }] } }] }));
  };

  const statuses: string[] = [];
  const gf = new GenFill(cfg, (m) => statuses.push(m), () => {}, {
    command: process.execPath,
    args: [path.join(APP_DIR, "test", "mock-photocraft.js"), root],
  });

  let st = await gf.generate("a red balloon");
  assert.equal(st.variants.length, 2, "3 requested, 1 failed");
  assert.equal(st.active, 1);
  assert.match(statuses.at(-1)!, /2 variants ready \(1 failed/);

  st = await gf.show(0);
  assert.equal(st.active, 0);

  st = await gf.generate("a red balloon");
  assert.equal(st.variants.length, 5, "same selection: new variants are added to the set");

  const app: any = await gf.photocraft.tool("mock_state");
  const doc = app.docs.find((d: any) => d.name === "Untitled-1");
  assert.equal(app.docs.length, 2, "helper documents are closed again");
  assert.equal(app.docs[app.active].name, "Untitled-1", "the user's document is active again");
  assert.deepEqual(doc.sel, [608, 251, 1124, 882], "the user's selection is restored");
  assert.deepEqual(doc.channels, {}, "the helper channel is removed");

  const variants = doc.layers.filter((l: any) => l.name.startsWith("GenFill a red balloon"));
  assert.equal(variants.length, 5);
  assert.equal(variants.filter((l: any) => l.visible).length, 1, "exactly one variant visible");
  for (const l of variants) {
    assert.deepEqual(l.mask, [608, 251, 1124, 882], `${l.name} masked by the selection`);
    assert.ok(l.bounds[0] <= 608 && l.bounds[1] <= 251, `${l.name} placed around the selection`);
    assert.ok(l.bounds[0] + l.bounds[2] >= 608 + 1124 && l.bounds[1] + l.bounds[3] >= 251 + 882);
  }
  assert.ok(doc.layers[0].name.startsWith("GenFill"), "variants sit on top of the photo");
  const photo = doc.layers.find((l: any) => l.name === "photo");
  assert.deepEqual(photo.bounds, [46, 0, 2008, 1500], "the user's own layers are untouched");

  st = await gf.show(0);
  st = await gf.keep();
  assert.equal(st.variants.length, 0);
  const after: any = await gf.photocraft.tool("mock_state");
  const left = after.docs.find((d: any) => d.name === "Untitled-1").layers.filter((l: any) => l.name.startsWith("GenFill"));
  assert.equal(left.length, 1, "Keep leaves exactly one variant");
  assert.equal(left[0].name, "GenFill a red balloon 1", "the one that was shown");

  await gf.photocraft.close();
  fs.rmSync(root, { recursive: true, force: true });
  console.log("e2e: all tests passed");
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
