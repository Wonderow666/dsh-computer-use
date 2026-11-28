// The bug this guards: at 2ms per character a 7-char burst came out wrong 5
// times in 12 ("xyz 123" -> "xyz 223", "xyz 333", "xyz 3"). The engine now
// waits 8ms per character and reads the text back before saying ok.
import { loadTool } from "./_harness.mjs";

const tool = await loadTool({});
const failures = [];
const check = (name, fn) => {
  try { fn(); console.log("  ok   " + name); }
  catch (e) { failures.push(name); console.log("  FAIL " + name + "\n       " + e.message); }
};

const started = await tool.run({
  action: "run",
  plan: "launch C:\\Windows\\System32\\notepad.exe\nwait /无标题|Notepad|行 1|Line 1/ 8000\nsleep 500"
});
const hwnd = /hwnd (\d+)/.exec(String(started.text))?.[1];
const pid = Number(/pid (\d+)/.exec(String(started.text))?.[1]);
check("notepad is up", () => { if (!hwnd) throw new Error(String(started.text)); });

const want = "xyz 123";
let bad = 0;
for (let i = 0; i < 12; i++) {
  await tool.run({ action: "key", hwnd, combo: "ctrl+a" });
  await tool.run({ action: "key", hwnd, combo: "delete" });
  const typed = await tool.run({ action: "type", hwnd, text: want });
  await new Promise((r) => setTimeout(r, 200));
  const got = String((await tool.run({ action: "readtext", hwnd, chars: 200 })).text || "").split(/\n/)[0];
  if (!got.startsWith(want) || typed.verified !== true) { bad++; console.log(`  lost: ${JSON.stringify(got)} ${JSON.stringify(typed)}`); }
}
check(`12 bursts of ${JSON.stringify(want)} land unchanged`, () => {
  if (bad) throw new Error(`${bad}/12 wrong`);
});

const verify = await tool.run({ action: "type", hwnd, text: "hello dsh" , verify: true });
check("a verified type says so", () => {
  if (verify.verified !== true) throw new Error(JSON.stringify(verify));
});

const line = String((await tool.run({ action: "run", hwnd, plan: `type zzz` })).text);
check("a plan says the type was verified", () => {
  if (!/1 type 3ch verified/.test(line)) throw new Error(line);
});

if (pid) await tool.run({ action: "kill", pid });
console.log(`\n${failures.length} failed`);
process.exit(failures.length ? 1 : 0);
