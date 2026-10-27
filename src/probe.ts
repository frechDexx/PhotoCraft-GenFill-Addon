// Diagnostics: connects to the running PhotoCraft and writes probe-report.json (npm run probe).
import fs from "node:fs";
import path from "node:path";
import { APP_DIR, loadConfig } from "./config";
import { PhotoCraft } from "./photocraft";

(async () => {
  const pc = new PhotoCraft(loadConfig(), (m) => console.log(m));
  try {
    const report = await pc.probe();
    const out = path.join(APP_DIR, "probe-report.json");
    fs.writeFileSync(out, JSON.stringify(report, null, 2));
    console.log(`\nReport written: ${out}`);
    console.log(`Active document: ${JSON.stringify(report.detected.document)}`);
    console.log(`Selection:       ${JSON.stringify(report.detected.selection)}`);
  } catch (e) {
    console.error(`Error: ${(e as Error).message}`);
    process.exitCode = 1;
  } finally {
    await pc.close();
  }
})();
