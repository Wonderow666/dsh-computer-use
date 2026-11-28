// Unit tests for the dsh-computer-use plugin contract, with the engine mocked.
// check() awaits its body: an unawaited async body would resolve after the
// harness had already counted the test as a pass.
// Run: node test\run-tests.mjs
import assert from "node:assert/strict";
import fs from "node:fs";
import { register } from "node:module";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

register("./mock/hooks.mjs", import.meta.url);

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PLUGIN = path.join(ROOT, "lib", "index.js");
const ARTIFACTS = path.join(ROOT, "artifacts", "unit");

const mod = await import(pathToFileURL(PLUGIN).href);
const cp = await import(pathToFileURL(path.join(ROOT, "test", "mock", "stub-cp.mjs")).href);

let pass = 0;
let fail = 0;
async function check(name, fn) {
  try { await fn(); pass++; console.log("  ok   " + name); }
  catch (e) { fail++; console.log("  FAIL " + name + "\n       " + e.message); }
}
function eq(a, b, msg) { assert.deepEqual(a, b, msg); }

function boot(config = {}) {
  const defs = [];
  mod.apply({ tools: { register: (d) => defs.push(d) } }, {
    enabled: true,
    enginePath: path.join(ROOT, "bin", "cu.exe"),
    artifactsDir: ARTIFACTS,
    blockedProcesses: [],
    refuseFullscreenForeground: false,
    allowProcessControl: true,
    timeoutMs: 5000,
    ...config
  });
  cp.calls.length = 0;
  return defs[0];
}

const text = (v) => JSON.parse(v.text);
// `run` answers with a transcript, not JSON: only parse what claims to be JSON.
const trans = (v) => (v && typeof v.text === "string" ? v.text : String(v));
const callOf = (cmd) => cp.calls.filter((c) => c.argv[0] === cmd);

console.log("\n[schema]");
{
  const t = boot();
  await check("tool is named computer", () => eq(t.name, "computer"));
  await check("exposes a description", () => assert.ok(t.description.length > 100));
  await check("action is required and enumerated", () => {
    eq(t.parameters.type, "object");
    assert.ok(t.parameters.required.includes("action"));
    eq(t.parameters.additionalProperties, false);
    assert.ok(t.parameters.properties.action.enum.includes("screenshot"));
    assert.ok(t.parameters.properties.action.enum.includes("invoke"));
  });
  await check("each enum value is documented as a parameter path", () => {
    for (const k of ["hwnd", "title", "x", "y", "text", "combo", "elementPath", "region", "maxw", "depth", "max"]) assert.ok(t.parameters.properties[k], k);
  });
  await check("output schema declares text only", () => {
    assert.ok(t.output.schema.required.includes("text"));
    eq(t.output.schema.additionalProperties, false);
    eq(t.output.render({ action: "info" }, { text: "hi" }), [{ type: "text", text: "hi" }]);
  });
  await check("presentCall gives a read card for observation", () => {
    const v = t.presentCall({ action: "screenshot" });
    eq(v.card, "generic"); eq(v.kind, "read"); assert.match(v.title, /screen/i);
  });
  await check("presentCall marks input as execute", () => eq(t.presentCall({ action: "click" }).kind, "execute"));
  await check("presentCall shows the foreground flag for launch", () => eq(t.presentCall({ action: "launch" }).kind, "other"));
}

console.log("\n[observe]");
{
  const t = boot();
  const v = text(await t.execute({ action: "info" }, {}));
  await check("info returns monitors and foreground", () => {
    eq(v.monitors.length, 1); eq(v.foreground.hwnd, 656368);
  });
  await check("info passes no stray flags", () => eq(callOf("info")[0].argv, ["info"]));

  const w = text(await t.execute({ action: "windows" }, {}));
  await check("windows returns the window list", () => eq(w.windows.length, 2));
  await check("windows --all maps to the all flag", async () => {});
  await t.execute({ action: "windows", all: true }, {});
  await check("windows all passes --all", () => assert.ok(callOf("windows")[1].argv.includes("--all")));

  const s = text(await t.execute({ action: "screenshot", maxw: 640, region: "0,0,100,100" }, {}));
  await check("screenshot writes under artifactsDir", () => {
    assert.ok(s.path.startsWith(ARTIFACTS), s.path);
    assert.match(s.path, /shot-\d{8}-\d{6}-\d{3}\.png$/);
  });
  await check("screenshot passes maxw and region", () => {
    const a = callOf("shot")[0].argv;
    assert.ok(a.includes("--out") && a.includes("--maxw") && a.includes("--region"));
    eq(a[a.indexOf("--maxw") + 1], "640");
    eq(a[a.indexOf("--region") + 1], "0,0,100,100");
  });
  await check("screenshot reports the downscale factor", () => eq(s.scale, 4));

  const t2 = boot();
  const w2 = text(await t2.execute({ action: "screenshot" }, {}));
  await check("screenshot defaults to maxw 1600", () => eq(callOf("shot")[0].argv[callOf("shot")[0].argv.indexOf("--maxw") + 1], "1600"));
  await check("screenshot hint offers picture pixels instead of arithmetic", () => assert.match(w2.hint, /imgx/));

  const tree = text(await t.execute({ action: "snapshot", hwnd: "656368", depth: 3 }, {}));
  await check("snapshot targets hwnd with depth", () => {
    const a = callOf("tree")[0].argv;
    eq(a[a.indexOf("--hwnd") + 1], "656368");
    eq(a[a.indexOf("--depth") + 1], "3");
    eq(tree.nodes[1].id, "0.1.2");
  });
}

console.log("\n[window resolution]");
{
  const t = boot();
  await t.execute({ action: "click", title: "notepad", x: 10, y: 10 }, {});
  await check("title resolves to a hwnd and raises it", () => {
    eq(callOf("focus")[0].argv, ["focus", "--hwnd", "999001"]);
    const click = callOf("click")[0].argv;
    eq(click[0], "click");
    eq(click[click.indexOf("--x") + 1], "10");
  });
  await check("focused flag reports the raise", () => {});

  const t2 = boot();
  const v = text(await t2.execute({ action: "click", hwnd: "656368", x: 1, y: 2 }, {}));
  await check("already-foreground window is not re-focused", () => eq(callOf("focus").length, 0));
  await check("click result reports focused=false", () => eq(v.focused, false));

  await assert.rejects(() => t2.execute({ action: "focus", title: "no such window" }, {}), /no window title contains/);
  await check("unknown title lists open windows", () => {});
}

