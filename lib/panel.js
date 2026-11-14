/**
 * A small control panel for the `computer` tool: the same engine, driven from a
 * browser page instead of a model turn.
 *
 * Why a panel and not a live mirror: the expensive part of GUI automation is
 * *looking* (a screenshot plus a vision call costs thousands of tokens), so the
 * panel shows the screen only when you ask for it, and answers the cheap
 * questions - can I act, which controls exist, what is under this pixel - from
 * the same `state`/`ui`/`hit` calls the model already uses. A human can then
 * point at a control once and get a stable selector to hand back to the model.
 *
 * Two mounts, one handler:
 *   - `startPanel()` puts it on loopback with a random token, for a plain
 *     browser window;
 *   - `createPanelHandler()` is what the plugin mounts on DSH's own web server
 *     (`ctx.webServer`), where the DSH session cookie is the authentication and
 *     the client tab just frames it same-origin.
 * Both share the same whitelist: the page cannot run arbitrary engine commands.
 */
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import crypto from "node:crypto";
import { panelHtml } from "./panel-html.js";

/** Actions the page is allowed to trigger; everything else is observe-only. */
const PANEL_ACTIONS = new Set(["click", "invoke", "type", "key", "focus", "scroll", "hover"]);

function json(res, code, body) {
  const text = typeof body === "string" ? body : JSON.stringify(body);
  res.writeHead(code, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store"
  });
  res.end(text);
}

function readBody(req, limit = 64 * 1024) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on("data", (c) => {
      size += c.length;
      if (size > limit) {
        reject(new Error("request body too large"));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on("end", () => {
      const raw = Buffer.concat(chunks).toString("utf8");
      if (!raw) return resolve({});
      try {
        resolve(JSON.parse(raw));
      } catch (e) {
        reject(new Error(`body is not JSON: ${e.message}`));
      }
    });
    req.on("error", reject);
  });
}

/**
 * Build the request handler without opening a socket.
 *
 * @param {object} opts
 * @param {(args: object) => Promise<any>} opts.exec - runs one tool action (the
 *   plugin's own executor, so panel actions get the same guards as model actions)
 * @param {string} [opts.artifactsDir] - only files inside it may be served
 * @param {(line: string) => void} [opts.log]
 * @param {string} [opts.token] - when set, every request must carry it
 * @param {string} [opts.prefix] - mount prefix, e.g. "/computer-use/panel";
 *   the page is served with that prefix baked in so its fetches stay same-origin
 */
