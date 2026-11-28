// A browser the model can actually talk to: Chrome DevTools Protocol over the
// WebSocket built into Node. No Playwright, no npm install - one process, one
// socket, and the same "no dependencies" rule as the rest of the plugin.
//
// The point is not "drive a browser instead of the desktop". It is that a web
// console has a DOM, and a DOM has names. `click button[data-testid=create]`
// survives a resize, a theme change and a scroll; `click 1840 612` does not.
import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";

const EDGE = [
  "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
  "C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe"
];
const CHROME = [
  "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
  "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe"
];

export function findBrowser(exe) {
  if (exe) return fs.existsSync(exe) ? exe : null;
  for (const p of EDGE.concat(CHROME)) if (fs.existsSync(p)) return p;
  return null;
}

async function getJson(url, timeoutMs = 2000) {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    const res = await fetch(url, { signal: ctl.signal });
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  } finally {
    clearTimeout(t);
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Is something already listening on this debugging port? */
export async function probe(port) {
  const v = await getJson(`http://127.0.0.1:${port}/json/version`, 1200);
  return v && v.webSocketDebuggerUrl ? v : null;
}

/**
 * Make sure a debuggable browser exists. Attaching to the person's own window is
 * not possible without the flag (Chromium refuses), so the honest options are
 * "reuse the one we started earlier" or "start one with its own profile, which
 * keeps its cookies between runs".
 */
export async function ensureBrowser(opts = {}) {
  const port = Number(opts.port) || 9222;
  const existing = await probe(port);
  if (existing) {
    return { port, spawned: false, browser: existing.Browser || "chromium", version: existing["Browser"] || null };
  }
  const exe = findBrowser(opts.exe);
  if (!exe) throw new Error("no Edge or Chrome found; pass exe in the plugin config or install one");
  const profileDir = opts.profileDir || path.join(opts.artifacts || process.cwd(), "browser-profile");
  fs.mkdirSync(profileDir, { recursive: true });
  const args = [
    `--remote-debugging-port=${port}`,
    `--user-data-dir=${profileDir}`,
    "--no-first-run",
    "--no-default-browser-check",
    "--disable-features=Translate",
    "--disable-background-networking"
  ];
  if (opts.headless) args.push("--headless=new", "--disable-gpu", "--window-size=1280,900");
  else args.push("--start-maximized");
  const child = spawn(exe, args, { detached: true, stdio: "ignore", windowsHide: false });
  child.unref();
  for (let i = 0; i < 50; i++) {
    await sleep(200);
    const v = await probe(port);
    if (v) return { port, exe, spawned: true, pid: child.pid, browser: v.Browser || "chromium", version: v.Browser || null };
  }
  throw new Error(`the browser did not open a debugging port at ${port}; start it yourself with --remote-debugging-port=${port}`);
}

export async function listTabs(port) {
  const list = await getJson(`http://127.0.0.1:${port}/json/list`, 2000);
  if (!Array.isArray(list)) throw new Error(`no debugging endpoint at 127.0.0.1:${port} - run browser "open" first`);
  return list.filter((t) => t.type === "page" && t.webSocketDebuggerUrl).map((t) => ({
    id: t.id, title: t.title, url: t.url, ws: t.webSocketDebuggerUrl
  }));
}

/**
 * Minimal CDP connection. One socket, one page; requests carry an id and either
 * resolve or reject, events go to whoever subscribed.
 */
export function connect(wsUrl, timeoutMs = 8000) {
  return new Promise((resolve, reject) => {
    let ws;
    try { ws = new WebSocket(wsUrl); } catch (e) { reject(new Error(`cannot open a CDP socket: ${e.message}`)); return; }
    const pending = new Map();
    const listeners = new Set();
    let nextId = 0;
    let settled = false;
    const timer = setTimeout(() => { if (!settled) { settled = true; try { ws.close(); } catch {} reject(new Error("CDP connection timed out")); } }, timeoutMs);

    const api = {
      send(method, params = {}) {
        const id = ++nextId;
        return new Promise((res, rej) => {
          pending.set(id, { res, rej });
          try { ws.send(JSON.stringify({ id, method, params })); }
          catch (e) { pending.delete(id); rej(new Error(`CDP send failed: ${e.message}`)); }
        });
      },
      on(fn) { listeners.add(fn); return () => listeners.delete(fn); },
      waitFor(method, ms = 10000) {
        return new Promise((res, rej) => {
          const t = setTimeout(() => { off(); rej(new Error(`no ${method} within ${ms}ms`)); }, ms);
          const off = api.on((msg) => { if (msg.method === method) { clearTimeout(t); off(); res(msg.params); } });
        });
      },
      close() { try { ws.close(); } catch { /* already gone */ } }
    };

    ws.addEventListener("open", () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(api);
    });
    ws.addEventListener("error", () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(new Error("the CDP socket refused to open (is the browser still running?)"));
    });
    ws.addEventListener("close", () => {
      for (const [, p] of pending) p.rej(new Error("the browser closed the CDP socket"));
      pending.clear();
    });
    ws.addEventListener("message", (ev) => {
      let msg;
      try { msg = JSON.parse(typeof ev.data === "string" ? ev.data : String(ev.data)); } catch { return; }
      if (msg.id && pending.has(msg.id)) {
        const p = pending.get(msg.id);
        pending.delete(msg.id);
        if (msg.error) p.rej(new Error(msg.error.message || "CDP error"));
        else p.res(msg.result);
        return;
      }
      if (msg.method) for (const fn of listeners) { try { fn(msg); } catch { /* a listener must not kill the socket */ } }
    });
  });
}

