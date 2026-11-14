/**
 * The panel's single page. Kept as a string on purpose: the plugin ships as a
 * plain ESM package with no build step, so there is nothing to bundle.
 */
export function panelHtml() {
  return `<!doctype html>
<html lang="zh">
<head>
<meta charset="utf-8">
<title>dsh-computer-use panel</title>
<style>
  :root { color-scheme: dark; }
  body { margin: 0; font: 13px/1.5 ui-monospace, "Cascadia Code", Consolas, monospace;
         background: #14161a; color: #d7dbe0; }
  header { display: flex; gap: 12px; align-items: center; padding: 8px 12px;
           border-bottom: 1px solid #2a2f36; position: sticky; top: 0; background: #14161a; z-index: 2; }
  header b { color: #8fd3ff; font-weight: 600; }
  .pill { padding: 1px 8px; border-radius: 10px; background: #222831; color: #9aa4b2; }
  .pill.bad { background: #45232a; color: #ff9b9b; }
  .pill.ok { background: #1d3326; color: #86e0a8; }
  main { display: grid; grid-template-columns: minmax(0, 1fr) 380px; gap: 12px; padding: 12px; }
  .card { border: 1px solid #2a2f36; border-radius: 6px; overflow: hidden; background: #171a1f; }
  .card h3 { margin: 0; padding: 6px 10px; font-size: 12px; color: #8b97a6;
             border-bottom: 1px solid #2a2f36; display: flex; gap: 8px; align-items: center; }
  .card h3 button { margin-left: auto; }
  .card .body { padding: 8px 10px; }
  #shotWrap { position: relative; background: #0e1013; min-height: 120px; }
  #shot { display: block; width: 100%; cursor: crosshair; }
  #marker { position: absolute; width: 14px; height: 14px; margin: -7px 0 0 -7px;
            border: 2px solid #ffd166; border-radius: 50%; pointer-events: none; display: none; }
  button { font: inherit; padding: 3px 9px; border-radius: 4px; border: 1px solid #3a424d;
           background: #222831; color: #d7dbe0; cursor: pointer; }
  button:hover { background: #2c343f; }
  button.primary { border-color: #2f6f9f; background: #1d3a52; color: #cfe9ff; }
  select { font: inherit; background: #222831; color: #d7dbe0; border: 1px solid #3a424d;
           border-radius: 4px; padding: 2px 6px; max-width: 100%; }
  ul { list-style: none; margin: 0; padding: 0; max-height: 42vh; overflow: auto; }
  li { padding: 4px 6px; border-bottom: 1px solid #22262c; cursor: pointer; display: flex; gap: 8px; }
  li:hover { background: #1e242c; }
  li .role { color: #7fb2d6; min-width: 72px; }
  li .name { flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  li .val { color: #8b97a6; max-width: 110px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  pre { margin: 0; white-space: pre-wrap; word-break: break-all; color: #9aa4b2; max-height: 22vh; overflow: auto; }
  .row { display: flex; gap: 8px; align-items: center; flex-wrap: wrap; }
  .muted { color: #6f7a88; }
  .ok { color: #86e0a8; } .bad { color: #ff9b9b; }
</style>
</head>
<body>
<header>
  <b>computer</b>
  <span id="state" class="pill">…</span>
  <span id="fg" class="pill"></span>
  <span class="row" style="margin-left:auto">
    <button id="btnShot" class="primary">截图</button>
    <button id="btnUi">控件</button>
    <button id="btnState">状态</button>
  </span>
</header>

<main>
  <section class="card">
    <h3>屏幕 <span id="shotMeta" class="muted"></span>
      <label class="muted" style="margin-left:auto"><input type="checkbox" id="auto"> 每 3 秒</label>
    </h3>
    <div id="shotWrap"><img id="shot" alt=""><div id="marker"></div></div>
    <div class="body">
      <div id="hitInfo" class="muted">点屏幕上的任意位置：这里会显示那一点属于哪个窗口、哪个控件。</div>
      <div class="row" style="margin-top:6px">
        <button id="btnClick" disabled>在这里点击</button>
        <button id="btnInvoke" disabled>invoke 这个控件</button>
        <span id="hitIds" class="muted"></span>
      </div>
    </div>
  </section>

  <section style="display:grid; gap:12px; align-content:start">
    <div class="card">
      <h3>窗口 <select id="winSel"></select></h3>
      <div class="body muted" id="winMeta">选择一个窗口，再按「控件」或「截图」。</div>
    </div>
    <div class="card">
      <h3>可操作控件 <span id="uiMeta" class="muted"></span></h3>
      <ul id="uiList"></ul>
    </div>
    <div class="card">
      <h3>动作日志 <button id="btnLog">刷新</button></h3>
      <div class="body"><pre id="log"></pre></div>
    </div>
  </section>
</main>

<script>
const token = new URLSearchParams(location.search).get("t") || "";
const base = "%BASE%";
let shotInfo = null;
let selected = null;
let lastHit = null;

async function api(path, body) {
  const res = await fetch(base + path, {
    method: body ? "POST" : "GET",
    headers: { "x-panel-token": token, "content-type": "application/json" },
    body: body ? JSON.stringify(body) : undefined
  });
  const data = await res.json().catch(() => ({ ok: false, error: "bad json" }));
  if (!res.ok) throw new Error(data.error || res.status);
  return data;
}

const $ = (id) => document.getElementById(id);
const setText = (id, text, cls) => { const el = $(id); el.textContent = text; if (cls !== undefined) el.className = cls; };

async function refreshState() {
  try {
    const s = await api("/api/state");
    const lock = s.locked || s.lockAppRunning;
    setText("state", lock ? "锁屏" : "可注入", "pill " + (lock ? "bad" : "ok"));
    const fg = s.foreground || {};
    setText("fg", fg.process ? fg.process + " · " + (fg.title || "") : "", "pill");
    selected = selected || (fg.hwnd ? String(fg.hwnd) : null);
  } catch (e) { setText("state", "连接失败", "pill bad"); }
}

async function loadWindows() {
  try {
    const w = await api("/api/windows");
    const wins = (w.windows || []).filter((x) => x.visible);
    const sel = $("winSel");
    sel.innerHTML = "";
    for (const x of wins) {
      const o = document.createElement("option");
      o.value = String(x.hwnd);
      o.textContent = (x.process || "?") + " · " + (x.title || "").slice(0, 48);
      if (selected && String(x.hwnd) === selected) o.selected = true;
      sel.appendChild(o);
    }
    if (!selected && wins[0]) selected = String(wins[0].hwnd);
    setText("winMeta", wins.length + " 个可见窗口", "body muted");
  } catch (e) { setText("winMeta", "窗口列表失败：" + e.message, "body bad"); }
}

async function shoot() {
  try {
    const s = await api("/api/shot" + (selected ? "?hwnd=" + selected : ""));
    shotInfo = s;
    $("shot").src = base + "/api/png?p=" + encodeURIComponent(s.path) + "&t=" + encodeURIComponent(token);
    setText("shotMeta", s.w + "×" + s.h + " · " + (s.bytes ? Math.round(s.bytes / 1024) + " KB" : ""));
  } catch (e) { setText("shotMeta", "截图失败：" + e.message); }
}

async function loadUi() {
  try {
    const ui = await api("/api/ui" + (selected ? "?hwnd=" + selected : ""));
    const list = $("uiList");
    list.innerHTML = "";
    for (const it of ui.items || []) {
      const li = document.createElement("li");
      li.title = (it.id || "") + "  " + JSON.stringify(it.rect || {});
      li.innerHTML = '<span class="role"></span><span class="name"></span><span class="val"></span>';
      li.children[0].textContent = it.role || "";
      li.children[1].textContent = it.name || "";
      li.children[2].textContent = it.value ? String(it.value).slice(0, 24) : "";
      li.onclick = () => invoke(it);
      list.appendChild(li);
    }
    setText("uiMeta", (ui.count || 0) + " 个 / 扫描 " + (ui.scanned || 0) + (ui.hint ? " · " + ui.hint : ""));
  } catch (e) { setText("uiMeta", "控件列表失败：" + e.message); }
}

async function invoke(item) {
  if (!selected) return;
  try {
    await api("/api/act", { action: "invoke", hwnd: selected, elementPath: item.id, value: item.value });
    setText("uiMeta", "已 invoke " + item.role + " " + item.name);
    loadLog();
  } catch (e) { setText("uiMeta", "invoke 失败：" + e.message); }
}

$("shot").addEventListener("click", async (ev) => {
  if (!shotInfo) return;
  const rect = $("shot").getBoundingClientRect();
  const imgX = ((ev.clientX - rect.left) / rect.width) * shotInfo.srcW;
  const imgY = ((ev.clientY - rect.top) / rect.height) * shotInfo.srcH;
  const x = Math.round((imgX + (shotInfo.x || 0)));
  const y = Math.round((imgY + (shotInfo.y || 0)));
  const m = $("marker");
  m.style.display = "block";
  m.style.left = (ev.clientX - rect.left) + "px";
  m.style.top = (ev.clientY - rect.top) + "px";
  try {
    const hit = await api("/api/hit", { x, y });
    lastHit = { x, y, hit };
    const el = hit.element || {};
    $("hitInfo").innerHTML = "<b>" + x + "," + y + "</b> → " +
      ((hit.window && (hit.window.process + " · " + hit.window.title)) || "?") +
      (el.role ? " · " + el.role + " " + (el.name || "") : " · (无控件)");
    $("btnClick").disabled = false;
    $("btnInvoke").disabled = !el.id;
    setText("hitIds", el.id ? "id " + el.id : "", "muted");
  } catch (e) { $("hitInfo").textContent = "hit 失败：" + e.message; }
});

$("btnClick").onclick = async () => {
  if (!lastHit) return;
  try {
    await api("/api/act", { action: "click", hwnd: selected, x: lastHit.x, y: lastHit.y });
    setText("hitInfo", "已点击 " + lastHit.x + "," + lastHit.y, "ok");
    loadLog();
  } catch (e) { setText("hitInfo", "点击失败：" + e.message, "bad"); }
};

$("btnInvoke").onclick = async () => {
  const el = lastHit && lastHit.hit && lastHit.hit.element;
  if (el && el.id) invoke({ id: el.id, role: el.role, name: el.name, value: el.value });
};

async function loadLog() {
  try {
    const r = await api("/api/log");
    $("log").textContent = (r.lines || []).join("\\n");
  } catch (e) { $("log").textContent = "日志失败：" + e.message; }
}

$("btnShot").onclick = shoot;
$("btnUi").onclick = loadUi;
$("btnState").onclick = () => { refreshState(); loadWindows(); };
$("btnLog").onclick = loadLog;
$("winSel").onchange = (e) => { selected = e.target.value; setText("uiMeta", ""); };
$("auto").onchange = (e) => {
  if (window.__auto) { clearInterval(window.__auto); window.__auto = null; }
  if (e.target.checked) window.__auto = setInterval(shoot, 3000);
};

refreshState();
loadWindows();
loadLog();
</script>
</body>
</html>`;
}