export function createPanelHandler(opts) {
  const exec = opts.exec;
  if (typeof exec !== "function") throw new TypeError("createPanelHandler needs an exec function");
  const token = opts.token || null;
  const prefix = (opts.prefix || "").replace(/\/+$/, "");
  const artifacts = opts.artifactsDir ? path.resolve(opts.artifactsDir) : null;
  const history = [];
  const log = (line) => {
    const entry = `${new Date().toISOString().slice(11, 19)} ${line}`;
    history.push(entry);
    if (history.length > 200) history.shift();
    if (opts.log) opts.log(entry);
  };

  const authorized = (req, url) => {
    if (!token) return true;
    const headerToken = req.headers && req.headers["x-panel-token"];
    const queryToken = url.searchParams.get("t");
    return headerToken === token || queryToken === token;
  };

  const handler = async (req, res) => {
    let url;
    try {
      url = new URL(req.url || "/", "http://panel.local");
    } catch {
      return json(res, 400, { ok: false, error: "bad url" });
    }
    if (!authorized(req, url)) return json(res, 401, { ok: false, error: "missing or wrong token" });

    let pathname = url.pathname;
    if (prefix) {
      if (pathname === prefix) pathname = "/";
      else if (pathname.startsWith(prefix + "/")) pathname = pathname.slice(prefix.length);
      else return json(res, 404, { ok: false, error: `the panel is mounted at ${prefix}` });
    }

    try {
      if (req.method === "GET" && (pathname === "/" || pathname === "/index.html")) {
        res.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
        return res.end(panelHtml().replace("%BASE%", prefix));
      }

      if (req.method === "GET" && pathname === "/api/log") {
        return json(res, 200, { ok: true, lines: history.slice(-80) });
      }

      if (req.method === "GET" && pathname === "/api/state") {
        const state = await exec({ action: "state" });
        log("state");
        return json(res, 200, state);
      }

      if (req.method === "GET" && pathname === "/api/windows") {
        const wins = await exec({ action: "windows" });
        return json(res, 200, wins);
      }

      if (req.method === "GET" && pathname === "/api/ui") {
        const hwnd = url.searchParams.get("hwnd") || undefined;
        const ui = await exec({ action: "ui", hwnd, max: Number(url.searchParams.get("max") || 60) });
        log(`ui ${hwnd || ""} ${ui.count} items`);
        return json(res, 200, ui);
      }

      if (req.method === "GET" && pathname === "/api/shot") {
        const hwnd = url.searchParams.get("hwnd") || undefined;
        const shot = await exec({
          action: "screenshot",
          hwnd,
          maxw: Number(url.searchParams.get("maxw") || 1400)
        });
        log(`shot ${shot.w}x${shot.h} ${shot.bytes || "?"}b`);
        return json(res, 200, shot);
      }

      if (req.method === "GET" && pathname === "/api/png") {
        const wanted = url.searchParams.get("p") || "";
        if (!artifacts) return json(res, 404, { ok: false, error: "no artifacts directory" });
        const resolved = path.resolve(wanted);
        if (!resolved.startsWith(artifacts + path.sep) || !fs.existsSync(resolved)) {
          return json(res, 404, { ok: false, error: "not an artifact this panel may serve" });
        }
        res.writeHead(200, { "content-type": "image/png", "cache-control": "no-store" });
        return fs.createReadStream(resolved).pipe(res);
      }

      if (req.method === "POST" && pathname === "/api/hit") {
        const body = await readBody(req);
        const hit = await exec({ action: "hit", x: Number(body.x), y: Number(body.y) });
        return json(res, 200, hit);
      }

      if (req.method === "POST" && pathname === "/api/act") {
        const body = await readBody(req);
        const action = String(body.action || "");
        if (!PANEL_ACTIONS.has(action)) {
          return json(res, 403, { ok: false, error: `the panel may not run "${action}" (allowed: ${[...PANEL_ACTIONS].join(", ")})` });
        }
        const args = { ...body, action };
        delete args.t;
        const out = await exec(args);
        log(`act ${action} ${args.hwnd || ""} ${args.text ? JSON.stringify(String(args.text).slice(0, 24)) : ""}`.trim());
        return json(res, 200, out);
      }

      return json(res, 404, { ok: false, error: `no route for ${req.method} ${pathname}` });
    } catch (err) {
      const message = String((err && err.message) || err);
      log(`ERROR ${message.slice(0, 160)}`);
      return json(res, 500, { ok: false, error: message });
    }
  };

  return { handler, history, log };
}

/**
 * Start the panel on loopback.
 *
 * @param {object} opts - same as createPanelHandler, plus:
 * @param {number} [opts.port] - 0 picks a free port
 * @param {string} [opts.host] - default 127.0.0.1
 * @returns {Promise<{url: string, port: number, token: string, close: () => Promise<void>}>}
 */
export async function startPanel(opts) {
  const host = opts.host || "127.0.0.1";
  const token = opts.token || crypto.randomBytes(16).toString("hex");
  const { handler } = createPanelHandler({ ...opts, token, prefix: "" });
  const server = http.createServer((req, res) => {
    handler(req, res);
  });

  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(opts.port === undefined ? 0 : opts.port, host, resolve);
  });
  const port = server.address().port;
  return {
    url: `http://${host}:${port}/?t=${token}`,
    port,
    token,
    close: () =>
      new Promise((resolve) => {
        server.closeAllConnections?.();
        server.close(() => resolve());
      })
  };
}
