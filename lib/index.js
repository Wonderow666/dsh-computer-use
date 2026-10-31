/**
 * dsh-computer-use — native Windows GUI control for DeepSeek Harness.
 *
 * Registers a single `computer` tool backed by `bin/cu.exe`, a Win32 +
 * UI Automation bridge: screen capture, window inventory, accessibility
 * tree, mouse/keyboard injection, app launch/terminate, clipboard.
 *
 * What we took from the public implementations (Windows-MCP, trycua/cua):
 *  - "screenshot first" as the cheap state read, so no vision model is needed
 *    to *act* (only to *see*), and the image is downscaled by default;
 *  - an accessibility tree with stable, stateless element ids so a click can be
 *    deterministic instead of pixel-guessed;
 *  - one process invocation per action, so a wedged call cannot poison a
 *    long-lived daemon;
 *  - explicit foreground ownership: only the intended window receives input.
 * What we dropped: 20 near-duplicate tools (one `action` enum instead), the MCP
 * socket hop (a native tool is one less moving part), and the registry/toast/
 * file-system surface that the shell tool already covers better.
 *
 * @module dsh-computer-use
 */
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const name = "tool-computer";
export const inject = ["tools"];

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

/** Actions that synthesize pointer or keyboard input. */
const INPUT_ACTIONS = new Set(["click", "move", "scroll", "drag", "type", "key"]);
/** Actions that only observe; never blocked by the safety guard. */
const OBSERVE_ACTIONS = new Set(["screenshot", "windows", "info", "snapshot", "find", "hit", "procs", "clipboard"]);

/**
 * Configuration is read directly from the plugin config (cordis hands the
 * `insert[].config` object to `apply`). No schema library is imported on
 * purpose: a `link:`-installed plugin has no node_modules of its own, so any
 * non-builtin import would fail to resolve inside the DSH profile.
 *
 *   enabled                  boolean, default true
 *   enginePath               string,  default <pkg>/bin/cu.exe
 *   artifactsDir             string,  default <tmp>/dsh-computer
 *   blockedProcesses         string[], default SAFE_BLOCKED - refuse input whose
 *                            target process/class/title matches (case-insensitive)
 *   refuseFullscreenForeground boolean, default false
 *   allowProcessControl      boolean, default true - launch/kill on or off
 *   timeoutMs                number,  default 30000
 */

// Never type into the games this machine actually runs, even if the profile
// config is missing the key (an explicit [] still means "no blocking").
const SAFE_BLOCKED = ["TslGame.exe", "UnrealWindow"];
const ACTIONS = [
  "info", "windows", "screenshot", "snapshot", "find", "hit",
  "click", "move", "scroll", "drag", "type", "key", "focus", "wait",
  "launch", "kill", "procs", "clipboard", "invoke"
];

const DESCRIPTION = [
  "Control the Windows desktop directly: see the screen, read an app's accessibility tree, click, type, launch.",
  "Use this for GUI applications that have no CLI or API (Photoshop, After Effects, Resolve, Explorer, installers, game launchers, settings dialogs).",
  "Loop: `screenshot` (or `snapshot`) to look, act, then look again to verify the result. Never assume an action worked.",
  "`screenshot` writes a PNG and returns its path; open that path with your vision tool, then reason in screen pixels. When srcW > w the image is downscaled - multiply image coordinates by srcW/w.",
  "`snapshot` returns the UI Automation tree with element ids (e.g. \"0.2.1\") and rects. Prefer `invoke` with an element id: it drives the control through its own Invoke/Select/SetValue pattern and does not depend on window focus or exact pixels.",
  "`windows` lists top-level windows with hwnd, pid, class, rect and foreground flag; pass hwnd or a title substring to scope any action.",
  "Type with `type` (unicode, CJK safe) and send accelerators with `key`, e.g. combo \"ctrl+shift+s\" or \"alt+f4,enter\".",
  "Input goes to whatever window is in front: when the target is not foreground this tool raises it first and reports focused=true.",
  "Out of scope: files, registry, process listing details, notifications - use pwsh for those."
].join(" ");

