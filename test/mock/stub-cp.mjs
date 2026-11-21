// Fake `spawn`: records argv, emits a canned JSON line, never starts a process.
import { EventEmitter } from "node:events";

export const state = {
  foreground: {
    hwnd: 656368, title: "DeepSeek Harness", class: "Chrome_WidgetWin_1",
    process: "chrome.exe", pid: 32992, visible: true, foreground: true,
    rect: { x: 318, y: 149, w: 1923, h: 1234 }
  },
  monitors: [{ index: 0, x: 0, y: 0, w: 2560, h: 1600, workX: 0, workY: 0, workW: 2560, workH: 1528, dpi: 144, scale: 1.5, primary: true }],
  windows: [
    { hwnd: 656368, title: "DeepSeek Harness", class: "Chrome_WidgetWin_1", process: "chrome.exe", pid: 32992, visible: true, foreground: true, rect: { x: 318, y: 149, w: 1923, h: 1234 } },
    { hwnd: 999001, title: "Untitled - Notepad", class: "Notepad", process: "notepad.exe", pid: 4242, visible: true, foreground: false, rect: { x: 40, y: 40, w: 900, h: 700 } }
  ],
  modals: null,
  // Tests say what a `watch` call should see: fired (default) or a timeout.
  watch: null,
  // Tests say what `ui` exposes when the default two controls are not enough.
  ui: null,
  failNext: null,
  typeVerify: null,
  // Tests flip this to simulate a locked workstation without touching anything else.
  infoOverride: null
};

export const calls = [];

// One overlay widget (not a dialog) plus a dialog owned by some other process:
// neither blocks the foreground app, so a good session bootstrap counts zero.
// Tests swap this list to simulate a dialog that really is in the way.
const DEFAULT_MODALS = [
  { hwnd: 7002, title: "NVIDIA GeForce Overlay DT", class: "CEF-OSC-WIDGET", pid: 9001, process: "NVIDIA Overlay.exe", dialogClass: false, visible: true },
  { hwnd: 7001, title: "no_active_wnd", class: "#32770", pid: 4242, process: "wegame.exe", dialogClass: true, visible: true, enabled: true }
];

function opt(argv) {
  const out = {};
  for (let i = 1; i < argv.length; i++) {
    const k = argv[i];
    if (typeof k === "string" && k.startsWith("--")) {
      const next = argv[i + 1];
      if (next === undefined || (typeof next === "string" && next.startsWith("--"))) out[k.slice(2)] = true;
      else { out[k.slice(2)] = next; i++; }
    }
  }
  return out;
}

