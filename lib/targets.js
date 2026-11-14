// Target adapters: run a command on ANOTHER machine (a VMware guest, or any
// host that speaks ssh) and bring back text.
//
// Why this exists: the expensive part of computer use is look-then-act over
// pixels. When the box being driven has a real command line behind a
// programmatic channel, one `exec` call replaces dozens of screenshots. The
// VMware adapter uses vmrun (VMware Tools), the ssh adapter uses the system
// ssh client. Both are optional: with no `targets` configured the tool simply
// reports that none exist.
//
// No third-party imports on purpose: a `link:`-installed plugin has no
// node_modules of its own.

import { spawn } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/** Default cap on returned stdout; keeps a runaway command from eating context. */
export const DEFAULT_MAX_CHARS = 8000;

export function clip(text, max) {
  const s = String(text == null ? "" : text);
  return s.length <= max ? s : s.slice(0, max) + `…(+${s.length - max} chars)`;
}

/** Keep the END of the output: that is where the error and the new prompt are. */
export function tailClip(text, max) {
  const s = String(text == null ? "" : text);
  if (s.length <= max) return { text: s, truncated: false, chars: s.length };
  return { text: `…(+${s.length - max} chars)\n` + s.slice(-max), truncated: true, chars: s.length };
}

export function shellQuote(value) {
  return "'" + String(value).replace(/'/g, "'\\''") + "'";
}

/**
 * Spawn argv and collect output. `binary` keeps Buffers (scp-style file gets),
 * `stdin` feeds a Buffer/string (ssh `cat > file`). A timeout kills the child;
 * a killed child reports code -1 and timedOut true.
 */
export function runProcess(argv, opts = {}) {
  const timeoutMs = Number(opts.timeoutMs || 60000);
  return new Promise((resolve) => {
    let settled = false;
    const t0 = Date.now();
    const done = (r) => { if (!settled) { settled = true; resolve(r); } };
    let child;
    try {
      child = spawn(argv[0], argv.slice(1), {
        windowsHide: true,
        stdio: [opts.stdin === undefined ? "ignore" : "pipe", "pipe", "pipe"]
      });
    } catch (err) {
      done({ code: -1, out: opts.binary ? Buffer.alloc(0) : "", err: String((err && err.message) || err), timedOut: false, ms: 0 });
      return;
    }
    const outChunks = [];
    const errChunks = [];
    const timer = setTimeout(() => { try { child.kill(); } catch { /* already gone */ } }, timeoutMs);
    child.stdout.on("data", (c) => outChunks.push(Buffer.isBuffer(c) ? c : Buffer.from(String(c))));
    child.stderr.on("data", (c) => errChunks.push(Buffer.isBuffer(c) ? c : Buffer.from(String(c))));
    if (opts.stdin !== undefined) {
      try { child.stdin.end(opts.stdin); } catch { /* the process may have exited */ }
    }
    child.on("error", (err) => {
      clearTimeout(timer);
      done({ code: -1, out: opts.binary ? Buffer.alloc(0) : "", err: String((err && err.message) || err), timedOut: false, ms: Date.now() - t0 });
    });
    child.on("close", (code, signal) => {
      clearTimeout(timer);
      const buf = Buffer.concat(outChunks);
      const errBuf = Buffer.concat(errChunks);
      done({
        code: signal ? -1 : code,
        out: opts.binary ? buf : buf.toString("utf8"),
        err: errBuf.toString("utf8"),
        timedOut: Boolean(signal) && signal === "SIGTERM",
        ms: Date.now() - t0
      });
    });
  });
}

/** vmrun argv prefix: type, guest credentials (host-side copyFile* ignores them). */
export function vmrunArgv(target, rest) {
  const argv = [target.vmrun || "vmrun", "-T", "ws"];
  if (target.user) argv.push("-gu", target.user);
  if (target.password) argv.push("-gp", target.password);
  return argv.concat(rest);
}

/** ssh argv for one remote command; the command is quoted exactly once. */
export function sshArgv(target, remoteCommand) {
  const argv = [
    target.ssh || "ssh",
    "-o", "BatchMode=yes",
    "-o", "StrictHostKeyChecking=accept-new",
    "-o", `ConnectTimeout=${target.connectTimeoutSeconds || 10}`
  ];
  if (target.port) argv.push("-p", String(target.port));
  if (target.key) argv.push("-i", target.key);
  for (const option of target.sshOptions || []) argv.push("-o", option);
  argv.push(target.user ? `${target.user}@${target.host}` : target.host);
  argv.push("--", remoteCommand);
  return argv;
}

/** Cheap description of the configured targets - no spawn, no probe. */
export function listTargets(cfg) {
  const map = (cfg && cfg.targets) || {};
  return Object.entries(map).map(([name, target]) => {
    const out = { name, type: target.type };
    if (target.type === "vmware") out.detail = path.basename(String(target.vmx || ""));
    else out.detail = `${target.user ? target.user + "@" : ""}${target.host || ""}`;
    if (target.type === "ssh" && target.key) out.key = path.basename(String(target.key));
    return out;
  });
}

export function resolveTarget(cfg, name) {
  const map = (cfg && cfg.targets) || {};
  const target = map[name];
  if (!target) {
    const names = Object.keys(map);
    throw new Error(names.length
      ? `unknown target ${JSON.stringify(name)}; configured targets: ${names.join(", ")}`
      : "no targets are configured - add a `targets` map to the plugin config (see README, action=targets)");
  }
  if (!target.type) throw new Error(`target ${JSON.stringify(name)} has no type; use "vmware" or "ssh"`);
  if (target.type === "vmware" && !target.vmx) throw new Error(`target ${JSON.stringify(name)} needs a vmx path`);
  if (target.type === "ssh" && !target.host) throw new Error(`target ${JSON.stringify(name)} needs a host`);
  if (!["vmware", "ssh"].includes(target.type)) {
    throw new Error(`target ${JSON.stringify(name)} has unsupported type ${JSON.stringify(target.type)}; use "vmware" or "ssh"`);
  }
  return target;
}

async function vmwareExec(target, o, runner, workdir) {
  const id = crypto.randomBytes(4).toString("hex");
  const hostScript = path.join(workdir, `dsh-${id}.sh`);
  const hostOut = path.join(workdir, `dsh-${id}.out`);
  const hostRc = path.join(workdir, `dsh-${id}.rc`);
  const guestScript = `/tmp/dsh-${id}.sh`;
  const guestOut = `/tmp/dsh-${id}.out`;
  const guestRc = `/tmp/dsh-${id}.rc`;
  const body = (o.cwd ? `cd ${shellQuote(o.cwd)} || exit 97\n` : "") + o.command + "\n";
  try {
    fs.writeFileSync(hostScript, body, "utf8");
    const copyIn = await runner(vmrunArgv(target, ["copyFileFromHostToGuest", target.vmx, hostScript, guestScript]), { timeoutMs: 60000 });
    if (copyIn.code !== 0) throw new Error(`vmrun copyFileFromHostToGuest failed: ${clip(copyIn.err || copyIn.out, 400).trim()}`);
    const wrapper = `bash ${shellQuote(guestScript)} > ${shellQuote(guestOut)} 2>&1; echo $? > ${shellQuote(guestRc)}`;
    const runArgv = vmrunArgv(target, [
      ...(target.interactive ? ["-interactive"] : []),
      "runProgramInGuest", target.vmx, "/bin/bash", "-c", wrapper
    ]);
    const runRes = await runner(runArgv, { timeoutMs: o.timeoutMs });
    if (runRes.code !== 0) throw new Error(`vmrun runProgramInGuest failed: ${clip(runRes.err || runRes.out, 400).trim()}`);
    const outCopy = await runner(vmrunArgv(target, ["copyFileFromGuestToHost", target.vmx, guestOut, hostOut]), { timeoutMs: 60000 });
    const rcCopy = await runner(vmrunArgv(target, ["copyFileFromGuestToHost", target.vmx, guestRc, hostRc]), { timeoutMs: 60000 });
    const stdout = outCopy.code === 0 && fs.existsSync(hostOut) ? fs.readFileSync(hostOut, "utf8") : "";
    const rcText = rcCopy.code === 0 && fs.existsSync(hostRc) ? fs.readFileSync(hostRc, "utf8").trim() : "";
    return {
      stdout,
      stderr: "",
      exitCode: rcText === "" ? null : Number(rcText),
      ms: runRes.ms,
      note: rcText === "" ? "the guest wrote no exit code (see stdout)" : runRes.timedOut ? "timed out" : undefined
    };
  } finally {
    for (const file of [hostScript, hostOut, hostRc]) {
      try { fs.unlinkSync(file); } catch { /* best effort */ }
    }
  }
}

async function sshExec(target, o, runner) {
  const inner = o.cwd ? `cd ${shellQuote(o.cwd)} && ${o.command}` : o.command;
  const res = await runner(sshArgv(target, `bash -lc ${shellQuote(inner)}`), { timeoutMs: o.timeoutMs });
  return {
    stdout: res.out,
    stderr: res.err,
    exitCode: res.code,
    ms: res.ms,
    note: res.timedOut ? "timed out" : undefined
  };
}

/**
 * The tool-facing facade. `runner` is injectable so the adapters can be tested
 * without a VM (see test/targets.mjs).
 */
export function makeTargetClient(options = {}) {
  const cfg = options.cfg || {};
  const runner = options.runProcess || runProcess;
  const workdir = options.workdir || os.tmpdir();
  const log = options.log || (() => {});

  async function exec(name, opts = {}) {
    const target = resolveTarget(cfg, name);
    const command = String(opts.command || "");
    if (!command.trim()) throw new Error("exec requires a non-empty `command`");
    const o = { command, cwd: opts.cwd, timeoutMs: Number(opts.timeoutMs || target.timeoutMs || 120000) };
    log("exec", name, command.slice(0, 120));
    const raw = target.type === "vmware"
      ? await vmwareExec(target, o, runner, workdir)
      : await sshExec(target, o, runner);
    const capped = tailClip(raw.stdout, Number(opts.maxChars || DEFAULT_MAX_CHARS));
    const out = {
      ok: raw.exitCode === 0,
      target: name,
      type: target.type,
      exitCode: raw.exitCode,
      ms: raw.ms,
      stdout: capped.text
    };
    if (capped.truncated) out.stdoutChars = capped.chars;
    const err = String(raw.stderr || "").trim();
    if (err) out.stderr = tailClip(err, 2000).text;
    if (raw.note) out.note = raw.note;
    return out;
  }

  async function put(name, opts = {}) {
    const target = resolveTarget(cfg, name);
    const local = String(opts.local || "");
    const remote = String(opts.remote || "");
    if (!local || !remote) throw new Error("put requires `local` and `remote`");
    if (!fs.existsSync(local)) throw new Error(`put: local file not found: ${local}`);
    log("put", name, local, "->", remote);
    if (target.type === "vmware") {
      const res = await runner(vmrunArgv(target, ["copyFileFromHostToGuest", target.vmx, local, remote]), { timeoutMs: 120000 });
      if (res.code !== 0) throw new Error(`put failed: ${clip(res.err || res.out, 400).trim()}`);
      return { ok: true, target: name, direction: "put", remote, bytes: fs.statSync(local).size };
    }
    const buf = fs.readFileSync(local);
    const res = await runner(sshArgv(target, `cat > ${shellQuote(remote)}`), { timeoutMs: 120000, stdin: buf });
    if (res.code !== 0) throw new Error(`put failed (${res.code}): ${clip(res.err, 400).trim()}`);
    return { ok: true, target: name, direction: "put", remote, bytes: buf.length };
  }

  async function get(name, opts = {}) {
    const target = resolveTarget(cfg, name);
    const remote = String(opts.remote || "");
    const local = String(opts.local || "");
    if (!local || !remote) throw new Error("get requires `remote` and `local`");
    log("get", name, remote, "->", local);
    fs.mkdirSync(path.dirname(local), { recursive: true });
    if (target.type === "vmware") {
      const res = await runner(vmrunArgv(target, ["copyFileFromGuestToHost", target.vmx, remote, local]), { timeoutMs: 120000 });
      if (res.code !== 0) throw new Error(`get failed: ${clip(res.err || res.out, 400).trim()}`);
      return { ok: true, target: name, direction: "get", remote, bytes: fs.existsSync(local) ? fs.statSync(local).size : 0 };
    }
    const res = await runner(sshArgv(target, `cat ${shellQuote(remote)}`), { timeoutMs: 120000, binary: true });
    if (res.code !== 0) throw new Error(`get failed (${res.code}): ${clip(res.err, 400).trim()}`);
    fs.writeFileSync(local, res.out);
    return { ok: true, target: name, direction: "get", remote, bytes: res.out.length };
  }

  return { list: () => listTargets(cfg), exec, put, get };
}