function clean(data) {
  if (Array.isArray(data)) return data.map(clean);
  if (!data || typeof data !== "object") return data;
  const out = {};
  for (const [k, v] of Object.entries(data)) {
    if (v === undefined || v === null || v === "") continue;
    if (Array.isArray(v) && v.length === 0) continue;
    out[k] = clean(v);
  }
  return out;
}

function run(engine, args, timeoutMs) {
  return new Promise((resolve) => {
    let settled = false;
    const done = (r) => { if (!settled) { settled = true; resolve(r); } };
    let child;
    try {
      child = spawn(engine, args, { windowsHide: false, stdio: ["ignore", "pipe", "pipe"] });
    } catch (e) {
      done({ code: -1, out: "", err: String((e && e.message) || e) });
      return;
    }
    let out = "";
    let err = "";
    const timer = setTimeout(() => { try { child.kill(); } catch {} done({ code: -1, out, err: "timeout" }); }, timeoutMs);
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (c) => { out += c; });
    child.stderr.on("data", (c) => { err += c; });
    child.on("error", (e) => { clearTimeout(timer); done({ code: -1, out, err: String((e && e.message) || e) }); });
    child.on("close", (code) => { clearTimeout(timer); done({ code, out, err }); });
  });
}

function parseJson(text) {
  const line = String(text || "").trim().split(/\r?\n/).filter(Boolean).pop();
  if (!line) return null;
  try { return JSON.parse(line); } catch { return null; }
}

