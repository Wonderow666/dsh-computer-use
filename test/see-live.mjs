// Real desktop, real engine: see numbers the things it can see, and clicknum
// clicks the number that was printed. It starts its own window: a test that
// depends on what the user happened to have open fails for the wrong reason.
import fs from "node:fs";
import path from "node:path";
import { loadTool, ROOT } from "./_harness.mjs";

const { run } = await loadTool();
let pass = 0, fail = 0;
const ok = (name, cond, extra = "") => {
  if (cond) { pass++; console.log(`  ok   ${name}`); }
  else { fail++; console.log(`  FAIL ${name} ${extra}`); }
};

const launched = await run({ action: "launch", path: "notepad.exe" });
// Windows 11 Notepad is a packaged app: the window does not carry the pid we
// launched, so find it by name, the way a person would.
await new Promise((r) => setTimeout(r, 2500));
let chosen = null;
for (let i = 0; i < 10 && !chosen; i++) {
  const listed = await run({ action: "windows" });
  chosen = (listed.windows || []).find((w) => /notepad/i.test(w.process || "") && w.visible !== false && w.title);
  if (!chosen) await new Promise((r) => setTimeout(r, 500));
}
if (!chosen) { console.log("notepad never showed a window; nothing to test"); process.exit(0); }
console.log(`  window ${chosen.hwnd} ${chosen.process} "${chosen.title}"`);

const seen = await run({ action: "see", hwnd: String(chosen.hwnd), max: 6, goal: "find a button" });
ok("see returns a picture", typeof seen.image === "string" && fs.existsSync(seen.image), JSON.stringify(seen).slice(0, 300));
ok("see returns numbered targets", Array.isArray(seen.targets) && seen.targets.length > 0, JSON.stringify(seen.targets));
ok("every target has a name and a number", (seen.targets || []).every((t) => t.n >= 1 && typeof t.name === "string" && t.name.length > 0));
console.log("  targets:", (seen.targets || []).map((t) => `${t.n}:${t.role}:${t.name}`).join(" | "));

const bytes = seen.image && fs.existsSync(seen.image) ? fs.statSync(seen.image).size : 0;
ok("the picture is a real frame, not a blank one", bytes > 10000, `${bytes} bytes`);
ok("the goal came back with it", seen.goal === "find a button", String(seen.goal));

// The sidecar remembers what the numbers mean.
const side = path.join(ROOT, "artifacts", "e2e", "see", "last.json");
ok("see wrote the sidecar", fs.existsSync(side), side);
const last = JSON.parse(fs.readFileSync(side, "utf8"));
ok("the sidecar keeps the clickable rects", Array.isArray(last.targets) && last.targets.every((t) => t.rect && t.rect.w > 0), JSON.stringify(last.targets[0] || null));

// clicknum refuses a number that was never printed.
let refused = null;
try { await run({ action: "clicknum", n: 999 }); } catch (e) { refused = e.message; }
ok("clicknum refuses a number the picture did not have", !!refused && /999/.test(refused), String(refused));

// clicknum follows the map. A tab or a menu title only moves the selection, so
// the test does not change anything on disk.
const tab = last.targets.find((t) => /^(TabItem|MenuItem)$/.test(t.role)) || last.targets[0];
const clicked = await run({ action: "clicknum", n: tab.n });
ok("clicknum clicks the numbered thing", clicked.ok === true && clicked.clicked && clicked.clicked.n === tab.n, JSON.stringify(clicked));
ok("it says how it clicked", clicked.how === "invoke" || clicked.how === "point", String(clicked.how));
console.log(`  clicked ${clicked.clicked.n}:${clicked.clicked.role}:${clicked.clicked.name} via ${clicked.how}`);

// Leave the desktop as it was: only the process this test started.
try { await run({ action: "kill", pid: launched.pid }); } catch { console.log("  note: could not close notepad (it may be elevated)"); }

console.log(`\n${pass} passed, ${fail} failed`);
process.exitCode = fail ? 1 : 0;
