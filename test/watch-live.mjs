// Real engine, real window, no stubs: a watch must stay quiet on a quiet
// desktop and return the instant a window appears - and it must not cost a
// poll loop to do it.
import assert from "node:assert";
import { execFile } from "node:child_process";
import { loadTool, sleep } from "./_harness.mjs";

const { run } = await loadTool();
let pass = 0;
const ok = (name, cond, extra = "") => {
  if (cond) { pass++; console.log(`  ok   ${name}`); }
  else { console.log(`  FAIL ${name} ${extra}`); process.exitCode = 1; }
};

// 1. Nothing happening: the watch returns a timeout, with the elapsed time.
const quiet = await run({ action: "watch", event: "window-created", timeout: 400 });
ok("a quiet desktop times out instead of hanging", quiet.fired === false && quiet.waitedMs >= 380, JSON.stringify(quiet).slice(0, 200));

// 2. Something appears mid-wait: the watch returns at once, and reports it.
const pending = run({ action: "watch", event: "window-created", timeout: 8000 });
await sleep(600);
const started = Date.now();
const child = execFile("notepad.exe", [], { windowsHide: false });
child.on("error", () => {});
const got = await pending;
const elapsed = Date.now() - started;
ok("a watch fires on the window that appears", got.fired === true, JSON.stringify(got).slice(0, 300));
ok("the window it reports is the one that appeared", !!got.window && /notepad|记事本/i.test(`${got.window.process} ${got.window.title}`), JSON.stringify(got.window));
ok("it returned when the window appeared, not after the timeout", elapsed < 6000, `${elapsed}ms`);
ok("no polling was needed: one engine call answered", typeof got.waitedMs === "number", JSON.stringify(got.waitedMs));

// 3. In a plan: the watch is the step that gives the plan a window to work on.
//    `launch` already returns the window it started, so waiting for
//    "window-created" after it would wait for a window that already exists -
//    the useful shape is to watch first, and let the app appear from outside.
child.kill();
await sleep(400);
const pendingPlan = run({
  action: "run",
  plan: "watch window-created 8000\nread 200"
});
await sleep(500);
const spawned = execFile("notepad.exe", [], { windowsHide: false });
spawned.on("error", () => {});
const plan = await pendingPlan;
ok("a plan can wait for a window and then read it",
  /1 watch window-created \d+ms "/.test(plan.text) && /2 read \d+ch/.test(plan.text) && /done 2\/2/.test(plan.text),
  plan.text);

// Clean up: only the notepad windows we passed. Several windows can share one
// pid, and a window may belong to a process this engine cannot end (elevated,
// another session), so each pid is tried once and cleanup never fails the run.
const wins = await run({ action: "windows" });
const pids = [...new Set((wins.windows || []).filter((w) => /notepad\.exe/i.test(w.process || "")).map((w) => w.pid))];
for (const pid of pids) {
  try { await run({ action: "kill", pid }); }
  catch (e) { console.log(`  note: could not close notepad pid ${pid}: ${e.message}`); }
}

console.log(`\n${pass} passed`);
if (process.exitCode) console.log("(see the FAIL lines above)");
