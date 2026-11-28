# dsh-computer-use

[![CI](https://github.com/Wonderow666/dsh-computer-use/actions/workflows/ci.yml/badge.svg)](https://github.com/Wonderow666/dsh-computer-use/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](https://github.com/Wonderow666/dsh-computer-use/blob/main/LICENSE)

> 让 [DeepSeek Harness](https://github.com/deepseek-ai/dsh)（DSH）真正“动手”操作 Windows 桌面的原生插件：看屏幕、读控件树、点击、打字、启动/关闭软件。全部能力收在一个 `computer` 工具里，底层是一个 70 KB 的单文件 C# 桥 `bin/cu.exe`（Win32 + UI Automation，无第三方依赖、无 Python、不需要视觉模型）。

> **English TL;DR** — a native DSH plugin that gives the agent control of a Windows desktop through a single `computer` tool: 39 actions covering screen capture, the UI Automation tree, a compact control inventory, text readback, SendInput mouse/keyboard injection, UIA pattern invocation (`SetValue`/`Invoke` with no focus or pixel dependency), one-call step plans, cross-machine `exec` over VMware Tools or ssh, per-app profiles, plus an optional read-only panel a human can point at. The engine is one 70 KB C# file compiled by the .NET Framework compiler that ships with Windows — no Python, no MCP hop, no service to keep alive, no vision model required (screenshots are written to disk and returned as paths, then read by whatever vision tool the host has). Input is guarded three times: a configurable per-process blocklist, a hard "target must be foreground" refusal, and a dual-witness point-ownership check before every click. MIT, Windows 10/11, DSH 0.2.x.

[<img src="https://cdn.jsdelivr.net/gh/Wonderow666/dsh-computer-use@main/docs/input-roundtrip.png" width="560" alt="测试窗口：插件通过 UI Automation 的 Value 模式把文字写进输入框，再通过 Invoke 模式点下保存按钮">](https://github.com/Wonderow666/dsh-computer-use/blob/main/docs/input-roundtrip.png)

上图的输入框内容是 DSH 用 UIA 的 `SetValue` 模式写进去的、按钮是 `Invoke` 模式按下去的——全程没有移动过真实鼠标、也没有依赖焦点。更多证据：控制台闭环（`launch cmd` → 打字 → 回车 → 命令真的执行了）见 [docs/console-roundtrip.png](https://github.com/Wonderow666/dsh-computer-use/blob/main/docs/console-roundtrip.png)。

## 为什么是这个形态

调研了 GitHub 上两个成熟的实现后做的取舍：

| 参考实现 | 取（精华） | 去（糟粕） |
| --- | --- | --- |
| [Windows-MCP](https://github.com/CursorTouch/Windows-MCP) | “先截图”作为最便宜的状态读取；UI Automation 树给出稳定元素 id，让点击可复现；显示/区域/窗口级坐标；用户接管机制 | 二十来个高度重叠的工具（本插件合并成单个 `action` 枚举）；注册表/通知/文件系统工具（`pwsh` 已覆盖且更强）；Python + 常驻服务 |
| [trycua/cua](https://github.com/trycua/cua) | 截图→动作→再看一眼的循环；坐标以物理像素为准 | 必须跑沙箱虚拟机；一层 agent 框架 + 一层传输协议 |

另外刻意**没有**走 MCP：DSH 本身就有原生工具注册（registry 直接吃 JSON Schema 形式的 `ToolDefinition`），再套一层 socket 只会多一跳故障点。MCP 版本的价值在跨客户端复用，这里不需要。

插件刻意**零第三方导入**：`link:` 安装的包没有自己的 `node_modules`，任何 `@deepseek-ai/*` 裸导入在 profile 里都解析不到（Node 按 realpath 解析）。所以参数 schema 是手写的 JSON Schema，参数校验也自己做，只用 `node:` 内置模块。

## 安装

要求：Windows 10/11、DSH 0.2.x（desktop 或 web profile）、Node ≥ 20。

```powershell
# 方式 A：直接从 GitHub 装（推荐）
dsh plugin --profile desktop add github:Wonderow666/dsh-computer-use

# 方式 B：本地开发（link:，改代码立刻生效，不用重装）
dsh plugin --profile desktop add link:F:\path\to\dsh-computer-use

# 然后在同一 profile 的 package.json 里确认 dsh.profile.bundles 末尾有 "dsh-computer-use"
# （`dsh plugin add` 通常会自动追加；没有就手动加一行）

# 重启 DSH —— 插件在进程启动时挂载
```

重启之后**还要开一个新会话**：工具清单在会话创建时装配，正在进行中的对话不会热更新，所以“重启了但老会话里依旧没有 `computer`”是正常现象，不是插件没装上（判断依据：`DSH_COMPUTER_USE_DEBUG=1` 会让插件在挂载时把 `apply` + `registered tool 'computer'` 打到 stderr）。

`dsh` 就是 DSH 自带的启动器，例如
`& "$env:LOCALAPPDATA\Programs\DeepSeek Harness\resources\runtime\cli\bin\dsh.cmd" plugin --profile desktop add ...`。

仓库里带了编译好的 `bin/cu.exe`，**装完即用，不需要任何构建工具**。想自己编（或改了 `bridge/cu.cs`）见下面的“构建与自测”。

重启后模型侧多出一个 `computer` 工具。插件配置在 `cordis.patch.yml`（`blockedProcesses`、`refuseFullscreenForeground`、`allowProcessControl`、`timeoutMs`、`enginePath`、`artifactsDir`），profile 自己的 `cordis.patch.yml` 可以按 id 覆盖这些字段。

## 工具面（单一 `computer`，41 个 action）

| 类别 | action | 返回 |
| --- | --- | --- |
| 预检 | `inputcheck` | 移动光标再复位，回报 `landed`/`integrity`/`locked`/`pointerDrifting` 与一句结论。**动手前先跑它** |
| | **`state`** | 一次调用给出“我现在能不能动手”：`locked`/`lockAppRunning`/`privileged`/`foreground`/目标窗口 `geom`/**该应用的模态框计数**（实测 351–547 字节） |
| | **`session`** | **开场一句话**：能否输入（`locked`/`privileged`）、前台是谁、模态框几个、配置了哪些 `targets`/`profiles`，外加该先干什么的 `hint`。一次调用替代 3–4 次探测 |
| 观察 | `info` | 屏幕/虚拟桌面尺寸、每台显示器 dpi 与缩放、光标、前台窗口、`locked`、输入桌面名 |
| | `windows` / `procs` | 顶层窗口（hwnd/title/class/process/pid/rect/foreground）或进程列表 |
| | **`ui`** | **紧凑控件清单**：只列可操作控件（按钮/输入框/下拉/菜单/列表…）与短文本，带 `value`，默认 60 条上限。同一窗口比 `snapshot` 小 5–7 倍 |
| | `screenshot` | PNG 路径 + `srcW/srcH/w/h/scale/mean/contrast`，默认缩到 1600 宽；支持 `region` 裁剪、**`trim`（按内容裁剪）**、**`minBytes`（拒绝空白图）** 与 **`minBrightness`/`minStddev`/`wake`（拒绝休眠屏/纯色帧，可先唤醒再重拍）** |
| | `snapshot` | UI Automation 控制树，元素 id 形如 `0.2.1`，带类型与矩形（**只在需要结构/父级关系时才用**） |
| | `find` / `hit` | 按名称找控件 / 查某坐标下是什么窗口与控件 |
| | `geom` | 窗口矩形 + **客户区原点** + dpi，几何断言的唯一来源 |
| | `modals` | 枚举可见的 `#32770` 对话框、带 owner 的弹窗、被禁用的顶层窗口（“输入被吞”的第一嫌疑人） |
| | `hover` | 移到目标控件驻留后读 UIA 的 name/helpText/acceleratorKey 与 `tooltips_class32` 文本 |
| | **`ocr`** | **当应用根本不给文本时**从截图上读字（tesseract，默认 `chi_sim+eng`）。一次调用换回 `text`，省掉“截图→视觉模型”那条最贵的路。实测控制台 183 字 ≈ 1 秒 |
| | **`readtext`** | 把窗口的文字读回来（UIA Text/Value → win32 `WM_GETTEXT` 兜底），返回 `text`/`strategy`/`sources` |
| | **`waittext`** | 轮询 `readtext` 直到正则命中，返回 `matched`/`waitedMs`/`text`；超时给出已读到的尾部文本。**加 `ocr: true` 改成轮询像素**（引擎 `waitocr`），自绘界面也能等 |
| 批量 | **`run`** | **一次调用执行整份计划**（`wait`/`type`/`key`/`click`/`clickrel`/`invoke`/`read`/`shot`），只回每步一行 transcript；输入前自动置前；也可用 `profile` + `task` 重放存好的计划；`window` 按名字模糊选窗，`dryRun: true` 只解析不执行 |
| 输入 | `click` `move` `scroll` `drag` | SendInput 注入，物理像素坐标；支持 `hwnd`/`title` 定位与 **`relx`/`rely`（客户区相对坐标）** |
| | `type` `key` | Unicode 键入（中文安全）；**`type` 可加 `verify`** 回读校验；`key` 走组合键 `"ctrl+shift+s"` |
| | `invoke` | 通过 UIA 的 Invoke/Toggle/Select/SetValue 模式驱动控件，不依赖焦点与像素 |
| 生命周期 | `launch` `kill` `focus` `wait` | 启动进程（可带参数/工作目录）、结束进程、置前、等待 |
| 应用知识 | **`profiles`** | 列出配置好的应用画像（匹配规则、可重放的计划名、控件别名），**不返回计划正文**；加 `check: true` 会逐条体检（match 键、计划语法、别名引用）|
| 跨机执行 | **`targets`** | 列出配置好的远端目标（VMware 虚拟机 / ssh 主机），不联网、不起进程 |
| | **`exec`** | 在目标里跑一条命令，返回 `exitCode` 与 stdout 尾部（默认上限 8000 字符） |
| | **`put` / `get`** | 与目标之间传文件（vmrun 走 Tools 复制，ssh 走 stdin/`cat`，二进制安全） |
| 杂项 | `clipboard` | 读写剪贴板 |

`click`/`move`/`drag` 会**验证注入是否真的落地**：注入后读回光标，偏差超过 2px 就报错并附诊断，而不是假装成功。窗口移动/缩放后坐标失效的问题，用 `relx`/`rely` 解决——它们是相对目标窗口客户区的偏移，引擎每次实时解析成屏幕坐标。

### 计划能自己启动程序（v0.17.0）

画像写到今天，第一步永远是"先手动把软件打开"——`run {profile, task}` 只会去找已经存在的窗口。加了 `launch` 步骤之后，一个计划可以自己开机：

```json
"start": [
  "launch C:\\Windows\\System32\\notepad.exe",
  "wait /Notepad|记事本/ 5000"
]
```

规则三条：

- 动词后面整段都是**路径**；路径带空格不用加引号。
- 要带命令行参数就在 `|` 后面写：`launch C:\Program Files\App\app.exe | --open "a b.txt"`。
- `launch` 只负责把进程拉起来，**等窗口就绪用 `wait`**——"起来得多慢"交给 `wait` 的超时决定，而不是塞一个 `sleep`。
- `launch` 之后**窗口会被接管**：计划里没有指定 `hwnd`/`window` 时，后续步骤自动改用它刚打开的窗口（按 pid 找，找不到再按进程名找——Notepad、Paint 这类打包应用是启动器交出窗口）。所以 `launch` → `wait` → `type` 能连着写。

`run { dryRun: true }` 会把 `launch` 也解析出来但不执行，所以"计划写得对不对"仍然能在动手前验。

### 开场只花一次进程启动（v0.16.0）

`session` 原来要起两次引擎（`info` 一次、`modals` 一次）。现在引擎的 `info` 支持 `--modals`，对话框列表随 info 一起回来：**一次进程启动**拿到锁屏、前台、屏幕尺寸、模态框、画像匹配。

同时纠正了模态框的计数口径。原来统计整张桌面上所有 `#32770`/禁用窗口，于是只要有常驻程序留了个对话框（比如 WeGame 的 `no_active_wnd`），每次开场都报"1 个对话框开着"，模型就去关一个根本不在前面的窗口。现在只认**属于前台应用**的对话框：前台窗口本身、前台进程自己的对话框、或 owner 指向前台窗口的弹窗。

实测（2560×1600，Windows 11）：`session` 58ms、447 字节、1 次进程启动；同机 `info` 48ms。

### schema 也是成本（v0.15.0）

工具描述和参数 schema 在**每一次请求**里都要重发一遍，它和截图一样花 token。v0.15.0 把这份固定开销从 **11,756 字符压到 9,046 字符**（-23%）：工具描述 2,415 → 1,230，最长的十几个参数说明各砍掉一半。做法只有两条：

- 描述只留"什么时候用它、代价多大、别踩哪个坑"，长流程放进 README 与 `docs/PLAYBOOK.md`，靠 `session` 的 hint 在需要时提醒；
- 每加一个参数，先付 ~60 字符的 JSON 骨架，再写一句说明；重复 README 的话不要写第二遍。

随时可以自己量：`node tools/schema-cost.mjs`（或 `pnpm run schema:cost`），它会打印 description / parameter json / 合计字符数与最长的十个说明。

### 为什么要有 `readtext` / `waittext` / `trim` / `verify`

前三个版本里，“操作对不对”只能靠截图 + OCR 判断，代价是每验证一步都要一次视觉调用；而“命令敲进去没有”只能靠猜，于是会踩到两类静默失败：**IME 把注入的 ASCII 组合成中文**、**提示符还没出来就敲下一条**。v0.3.0 把这两件事都做进工具：

- `readtext`：UIA 的 TextPattern / ValuePattern 优先，win32 `WM_GETTEXT` 兜底，取“读到字符最多的通道”。终端、控制台、编辑器、WinForms、多数 Qt 控件都能直接返回文字（实测 cmd 控制台一次读到整个屏幕缓冲区）。读不到时返回 `strategy: "none"` 和一句 `hint`，**不会拿标题冒充内容**。
- `waittext --regex`：把“等提示符”变成一次调用。`waittext --regex "RA[>#]" --timeout 5000` 命中即返回，超时把已经读到的尾部文本一起带回来，便于判断卡在哪。
- `screenshot --trim`：按内容裁掉空白边。生成报告时特别有用——实测同一个控制台截图从 678 KB 掉到 12 KB，插进文档也不会变成"一大片空白里有个小窗口"。
- `type --verify`：打完字回读一次，文本没出现就**报错**而不是假装成功（输入法组合、密码框、焦点丢失都会被抓到）；窗口没有文本通道时返回 `verified: "unavailable"`，明确告诉模型改用视觉核对。

限制也写清楚：Chromium 系窗口默认不暴露渲染内容（需要 `--force-renderer-accessibility`），此时 `readtext` 会诚实地返回 `none` 而不是编造文本；`--trim` 只在背景比较单色时有效，照片壁纸背景会被判成"全是内容"从而不裁。

- `screenshot --minBytes 15000`：**证据类截图的体检**。屏幕熄灭、窗口被遮住、整帧全黑时，PNG 会压到几 KB——看起来"拍成功了"，插进报告才发现是白图。给了下限就直接报错：`the screenshot is only 5708 bytes (< --min-bytes 15000), so it is blank or the window was not visible`。返回体里恒有 `bytes` 字段，可以自己判。

### 为什么要有 `state` / `ui` / `run`（token 账）

前四个版本的能力都在引擎层，但**每次交互仍然是模型自己一步步试探**：点一下、截个图看有没有反应、再点一下。真正烧 token 的不是引擎，是"每走一步都要重新看清世界"这个循环。v0.4.0 把三件最贵的动作变成工具语义：

| 你想知道 | 以前 | 现在 | 实测 |
| --- | --- | --- | --- |
| 现在能不能动手 | `info` + `inputcheck` + 自己判断 | `state` | **351–547 字节**，一次调用带 `locked`/`lockAppRunning`/`privileged`/前台/目标几何/该应用的模态框 |
| 这个窗口能点什么 | `snapshot`（全树） | `ui` | 同一窗口 **3946 字节 vs 26390 字节**（≈7 倍），且只列可操作控件 |
| 这五步操作对不对 | 5 次调用 + 中间 2 张截图 | `run` | 5 步 **108 字节** transcript，`done 5/5 in 1.2s` |

`run` 的计划语法是一行一步，注释用 `#`：

```
wait /[$#>]\s*$/ 8000     # 等提示符，带超时
type echo hi > out.txt    # Unicode 键入
key enter
wait /hi/ 4000            # 等命令结果
read                      # 读回来（几百 token，替代截图）
shot                      # 只有真需要证据时才拍
```

每一步自己声明"什么算成功"，因此**不需要额外截图来相信它**：成功就 `3 key enter`，失败就

```
1 wait FAILED after 1125ms: text did not match /definitely-not-on-screen/ within 996ms (strategy uia, 720 chars read) | last text: "…F:\…>"
stopped at step 1 of 2
```

——失败时把窗口当时的尾部文本一起带回来，通常这一行就够定位，不用再截一张图。输入类步骤执行前会自动 `focus` 目标窗口（引擎的"不在前台就拒发"护栏因此变成"自动置前后再发"，而不是一个必须人工处理的错误）。

一次典型调用看起来是这样（模型侧）：

```jsonc
{ "action": "screenshot", "hwnd": "656368", "maxw": 1200 }   // -> PNG 路径 + scale
{ "action": "snapshot", "hwnd": "656368", "depth": 6 }        // -> 控件树 + 元素 id
{ "action": "invoke", "hwnd": "656368", "elementPath": "0.2.1" }
{ "action": "type", "hwnd": "656368", "text": "你好，世界" }
{ "action": "key", "combo": "ctrl+shift+s" }
```

设计约定：

- **截图不直接回给模型**——DSH 的工具输出只支持文本块，所以截图落盘并返回路径，模型再用视觉工具查看。返回里的 `scale` 就是“屏幕像素 = 图像像素 × scale”。
- **输入前先确认归属**：给了 `hwnd`/`title` 时会把目标窗口置前，并在结果里回报 `focused: true`，避免按键落到别的窗口。
- **单次动作一次进程调用**：无常驻服务，卡住也杀得掉，超时默认 30 s。
- **`snapshot` 与 `find` 的元素 id 是同一套编号**（`0.2.1` 式控制视图路径），所以 `find` 找到控件后可以直接把它的 `id` 喂给 `invoke`，不用再走一遍像素点击。
- **`dryRun: true`** 只解析 argv、不注入输入、不抢焦点，适合先看它打算干什么。

## 跑通一次，就存成数据：`run { save }`

上一节讲的是"每应用一份 JSON"。可 JSON 从哪来？以前只能手写。现在跑通的计划可以直接落盘：

```json
{ "action": "run", "hwnd": "67970", "save": "pt/rip",
  "plan": "wait /Password:/ 15000 ocr\ntype hhh666\nkey enter\nwait /RA>/ 8000 ocr" }
```

返回尾部会多两行：

```
saved profile "pt" (rip) -> C:\Users\…\dsh-computer\profiles\pt.json
paste this under `profiles:` in cordis.patch.yml:
  pt:
    match: { process: "PacketTracer.exe", class: "Qt51516QWindowIcon" }
    plans:
      rip: |
        wait /Password:/ 15000 ocr
        …
```

下次就是一次 `{ "action": "run", "profile": "pt", "task": "rip" }`，窗口由 `match` 自己找，计划里不用写坐标也不用写 hwnd。

- **match 只取 `process` + `class`**：标题会变、窗口会重开，进程名和窗口类不会。
- 同一个 id 再存会**合并** task，不会覆盖别的计划。
- 文件落在 `<artifacts>/profiles/<id>.json`（默认 `%TEMP%\dsh-computer\profiles\`），可以直接抄进插件配置，永久生效。

**为什么这对 token 重要**：一次走查 PT 的 RIP 配置要几十次点击 + 若干次截图确认；把它变成 profile 后，同样的活只有一行调用和一份 transcript。

## 等到像素说对了再往下走（v0.10.0）

实训里最贵的一类往返是"打完命令 → 截图 → 猜有没有生效 → 再截图"。现在读和等都能直接落在像素上：

```json
{ "action": "readtext", "hwnd": "67970", "ocr": true }
→ { "strategy": "ocr", "chars": 172, "text": "..." }

{ "action": "waittext", "hwnd": "67970", "regex": "RA#", "ocr": true, "timeout": 20000 }
→ { "matched": true, "tries": 1, "waitedMs": 968 }
```

计划里写成 `ocr` 后缀即可，可选步骤仍然是 `?`：

```
wait /Password:/ 15000 ocr
type hhh666
key enter
wait? /RA>/ 8000 ocr
read ocr
```

**代价**：一次 OCR 约 1 秒、几百 token 的文本；"截图 + 视觉模型"是 1–3k token。所以顺序永远是 `readtext` → `ocr` → `screenshot`。

## 开场先问一句：`session`

```json
{ "action": "session" }
→ {
    "locked": false, "privileged": true,
    "foreground": { "title": "Packet Tracer", "process": "PacketTracer.exe" },
    "modals": 0,
    "targets": ["centos7"],
    "profiles": [{ "id": "pt", "plans": ["build-topology"] }],
    "hint": [
      "a task may live in another machine: targets = centos7 - prefer exec over pixels",
      "the front window matches profile \"pt\": run {profile:\"pt\",task:\"build-topology\"} instead of clicking through it",
      "when you do need pixels: readtext first, then ocr, then a screenshot"
    ]
  }
```

它把"我能不能动手 / 面前是谁 / 有什么现成的路"压成一次调用，省掉开场的三次探测。

## 当应用不给文本：`ocr`、帧体检与自动 IME（v0.9.0）

三个实训项目里踩到的坑，最后都落成了引擎能力：

**1. 有些应用读不出文字，但截图上明明有字。** PT 的终端控件是自绘的，`readtext` 只拿到 0 字；过去只能截图 + 视觉模型，一次 1–3k token。现在：

```json
{ "action": "ocr", "hwnd": "67970", "psm": 6 }
→ { "ok": true, "text": "RA# show ip route\n...", "chars": 183, "ms": 968 }
```

`lang` 默认 `chi_sim+eng`，`psm` 默认 6；tesseract 路径用 `DSH_TESSERACT` 或 `--tesseract` 指定。返回的是**文本**，不是图片——模型可以直接 grep 提示符。

**2. 抓到过全黑的"证据图"。** Linux 实训那次报告里有两张图是黑的（mean 2.2），因为抓屏时 guest 屏幕已经休眠，而当时唯一的守门条件是"文件不小于 15KB"——1280×768 的纯黑 PNG 压缩后仍有 37KB。现在 `screenshot` 会自己体检：

| 参数 | 含义 |
| --- | --- |
| `minBytes` | 文件字节下限（空白图的粗筛） |
| `minBrightness` | 亮度均值下限（默认不判） |
| `minStddev` | 对比度下限（纯色帧必然很低） |
| `wake` | 先抖一下光标再重拍的次数 |

不达标会**报错而不是返回图**：`the frame looks blank: mean brightness 15 (need >= 20), contrast 3 (need >= 5) after 2 capture(s)`，并在 JSON 里回 `mean`/`contrast` 供你判断。

**3. 中文输入法把注入的 ASCII 合成中文。** PT 里出现 `R 标 p route` 这种回显，密码框只收到回车。现在 `type`/`key`（以及 `run` 的输入步骤）在注入前会自动 `ime --disable`，把目标窗口切到英文布局；`autoIme: false` 可关掉。

**4. 计划里允许"可选步骤"。** 在操作符后面加 `?`：

```
wait? /Password:/ 1500
type secret
key enter
read
```

可选步骤失败只记一行 `skipped (optional)`，不影响后续步骤；必选步骤仍然失败即停。

### 画像可以放在文件里（v0.12.0）

写进 `cordis.patch.yml` 只适合一两个画像；真正要复用，画像应该是**能 diff、能 review 的 JSON**：

```yaml
# cordis.patch.yml
config:
  profilesFile: profiles            # 相对插件目录；也接受绝对路径或数组
  # profiles: { ... }               # 内联的优先级更高，可覆盖同名画像
```

`profiles/` 下每个 `.json` 一个文件（或一个文件里放数组 / `{ "profiles": [...] }`），插件启动时按文件名顺序读入，同 id 时**内联覆盖文件**。仓库里带了一份可直接抄的 `profiles/example.json`（notepad / Packet Tracer / Horizon 三个例子，含 `notes` 说明为什么要那样写 `match`）。

用法没变：

```
computer { action: "profiles" }                                  // 看有哪些画像（不含计划正文）
computer { action: "run", profile: "packet-tracer", task: "read-screen" }
computer { action: "run", profile: "notepad", task: "save", save: "notepad/save" }   // 跑通就落盘成画像
```

## 先验，再跑（v0.14.0）

计划和画像都是**数据**，所以能在花掉一次真机运行之前先检查：

| 想验证的 | 一行调用 | 它替你省掉的 |
| --- | --- | --- |
| 这份计划语法对不对、会打到哪个窗口 | `run { window: "notepad", plan: "...", dryRun: true }` | 一次真跑 + 一次回滚 |
| 窗口名怎么写 | `run { window: "记事本", dryRun: true, plan: "read" }` | 先 `windows` 再数 hwnd 的两次往返 |
| 画像有没有笔误 | `profiles { check: true }` | 跑到第 3 步才发现 `{{alias}}` 不存在 |

- `window` 是**不区分大小写的子串**，会同时匹配标题、进程名和窗口类；找不到时错误信息里直接列出当前打开的窗口。
- `dryRun` 返回 `{ ok, dryRun, target, steps }`：`target` 是真实解析到的窗口（含 `hwnd`/`pid`/`rect`），`steps` 是解析后的 `{ line, op, optional, rest }`。**不注入、不抢焦点、不落盘。**
- `profiles { check: true }` 逐条检查 `match` 的键是否合法、`match` 是否为空、计划能否解析、`{{alias}}` 是否都有定义，返回 `{ ok, checked, failing, profiles: [{ id, ok, plans, problems }] }`。

这不是花架子：随包的 `profiles/example.json` 第一次被 `check` 时就被抓出两处真错（`read-page` 和 `read` 写成了 `readtext`，而计划里的动作叫 `read`）。写完画像先 check，能省下的是一次"跑到一半才发现"的调试。

## 跨机执行：先把另一台机器变成一条命令（token 账）

`targets` / `exec` / `put` / `get` 是 v0.7.0 加的，起因是一次真实任务：在一台 CentOS 7 虚拟机里部署 OpenStack（关服务、改 SELinux、换源、跑 30 分钟的 `packstack`、验证 11 个组件）。如果按像素做，每一步都要「截图 → 看 → 点/打字 → 再截图确认」；实际做法是**用 VMware Tools 把命令送进 guest、把输出取回**，整场部署只拍了 5 张证据图，其余全部是文本往返。

代价对比（同一件事）：

| 做法 | 往返次数 | 进入上下文的内容 |
| --- | --- | --- |
| 纯 GUI | 每步 2–3 次（截图 + 点击 + 确认截图） | 每次 1–3k token 的图像理解 |
| `exec` | 1 次/组命令 | 200–2000 字符的 stdout 尾部 |

配置（`cordis.patch.yml` 的 `config` 里加 `targets`，或插件设置里同样结构的 JSON）：

```yaml
targets:
  cloud:                                  # 名字随便起，action 里用它
    type: vmware
    vmrun: D:\LINUX666\vmrun.exe          # 不给就用 PATH 里的 vmrun
    vmx: D:\云计算导论虚拟机2\CentOS 7 64 位.vmx
    user: root
    password: "123456"
    timeoutMs: 180000                     # 单条命令默认预算
  rhel8:
    type: ssh
    host: 10.10.177.222
    user: root
    key: C:\Users\you\.ssh\id_ed25519
```

用法：

```jsonc
{ "action": "targets" }                                                    // 先看有哪些目标
{ "action": "exec", "target": "cloud", "command": "systemctl is-active mariadb; rpm -q mariadb" }
{ "action": "exec", "target": "rhel8", "command": "tail -50 /var/log/messages", "maxChars": 3000 }
{ "action": "get",  "target": "cloud", "remote": "/root/shot.png", "local": "F:\\out\\shot.png" }
```

实现与边界：

- **vmware** 后端把一个脚本 `copyFileFromHostToGuest` 进去，用 `runProgramInGuest` 执行「跑脚本 → 重定向到 `.out` → 把 `$?` 写进 `.rc`」，再把两个文件取回。所以拿到的是**guest 里真实的退出码**，不是 `vmrun` 的。
- **ssh** 后端把命令包成 `bash -lc '…'`（`cwd` 会先 `cd`），`put` 走 `cat > path` 的 stdin，`get` 走 `cat path` 并按二进制读回，PNG 不会被 UTF-8 破坏。
- stdout 默认只留**尾部** 8000 字符（错误和新提示符都在尾部），被截断时返回 `stdoutChars` 让你知道原来有多长。
- 凭证写在 profile 配置里，`exec` 以该用户身份运行；它**不受** `blockedProcesses` 约束——那是给本机 GUI 输入用的护栏，跨机命令是另一回事，别把这两件事混在一起。
- 目前 vmware 后端假设 guest 是 POSIX（`/bin/bash`）。Windows guest 需要 `cmd`/`powershell` 版的包装器，还没做——那种机器仍然走 GUI，或用 guest 里自己开的 ssh。
- 没有 Tools、也不通 ssh 的虚拟机（比如刚装完没配网络的），`exec` 会直接报错并说明；这时再退回 `targets` 之外的 GUI 动作。

### Windows 客户机（v0.13.0）

以前 `targets` 只假设客户机是 POSIX。现在每个目标可以说明它说的是哪种 shell：

```yaml
targets:
  winbox:
    type: vmware
    vmx: D:\vms\Windows 10 x64.vmx
    vmrun: D:\LINUX666\vmrun.exe
    user: Administrator
    password: "***"
    shell: windows          # posix | windows；不写就按 vmx 名字猜
```

- **vmware + windows**：命令写进 `C:\Windows\Temp\dsh-<id>.cmd`，`@echo off` 开头、末尾 `echo %ERRORLEVEL% > ...rc`，再用 `cmd.exe /c` 跑它——和 POSIX 版一样拿到**客户机真实退出码**，而不是"vmrun 自己成功"。
- **ssh + windows**：不拼命令行，改用 `powershell -NoProfile -NonInteractive -EncodedCommand <base64>`（UTF-16LE），彻底绕开引号地狱；`cwd` 用 `Set-Location -LiteralPath`，退出码用 `$LASTEXITCODE` 兜底为 0。
- **put / get + ssh + windows**：二进制走标准输入/输出（`[Console]::OpenStandardInput()` / `OpenStandardOutput()`），所以 `.png`、`.zip` 不会在 PowerShell 管道里被当文本改坏；`put` 还会顺带建目录。
- `action: "targets"` 现在会回报每个目标的 `shell`，一眼看出它按 POSIX 还是 cmd 处理。

不知该写哪个？`shell` 省略时会看 vmx 名字里有没有 `Windows` / `Win10` 之类；拿不准就明确写上，猜错只会得到一条明确的失败，不会静默跑错。

## 应用画像：把"这个软件怎么用"变成数据（v0.8.0）

引擎和协议是通用的，但**每个软件的知识不通用**：窗口怎么认、那个按钮叫什么、这套步骤上次是怎么走通的。放在一次性脚本里，换个软件就要重写一遍；写进配置，就变成"换软件只写 JSON"。

一个 profile 包含四件事：怎么认窗口（`match`）、控件叫什么（`aliases`）、哪些步骤已经验证过（`plans`）、以及给人看的备注（`notes`）。

```yaml
profiles:
  pt:                                       # 名字随便起，action 里用它
    match: { process: PacketTracer.exe, class: "Qt5*" }   # 全中才算命中
    notes: 调色板在 y=1404，每放一个设备要重新点型号
    aliases:
      panel: "0.1.3.0.2.0"                  # 设备类别栏
      addLink: "0.2.2"
    plans:
      new-topology: |
        key ctrl+n
        wait /是否要保存/ 3000
        click --name No
      inspect:
        - readtext
        - wait /工作区列表/ 4000
```

用法（三个入口，都不需要模型自己找窗口）：

```jsonc
{ "action": "profiles" }                                      // 有哪些画像、各自能重放什么
{ "action": "state" }                                         // 输出里的 profile 就是当前前台应用命中的画像
{ "action": "run", "profile": "pt", "task": "new-topology" }   // 重放，窗口由 match 自动定位
{ "action": "run", "profile": "pt", "plan": "invoke {{panel}} 设备" }  // 临时计划，别名照样生效
```

设计上的几处取舍：

- **窗口由 `match` 解析，不由调用方传 hwnd。** 计划因此可以跨会话复用；窗口挪了、缩放了、重启了都不影响。
- **`process`/`class` 无通配符时是全等比较，不是子串。** `Qt5` 不会误配 `Qt51516QWindowIcon`——误配到别的窗口比配不上更糟。要模糊匹配就写 `Qt5*`。
- **计划正文不列出来。** `profiles` 只回名字，避免每次调用都把几 KB 的计划塞进上下文；要用哪份就点哪份。
- **别名只替换参数部分**，`{{panel}}` 出现在 `rest` 里才会展开，避免把 `op` 也替换掉。
- 报错都带上下文：未知画像列出已有名字，未知计划列出可选项，未知窗口列出当前打开的窗口。

## 失败会留下证据，而不是一句“没成功”（v0.18.0）

计划中途失败时，工具会自己开一个目录，把现场原样放进去：

```text
F:\…\dsh-computer-use\artifacts\failures\2026-11-21T17-25-25\
  plan.txt         计划原文（带步骤号，可整段贴回去改）
  transcript.txt   每条步骤的结果，停在第几步、为什么
  where.json       停在哪一步、哪个窗口、什么时候
  shot.png         那个窗口当时的像素（过了亮度门，不会是黑图）
  tree.json        那个窗口当时的控件树
```

transcript 的最后一行会给出目录路径。之后用 `computer action=failures` 按时间倒序列出最近几次，挑一个回看：

```json
{"ok":true,"count":4,"failures":[{"dir":"…\\2026-11-21T17-25-25","firstStep":"1 launch C:\\Windows\\System32\\cmd.exe","stopped":"2 wait FAILED after 1765ms: text did not match …"}]}
```

为什么值得多花一次截屏 + 一次控件树：**失败如果不可回看，就只能靠猜**。真机上第一次跑出来的证据是 476 字符的控制台文本 + 37KB 截图 + 14 个节点，足以让人一眼看出“等错窗口了”还是“文本被 IME 吃了”。成功的计划不留任何东西（不留垃圾）。

## 点名字，不是坐标（v0.19.0）

坐标是"这一刻这一块屏幕上的一个位置"。窗口挪一下、列表滚一格、系统换个语言，坐标就错，
而名字通常还在。所以让点击先认名字：

```
computer action=click name="Save"                  # 找到名为 Save 的控件，先 invoke
computer action=click name="导出" role=Button      # 同名太多时按角色筛
computer action=click name="第 3 页" index=2       # 再按序号挑
```

点击顺序是 **invoke → 点中心 → 报错**：控件能 invoke 就 invoke（被滚出视野也有效，
这对长列表很关键），不能才在控件矩形的中心真点一下，两样都不行就说清为什么：

```
no control matches "Save" in window 721562; closest: MenuItem:文件 | Button:标题
```

这条路径在计划里写作 `press`，占位符写作 `{{名字}}`，来源是 `vars`：

```
computer action=run window="Notepad" vars={"file":"report.txt"} plan="
  until /无标题/ 4000 press 文件
  type {{file}}
  key ctrl+s
"
```

计划现在有三种"重来一次"，都在引擎里循环，不花模型的 token：

| 前缀 | 意思 | 什么时候用 |
| --- | --- | --- |
| `repeat N 步骤` | 原样重试 N 次（上限 50） | 点一下可能没跟上的按钮 |
| `until /re/ [ms] 步骤` | 做一步，再读窗口文本，被正则匹配就停 | "点完等它变成什么样"的每一步 |
| 直接写 | 只做一次 | 其余情况 |

真机上一分钟的结果（Windows 11，Notepad）：

```
1 1 key ctrl+a until /notepad|记事本|无标题/ ok
done 1/1 in 0.7s
```

```
press "Save" via invoke (Button)
```

**一个必须记住的边界**：本次排查里 `find` 一度对所有窗口返回空树，原因是集成脚本把
`enginePath` 直接指向了工作目录里的 `bin/cu.exe`——工作目录里的进程是低完整性级别，
UIA 客户端跨不过去，于是每棵树都是空的。生产路径一直没这个问题，因为插件会把引擎复制到
`%LOCALAPPDATA%` 再跑。测试脚本现在也照这个来（`test/_harness.mjs` 不再传 `enginePath`）。

## 等事件，不轮询（v0.20.0）

轮询是一种花自己的 token 去问"好了吗"的方式：每 300ms 起一次引擎、读一次文本、判断一次，直到某个东西出现。桌面上的多数等待都有事件可听——窗口被创建、被关闭、切到前台、标题变了——所以 v0.20.0 把等待做成一次调用：

```json
{ "action": "watch", "event": "window-created", "timeout": 10000 }
```

引擎用 `SetWinEventHook` 挂上事件，边泵消息边等；事件到了立刻返回，最多等到 timeout。

| 参数 | 含义 |
| --- | --- |
| `event` | `window-created`（默认）、`window-closed`、`foreground`、`title` |
| `timeout` | 毫秒，默认 10000；到点返回 `fired: false` |
| `hwnd` / `pid` | 只看这个窗口或这个进程（`title` 事件用它） |

返回 `{ok, fired, event, waitedMs, window, appeared}`：`window` 是那个窗口（hwnd/title/class/process/pid/rect）；`fired: false` 时带 `appeared`，列出等待期间新出现的窗口——"漏了事件"和"什么都没发生"从外面看是一样的，不给这个列表就只能猜。

计划里同样能用：

```text
watch window-created 8000
read 200
```

实测（Windows 11，2560×1600）：静默桌面 `timeout 400` → 405ms 返回 `fired: false`；后台 600ms 时启动 notepad → 819ms 返回 `fired: true`，`window.title = "记事本"`。计划里 `watch window-created 8000` 等到窗口后，下一步 `read` 直接读它（计划没指定 hwnd 时，watch 看到的窗口会成为后续步骤的目标）。

一个反直觉的顺序：**不要 `launch` 之后再用 `watch window-created` 等它**。`launch` 已经等到窗口并把 hwnd 交回来了，再等"新窗口创建"只会等到超时；要等窗口用 `wait /标题/ 5000`，`watch` 留给"窗口由别处打开"的场合（比如你点了菜单、另一个进程被唤起）。

## MCP 包装（v0.21.0）

核心能力不绑在 DSH 上：`mcp/server.mjs` 是同一个 `computer` 工具的 MCP stdio 服务，任何支持 MCP 的客户端（Claude Desktop、IDE、别的 agent 框架）都能直接用。

```json
{
  "mcpServers": {
    "computer": {
      "command": "node",
      "args": ["F:\\Dharness\\plugins\\dsh-computer-use\\mcp\\server.mjs"]
    }
  }
}
```

它只做三件事：`initialize` → `tools/list` → `tools/call`。工具定义、参数 schema、安全护栏全部复用 `lib/index.js`（不是复制一份），所以 DSH 里和 MCP 里的 `computer` 永远是同一份。

- 传输：一行一条 JSON-RPC（MCP stdio 规范）；日志走 stderr，不污染消息流。
- 失败：参数错或引擎报错 → `isError: true` 的**结果**（模型看得见、能改），只有协议层错误才是 JSON-RPC `error`（未知工具 -32602、未知方法 -32601、坏 JSON -32700）。
- 配置：环境变量 `DSH_COMPUTER_USE_MCP_CONFIG` 传一个 JSON，内容与 `cordis.patch.yml` 里的插件配置同形（`artifactsDir`、`profiles`、`targets`、`blockedProcesses`…）。
- 范围：只暴露 tools。要 `resources/*` 的客户端会拿到 -32601——桌面不是数据集，没必要假装是。

实测（真机）：`initialize` 回 `serverInfo.name = "dsh-computer-use"` 与版本号；`tools/list` 一个工具、schema 与插件内定义**同一个对象**；`tools/call {action:"info"}` 拿到 `ok: true, screenW: 2560`；坏 action 回 `isError`；未知工具回 -32602。`test/mcp.mjs` 15 项全绿。

## 看得见的编号：把定位变成"第 3 个"（v0.22.0）

画面类软件（画布、游戏、自绘面板）没有可读的控件树，模型只能靠坐标猜。`see` 换了个做法：先截一张图，把**能点的地方按读图顺序编上号**，再回来一份编号表；要点击时只要说 `clicknum 3`。

| 想做什么 | 怎么写 | 回来什么 |
| --- | --- | --- |
| 给窗口编号 | `computer action=see hwnd=721562 goal="找一个按钮"` | `{image, count, targets:[{n,role,name}]}` |
| 点第 3 个 | `computer action=clicknum n=3` | `{ok, clicked:{n,role,name}, how:"invoke"|"point"}` |

三条行为值得记：

1. **只编号能点的东西**：`Text`、禁用控件、没有名字的、短边小于 8px 的都跳过（编号多了反而要读更多）。默认最多 12 个（`max` 上限 30），按从上到下、从左到右排序。
2. **先把窗口调到前台再截**：截到的不是目标窗口，就退回让窗口自己画（`printwindow`）。否则数字会落在别的窗口的像素上——真机第一版就是这样把编号画到了聊天窗上。
3. **编号表存在磁盘上**：`artifacts/see/last.json` 记住这张图每个数字对应的控件与矩形，所以 `clicknum` 可以晚几步再用；重新 `see` 一次就覆盖成新的。

真机一次 `see`（记事本，`max=6`）：

```
targets: 1:Button:最小化 | 2:Button:最大化 | 3:Button:关闭 | 4:MenuItem:系统 | 5:TabItem:无标题. 未修改。 | 6:Button:关闭标签页
clicked 4:MenuItem:系统 via invoke
```

`how` 是结果不是承诺：能 `invoke` 就走控件本身（被滚出视野也有效），不能才退回到矩形中心点一下。编号挤在一起时（标题栏三个按钮只隔 10px），徽标会按碰撞避让挪位；如果图上看不清，`find --name` 仍然是最精确的那把尺。

## 坐标只报一种（v0.23.0）

坐标这件事原来有三种：截图像素、屏幕像素、客户区像素。截图是 1600 宽的图，屏幕是 2560 宽，`relx/rely` 又是**相对窗口客户区**的——三个数看起来都像坐标，差了 1.6 倍。模型不该做这种乘法。

现在一张截图自带它的换算表，点击直接用**图上的像素**：

| 想做什么 | 怎么写 | 回来什么 |
| --- | --- | --- |
| 截一张图 | `computer action=screenshot hwnd=721562` | `{path, w, h, srcW, scale, x, y}`，并存进 `artifacts/shots.json` |
| 点图上 (120, 64) | `computer action=click imgx=120 imgy=64` | `{ok, x, y, from:{image, imgx, imgy, scale}}`——返回的 `x/y` 就是真实落点 |

`see` 的编号图同样登记在册，所以 `clicknum` 和 `click imgx/imgy` 可以混着用。换算只有一次：`屏幕 = 图原点 + 图像素 × scale`，由插件算，不由模型算。截图只留最近 20 张的账，找不到账就直说"先截一张"，不猜。

### 给文件选择框一条路：`upload`

浏览器的"选择文件"框是个标准 Win32 对话框（`#32770`），键盘能走完：聚焦 → 清空文件名框 → 输入路径 → 回车。`upload` 把这四步合成一次调用，并且**确认框关没关**：

```
computer action=upload path="D:\\data\\report.csv"
→ {"ok":true,"dialog":"打开","file":"D:\\data\\report.csv","closed":true}
```

没有对话框、路径不存在都会被明确拒绝（前者列出当前所有对话框的标题），绝不盲敲。这一步补的是"上传"这个以前只能靠人点的动作。

### 重试是一行前缀

`retry N` 和 `until` 并列，管的是"这一招可能不灵"：

```
retry 3 press Save
until /已保存|Saved/ 8000 key ctrl+s
```

`retry` 最多试 N 次（上限 20），成功即停；全失败才进入失败复盘（留下截图、控件树与 transcript）。`until` 管的是"等到屏幕说对了"，两者可以叠。

最后一条：控件 `invoke` 失败现在会**带着原因**回退到真实点击（`{"how":"click","invokeFailed":"ElementNotAvailableException…"}`）。虚拟列表回收元素时矩形仍然是对的——失败是事实，不该被吞掉。

## 浏览器：用名字，不用坐标（v0.24.0）

网页控制台是桌面控制最不划算的地方：DOM 里每个按钮都有名字，屏幕上它们只是一堆像素。改一个窗口大小，昨天的坐标就全废了；而 `button[data-testid=create]` 明天还在。

所以插件里加了一条不经过鼠标的路：**Chrome DevTools Protocol**，Node 自带的 `WebSocket` 直连，不装 Playwright、不加依赖。它开着普通浏览器（Edge/Chrome 都行），用 `--remote-debugging-port` 暴露一个本地端口，插件连上去发命令。

| 想做什么 | 怎么写 | 回来什么 |
| --- | --- | --- |
| 起一个可调试的浏览器 | `computer action=browser browser="open"` | `{port, spawned, browser, tabs}` |
| 看有哪些标签页 | `browser="tabs"` | `{tabs:[{i,title,url}]}` |
| 打开网址 | `browser="goto https://console.cloud.tencent.com/cos"` | `{url, state, title}` |
| 点一个按钮 | `browser="click button[type=submit]"` | `{clicked:{selector,tag,text}}` |
| 填一个输入框 | `browser="fill #bucket-name | my-bucket-01"` | `{filled:{selector,value}}` |
| 读页面文字 | `browser="text main"`（省略选择器 = 整页） | `{chars, text}` |
| 执行一句 JS | `browser="eval document.title"` | `{value}` |
| 页面截图 | `browser="shot login.png"` | `{image, bytes}` |
| 上传文件 | `browser="upload input[type=file] | D:\\data\\a.csv"` | `{uploaded:{selector,file}}` |
| 指定下载目录 | `browser="downloads D:\\data\\downloads"` | `{downloads}` |

四条行为：

1. **点击是真的鼠标事件**（`Input.dispatchMouseEvent` 落在元素矩形中心），不是 `element.click()` 骗自己；先 `scrollIntoView`，所以滚出视野的元素也能点。
2. **填值走原生 setter**，再补 `input`/`change` 事件——React、Vue 的受控输入框认这个，直接 `el.value = x` 不认。
3. **上传不走对话框**：`DOM.setFileInputFiles` 把文件直接塞进 `<input type=file>`，没有"选择文件"框要过。
4. **锁屏也能用**：它不求 Windows 移动光标，所以屏幕锁着时它照常工作——这恰好补上桌面控制在锁屏时彻底失效的空白。

它开的浏览器有自己的 profile（`artifacts/browser/profile`），第一次登录后 cookie 会留着；要复用人已经登录的窗口，得人自己用 `--remote-debugging-port=9222` 启动一次浏览器，然后 `browser="tabs"` 就能看见那些标签页。

真机（headless Edge 158，本地页面，屏锁着）：

```
open       → port 9333, spawned true, Edg/158.0.4370.45
click #b   → BUTTON at 104,62 → document.title 从 "dsh probe" 变成 "clicked"
fill #t    → "my-bucket-01"
shot       → 11,986 bytes
upload     → files[0].name = "report.csv"
```

### 下载要三步都对，文件才落盘（v0.24.1）

Edge 158 会**静默忽略** `Browser.setDownloadBehavior {behavior:"allow"}`：文件照旧进 `C:\Users\...\Downloads`，没有任何报错。实测能用的组合是三步：

1. `behavior: "allowAndName"`：文件先进你指定的目录，但**用 guid 当文件名**；
2. 浏览器级 CDP 会话必须**一直开着**——一关，下载规则跟着消失，下一次点击又回到默认目录（这条最容易踩：设置完就 `close()` 看起来"成功"过一秒）；
3. 监听 `Browser.downloadWillBegin` 拿 `suggestedFilename`，在 `downloadProgress` 变成 `completed` 时把 guid 改回真名。

所以 `browser="downloads <dir>"` 之后不要自己断开：插件会保住那条会话，替你把 guid 改回去。真机：

```
downloads → dir C:\...\downloads
click     → 页面触发 report.csv
poll      → [ 'report.csv' ]   （guid 已被改名）
```

顺带一句边界：浏览器能做的是"网页里的事"。系统弹窗、原生安装器、桌面软件，仍然归 `computer` 的其余 40 个 action。

## 可视化面板：人给模型指路

模型不需要"看着屏幕操作"，但**人需要看着屏幕给模型指路**。面板做四件事：按需截图 → 点一下查这个点是什么控件 → 列出可操作控件 → 记动作日志。

v0.6.0 起面板有两个挂载点，共用同一个请求处理器：

1. **DSH 自己的 Web 服务**（默认）：挂在 `/computer-use/panel`，与 DSH 页面同源，用 DSH 会话 Cookie 鉴权——不需要 token、不需要 CORS。右侧栏会多出一个「电脑操作面板」标签页，里面是同源 iframe。
2. **回环端口 + 随机 token**（可选）：想用普通浏览器窗口看时用。

```yaml
# profile 的 cordis.patch.yml（或 dsh-computer-use 的插件配置）
config:
  panelPort: 7333        # 可选的回环副本；DSH_COMPUTER_USE_PANEL=1 则随机端口
```

客户端标签页来自 `lib/client.js`（`dsh.client` + `exports["./client"]`），**需要重启 DSH 才会装载**。重启后有两个入口：

1. **设置 → 电脑操作面板** → 点「在右侧栏打开面板」（这条最稳，每个注册的 settings section 都会列出来）；
2. 右侧栏（对话头部那个分栏图标）→ 标签栏的「+」→「电脑操作面板」。

启动时插件会写一份挂载诊断到 `<artifactsDir>/panel-diag.json`（`mounted: true` 表示已挂到 DSH 自己的 Web 服务上）；回环副本还会把地址和 token 写进 `<artifactsDir>/panel.json`（默认 `%TEMP%\dsh-computer`），同时在 stderr 打印一次：

```
[dsh-computer-use] panel: http://127.0.0.1:7333/?t=2f9c…
```

- **鉴权**：DSH 内挂载靠会话 Cookie；回环副本靠 `?t=<token>` 或 `x-panel-token` 头，缺了就是 401，且默认只绑 `127.0.0.1`。
- **动作白名单**：面板只能 `click` / `invoke` / `type` / `key` / `focus` / `scroll` / `hover`，`kill`、`launch` 之类一律 403——浏览器里的一次误点不该能关掉你的程序。
- **同一个安全闸**：面板调用的是模型的 `computer` 执行器本身，所以 `blockedProcesses`、前台护栏、LOW 完整性提示全部照旧生效。
- **不是实时镜像**：默认不截图、不推送画面，只有在你看的时候才抓一张（另有一个 3 秒自动刷新开关，默认关）。实时镜子会把人重新带回"用像素看世界"，而那正是这个插件想省掉的开销。

面板的价值不只是"能点"：它顺手给出**稳定的选择器**（`role` + `name` + `automationId` + `id` 路径），这些正是将来写进 `profile` 文件、让下一次任务不必再试探的东西。

## 安全边界

1. `blockedProcesses`：目标窗口的进程名/窗口类/标题命中任一字符串就拒绝注入输入。**默认已填 `TslGame.exe` / `UnrealWindow`**（PUBG），也就是永远不会往游戏窗口里打字或点击；想操作别的游戏就往这个数组里加。只读动作不受影响。
2. `refuseFullscreenForeground`：目标窗口占满整台显示器时拒绝注入（默认关）。
3. `allowProcessControl: false`：彻底禁用 `launch`/`kill`。
4. 判定对象是**即将接收输入的那个窗口**，不是当前前台窗口——否则后台一个被禁的应用会误伤无关的点击。
5. 只读动作（截图、窗口列表、控件树、剪贴板读）永不被拦。

`cu.exe` 自身不含任何策略，策略全部在插件层，便于按 profile 调整。

### 引擎层的两道物理护栏

策略之外，`cu.exe` 还做两件策略无关的保命事——**宁可报错，也不把输入打到错误的窗口**：

- **不在前台就拒输**：`type` / `key` 带了 `--hwnd` 而该窗口不是前台时，直接拒绝（`refusing to send input: window … is not in the foreground`）。必须先 `focus`。
- **坐标归属检查（双证人）**：`click` / `scroll` 前同时问两个来源——`WindowFromPoint` 和 UIA 的 `AutomationElement.FromPoint`（上溯到顶层取 ProcessId）。两者都指向别的进程才拒绝。只信 `WindowFromPoint` 会误杀：实测存在“UIA 在该点拿到目标按钮、`WindowFromPoint` 却恒返回另一个窗口”的情况（透明/置顶覆盖层的典型症状）。

### focus 的分级升级

后台窗口置前并不总能成功（Windows 前台锁是真实存在的），`focus` 依次尝试：

1. `SetForegroundWindow` + 轮询确认（`WaitOwns`，120ms）；
2. 按住 ALT 期间再 `SetForegroundWindow`，然后松手；
3. `SwitchToThisWindow`；
4. 仅 `forceFocus: true` 时：`SW_MINIMIZE` + `SW_RESTORE`。

四级都失败就返回 `ok:false` 并说明前台是谁——不猜、不乱输。`AttachThreadInput` 与 `SPI_SETFOREGROUNDLOCKTIMEOUT` 两条早期方案在本机实测恒失败（`err 5` / `err 87`），已删掉以免误导。

顺带一条经验：失败往往取决于**调用进程当时有没有前台权限**这一系统状态，而不是技巧本身，所以别从一次失败推断“沙箱禁止置前”。

### 两个值得记下的坑

- **`spawn(windowsHide: true)` 会隐藏目标窗口**：Windows 把 `STARTUPINFO.wShowWindow`（`SW_HIDE`）替换进进程对某个窗口的**第一次** `ShowWindow` 调用。于是 `ShowWindow(target, SW_SHOW)` 实际变成隐藏目标窗口——UIA 子树随之消失，表现为“`focus` 之后 `find` 返回 `count:0`、`windows` 里该窗口 `visible=false`”。修法：桥编成 `/target:winexe`（本就没有控制台），插件 `spawn` 明确 `windowsHide: false`，`focus` 里改用 `SetWindowPos(..., SWP_SHOWWINDOW|SWP_NOACTIVATE)` 而不是 `ShowWindow`（`SWP_SHOWWINDOW` 不受 STARTUPINFO 替换影响）。用 message-only 窗口“吸收”掉第一次 `ShowWindow` 的做法无效——替换是按窗口而非按进程。
- **winexe 没有控制台**：`Console.OutputEncoding = …` 这类调用会抛异常，必须 `try/catch`；但标准输出被父进程重定向时照常可用，所以插件仍能拿 JSON。
- **winexe 的 stdout 默认不是 UTF-8**：没有控制台时 .NET 会退回 ANSI 代码页（本机是 CP936），于是重定向出来的 JSON 里所有中文窗口标题/控件名都成了乱码（`"让dsh操控…"` → `"��dsh�ٿ�…"`），按标题选窗口、按中文控件名匹配全部失效。修法：不要走 `Console.Out`，直接 `new StreamWriter(Console.OpenStandardOutput(), new UTF8Encoding(false))`，绕开控制台栈。
- **在 PowerShell 里手动跑 `cu.exe` 可能抓到空输出**：GUI 子系统程序不会阻塞 `&`，管道常常拿不到 stdout。要么 `cmd /c "cu.exe windows > out.json"`，要么 `Start-Process -Wait -RedirectStandardOutput out.json`；插件走的是 `stdio: ["ignore","pipe","pipe"]`，不受影响。

### 为什么“点了没反应”：三个静默失败源

Windows 有三套机制会让注入的输入**无声无息地消失**——`SendInput` 照样返回成功，光标纹丝不动，屏幕毫无变化。这是自动化里最贵的坑：你会开始怀疑应用本身坏了。

| 静默失败源 | 现象 | 判断 | 处理 |
| --- | --- | --- | --- |
| **进程完整性过低** | `SetCursorPos` 返回 False；`SendInput` 返回 1 但指针不动 | `inputcheck` → `integrity: "LOW"` | 引擎必须从**非低完整性**路径运行（见下） |
| **工作站已锁屏** | 同上，且前台窗口是锁屏界面 | `inputcheck` → `locked: true` 且 `inputDesktopName` 不是 `Default`；`session` 会给出 `lockedEvidence` | 解锁屏幕，没有别的办法 |
| **目标进程已提权（UIPI）** | 目标窗口收不到输入 | `inputcheck` → 前台进程提权而引擎没有 | 提权运行目标，或别用提权程序 |

**锁屏这一条最容易误判**：现代 Windows 在 `Default` 桌面上渲染锁屏，所以 `OpenInputDesktop` 明明返回 `Default`、`locked` 曾经也会报 false，而 `SetCursorPos` 照样失败。引擎因此把 `LockApp`/`LogonUI` 当第二个证人，`inputcheck` 里多一个 `lockAppRunning` 字段。

但反过来也要小心：**`LockApp.exe` 常驻并不等于锁屏**。2026-11-19 的实机就是 `locked: true / lockAppRunning: true`，而 `inputcheck` 的 `landed` 是 `true`——光标确实被移动了。所以 v0.14.1 起 `session` 会区分证据强度：输入桌面不是 `Default` 才说"已锁屏"（`lockedEvidence: "input-desktop"`）；只是因为 `LockApp` 在跑则标 `lockedEvidence: "lockapp"`，并明确要求先跑一次 `inputcheck` 再下结论。判据永远是"事件到没到屏幕"，不是"哪个进程在跑"。

**低完整性这一条尤其隐蔽**：DSH 给会话工作目录打上 `Low Mandatory Level` 标签（它沙箱的一部分），而 Windows 会**用镜像文件的完整性标签启动进程**。于是从 `F:\Dharness\...\bin\cu.exe` 启动的引擎是 LOW 进程——它能看屏幕、能读控件树，但 `SetCursorPos`/`SendInput` 一律被丢弃。

所以插件默认不直接跑包里的 `bin/cu.exe`，而是先把它**复制到 `%LOCALAPPDATA%\dsh-computer-use\engine\<size-mtime>\cu.exe` 再执行**（正常完整性），必要时才回退到原路径。想验证：

```powershell
computer action=inputcheck          # -> landed:true, integrity:"MEDIUM"
```

## 操作协议

`docs/PLAYBOOK.md` 把实操中踩过的坑固化成流程：五分钟预检、坐标只用一个空间、先用语义入口（hover/find/invoke）再动像素、绝不隐式改窗口状态、报告只写“做了什么、测到什么”。**新任务开始前先读它。**

## 构建与自测

```powershell
# 重新编译 C# 桥（用系统自带 .NET Framework 编译器，无需 SDK / NuGet / 联网）
powershell -ExecutionPolicy Bypass -File .\build.ps1

# 连测试夹具一起编（test/target/target.exe，供 input.mjs 用）
powershell -ExecutionPolicy Bypass -File .\build.ps1 -Test

# 插件契约单测：mock 掉引擎，校验 argv 映射/窗口解析/安全闸/干跑/长文本落盘/计划启动（100 项）
node test\run-tests.mjs

# 真机观察链路：真插件 + 真 spawn + 真 cu.exe，只读不注入
node test\e2e.mjs

# 文本通道与裁剪：launch cmd → readtext → waittext → trim（只读，不抢焦点）
node test\readtext.mjs
# 只读：ocr 读控制台 + 帧体检（需要 tesseract，没有就自动跳过）
node test\ocr.mjs

# 一次调用跑完一份计划：wait → type → key → wait → read（会抢焦点，1.2 秒）
node test\plan.mjs

# 面板：token、白名单、截图路由、目录外文件拒绝、前缀挂载与宿主挂载（27 项）
node test\panel.mjs

# 跨机执行：vmrun/ssh 的 argv、真实退出码、二进制传输、stdout 截断（38 项，纯单测不抢焦点）
node test\targets.mjs

# 应用画像：匹配语义、别名替换、profile+task 重放、错误信息（42 项，纯单测不抢焦点）
node test\profiles.mjs

# 画像的真机链路：launch cmd → profile 的 match 解析出真 hwnd → 重放只读计划（7 项，不抢焦点、不注入）
node test\profile-live.mjs

# 控制台闭环：launch cmd → 打字 → 回车 → 校验命令真的执行了（会抢焦点）
node test\console.mjs

# 输入闭环：中文/emoji 打字 → 坐标点击 → 回读文件 → UIA SetValue/Invoke → 再回读
node test\input.mjs
```

最近一次全量结果：`134 passed, 0 failed`；`profiles.mjs` 42 项全过（匹配语义、`profiles` 不泄漏计划正文、`state.profile` 命中/未命中、`run` 用 `profile`+`task` 自动定位窗口并解析 `{{alias}}`、未知画像/计划/窗口的报错）；`profile-live.mjs` 7 项全过（真机：`launch cmd` → profile 的 `match` 解析出 hwnd → 重放只读计划 → `readtext` 读到 400 字符，`strategy=uia`）；`targets.mjs` 38 项全过（vmrun/ssh argv、guest 真实退出码、二进制 `get` 字节一致、stdout 只留尾部）；`e2e.mjs` 观察链路 OK；`readtext.mjs` 10 项全过（控制台读到 400 字符、`waittext` 109 ms 命中提示符、`--trim` 1440×720 → 483×720 且 PNG 678 KB → 12 KB）；`plan.mjs` 9 项全过（5 步计划一次调用 108 字节 transcript、`done 5/5 in 1.2s`、失败时带上窗口尾部文本）；`panel.mjs` 27 项全过（无 token 401、目录外文件 404、`kill` 403、前缀挂载、客户端 bundle 注册 tab 与 settings section）；`console.mjs` 七步全过；`input.mjs` 两条闭环都 `MATCH`（`SendInput` 键盘与 UIA `SetValue`/`Invoke` 各自独立验证）。

CI（`.github/workflows/ci.yml`，windows-latest）每次 push 会自动跑「编译桥 → 断言 `bin/cu.exe` 存在 → 123 项契约单测 → 38 项跨机适配单测 → 42 项画像单测」，并把编出来的 `cu.exe` 作为 artifact 上传。它只跑不抢焦点的部分，真机注入脚本 `console.mjs` / `input.mjs` / `plan.mjs` 需要人盯着，不进 CI。

`bin/cu.exe` 也可以单独用，方便排查（它自己就是命令行程序，JSON 打到 stdout）：

```powershell
.\bin\cu.exe info
.\bin\cu.exe windows
.\bin\cu.exe shot --out t.png --maxw 1280
.\bin\cu.exe tree --hwnd 123456 --depth 6
.\bin\cu.exe click --x 800 --y 400
```

## 已知限制

- **Chromium/Electron 系窗口默认不暴露可访问性树**：DSH 自己的窗口 `snapshot` 只有寥寥几个节点。要么用 `--force-renderer-accessibility` 启动目标应用，要么对这类窗口用截图 + 坐标点击。
- `type` 走 `KEYEVENTF_UNICODE`，绕开输入法与键盘布局，但需要目标窗口接受普通 `WM_CHAR`；少数自绘输入框（部分游戏、远程桌面）会吞掉。
- 只支持单会话桌面（当前用户），不支持服务会话、锁屏后操作、多用户切换。
- 高 DPI 已按 monitor-aware（`SetProcessDpiAwarenessContext(-4)`）处理，坐标一律物理像素；如果用户改了缩放，脚本里写死的坐标要重取。
- 剪贴板走 `Clipboard.SetText`，遇到被其他进程独占会短暂重试后失败。
- **`launch` 对“刚编译出来的无签名 exe”会报 1223（`操作已被用户取消`）**：这是 Windows 的 Smart App Control / ASR 在拦，不是权限或会话问题。签名程序、系统程序（`notepad.exe`、`cmd.exe`）都正常；自己 build 的测试靶请先用别的途径启动（本项目测试脚本直接容忍失败）。
- `notepad.exe`/`calc.exe` 这类打包应用（packaged app）走激活代理启动，`launch` 拿得到 pid 但没有独立顶层窗口，`hwnd` 可能是 0；要操作它们得先用 `windows` 找到真正的窗口。
- 不做 UAC 提权：操作以管理员身份运行的程序需要 DSH 本身以管理员启动。

## 目录

```text
dsh-computer-use/
├─ lib/index.js          # 插件：手写 JSON Schema 参数 + 安全闸 + argv 映射（零第三方导入）
├─ lib/targets.js        # 跨机执行：vmrun / ssh 两种后端 + 二进制 put/get
├─ lib/panel.js          # 面板请求处理器（宿主挂载 / 回环挂载共用）
├─ lib/panel-html.js     # 面板单页（字符串，无构建）
├─ lib/client.js         # DSH 客户端标签页（手写 IIFE，右侧栏 iframe）
├─ cordis.patch.yml      # bundle patch + 默认配置
├─ bridge/cu.cs          # C# 桥源码（单文件，C# 5 语法，csc.exe 可编）
├─ bin/cu.exe            # 编译产物（随仓库提供，装完即用）
├─ build.ps1             # 重新编译（-Test 连测试夹具一起编）
├─ test/                 # 100 项单测 + 只读/闭环脚本 + mock + WinForms 夹具
└─ docs/                 # README 用图
```

## License

[MIT](LICENSE) © 2026 Wonderow666
