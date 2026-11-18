// Unit checks for the remote-target adapters (lib/targets.js).
//
// No VM and no ssh host are involved: a fake runner records the argv that would
// have been spawned and fakes the two guest-side file copies, so the whole
// adapter path - command wrapping, exit-code plumbing, truncation, binary
// file transfer - is exercised without a network.
//
//   node test/targets.mjs
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  makeTargetClient,
  listTargets,
  resolveTarget,
  sshArgv,
  vmrunArgv,
  shellQuote,
  tailClip,
  targetShell,
  DEFAULT_MAX_CHARS
} from "../lib/targets.js";
import { loadTool } from "./_harness.mjs";

const results = [];
function check(name, cond, detail) {
  results.push({ name, ok: Boolean(cond), detail });
  console.log(`${cond ? "ok  " : "FAIL"} ${name}${detail ? ` — ${detail}` : ""}`);
  if (!cond) process.exitCode = 1;
}

const work = fs.mkdtempSync(path.join(os.tmpdir(), "dsh-targets-"));

// A runner that behaves like vmrun for the three subcommands we use:
// copyFileFromHostToGuest (host -> guest) and copyFileFromGuestToHost
// (guest -> host) move real bytes inside the temp dir, so the adapter's own
// read-back logic runs for real.
function fakeVmrun(calls, guestFiles) {
  return async (argv) => {
    calls.push(argv);
    const sub = argv.find((a) => /^(copyFileFromHostToGuest|copyFileFromGuestToHost|runProgramInGuest)$/.test(a));
    if (sub === "copyFileFromHostToGuest") {
      const [, , hostPath, guestPath] = argv.slice(argv.indexOf(sub));
      guestFiles.set(guestPath, fs.readFileSync(hostPath, "utf8"));
      return { code: 0, out: "", err: "", ms: 5 };
    }
    if (sub === "copyFileFromGuestToHost") {
      const [, , guestPath, hostPath] = argv.slice(argv.indexOf(sub));
      const body = guestFiles.get(guestPath);
      if (body === undefined) return { code: 1, out: "", err: "guest file missing", ms: 5 };
      fs.writeFileSync(hostPath, body);
      return { code: 0, out: "", err: "", ms: 5 };
    }
    if (sub === "runProgramInGuest") {
      // the guest would have executed the wrapper; emulate what it writes back
      const wrapper = argv[argv.length - 1];
      const winScript = /^"([^"]+\.cmd)"/.exec(wrapper);
      const outPath = />>?\s*'([^']+\.out)'/.exec(wrapper) || />>?\s*"([^"]+\.out)"/.exec(wrapper) || />>?\s*([^\s;]+\.out)/.exec(wrapper);
      const rcPath = /echo \$[?]\s*>\s*'?([^'\s;]+\.rc)'?/.exec(wrapper);
      const scriptPath = /^bash '([^']+)'/.exec(wrapper);
      const script = scriptPath ? guestFiles.get(scriptPath[1]) || "" : winScript ? guestFiles.get(winScript[1]) || "" : "";
      const body = guestFiles.has("__stdout__") ? guestFiles.get("__stdout__") : `ran: ${script.trim()}`;
      if (outPath) guestFiles.set(outPath[1], body);
      if (rcPath) guestFiles.set(rcPath[1], `${guestFiles.get("__rc__") ?? 0}\n`);
      if (winScript) guestFiles.set(winScript[1].replace(/\.cmd$/, ".rc"), `${guestFiles.get("__rc__") ?? 0}\n`);
      return { code: 0, out: "", err: "", ms: 12 };
    }
    return { code: 0, out: "", err: "", ms: 1 };
  };
}

const vm = { type: "vmware", vmx: "D:\\vms\\CentOS 7 64 位.vmx", vmrun: "D:\\LINUX666\\vmrun.exe", user: "root", password: "123456" };
const sx = { type: "ssh", host: "10.10.177.222", user: "root", key: "C:\\Users\\x\\.ssh\\id_ed25519" };
const cfg = { targets: { cloud: vm, rhel8: sx } };