console.log("\n[input mapping]");
{
  const t = boot();
  await t.execute({ action: "type", text: "hello" }, {});
  await check("short text goes through --text", () => eq(callOf("type")[0].argv, ["type", "--text", "hello"]));

  const long = "x".repeat(2000);
  await t.execute({ action: "type", text: long }, {});
  const a = callOf("type")[1].argv;
  await check("long text is spooled to --textfile", () => {
    eq(a[1], "--textfile");
    eq(fs.readFileSync(a[2], "utf8"), long);
  });

  await t.execute({ action: "key", combo: "ctrl+shift+s" }, {});
  await check("key passes the chord", () => eq(callOf("key")[0].argv, ["key", "--combo", "ctrl+shift+s"]));

  await t.execute({ action: "click", x: 5, y: 6, button: "right", count: 2 }, {});
  const c = callOf("click")[0].argv;
  await check("click maps button and count", () => {
    eq(c[c.indexOf("--button") + 1], "right");
    eq(c[c.indexOf("--count") + 1], "2");
  });

  await t.execute({ action: "scroll", x: 5, y: 6, amount: -3, horizontal: true }, {});
  const sc = callOf("scroll")[0].argv;
  await check("scroll maps amount and horizontal", () => {
    eq(sc[sc.indexOf("--amount") + 1], "-3");
    assert.ok(sc.includes("--horizontal"));
  });

  await t.execute({ action: "drag", x1: 1, y1: 2, x2: 3, y2: 4, ms: 500 }, {});
  await check("drag maps its four points", () => eq(callOf("drag")[0].argv, ["drag", "--x1", "1", "--y1", "2", "--x2", "3", "--y2", "4", "--ms", "500"]));

  await t.execute({ action: "move", x: 7, y: 8 }, {});
  await check("move maps coordinates", () => eq(callOf("move")[0].argv, ["move", "--x", "7", "--y", "8"]));

  await assert.rejects(() => t.execute({ action: "type" }, {}), /requires `text`/);
  await assert.rejects(() => t.execute({ action: "key" }, {}), /requires `combo`/);
  await assert.rejects(() => t.execute({ action: "invoke", hwnd: "1" }, {}), /requires elementPath/);
  await assert.rejects(() => t.execute({ action: "kill" }, {}), /requires pid or name/);
  await check("missing required arguments are rejected", () => {});
}

console.log("\n[guard]");
{
  const t = boot({ blockedProcesses: ["chrome.exe"] });
  await assert.rejects(() => t.execute({ action: "click", x: 1, y: 1 }, {}), /input blocked/);
  await check("blocked process refuses input", () => eq(callOf("click").length, 0));
  await check("blocked process still allows observation", async () => {});
  await t.execute({ action: "screenshot" }, {});
  await check("screenshot is never blocked", () => eq(callOf("shot").length, 1));

  const t2 = boot({ blockedProcesses: ["unrealwindow"] });
  cp.state.foreground = { hwnd: 1, title: "PUBG", class: "UnrealWindow", process: "TslGame.exe", rect: { x: 0, y: 0, w: 2560, h: 1600 } };
  await assert.rejects(() => t2.execute({ action: "key", combo: "a" }, {}), /input blocked/);
  await check("guard matches window class too", () => {});
  cp.state.foreground = {
    hwnd: 656368, title: "DeepSeek Harness", class: "Chrome_WidgetWin_1",
    process: "chrome.exe", pid: 32992, visible: true, foreground: true,
    rect: { x: 318, y: 149, w: 1923, h: 1234 }
  };

  const t3 = boot({ refuseFullscreenForeground: true });
  cp.state.foreground = { hwnd: 1, title: "PUBG", class: "UnrealWindow", process: "TslGame.exe", rect: { x: 0, y: 0, w: 2560, h: 1600 } };
  await assert.rejects(() => t3.execute({ action: "click", x: 1, y: 1 }, {}), /fullscreen/);
  await check("fullscreen foreground refuses input", () => {});
  cp.state.foreground = {
    hwnd: 656368, title: "DeepSeek Harness", class: "Chrome_WidgetWin_1",
    process: "chrome.exe", pid: 32992, visible: true, foreground: true,
    rect: { x: 318, y: 149, w: 1923, h: 1234 }
  };

  const t4 = boot({ allowProcessControl: false });
  await assert.rejects(() => t4.execute({ action: "launch", path: "notepad.exe" }, {}), /allowProcessControl/);
  await assert.rejects(() => t4.execute({ action: "kill", pid: 1 }, {}), /allowProcessControl/);
  await check("process control can be disabled", () => {});

  const t5 = boot({ enabled: false });
  await assert.rejects(() => t5.execute({ action: "info" }, {}), /disabled/);
  await check("enabled=false disables everything", () => {});
}

console.log("\n[process + clipboard]");
{
  const t = boot();
  await t.execute({ action: "procs", name: "note" }, {});
  await check("procs forwards the filter", () => eq(callOf("procs")[0].argv, ["procs", "--name", "note"]));
  await t.execute({ action: "launch", path: "C:\\Windows\\notepad.exe", args: "a.txt", cwd: "C:\\" }, {});
  await check("launch forwards path/args/cwd", () => eq(callOf("launch")[0].argv, ["launch", "--path", "C:\\Windows\\notepad.exe", "--args", "a.txt", "--cwd", "C:\\"]));
  await t.execute({ action: "kill", pid: 4242 }, {});
  await check("kill forwards a pid", () => eq(callOf("kill")[0].argv, ["kill", "--pid", "4242"]));
  await t.execute({ action: "clipboard", clipboardCommand: "set", text: "hi 中文" }, {});
  const cl = callOf("clip")[0].argv;
  await check("clipboard set spools utf8 text", () => {
    eq(cl[1], "--textfile");
    eq(fs.readFileSync(cl[2], "utf8"), "hi 中文");
  });
  const got = text(await t.execute({ action: "clipboard" }, {}));
  await check("clipboard get reads text", () => eq(got.text, "clipboard contents"));
}

