// What this tool costs the model on EVERY request: description + parameter schema.
// Run: node tools/schema-cost.mjs   (or: pnpm run schema:cost)
import { fileURLToPath } from "node:url";
import path from "node:path";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const mod = await import(new URL("../lib/index.js", import.meta.url).href);

const defs = [];
mod.apply(
  {
    tools: { register: (d) => defs.push(d) },
    on() {},
    effect(fn) { fn(); },
    inject() {}
  },
  {
    enabled: true,
    enginePath: path.join(ROOT, "bin", "cu.exe"),
    artifactsDir: path.join(ROOT, "artifacts", "unit"),
    blockedProcesses: [],
    refuseFullscreenForeground: false,
    allowProcessControl: true,
    timeoutMs: 5000
  }
);

const def = defs[0];
const desc = def.description || "";
const params = JSON.stringify(def.parameters || {});
const total = desc.length + params.length;

console.log("description chars:", desc.length);
console.log("parameter json  :", params.length);
console.log("total per request:", total);

const props = (def.parameters && def.parameters.properties) || {};
const rows = Object.entries(props)
  .map(([k, v]) => [k, (v.description || "").length])
  .sort((a, b) => b[1] - a[1])
  .slice(0, 10);
console.log("\nlongest descriptions (chars):");
for (const [k, n] of rows) console.log("  " + k.padEnd(16) + String(n).padStart(4));

// A parameter costs ~60 characters of JSON scaffolding before you write a word.
console.log("\nparameters:", Object.keys(props).length, "-> scaffolding ~" + Object.keys(props).length * 60 + " chars");
process.exit(0);