function payload(cmd, o) {
  switch (cmd) {
    case "info": {
      const base = {
        ok: true, screenW: 2560, screenH: 1600, virtualX: 0, virtualY: 0,
        cursor: { x: 800, y: 600 }, monitors: state.monitors, foreground: state.foreground,
        locked: false, lockAppRunning: false, inputDesktopName: "Default",
        privileged: true, uiRestrictions: 0,
        ...(state.infoOverride || {})
      };
      // `info --modals` mirrors the engine: the dialog list rides along so the
      // session bootstrap costs one process launch instead of two.
      if (o.modals) {
        const list = state.modals || DEFAULT_MODALS;
        base.modals = list;
        base.modalCount = list.length;
      }
      return base;
    }
    case "ui": {
      const items = state.ui || [
        { id: "0.1.0", role: "Button", name: "Save", rect: { x: 10, y: 20, w: 80, h: 24 } },
        { id: "0.1.1", role: "Edit", name: "Name", value: "hello", rect: { x: 10, y: 60, w: 200, h: 24 } }
      ];
      return { ok: true, count: items.length, scanned: 9, truncated: false, root: state.foreground, items };
    }
    case "mark":
      // The engine draws; the stub only has to prove what it was asked to draw.
      return { ok: true, path: o.out, marks: String(o.marks || "").split(";").filter(Boolean).length, w: 1600, h: 1000, bytes: 23456 };
    case "watch": {
      // The real engine hooks a win event; here the script says what happens,
      // so a test can ask for "it fired" and "it timed out" without a desktop.
      const plan = state.watch || {};
      const want = o.event || "window-created";
      if (plan.event && plan.event !== want) return { ok: true, fired: false, event: want, waitedMs: 5, window: null, appeared: [] };
      if (plan.fired === false) {
        return { ok: true, fired: false, event: want, waitedMs: plan.waitedMs || 120, window: null, appeared: plan.appeared || [] };
      }
      return {
        ok: true, fired: true, event: want, waitedMs: plan.waitedMs || 42,
        window: plan.window || { hwnd: 777001, title: "Fresh Window", class: "Notepad", process: "notepad.exe", pid: 4243, visible: true, rect: { x: 10, y: 10, w: 400, h: 300 } },
        appeared: []
      };
    }
    case "modals":
      // One real dialog plus one overlay widget: only the dialog counts.
      return {
        ok: true,
        count: (state.modals || DEFAULT_MODALS).length,
        modals: state.modals || DEFAULT_MODALS
      };
    case "geom": {
      const w = state.windows.find((x) => String(x.hwnd) === String(o.hwnd)) || state.foreground;
      return {
        ok: true, hwnd: w.hwnd, title: w.title, class: w.class, pid: w.pid,
        rect: w.rect,
        client: { x: 0, y: 0, w: w.rect.w, h: w.rect.h - 39 },
        clientOrigin: { x: w.rect.x, y: w.rect.y + 39 },
        dpi: 144, scale: 1.5, maximized: false, minimized: false, monitors: state.monitors
      };
    }
    case "windows":
      return { ok: true, count: state.windows.length, foreground: state.foreground, windows: state.windows };
    case "launch":
      return { ok: true, path: o.path, pid: 4242, hwnd: 999001, title: "Untitled - Notepad" };
    case "ocr":
      return {
        ok: true, text: "RA# show ip route", chars: 18, ms: 7,
        region: { x: 0, y: 0, w: 800, h: 600 },
        lang: o.lang || "chi_sim+eng", psm: Number(o.psm || 6)
      };
    case "ime":
      return { ok: true, action: "ime", layout: "en-US" };
    case "shot": {
      // A shot of a named window reports that window as the foreground: that is
      // what tells `see` the pixels really are the target's.
      const fg = o.hwnd
        ? (state.windows.find((w) => String(w.hwnd) === String(o.hwnd)) || state.foreground)
        : state.foreground;
      return {
        ok: true, path: o.out, x: 0, y: 0,
        mean: o["min-brightness"] ? 180 : 16, contrast: 24,
        bytes: o["min-bytes"] ? 480426 : 3120,
        w: Number(o.maxw || 1600), h: Math.round(Number(o.maxw || 1600) * 1600 / 2560),
        srcW: 2560, srcH: 1600,
        ...(o.trim ? { trim: { x: 12, y: 30, w: 400, h: 120 } } : {}),
        cursor: { x: 800, y: 600 }, foreground: fg
      };
    }
    case "readtext":
      return {
        ok: true, hwnd: Number(o.hwnd), title: state.foreground.title,
        chars: 12, strategy: "uia", sources: [{ source: "uia", role: "Edit", via: "text", chars: 12 }],
        text: "hello world\n"
      };
    case "waitocr":
      return {
        ok: true, matched: true, strategy: "ocr", waitedMs: 980, tries: 2,
        chars: 42, regex: o.regex || ".*", text: "RA# show ip route\nO 192.168.1.0/24"
      };
    case "waittext": {
      // A wait that always matches makes every timeout path untestable.
      // The words the happy-path tests wait for, on one screen: a stub that
      // only knows "never-there" cannot tell success from failure.
      const screen = "RA# show ip route\nok Saved hello world";
      const pattern = String(o.regex || ".*");
      let hit = true;
      try { hit = new RegExp(pattern, "i").test(screen); } catch { hit = true; }
      if (!hit) {
        return {
          ok: false, matched: false, waitedMs: 42, hwnd: Number(o.hwnd), strategy: "uia", chars: 12, text: "RA#",
          error: `text did not match /${pattern}/ within ${Number(o.timeout || 8000)}ms in window ${o.hwnd}`
        };
      }
      return { ok: true, matched: true, waitedMs: 42, hwnd: Number(o.hwnd), strategy: "uia", chars: 12, text: screen };
    }
    case "type":
      if (!o.verify) return { ok: true, action: "type", chars: 7 };
      if (state.typeVerify === "mismatch") {
        return {
          ok: false,
          error: "typed text did not show up in the window (strategy uia, 30 chars read). The app may have swallowed the keystrokes - IME composition, a secure field, or lost focus. Wanted the last part: \"x\"; read back: \"nothing\""
        };
      }
      if (state.typeVerify === "ok") return { ok: true, action: "type", chars: 7, verified: true, strategy: "uia" };
      return { ok: true, action: "type", chars: 7, verified: "unavailable", strategy: "none" };
    case "tree":
      return { ok: true, nodes: [{ id: "0", name: "Window", type: "Window", hwnd: Number(o.hwnd) }, { id: "0.1.2", name: "Save", type: "Button", rect: { x: 10, y: 20, w: 80, h: 24 } }] };
    case "find": {
      // A finder that answers every query cannot tell "Save" from "Nonexistent".
      const want = String(o.name || "").toLowerCase();
      const all = [{ id: "0.1.2", role: "Button", name: "Save", automationId: "save", rect: { x: 10, y: 20, w: 80, h: 24 } }];
      const matches = want ? all.filter((m) => m.name.toLowerCase().includes(want)) : all;
      return { ok: true, count: matches.length, matches };
    }
    case "procs":
      return { ok: true, count: 2, processes: [{ pid: 4242, name: "notepad.exe" }, { pid: 32992, name: "chrome.exe" }] };
    case "focus":
      return { ok: true, window: state.windows.find((w) => String(w.hwnd) === String(o.hwnd)) || null };
    case "hit":
      return { ok: true, x: Number(o.x), y: Number(o.y), window: state.foreground };
    case "clip":
      return { ok: true, text: "clipboard contents" };
    default:
      return { ok: true };
  }
}

export function spawn(engine, argv, opts) {
  calls.push({ engine, argv: [...argv], opts });
  const cmd = argv[0];
  const child = new EventEmitter();
  const stream = () => {
    const s = new EventEmitter();
    s.setEncoding = () => s;
    return s;
  };
  child.stdout = stream();
  child.stderr = stream();
  child.kill = () => {};
  queueMicrotask(() => {
    if (state.failNext === cmd) {
      state.failNext = null;
      child.stderr.emit("data", "boom: simulated engine failure\n");
      child.emit("close", 1);
      return;
    }
    const data = payload(cmd, opt(argv));
    if (data.ok === false) {
      child.stdout.emit("data", JSON.stringify(data) + "\n");
    } else {
      child.stdout.emit("data", JSON.stringify(data) + "\n");
    }
    child.emit("close", 0);
  });
  return child;
}

export default { spawn };
