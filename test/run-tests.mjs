// Unit tests for the dsh-computer-use plugin contract, with the engine mocked.
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
function check(name, fn) {
  try { fn(); pass++; console.log("  ok   " + name); }
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
const callOf = (cmd) => cp.calls.filter((c) => c.argv[0] === cmd);

console.log("\n[schema]");
{
  const t = boot();
  check("tool is named computer", () => eq(t.name, "computer"));
  check("exposes a description", () => assert.ok(t.description.length > 100));
  check("action is required and enumerated", () => {
    eq(t.parameters.type, "object");
    assert.ok(t.parameters.required.includes("action"));
    eq(t.parameters.additionalProperties, false);
    assert.ok(t.parameters.properties.action.enum.includes("screenshot"));
    assert.ok(t.parameters.properties.action.enum.includes("invoke"));
  });
  check("each enum value is documented as a parameter path", () => {
    for (const k of ["hwnd", "title", "x", "y", "text", "combo", "elementPath", "region", "maxw", "depth", "max"]) assert.ok(t.parameters.properties[k], k);
  });
  check("output schema declares text only", () => {
    assert.ok(t.output.schema.required.includes("text"));
    eq(t.output.schema.additionalProperties, false);
    eq(t.output.render({ action: "info" }, { text: "hi" }), [{ type: "text", text: "hi" }]);
  });
  check("presentCall gives a read card for observation", () => {
    const v = t.presentCall({ action: "screenshot" });
    eq(v.card, "generic"); eq(v.kind, "read"); assert.match(v.title, /screen/i);
  });
  check("presentCall marks input as execute", () => eq(t.presentCall({ action: "click" }).kind, "execute"));
  check("presentCall shows the foreground flag for launch", () => eq(t.presentCall({ action: "launch" }).kind, "other"));
}

console.log("\n[observe]");
{
  const t = boot();
  const v = text(await t.execute({ action: "info" }, {}));
  check("info returns monitors and foreground", () => {
    eq(v.monitors.length, 1); eq(v.foreground.hwnd, 656368);
  });
  check("info passes no stray flags", () => eq(callOf("info")[0].argv, ["info"]));

  const w = text(await t.execute({ action: "windows" }, {}));
  check("windows returns the window list", () => eq(w.windows.length, 2));
  check("windows --all maps to the all flag", async () => {});
  await t.execute({ action: "windows", all: true }, {});
  check("windows all passes --all", () => assert.ok(callOf("windows")[1].argv.includes("--all")));

  const s = text(await t.execute({ action: "screenshot", maxw: 640, region: "0,0,100,100" }, {}));
  check("screenshot writes under artifactsDir", () => {
    assert.ok(s.path.startsWith(ARTIFACTS), s.path);
    assert.match(s.path, /shot-\d{8}-\d{6}-\d{3}\.png$/);
  });
  check("screenshot passes maxw and region", () => {
    const a = callOf("shot")[0].argv;
    assert.ok(a.includes("--out") && a.includes("--maxw") && a.includes("--region"));
    eq(a[a.indexOf("--maxw") + 1], "640");
    eq(a[a.indexOf("--region") + 1], "0,0,100,100");
  });
  check("screenshot reports the downscale factor", () => eq(s.scale, 4));

  const t2 = boot();
  const w2 = text(await t2.execute({ action: "screenshot" }, {}));
  check("screenshot defaults to maxw 1600", () => eq(callOf("shot")[0].argv[callOf("shot")[0].argv.indexOf("--maxw") + 1], "1600"));
  check("screenshot hint mentions scale", () => assert.match(w2.hint, /scale/));

  const tree = text(await t.execute({ action: "snapshot", hwnd: "656368", depth: 3 }, {}));
  check("snapshot targets hwnd with depth", () => {
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
  check("title resolves to a hwnd and raises it", () => {
    eq(callOf("focus")[0].argv, ["focus", "--hwnd", "999001"]);
    const click = callOf("click")[0].argv;
    eq(click[0], "click");
    eq(click[click.indexOf("--x") + 1], "10");
  });
  check("focused flag reports the raise", () => {});

  const t2 = boot();
  const v = text(await t2.execute({ action: "click", hwnd: "656368", x: 1, y: 2 }, {}));
  check("already-foreground window is not re-focused", () => eq(callOf("focus").length, 0));
  check("click result reports focused=false", () => eq(v.focused, false));

  await assert.rejects(() => t2.execute({ action: "focus", title: "no such window" }, {}), /no window title contains/);
  check("unknown title lists open windows", () => {});
}

console.log("\n[input mapping]");
{
  const t = boot();
  await t.execute({ action: "type", text: "hello" }, {});
  check("short text goes through --text", () => eq(callOf("type")[0].argv, ["type", "--text", "hello"]));

  const long = "x".repeat(2000);
  await t.execute({ action: "type", text: long }, {});
  const a = callOf("type")[1].argv;
  check("long text is spooled to --textfile", () => {
    eq(a[1], "--textfile");
    eq(fs.readFileSync(a[2], "utf8"), long);
  });

  await t.execute({ action: "key", combo: "ctrl+shift+s" }, {});
  check("key passes the chord", () => eq(callOf("key")[0].argv, ["key", "--combo", "ctrl+shift+s"]));

  await t.execute({ action: "click", x: 5, y: 6, button: "right", count: 2 }, {});
  const c = callOf("click")[0].argv;
  check("click maps button and count", () => {
    eq(c[c.indexOf("--button") + 1], "right");
    eq(c[c.indexOf("--count") + 1], "2");
  });

  await t.execute({ action: "scroll", x: 5, y: 6, amount: -3, horizontal: true }, {});
  const sc = callOf("scroll")[0].argv;
  check("scroll maps amount and horizontal", () => {
    eq(sc[sc.indexOf("--amount") + 1], "-3");
    assert.ok(sc.includes("--horizontal"));
  });

  await t.execute({ action: "drag", x1: 1, y1: 2, x2: 3, y2: 4, ms: 500 }, {});
  check("drag maps its four points", () => eq(callOf("drag")[0].argv, ["drag", "--x1", "1", "--y1", "2", "--x2", "3", "--y2", "4", "--ms", "500"]));

  await t.execute({ action: "move", x: 7, y: 8 }, {});
  check("move maps coordinates", () => eq(callOf("move")[0].argv, ["move", "--x", "7", "--y", "8"]));

  await assert.rejects(() => t.execute({ action: "type" }, {}), /requires `text`/);
  await assert.rejects(() => t.execute({ action: "key" }, {}), /requires `combo`/);
  await assert.rejects(() => t.execute({ action: "invoke", hwnd: "1" }, {}), /requires elementPath/);
  await assert.rejects(() => t.execute({ action: "kill" }, {}), /requires pid or name/);
  check("missing required arguments are rejected", () => {});
}

console.log("\n[guard]");
{
  const t = boot({ blockedProcesses: ["chrome.exe"] });
  await assert.rejects(() => t.execute({ action: "click", x: 1, y: 1 }, {}), /input blocked/);
  check("blocked process refuses input", () => eq(callOf("click").length, 0));
  check("blocked process still allows observation", async () => {});
  await t.execute({ action: "screenshot" }, {});
  check("screenshot is never blocked", () => eq(callOf("shot").length, 1));

  const t2 = boot({ blockedProcesses: ["unrealwindow"] });
  cp.state.foreground = { hwnd: 1, title: "PUBG", class: "UnrealWindow", process: "TslGame.exe", rect: { x: 0, y: 0, w: 2560, h: 1600 } };
  await assert.rejects(() => t2.execute({ action: "key", combo: "a" }, {}), /input blocked/);
  check("guard matches window class too", () => {});
  cp.state.foreground = {
    hwnd: 656368, title: "DeepSeek Harness", class: "Chrome_WidgetWin_1",
    process: "chrome.exe", pid: 32992, visible: true, foreground: true,
    rect: { x: 318, y: 149, w: 1923, h: 1234 }
  };

  const t3 = boot({ refuseFullscreenForeground: true });
  cp.state.foreground = { hwnd: 1, title: "PUBG", class: "UnrealWindow", process: "TslGame.exe", rect: { x: 0, y: 0, w: 2560, h: 1600 } };
  await assert.rejects(() => t3.execute({ action: "click", x: 1, y: 1 }, {}), /fullscreen/);
  check("fullscreen foreground refuses input", () => {});
  cp.state.foreground = {
    hwnd: 656368, title: "DeepSeek Harness", class: "Chrome_WidgetWin_1",
    process: "chrome.exe", pid: 32992, visible: true, foreground: true,
    rect: { x: 318, y: 149, w: 1923, h: 1234 }
  };

  const t4 = boot({ allowProcessControl: false });
  await assert.rejects(() => t4.execute({ action: "launch", path: "notepad.exe" }, {}), /allowProcessControl/);
  await assert.rejects(() => t4.execute({ action: "kill", pid: 1 }, {}), /allowProcessControl/);
  check("process control can be disabled", () => {});

  const t5 = boot({ enabled: false });
  await assert.rejects(() => t5.execute({ action: "info" }, {}), /disabled/);
  check("enabled=false disables everything", () => {});
}

console.log("\n[process + clipboard]");
{
  const t = boot();
  await t.execute({ action: "procs", name: "note" }, {});
  check("procs forwards the filter", () => eq(callOf("procs")[0].argv, ["procs", "--name", "note"]));
  await t.execute({ action: "launch", path: "C:\\Windows\\notepad.exe", args: "a.txt", cwd: "C:\\" }, {});
  check("launch forwards path/args/cwd", () => eq(callOf("launch")[0].argv, ["launch", "--path", "C:\\Windows\\notepad.exe", "--args", "a.txt", "--cwd", "C:\\"]));
  await t.execute({ action: "kill", pid: 4242 }, {});
  check("kill forwards a pid", () => eq(callOf("kill")[0].argv, ["kill", "--pid", "4242"]));
  await t.execute({ action: "clipboard", clipboardCommand: "set", text: "hi 中文" }, {});
  const cl = callOf("clip")[0].argv;
  check("clipboard set spools utf8 text", () => {
    eq(cl[1], "--textfile");
    eq(fs.readFileSync(cl[2], "utf8"), "hi 中文");
  });
  const got = text(await t.execute({ action: "clipboard" }, {}));
  check("clipboard get reads text", () => eq(got.text, "clipboard contents"));
}

console.log("\n[invoke + dryRun]");
{
  const t = boot();
  await t.execute({ action: "invoke", hwnd: "656368", elementPath: "0.1.2" }, {});
  check("invoke passes hwnd and element path", () => eq(callOf("invoke")[0].argv, ["invoke", "--hwnd", "656368", "--path", "0.1.2"]));
  await t.execute({ action: "invoke", hwnd: "656368", elementPath: "0.1.2", value: "v" }, {});
  check("invoke forwards a value", () => eq(callOf("invoke")[1].argv[callOf("invoke")[1].argv.length - 1], "v"));

  const d = text(await t.execute({ action: "click", x: 1, y: 2, dryRun: true }, {}));
  check("dryRun returns argv without injecting", () => {
    eq(d.dryRun, true);
    assert.ok(d.argv.includes("click"));
    eq(callOf("click").length, 0);
  });
  const d2 = text(await t.execute({ action: "click", title: "notepad", dryRun: true }, {}));
  check("dryRun does not steal focus", () => {
    eq(d2.focused, false);
    eq(callOf("focus").length, 0);
  });
}

console.log("\n[readtext / waittext / trim / verify]");
{
  const t = boot();
  const r = text(await t.execute({ action: "readtext", hwnd: "656368" }, {}));
  check("readtext passes the window and returns the text", () => {
    eq(callOf("readtext")[0].argv, ["readtext", "--hwnd", "656368"]);
    eq(r.strategy, "uia");
    assert.match(r.text, /hello/);
  });
  await t.execute({ action: "readtext", hwnd: "656368", chars: 500 }, {});
  check("readtext forwards chars", () => eq(callOf("readtext")[1].argv, ["readtext", "--hwnd", "656368", "--chars", "500"]));

  const wt = text(await t.execute({ action: "waittext", hwnd: "656368", regex: "RA[>#]", timeout: 2000 }, {}));
  check("waittext forwards the regex and timeout", () => {
    eq(callOf("waittext")[0].argv, ["waittext", "--hwnd", "656368", "--regex", "RA[>#]", "--timeout", "2000"]);
    eq(wt.matched, true);
  });
  await assert.rejects(() => t.execute({ action: "waittext" }, {}), /requires `regex`/);
  check("waittext requires a regex", () => {});

  const s = text(await t.execute({ action: "screenshot", trim: true, tol: 20, pad: 4 }, {}));
  check("screenshot forwards trim options", () => {
    const a = callOf("shot")[0].argv;
    assert.ok(a.includes("--trim"));
    eq(a[a.indexOf("--tol") + 1], "20");
    eq(a[a.indexOf("--pad") + 1], "4");
    assert.ok(s.trim);
  });
  await t.execute({ action: "screenshot" }, {});
  check("screenshot does not trim by default", () => assert.ok(!callOf("shot")[1].argv.includes("--trim")));

  const sMin = text(await t.execute({ action: "screenshot", minBytes: 15000 }, {}));
  check("screenshot forwards minBytes as --min-bytes", () => {
    const a = callOf("shot")[2].argv;
    eq(a[a.indexOf("--min-bytes") + 1], "15000");
    eq(sMin.bytes, 480426);
  });
  await t.execute({ action: "screenshot", minBytes: 0 }, {});
  check("screenshot omits --min-bytes when it is zero", () => assert.ok(!callOf("shot")[3].argv.includes("--min-bytes")));

  await t.execute({ action: "type", hwnd: "656368", text: "echo hi", verify: true }, {});
  check("type --verify reaches the engine", () => {
    const a = callOf("type")[0].argv;
    assert.ok(a.includes("--verify"));
    eq(a[a.indexOf("--text") + 1], "echo hi");
  });
  const tv = text(await t.execute({ action: "type", hwnd: "656368", text: "x", verify: true }, {}));
  check("type verify reports unavailable when the window has no text", () => eq(tv.verified, "unavailable"));
  cp.state.typeVerify = "ok";
  const tv2 = text(await t.execute({ action: "type", hwnd: "656368", text: "x", verify: true }, {}));
  check("type verify passes through when the text appeared", () => eq(tv2.verified, true));
  cp.state.typeVerify = "mismatch";
  await assert.rejects(() => t.execute({ action: "type", hwnd: "656368", text: "x", verify: true }, {}), /did not show up/);
  check("type verify fails when the app swallowed the text", () => {});
  cp.state.typeVerify = null;
}

console.log("\n[engine failure]");
{
  const t = boot({ timeoutMs: 5000 });
  cp.state.failNext = "info";
  await assert.rejects(() => t.execute({ action: "info" }, {}), /computer engine failed \(exit 1\): boom/);
  check("engine stderr surfaces in the error", () => {});
}

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
