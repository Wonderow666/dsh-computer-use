// One-call plan execution against a real console: the token-economy check.
//
//   node test/plan.mjs
//
// The point is not that typing works (console.mjs proves that). The point is
// that the whole sequence - wait for the prompt, type, press enter, wait for the
// output, read it - costs ONE tool call and a five-line transcript, instead of
// five calls each followed by a screenshot to see whether it worked.
import { loadTool, ENGINE, ARTIFACTS } from "./_harness.mjs";
import { spawnSync } from "node:child_process";
import path from "node:path";
import fs from "node:fs";

const results = [];
function check(name, cond, detail) {
  results.push({ name, ok: Boolean(cond), detail });
  console.log(`${cond ? "ok  " : "FAIL"} ${name}${detail ? ` — ${detail}` : ""}`);
  if (!cond) process.exitCode = 1;
}

const { run } = await loadTool();

const proof = path.join(ARTIFACTS, "plan-proof.txt");
try { fs.unlinkSync(proof); } catch {}

const launched = await run({ action: "launch", path: "C:\\Windows\\System32\\cmd.exe" });
const pid = launched.pid;
let con = null;
for (let i = 0; i < 20 && !con; i++) {
  const list = await run({ action: "windows" });
  con = (list.windows || []).find((w) => Number(w.pid) === Number(pid) && w.visible);
  if (!con) await new Promise((r) => setTimeout(r, 250));
}
check("console window appeared", Boolean(con), con && `hwnd=${con.hwnd}`);

// The plan: every step states its own post-condition, so nothing needs a
// screenshot to be believed.
const plan = [
  `wait /[$#>]\\s*$/ 8000`,
  `type echo plan-ok>${proof}`,
  `key enter`,
  `wait /plan-ok/ 8000`,
  `read`
].join("\n");

const started = Date.now();
const out = await run({ action: "run", hwnd: String(con.hwnd), plan });
const ms = Date.now() - started;
console.log("--- transcript ---");
console.log(out.text);
console.log("--- /transcript ---");

check("plan reports success", /done 5\/5/.test(out.text), `${ms}ms`);
check("transcript has one line per step", (out.text.trim().split(/\r?\n/).length) === 6);
check("transcript is compact", out.text.length < 400, `${out.text.length} bytes`);
check("every step is reported", /1 wait/.test(out.text) && /3 key enter/.test(out.text) && /5 read/.test(out.text));
check("the command really executed", fs.existsSync(proof), fs.existsSync(proof) ? `${fs.statSync(proof).size} bytes` : "missing");

// A failing post-condition must stop the plan and show what the window said.
const failing = await run({ action: "run", hwnd: String(con.hwnd), plan: "wait /definitely-not-on-screen/ 900\nread" });
console.log("--- failing transcript ---");
console.log(failing.text);
check("a failed wait stops the plan", /FAILED/.test(failing.text) && /stopped at step 1 of 2/.test(failing.text));
check("the failure quotes the window text", /last text:/.test(failing.text));

const killed = spawnSync(ENGINE, ["kill", "--pid", String(pid)], { encoding: "utf8" });
check("console closed", killed.status === 0, (killed.stdout || "").trim().slice(0, 60));

const failed = results.filter((r) => !r.ok).length;
console.log(`\n${results.length - failed} passed, ${failed} failed  (artifacts: ${ARTIFACTS})\n`);