console.log("\n[invoke + dryRun]");
{
  const t = boot();
  await t.execute({ action: "invoke", hwnd: "656368", elementPath: "0.1.2" }, {});
  await check("invoke passes hwnd and element path", () => eq(callOf("invoke")[0].argv, ["invoke", "--hwnd", "656368", "--path", "0.1.2"]));
  await t.execute({ action: "invoke", hwnd: "656368", elementPath: "0.1.2", value: "v" }, {});
  await check("invoke forwards a value", () => eq(callOf("invoke")[1].argv[callOf("invoke")[1].argv.length - 1], "v"));

  cp.state.invoke = { ok: true, pattern: "click-center" };
  const degraded = text(await t.execute({ action: "invoke", hwnd: "656368", elementPath: "0.9.9" }, {}));
  await check("an invoke without a pattern says it clicked instead", () => {
    eq(degraded.pattern, "click-center");
    eq(degraded.degraded, "click-center");
    assert.ok(/verify the effect/.test(String(degraded.why)), String(degraded.why));
  });
  const planDeg = await t.execute({ action: "run", hwnd: "656368", plan: "invoke 0.1.2" }, {});
  await check("a plan line says when invoke degraded", () => assert.ok(/no invoke pattern: clicked the centre/.test(planDeg.text), planDeg.text));
  cp.state.invoke = null;

  const shot = text(await t.execute({ action: "screenshot", hwnd: "999001", clientRegion: "10,20,300,200" }, {}));
  await check("clientRegion is converted from the window's client origin", () => {
    assert.ok(shot.ok, JSON.stringify(shot));
    const argv = callOf("shot")[0].argv;
    eq(argv[argv.indexOf("--region") + 1], "50,99,350,299");
  });
  await assert.rejects(
    () => t.execute({ action: "screenshot", clientRegion: "0,0,10,10" }, {}),
    /needs a target window/
  );
  await check("clientRegion without a window is refused", () => {});

  const d = text(await t.execute({ action: "click", x: 1, y: 2, dryRun: true }, {}));
  await check("dryRun returns argv without injecting", () => {
    eq(d.dryRun, true);
    assert.ok(d.argv.includes("click"));
    eq(callOf("click").length, 0);
  });
  const focusBefore = callOf("focus").length;
  const d2 = text(await t.execute({ action: "click", title: "notepad", dryRun: true }, {}));
  await check("dryRun does not steal focus", () => {
    eq(d2.focused, false);
    eq(callOf("focus").length, focusBefore);
  });
}

console.log("\n[readtext / waittext / trim / verify]");
{
  const t = boot();
  const r = text(await t.execute({ action: "readtext", hwnd: "656368" }, {}));
  await check("readtext passes the window and returns the text", () => {
    eq(callOf("readtext")[0].argv, ["readtext", "--hwnd", "656368"]);
    eq(r.strategy, "uia");
    assert.match(r.text, /hello/);
  });
  await t.execute({ action: "readtext", hwnd: "656368", chars: 500 }, {});
  await check("readtext forwards chars", () => eq(callOf("readtext")[1].argv, ["readtext", "--hwnd", "656368", "--chars", "500"]));

  const wt = text(await t.execute({ action: "waittext", hwnd: "656368", regex: "RA[>#]", timeout: 2000 }, {}));
  await check("waittext forwards the regex and timeout", () => {
    eq(callOf("waittext")[0].argv, ["waittext", "--hwnd", "656368", "--regex", "RA[>#]", "--timeout", "2000"]);
    eq(wt.matched, true);
  });
  await assert.rejects(() => t.execute({ action: "waittext" }, {}), /requires `regex`/);
  await check("waittext requires a regex", () => {});

  const s = text(await t.execute({ action: "screenshot", trim: true, tol: 20, pad: 4 }, {}));
  await check("screenshot forwards trim options", () => {
    const a = callOf("shot")[0].argv;
    assert.ok(a.includes("--trim"));
    eq(a[a.indexOf("--tol") + 1], "20");
    eq(a[a.indexOf("--pad") + 1], "4");
    assert.ok(s.trim);
  });
  await t.execute({ action: "screenshot" }, {});
  await check("screenshot does not trim by default", () => assert.ok(!callOf("shot")[1].argv.includes("--trim")));

  const sMin = text(await t.execute({ action: "screenshot", minBytes: 15000 }, {}));
  await check("screenshot forwards minBytes as --min-bytes", () => {
    const a = callOf("shot")[2].argv;
    eq(a[a.indexOf("--min-bytes") + 1], "15000");
    eq(sMin.bytes, 480426);
  });
  await t.execute({ action: "screenshot", minBytes: 0 }, {});
  await check("screenshot omits --min-bytes when it is zero", () => assert.ok(!callOf("shot")[3].argv.includes("--min-bytes")));

  await t.execute({ action: "type", hwnd: "656368", text: "echo hi", verify: true }, {});
  await check("type --verify reaches the engine", () => {
    const a = callOf("type")[0].argv;
    assert.ok(a.includes("--verify"));
    eq(a[a.indexOf("--text") + 1], "echo hi");
  });
  const tv = text(await t.execute({ action: "type", hwnd: "656368", text: "x", verify: true }, {}));
  await check("type verify reports unavailable when the window has no text", () => eq(tv.verified, "unavailable"));
  cp.state.typeVerify = "ok";
  const tv2 = text(await t.execute({ action: "type", hwnd: "656368", text: "x", verify: true }, {}));
  await check("type verify passes through when the text appeared", () => eq(tv2.verified, true));
  cp.state.typeVerify = "mismatch";
  await assert.rejects(() => t.execute({ action: "type", hwnd: "656368", text: "x", verify: true }, {}), /did not show up/);
  await check("type verify fails when the app swallowed the text", () => {});
  cp.state.typeVerify = null;
}