function stamp() {
  const d = new Date();
  const p = (n, w = 2) => String(n).padStart(w, "0");
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}-${p(d.getMilliseconds(), 3)}`;
}

function hits(haystack, needles) {
  const s = String(haystack || "").toLowerCase();
  if (!s) return false;
  return needles.some((n) => n && s.includes(n));
}

export function apply(ctx, config) {
  const cfg = config || {};
  const dbg = process.env.DSH_COMPUTER_USE_DEBUG
    ? (...m) => {
        try {
          console.error("[dsh-computer-use]", ...m);
        } catch {
          /* no console in some hosts */
        }
      }
    : () => {};
  const engine = cfg.enginePath || path.join(ROOT, "bin", "cu.exe");
  const artifacts = cfg.artifactsDir || path.join(os.tmpdir(), "dsh-computer");
  const timeoutMs = cfg.timeoutMs || 30000;
  const blocked = (cfg.blockedProcesses === undefined ? SAFE_BLOCKED : cfg.blockedProcesses || [])
    .map((s) => String(s).toLowerCase())
    .filter(Boolean);
  dbg("apply", { engine, artifacts, timeoutMs, blocked, tools: Boolean(ctx && ctx.tools) });

  async function call(args) {
    if (!fs.existsSync(engine)) throw new Error(`computer engine missing at ${engine} - build it with bridge/build.ps1 or set enginePath`);
    const res = await run(engine, args, timeoutMs);
    const data = parseJson(res.out);
    if (!data) throw new Error(`computer engine failed (exit ${res.code}): ${String(res.err || res.out || "no output").slice(0, 700)}`);
    if (data.ok === false) throw new Error(data.error || "computer engine reported failure");
    return data;
  }

  async function resolveHwnd(args) {
    if (args.hwnd !== undefined && args.hwnd !== null && args.hwnd !== "") return String(args.hwnd);
    if (!args.title) return undefined;
    const { windows } = await call(["windows"]);
    const needle = String(args.title).toLowerCase();
    const hit = (windows || []).find((w) => String(w.title || "").toLowerCase().includes(needle));
    if (!hit) {
      const names = (windows || []).map((w) => `${w.hwnd}:${w.title}`).slice(0, 25).join(" | ");
      throw new Error(`no window title contains ${JSON.stringify(args.title)}; open windows: ${names}`);
    }
    return String(hit.hwnd);
  }

  async function observe() {
    return call(["info"]);
  }

  /**
   * The safety net. It judges the window that will RECEIVE the input, not the
   * one that happens to be in front right now - otherwise a blocked app in the
   * background would veto an unrelated, legitimate click.
   */
  function checkTarget(win) {
    const w = win || {};
    if (blocked.length && (hits(w.process, blocked) || hits(w.class, blocked) || hits(w.title, blocked))) {
      throw new Error(`input blocked: target "${w.title}" (${w.process || w.class}) matches blockedProcesses`);
    }
  }

  function checkFullscreen(win, monitors) {
    const r = (win || {}).rect || {};
    const mon = (monitors || []).find((m) => r.x === m.x && r.y === m.y && r.w === m.w && r.h === m.h);
    if (mon) throw new Error(`input blocked: target "${win.title}" is fullscreen on monitor ${mon.index}`);
  }

  /**
   * Hand-written JSON Schema. The tool registry receives `parameters` already
   * compiled to JSON Schema, so no validator library is needed - and importing
   * one would break a `link:`-installed plugin. Arguments are checked here.
   */
  const PARAMETERS = {
    type: "object",
    properties: {
      action: {
        type: "string",
        enum: ACTIONS,
        description: "info | windows | screenshot | snapshot | find | hit | click | move | scroll | drag | type | key | focus | wait | launch | kill | procs | clipboard | invoke"
      },
      hwnd: { type: "string", description: "Target window handle (decimal) from `windows`." },
      title: { type: "string", description: "Target window by title substring; resolved to hwnd. Ignored when hwnd is given." },
      x: { type: "integer", description: "Screen X in physical pixels." },
      y: { type: "integer", description: "Screen Y in physical pixels." },
      x1: { type: "integer", description: "drag start X." },
      y1: { type: "integer", description: "drag start Y." },
      x2: { type: "integer", description: "drag end X." },
      y2: { type: "integer", description: "drag end Y." },
      button: { type: "string", enum: ["left", "right", "middle"], description: "Mouse button, default left." },
      count: { type: "integer", description: "Click repeat count, default 1." },
      double: { type: "boolean", description: "Convenience for count=2." },
      amount: { type: "integer", description: "Scroll notches, positive up (default 3); negative scrolls down." },
      horizontal: { type: "boolean", description: "Scroll horizontally instead of vertically." },
      ms: { type: "integer", description: "drag duration or wait duration in milliseconds." },
      text: { type: "string", description: "Text to type, or clipboard payload." },
      combo: { type: "string", description: "Key chord such as \"ctrl+shift+s\"; comma separates consecutive chords." },
      path: { type: "string", description: "launch: executable or document path." },
      args: { type: "string", description: "launch: command line arguments." },
      cwd: { type: "string", description: "launch: working directory." },
      pid: { type: "integer", description: "kill: target process id." },
      elementPath: { type: "string", description: "invoke: element id from snapshot, e.g. \"0.2.1\"." },
      value: { type: "string", description: "invoke: value written through ValuePattern." },
      region: { type: "string", description: "screenshot: crop as \"left,top,right,bottom\" in physical pixels." },
      maxw: { type: "integer", description: "screenshot: downscale to this width (default 1600, 0 = native)." },
      depth: { type: "integer", description: "snapshot: accessibility tree depth, default 9." },
      max: { type: "integer", description: "snapshot: node budget, default 350." },
      name: { type: "string", description: "find: name/AutomationId substring. procs/kill: process name filter." },
      clipboardCommand: { type: "string", enum: ["get", "set"], description: "clipboard: get or set (default get)." },
      all: { type: "boolean", description: "windows: include hidden/untitled windows." },
      forceFocus: {
        type: "boolean",
        description:
          "Focus: allow the last-resort activation (a lone ALT tap) when Windows refuses a normal foreground switch. It can briefly disturb whatever the user has in front, so it is off by default."
      },
      dryRun: { type: "boolean", description: "Return the resolved engine command instead of executing it." }
    },
    required: ["action"],
    additionalProperties: false
  };

  function validateArgs(args) {
    const props = PARAMETERS.properties;
    if (args.action === undefined) throw new Error('missing required argument "action"');
    for (const [key, value] of Object.entries(args)) {
      if (!Object.hasOwn(props, key)) throw new Error(`unknown argument ${JSON.stringify(key)}`);
      if (value === undefined || value === null) continue;
      const spec = props[key];
      const ok = spec.type === "integer" ? Number.isInteger(value)
        : spec.type === "string" ? typeof value === "string"
        : spec.type === "boolean" ? typeof value === "boolean"
        : true;
      if (!ok) throw new Error(`argument ${JSON.stringify(key)} must be ${spec.type}`);
      if (spec.enum && !spec.enum.includes(value)) {
        throw new Error(`argument ${JSON.stringify(key)} must be one of ${spec.enum.join(", ")}`);
      }
    }
  }

  ctx.tools.register({
    name: "computer",
    description: DESCRIPTION,
    parameters: PARAMETERS,
    output: {
      schema: {
        type: "object",
        additionalProperties: false,
        properties: { text: { type: "string" } },
        required: ["text"]
      },
      render: (_args, value) => [{ type: "text", text: value.text }]
    },
    presentCall: (callArgs) => {
      const args = callArgs || {};
      const a = String(args.action || "");
      const kind = OBSERVE_ACTIONS.has(a) ? "read" : a === "launch" || a === "kill" ? "other" : "execute";
      const label = a === "screenshot" ? "Look at the screen"
        : a === "snapshot" ? "Read app UI tree"
        : a === "click" ? "Click on screen"
        : a === "type" || a === "key" ? "Send keyboard input"
        : `Computer: ${a}`;
      return { card: "generic", title: label, kind, rawInput: args };
    },
    async execute(rawArgs) {
      const args = rawArgs || {};
      validateArgs(args);
      const action = String(args.action || "");
      if (!ACTIONS.includes(action)) throw new Error(`unknown action ${JSON.stringify(action)}`);
      if (cfg.enabled === false) throw new Error("computer tool is disabled by configuration");
      if ((action === "launch" || action === "kill") && cfg.allowProcessControl === false) {
        throw new Error("process control is disabled by configuration (allowProcessControl=false)");
      }

      const hwnd = await resolveHwnd(args);
      const argv = [];
      const push = (k, v) => { if (v !== undefined && v !== null && v !== "") argv.push(`--${k}`, String(v)); };
      const flag = (k, on) => { if (on) argv.push(`--${k}`); };

      // Foreground ownership: judge and raise the window that will actually
      // receive the input; never inject into a blocked or fullscreen app.
      let focused = false;
      let fg = null;
      if (INPUT_ACTIONS.has(action)) {
        const listing = await call(["windows"]);
        fg = listing.foreground || null;
        const target = hwnd
          ? ((listing.windows || []).find((w) => String(w.hwnd) === String(hwnd)) || { hwnd: Number(hwnd) })
          : fg || {};
        checkTarget(target);
        if (cfg.refuseFullscreenForeground) checkFullscreen(target, (await observe()).monitors);
        if (hwnd && String((fg || {}).hwnd || "") !== String(hwnd) && args.dryRun !== true) {
          await call(args.forceFocus ? ["focus", "--hwnd", String(hwnd), "--force"] : ["focus", "--hwnd", String(hwnd)]);
          focused = true;
        }
      }

      switch (action) {
        case "info":
          return { text: JSON.stringify(clean(await call(["info"]))) };
        case "windows":
          return { text: JSON.stringify(clean(await call(args.all ? ["windows", "--all"] : ["windows"]))) };
        case "procs":
          argv.push("procs"); push("name", args.name);
          return { text: JSON.stringify(clean(await call(argv))) };
        case "screenshot": {
          fs.mkdirSync(artifacts, { recursive: true });
          const out = path.join(artifacts, `shot-${stamp()}.png`);
          argv.push("shot", "--out", out);
          if (hwnd) push("hwnd", hwnd);
          push("region", args.region);
          push("maxw", args.maxw === undefined ? 1600 : args.maxw);
          const data = await call(argv);
          const scale = data.w ? Number((data.srcW || data.w) / data.w) : 1;
          return {
            text: JSON.stringify(clean({
              ...data,
              scale,
              hint: "Open this PNG with your vision tool. Screen pixel = image pixel * scale."
            }))
          };
        }
        case "snapshot": {
          argv.push("tree");
          if (hwnd) push("hwnd", hwnd);
          push("depth", args.depth);
          push("max", args.max);
          return { text: JSON.stringify(clean(await call(argv))) };
        }
        case "find":
          argv.push("find"); if (hwnd) push("hwnd", hwnd); push("name", args.name);
          return { text: JSON.stringify(clean(await call(argv))) };
        case "hit":
          argv.push("hit"); push("x", args.x); push("y", args.y);
          return { text: JSON.stringify(clean(await call(argv))) };
        case "move":
          argv.push("move"); push("x", args.x); push("y", args.y);
          break;
        case "click":
          argv.push("click"); if (hwnd) push("hwnd", hwnd); push("x", args.x); push("y", args.y);
          push("button", args.button); push("count", args.count); flag("double", args.double);
          break;
        case "scroll":
          argv.push("scroll"); if (hwnd) push("hwnd", hwnd); push("x", args.x); push("y", args.y); push("amount", args.amount);
          flag("horizontal", args.horizontal);
          break;
        case "drag":
          argv.push("drag"); if (hwnd) push("hwnd", hwnd); push("x1", args.x1); push("y1", args.y1); push("x2", args.x2); push("y2", args.y2);
          push("ms", args.ms); push("button", args.button);
          break;
        case "type": {
          if (!args.text) throw new Error("type requires `text`");
          if (args.text.length > 1500) {
            fs.mkdirSync(artifacts, { recursive: true });
            const tmp = path.join(artifacts, `type-${stamp()}.txt`);
            fs.writeFileSync(tmp, args.text, "utf8");
            argv.push("type", "--textfile", tmp);
          } else {
            argv.push("type", "--text", args.text);
          }
          // Without --hwnd the engine types into whatever has focus, so always
          // pass the window the model asked for and let it re-check the target.
          if (hwnd) argv.push("--hwnd", String(hwnd));
          break;
        }
        case "key":
          if (!args.combo) throw new Error("key requires `combo`");
          argv.push("key", "--combo", args.combo);
          if (hwnd) argv.push("--hwnd", String(hwnd));
          break;
        case "wait":
          argv.push("wait"); push("ms", args.ms === undefined ? 500 : args.ms);
          return { text: JSON.stringify(clean(await call(argv))) };
        case "focus": {
          if (!hwnd) throw new Error("focus requires hwnd or title");
          return { text: JSON.stringify(clean(await call(args.forceFocus ? ["focus", "--hwnd", hwnd, "--force"] : ["focus", "--hwnd", hwnd]))) };
        }
        case "launch": {
          if (!args.path) throw new Error("launch requires `path`");
          argv.push("launch", "--path", args.path); push("args", args.args); push("cwd", args.cwd);
          return { text: JSON.stringify(clean(await call(argv))) };
        }
        case "kill": {
          if (args.pid === undefined && !args.name) throw new Error("kill requires pid or name");
          argv.push("kill"); push("pid", args.pid); push("name", args.name);
          return { text: JSON.stringify(clean(await call(argv))) };
        }
        case "clipboard": {
          if ((args.clipboardCommand || "get") === "set") {
            if (args.text === undefined) throw new Error("clipboard set requires `text`");
            fs.mkdirSync(artifacts, { recursive: true });
            const tmp = path.join(artifacts, `clip-${stamp()}.txt`);
            fs.writeFileSync(tmp, args.text, "utf8");
            argv.push("clip", "--textfile", tmp);
          } else {
            argv.push("clip", "--get");
          }
          return { text: JSON.stringify(clean(await call(argv))) };
        }
        case "invoke": {
          if (!hwnd) throw new Error("invoke requires hwnd or title");
          if (!args.elementPath) throw new Error("invoke requires elementPath from snapshot");
          argv.push("invoke", "--hwnd", hwnd, "--path", args.elementPath);
          push("value", args.value);
          return { text: JSON.stringify(clean(await call(argv))) };
        }
        default:
          throw new Error(`unhandled action ${action}`);
      }

      if (args.dryRun) return { text: JSON.stringify(clean({ dryRun: true, engine, argv, focused, target: fg })) };
      const data = await call(argv);
      return { text: JSON.stringify(clean({ ...data, focused })) };
    }
  });
  dbg("registered tool 'computer'");
}