check("vmrun argv carries type and guest credentials",
  vmrunArgv(vm, ["runProgramInGuest", vm.vmx, "/bin/bash", "-c", "true"]).join(" ")
    === 'D:\\LINUX666\\vmrun.exe -T ws -gu root -gp 123456 runProgramInGuest D:\\vms\\CentOS 7 64 位.vmx /bin/bash -c true');

check("ssh argv quotes the remote command once",
  sshArgv(sx, `bash -lc ${shellQuote("echo 'hi'")}`).slice(-1)[0] === `bash -lc 'echo '\\''hi'\\'''`,
  sshArgv(sx, `bash -lc ${shellQuote("echo 'hi'")}`).slice(-1)[0]);

check("unknown target lists the configured names",
  (() => { try { resolveTarget(cfg, "nope"); return false; } catch (e) { return /cloud, rhel8/.test(e.message); } })());

check("no targets explains how to configure them",
  (() => { try { resolveTarget({}, "x"); return false; } catch (e) { return /no targets are configured/.test(e.message); } })());

check("targets listing is spawn-free and descriptive",
  JSON.stringify(listTargets(cfg)).includes("CentOS 7 64 位.vmx") && JSON.stringify(listTargets(cfg)).includes("root@10.10.177.222"));

// --- vmware exec -----------------------------------------------------------
{
  const calls = [];
  const guestFiles = new Map();
  guestFiles.set("__stdout__", "SELinux status: disabled\n");
  const client = makeTargetClient({ cfg, runProcess: fakeVmrun(calls, guestFiles), workdir: work });
  const r = await client.exec("cloud", { command: "sestatus | head -1" });
  check("vmware exec returns the guest stdout", r.stdout === "SELinux status: disabled\n", JSON.stringify(r.stdout));
  check("vmware exec reports exit 0 and the target", r.ok === true && r.exitCode === 0 && r.target === "cloud" && r.type === "vmware");
  check("vmware exec copies in, runs, copies out",
    calls.map((c) => c.find((a) => /^(copyFileFromHostToGuest|runProgramInGuest|copyFileFromGuestToHost)$/.test(a))).join(",")
      === "copyFileFromHostToGuest,runProgramInGuest,copyFileFromGuestToHost,copyFileFromGuestToHost");
  const wrapper = calls[1][calls[1].length - 1];
  check("the wrapper redirects output and records the exit code", /\.out.*2>&1; echo \$\? > .*\.rc/.test(wrapper), wrapper);
  check("the temp script is cleaned up", !fs.readdirSync(work).some((f) => f.endsWith(".sh")));
}

// --- exit codes and truncation --------------------------------------------
{
  const calls = [];
  const guestFiles = new Map([["__rc__", 2], ["__stdout__", "line1\nline2\nboom\n"]]);
  const client = makeTargetClient({ cfg, runProcess: fakeVmrun(calls, guestFiles), workdir: work });
  const r = await client.exec("cloud", { command: "false" });
  check("a failing command reports ok=false with its exit code", r.ok === false && r.exitCode === 2, `exit=${r.exitCode}`);
}
{
  const long = Array.from({ length: 400 }, (_, i) => `row ${i}`).join("\n");
  const calls = [];
  const guestFiles = new Map([["__stdout__", long]]);
  const client = makeTargetClient({ cfg, runProcess: fakeVmrun(calls, guestFiles), workdir: work });
  const r = await client.exec("cloud", { command: "seq 1 400", maxChars: 500 });
  check("stdout is capped and the TAIL is kept", r.stdout.length < 700 && r.stdout.endsWith("row 399") && r.stdoutChars === long.length,
    `len=${r.stdout.length} chars=${r.stdoutChars}`);
}

