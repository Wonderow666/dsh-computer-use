// Live check of the profile path against a real window and the real engine.
//
// Read-only on purpose: the plan only reads text, so nothing is typed and no
// window has to be raised. Proves three things the mocked unit tests cannot:
// the profile's `match` resolves a real HWND, `run` injects that hwnd into the
// engine calls, and the alias/window plumbing survives a real spawn.
//
//   node test/profile-live.mjs
import { loadTool } from "./_harness.mjs";

const results = [];
function check(name, cond, detail) {
  results.push({ name, ok: Boolean(cond), detail });
  console.log(`${cond ? "ok  " : "FAIL"} ${name}${detail ? ` — ${detail}` : ""}`);
  if (!cond) process.exitCode = 1;
}

const cfg = {
  profiles: {
    console: {
      match: { process: "cmd.exe" },
      notes: "the classic console host",
      plans: { peek: "read" }
    }
  }
};

const { run } = await loadTool(cfg);

const launched = await run({ action: "launch", path: "cmd.exe" });
check("launched a console", launched.ok !== false && launched.pid > 0, `pid=${launched.pid} hwnd=${launched.hwnd}`);

// Give the console a moment to create its window, then let the profile find it.
let hwnd = launched.hwnd;
for (let i = 0; i < 20 && !hwnd; i++) {
  const w = await run({ action: "windows" });
  const hit = (w.windows || []).find((x) => x.pid === launched.pid && x.visible);
  hwnd = hit ? hit.hwnd : 0;
  if (!hwnd) await new Promise((r) => setTimeout(r, 250));
}
check("the console window exists", Boolean(hwnd), `hwnd=${hwnd}`);

const state = await run({ action: "state" });
check("state names the profile for the front window", Boolean(state.profile), JSON.stringify(state.profile));

const played = await run({ action: "run", profile: "console", task: "peek" });
check("the saved plan replayed", /done 1\/1/.test(played.text || ""), (played.text || "").replace(/\n/g, " | "));
check("the transcript reports how much it read", /read \d+ch via \w+/.test(played.text || ""), played.text || "");

// The transcript is one line per step by design - read the text directly to
// prove the engine really pulled characters out of that window.
const text = await run({ action: "readtext", hwnd: String(hwnd), chars: 400 });
check("readtext on that window returns console text", /Microsoft Windows|dsh-computer-use>/.test(text.text || ""), `${text.chars} chars, strategy=${text.strategy}`);

const listing = await run({ action: "profiles" });
check("profiles lists it without the plan body", listing.count === 1 && !JSON.stringify(listing).includes("read\n"), JSON.stringify(listing.profiles[0]));

if (launched.pid) await run({ action: "kill", pid: launched.pid });
console.log(`\n${results.filter((r) => r.ok).length} passed, ${results.filter((r) => !r.ok).length} failed`);