/** Run an expression in the page and bring back a JSON-safe value. */
export async function evaluate(cdp, expression) {
  const r = await cdp.send("Runtime.evaluate", {
    expression,
    returnByValue: true,
    awaitPromise: true,
    userGesture: true
  });
  if (r.exceptionDetails) {
    const d = r.exceptionDetails;
    const text = (d.exception && (d.exception.description || d.exception.value)) || d.text || "evaluation failed";
    throw new Error(String(text).split("\n")[0].slice(0, 300));
  }
  const v = r.result || {};
  return v.value;
}

export async function waitReady(cdp, ms = 15000) {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    try {
      const state = await evaluate(cdp, "document.readyState");
      if (state === "complete" || state === "interactive") return state;
    } catch { /* navigating */ }
    await sleep(150);
  }
  return "timeout";
}

export async function navigate(cdp, url, ms = 20000) {
  await cdp.send("Page.enable").catch(() => {});
  await cdp.send("Page.navigate", { url });
  const state = await waitReady(cdp, ms);
  // A new document forgets the page-level download rule, so set it again here.
  await pageDownloads(cdp);
  return state;
}

export async function textOf(cdp, selector) {
  if (!selector) return evaluate(cdp, "document.body ? document.body.innerText : ''");
  const sel = JSON.stringify(selector);
  return evaluate(cdp, `(() => { const e = document.querySelector(${sel}); return e ? (e.innerText || e.value || "") : null; })()`);
}

/** Real mouse events at the element's centre: a JS .click() lies to some apps. */
export async function clickSelector(cdp, selector) {
  const sel = JSON.stringify(selector);
  const box = await evaluate(cdp, `(() => {
    const e = document.querySelector(${sel});
    if (!e) return null;
    e.scrollIntoView({ block: "center", inline: "center" });
    const r = e.getBoundingClientRect();
    if (!r.width || !r.height) return { hidden: true, tag: e.tagName };
    return { x: r.left + r.width / 2, y: r.top + r.height / 2, tag: e.tagName, text: (e.innerText || "").slice(0, 40) };
  })()`);
  if (!box) throw new Error(`no element matches ${selector}`);
  if (box.hidden) throw new Error(`the element matches ${selector} but has no box on screen`);
  const hit = await evaluate(cdp, `(() => { const e = document.elementFromPoint(${box.x}, ${box.y}); return e ? (e.id || e.tagName) : null; })()`);
  for (const type of ["mousePressed", "mouseReleased"]) {
    await cdp.send("Input.dispatchMouseEvent", {
      type, x: box.x, y: box.y, button: "left", clickCount: 1, buttons: type === "mousePressed" ? 1 : 0
    });
  }
  return { ...box, hit };
}

/**
 * Fill a field the way a person would: focus, set the value through the native
 * setter (React and Vue listen to that one, not to el.value = x), then tell them
 * it changed.
 */
