// Unit tests for the image math and the doc_inspect parser. No PhotoCraft or Gemini needed.
import assert from "node:assert/strict";
import sharp from "sharp";
import { clipToCanvas, finishOutput, nearestRatio, planRegion, prepareInputs, ratioValue } from "../imaging";
import { findSelectionRect } from "../photocraft";

(async () => {
  // region planning: selection stays inside, region stays on canvas, ratio is close
  const cases = [
    { sel: { x: 100, y: 100, w: 200, h: 50 }, W: 1920, H: 1080 },
    { sel: { x: 0, y: 0, w: 1920, h: 1080 }, W: 1920, H: 1080 },
    { sel: { x: 1800, y: 900, w: 120, h: 180 }, W: 1920, H: 1080 },
    { sel: { x: 10, y: 10, w: 30, h: 900 }, W: 1000, H: 1000 },
    { sel: { x: 400, y: 0, w: 50, h: 3000 }, W: 800, H: 3000 },
  ];
  for (const c of cases) {
    const { region, ratio } = planRegion(c.sel, c.W, c.H, 0.35);
    assert.ok(region.x >= 0 && region.y >= 0, "region on canvas");
    assert.ok(region.x + region.w <= c.W && region.y + region.h <= c.H, `region inside canvas ${JSON.stringify(region)}`);
    assert.ok(region.x <= c.sel.x && region.y <= c.sel.y, `selection inside region ${JSON.stringify({ region, sel: c.sel })}`);
    assert.ok(region.x + region.w >= c.sel.x + c.sel.w && region.y + region.h >= c.sel.y + c.sel.h, "selection inside region (far edge)");
    assert.ok(ratioValue(ratio) > 0);
    if (c.W % 2 === 0) assert.ok(region.w % 2 === 0, "even width");
    if (c.H % 2 === 0) assert.ok(region.h % 2 === 0, "even height");
  }
  assert.equal(nearestRatio(1920, 1080), "16:9");
  assert.equal(nearestRatio(1000, 1000), "1:1");
  assert.equal(clipToCanvas({ x: -50, y: -50, w: 40, h: 40 }, 100, 100), null);
  assert.deepEqual(clipToCanvas({ x: -10, y: 5, w: 50, h: 500 }, 100, 100), { x: 0, y: 5, w: 40, h: 95 });

  // round trip: crop -> fake model output (other size) -> back to exact region size
  const doc = await sharp({ create: { width: 1200, height: 800, channels: 3, background: "#336699" } }).png().toBuffer();
  const sel = { x: 50, y: 600, w: 300, h: 180 };
  const { region, ratio } = planRegion(sel, 1200, 800, 0.35);
  const prep = await prepareInputs(doc, region, sel, ratio, 1024);
  const im = await sharp(prep.imagePng).metadata();
  const mk = await sharp(prep.maskPng).metadata();
  assert.equal(im.width, mk.width);
  assert.equal(im.height, mk.height);
  assert.ok(Math.max(im.width!, im.height!) <= 1024);
  assert.ok(Math.abs(im.width! / im.height! - ratioValue(ratio)) < 0.02, "sent image has the model ratio");
  const fake = await sharp({ create: { width: 1344, height: 768, channels: 3, background: "#ff0000" } }).png().toBuffer();
  const out = await sharp(await finishOutput(fake, prep)).metadata();
  assert.equal(out.width, region.w);
  assert.equal(out.height, region.h);

  // mask: white inside the selection, black outside
  const raw = await sharp(prep.maskPng).greyscale().raw().toBuffer({ resolveWithObject: true });
  const s = raw.info.width / (region.w + prep.pad.left + prep.pad.right);
  const px = (x: number, y: number) => raw.data[Math.round(y * s) * raw.info.width + Math.round(x * s)];
  assert.ok(px(sel.x - region.x + prep.pad.left + sel.w / 2, sel.y - region.y + prep.pad.top + sel.h / 2) > 200, "mask white in selection");
  assert.ok(px(prep.pad.left + 2, prep.pad.top + 2) < 50, "mask black outside");

  // doc_inspect parsing, several plausible shapes
  assert.deepEqual(findSelectionRect({ selection: { bounds: [1, 2, 3, 4] } }), { x: 1, y: 2, w: 3, h: 4 });
  assert.deepEqual(findSelectionRect({ doc: { selection: { x: 5, y: 6, width: 7, height: 8 } } }), { x: 5, y: 6, w: 7, h: 8 });
  assert.deepEqual(findSelectionRect({ selection: { left: 10, top: 10, right: 30, bottom: 20 } }), { x: 10, y: 10, w: 20, h: 10 });
  assert.equal(findSelectionRect({ selection: null, layers: [{ selection: [1, 1, 1, 1] }] }), null);
  // shape returned by the real PhotoCraft doc_inspect
  const real = { activeLayer: 2, hasSelection: true, height: 1500, width: 2100,
    layers: [{ id: 2, name: "Background", bounds: [0, 0, 2100, 1500] }], selectionBounds: [608, 251, 1124, 882] };
  assert.deepEqual(findSelectionRect(real), { x: 608, y: 251, w: 1124, h: 882 });
  assert.equal(findSelectionRect({ ...real, hasSelection: false }), null);

  console.log("unit: all tests passed");
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
