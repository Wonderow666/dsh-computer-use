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
import { normalizeProfiles, describeProfiles, findProfile, matchProfile, planSource, applyAliasesToSteps, windowMatches, readProfileFiles, mergeProfileLists } from "./profiles.js";
import { ensureBrowser, listTabs, connect as cdpConnect, evaluate as cdpEval, navigate as cdpGoto, clickSelector, fillSelector, textOf as cdpText, screenshot as cdpShot, setFileInput, setDownloads, probe as cdpProbe, newTab as cdpNewTab, closeTab as cdpCloseTab, pageHistory as cdpHistory, handleDialog as cdpDialog } from "./browser.js";

export const name = "tool-computer";
export const inject = ["tools"];

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

/** Actions that synthesize pointer or keyboard input. */
const INPUT_ACTIONS = new Set(["click", "clicknum", "move", "scroll", "drag", "type", "key"]);
/** Actions that only observe; never blocked by the safety guard. */
const OBSERVE_ACTIONS = new Set([
  "screenshot", "windows", "info", "snapshot", "find", "hit", "procs", "clipboard",
  "inputcheck", "hover", "geom", "modals", "watch", "readtext", "waittext", "ocr", "state", "session", "ui", "see", "targets", "profiles"
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
  "info", "windows", "state", "session", "screenshot", "ocr", "snapshot", "ui", "see", "find", "hit", "hover", "geom", "modals", "watch", "inputcheck",
  "readtext", "waittext",
  "click", "clicknum", "move", "scroll", "drag", "type", "upload", "key", "focus", "wait",
  "launch", "kill", "procs", "clipboard", "invoke", "run",
  "browser", "targets", "exec", "put", "get", "profiles", "failures"
];

/** Steps a plan file may contain (see runPlan). */
const PLAN_OPS = new Set([
  "wait", "read", "ocr", "type", "key", "focus", "click", "clickrel", "press", "invoke", "shot", "sleep", "launch", "watch",
  "page", "assert"
]);
/** Plan steps that synthesize input and therefore respect the blocklist. */
const INPUT_STEPS = new Set(["type", "key", "click", "clickrel", "invoke"]);
/** Steps that promise an effect; a plan made of them should end by checking one. */
const MUTATING_STEPS = new Set(["type", "key", "click", "clickrel", "press", "invoke", "upload", "launch"]);
/** Steps that read something back: text, pixels, an event, or a page. */
const CHECKING_STEPS = new Set(["wait", "read", "ocr", "assert", "watch", "page", "shot"]);

function planWarnings(steps) {
  const out = [];
  const mutates = steps.some((s) => MUTATING_STEPS.has(s.op));
  const checks = steps.some((s) => CHECKING_STEPS.has(s.op));
  if (mutates && !checks) {
    out.push('this plan changes the screen but never checks it - end with "assert /text you expect/" so a wrong click fails here');
  }
  return out;
}

const DESCRIPTION = [
  "Control the Windows desktop: see the screen, read text, click, type, launch. For GUI apps with no CLI (Photoshop, After Effects, Resolve, Explorer, installers, dialogs). For a web page use action=browser (CDP + CSS selectors) instead of clicking pixels.",
  "Spend tokens in this order: (0) inside a VMware guest or an ssh box, use targets/exec - one call returns text; (1) if a command line can do it, use pwsh; (2) readtext/waittext for state, ocr when the app exposes no text (Qt canvases, VM consoles, remote desktops) - ocr is local tesseract, so it still works when the vision model does not; (3) ui for a compact control list, snapshot only for the full tree; (4) run to do a known sequence in one call (one line per step, stops on the first failure).",
  "Before the first click run inputcheck: it names why input would not land (locked screen, low integrity, elevated target).",
  "Prefer control patterns over pixels: ui/find give ids, invoke fires Invoke/Select/SetValue without focus (a pattern of click-center means it had none and clicked the centre instead). One coordinate space: geom + clickrel rather than absolute points.",
  "state is the cheap snapshot; modals before blaming an app that ignores input; hover reads a tooltip.",
  "Per-app knowledge lives in profiles: profiles, state (which profile owns the foreground), run {profile, task}. Save a sequence that worked twice instead of re-deriving it.",
  "Out of scope: files, registry, processes, notifications - use pwsh."
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
    let raw = line.trim();
    if (!raw || raw.startsWith("#")) return;
    // Two prefixes may precede a step, in either order:
    //   repeat 3 click 100 200        do it up to three times, stop when it lands
    //   until /Saved/ 15000 key ctrl+s   keep doing it until the window says so
    let repeat = 0;
    let retry = 0;
    let until = null;
    let untilMs = 0;
    // `repeat 3` on its own is a mistake worth naming precisely: without this it
    // would be read as a step whose verb is "repeat".
    if (/^(?:repeat\s+\d+|retry\s+\d+|until\s+(?:\/(?:[^/\\]|\\.)*\/|\S+)(?:\s+\d+)?)\s*$/i.test(raw)) {
      throw new Error(`plan line ${i + 1}: the prefix has no step after it`);
    }
    for (let guard = 0; guard < 4; guard++) {
      const r = /^repeat\s+(\d+)\s+([\s\S]+)$/i.exec(raw);
      if (r) { repeat = Number(r[1]); raw = r[2].trim(); continue; }
      const t = /^retry\s+(\d+)\s+([\s\S]+)$/i.exec(raw);
      if (t) { retry = Number(t[1]); raw = t[2].trim(); continue; }
      const u = /^until\s+(\/(?:[^/\\]|\\.)*\/|\S+)(?:\s+(\d+))?\s+([\s\S]+)$/i.exec(raw);
      if (u) {
        let pat = u[1];
        if (pat.startsWith("/")) pat = pat.slice(1, -1);
        until = pat;
        untilMs = u[2] ? Number(u[2]) : 0;
        raw = u[3].trim();
        continue;
      }
      break;
    }
    if (!raw) throw new Error(`plan line ${i + 1}: the prefix has no step after it`);
    const m = /^([a-zA-Z]+)(\?)?\s*(.*)$/.exec(raw);
    if (!m) throw new Error(`plan line ${i + 1}: cannot parse ${JSON.stringify(raw)}`);
    const op = m[1].toLowerCase();
    const optional = Boolean(m[2]);
    if (!PLAN_OPS.has(op)) throw new Error(`plan line ${i + 1}: unknown step ${JSON.stringify(op)} (allowed: ${[...PLAN_OPS].join(", ")})`);
    if (repeat > 50) throw new Error(`plan line ${i + 1}: repeat ${repeat} is too many (max 50)`);
    if (retry > 20) throw new Error(`plan line ${i + 1}: retry ${retry} is too many (max 20)`);
    const rest = (m[3] || "").trim();
    if (op === "launch" && !rest) throw new Error(`plan line ${i + 1}: launch needs a path: launch PATH [| args]`);
    steps.push({ line: i + 1, op, optional, rest, repeat, retry, until, untilMs });
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
  // Profiles can be inline (cordis.patch.yml) or shipped as JSON files;
  // relative paths resolve against the plugin directory, so an install can
  // just point at \`profiles\` and get the examples that came with the package.
  const profileSpecs = [].concat(cfg.profilesFile || []).map((spec) =>
    path.isAbsolute(String(spec)) ? String(spec) : path.join(ROOT, String(spec))
  );
  const fileProfiles = profileSpecs.length ? readProfileFiles(profileSpecs) : [];
  const profiles = normalizeProfiles(mergeProfileLists(fileProfiles, cfg.profiles));
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

  // A picture without its scale is a trap: 1600-wide image of a 2560-wide screen
  // is 1.6x apart, and the two numbers look equally plausible. Every shot keeps
  // its own map, and click takes image pixels so nobody does the arithmetic.
  function recordShot(meta) {
    try {
      fs.mkdirSync(artifacts, { recursive: true });
      const file = path.join(artifacts, "shots.json");
      let all = [];
      try { all = JSON.parse(fs.readFileSync(file, "utf8")); } catch { all = []; }
      all = [meta].concat(all.filter((m) => m && m.image !== meta.image)).slice(0, 20);
      fs.writeFileSync(file, JSON.stringify(all, null, 2), "utf8");
    } catch { /* a picture without a map is still a picture */ }
  }

  function shotMetaFor(image) {
    const file = path.join(artifacts, "shots.json");
    let all = [];
    try { all = JSON.parse(fs.readFileSync(file, "utf8")); } catch { return null; }
    if (!Array.isArray(all) || !all.length) return null;
    if (!image) return all[0];
    const want = path.resolve(String(image)).toLowerCase();
    return all.find((m) => m && m.image && path.resolve(m.image).toLowerCase() === want) || null;
  }

  // Click a control by what it says, not by where it sits. The accessibility
  // tree supplies the geometry, so the same plan works after a DPI change, a
  // theme change or a window that moved. Invoking the pattern is preferred -
  // it works even when the control is scrolled out of sight - and a real click
  // at the centre is the fallback for controls that only support a physical hit.
  async function clickByName(want, role, index, hwnd) {
    const argv = ["find", "--name", String(want), "--max", "40"];
    if (hwnd) argv.push("--hwnd", hwnd);
    const found = await call(argv);
    let matches = found.matches || [];
    const wantRole = role ? String(role).toLowerCase() : "";
    if (wantRole) matches = matches.filter((m) => String(m.role || "").toLowerCase() === wantRole);
    const pick = matches[Number(index || 0)];
    if (!pick) {
      const seen = (matches.slice(0, 8).map((m) => `${m.role}:${m.name}`).join(" | ")) || "none";
      throw new Error(`no control matches "${want}"${wantRole ? ` with role "${role}"` : ""} in this window; closest: ${seen}`);
    }
    let invokeError = "";
    if (pick.id && pick.role !== "Text") {
      try {
        const inv = await call(["invoke", "--path", pick.id].concat(hwnd ? ["--hwnd", hwnd] : []));
        return { how: "invoke", role: pick.role, name: pick.name, pattern: inv.pattern || "invoke" };
      } catch (e) {
        // ElementNotAvailableException is what a virtualized list says when its
        // element is recycled; the rectangle can still be right.
        invokeError = String((e && e.message) || e).slice(0, 160);
      }
    }
    const r = pick.rect || {};
    if (!r || r.w === undefined) throw new Error(`"${want}" has no on-screen rectangle (it may be virtualized)`);
    const cx = String(Math.round(r.x + r.w / 2));
    const cy = String(Math.round(r.y + r.h / 2));
    const argvClick = ["click", "--x", cx, "--y", cy].concat(hwnd ? ["--hwnd", hwnd] : []);
    await call(argvClick);
    return {
      how: "click", role: pick.role, name: pick.name, x: Number(cx), y: Number(cy),
      ...(invokeError ? { invokeFailed: invokeError } : {})
    };
  }

  // A failed plan leaves a directory behind: the plan as written, the exact
  // transcript, the window's pixels and its control tree. The value is not my
  // debugging - it is that the person who owns the machine can look.
  async function dumpFailure(steps, at, hwnd, lines) {
    const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 23);
    const dir = path.join(artifacts, "failures", stamp);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(
      path.join(dir, "plan.txt"),
      steps.map((s, i) => `${i + 1}${s.optional ? "?" : ""} ${s.op} ${String(s.rest || "").trim()}`.trim()).join("\n"),
      "utf8"
    );
    fs.writeFileSync(path.join(dir, "transcript.txt"), lines.join("\n"), "utf8");
    fs.writeFileSync(
      path.join(dir, "where.json"),
      JSON.stringify({ stoppedAt: at + 1, hwnd: hwnd || null, steps: steps.length, when: new Date().toISOString() }, null, 2),
      "utf8"
    );
    if (hwnd) {
      try { await call(["shot", "--out", path.join(dir, "shot.png"), "--hwnd", hwnd, "--maxw", "1600"]); } catch { /* the window may be gone */ }
      try { fs.writeFileSync(path.join(dir, "tree.json"), JSON.stringify(await call(["tree", "--hwnd", hwnd, "--depth", "6", "--max", "400"]), null, 2), "utf8"); } catch { /* same */ }
    }
    return dir;
  }

  // One implementation for both callers: the `browser` action and the `page`
  // plan step. Keeping them together is what makes a web flow replayable.
  let activeTab = 0;
  // The page socket is reused between calls: Page must stay enabled on the
  // session that answers a dialog, and a dialog outlives the call that opened it.
  const pageSessions = new Map();
  async function pageSession(wsUrl) {
    const hit = pageSessions.get(wsUrl);
    if (hit && !hit.dead) return hit.cdp;
    const cdp = await cdpConnect(wsUrl);
    pageSessions.set(wsUrl, { cdp, dead: false, at: Date.now() });
    await cdp.send("Page.enable", {}).catch(() => null);
    return cdp;
  }
  async function browserCommand(cmdText) {
    const cmd = String(cmdText || "").trim();
    const m = cmd.match(/^([a-z]+)\s*([\s\S]*)$/i);
    if (!m) throw new Error(`browser: cannot read ${JSON.stringify(cmd)}`);
    const op = m[1].toLowerCase();
    const rest = m[2].trim();
    const port = Number(cfg.browserPort) || 9222;
    const bdir = path.join(artifacts, "browser");
    const boot = () => ensureBrowser({
      port, headless: /\bheadless\b/.test(rest), exe: cfg.browserExe,
      // A running instance keeps its profile locked and ignores new flags,
      // so a throwaway headless browser gets a profile of its own per port.
      profileDir: path.join(bdir, /\bheadless\b/.test(rest) ? "profile-" + port : "profile"), artifacts
    });
    if (op === "open") {
      const info = await boot();
      const tabs = await listTabs(info.port);
      return { op, data: clean({
        port: info.port, spawned: info.spawned, browser: info.browser,
        tabs: tabs.map((t) => ({ title: t.title, url: t.url }))
      }) };
    }
    if (op === "tabs") {
      const info = await boot();
      const tabs = await listTabs(info.port);
      return { op, data: clean({ port: info.port, tabs: tabs.map((t, i) => ({ i, title: t.title, url: t.url })) }) };
    }
    if (op === "downloads") {
      const info = await boot();
      const v = await cdpProbe(info.port);
      if (!v || !v.webSocketDebuggerUrl) throw new Error("no browser socket to set downloads on");
      const bcdp = await cdpConnect(v.webSocketDebuggerUrl);
      // The browser-level session stays open on purpose: closing it drops the
      // download rule, and it is what renames guid files back to the names the
      // page suggested.
      const dir = await setDownloads(bcdp, rest || path.join(bdir, "downloads"), info.port);
      return { op, data: { downloads: dir } };
    }
    const info = await boot();
    const tabs = await listTabs(info.port);
    const tabList = async () => (await listTabs(info.port)).map((t, i) => ({ i, title: t.title, url: t.url }));
    if (op === "newtab") {
      const v = await cdpProbe(info.port);
      if (!v || !v.webSocketDebuggerUrl) throw new Error("no browser socket to open a tab on");
      const bcdp = await cdpConnect(v.webSocketDebuggerUrl);
      let targetId = null;
      try {
        targetId = await cdpNewTab(bcdp, rest || "about:blank");
      } finally { bcdp.close(); }
      const list = await tabList();
      // /json/list order is not "the new one is last": find the tab we made.
      const found = list.findIndex((t) => t.id === targetId);
      activeTab = found >= 0 ? found : Math.max(0, list.length - 1);
      return { op, data: { active: activeTab, tabs: list } };
    }
    if (op === "tab") {
      const list = await tabList();
      if (!list.length) throw new Error('the browser has no page yet: browser "goto about:blank" first');
      let idx = -1;
      if (/^\d+$/.test(rest)) idx = Number(rest);
      else {
        const want = rest.toLowerCase();
        idx = list.findIndex((t) => String(t.title).toLowerCase().includes(want) || String(t.url).toLowerCase().includes(want));
      }
      if (idx < 0 || idx >= list.length) {
        throw new Error(`no tab ${JSON.stringify(rest || "?")}: ${list.map((t) => `${t.i}:${t.title}`).join(" | ") || "none"}`);
      }
      activeTab = idx;
      return { op, data: { active: idx, tab: list[idx], tabs: list } };
    }
    if (op === "close") {
      const v = await cdpProbe(info.port);
      if (!v || !v.webSocketDebuggerUrl) throw new Error("no browser socket to close a tab on");
      const list = await tabList();
      const idx = Math.min(activeTab, list.length - 1);
      if (idx < 0) throw new Error('no tab to close: browser "goto about:blank" first');
      const tabId = tabs[idx] && tabs[idx].id;
      const bcdp = await cdpConnect(v.webSocketDebuggerUrl);
      try { await cdpCloseTab(bcdp, tabId); } finally { bcdp.close(); }
      activeTab = 0;
      return { op, data: { closed: list[idx].title, tabs: await tabList() } };
    }
    if (!tabs.length) throw new Error('the browser has no page yet: browser "goto about:blank" first');
    const pick = Math.min(Math.max(activeTab, 0), tabs.length - 1);
    // One session per tab, kept alive between calls: a dialog has to be answered
    // on the same Page-enabled session that watched it open.
    const cdp = await pageSession(tabs[pick].ws);
    {
      if (op === "goto") {
        if (!rest) throw new Error("goto needs a URL");
        const state = await cdpGoto(cdp, rest);
        let title = null, href = null;
        try { title = await cdpEval(cdp, "document.title"); href = await cdpEval(cdp, "location.href"); } catch { /* racing a navigation */ }
        return { op, data: clean({ url: href || rest, state, title }) };
      }
      if (op === "eval") {
        if (!rest) throw new Error("eval needs an expression");
        return { op, data: { value: await cdpEval(cdp, rest) } };
      }
      if (op === "wait") {
        // Waiting for an element beats sleeping a guessed number of seconds.
        const mm = rest.match(/^(.*?)(?:\s+(\d+))?$/);
        const sel = (mm && mm[1] ? mm[1] : rest).trim();
        const waitMs = mm && mm[2] ? Number(mm[2]) : 8000;
        if (!sel) throw new Error("wait needs a CSS selector");
        const started = Date.now();
        let found = false;
        while (Date.now() - started < waitMs) {
          try {
            found = Boolean(await cdpEval(cdp, `!!document.querySelector(${JSON.stringify(sel)})`));
          } catch { /* a navigation in flight is not an answer yet */ }
          if (found) break;
          await new Promise((r) => setTimeout(r, 150));
        }
        if (!found) throw new Error(`no element matches ${sel} within ${waitMs}ms`);
        return { op, data: { selector: sel, waitedMs: Date.now() - started } };
      }
      if (op === "back" || op === "forward" || op === "reload") {
        const got = await cdpHistory(cdp, op);
        return { op, data: clean({ url: got.url, state: got.state, title: got.title }) };
      }
      if (op === "dialog") {
        const bits = rest.split(/\s+/).filter(Boolean);
        const what = (bits.shift() || "").toLowerCase();
        if (what !== "accept" && what !== "dismiss") {
          throw new Error('dialog needs accept or dismiss: browser="dialog accept"');
        }
        const text = bits.join(" ");
        return { op, data: await cdpDialog(cdp, what === "accept", text || undefined) };
      }
      if (op === "click") {
        if (!rest) throw new Error("click needs a CSS selector");
        const box = await clickSelector(cdp, rest);
        return { op, data: { clicked: clean({ selector: rest, tag: box.tag, text: box.text, x: box.x, y: box.y, hit: box.hit }) } };
      }
      if (op === "fill") {
        const i = rest.indexOf("|");
        if (i < 0) throw new Error('fill needs a selector and a value: browser="fill #name | my-bucket"');
        const sel = rest.slice(0, i).trim();
        const val = rest.slice(i + 1).trim();
        return { op, data: { filled: { selector: sel, value: await fillSelector(cdp, sel, val) } } };
      }
      if (op === "text") {
        const t = await cdpText(cdp, rest || null);
        const str = String(t === null || t === undefined ? "" : t);
        return { op, data: { chars: str.length, text: str.slice(0, 6000) } };
      }
      if (op === "shot") {
        const name = rest || ("shot-" + new Date().toISOString().replace(/[:.]/g, "-").slice(0, 23) + ".png");
        const out = path.isAbsolute(name) ? name : path.join(bdir, name.endsWith(".png") ? name : name + ".png");
        const got = await cdpShot(cdp, out);
        return { op, data: { image: got.path, bytes: got.bytes } };
      }
      if (op === "upload") {
        const i = rest.indexOf("|");
        if (i < 0) throw new Error('upload needs a selector and a path: browser="upload input[type=file] | D:\\data\\a.csv"');
        const sel = rest.slice(0, i).trim();
        const file = rest.slice(i + 1).trim();
        return { op, data: { uploaded: { selector: sel, file: await setFileInput(cdp, sel, file) } } };
      }
      throw new Error(`unknown browser command "${op}": open, tabs, tab N, newtab [URL], close, goto, back, forward, reload, eval, wait, dialog, click, fill, text, shot, upload, downloads`);
    }
  }

  // Execute a parsed plan and return a compact transcript: one line per step,
  // plus the reason it stopped. Nothing here screenshots unless the plan says so.
  async function execPlan(steps, opts) {
    const state = { hwnd: opts.hwnd };
    const t0 = Date.now();
    const budget = Number(opts.timeoutMs || 120000);
    const lines = [];
    const tail = (s) => String(s || "").replace(/\s+/g, " ").slice(-180);

    async function windowText(chars) {
      const argv = ["readtext", "--chars", String(chars || 2000)];
      if (state.hwnd) argv.push("--hwnd", state.hwnd);
      try { const r = await call(argv); return String(r.text || ""); } catch { return ""; }
    }

    // One attempt at one step. It returns the line that step deserves in the
    // transcript; throwing means "this attempt did not land", which is exactly
    // what repeat/until retry on.
    async function attempt(s, i, started) {
      if (state.hwnd && INPUT_STEPS.has(s.op)) {
        // Input only reaches the foreground window. The engine refuses to inject
        // anywhere else, so raise the target right before each input step - a
        // no-op when it is already in front. Polite activation first; if
        // Windows' foreground lock refuses it, escalate once to --force.
        try { await call(["focus", "--hwnd", state.hwnd]); }
        catch {
          try { await call(["focus", "--hwnd", state.hwnd, "--force"]); } catch { /* the step below will explain */ }
        }
        // A Chinese IME composes injected ASCII into characters the app never sees
        // as keystrokes, so a plan types nothing but still "succeeds".
        if (opts.autoIme !== false) {
          try { await call(["ime", "--hwnd", state.hwnd, "--disable"]); } catch { /* not fatal */ }
        }
      }
      const hwnd = state.hwnd;
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
          await call(argv);
          return `${i + 1} ${useOcr ? "wait(ocr)" : "wait"} /${pattern}/ ${Date.now() - started}ms`;
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
          return `${i + 1} ${useOcrRead ? "read(ocr)" : "read"} ${r.chars}ch via ${r.strategy || (useOcrRead ? "ocr" : "?")}`;
        }
        case "ocr": {
          const argv = ["ocr", "--psm", String(opts.psm || 6)];
          if (hwnd) argv.push("--hwnd", hwnd);
          if (s.rest) argv.push("--region", s.rest);
          if (opts.lang) argv.push("--lang", opts.lang);
          const r = await call(argv);
          const first = String(r.text || "").replace(/\s+/g, " ").slice(0, 70);
          return `${i + 1} ocr ${r.chars}ch ${r.ms}ms${first ? ` :: ${first}` : ""}`;
        }
        case "focus": {
          if (!hwnd) throw new Error("focus step needs a target window (pass hwnd or title to the tool)");
          await call(["focus", "--hwnd", hwnd]);
          return `${i + 1} focus ok`;
        }
        case "type": {
          if (!s.rest) throw new Error("type step has no text");
          const argv = ["type", "--text", s.rest];
          if (hwnd) argv.push("--hwnd", hwnd);
          if (opts.verify) argv.push("--verify");
          const r = await call(argv);
          // The engine verifies by default now; a type that cannot be read back
          // says so instead of claiming the characters landed.
          const mark = r && r.verified === true ? " verified" : r && r.verified === "unavailable" ? " (unverified: no text channel)" : "";
          return `${i + 1} type ${s.rest.length}ch${mark}`;
        }
        case "key": {
          const argv = ["key", "--combo", s.rest];
          if (hwnd) argv.push("--hwnd", hwnd);
          await call(argv);
          return `${i + 1} key ${s.rest}`;
        }
        case "click":
        case "clickrel": {
          const [xs, ys] = s.rest.split(/\s+/);
          const argv = ["click"];
          if (hwnd) argv.push("--hwnd", hwnd);
          argv.push(s.op === "click" ? "--x" : "--relx", xs, s.op === "click" ? "--y" : "--rely", ys);
          await call(argv);
          return `${i + 1} ${s.op} ${xs},${ys}`;
        }
        case "press": {
          // Click by name instead of by coordinate: a plan that survives a DPI
          // change, a theme change or a window that moved.
          const [nm, role] = splitFirst(s.rest);
          if (!nm) throw new Error("press needs a control name: press Save");
          const got = await clickByName(nm, role || undefined, 0, hwnd);
          return `${i + 1} press "${nm}" via ${got.how}${got.role ? ` (${got.role})` : ""}`;
        }
        case "invoke": {
          const [id, value] = splitFirst(s.rest);
          if (!id) throw new Error("invoke step needs an element id");
          if (!hwnd) throw new Error("invoke step needs a target window (pass hwnd or title)");
          const argv = ["invoke", "--hwnd", hwnd, "--path", id];
          if (value) argv.push("--value", value);
          const r = await call(argv);
          const tag = r && r.pattern === "click-center" ? " (no invoke pattern: clicked the centre)" : "";
          return `${i + 1} invoke ${id} ${(r && r.pattern) || "ok"}${tag}`;
        }
        case "shot": {
          fs.mkdirSync(artifacts, { recursive: true });
          const name = (s.rest || `shot-${stamp()}.png`).replace(/[^\w.-]+/g, "_");
          const out = path.isAbsolute(name) ? name : path.join(artifacts, name.endsWith(".png") ? name : `${name}.png`);
          const argv = ["shot", "--out", out, "--maxw", "1600"];
          if (hwnd) argv.push("--hwnd", hwnd);
          if (opts.minBytes) argv.push("--min-bytes", String(opts.minBytes));
          const r = await call(argv);
          return `${i + 1} shot ${path.basename(out)} ${Math.round((r.bytes || 0) / 1024)}KB`;
        }
        case "launch": {
          const rest = (s.rest || "").trim();
          if (!rest) throw new Error("launch needs a path: launch C:\\Windows\\notepad.exe");
          // `launch C:\Program Files\App\app.exe | --flag value` - the part after |
          // is the command line, so paths with spaces need no quoting rules.
          const bar = rest.indexOf("|");
          let exePath = (bar >= 0 ? rest.slice(0, bar) : rest).trim();
          const exeArgs = bar >= 0 ? rest.slice(bar + 1).trim() : "";
          const quoted = /^"(.*)"$/.exec(exePath) || /^'(.*)'$/.exec(exePath);
          if (quoted) exePath = quoted[1];
          const argvLaunch = ["launch", "--path", exePath];
          if (exeArgs) argvLaunch.push("--args", exeArgs);
          const got = await call(argvLaunch);
          // A fresh window is not the foreground yet, and the plan was written
          // assuming it could talk to it. Adopt the window this pid owns, so
          // `wait`/`read`/`type` after `launch` have somewhere to land. Packaged
          // apps start a launcher that hands the window to another pid, so fall
          // back to matching the process name.
          if (!state.hwnd) {
            if (got.hwnd) state.hwnd = String(got.hwnd);
            const exeName = path.basename(exePath).toLowerCase();
            for (let tries = 0; tries < 10 && !state.hwnd; tries++) {
              const listing = await call(["windows"]);
              const mine = (listing.windows || []).find((w) =>
                w && w.visible !== false &&
                ((got.pid && w.pid === got.pid) || String(w.process || "").toLowerCase() === exeName));
              if (mine) { state.hwnd = String(mine.hwnd); break; }
              await new Promise((r) => setTimeout(r, 250));
            }
            if (state.hwnd) { try { await call(["focus", "--hwnd", state.hwnd]); } catch { /* already in front */ } }
          }
          return `${i + 1} launch ${path.basename(exePath)} pid ${got.pid || "?"}${state.hwnd ? ` hwnd ${state.hwnd}` : " (window not up yet)"}`;
        }
        case "watch": {
          // `watch window-created 8000` - sleep until the engine sees the event.
          // Polling costs a launch plus a text read per try; this costs one call
          // that returns the moment it fires.
          const bits = (s.rest || "").trim().split(/\s+/).filter(Boolean);
          const ev = bits[0] || "window-created";
          const ms = Number(bits[1]) || 8000;
          const argvWatch = ["watch", "--event", ev, "--timeout", String(ms)];
          if (ev === "title" && state.hwnd) argvWatch.push("--hwnd", String(state.hwnd));
          const got = await call(argvWatch);
          if (!got.fired) {
            const seen = (got.appeared || [])
              .map((w) => `${w.title} (${w.process})`)
              .slice(0, 5)
              .join(" | ");
            throw new Error(
              `no ${ev} within ${ms}ms${seen ? `; appeared instead: ${seen}` : "; nothing new appeared"}`
            );
          }
          const win = got.window && got.window.hwnd ? got.window : null;
          if (win && !state.hwnd) state.hwnd = String(win.hwnd);
          return `${i + 1} watch ${ev} ${got.waitedMs}ms${win ? ` "${win.title}"` : ""}`;
        }
        case "page": {
          // `page click #create` - the same browser commands as action=browser,
          // so a web flow can live in a profile and be retried like any step.
          const got = await browserCommand(s.rest);
          const d = got.data || {};
          if (got.op === "goto") return `${i + 1} page goto ${tail(d.url || s.rest)} ${d.state || ""}`.trim();
          if (got.op === "wait") return `${i + 1} page wait ${d.selector} ${d.waitedMs}ms`;
          if (got.op === "click") return `${i + 1} page click ${d.clicked ? d.clicked.tag + " " + (d.clicked.text || d.clicked.selector) : s.rest}`;
          if (got.op === "fill") return `${i + 1} page fill ${d.filled ? d.filled.selector + " = " + tail(d.filled.value) : s.rest}`;
          if (got.op === "text") return `${i + 1} page text ${d.chars}ch`;
          if (got.op === "eval") return `${i + 1} page eval -> ${tail(d.value)}`;
          if (got.op === "shot") return `${i + 1} page shot ${d.image} ${d.bytes}b`;
          if (got.op === "upload") return `${i + 1} page upload ${d.uploaded ? d.uploaded.file : s.rest}`;
          return `${i + 1} page ${got.op}`;
        }
        case "assert": {
          // Same wait as `wait`, but its sentence is a claim about the result.
          // The matched text comes back with the line, so the transcript shows
          // what was actually on screen when the claim held.
          const { pattern, timeout } = parseWait(s.rest);
          const argv = ["waittext", "--regex", pattern, "--timeout", String(timeout || 5000)];
          if (hwnd) argv.push("--hwnd", hwnd);
          await call(argv);
          const shown = await windowText(1200);
          const hit = new RegExp(pattern, "i").exec(shown);
          const around = hit
            ? shown.slice(Math.max(0, hit.index - 24), hit.index + hit[0].length + 24).replace(/\s+/g, " ").trim()
            : "";
          return `${i + 1} assert /${pattern}/ ok${around ? ` :: ${around}` : ""}`;
        }
        case "sleep": {
          const ms = Number(s.rest || 500);
          await new Promise((r) => setTimeout(r, ms));
          return `${i + 1} sleep ${ms}ms`;
        }
        default:
          throw new Error(`unknown step ${s.op}`);
      }
    }

    for (let i = 0; i < steps.length; i++) {
      const s = steps[i];
      const started = Date.now();
      if (Date.now() - t0 > budget) {
        lines.push(`stopped: ${budget}ms budget exceeded before step ${i + 1}`);
        return { ok: false, text: lines.join("\n") };
      }
      const tries = s.until ? 50 : Math.max(1, s.repeat || s.retry || 1);
      const deadline = s.until ? started + (s.untilMs || 20000) : 0;
      let line = "";
      let why = "";
      for (let n = 1; n <= tries; n++) {
        if (Date.now() - t0 > budget) { why = `${budget}ms budget exceeded`; break; }
        try { line = await attempt(s, i, started); }
        catch (e) { why = e && e.message ? e.message : String(e); line = ""; }
        if (!s.until) { if (line) break; continue; }
        // until: the step is a pulse, the window text is the stop condition.
        const txt = await windowText(2000);
        if (new RegExp(s.until, "i").test(txt)) { why = ""; if (!line) line = `${s.op} ok`; break; }
        if (Date.now() >= deadline) {
          why = `text did not match /${s.until}/ within ${Date.now() - started}ms${why ? ` (last error: ${why})` : ""}`;
          line = "";
          break;
        }
        await new Promise((r) => setTimeout(r, 500));
      }
      if (!line) {
        let detail = why || "step did not land";
        if (s.op === "wait" || s.op === "read" || s.op === "assert") detail += ` | last text: "${tail(await windowText(1500))}"`;
        // "wait? /prompt/" - a step marked optional is a probe, not a promise:
        // record it and keep going instead of abandoning the rest of the plan.
        if (s.optional) {
          lines.push(`${i + 1} ${s.op} skipped (optional): ${tail(detail)}`);
          continue;
        }
        // The failure is the evidence: what was known to work, what the screen
        // says right now, and the one action that shows the saved picture.
        const lastOk = lines.length ? lines[lines.length - 1] : "(nothing ran yet)";
        lines.push(`${i + 1} ${s.op} FAILED after ${Date.now() - started}ms: ${detail}`);
        lines.push(`stopped at step ${i + 1} of ${steps.length}; last ok: ${lastOk}`);
        const screen = await windowText(600);
        if (String(screen).trim()) lines.push(`screen: "${tail(screen)}"`);
        const dump = await dumpFailure(steps, i, state.hwnd, lines).catch(() => null);
        if (dump) lines.push(`forensics: ${dump}`);
        lines.push(`next: fix step ${i + 1} and rerun, or action="failures" to list what was saved`);
        return { ok: false, text: lines.join("\n"), dump: dump || undefined };
      }
      lines.push(s.until ? `${i + 1} ${line} until /${s.until}/ ok` : line);
    }
    for (const w of planWarnings(steps)) lines.push(`hint: ${w}`);
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
  /**
   * Turn a plan that just worked into a profile on disk, and hand back the
   * snippet to paste into the plugin config. Re-deriving the same clicks next
   * week is the most expensive thing this tool can do.
   */
  async function saveProfile(spec, plan, prof, target) {
    const raw = String(spec);
    const slash = raw.indexOf("/");
    const id = (slash >= 0 ? raw.slice(0, slash) : raw).trim();
    const task = (slash >= 0 ? raw.slice(slash + 1) : "main").trim() || "main";
    if (!/^[a-z0-9][a-z0-9._-]*$/i.test(id)) throw new Error(`save: bad profile id ${JSON.stringify(id)} (use letters, digits, dot, dash, underscore)`);
    if (!/^[a-z0-9][a-z0-9._-]*$/i.test(task)) throw new Error(`save: bad task name ${JSON.stringify(task)}`);
    let match = prof && prof.match ? { ...prof.match } : null;
    if (!match || !Object.keys(match).length) {
      let win = null;
      if (target) {
        const listing = await call(["windows"]);
        win = (listing.windows || []).find((w) => String(w.hwnd) === String(target));
      } else {
        const info = await call(["info"]);
        win = info.foreground;
      }
      if (!win) throw new Error("save needs a window to describe: pass `hwnd` or run against a profile");
      // process + class survive restarts and retitles; the title does not.
      match = { process: win.process };
      if (win.class) match.class = win.class;
    }
    const dir = path.join(artifacts, "profiles");
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, `${id}.json`);
    let record = { id, match, plans: {} };
    if (fs.existsSync(file)) {
      try { const old = JSON.parse(fs.readFileSync(file, "utf8")); if (old && old.plans) record = { id, match: old.match || match, plans: old.plans }; } catch { /* overwrite a corrupt file */ }
    }
    record.id = id;
    record.match = match;
    record.plans[task] = plan;
    fs.writeFileSync(file, JSON.stringify(record, null, 2) + "\n", "utf8");
    const cond = Object.entries(match).map(([k, v]) => `${k}: ${JSON.stringify(v)}`).join(", ");
    const body = plan.trimEnd().split("\n").map((line) => `        ${line}`).join("\n");
    const snippet = [`  ${id}:`, `    match: { ${cond} }`, "    plans:", `      ${task}: |`, body].join("\n");
    return { id, task, plans: Object.keys(record.plans), path: file, snippet };
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
          "info | windows | screenshot | snapshot | ui | see | find | hit | hover | geom | modals | inputcheck | click | clicknum | move | scroll | drag | type | upload | key | focus | wait | launch | kill | procs | clipboard | invoke | state | ui | readtext | waittext | run | profiles | failures | targets | exec | put | get"
      },
      hwnd: { type: "string", description: "Target window handle (decimal) from `windows`." },
      title: { type: "string", description: "Target window by title substring; resolved to hwnd. Ignored when hwnd is given." },
      x: { type: "integer", description: "Screen X in physical pixels." },
      y: { type: "integer", description: "Screen Y in physical pixels." },
      relx: {
        type: "integer",
        description:
          "Client-area X inside `hwnd`; survives moves and resizes. Title and menu bars sit above it: screenshot, then imgx."
      },
      rely: { type: "integer", description: "Client-area Y inside `hwnd` (see relx)." },
      x1: { type: "integer", description: "drag start X." },
      y1: { type: "integer", description: "drag start Y." },
      x2: { type: "integer", description: "drag end X." },
      y2: { type: "integer", description: "drag end Y." },
      button: { type: "string", enum: ["left", "right", "middle"], description: "Mouse button, default left." },
      count: { type: "integer", description: "Click repeat count, default 1." },
      name: { type: "string", description: "click: a control name or substring (from `find`/`ui`); clicks its centre, or invokes it." },
      goal: { type: "string", description: "see: what you are looking for, recorded with the picture." },
      n: { type: "integer", description: "clicknum: the number printed on the picture by see." },
      browser: { type: "string", description: "browser: open | tabs | tab N | newtab [URL] | close | goto URL | back | forward | reload | eval EXPR | wait SELECTOR [ms] | dialog accept|dismiss | click SELECTOR | fill SELECTOR | TEXT | text [SELECTOR] | shot [name] | upload SELECTOR | PATH | downloads [DIR]" },
      role: { type: "string", description: "click: narrow `name` to one control type, e.g. Button, MenuItem, TabItem." },
      index: { type: "integer", description: "click: which of the name matches to use, default 0 (the first)." },
      imgx: { type: "integer", description: "click: X in the last screenshot's pixels; converted to screen for you." },
      imgy: { type: "integer", description: "click: Y in the same picture." },
      double: { type: "boolean", description: "Convenience for count=2." },
      amount: { type: "integer", description: "Scroll notches, positive up (default 3); negative scrolls down." },
      horizontal: { type: "boolean", description: "Scroll horizontally instead of vertically." },
      ms: { type: "integer", description: "drag duration, wait duration, or hover dwell in milliseconds." },
      text: { type: "string", description: "Text to type, or clipboard payload." },
      combo: { type: "string", description: "Key chord such as \"ctrl+shift+s\"; comma separates consecutive chords." },
      path: { type: "string", description: "launch: executable or document path. upload: the file to put into an open file dialog." },
      args: { type: "string", description: "launch: command line arguments." },
      cwd: { type: "string", description: "launch/exec: working directory." },
      pid: { type: "integer", description: "kill: target process id." },
      elementPath: { type: "string", description: "invoke: element id from snapshot, e.g. \"0.2.1\"." },
      value: { type: "string", description: "invoke: value written through ValuePattern." },
      region: { type: "string", description: "screenshot: crop as \"left,top,right,bottom\" in physical pixels." },
      clientRegion: {
        type: "string",
        description:
          "screenshot: crop inside the window's client area as \"x,y,w,h\" - the DPI arithmetic is done for you."
      },
      maxw: { type: "integer", description: "screenshot: downscale to this width (default 1600, 0 = native)." },
      trim: {
        type: "boolean",
        description:
          "screenshot: crop to the non-background content box, when the subject is a small part of the frame."
      },
      tol: { type: "integer", description: "screenshot trim: per-channel colour tolerance for 'background', default 12." },
      pad: { type: "integer", description: "screenshot trim: pixels of margin kept around the content, default 6." },
      minBytes: {
        type: "integer",
        description:
          "screenshot: refuse a PNG smaller than this many bytes - blank frames compress to a few KB. Use 15000 when the picture is evidence."
      },
      minBrightness: {
        type: "integer",
        description:
          "screenshot: reject frames whose mean luminance is below this (0-255); a sleeping display is dark yet still compresses small. 20 is a safe floor for evidence."
      },
      minStddev: {
        type: "integer",
        description:
          "screenshot: reject frames flatter than this luminance stddev (0 = one flat colour). 6 is a safe floor for evidence."
      },
      wake: {
        type: "integer",
        description:
          "screenshot: retry up to N more times, wiggling the pointer to wake a blanked console."
      },
      lang: { type: "string", description: "ocr/run: tesseract language(s), default \"chi_sim+eng\"." },
      psm: { type: "integer", description: "ocr/run: tesseract page-segmentation mode, default 6 (a uniform block of text)." },
      tesseract: { type: "string", description: "ocr: path to tesseract.exe; defaults to DSH_TESSERACT or \"tesseract\" on PATH." },
      ocr: { type: "boolean", description: "readtext/waittext: read pixels with tesseract when the window exposes no text (Qt canvases, consoles)." },
      interval: { type: "integer", description: "waittext (ocr): milliseconds between OCR reads, default 400." },
      keep: { type: "string", description: "ocr: also write the captured PNG here (relative names land in the artifacts directory)." },
      regex: {
        type: "string",
        description:
          "waittext: regular expression matched against the window text; the action returns as soon as it matches."
      },
      timeout: { type: "integer", description: "waittext/run/watch: give up after this many milliseconds (waittext 8000, watch 10000; run uses the plan budget)." },
      event: { type: "string", description: "watch: window-created (default), window-closed, foreground or title. Returns as soon as it fires, so waiting costs one call instead of a poll loop." },
      save: { type: "string", description: "run: on success write the plan to artifacts/profiles/<id>.json (`<id>` or `<id>/<task>`) and return the YAML snippet for `profiles:`." },
      plan: {
        type: "string",
        description:
          "run: the plan, one step per line: `wait /re/ [ms]`, `read`, `ocr [l,t,r,b]`, `type TEXT`, `key ctrl+s`, `focus`, `press NAME`, `click X Y`, `clickrel X Y`, `invoke ID [value]`, `launch PATH [| args]`, `watch EVENT [ms]`, `page OP …` (goto/click/fill/wait/text/eval/shot/upload), `assert /re/ [ms]`, `shot name.png`, `sleep MS`. End a plan that clicks or types with `assert` or `read`: it turns a wrong click into a failed step. Prefix a step with `retry N` to try it up to N times, or `until /re/ [ms]` to repeat it until the window text matches. Append `?` for optional. Stops at the first failed post-condition; `{{name}}` comes from `vars`."
      },
      vars: { type: "object", description: "run: values for `{{name}}` in the plan (numbers, file names, versions), so one plan serves many inputs." },
      file: { type: "string", description: "run: read the plan from this file instead of `plan`." },
      profile: {
        type: "string",
        description:
          "run/profiles: a configured app profile. With it the plan may come from `task`, `{{alias}}` resolves to its control ids, and `match` finds the window."
      },
      task: {
        type: "string",
        description: "run: name of the plan saved in the profile given by `profile`. Omitted when the profile has exactly one plan."
      },
      window: {
        type: "string",
        description:
          "run: pick the window by a case-insensitive substring of title, process or class."
      },
      dryRun: {
        type: "boolean",
        description:
          "run: parse the plan, resolve the window and apply profile aliases, then report the steps and stop. No input is sent, no plan is saved - use it to lint a plan before spending a real run."
      },
      check: {
        type: "boolean",
        description:
          "profiles: lint them instead of listing: bad `match`, unparsable plans, undefined `{{alias}}`."
      },
      limit: { type: "integer", description: "failures: how many to list, default 10, newest first." },
      target: {
        type: "string",
        description:
          "exec/put/get: a configured remote target (vmware guest or ssh host); call targets to list them."
      },
      command: {
        type: "string",
        description:
          "exec: command to run inside the target; returns the exit code and the tail of stdout."
      },
      local: { type: "string", description: "put: the local file to send. get: the local path to write." },
      remote: { type: "string", description: "put: the remote path to write. get: the remote file to read." },
      maxChars: {
        type: "integer",
        description:
          "exec: cap on returned stdout characters (default 8000, tail kept)."
      },
      chars: { type: "integer", description: "readtext/waittext: maximum characters to read back (default 20000)." },
      verify: {
        type: "boolean",
        description:
          "type: reading the text back is now the default (a 2ms burst lost characters 5 times in 12). This flag stays for compatibility; set noverify on the engine to opt out."
      },
      depth: { type: "integer", description: "snapshot: accessibility tree depth, default 9." },
      max: { type: "integer", description: "snapshot: node budget, default 350." },
      name: { type: "string", description: "find: name/AutomationId substring. procs/kill: process name filter." },
      clipboardCommand: { type: "string", enum: ["get", "set"], description: "clipboard: get or set (default get)." },
      all: { type: "boolean", description: "windows: include hidden/untitled windows." },
      forceFocus: {
        type: "boolean",
        description:
          "focus: allow the last-resort ALT-tap activation when Windows refuses a foreground switch; it can disturb the user, so it is off by default."
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

      // The browser is the other target with names instead of pixels: a selector
      // survives a resize, a scroll and a theme change. It needs no desktop input
      // at all, so it also works while the screen is locked.
      if (action === "browser") {
        if (!args.browser) throw new Error('browser needs a command, e.g. browser="goto https://example.com"');
        const got = await browserCommand(String(args.browser));
        return { text: JSON.stringify(clean({ ok: true, ...got.data })) };
      }
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
          // One engine launch, not two: `info --modals` already returns the
          // dialog list, so the old second spawn for `modals` is gone.
          const info = await call(["info", "--modals"]);
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
          let modalList = info.modals;
          if (!Array.isArray(modalList)) {
            // Older engine without the flag: pay the second launch rather than
            // silently losing the dialog check.
            try {
              const m = await call(["modals"]);
              modalList = m.modals || m.items || [];
            } catch { modalList = []; }
          }
          // Overlay widgets (NVIDIA GeForce Overlay, HUD layers) are visible and
          // disabled but they are not dialogs. Neither is a #32770 window owned
          // by some unrelated resident process (WeGame's `no_active_wnd`, a
          // background installer): only a dialog belonging to the app in front
          // can swallow clicks aimed at that app. Counting every dialog on the
          // desktop produced a permanent warning that was never actionable.
          const frontWin = info.foreground || {};
          const belongsToFront = (d) => {
            if (!d) return false;
            if (d.dialogClass === false) return false;
            if (d.hwnd && frontWin.hwnd && String(d.hwnd) === String(frontWin.hwnd)) return true;
            if (d.pid && frontWin.pid && d.pid === frontWin.pid) return true;
            const owner = d.owner && d.owner.hwnd;
            return !!(owner && frontWin.hwnd && String(owner) === String(frontWin.hwnd));
          };
          dialogs = modalList.filter(belongsToFront).length;
          out.modals = dialogs;
          // `locked` has two witnesses and only one of them is decisive. A
          // different input desktop means nobody can type; LockApp.exe merely
          // being alive means nothing (it is resident on Windows 11 whether or
          // not the workstation is locked), so that case has to say so.
          const lockEvidence = info.locked
            ? (info.inputDesktopName && info.inputDesktopName !== "Default" ? "input-desktop" : "lockapp")
            : null;
          if (lockEvidence) out.lockedEvidence = lockEvidence;
          if (lockEvidence === "input-desktop") hints.push("the input desktop is not Default, so the workstation is locked: input does nothing until it is unlocked");
          else if (lockEvidence === "lockapp") hints.push("LockApp.exe is running, which only means the lock screen is loaded - it is NOT proof that input is blocked: run `inputcheck` (one cursor move) before assuming the screen is locked");
          if (lockEvidence !== "lockapp" && info.privileged === false) hints.push("this process runs at low integrity: input and screen capture will fail");
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
        case "see": {
          // One picture with numbers on it, plus the map from number to control.
          // Canvas apps have no tree to click; a numbered picture is the closest
          // thing to a tree that pixels can give.
          let target = hwnd;
          if (!target && args.window) {
            const { windows } = await call(["windows"]);
            const want = String(args.window).toLowerCase();
            const hit = (windows || []).find((w) =>
              String(w.title || "").toLowerCase().includes(want) ||
              String(w.process || "").toLowerCase().includes(want) ||
              String(w.class || "").toLowerCase().includes(want));
            if (!hit) {
              const names = (windows || []).map((w) => w.process + ":" + w.title).slice(0, 12).join(" | ");
              throw new Error("no open window matches " + JSON.stringify(args.window) + "; open windows: " + names);
            }
            target = String(hit.hwnd);
          }
          if (!target) {
            const info = await call(["info"]);
            if (!info.foreground || !info.foreground.hwnd) throw new Error("no foreground window to see; pass hwnd or window");
            target = String(info.foreground.hwnd);
          }
          const dir = path.join(artifacts, "see");
          const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
          const plain = path.join(dir, stamp + "-plain.png");
          const marked = path.join(dir, stamp + "-numbers.png");
          // The pixels have to be this window, not whatever happens to be in
          // front of it: raise it, and if it still is not in front (a stubborn
          // app refuses foreground), ask it to draw itself instead.
          let shot;
          try { await call(["focus", "--hwnd", target]); } catch { /* keep going */ }
          shot = await call(["shot", "--out", plain, "--hwnd", target, "--maxw", "1600"]);
          if (!shot.foreground || String(shot.foreground.hwnd) !== String(target)) {
            shot = await call(["shot", "--out", plain, "--hwnd", target, "--maxw", "1600", "--printwindow"]);
          }
          const ui = await call(["ui", "--hwnd", target, "--max", "240", "--depth", "8"]);
          const scale = shot.srcW ? shot.w / shot.srcW : 1;
          const roleOk = new Set([
            "Button", "TabItem", "MenuItem", "MenuItem2", "CheckBox", "RadioButton", "ComboBox",
            "Edit", "ListItem", "Hyperlink", "SplitButton", "TreeItem", "DataItem", "Slider", "Spinner"
          ]);
          const seen = new Set();
          const candidates = [];
          for (const item of ui.items || []) {
            const r = item.rect;
            if (!r || !item.name || !roleOk.has(String(item.role))) continue;
            if (item.enabled === false) continue;
            if (r.w < 8 || r.h < 8) continue;
            const key = [item.role, item.name, r.x, r.y, r.w, r.h].join("|");
            if (seen.has(key)) continue;
            seen.add(key);
            candidates.push(item);
          }
          candidates.sort((a, b) => (a.rect.y - b.rect.y) || (a.rect.x - b.rect.x));
          const cap = Math.max(1, Math.min(30, Number(args.max) || 12));
          const picks = candidates.slice(0, cap);
          const marks = [];
          const targets = picks.map((item, i) => {
            const r = item.rect;
            const n = i + 1;
            const mx = Math.max(0, Math.round((r.x - shot.x) * scale));
            const my = Math.max(0, Math.round((r.y - shot.y) * scale));
            const mw = Math.max(2, Math.round(r.w * scale));
            const mh = Math.max(2, Math.round(r.h * scale));
            marks.push([n, mx, my, Math.min(mw, shot.w - mx), Math.min(mh, shot.h - my)].join("|"));
            return { n, id: item.id || null, role: item.role, name: item.name, rect: r };
          });
          let image = plain;
          if (targets.length) {
            try {
              const m = await call(["mark", "--in", plain, "--out", marked, "--marks", marks.join(";")]);
              image = m.path || marked;
            } catch {
              image = plain; // the picture is still useful without the badges
            }
          }
          fs.mkdirSync(dir, { recursive: true });
          fs.writeFileSync(path.join(dir, "last.json"), JSON.stringify({
            hwnd: target, image, scale, goal: args.goal || null, targets, when: new Date().toISOString()
          }, null, 2), "utf8");
          // The same picture must also work with click imgx/imgy, so keep its own
          // screen-per-pixel factor (note: `see`'s `scale` is the inverse).
          recordShot({
            image,
            hwnd: target,
            x: Number(shot.x || 0),
            y: Number(shot.y || 0),
            w: Number(shot.w || 0),
            h: Number(shot.h || 0),
            srcW: Number(shot.srcW || shot.w || 0),
            srcH: Number(shot.srcH || shot.h || 0),
            scale: shot.w ? Number((shot.srcW || shot.w) / shot.w) : 1,
            when: new Date().toISOString()
          });
          const out = {
            ok: true,
            image,
            window: shot.foreground || null,
            count: targets.length,
            targets: targets.map((t) => ({ n: t.n, role: t.role, name: t.name })),
            hint: targets.length
              ? "open the image, then clicknum N to click what number N points at"
              : "this window exposes no named controls: the picture is the map - use click with relx/rely, or readtext first"
          };
          if (args.goal) out.goal = String(args.goal);
          return { text: JSON.stringify(clean(out)) };
        }

        case "run": {
          let src = args.plan || "";
          let target = hwnd;
          let prof = null;
          let profileMissing = null;
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
                const msg = `profile "${prof.id}" matches no open window (match: ${JSON.stringify(prof.match)}); open windows: ${open}`;
                // A dry run is how you check a recipe before starting the app,
                // so "not open yet" is an answer, not a failure. A plan that
                // launches the app itself has the same right: the launch step
                // adopts the window, so requiring one now would be circular.
                const startsApp = /(^|\n)\s*(?:retry\s+\d+\s+|until\s+\S+(?:\s+\d+)?\s+)?launch\b/i.test(String(src));
                if (!args.dryRun && !startsApp) throw new Error(msg);
                profileMissing = msg;
              } else {
                target = String(hit.hwnd);
              }
            }
          }
          if (!src && args.file) {
            if (!fs.existsSync(String(args.file))) throw new Error(`plan file not found: ${args.file}`);
            src = fs.readFileSync(String(args.file), "utf8");
          }
          // `window` is the middle ground between "here is a hwnd" and "write a
          // profile": a fuzzy name (title/process/class substring) is enough.
          let windowListing = null;
          if (!target && args.window) {
            const listing = await call(["windows"]);
            windowListing = listing;
            const want = String(args.window).toLowerCase();
            const hit = (listing.windows || []).find((w) =>
              String(w.title || "").toLowerCase().includes(want) ||
              String(w.process || "").toLowerCase().includes(want) ||
              String(w.class || "").toLowerCase().includes(want));
            if (!hit) {
              const open = (listing.windows || []).map((w) => `${w.process}:${w.title}`).slice(0, 12).join(" | ");
              throw new Error(`no open window matches ${JSON.stringify(args.window)}; open windows: ${open}`);
            }
            target = String(hit.hwnd);
          }
          if (!src) throw new Error("run needs `plan` (inline text), `file` (path), or `profile` + `task`");
          let steps = parsePlan(src);
          // Numbers, file names, versions: the same plan should serve every case
          // without editing the text. Profile aliases and caller vars are one
          // table; the caller wins on a clash.
          const table = { ...(prof ? prof.aliases : {}), ...(args.vars || {}) };
          if (Object.keys(table).length) steps = applyAliasesToSteps(steps, table);
          // A dry run answers "what would this do" without touching the desktop:
          // syntax, aliases and window resolution get checked for free.
          if (args.dryRun) {
            // Reuse the listing that resolved the window when there was one:
            // a dry run should cost the same single call it always claimed.
            const listing = windowListing || (target ? await call(["windows"]) : { windows: [] });
            const win = (listing.windows || []).find((w) => String(w.hwnd) === String(target));
            return {
              text: JSON.stringify({
                ok: true,
                dryRun: true,
                target: win || null,
                steps: steps.map((s) => ({ line: s.line, op: s.op, optional: s.optional, rest: String(s.rest || "").slice(0, 120) })),
                warnings: [...(profileMissing ? [profileMissing] : []), ...planWarnings(steps)]
              })
            };
          }
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
          // A plan that just worked is knowledge: keep it as data instead of
          // re-deriving it next time (that is the whole point of profiles).
          if (args.save) {
            // A profile is only worth keeping if it actually finished: a plan
            // that stopped at step 2 would just teach the next run to fail faster.
            if (!res.ok) throw new Error(`not saved: the plan stopped early, so it is not a working recipe yet\n${res.text}`);
            const saved = await saveProfile(args.save, src, prof, target);
            return { text: `${res.text}\nsaved profile "${saved.id}" (${saved.plans.join(", ")}) -> ${saved.path}\npaste this under \`profiles:\` in cordis.patch.yml:\n${saved.snippet}` };
          }
          return { text: res.text };
        }
        case "failures": {
          // Forensics only pay off if you can find them again.
          const root = path.join(artifacts, "failures");
          let names = [];
          try {
            names = fs.readdirSync(root)
              .filter((d) => { try { return fs.statSync(path.join(root, d)).isDirectory(); } catch { return false; } })
              .sort()
              .reverse();
          } catch { /* none yet */ }
          const limit = Number(args.limit || 10);
          const items = names.slice(0, limit).map((d) => {
            const dir = path.join(root, d);
            let stopped = "";
            let plan = "";
            try {
              const t = fs.readFileSync(path.join(dir, "transcript.txt"), "utf8").trim().split("\n");
              stopped = String(t[t.length - 2] || "").slice(0, 200);
            } catch { /* partial dump */ }
            try { plan = fs.readFileSync(path.join(dir, "plan.txt"), "utf8").split("\n")[0] || ""; } catch { /* same */ }
            return { dir, firstStep: plan, stopped };
          });
          return { text: JSON.stringify({ ok: true, count: names.length, failures: items }) };
        }
        case "profiles": {
          const described = describeProfiles(profiles);
          if (!args.check) return { text: JSON.stringify({ ok: true, count: profiles.length, profiles: described }) };
          // Lint the shipped/edited profiles: a typo should fail here, not in the
          // middle of a plan on a live desktop.
          const report = profiles.map((p) => {
            const problems = [];
            const callerVars = [];
            for (const key of Object.keys(p.match || {})) {
              if (!["hwnd", "process", "class", "title"].includes(key)) problems.push(`match has unknown key ${JSON.stringify(key)}`);
            }
            if (!Object.keys(p.match || {}).length) problems.push("match is empty: this profile can never match a window");
            const planNames = Object.keys(p.plans || {});
            if (!planNames.length) problems.push("no plans");
            for (const name of planNames) {
              const body = p.plans[name];
              try {
                parsePlan(body);
              } catch (err) {
                problems.push(`plan "${name}": ${err.message}`);
                continue;
              }
              for (const used of new Set((String(body || "").match(/\{\{([a-zA-Z0-9_.-]+)\}\}/g) || []).map((m) => m.slice(2, -2)))) {
                // A placeholder may come from the profile's aliases or from the
                // caller's run {vars}. Only the former is knowable here; the rest
                // are reported as callerVars so they are visible, not fatal.
                if (used in (p.aliases || {})) continue;
                callerVars.push(used);
              }
            }
            return {
              id: p.id,
              ok: problems.length === 0,
              plans: planNames,
              ...(callerVars.length ? { callerVars: [...new Set(callerVars)] } : {}),
              problems
            };
          });
          return {
            text: JSON.stringify({
              ok: report.every((r) => r.ok),
              checked: report.length,
              failing: report.filter((r) => !r.ok).length,
              profiles: report
            })
          };
        }
        case "screenshot": {
          fs.mkdirSync(artifacts, { recursive: true });
          const out = path.join(artifacts, `shot-${stamp()}.png`);
          argv.push("shot", "--out", out);
          if (hwnd) push("hwnd", hwnd);
          push("region", args.region);
          if (args.clientRegion) {
            // Screenshots are physical pixels; a caller looking at a window knows
            // only its client area. Convert here so no one has to multiply by DPI.
            const bits = String(args.clientRegion).split(",").map((n) => Number(n.trim()));
            if (bits.length !== 4 || bits.some((n) => !Number.isFinite(n))) {
              throw new Error('clientRegion needs "x,y,w,h" in client pixels, e.g. "0,0,800,600"');
            }
            if (!hwnd) throw new Error("clientRegion needs a target window: pass hwnd or title");
            const g = await call(["geom", "--hwnd", String(hwnd)]);
            const ox = Number((g.clientOrigin && g.clientOrigin.x) || 0);
            const oy = Number((g.clientOrigin && g.clientOrigin.y) || 0);
            const [cx, cy, cw, ch] = bits;
            argv.push("--region", [ox + cx, oy + cy, ox + cx + cw, oy + cy + ch].join(","));
          }
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
          recordShot({
            image: data.path || out,
            hwnd: hwnd || null,
            x: Number(data.x || 0),
            y: Number(data.y || 0),
            w: Number(data.w || 0),
            h: Number(data.h || 0),
            srcW: Number(data.srcW || data.w || 0),
            srcH: Number(data.srcH || data.h || 0),
            scale,
            when: new Date().toISOString()
          });
          return {
            text: JSON.stringify(clean({
              ...data,
              scale,
              hint: "Open this PNG with your vision tool. To click a point you see in it: click { imgx: px, imgy: py } - no arithmetic."
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
        case "watch": {
          argv.push("watch");
          push("event", args.event || "window-created");
          push("timeout", args.timeout === undefined ? undefined : String(args.timeout));
          if (hwnd) push("hwnd", hwnd);
          push("pid", args.pid);
          return { text: JSON.stringify(clean(await call(argv))) };
        }
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
          {
            const data = clean(await call(argv));
            if (!String(data.text || "").trim()) {
              // Custom-drawn apps (Eclipse's editors, WPS documents, canvases) expose
              // no text to UIA. Say so in the result, not only in the docs.
              data.hint =
                "this window exposes no text: readtext {ocr:true} reads the pixels, or press ctrl+a / ctrl+c and take it with clipboard";
            }
            return { text: JSON.stringify(data) };
          }
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
        case "clicknum": {
          const side = path.join(artifacts, "see", "last.json");
          if (!fs.existsSync(side)) throw new Error('no numbered picture yet: run action "see" first');
          const last = JSON.parse(fs.readFileSync(side, "utf8"));
          const want = Number(args.n);
          if (!Number.isFinite(want)) throw new Error("clicknum needs a number: n is what the picture printed");
          const hit = (last.targets || []).find((t) => Number(t.n) === want);
          if (!hit) {
            const all = (last.targets || []).map((t) => `${t.n}:${t.role}:${t.name}`).join(", ") || "none";
            throw new Error(`the picture numbered ${all} - there is no ${want}; take a fresh one with see`);
          }
          await call(["focus", "--hwnd", String(last.hwnd)]).catch(() => null);
          let how = "point";
          if (hit.id) {
            try {
              await call(["invoke", "--path", String(hit.id), "--hwnd", String(last.hwnd)]);
              how = "invoke";
            } catch {
              how = "point";
            }
          }
          if (how === "point") {
            const cx = Math.round(hit.rect.x + hit.rect.w / 2);
            const cy = Math.round(hit.rect.y + hit.rect.h / 2);
            await call(["click", "--x", String(cx), "--y", String(cy), "--hwnd", String(last.hwnd)]);
          }
          return { text: JSON.stringify({ ok: true, clicked: { n: hit.n, role: hit.role, name: hit.name }, how, image: last.image }) };
        }
        case "click": {
          // Point at a control, not at a pixel: the coordinates are derived at
          // click time from what the accessibility tree says is there.
          if (args.imgx !== undefined || args.imgy !== undefined) {
            if (args.imgx === undefined || args.imgy === undefined) {
              throw new Error("click needs both imgx and imgy: picture pixels from a screenshot");
            }
            const meta = shotMetaFor(null);
            if (!meta) {
              throw new Error("no picture on record yet: take one with action \"screenshot\" first");
            }
            const sc = Number(meta.scale || 1);
            const sx = Math.round(Number(meta.x || 0) + Number(args.imgx) * sc);
            const sy = Math.round(Number(meta.y || 0) + Number(args.imgy) * sc);
            const argvImg = ["click", "--x", String(sx), "--y", String(sy)];
            const imgHwnd = hwnd || (meta.hwnd ? String(meta.hwnd) : "");
            if (imgHwnd) argvImg.push("--hwnd", imgHwnd);
            if (args.button) argvImg.push("--button", String(args.button));
            if (args.count !== undefined) argvImg.push("--count", String(args.count));
            await call(argvImg);
            return {
              text: JSON.stringify({
                ok: true, x: sx, y: sy,
                from: { image: meta.image, imgx: args.imgx, imgy: args.imgy, scale: sc }
              })
            };
          }
          if (args.name) {
            const got = await clickByName(args.name, args.role, args.index, hwnd);
            return { text: JSON.stringify({ ok: true, ...got }) };
          }
          argv.push("click"); if (hwnd) push("hwnd", hwnd); push("x", args.x); push("y", args.y);
          push("relx", args.relx); push("rely", args.rely);
          push("button", args.button); push("count", args.count); flag("double", args.double);
          break;
        }
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
        case "upload": {
          // The browser's file picker is a plain Win32 dialog: focus it, clear the
          // name box, type the path, press Enter. That turns "upload a file" into
          // one call instead of a scavenger hunt through the desktop.
          if (!args.path) throw new Error("upload requires `path`");
          const target = path.resolve(String(args.path));
          if (!fs.existsSync(target)) throw new Error(`upload: no such file ${target}`);
          const info = await call(["info"]);
          const frontPid = info.foreground && info.foreground.pid;
          const listing = await call(["modals"]);
          const listed = listing.modals || listing.items || [];
          const boxes = listed.filter((d) => d && /#32770/.test(String(d.class || "")));
          if (!boxes.length) {
            const seen = listed.map((d) => d.title).join(" | ") || "none";
            throw new Error(`upload: no file dialog is open; open one first (dialogs: ${seen})`);
          }
          // A background app can own an enabled #32770 too (wegame's "no_active_wnd"),
          // and typing into that one goes nowhere. Prefer the foreground app's dialog.
          const usable = boxes.filter((d) =>
            d.visible !== false && d.enabled !== false && !/^no_active_wnd$/i.test(String(d.title || ""))
          );
          if (!usable.length) {
            const seen = boxes.map((d) => `${d.title} (${d.process})`).join(" | ");
            throw new Error(`upload: only background dialogs are open: ${seen} - open the file picker in the app you mean`);
          }
          const rank = (d) =>
            (frontPid && d.pid === frontPid ? 4 : 0) +
            (/打开|Open|选择|Select|上传|Upload|保存|Save/i.test(String(d.title || "")) ? 2 : 0) +
            (d.dialogClass === true ? 1 : 0);
          usable.sort((a, b) => rank(b) - rank(a));
          const dlg = usable[0];
          const dlgHwnd = String(dlg.hwnd);
          await call(["focus", "--hwnd", dlgHwnd]);
          if (cfg.autoIme !== false) {
            try { await call(["ime", "--hwnd", dlgHwnd, "--disable"]); } catch { /* not fatal */ }
          }
          try { await call(["key", "--combo", "ctrl+a", "--hwnd", dlgHwnd]); } catch { /* some dialogs ignore it */ }
          await call(["type", "--text", target, "--hwnd", dlgHwnd]);
          await call(["key", "--combo", "return", "--hwnd", dlgHwnd]);
          const waitClosed = async (rounds) => {
            for (let i = 0; i < rounds; i++) {
              await new Promise((r) => setTimeout(r, 150));
              const again = await call(["modals"]).catch(() => null);
              const still = again ? (again.modals || again.items || []) : [];
              if (!still.some((d) => String(d.hwnd) === dlgHwnd)) return true;
            }
            return false;
          };
          let closed = await waitClosed(20);
          if (!closed) {
            // Some Open dialogs ignore the first Enter while the name box is still
            // composing: one more commit, then give up and say what to do.
            await call(["key", "--combo", "return", "--hwnd", dlgHwnd]).catch(() => {});
            closed = await waitClosed(12);
          }
          return {
            text: JSON.stringify({
              ok: true, dialog: dlg.title, dialogPid: dlg.pid, file: target, closed,
              hint: closed ? undefined : "the dialog is still open: click its file-name box first, then upload again"
            })
          };
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
          const got = await call(argv);
          // The engine falls back to clicking an element's centre when it has no
          // UIA pattern. That is a real fallback, not an Invoke: say so out loud.
          if (got && got.pattern === "click-center") {
            return {
              text: JSON.stringify(clean({
                ...got,
                degraded: "click-center",
                why: "the element has no invoke/toggle/select/setvalue pattern, so its centre was clicked - verify the effect instead of trusting the return"
              }))
            };
          }
          return { text: JSON.stringify(clean(got)) };
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