// --- ssh -------------------------------------------------------------------
{
  const calls = [];
  const client = makeTargetClient({
    cfg,
    runProcess: async (argv) => { calls.push(argv); return { code: 0, out: "ok\n", err: "", ms: 3 }; }
  });
  const r = await client.exec("rhel8", { command: "uptime", cwd: "/root" });
  const remote = calls[0].slice(-1)[0];
  check("ssh exec wraps the command in bash -lc with a cd",
    remote.startsWith("bash -lc 'cd ") && remote.includes("/root") && remote.includes("uptime"), remote);
  check("ssh exec forwards the exit code", r.exitCode === 0 && r.stdout === "ok\n");
}
{
  const buf = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0xff, 0x10]);
  const calls = [];
  const client = makeTargetClient({
    cfg,
    runProcess: async (argv, opts) => { calls.push({ argv, opts }); return { code: 0, out: buf, err: "", ms: 2 }; }
  });
  const local = path.join(work, "pulled.bin");
  const r = await client.get("rhel8", { remote: "/tmp/x.png", local });
  check("ssh get keeps binary bytes intact", fs.readFileSync(local).equals(buf) && r.bytes === buf.length, `${r.bytes} bytes`);
  check("ssh get reads the file with cat and no terminal tricks", calls[0].argv.slice(-1)[0] === "cat '/tmp/x.png'", calls[0].argv.slice(-1)[0]);
}
{
  const calls = [];
  const client = makeTargetClient({
    cfg,
    runProcess: async (argv, opts) => { calls.push({ argv, opts }); return { code: 0, out: "", err: "", ms: 1 }; }
  });
  const local = path.join(work, "push.txt");
  fs.writeFileSync(local, "hello\n");
  const r = await client.put("rhel8", { local, remote: "/tmp/push.txt" });
  check("ssh put streams the bytes over stdin", Buffer.isBuffer(calls[0].opts.stdin) && calls[0].opts.stdin.toString() === "hello\n" && r.bytes === 6);
}