console.log("\n[state / ui / run]");
{
  const t = boot({});
  const st = text(await t.execute({ action: "state" }, {}));
  await check("state folds lock and foreground into one answer", () => {
    eq(st.locked, false);
    eq(st.foreground.hwnd, 656368);
  });
  const st2 = text(await t.execute({ action: "state", hwnd: "656368" }, {}));
  await check("state adds the target geometry when a target is given", () => eq(st2.target.hwnd, 656368));

  const ui = text(await t.execute({ action: "ui", hwnd: "656368", max: 12 }, {}));
  await check("ui forwards hwnd and max", () => {
    const a = callOf("ui")[0].argv;
    eq(a[a.indexOf("--hwnd") + 1], "656368");
    eq(a[a.indexOf("--max") + 1], "12");
    eq(ui.count, 2);
  });

  const plan = "wait /ok/ 900\ntype hello\nkey enter\nread";
  const ran = await t.execute({ action: "run", hwnd: "999001", plan }, {});
  await check("run executes a whole plan in one call", () => /done 4\/4/.test(ran.text));
  await check("run transcript is one line per step plus a summary", () => eq(ran.text.trim().split(/\r?\n/).length, 5));
  await check("run raises the target before typing", () => {
    const order = cp.calls.filter((c) => ["focus", "type", "key"].includes(c.argv[0])).map((c) => c.argv[0]);
    eq(order[0], "focus");
  });
  await check("run does not screenshot unless the plan asks", () => eq(cp.calls.filter((c) => c.argv[0] === "shot").length, 0));

  await assert.rejects(() => t.execute({ action: "run", hwnd: "656368", plan: "fly away" }, {}), /unknown step/);
  await check("run rejects an unknown step", () => {});
  await assert.rejects(() => t.execute({ action: "run" }, {}), /needs `plan`/);
  await check("run rejects an empty plan", () => {});

  const plans = path.join(ROOT, "artifacts", "unit", "plan-input.txt");
  fs.mkdirSync(path.dirname(plans), { recursive: true });
  fs.writeFileSync(plans, "wait /ok/ 900\nread\n", "utf8");
  const fromFile = await t.execute({ action: "run", hwnd: "656368", file: plans }, {});
  await check("run can read the plan from a file", () => /done 2\/2/.test(fromFile.text));
}

