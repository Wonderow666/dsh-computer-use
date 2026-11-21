// Live check for failure forensics: a real window, a real failed wait, and the
// directory a human could open to see what happened.   node test/forensics-live.mjs
import { loadTool } from "./_harness.mjs";
import fs from "node:fs";
import path from "node:path";

const { run } = await loadTool();
let failed = 0;
function check(name, cond, detail) {
  console.log(`${cond ? "ok  " : "FAIL"} ${name}${detail ? "  " + detail : ""}`);
  if (!cond) failed++;
}

const r = await run({
  action: "run",
  plan: [
    "launch C:\\Windows\\System32\\cmd.exe",
    "wait /definitely-not-on-this-screen/ 1500"
  ].join("\n")
});
const transcript = String(r.text || "");
const m = /forensics: (.+)$/m.exec(transcript);
check("the failed plan names its dump directory", Boolean(m), transcript.split("\n").slice(-3).join(" | "));
if (!m) process.exit(1);
const dir = m[1].trim();

const files = ["plan.txt", "transcript.txt", "where.json", "shot.png", "tree.json"];
for (const f of files) check(`dump has ${f}`, fs.existsSync(path.join(dir, f)));

const shot = path.join(dir, "shot.png");
if (fs.existsSync(shot)) {
  const bytes = fs.statSync(shot).size;
  check("the screenshot is a real picture, not a black frame", bytes > 8000, `${Math.round(bytes / 1024)}KB`);
}
const tree = path.join(dir, "tree.json");
if (fs.existsSync(tree)) {
  const j = JSON.parse(fs.readFileSync(tree, "utf8"));
  check("the tree dump has nodes", Array.isArray(j.items) ? j.items.length > 0 : Boolean(j.root), JSON.stringify(j).slice(0, 120));
}

const list = await run({ action: "failures", limit: 3 });
check("failures lists the dump it just wrote", (list.failures || []).some((f) => f.dir === dir), JSON.stringify(list).slice(0, 200));

console.log(`\ndump: ${dir}`);
console.log(failed ? `${failed} failed` : "all good");
process.exit(failed ? 1 : 0);