export async function fillSelector(cdp, selector, text) {
  const sel = JSON.stringify(selector);
  const val = JSON.stringify(String(text));
  const got = await evaluate(cdp, `(() => {
    const e = document.querySelector(${sel});
    if (!e) return null;
    e.focus();
    const proto = e instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype
      : (e instanceof HTMLInputElement ? HTMLInputElement.prototype : null);
    const desc = proto && Object.getOwnPropertyDescriptor(proto, "value");
    if (desc && desc.set) desc.set.call(e, ${val}); else e.value = ${val};
    e.dispatchEvent(new Event("input", { bubbles: true }));
    e.dispatchEvent(new Event("change", { bubbles: true }));
    return e.value;
  })()`);
  if (got === null) throw new Error(`no element matches ${selector}`);
  return got;
}

export async function screenshot(cdp, out) {
  const r = await cdp.send("Page.captureScreenshot", { format: "png" });
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, Buffer.from(r.data, "base64"));
  return { path: out, bytes: fs.statSync(out).size };
}

/** Hand a file to a real <input type=file>, no dialog involved. */
export async function setFileInput(cdp, selector, file) {
  const target = path.resolve(file);
  if (!fs.existsSync(target)) throw new Error(`no such file ${target}`);
  await cdp.send("DOM.enable").catch(() => {});
  const { root } = await cdp.send("DOM.getDocument", { depth: 1 });
  const { nodeId } = await cdp.send("DOM.querySelector", { nodeId: root.nodeId, selector });
  if (!nodeId) throw new Error(`no element matches ${selector}`);
  await cdp.send("DOM.setFileInputFiles", { nodeId, files: [target] });
  return target;
}

/** Downloads go where we say, instead of somewhere in a profile nobody reads. */
let downloadDir = null;

// The rule lives as long as the browser-level CDP session that made it. Closing
// that session silently restores "save to the user's Downloads", so it is kept
// open for the life of this process and doubles as the download event listener.
let downloadSession = null;
const downloadNames = new Map(); // guid -> suggested filename

function keepDownloads(browserCdp) {
  downloadSession = browserCdp;
  browserCdp.on((msg) => {
    if (msg.method === "Browser.downloadWillBegin") {
      downloadNames.set(msg.params.guid, msg.params.suggestedFilename || msg.params.guid);
      return;
    }
    if (msg.method !== "Browser.downloadProgress") return;
    const { guid, state } = msg.params;
    if (state !== "completed") return;
    const name = downloadNames.get(guid) || guid;
    downloadNames.delete(guid);
    const from = path.join(downloadDir, guid);
    const to = path.join(downloadDir, name);
    if (!downloadDir) return;
    // allowAndName stores the file under its guid; the person wants the name
    // the page suggested. Retry briefly: the progress event can precede the
    // final write by a few milliseconds.
    let tries = 0;
    const settle = () => {
      try { fs.renameSync(from, to); }
      catch (e) {
        if (tries++ < 20) setTimeout(settle, 100);
      }
    };
    settle();
  });
}

async function pageDownloads(cdp) {
  // Deliberately empty. On Edge 158 a page-level "allow" overrides the
  // browser-level rule with "save to the user's Downloads", so the only
  // setting we make is the browser-wide allowAndName in setDownloads().
  return cdp;
}

/** Kept for callers that want to know whether downloads are configured. */
export async function applyDownloads(cdp) {
  await pageDownloads(cdp);
  return downloadDir;
}

export async function setDownloads(browserCdp, dir, port) {
  const target = path.resolve(dir);
  fs.mkdirSync(target, { recursive: true });
  downloadDir = target;
  // "allow" is silently ignored on this build (Edge 158 writes to the user's
  // Downloads anyway); "allowAndName" is honoured and names files by guid, so
  // keepDownloads() renames them to the suggested name on completion.
  keepDownloads(browserCdp);
  await browserCdp.send("Browser.setDownloadBehavior", { behavior: "allowAndName", downloadPath: target, eventsEnabled: true });
  if (port) {
    for (const tab of await listTabs(port).catch(() => [])) {
      const cdp = await connect(tab.ws).catch(() => null);
      if (!cdp) continue;
      await pageDownloads(cdp);
      cdp.close();
    }
  }
  return target;
}