console.log("\n[ocr / frame quality / optional steps]");
{
  const t = boot({ tesseract: "C:\\tools\\tesseract.exe" });
  const r = text(await t.execute({ action: "ocr", hwnd: "656368", psm: 4, lang: "eng", region: "0,0,800,600" }, {}));
  await check("ocr forwards window, region, lang and psm", () => {
    const a = callOf("ocr")[0].argv;
    eq(a[a.indexOf("--hwnd") + 1], "656368");
    eq(a[a.indexOf("--region") + 1], "0,0,800,600");
    eq(a[a.indexOf("--lang") + 1], "eng");
    eq(a[a.indexOf("--psm") + 1], "4");
    eq(a[a.indexOf("--tesseract") + 1], "C:\\tools\\tesseract.exe");
    eq(r.chars, 18);
  });
  const r2 = text(await t.execute({ action: "ocr", hwnd: "656368", tesseract: "D:\\t.exe" }, {}));
  await check("ocr lets the call override the configured tesseract path", () => {
    const a = callOf("ocr").pop().argv;
    eq(a[a.indexOf("--tesseract") + 1], "D:\\t.exe");
    eq(r2.ok, true);
  });

  const s = text(await t.execute({ action: "screenshot", hwnd: "656368", minBrightness: 20, minStddev: 6, wake: 2 }, {}));
  await check("screenshot forwards brightness, contrast and wake gates", () => {
    const a = callOf("shot").pop().argv;
    eq(a[a.indexOf("--min-brightness") + 1], "20");
    eq(a[a.indexOf("--min-stddev") + 1], "6");
    eq(a[a.indexOf("--wake") + 1], "2");
    eq(s.mean, 180);
  });

  const plan = "wait /nothing/ 200\ntype hello";
  cp.state.failNext = "waittext";
  const proc = await t.execute({ action: "run", hwnd: "999001", plan: plan.replace("wait ", "wait? ") }, {});
  await check("an optional step records its failure and the plan continues", () => {
    assert.ok(/skipped \(optional\)/.test(proc.text), proc.text);
    assert.ok(/done 2\/2/.test(proc.text), proc.text);
  });

  cp.calls.length = 0;
  await t.execute({ action: "run", hwnd: "999001", plan: "type hi" }, {});
  await check("run switches the target to an English layout before typing", () => {
    eq(cp.calls.filter((c) => c.argv[0] === "ime").length, 1);
    eq(cp.calls.filter((c) => c.argv[0] === "type").length, 1);
  });
  cp.calls.length = 0;
  const off = boot({ autoIme: false });
  await off.execute({ action: "run", hwnd: "999001", plan: "type hi" }, {});
  await check("autoIme:false leaves the keyboard layout alone", () => eq(cp.calls.filter((c) => c.argv[0] === "ime").length, 0));
  cp.calls.length = 0;
  await t.execute({ action: "type", hwnd: "656368", text: "hi" }, {});
  await check("the type action also switches layout first", () => eq(cp.calls.filter((c) => c.argv[0] === "ime").length, 1));
}
console.log("\n[session / ocr fallbacks]");
{
  const t = boot({ tesseract: "C:\\tools\\tesseract.exe" });
  const beforeCalls = cp.calls.length;
  const s = text(await t.execute({ action: "session" }, {}));
  await check("session bootstraps with one engine launch", () => {
    // info --modals carries the dialog list, so the old second spawn is gone.
    eq(cp.calls.length - beforeCalls, 1);
    eq(cp.calls[cp.calls.length - 1].argv.includes("--modals"), true);
  });
  await check("session answers orientation in one call", () => {
    eq(s.ok, true);
    eq(s.locked, false);
    eq(Array.isArray(s.hint), true);
    assert.ok(s.hint.length >= 1, JSON.stringify(s.hint));
  });
  await check("session reports the foreground and the modal count", () => {
    eq(s.foreground.title, "DeepSeek Harness");
    eq(typeof s.modals, "number");
  });
  await check("session ignores dialogs that belong to other processes", () => {
    // The stub's dialog belongs to wegame.exe (pid 4242) while the foreground is
    // chrome.exe (pid 32992): WeGame's `no_active_wnd` is resident but harmless.
    eq(s.modals, 0);
  });
  cp.state.modals = [
    { hwnd: 7003, title: "另存为", class: "#32770", pid: 32992, process: "chrome.exe", dialogClass: true, visible: true, enabled: true }
  ];
  const sOwnDialog = text(await t.execute({ action: "session" }, {}));
  await check("session counts a dialog owned by the foreground app", () => {
    eq(sOwnDialog.modals, 1);
    assert.ok(sOwnDialog.hint.some((h) => /dialog/.test(h)), JSON.stringify(sOwnDialog.hint));
  });
  cp.state.modals = null;

  // LockApp.exe is resident on Windows 11 whether or not the workstation is
  // locked: on 2026-11-19 the tool reported locked:true while `inputcheck`
  // showed landed:true, so the weak witness must ask for confirmation instead
  // of telling the model that input is dead.
  cp.state.infoOverride = { locked: true, lockAppRunning: true, inputDesktopName: "Default" };
  const sWeak = text(await t.execute({ action: "session" }, {}));
  await check("session treats a resident LockApp as suspicion, not proof", () => {
    eq(sWeak.lockedEvidence, "lockapp");
    assert.ok(sWeak.hint.some((h) => /inputcheck/.test(h)), JSON.stringify(sWeak.hint));
    eq(sWeak.hint.some((h) => /input does nothing/.test(h)), false);
  });
  cp.state.infoOverride = { locked: true, lockAppRunning: true, inputDesktopName: "LockScreen" };
  const sHard = text(await t.execute({ action: "session" }, {}));
  await check("session calls it locked when the input desktop is not Default", () => {
    eq(sHard.lockedEvidence, "input-desktop");
    assert.ok(sHard.hint.some((h) => /is locked/.test(h)), JSON.stringify(sHard.hint));
  });
  cp.state.infoOverride = null;

  const r1 = text(await t.execute({ action: "readtext", hwnd: "656368", ocr: true }, {}));
  await check("readtext falls back to ocr when asked", () => {
    eq(r1.strategy, "ocr");
    eq(callOf("ocr").length, 1);
    eq(callOf("readtext").length, 0);
  });

  const r2 = text(await t.execute({ action: "waittext", hwnd: "656368", regex: "RA#", ocr: true, timeout: 3000 }, {}));
  await check("waittext can wait on the pixels", () => {
    const a = callOf("waitocr").pop().argv;
    eq(a[a.indexOf("--regex") + 1], "RA#");
    eq(a[a.indexOf("--timeout") + 1], "3000");
    eq(r2.matched, true);
  });

  cp.calls.length = 0;
  await t.execute({ action: "run", hwnd: "999001", plan: "wait /RA#/ 2000 ocr\nread ocr" }, {});
  await check("a plan can wait and read on the pixels", () => {
    eq(cp.calls.filter((c) => c.argv[0] === "waitocr").length, 1);
    eq(cp.calls.filter((c) => c.argv[0] === "ocr").length >= 1, true);
    eq(cp.calls.filter((c) => c.argv[0] === "waittext").length, 0);
  });
}
console.log("\n[saving a plan as a profile]");
{
  const t = boot({});
  const dir = path.join(ARTIFACTS, "profiles");
  fs.rmSync(dir, { recursive: true, force: true });
  // A plan returns a transcript, not JSON.
  const out = await t.execute({ action: "run", hwnd: "999001", plan: "read\ntype hello", save: "notepad/greet" }, {});
  await check("a passing plan can be saved as a profile", () => {
    assert.ok(String(out.text).includes('saved profile "notepad"'), out.text);
    const rec = JSON.parse(fs.readFileSync(path.join(dir, "notepad.json"), "utf8"));
    eq(rec.id, "notepad");
    eq(rec.match.process, "notepad.exe");
    eq(rec.match.class, "Notepad");
    eq(rec.plans.greet.trim(), "read\ntype hello");
    assert.ok(String(out.text).includes("match: { process:"), out.text);
  });
  await check("a saved task is merged, not replaced", () => {
    return t.execute({ action: "run", hwnd: "999001", plan: "read", save: "notepad/peek" }, {}).then(() => {
      const rec = JSON.parse(fs.readFileSync(path.join(dir, "notepad.json"), "utf8"));
      eq(Object.keys(rec.plans).sort().join(","), "greet,peek");
    });
  });
  await check("a plan that stopped early is not saved", async () => {
    fs.rmSync(path.join(dir, "half.json"), { force: true });
    let err = null;
    try {
      // step 1 waits for text the stub never says, so the plan stops there
      await t.execute({ action: "run", hwnd: "999001", plan: "wait /never-appears/ 200\nread", save: "half/broken" }, {});
    } catch (e) { err = e; }
    assert.ok(err && /not saved/.test(err.message), String(err && err.message));
    eq(fs.existsSync(path.join(dir, "half.json")), false);
  });
  await check("a bad profile id is refused", async () => {
    let err = null;
    try { await t.execute({ action: "run", hwnd: "999001", plan: "read", save: "bad id!" }, {}); } catch (e) { err = e; }
    assert.ok(err && /bad profile id/.test(err.message), String(err && err.message));
  });
}
console.log("\n[window by name, dry run, profile lint]");
{
  const t = boot({
    profiles: [
      {
        id: "notepad",
        match: { process: "notepad.exe" },
        aliases: { editor: "0.1.1" },
        plans: { greet: "type {{editor}}\nread" }
      },
      {
        id: "broken",
        match: { typo: "x" },
        plans: { oops: "wait /never/ 10\nbogus-step" }
      }
    ]
  });

  await check("run picks the window from a fuzzy name", async () => {
    cp.calls.length = 0;
    await t.execute({ action: "run", window: "notepad", plan: "read" }, {});
    eq(callOf("readtext").length, 1);
    eq(callOf("readtext")[0].argv.includes("--hwnd"), true);
    eq(callOf("readtext")[0].argv[callOf("readtext")[0].argv.indexOf("--hwnd") + 1], "999001");
  });

  await check("an unknown window name suggests the open ones", async () => {
    let err = null;
    try { await t.execute({ action: "run", window: "no-such-window", plan: "read" }, {}); } catch (e) { err = e; }
    assert.ok(err && /no open window matches/.test(err.message) && /Notepad/.test(err.message), String(err && err.message));
  });

  await check("a dry run parses and resolves but sends nothing", async () => {
    cp.calls.length = 0;
    const r = text(await t.execute({ action: "run", window: "notepad", plan: "type hello\nwait /x/ 100", dryRun: true }, {}));
    eq(r.dryRun, true);
    eq(r.steps.length, 2);
    eq(r.steps[0].op, "type");
    eq(r.target.hwnd, 999001);
    eq(callOf("type").length, 0);
    eq(cp.calls.length, 1); // only the windows listing
  });

  await check("profiles --check lints matches, plans and aliases", async () => {
    const r = text(await t.execute({ action: "profiles", check: true }, {}));
    eq(r.checked, 2);
    eq(r.ok, false);
    eq(r.failing, 1);
    const bad = r.profiles.find((p) => p.id === "broken");
    eq(bad.ok, false);
    assert.ok(bad.problems.some((p) => /unknown key/.test(p)), JSON.stringify(bad.problems));
    assert.ok(bad.problems.some((p) => /unknown step/.test(p)), JSON.stringify(bad.problems));
  });

  await check("a profile that names an undefined alias fails the lint", async () => {
    const t2 = boot({ profiles: [{ id: "aliased", match: { process: "notepad.exe" }, plans: { go: "type {{ghost}}" } }] });
    const r = text(await t2.execute({ action: "profiles", check: true }, {}));
    eq(r.ok, false);
    assert.ok(r.profiles[0].problems.some((p) => /\{\{ghost\}\}/.test(p)), JSON.stringify(r.profiles[0].problems));
  });
}
console.log("\n[launch inside a plan]");
{
  const t = boot({
    profiles: [{ id: "notepad", match: { process: "notepad.exe" }, plans: { start: "launch C:\\Windows\\notepad.exe" } }]
  });

  await check("a plan can start the app it is about", async () => {
    cp.calls.length = 0;
    const r = await t.execute({ action: "run", profile: "notepad", task: "start" }, {});
    eq(callOf("launch").length, 1);
    eq(callOf("launch")[0].argv[callOf("launch")[0].argv.indexOf("--path") + 1], "C:\\Windows\\notepad.exe");
    eq(callOf("launch")[0].argv.includes("--args"), false);
    assert.ok(/1 launch notepad\.exe pid 4242/.test(trans(r)), trans(r));
    // The launched window becomes the plan's target, so the next step has
    // somewhere to land instead of talking to whatever was in front.
    assert.ok(/hwnd 999001/.test(trans(r)), trans(r));
  });

  await check("a pipe separates the path from its arguments", async () => {
    cp.calls.length = 0;
    const r = trans(await t.execute({ action: "run", window: "notepad", plan: "launch C:\\Program Files\\App\\app.exe | --open \"a b.txt\"" }, {}));
    const l = callOf("launch")[0].argv;
    eq(l[l.indexOf("--path") + 1], "C:\\Program Files\\App\\app.exe");
    eq(l[l.indexOf("--args") + 1], "--open \"a b.txt\"");
    assert.ok(/launch app\.exe/.test(r), r);
  });

  await check("a launch without a path is a parse error, not a spawn", async () => {
    cp.calls.length = 0;
    let err = null;
    try { await t.execute({ action: "run", window: "notepad", plan: "launch" }, {}); } catch (e) { err = e; }
    assert.ok(err && /launch needs a path/.test(err.message), String(err && err.message));
    eq(callOf("launch").length, 0);
  });
}
console.log("\n[controls by name, plan vars and loops]");
{
  const t = boot({ profiles: [{ id: "notepad", match: { process: "notepad.exe" }, aliases: { file: "notes.txt" }, plans: {} }] });

  await check("click --name finds the control and invokes it", async () => {
    cp.calls.length = 0;
    const r = text(await t.execute({ action: "click", name: "Save", title: "Notepad" }, {}));
    eq(r.how, "invoke");
    eq(r.role, "Button");
    const inv = callOf("invoke")[0];
    assert.ok(inv, "no invoke call");
    eq(inv.argv[inv.argv.indexOf("--path") + 1], "0.1.2");
  });

  await check("a name that matches nothing says what is there instead", async () => {
    let err = null;
    try { await t.execute({ action: "click", name: "Nonexistent", title: "Notepad" }, {}); } catch (e) { err = e; }
    assert.ok(err && /no control matches "Nonexistent"/.test(err.message), String(err && err.message));
  });

  await check("press is the plan verb for the same thing", async () => {
    const r = trans(await t.execute({ action: "run", window: "notepad", plan: "press Save" }, {}));
    assert.ok(/press "Save" via invoke \(Button\)/.test(r), r);
  });

  await check("vars fill {{name}} wherever it stands in the plan", async () => {
    cp.calls.length = 0;
    const r = trans(await t.execute({ action: "run", window: "notepad", plan: "type {{file}}", vars: { file: "report.txt" } }, {}));
    assert.ok(/type 10ch/.test(r), r);
    const ty = callOf("type")[0];
    eq(ty.argv[ty.argv.indexOf("--text") + 1], "report.txt");
  });

  await check("repeat retries a step the stated number of times", async () => {
    cp.calls.length = 0;
    const r = trans(await t.execute({ action: "run", window: "notepad", plan: "repeat 3 wait /never-there/ 20" }, {}));
    eq(callOf("waittext").length, 3);
    assert.ok(/FAILED/.test(r), r);
  });

  await check("until repeats a step until the window agrees", async () => {
    cp.calls.length = 0;
    const r = trans(await t.execute({ action: "run", window: "notepad", plan: "until /hello/ 3000 key ctrl+s" }, {}));
    assert.ok(/key ctrl\+s until \/hello\/ ok/.test(r), r);
    eq(callOf("key").length, 1);
  });

  await check("until gives up on time and says which text it waited for", async () => {
    cp.calls.length = 0;
    const r = trans(await t.execute({ action: "run", window: "notepad", plan: "until /never-there/ 400 key ctrl+s" }, {}));
    assert.ok(/FAILED/.test(r) && /never-there/.test(r), r);
    assert.ok(callOf("key").length >= 1, "the step never ran");
  });

  await check("an empty prefix is a parse error", async () => {
    let err = null;
    try { await t.execute({ action: "run", window: "notepad", plan: "repeat 3" }, {}); } catch (e) { err = e; }
    assert.ok(err && /prefix has no step/.test(err.message), String(err && err.message));
  });
}