// --- windows guests --------------------------------------------------------
const decodePs = (remote) => {
  const m = /^powershell -NoProfile -NonInteractive -EncodedCommand (.+)$/.exec(remote);
  return m ? Buffer.from(m[1], "base64").toString("utf16le") : "";
};
{
  const winbox = { type: "vmware", vmx: "D:\\vms\\Windows 10 x64.vmx", vmrun: "D:\\LINUX666\\vmrun.exe", user: "Administrator", password: "pw" };
  check("a Windows vmx name is detected as a cmd guest", targetShell(winbox) === "windows");
  check("an explicit shell wins over the guess", targetShell({ ...winbox, shell: "posix" }) === "posix");
  check("the targets listing says which shell each guest speaks",
    listTargets({ targets: { win: winbox, cloud: vm } }).map((t) => t.shell).join(",") === "windows,posix");

  const calls = [];
  const guestFiles = new Map([["__stdout__", "Volume in drive C has no label.\n"]]);
  const client = makeTargetClient({ cfg: { targets: { win: winbox } }, runProcess: fakeVmrun(calls, guestFiles), workdir: work });
  const r = await client.exec("win", { command: "vol", cwd: "C:\\Tools" });
  const runCall = calls.find((c) => c.includes("runProgramInGuest"));
  const wrapper = runCall[runCall.length - 1];
  check("vmware runs a .cmd wrapper through cmd.exe", runCall.includes("C:\\Windows\\System32\\cmd.exe") && runCall.includes("-c") && /^"[^"]+\.cmd"/.test(wrapper), wrapper);
  check("the .cmd wrapper starts with @echo off and records ERRORLEVEL",
    (() => { const body = [...guestFiles.entries()].find(([k]) => k.endsWith(".cmd")); return Boolean(body) && body[1].startsWith("@echo off") && body[1].includes("echo %ERRORLEVEL% > "); })(),
    (() => { const body = [...guestFiles.entries()].find(([k]) => k.endsWith(".cmd")); return body ? body[1].replace(/\r?\n/g, " ⏎ ").slice(0, 90) : "(no .cmd)"; })());
  check("a Windows guest still returns stdout and exit 0", r.stdout.includes("Volume in drive C") && r.ok === true && r.exitCode === 0);
  check("the temp .cmd is cleaned up", !fs.readdirSync(work).some((f) => f.endsWith(".cmd")));
}
{
  const winssh = { type: "ssh", host: "10.0.0.9", user: "Administrator", shell: "windows" };
  const calls = [];
  const client = makeTargetClient({
    cfg: { targets: { winssh } },
    runProcess: async (argv, opts) => { calls.push({ argv, opts }); return { code: 0, out: "ok\n", err: "", ms: 2 }; }
  });
  await client.exec("winssh", { command: "dir C:\\", cwd: "C:\\Tools" });
  const ps = decodePs(calls[0].argv.slice(-1)[0]);
  check("windows ssh runs the command through PowerShell -EncodedCommand",
    ps.includes("Set-Location -LiteralPath 'C:\\Tools'") && ps.includes("dir C:\\") && ps.includes("$LASTEXITCODE"), ps);
  check("windows ssh keeps the exit code in a PowerShell-friendly way", ps.trim().endsWith("exit $c"));
}
{
  const winssh = { type: "ssh", host: "10.0.0.9", user: "Administrator", shell: "windows" };
  const buf = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0xff]);
  const calls = [];
  const client = makeTargetClient({
    cfg: { targets: { winssh } },
    runProcess: async (argv, opts) => { calls.push({ argv, opts }); return { code: 0, out: buf, err: "", ms: 2 }; }
  });
  const local = path.join(work, "win-pull.bin");
  const g = await client.get("winssh", { remote: "C:\\Temp\\x.png", local });
  check("windows ssh get streams binary through stdout", decodePs(calls[0].argv.slice(-1)[0]).includes("OpenStandardOutput") && fs.readFileSync(local).equals(buf) && g.bytes === buf.length);
  const pushLocal = path.join(work, "win-push.txt");
  fs.writeFileSync(pushLocal, "hello\n");
  const p = await client.put("winssh", { local: pushLocal, remote: "C:\\Temp\\push.txt" });
  const putPs = decodePs(calls[1].argv.slice(-1)[0]);
  check("windows ssh put streams the bytes in and creates the directory",
    putPs.includes("OpenStandardInput") && putPs.includes("GetParent") && Buffer.isBuffer(calls[1].opts.stdin) && p.bytes === 6, putPs.slice(0, 90));
}

// --- the tool surface ------------------------------------------------------
const { tool, run } = await loadTool({ targets: cfg.targets });
const enumValues = tool.parameters.properties.action.enum || [];
for (const action of ["targets", "exec", "put", "get"]) {
  check(`the tool exposes action ${action}`, enumValues.includes(action));
}
check("the tool documents target/command/local/remote",
  ["target", "command", "local", "remote", "maxChars"].every((k) => Boolean(tool.parameters.properties[k])));

const listed = await run({ action: "targets" });
check("action=targets lists both backends without spawning", (listed.targets || []).length === 2, JSON.stringify(listed.targets));
await (async () => {
  try { await run({ action: "exec", target: "missing", command: "true" }); check("exec on an unknown target fails", false); }
  catch (e) { check("exec on an unknown target names the alternatives", /cloud, rhel8/.test(String(e.message)), String(e.message).slice(0, 80)); }
})();
await (async () => {
  try { await run({ action: "get", target: "cloud" }); check("get without paths fails", false); }
  catch (e) { check("get requires remote and local", /requires/.test(String(e.message)), String(e.message).slice(0, 60)); }
})();

check("tailClip keeps the end and marks the cut", (() => {
  const c = tailClip("a".repeat(100), 10);
  return c.truncated && c.text.endsWith("aaaaaaaaaa") && c.text.startsWith("…(+90 chars)");
})());
check("DEFAULT_MAX_CHARS is the documented cap", DEFAULT_MAX_CHARS === 8000);

fs.rmSync(work, { recursive: true, force: true });
const failed = results.filter((r) => !r.ok).length;
console.log(`\n${results.length - failed} passed, ${failed} failed`);
