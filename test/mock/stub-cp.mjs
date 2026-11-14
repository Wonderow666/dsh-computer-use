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
  failNext: null,
  typeVerify: null
};

export const calls = [];

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
    case "info":
      return { ok: true, screenW: 2560, screenH: 1600, virtualX: 0, virtualY: 0, cursor: { x: 800, y: 600 }, monitors: state.monitors, foreground: state.foreground };
    case "windows":
      return { ok: true, count: state.windows.length, foreground: state.foreground, windows: state.windows };
    case "shot":
      return {
        ok: true, path: o.out, x: 0, y: 0,
        bytes: o["min-bytes"] ? 480426 : 3120,
        w: Number(o.maxw || 1600), h: Math.round(Number(o.maxw || 1600) * 1600 / 2560),
        srcW: 2560, srcH: 1600,
        ...(o.trim ? { trim: { x: 12, y: 30, w: 400, h: 120 } } : {}),
        cursor: { x: 800, y: 600 }, foreground: state.foreground
      };
    case "readtext":
      return {
        ok: true, hwnd: Number(o.hwnd), title: state.foreground.title,
        chars: 12, strategy: "uia", sources: [{ source: "uia", role: "Edit", via: "text", chars: 12 }],
        text: "hello world\n"
      };
    case "waittext":
      return {
        ok: true, matched: true, waitedMs: 42, hwnd: Number(o.hwnd), strategy: "uia", chars: 12, text: "RA#"
      };
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
    case "find":
      return { ok: true, matches: [{ id: "0.1.2", name: "Save", type: "Button" }] };
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