console.log("\n[waiting for an event instead of polling]");
{
  const t = boot({});

  await check("watch answers as soon as the window appears", async () => {
    cp.calls.length = 0;
    cp.state.watch = null;
    const r = text(await t.execute({ action: "watch", event: "window-created", timeout: 1500 }, {}));
    eq(r.fired, true);
    eq(r.window.title, "Fresh Window");
    const a = callOf("watch")[0].argv;
    eq(a[a.indexOf("--event") + 1], "window-created");
    eq(a[a.indexOf("--timeout") + 1], "1500");
  });

  await check("a silent watch reports what appeared while it waited", async () => {
    cp.state.watch = { fired: false, waitedMs: 800, appeared: [{ title: "cmd.exe", process: "cmd.exe" }] };
    const r = text(await t.execute({ action: "watch", timeout: 900 }, {}));
    eq(r.fired, false);
    eq(r.appeared.length, 1);
    cp.state.watch = null;
  });

  await check("a plan can wait for a window instead of sleeping", async () => {
    cp.calls.length = 0;
    const r = trans(await t.execute({ action: "run", hwnd: "999001", plan: "watch window-created 3000\ntype hi" }, {}));
    assert.ok(/watch window-created \d+ms "Fresh Window"/.test(r), r);
    assert.ok(/type 2ch/.test(r), r);
  });

  await check("a watch that times out names what showed up instead", async () => {
    cp.state.watch = { fired: false, waitedMs: 60, appeared: [{ title: "Other", process: "other.exe" }] };
    const r = trans(await t.execute({ action: "run", hwnd: "999001", plan: "watch window-created 500" }, {}));
    assert.ok(/FAILED/.test(r) && /Other \(other\.exe\)/.test(r), r);
    cp.state.watch = null;
  });
}

