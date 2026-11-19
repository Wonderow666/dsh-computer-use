// Live check: how much does the session bootstrap cost now, and what does it say?
import { loadTool } from "./_harness.mjs";

const { run } = await loadTool();

const t0 = Date.now();
const s = await run({ action: "session" });
const ms = Date.now() - t0;
console.log("session:", ms + "ms", JSON.stringify(s));
console.log("bytes:", JSON.stringify(s).length);

const t1 = Date.now();
const i = await run({ action: "info" });
console.log("info   :", Date.now() - t1 + "ms", "bytes:", JSON.stringify(i).length);

process.exit(0);
