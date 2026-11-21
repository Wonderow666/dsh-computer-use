// Live check: click a control by name, and let a plan step loop until the
// window agrees. Runs the engine the way production does (staged copy), because
// an engine started straight from the workspace has no UIA view at all.
import { loadTool } from "./_harness.mjs";

const { run } = await loadTool();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let failed = 0;
const check = (name, cond, detail) => {
  console.log(`${cond ? "ok  " : "FAIL"} ${name}${detail ? "  " + detail : ""}`);
  if (!cond) failed++;
};

let launched;
try { launched = await run({ action: "launch", path: "notepad.exe" }); }
catch (e) { console.log("skip: notepad will not start here:", e.message); process.exit(0); }
console.log("launched:", JSON.stringify(launched).slice(0, 160));
await sleep(2500);

let win = null;
for (let i = 0; i < 10 && !win; i++) {
  const list = await run({ action: "windows" });
  win = (list.windows || []).find((w) => /notepad/i.test(w.process || "") && w.visible !== false);
  if (!win) await sleep(500);
}
check("notepad has a window to talk to", Boolean(win), win ? `hwnd ${win.hwnd} "${win.title}"` : "none");
if (!win) process.exit(1);

const hwnd = String(win.hwnd);
const ui = await run({ action: "ui", hwnd, max: 40 });
const named = (ui.items || ui.controls || []).filter((c) => c && c.name);
check("the accessibility tree is not empty", named.length > 0, `${ui.count} named, ${ui.scanned} scanned`);
console.log("controls:", named.slice(0, 12).map((c) => `${c.role}:${c.name}`).join(" | ").slice(0, 400));

// Locale decides the spelling of the first menu; ask for whatever is there.
const pick = named.find((c) => c.role === "MenuItem") || named[0];
const r = await run({ action: "click", name: pick.name, hwnd });
check("click --name resolved a real control", r.ok !== false, JSON.stringify(r).slice(0, 160));
check("it went through invoke or a real click", r.how === "invoke" || r.how === "click", r.how);
await run({ action: "key", hwnd, keys: "escape" }).catch(() => {});

const t = await run({ action: "run", hwnd, plan: "until /notepad|记事本|无标题/ 6000 key ctrl+a" });
const text = String(t.text || JSON.stringify(t));
check("until ran its step until the text agreed", /until \/.*\/ ok|key ctrl\+a until/.test(text), text.slice(0, 220));

console.log(failed ? `${failed} failed` : "all good");
process.exit(failed ? 1 : 0);