console.log("\n[failure forensics]");
{
  const t = boot({});

  await check("a failed plan leaves a directory with the plan, the transcript and the pixels", async () => {
    const r = trans(await t.execute({ action: "run", window: "notepad", plan: "wait /definitely-not-there/ 60" }, {}));
    assert.ok(/FAILED/.test(r), r);
    const m = /forensics: (.+)$/m.exec(r);
    assert.ok(m, r);
    const dir = m[1].trim();
    for (const f of ["plan.txt", "transcript.txt", "where.json"]) {
      assert.ok(fs.existsSync(path.join(dir, f)), `missing ${f} in ${dir}`);
    }
    assert.ok(/wait \/definitely-not-there\/ 60/.test(fs.readFileSync(path.join(dir, "plan.txt"), "utf8")));
    const where = JSON.parse(fs.readFileSync(path.join(dir, "where.json"), "utf8"));
    eq(where.stoppedAt, 1);
    eq(where.steps, 1);
    eq(where.hwnd, "999001");
  });

  await check("the failures action lists what is on disk", async () => {
    // text() already parses; parsing a second time was why this test lied to
    // itself on the first run with awaits in place.
    const r = text(await t.execute({ action: "failures", limit: 5 }, {}));
    assert.ok(r.count >= 1, JSON.stringify(r));
    assert.ok(r.failures[0].dir && /definitely-not-there/.test(r.failures[0].stopped), JSON.stringify(r));
  });

  await check("a plan that worked leaves nothing behind", async () => {
    const before = (() => { try { return fs.readdirSync(path.join(ARTIFACTS, "failures")).length; } catch { return 0; } })();
    const r = trans(await t.execute({ action: "run", window: "notepad", plan: "read" }, {}));
    assert.ok(!/forensics/.test(r), r);
    const after = (() => { try { return fs.readdirSync(path.join(ARTIFACTS, "failures")).length; } catch { return 0; } })();
    eq(after, before);
  });
}

﻿console.log("\n[numbered pictures]");
{
  const t = boot();
  cp.state.ui = [
    { id: "0.2.0", role: "Text", name: "status line", rect: { x: 10, y: 10, w: 120, h: 20 } },
    { id: "0.2.1", role: "MenuItem", name: "File", rect: { x: 40, y: 80, w: 60, h: 22 } },
    { id: "0.2.2", role: "Button", name: "Disabled", enabled: false, rect: { x: 10, y: 120, w: 60, h: 20 } },
    { id: "0.2.3", role: "Button", name: "Save", rect: { x: 110, y: 220, w: 80, h: 24 } },
    { id: "0.2.4", role: "Button", name: "Tiny", rect: { x: 10, y: 300, w: 3, h: 3 } },
    { id: "0.2.5", role: "Button", name: "", rect: { x: 200, y: 300, w: 60, h: 20 } }
  ];
  const seen = text(await t.execute({ action: "see", hwnd: "999001", goal: "save the file", max: 5 }, {}));
  await check("see numbers only the controls it could click", () => {
    eq(seen.count, 2);
    eq(seen.targets.map((x) => x.name), ["File", "Save"]);
  });
  await check("see returns a picture and the goal", () => {
    eq(typeof seen.image, "string");
    eq(seen.goal, "save the file");
  });
  await check("see asks the engine to draw the numbers at the right place", () => {
    const mark = callOf("mark")[0];
    assert.ok(mark, "mark was not called");
    const marks = mark.argv[mark.argv.indexOf("--marks") + 1];
    // The screenshot is 1600 wide for a 2560-wide screen: everything halves.
    eq(marks.split(";")[0], "1|25|50|38|14");
  });
  await check("see leaves the map on disk for clicknum", () => {
    const side = path.join(ARTIFACTS, "see", "last.json");
    const last = JSON.parse(fs.readFileSync(side, "utf8"));
    eq(last.hwnd, "999001");
    eq(last.targets.length, 2);
    assert.ok(last.targets[0].rect.w > 0);
    assert.ok(fs.existsSync(side));
    eq(last.targets[0].id, "0.2.1");
  });

  const clicked = text(await t.execute({ action: "clicknum", n: 2 }, {}));
  await check("clicknum clicks what the number pointed at", () => {
    eq(clicked.clicked.name, "Save");
    eq(clicked.how, "invoke");
    eq(callOf("invoke")[0].argv[callOf("invoke")[0].argv.indexOf("--path") + 1], "0.2.3");
  });
  await assert.rejects(() => t.execute({ action: "clicknum", n: 99 }, {}), /there is no 99/);
  await check("clicknum refuses a number the picture did not print", () => {});

  const empty = boot({ artifactsDir: path.join(ARTIFACTS, "nothing-here") });
  await assert.rejects(() => empty.execute({ action: "clicknum", n: 1 }, {}), /no numbered picture yet/);
  await check("clicknum without a picture says what to do first", () => {});

  cp.state.ui = [];
  const blank = text(await t.execute({ action: "see", hwnd: "999001" }, {}));
  await check("see still returns the picture when nothing is clickable", () => {
    eq(blank.count, 0);
    assert.ok(/no named controls/.test(blank.hint), blank.hint);
  });
  cp.state.ui = null;
}

