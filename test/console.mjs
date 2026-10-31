// Keyboard proof that does not fight the foreground lock: launch a console
// window (Windows lets a freshly created process come to the front), type a
// command into it, press Enter, then read the file the command wrote.
//
//   node test/console.mjs
import fs from "node:fs";
import path from "node:path";
import { ARTIFACTS, loadTool, sleep } from "./_harness.mjs";

const OUT = path.join(ARTIFACTS, "console-proof.txt");

const { run } = await loadTool({ artifactsDir: path.join(ARTIFACTS, "console") });
const check = (name, ok, extra = "") => {
  console.log(`${ok ? "ok  " : "FAIL"} ${name}${extra ? " - " + extra : ""}`);
  if (!ok) process.exitCode = 1;
};

fs.mkdirSync(path.dirname(OUT), { recursive: true });
try { fs.unlinkSync(OUT); } catch {}

const launched = await run({ action: "launch", path: "C:\\Windows\\System32\\cmd.exe" });
check("launch cmd.exe", launched.ok !== false && launched.pid > 0, JSON.stringify(launched).slice(0, 120));
await sleep(900);

const wins = await run({ action: "windows" });
const con = (wins.windows || []).find((w) => Number(w.pid) === Number(launched.pid));
if (!con) {
  console.log("FAIL console window not found; windows:", (wins.windows || []).map((w) => `${w.process}:${w.title}`).join(", "));
  process.exit(1);
}
check("console window visible", true, `hwnd ${con.hwnd} foreground=${con.foreground}`);

// Guard: typing is refused when a *different* window owns the keyboard.
let refused = null;
try {
  await run({ action: "type", hwnd: "1", text: "should-not-land" });
} catch (e) {
  refused = e.message;
}
check("wrong-window typing refused", !!refused && /refusing to send input|foreground/i.test(refused), String(refused).slice(0, 110));

const command = `echo dsh-console-ok>${OUT}`;
const typed = await run({ action: "type", hwnd: String(con.hwnd), text: command });
check("type command", typed.ok !== false && typed.chars === command.length, JSON.stringify(typed).slice(0, 100));

const keyed = await run({ action: "key", hwnd: String(con.hwnd), combo: "enter" });
check("press enter", keyed.ok !== false, JSON.stringify(keyed).slice(0, 80));
await sleep(900);

const wrote = fs.existsSync(OUT);
check("command executed by the console", wrote, wrote ? JSON.stringify(fs.readFileSync(OUT, "utf8").trim()) : "file missing");

const shot = await run({ action: "screenshot", hwnd: String(con.hwnd), maxw: 700 });
check("screenshot", !!shot.path, shot.path);

await run({ action: "kill", pid: launched.pid });
console.log("done");
