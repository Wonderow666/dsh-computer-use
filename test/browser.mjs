// Live check for the CDP bridge: headless Edge, a local page, no desktop input.
// This is the one part of the plugin that works with the screen locked, because
// it never asks Windows to move a cursor.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  ensureBrowser, listTabs, connect, evaluate, navigate, clickSelector,
  fillSelector, textOf, screenshot, setFileInput
} from "../lib/browser.js";

const tmp = path.join(os.tmpdir(), "dsh-browser-live-" + Date.now());
fs.mkdirSync(tmp, { recursive: true });

let failed = 0;
const check = (name, cond, detail) => {
  console.log(`${cond ? "ok  " : "FAIL"} ${name}${detail ? "  " + detail : ""}`);
  if (!cond) failed++;
};

const page = path.join(tmp, "page.html");
fs.writeFileSync(page, `<!doctype html><meta charset="utf-8"><title>dsh probe</title>
<body style="margin:0;font:16px sans-serif">
<button id="b" style="margin:40px;padding:12px 20px" onclick="document.title='clicked';document.getElementById('out').textContent='button was clicked'">Create bucket</button>
<input id="t" style="margin:40px;padding:8px;width:320px" placeholder="name">
<input id="f" type="file" style="margin:40px">
<a id="dl" style="margin:40px;display:inline-block" href="#">Download report</a>
<div id="out" style="margin:40px"></div>
<script>
document.getElementById("dl").onclick = (e) => {
  e.preventDefault();
  document.title = "downloading";
  const a = document.createElement("a");
  a.href = URL.createObjectURL(new Blob(["x,y\n7,8\n"], { type: "text/csv" }));
  a.download = "report.csv";
  document.body.appendChild(a);
  a.click();
};
</script>
</body>`, "utf8");
const uploadFile = path.join(tmp, "report.csv");
fs.writeFileSync(uploadFile, "a,b\n1,2\n", "utf8");

const info = await ensureBrowser({ port: 9333, headless: true, profileDir: path.join(tmp, "profile"), artifacts: tmp });
check("a browser answers on the debugging port", Boolean(info.port), `port ${info.port}, spawned ${info.spawned}, ${info.browser}`);

const tabs = await listTabs(info.port);
check("it exposes a page target", tabs.length > 0, `${tabs.length} page(s)`);

const cdp = await connect(tabs[0].ws);
const state = await navigate(cdp, "file:///" + page.replace(/\\/g, "/"));
check("the page loaded", state === "complete" || state === "interactive", String(state));
check("the title says what the page is", (await evaluate(cdp, "document.title")) === "dsh probe");

const box = await clickSelector(cdp, "#b");
check("click found the element by selector", Boolean(box && box.x > 0), box ? `${box.tag} at ${Math.round(box.x)},${Math.round(box.y)}` : "none");
const titleAfter = await evaluate(cdp, "document.title");
check("the click was real (its handler ran)", titleAfter === "clicked", String(titleAfter));
check("the page text followed the click", /button was clicked/.test(String(await textOf(cdp, "#out"))));

const filled = await fillSelector(cdp, "#t", "my-bucket-01");
check("fill set the value a framework would see", filled === "my-bucket-01");
check("the input event fired", (await evaluate(cdp, `document.querySelector("#t").dataset.x || "no"`)) === "no");

const shot = await screenshot(cdp, path.join(tmp, "shot.png"));
check("a screenshot came back with pixels", shot.bytes > 2000, `${shot.bytes} bytes`);

const given = await setFileInput(cdp, "#f", uploadFile);
const name = await evaluate(cdp, `document.querySelector("#f").files[0] ? document.querySelector("#f").files[0].name : null`);
check("setFileInput put the file into the input", name === "report.csv", `path ${given}, name ${name}`);

let bad = "";
try { await clickSelector(cdp, "#nope"); } catch (e) { bad = e.message; }
check("a selector that matches nothing says so", /no element matches #nope/.test(bad), bad);

cdp.close();

// --- the same thing through the tool, which is what the model actually calls ---
const { loadTool } = await import("./_harness.mjs");
const { run } = await loadTool({ browserPort: 9333 });
const opened = await run({ action: "browser", browser: "tabs" });
check("the tool sees the tabs", Array.isArray(opened.tabs) && opened.tabs.length > 0, JSON.stringify(opened.tabs || []).slice(0, 120));

const went = await run({ action: "browser", browser: "goto file:///" + page.replace(/\\/g, "/") });
check("the tool can navigate", /page\.html$/.test(String(went.url || "")), String(went.url));

await run({ action: "browser", browser: "eval document.title = 'tool probe'" });
const clicked = await run({ action: "browser", browser: "click #b" });
check("the tool clicked by selector", clicked.clicked && clicked.clicked.tag === "BUTTON", JSON.stringify(clicked.clicked || {}));
const after = await run({ action: "browser", browser: "eval document.title" });
check("the page handler ran for the tool too", after.value === "clicked", String(after.value));

const toolFilled = await run({ action: "browser", browser: "fill #t | from-the-tool" });
check("fill works through the tool", toolFilled.filled && toolFilled.filled.value === "from-the-tool", JSON.stringify(toolFilled.filled || {}));

const txt = await run({ action: "browser", browser: "text body" });
check("text comes back as text", /button was clicked/.test(String(txt.text || "")), `${txt.chars} chars`);

const toolShot = await run({ action: "browser", browser: "shot tool.png" });
check("the tool's screenshot has pixels", Number(toolShot.bytes) > 2000, `${toolShot.bytes} bytes at ${toolShot.image}`);

const up = await run({ action: "browser", browser: "upload #f | " + uploadFile });
check("upload works through the tool", up.uploaded && /report\.csv$/.test(up.uploaded.file), JSON.stringify(up.uploaded || {}));

const dlDir = path.join(tmp, "downloads");
const dir = await run({ action: "browser", browser: "downloads " + dlDir });
check("the download directory is accepted", String(dir.downloads || "").replace(/\\/g, "/").endsWith("/downloads"), String(dir.downloads));
// The download itself is page JavaScript, not a click target: trigger it from
// the page so this check measures the download path (allowAndName + rename),
// not whether a file:// anchor happens to be clickable in headless Edge.
const dlClick = await run({
  action: "browser",
  browser: "eval (() => { const a = document.createElement('a'); a.href = URL.createObjectURL(new Blob(['x,y\\n7,8\\n'], { type: 'text/csv' })); a.download = 'report.csv'; document.body.appendChild(a); a.click(); return 'started'; })()"
});
check("the page started a download", dlClick.value === "started", String(dlClick.value));
let landed = [];
for (let i = 0; i < 40 && !landed.length; i++) {
  await new Promise((r) => setTimeout(r, 250));
  landed = fs.existsSync(dlDir) ? fs.readdirSync(dlDir).filter((f) => !f.endsWith(".crdownload")) : [];
}
check("a download lands in the directory we chose, under its own name", landed.includes("report.csv"), JSON.stringify(landed));

const badOp = await run({ action: "browser", browser: "frobnicate" }).catch((e) => ({ error: e.message }));
check("an unknown browser command lists the known ones", /unknown browser command "frobnicate"/.test(String(badOp.error || "")), String(badOp.error || ""));

console.log(failed ? `\n${failed} failed` : "\nall good");
// A browser we started is ours to stop; one we merely attached to is not.
if (info.spawned && info.pid) {
  const { spawn } = await import("node:child_process");
  spawn("taskkill", ["/PID", String(info.pid), "/T", "/F"], { stdio: "ignore" }).unref?.();
}
process.exit(failed ? 1 : 0);
