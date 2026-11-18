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
import { startPanel, createPanelHandler } from "./panel.js";
import { makeTargetClient } from "./targets.js";
import { normalizeProfiles, describeProfiles, findProfile, matchProfile, planSource, applyAliasesToSteps, windowMatches } from "./profiles.js";

export const name = "tool-computer";
export const inject = ["tools"];

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

/** Actions that synthesize pointer or keyboard input. */
const INPUT_ACTIONS = new Set(["click", "move", "scroll", "drag", "type", "key"]);
/** Actions that only observe; never blocked by the safety guard. */
const OBSERVE_ACTIONS = new Set([
  "screenshot", "windows", "info", "snapshot", "find", "hit", "procs", "clipboard",
  "inputcheck", "hover", "geom", "modals", "readtext", "waittext", "ocr", "state", "session", "ui", "targets", "profiles"
]);

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
  "info", "windows", "state", "session", "screenshot", "ocr", "snapshot", "ui", "find", "hit", "hover", "geom", "modals", "inputcheck",
  "readtext", "waittext",
  "click", "move", "scroll", "drag", "type", "key", "focus", "wait",
  "launch", "kill", "procs", "clipboard", "invoke", "run",
  "targets", "exec", "put", "get", "profiles"
];

/** Steps a plan file may contain (see runPlan). */
const PLAN_OPS = new Set([
  "wait", "read", "ocr", "type", "key", "focus", "click", "clickrel", "invoke", "shot", "sleep"
]);
/** Plan steps that synthesize input and therefore respect the blocklist. */
const INPUT_STEPS = new Set(["type", "key", "click", "clickrel", "invoke"]);

