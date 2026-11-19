// Live check for the `launch` plan step: one call starts the app, adopts its
// window and reads it.   node test/launch-step.mjs
import { loadTool } from "./_harness.mjs";

const { run } = await loadTool();
let failed = 0;
function check(name, cond, detail) {
  console.log(`${cond ? "ok  " : "FAIL"} ${name}${detail ? "  " + detail : ""}`);
  if (!cond) failed++;
}

// cmd.exe is the honest test: it has a window the moment launch returns, and
// its console exposes text to readtext.
const r = await run({
  action: "run",
  plan: [
    "launch C:\\Windows\\System32\\cmd.exe",
    "wait /Microsoft Windows/ 6000",
    "read"
  ].join("\n")
});

const transcript = String(r.text || "");
check("one call launches, waits and reads", r.ok !== false, transcript);
check("the launched window was adopted (hwnd in the transcript)", /1 launch cmd\.exe pid \d+ hwnd \d+/.test(transcript), transcript.split("\n")[0] || "");
const lines = transcript.split("\n");
check("the wait matched the console text", /^2 wait /.test(lines[1] || "") && !/FAILED/.test(lines[1] || ""), lines[1] || "");

// The plan must not silently point at whatever was in front before.
check("the read came from the launched window", /^3 read \d+ch/.test(lines[2] || ""), lines[2] || "");

// Dry run parses the step without starting anything.
const dry = await run({ action: "run", plan: "launch C:\\Windows\\System32\\cmd.exe", dryRun: true });
check("a dry run lists the launch step", dry.dryRun === true && dry.steps[0] && dry.steps[0].op === "launch", JSON.stringify(dry.steps));

// Clean up only the console this script started.
const list = await run({ action: "windows" });
for (const w of list.windows || []) {
  if (String(w.process || "").toLowerCase() === "cmd.exe" && w.pid === r.pid) await run({ action: "kill", pid: w.pid }).catch(() => {});
}
console.log(failed ? `\n${failed} failed` : "\nall good");
process.exit(failed ? 1 : 0);