console.log("\n[coordinates, retries, uploads]");
{
  const t = boot();
  const shotsFile = path.join(ARTIFACTS, "shots.json");
  try { fs.rmSync(shotsFile, { force: true }); } catch { /* first run */ }

  const shot = text(await t.execute({ action: "screenshot", hwnd: "999001" }, {}));
  await check("a screenshot records how it was taken", () => {
    eq(shot.scale, 1.6);
    const all = JSON.parse(fs.readFileSync(shotsFile, "utf8"));
    eq(all[0].image, shot.path);
    eq(all[0].scale, 1.6);
    eq(all[0].hwnd, "999001");
  });

  const pic = text(await t.execute({ action: "click", imgx: 100, imgy: 50 }, {}));
  await check("click takes picture pixels and converts them once", () => {
    eq([pic.x, pic.y], [160, 80]);
    const c = callOf("click").at(-1);
    eq(c.argv[c.argv.indexOf("--x") + 1], "160");
    eq(c.argv[c.argv.indexOf("--y") + 1], "80");
  });

  const bare = boot({ artifactsDir: path.join(ARTIFACTS, "no-shots") });
  await assert.rejects(() => bare.execute({ action: "click", imgx: 1, imgy: 1 }, {}), /no picture on record/);
  await check("a click in a picture that does not exist says what to do", () => {});

  const retried = trans(await t.execute({ action: "run", hwnd: "999001", plan: "retry 3 wait /never-there/ 20" }, {}));
  await check("retry N gives a step N tries before giving up", () => {
    assert.ok(/FAILED/.test(retried), retried);
    eq(callOf("waittext").filter((c) => c.argv.join(" ").includes("never-there")).length, 3);
  });
  await assert.rejects(() => t.execute({ action: "run", hwnd: "999001", plan: "retry 3" }, {}), /prefix has no step/);
  await check("retry without a step is named as a mistake", () => {});

  const u = boot();
  const file = path.join(ARTIFACTS, "upload-me.txt");
  fs.mkdirSync(ARTIFACTS, { recursive: true });
  fs.writeFileSync(file, "hello\n", "utf8");
  cp.state.modals = null;
  cp.state.modalsQueue = [
    [{ hwnd: 8801, title: "打开", class: "#32770", pid: 300, process: "chrome.exe", dialogClass: true, visible: true }],
    []
  ];
  const up = text(await u.execute({ action: "upload", path: file }, {}));
  await check("upload types the path into the dialog that is already open", () => {
    eq(up.closed, true);
    eq(up.dialog, "打开");
    const typed = callOf("type").at(-1);
    assert.ok(typed.argv.includes(file), typed.argv.join(" "));
    eq(typed.argv[typed.argv.indexOf("--hwnd") + 1], "8801");
    const keys = callOf("key").map((c) => c.argv[c.argv.indexOf("--combo") + 1]);
    // Clear the stale name first, then commit - and never trust the box to be empty.
    eq(keys.slice(-2), ["ctrl+a", "return"]);
  });

  cp.state.modals = null;
  cp.state.modalsQueue = [
    [
      { hwnd: 8801, title: "no_active_wnd", class: "#32770", pid: 4242, process: "wegame.exe", dialogClass: true, visible: true, enabled: true },
      { hwnd: 8802, title: "打开", class: "#32770", pid: 32992, process: "chrome.exe", dialogClass: true, visible: true, enabled: true }
    ],
    []
  ];
  const picked = text(await u.execute({ action: "upload", path: file }, {}));
  await check("upload picks the dialog of the app in front, not a background one", () => {
    eq(picked.dialog, "打开");
    eq(picked.dialogPid, 32992);
    const typed = callOf("type").at(-1);
    eq(typed.argv[typed.argv.indexOf("--hwnd") + 1], "8802");
  });

  cp.state.modalsQueue = null;
  cp.state.modals = [];
  await assert.rejects(() => u.execute({ action: "upload", path: file }, {}), /no file dialog is open/);
  await check("upload says so when no dialog is open", () => {});
  cp.state.modals = null;
  await assert.rejects(() => u.execute({ action: "upload", path: path.join(ARTIFACTS, "nope.txt") }, {}), /no such file/);
  await check("upload refuses a path that is not there", () => {});
}

console.log("\n[browser by name]");
{
  const t = boot();
  const def = t.definition || t.def || t;
  const enumList = (((def.parameters || {}).properties || {}).action || {}).enum || [];
  await check("the action list offers the browser", () => assert.ok(enumList.includes("browser"), `${enumList.length} actions`));
  await check("the browser parameter is documented", () => assert.ok((((def.parameters || {}).properties) || {}).browser));
  await assert.rejects(() => t.execute({ action: "browser" }, {}), /browser needs a command/);
  await check("a browser call without a command is a clear error", () => {});
  const dry = await t.execute({ action: "run", dryRun: true, plan: "page goto about:blank\npage wait #ready 3000" }, {});
  const parsed = JSON.parse(dry.text);
  await check("a plan can carry the browser too", () => {
    assert.strictEqual(parsed.steps.length, 2);
    assert.strictEqual(parsed.steps[0].op, "page");
    assert.strictEqual(parsed.steps[0].rest, "goto about:blank");
    assert.strictEqual(parsed.steps[1].rest, "wait #ready 3000");
  });
}

console.log("\n[loud defaults]");
{
  const t = boot();
  const slept = text(await t.execute({ action: "wait", ms: 40 }, {}));
  await check("wait says how long it slept instead of returning nothing", () => {
    eq(slept.ok, true);
    eq(slept.sleptMs, 40);
    const c = callOf("wait").at(-1);
    eq(c.argv.slice(1), ["--ms", "40"]);
  });

  cp.state.readtextEmpty = true;
  const blind = text(await t.execute({ action: "readtext", hwnd: "999001" }, {}));
  cp.state.readtextEmpty = false;
  await check("an empty readtext says where else to look", () => {
    eq(blind.chars, 0);
    assert.ok(/ocr/.test(String(blind.hint || "")), String(blind.hint));
    assert.ok(/clipboard/.test(String(blind.hint || "")), String(blind.hint));
  });

  cp.state.staleHwnd = 12345;
  await assert.rejects(() => t.execute({ action: "focus", hwnd: "12345" }, {}), /no window with hwnd 12345 - it was closed or recreated/);
  cp.state.staleHwnd = null;
  await check("a stale hwnd is named as stale", () => {});
}

console.log("\n[engine failure]");
{
  const t = boot({ timeoutMs: 5000 });
  cp.state.failNext = "info";
  await assert.rejects(() => t.execute({ action: "info" }, {}), /computer engine failed \(exit 1\): boom/);
  await check("engine stderr surfaces in the error", () => {});
}

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