const DESCRIPTION = [
  "Control the Windows desktop: see the screen, read an app's accessibility tree or text, click, type, launch. Use it for GUI apps that have no CLI (Photoshop, After Effects, Resolve, Explorer, installers, settings dialogs).",
  "Token discipline, in priority order: (0) when the work is really inside another machine - a VMware guest or any box with ssh - drive it through `targets`/`exec`: one call returns text, while the same job over pixels costs dozens of screenshots; (1) if the job can be driven by a command line, use pwsh instead of pixels; (2) `readtext`/`waittext` to learn state, then `ocr` when the app exposes no text at all (Qt canvases, VM consoles, remote desktops) - a screenshot plus vision costs ~100x more and is only for when neither text nor OCR is available; (3) `ui` for a compact inventory of named controls, `snapshot` only when you need the full tree; (4) `run` to execute a known sequence in ONE call - it returns a one-line-per-step transcript and stops at the first failed post-condition.",
  "Before the first click run `inputcheck`: it proves synthetic input reaches the screen and names the reason when it would not (locked workstation, low-integrity process, elevated target). A click that lands nowhere looks exactly like an app that ignores you.",
  "Drive controls through their own patterns: `ui`/`find` give element ids, `invoke` fires Invoke/Select/SetValue with no focus or pixel dependency. `type` is unicode-safe and takes `verify: true` to read the text back; `key` sends chords like \"ctrl+shift+s\".",
  "One coordinate space: `geom` gives window rect, client rect and client origin; prefer `clickrel`/`relx` over absolute `--x/--y` so moving the window does not invalidate the point.",
  "`state` is the cheap session snapshot (lock, foreground, target geometry, blocking dialogs). `modals` before blaming an app that ignores input. `hover` reads a tooltip instead of guessing an icon.",
  "Input goes to whatever is in front: when the target is not foreground the tool raises it first, and reports focused=true.",
  "Per-app knowledge lives in profiles, not in scripts: `profiles` lists them, `state` names the one that owns the foreground window, and `run` with `profile` + `task` replays a saved plan (aliases and target window included). When a sequence works twice, save it into the profile instead of re-deriving it next time.",
  "Out of scope: files, registry, process details, notifications - use pwsh."
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

/**
 * DSH labels its workspace with Low integrity, and Windows starts an image that
 * carries that label as a low-integrity process. A low-integrity process can
 * read the screen but never move the pointer or type: SendInput reports success
 * and the events are dropped. So run the engine from a normal-integrity copy
 * outside the workspace instead of from the package directory.
 */
function stageEngine(source) {
  try {
    const base = process.env.LOCALAPPDATA || path.join(os.homedir(), "AppData", "Local");
    const st = fs.statSync(source);
    const tag = `${st.size}-${Math.round(st.mtimeMs)}`;
    const dir = path.join(base, "dsh-computer-use", "engine", tag);
    const target = path.join(dir, "cu.exe");
    if (fs.existsSync(target) && fs.statSync(target).size === st.size) return target;
    fs.mkdirSync(dir, { recursive: true });
    fs.copyFileSync(source, target);
    return target;
  } catch {
    return source; // read-only profile or odd ACL: fall back to the packaged path
  }
}

/**
 * A plan is a line-per-step script executed inside a single tool call. This is
 * the difference between "20 round trips, each paying for a screenshot" and
 * "one call, 20 lines of transcript": the model does not need to see the
 * intermediate screens when every step states its own post-condition.
 *
 *   wait /\$\s*$/ 5000     block until the prompt appears (pattern, then timeout)
 *   type show version       unicode-safe typing
 *   key enter               accelerators / chords
 *   focus                   raise the target window
 *   click 640 480           absolute screen pixels
 *   clickrel 120 40         client-area offsets of the target window
 *   invoke 0.2.1 [value]    drive a UIA control by element id
 *   shot step-3.png         evidence screenshot (bytes reported)
 *   read                    read the window text (reported as a char count)
 *   sleep 500               millis
 */
function parsePlan(src) {
  const steps = [];
  String(src || "").split(/\r?\n/).forEach((line, i) => {
    const raw = line.trim();
    if (!raw || raw.startsWith("#")) return;
    const m = /^([a-zA-Z]+)(\?)?\s*(.*)$/.exec(raw);
    if (!m) throw new Error(`plan line ${i + 1}: cannot parse ${JSON.stringify(raw)}`);
    const op = m[1].toLowerCase();
    const optional = Boolean(m[2]);
    if (!PLAN_OPS.has(op)) throw new Error(`plan line ${i + 1}: unknown step ${JSON.stringify(op)} (allowed: ${[...PLAN_OPS].join(", ")})`);
    steps.push({ line: i + 1, op, optional, rest: (m[3] || "").trim() });
  });
  if (!steps.length) throw new Error("plan is empty");
  if (steps.length > 80) throw new Error(`plan has ${steps.length} steps; split it (max 80)`);
  return steps;
}

/** "wait /pattern/ 5000" -> { pattern, timeout } */
function parseWait(rest) {
  const t = String(rest || "").trim();
  if (!t) throw new Error("wait needs a pattern");
  if (t.startsWith("/")) {
    const end = t.lastIndexOf("/");
    if (end <= 1) throw new Error(`wait: unterminated pattern ${JSON.stringify(t)}`);
    const pattern = t.slice(1, end);
    const tail = t.slice(end + 1).trim();
    return { pattern, timeout: tail ? Number(tail) : undefined };
  }
  const bits = t.split(/\s+/);
  return { pattern: bits[0], timeout: bits[1] ? Number(bits[1]) : undefined };
}

function splitFirst(rest) {
  const m = /^(\S+)\s*([\s\S]*)$/.exec(String(rest || "").trim());
  return m ? [m[1], m[2]] : ["", ""];
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
  const packaged = path.join(ROOT, "bin", "cu.exe");
  const engine = cfg.enginePath || stageEngine(packaged);
  const artifacts = cfg.artifactsDir || path.join(os.tmpdir(), "dsh-computer");
  // Other-machine execution channel (VMware guest via vmrun, or any ssh host).
  // Configured through `targets`; empty means the actions simply explain that.
  const remote = makeTargetClient({ cfg: { targets: cfg.targets }, log: dbg });
  // Per-app knowledge (window match, control aliases, saved plans) is data, not
  // code: it travels in the plugin config so a new application costs a JSON
  // block instead of another throwaway script.
  const profiles = normalizeProfiles(cfg.profiles);
  const timeoutMs = cfg.timeoutMs || 30000;
  const blocked = (cfg.blockedProcesses === undefined ? SAFE_BLOCKED : cfg.blockedProcesses || [])
    .map((s) => String(s).toLowerCase())
    .filter(Boolean);
  dbg("apply", { engine, artifacts, timeoutMs, blocked, profiles: profiles.map((p) => p.id), tools: Boolean(ctx && ctx.tools) });

  async function call(args) {
    if (!fs.existsSync(engine)) throw new Error(`computer engine missing at ${engine} - build it with bridge/build.ps1 or set enginePath`);
    const res = await run(engine, args, timeoutMs);
    const data = parseJson(res.out);
    if (!data) throw new Error(`computer engine failed (exit ${res.code}): ${String(res.err || res.out || "no output").slice(0, 700)}`);
    if (data.ok === false) throw new Error(data.error || "computer engine reported failure");
    return data;
  }

  // Execute a parsed plan and return a compact transcript: one line per step,
  // plus the reason it stopped. Nothing here screenshots unless the plan says so.
  async function execPlan(steps, opts) {
    const hwnd = opts.hwnd;
    const t0 = Date.now();
    const budget = Number(opts.timeoutMs || 120000);
    const lines = [];
    const tail = (s) => String(s || "").replace(/\s+/g, " ").slice(-180);
    for (let i = 0; i < steps.length; i++) {
      const s = steps[i];
      const started = Date.now();
      if (Date.now() - t0 > budget) {
        lines.push(`stopped: ${budget}ms budget exceeded before step ${i + 1}`);
        return { ok: false, text: lines.join("\n") };
      }
      try {
        // Input only reaches the foreground window. The engine refuses to inject
        // anywhere else (a guardrail, not an obstacle), so raise the target right
        // before each input step - it is a no-op when it is already in front.
        // Polite activation first; if Windows' foreground lock refuses it (the
        // desktop itself owns the foreground after a fresh launch or a dialog
        // closed), escalate once to --force - a lone ALT tap, documented in the
        // README - rather than failing a plan the caller already committed to.
        if (hwnd && INPUT_STEPS.has(s.op)) {
          try { await call(["focus", "--hwnd", hwnd]); }
          catch {
            try { await call(["focus", "--hwnd", hwnd, "--force"]); } catch { /* the step below will explain */ }
          }
          // A Chinese IME happily composes injected ASCII into characters the app
          // never sees as keystrokes, so a plan types nothing but still "succeeds".
          // Switching the target to an English layout first is cheap insurance.
          if (opts.autoIme !== false) {
            try { await call(["ime", "--hwnd", hwnd, "--disable"]); } catch { /* not fatal */ }
          }
        }
        switch (s.op) {
          case "wait": {
            // "wait /RA#/ 20000 ocr" reads the pixels instead of the text tree,
            // for windows that expose no text at all.
            const useOcr = /\socr\s*$/.test(" " + s.rest);
            const { pattern, timeout } = parseWait(useOcr ? s.rest.replace(/\s*ocr\s*$/, "") : s.rest);
            const argv = [useOcr ? "waitocr" : "waittext", "--regex", pattern, "--timeout", String(timeout || 8000)];
            if (hwnd) argv.push("--hwnd", hwnd);
            if (useOcr) {
              if (opts.psm) argv.push("--psm", String(opts.psm));
              if (opts.lang) argv.push("--lang", String(opts.lang));
              if (opts.tesseract) argv.push("--tesseract", String(opts.tesseract));
            }
            const r = await call(argv);
            lines.push(`${i + 1} ${useOcr ? "wait(ocr)" : "wait"} /${pattern}/ ${Date.now() - started}ms`);
            break;
          }
          case "read": {
            const useOcrRead = /\socr\s*$/.test(" " + s.rest);
            const argv = [useOcrRead ? "ocr" : "readtext"];
            if (hwnd) argv.push("--hwnd", hwnd);
            if (useOcrRead) {
              if (opts.psm) argv.push("--psm", String(opts.psm));
              if (opts.lang) argv.push("--lang", String(opts.lang));
            }
            const r = await call(argv);
            lines.push(`${i + 1} ${useOcrRead ? "read(ocr)" : "read"} ${r.chars}ch via ${r.strategy || "?"}`);
            break;
          }
          case "ocr": {
            const argv = ["ocr", "--psm", String(opts.psm || 6)];
            if (hwnd) argv.push("--hwnd", hwnd);
            if (s.rest) argv.push("--region", s.rest);
            if (opts.lang) argv.push("--lang", opts.lang);
            const r = await call(argv);
            const first = String(r.text || "").replace(/\s+/g, " ").slice(0, 70);
            lines.push(`${i + 1} ocr ${r.chars}ch ${r.ms}ms${first ? ` :: ${first}` : ""}`);
            break;
          }
          case "focus": {
            if (!hwnd) throw new Error("focus step needs a target window (pass hwnd or title to the tool)");
            await call(["focus", "--hwnd", hwnd]);
            lines.push(`${i + 1} focus ok`);
            break;
          }
          case "type": {
            if (!s.rest) throw new Error("type step has no text");
            const argv = ["type", "--text", s.rest];
            if (hwnd) argv.push("--hwnd", hwnd);
            if (opts.verify) argv.push("--verify");
            await call(argv);
            lines.push(`${i + 1} type ${s.rest.length}ch`);
            break;
          }
          case "key": {
            const argv = ["key", "--combo", s.rest];
            if (hwnd) argv.push("--hwnd", hwnd);
            await call(argv);
            lines.push(`${i + 1} key ${s.rest}`);
            break;
          }
          case "click":
          case "clickrel": {
            const [xs, ys] = s.rest.split(/\s+/);
            const argv = ["click"];
            if (hwnd) argv.push("--hwnd", hwnd);
            argv.push(s.op === "click" ? "--x" : "--relx", xs, s.op === "click" ? "--y" : "--rely", ys);
            await call(argv);
            lines.push(`${i + 1} ${s.op} ${xs},${ys}`);
            break;
          }
          case "invoke": {
            const [id, value] = splitFirst(s.rest);
            if (!id) throw new Error("invoke step needs an element id");
            if (!hwnd) throw new Error("invoke step needs a target window (pass hwnd or title)");
            const argv = ["invoke", "--hwnd", hwnd, "--path", id];
            if (value) argv.push("--value", value);
            const r = await call(argv);
            lines.push(`${i + 1} invoke ${id} ${r.pattern || "ok"}`);
            break;
          }
          case "shot": {
            fs.mkdirSync(artifacts, { recursive: true });
            const name = (s.rest || `shot-${stamp()}.png`).replace(/[^\w.-]+/g, "_");
            const out = path.isAbsolute(name) ? name : path.join(artifacts, name.endsWith(".png") ? name : `${name}.png`);
            const argv = ["shot", "--out", out, "--maxw", "1600"];
            if (hwnd) argv.push("--hwnd", hwnd);
            if (opts.minBytes) argv.push("--min-bytes", String(opts.minBytes));
            const r = await call(argv);
            lines.push(`${i + 1} shot ${path.basename(out)} ${Math.round((r.bytes || 0) / 1024)}KB`);
            break;
          }
          case "sleep": {
            const ms = Number(s.rest || 500);
            await new Promise((r) => setTimeout(r, ms));
            lines.push(`${i + 1} sleep ${ms}ms`);
            break;
          }
          default:
            throw new Error(`unknown step ${s.op}`);
        }
      } catch (e) {
        let why = e && e.message ? e.message : String(e);
        // A failed wait is the common case; show what the window actually said.
        if (s.op === "wait" || s.op === "read") {
          try {
            const argv = ["readtext", "--chars", "1500"];
            if (hwnd) argv.push("--hwnd", hwnd);
            const r = await call(argv);
            why += ` | last text: "${tail(r.text)}"`;
          } catch { /* the window may have died: keep the original error */ }
        }
        // "wait? /prompt/" - a step marked optional is a probe, not a promise:
        // record it and keep going instead of abandoning the rest of the plan.
        if (s.optional) {
          lines.push(`${i + 1} ${s.op} skipped (optional): ${tail(why)}`);
          continue;
        }
        lines.push(`${i + 1} ${s.op} FAILED after ${Date.now() - started}ms: ${why}`);
        lines.push(`stopped at step ${i + 1} of ${steps.length}`);
        return { ok: false, text: lines.join("\n") };
      }
    }
    lines.push(`done ${steps.length}/${steps.length} in ${((Date.now() - t0) / 1000).toFixed(1)}s`);
    return { ok: true, text: lines.join("\n") };
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
        description:
          "info | windows | screenshot | snapshot | find | hit | hover | geom | modals | inputcheck | click | move | scroll | drag | type | key | focus | wait | launch | kill | procs | clipboard | invoke | state | ui | readtext | waittext | run | profiles | targets | exec | put | get"
      },
      hwnd: { type: "string", description: "Target window handle (decimal) from `windows`." },
      title: { type: "string", description: "Target window by title substring; resolved to hwnd. Ignored when hwnd is given." },
      x: { type: "integer", description: "Screen X in physical pixels." },
      y: { type: "integer", description: "Screen Y in physical pixels." },
      relx: {
        type: "integer",
        description:
          "Client-area X offset inside `hwnd`, resolved against the live client origin. Preferred over x for anything inside a window: it survives moves, resize and maximize."
      },
      rely: { type: "integer", description: "Client-area Y offset inside `hwnd` (see relx)." },
      x1: { type: "integer", description: "drag start X." },
      y1: { type: "integer", description: "drag start Y." },
      x2: { type: "integer", description: "drag end X." },
      y2: { type: "integer", description: "drag end Y." },
      button: { type: "string", enum: ["left", "right", "middle"], description: "Mouse button, default left." },
      count: { type: "integer", description: "Click repeat count, default 1." },
      double: { type: "boolean", description: "Convenience for count=2." },
      amount: { type: "integer", description: "Scroll notches, positive up (default 3); negative scrolls down." },
      horizontal: { type: "boolean", description: "Scroll horizontally instead of vertically." },
      ms: { type: "integer", description: "drag duration, wait duration, or hover dwell in milliseconds." },
      text: { type: "string", description: "Text to type, or clipboard payload." },
      combo: { type: "string", description: "Key chord such as \"ctrl+shift+s\"; comma separates consecutive chords." },
      path: { type: "string", description: "launch: executable or document path." },
      args: { type: "string", description: "launch: command line arguments." },
      cwd: { type: "string", description: "launch/exec: working directory." },
      pid: { type: "integer", description: "kill: target process id." },
      elementPath: { type: "string", description: "invoke: element id from snapshot, e.g. \"0.2.1\"." },
      value: { type: "string", description: "invoke: value written through ValuePattern." },
      region: { type: "string", description: "screenshot: crop as \"left,top,right,bottom\" in physical pixels." },
      maxw: { type: "integer", description: "screenshot: downscale to this width (default 1600, 0 = native)." },
      trim: {
        type: "boolean",
        description:
          "screenshot: crop to the non-background content box. Use it when the interesting pixels are a small part of the capture (a dialog, one panel, one figure) - it drops empty margins and makes the image legible."
      },
      tol: { type: "integer", description: "screenshot trim: per-channel colour tolerance for 'background', default 12." },
      pad: { type: "integer", description: "screenshot trim: pixels of margin kept around the content, default 6." },
      minBytes: {
        type: "integer",
        description:
          "screenshot: refuse to return a PNG smaller than this many bytes. A blank capture (hidden window, display asleep, all-black frame) compresses to a few KB, so set a floor (e.g. 15000) when the picture is evidence rather than a look."
      },
      minBrightness: {
        type: "integer",
        description:
          "screenshot: reject a frame whose mean luminance is below this (0-255). A sleeping display or a suspended console is uniformly dark yet still compresses to tens of KB, so byte size alone misses it. 20 is a safe floor for evidence shots."
      },
      minStddev: {
        type: "integer",
        description:
          "screenshot: reject a frame whose luminance standard deviation is below this. 0 means a single flat colour - a blank panel, a window that never painted. 6 is a safe floor for evidence shots."
      },
      wake: {
        type: "integer",
        description:
          "screenshot: with a positive value, retry up to N more times before giving up, wiggling the pointer between attempts to dismiss a screensaver or blanked console."
      },
      lang: { type: "string", description: "ocr/run: tesseract language(s), default \"chi_sim+eng\"." },
      psm: { type: "integer", description: "ocr/run: tesseract page-segmentation mode, default 6 (a uniform block of text)." },
      tesseract: { type: "string", description: "ocr: path to tesseract.exe; defaults to DSH_TESSERACT or \"tesseract\" on PATH." },
      ocr: { type: "boolean", description: "readtext/waittext: read the pixels with tesseract when the window exposes no text at all (self-drawn terminals, Qt canvases). Costs one OCR pass per poll." },
      interval: { type: "integer", description: "waittext (ocr): milliseconds between OCR reads, default 400." },
      keep: { type: "string", description: "ocr: also write the captured PNG here (relative names land in the artifacts directory)." },
      regex: {
        type: "string",
        description:
          "waittext: regular expression matched against the window text; the action returns as soon as it matches."
      },
      timeout: { type: "integer", description: "waittext/run: give up after this many milliseconds (waittext default 8000; run default is the plan budget)." },
      plan: {
        type: "string",
        description:
          "run: the plan itself, one step per line. Steps: `wait /regex/ [ms]`, `read`, `ocr [l,t,r,b]`, `type TEXT`, `key ctrl+s`, `focus`, `click X Y`, `clickrel X Y`, `invoke ID [value]`, `shot name.png`, `sleep MS`. Append `?` to any step (`wait?`) to make it a probe: a failure is recorded and the plan continues. Returns a one-line-per-step transcript and stops at the first step whose post-condition fails. Use it whenever a sequence is known up front: one call instead of a dozen round trips."
      },
      file: { type: "string", description: "run: read the plan from this file instead of `plan`." },
      profile: {
        type: "string",
        description:
          "run/profiles: name of a configured app profile. With `profile` the plan may come from that profile (`task` names it), `{{alias}}` placeholders resolve to that profile's control ids, and the target window is found from the profile's `match` - so the plan never has to name a window."
      },
      task: {
        type: "string",
        description: "run: name of the plan saved in the profile given by `profile`. Omitted when the profile has exactly one plan."
      },
      target: {
        type: "string",
        description:
          "exec/put/get: name of a configured remote target (a VMware guest through vmrun, or an ssh host). Run action=targets first: with no target configured the other three fail with the list of names."
      },
      command: {
        type: "string",
        description:
          "exec: shell command to run inside the target (bash on the guest). The exit code and the tail of stdout come back; stdout is capped by maxChars."
      },
      local: { type: "string", description: "put: the local file to send. get: the local path to write." },
      remote: { type: "string", description: "put: the remote path to write. get: the remote file to read." },
      maxChars: {
        type: "integer",
        description:
          "exec: cap on returned stdout characters (default 8000, the tail is kept). Raise it only when the whole listing is the answer; lower it when you expect one line."
      },
      chars: { type: "integer", description: "readtext/waittext: maximum characters to read back (default 20000)." },
      verify: {
        type: "boolean",
        description:
          "type: read the window's text back after typing and fail when the text did not appear. Catches the silent cases - IME composition, a secure field, lost focus. Reports verified=\"unavailable\" when the window exposes no text channel."
      },
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

  const definition = {
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
        : a === "inputcheck" ? "Check that input lands"
        : a === "hover" ? "Hover and read the control"
        : a === "modals" ? "Look for dialogs in the way"
        : a === "geom" ? "Measure the window"
        : a === "readtext" ? "Read the window's text"
        : a === "session" ? "Get my bearings"
        : a === "ocr" ? "Read the pixels as text"
        : a === "waittext" ? "Wait for the screen to say…"
        : a === "run" && !args.profile ? "Run a GUI plan"
        : a === "ui" ? "List the app's controls"
        : a === "state" ? "Snapshot the desktop state"
        : a === "profiles" ? "List the app profiles"
        : a === "run" && args.profile ? `Run the saved plan ${args.profile}${args.task ? "/" + args.task : ""}`
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

      // Remote targets: a different machine behind vmrun or ssh. No window, no
      // foreground, so none of the GUI guardrails apply - but also no pixels, so
      // the whole interaction is text and costs a fraction of a screenshot loop.
      if (action === "targets") {
        return { text: JSON.stringify(clean({ ok: true, targets: remote.list() })) };
      }
      if (action === "exec") {
        if (!args.target) throw new Error("exec requires `target` (run action=targets to see the names)");
        if (!args.command) throw new Error("exec requires `command`");
        const r = await remote.exec(args.target, {
          command: args.command,
          cwd: args.cwd,
          timeoutMs: args.timeout,
          maxChars: args.maxChars
        });
        return { text: JSON.stringify(clean(r)) };
      }
      if (action === "put" || action === "get") {
        if (!args.target) throw new Error(`${action} requires \`target\` (run action=targets to see the names)`);
        const r = action === "put"
          ? await remote.put(args.target, { local: args.local, remote: args.remote })
          : await remote.get(args.target, { remote: args.remote, local: args.local });
        return { text: JSON.stringify(clean(r)) };
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
        case "state": {
          const info = await call(["info"]);
          const out = {
            ok: true,
            locked: info.locked,
            lockAppRunning: info.lockAppRunning,
            privileged: info.privileged,
            uiRestrictions: info.uiRestrictions,
            foreground: info.foreground
          };
          if (hwnd) out.target = await call(["geom", "--hwnd", String(hwnd)]);
          // A configured profile for whatever is in front turns "which app is
          // this and what is it called here" into one field instead of a hunt.
          if (profiles.length) {
            const hit = matchProfile(profiles, info.foreground);
            out.profile = hit
              ? { matched: true, id: hit.id, plans: Object.keys(hit.plans), ...(hit.notes ? { notes: hit.notes } : {}) }
              : { matched: false, configured: profiles.map((p) => p.id) };
          }
          if (cfg.targets && Object.keys(cfg.targets).length) out.targets = Object.keys(cfg.targets);
          try {
            // With a target we only care about dialogs belonging to that app - a
            // desktop-wide list is noise that reads like "something is blocking you".
            const m = await call(out.target && out.target.pid ? ["modals", "--pid", String(out.target.pid)] : ["modals"]);
            out.modals = { count: m.count, items: (m.modals || m.items || []).slice(0, 6).map((d) => ({ hwnd: d.hwnd, title: d.title, class: d.class, process: d.process })) };
          } catch { /* modals is best-effort */ }
          return { text: JSON.stringify(clean(out)) };
        }
        case "session": {
          // One call to get your bearings: can I type, what is in front, what is
          // configured, and what should I do first. Saves three or four probe
          // calls at the start of every task.
          const info = await call(["info"]);
          const out = {
            ok: true,
            locked: info.locked,
            lockAppRunning: info.lockAppRunning,
            privileged: info.privileged,
            screen: { w: info.screenW, h: info.screenH },
            foreground: info.foreground,
            targets: cfg.targets ? Object.keys(cfg.targets) : [],
            profiles: profiles.map((p) => ({ id: p.id, plans: Object.keys(p.plans) }))
          };
          const hints = [];
          let dialogs = 0;
          try { const m = await call(["modals"]); dialogs = Number(m.count || 0); } catch { /* best effort */ }
          out.modals = dialogs;
          if (info.locked || info.lockAppRunning) hints.push("the workstation looks locked: input does nothing until it is unlocked");
          else if (info.privileged === false) hints.push("this process runs at low integrity: input and screen capture will fail");
          if (dialogs) hints.push(`${dialogs} dialog(s) are open: an unseen modal swallows every click, so call modals and dismiss it first`);
          if (out.targets.length) hints.push(`a task may live in another machine: targets = ${out.targets.join(", ")} - prefer exec over pixels`);
          const front = profiles.length ? matchProfile(profiles, info.foreground) : null;
          if (front) {
            out.profile = { matched: true, id: front.id, plans: Object.keys(front.plans) };
            hints.push(`the front window matches profile "${front.id}": run {profile:"${front.id}",task:"<plan>"} instead of clicking through it`);
          }
          hints.push("when you do need pixels: readtext first, then ocr, then a screenshot");
          out.hint = hints;
          return { text: JSON.stringify(clean(out)) };
        }
        case "ui": {
          argv.push("ui");
          if (hwnd) push("hwnd", hwnd);
          push("max", args.max);
          push("depth", args.depth);
          return { text: JSON.stringify(clean(await call(argv))) };
        }
        case "run": {
          let src = args.plan || "";
          let target = hwnd;
          let prof = null;
          if (args.profile) {
            prof = findProfile(profiles, args.profile);
            if (!src && !args.file) src = planSource(prof, args.task);
            // A profile also knows which window it means. Resolving it here is
            // what lets a saved plan say "type hello" without naming a window,
            // and what makes every input step raise that window first.
            if (!target && Object.keys(prof.match || {}).length) {
              const listing = await call(["windows"]);
              const hit = (listing.windows || []).find((w) => windowMatches(prof.match, w));
              if (!hit) {
                const open = (listing.windows || []).map((w) => `${w.process}:${w.title}`).slice(0, 12).join(" | ");
                throw new Error(`profile "${prof.id}" matches no open window (match: ${JSON.stringify(prof.match)}); open windows: ${open}`);
              }
              target = String(hit.hwnd);
            }
          }
          if (!src && args.file) {
            if (!fs.existsSync(String(args.file))) throw new Error(`plan file not found: ${args.file}`);
            src = fs.readFileSync(String(args.file), "utf8");
          }
          if (!src) throw new Error("run needs `plan` (inline text), `file` (path), or `profile` + `task`");
          let steps = parsePlan(src);
          if (prof && Object.keys(prof.aliases).length) steps = applyAliasesToSteps(steps, prof.aliases);
          const needsInput = steps.some((s) => INPUT_STEPS.has(s.op));
          if (needsInput && target) {
            const listing = await call(["windows"]);
            checkTarget((listing.windows || []).find((w) => String(w.hwnd) === String(target)) || { hwnd: Number(target) });
          }
          const res = await execPlan(steps, {
            hwnd: target,
            timeoutMs: args.timeout || Math.max(timeoutMs * 4, 120000),
            minBytes: args.minBytes,
            verify: args.verify === true,
            autoIme: cfg.autoIme,
            psm: args.psm,
            lang: args.lang,
            tesseract: args.tesseract || cfg.tesseract
          });
          return { text: res.text };
        }
        case "profiles":
          return { text: JSON.stringify({ ok: true, count: profiles.length, profiles: describeProfiles(profiles) }) };
        case "screenshot": {
          fs.mkdirSync(artifacts, { recursive: true });
          const out = path.join(artifacts, `shot-${stamp()}.png`);
          argv.push("shot", "--out", out);
          if (hwnd) push("hwnd", hwnd);
          push("region", args.region);
          push("maxw", args.maxw === undefined ? 1600 : args.maxw);
          flag("trim", args.trim);
          push("tol", args.tol);
          push("pad", args.pad);
          if (args.minBytes !== undefined && args.minBytes > 0) {
            argv.push("--min-bytes", String(args.minBytes));
          }
          // A blank frame (sleeping display, suspended console) is dark and flat;
          // byte size alone cannot tell it apart from a real screenshot.
          if (args.minBrightness !== undefined && args.minBrightness >= 0) {
            argv.push("--min-brightness", String(args.minBrightness));
          }
          if (args.minStddev !== undefined && args.minStddev >= 0) {
            argv.push("--min-stddev", String(args.minStddev));
          }
          if (args.wake !== undefined && args.wake > 0) argv.push("--wake", String(args.wake));
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
        case "inputcheck":
          return { text: JSON.stringify(clean(await call(["inputcheck"]))) };
        case "geom":
          argv.push("geom"); if (hwnd) push("hwnd", hwnd);
          return { text: JSON.stringify(clean(await call(argv))) };
        case "modals":
          argv.push("modals"); if (hwnd) push("hwnd", hwnd); push("pid", args.pid);
          return { text: JSON.stringify(clean(await call(argv))) };
        case "readtext":
          if (args.ocr) {
            // No text channel at all: read the pixels instead of failing.
            const a = ["ocr"];
            if (hwnd) a.push("--hwnd", hwnd);
            if (args.lang) a.push("--lang", String(args.lang));
            if (args.psm) a.push("--psm", String(args.psm));
            if (args.maxw) a.push("--maxw", String(args.maxw));
            const tess = args.tesseract || cfg.tesseract;
            if (tess) a.push("--tesseract", String(tess));
            const o = await call(a);
            return { text: JSON.stringify({ ok: true, strategy: "ocr", chars: o.chars, text: o.text, ms: o.ms }) };
          }
          argv.push("readtext"); if (hwnd) push("hwnd", hwnd); push("chars", args.chars);
          return { text: JSON.stringify(clean(await call(argv))) };
        case "waittext": {
          if (!args.regex) throw new Error("waittext requires `regex`");
          if (args.ocr) {
            const a = ["waitocr"];
            if (hwnd) a.push("--hwnd", hwnd);
            a.push("--regex", String(args.regex));
            if (args.timeout) a.push("--timeout", String(args.timeout));
            if (args.interval) a.push("--interval", String(args.interval));
            if (args.lang) a.push("--lang", String(args.lang));
            if (args.psm) a.push("--psm", String(args.psm));
            if (args.maxw) a.push("--maxw", String(args.maxw));
            const tess = args.tesseract || cfg.tesseract;
            if (tess) a.push("--tesseract", String(tess));
            return { text: JSON.stringify(clean(await call(a))) };
          }
          argv.push("waittext"); if (hwnd) push("hwnd", hwnd);
          push("regex", args.regex); push("timeout", args.timeout); push("chars", args.chars);
          return { text: JSON.stringify(clean(await call(argv))) };
        }
        case "ocr": {
          // Text from apps that expose none (Qt canvases, VM consoles, remote
          // desktops). One call answers "what does the screen say" for a few
          // hundred tokens instead of shipping a PNG into a vision model.
          argv.push("ocr");
          if (hwnd) push("hwnd", hwnd);
          push("region", args.region);
          push("lang", args.lang);
          push("psm", args.psm);
          push("maxw", args.maxw === undefined || args.maxw === 0 ? undefined : args.maxw);
          if (args.keep) {
            fs.mkdirSync(artifacts, { recursive: true });
            const out = path.isAbsolute(args.keep) ? args.keep : path.join(artifacts, args.keep);
            argv.push("--keep", out);
          }
          if (args.tesseract) argv.push("--tesseract", args.tesseract);
          else if (cfg.tesseract) argv.push("--tesseract", cfg.tesseract);
          return { text: JSON.stringify(clean(await call(argv))) };
        }
        case "hover": {
          if (args.x === undefined || args.y === undefined) throw new Error("hover requires x and y");
          argv.push("hover"); push("x", args.x); push("y", args.y); push("ms", args.ms === undefined ? 1000 : args.ms);
          return { text: JSON.stringify(clean(await call(argv))) };
        }
        case "move":
          argv.push("move"); if (hwnd) push("hwnd", hwnd); push("x", args.x); push("y", args.y);
          push("relx", args.relx); push("rely", args.rely);
          break;
        case "click":
          argv.push("click"); if (hwnd) push("hwnd", hwnd); push("x", args.x); push("y", args.y);
          push("relx", args.relx); push("rely", args.rely);
          push("button", args.button); push("count", args.count); flag("double", args.double);
          break;
        case "scroll":
          argv.push("scroll"); if (hwnd) push("hwnd", hwnd); push("x", args.x); push("y", args.y); push("amount", args.amount);
          flag("horizontal", args.horizontal);
          break;
        case "drag":
          argv.push("drag"); if (hwnd) push("hwnd", hwnd); push("x1", args.x1); push("y1", args.y1); push("x2", args.x2); push("y2", args.y2);
          push("relx", args.relx); push("rely", args.rely);
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
          flag("verify", args.verify);
          if (hwnd && cfg.autoIme !== false) {
            // A Chinese IME swallows injected ASCII and turns it into Chinese
            // candidates: the app receives only the Enter. Force an English
            // layout on the target before typing, unless told not to.
            try { await call(["ime", "--hwnd", String(hwnd), "--disable"]); } catch { /* not fatal */ }
          }
          break;
        }
        case "key":
          if (!args.combo) throw new Error("key requires `combo`");
          argv.push("key", "--combo", args.combo);
          if (hwnd) argv.push("--hwnd", String(hwnd));
          if (hwnd && cfg.autoIme !== false) {
            try { await call(["ime", "--hwnd", String(hwnd), "--disable"]); } catch { /* not fatal */ }
          }
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
  };
  ctx.tools.register(definition);
  dbg("registered tool 'computer'");

  // The panel has two mounts that share one handler:
  //   - DSH's own web server, same-origin, authenticated by the DSH session, so
  //     a client tab can frame it without tokens or CORS games;
  //   - loopback with a random token, for a plain browser window (opt-in).
  const exec = async (args) => {
    const out = await definition.execute(args, {});
    const text = out && out.text;
    try { return JSON.parse(text); } catch { return { text }; }
  };
  const PANEL_PREFIX = "/computer-use/panel";
  // Mounting is done through a dynamic dependency on `webServer`: a static
  // `inject` would keep the whole plugin (and its tool) from loading in profiles
  // that have no web server at all, such as `dsh <profile> "..."` in a terminal.
  const diag = (extra) => {
    try {
      fs.mkdirSync(artifacts, { recursive: true });
      fs.writeFileSync(
        path.join(artifacts, "panel-diag.json"),
        JSON.stringify({ at: new Date().toISOString(), ...extra }, null, 2)
      );
    } catch { /* diagnostics must never break startup */ }
  };
  let sawWebServer = false;
  try { sawWebServer = Boolean(ctx.webServer && typeof ctx.webServer.register === "function"); } catch { /* service access may throw */ }
  diag({ mounted: false, phase: "apply", sawWebServer, hasInject: typeof ctx.inject === "function" });
  const mountPanel = (scope) => {    const mounted = () => scope.webServer.register({
      kind: "prefix",
      path: PANEL_PREFIX,
      handler: createPanelHandler({
        exec,
        artifactsDir: artifacts,
        log: (line) => dbg("panel", line),
        prefix: PANEL_PREFIX
      }).handler
    });
    if (typeof scope.effect === "function") scope.effect(mounted, "dsh-computer-use: panel");
    else mounted();
    diag({ mounted: true, via: "webServer" });
    dbg("panel mounted at " + PANEL_PREFIX);
  };
  let mountedPanel = false;
  try {
    if (typeof ctx.inject === "function") {
      ctx.inject(["webServer"], mountPanel);
      mountedPanel = true;
    } else if (ctx.webServer && typeof ctx.webServer.register === "function") {
      mountPanel(ctx);
      mountedPanel = true;
    }
  } catch (err) {
    diag({ mounted: false, error: String((err && err.message) || err) });
    dbg("panel mount failed", String((err && err.message) || err));
  }
  if (!mountedPanel) diag({ mounted: false, reason: "no webServer and no ctx.inject" });

  // Optional loopback copy for a normal browser window.
  // Off unless a port is configured (or DSH_COMPUTER_USE_PANEL=1 for a random one).
  const wantPanel = cfg.panelPort === undefined
    ? (process.env.DSH_COMPUTER_USE_PANEL ? 0 : null)
    : (cfg.panelPort === false ? null : Number(cfg.panelPort));
  if (wantPanel !== null) {
    startPanel({ exec, port: wantPanel, artifactsDir: artifacts, log: (line) => dbg("panel", line) })
      .then((panel) => {
        try {
          fs.mkdirSync(path.join(artifacts), { recursive: true });
          fs.writeFileSync(path.join(artifacts, "panel.json"), JSON.stringify({ url: panel.url, port: panel.port, token: panel.token }, null, 2));
        } catch { /* the URL is also in the debug log */ }
        // Let the host tear the server down with the plugin, not with the process.
        try { if (ctx && typeof ctx.on === "function") ctx.on("dispose", () => panel.close()); } catch { /* older hosts */ }
        dbg("panel listening", panel.url);
        try { console.error("[dsh-computer-use] panel: " + panel.url); } catch { /* no console */ }
      })
      .catch((err) => dbg("panel failed", String((err && err.message) || err)));
  }
}
