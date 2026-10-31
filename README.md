# dsh-computer-use

[![CI](https://github.com/Wonderow666/dsh-computer-use/actions/workflows/ci.yml/badge.svg)](https://github.com/Wonderow666/dsh-computer-use/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](https://github.com/Wonderow666/dsh-computer-use/blob/main/LICENSE)

> 让 [DeepSeek Harness](https://github.com/deepseek-ai/dsh)（DSH）真正“动手”操作 Windows 桌面的原生插件：看屏幕、读控件树、点击、打字、启动/关闭软件。全部能力收在一个 `computer` 工具里，底层是一个 41 KB 的单文件 C# 桥 `bin/cu.exe`（Win32 + UI Automation，无第三方依赖、无 Python、不需要视觉模型）。

> **English TL;DR** — a native DSH plugin that gives the agent control of a Windows desktop through a single `computer` tool: 19 actions covering screen capture, the UI Automation tree, SendInput mouse/keyboard injection, UIA pattern invocation (`SetValue`/`Invoke` with no focus or pixel dependency), app launch/kill, clipboard and process listing. The engine is one 41 KB C# file compiled by the .NET Framework compiler that ships with Windows — no Python, no MCP hop, no service to keep alive, no vision model required (screenshots are written to disk and returned as paths, then read by whatever vision tool the host has). Input is guarded three times: a configurable per-process blocklist, a hard "target must be foreground" refusal, and a dual-witness point-ownership check before every click. MIT, Windows 10/11, DSH 0.2.x.

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

`dsh` 就是 DSH 自带的启动器，例如
`& "$env:LOCALAPPDATA\Programs\DeepSeek Harness\resources\runtime\cli\bin\dsh.cmd" plugin --profile desktop add ...`。

仓库里带了编译好的 `bin/cu.exe`，**装完即用，不需要任何构建工具**。想自己编（或改了 `bridge/cu.cs`）见下面的“构建与自测”。

重启后模型侧多出一个 `computer` 工具。插件配置在 `cordis.patch.yml`（`blockedProcesses`、`refuseFullscreenForeground`、`allowProcessControl`、`timeoutMs`、`enginePath`、`artifactsDir`），profile 自己的 `cordis.patch.yml` 可以按 id 覆盖这些字段。

## 工具面（单一 `computer`，19 个 action）

| 类别 | action | 返回 |
| --- | --- | --- |
| 观察 | `info` | 屏幕/虚拟桌面尺寸、每台显示器 dpi 与缩放、光标、前台窗口 |
| | `windows` / `procs` | 顶层窗口（hwnd/title/class/process/pid/rect/foreground）或进程列表 |
| | `screenshot` | PNG 路径 + `srcW/srcH/w/h/scale`，默认缩到 1600 宽；支持 `region` 裁剪 |
| | `snapshot` | UI Automation 控制树，元素 id 形如 `0.2.1`，带类型与矩形 |
| | `find` / `hit` | 按名称找控件 / 查某坐标下是什么窗口与控件 |
| 输入 | `click` `move` `scroll` `drag` | SendInput 注入，物理像素坐标，可选 `hwnd`/`title` 定位窗口 |
| | `type` `key` | Unicode 键入（中文安全）；`key` 走组合键 `"ctrl+shift+s"`，逗号分隔连续按键 |
| | `invoke` | 通过 UIA 的 Invoke/Toggle/Select/SetValue 模式驱动控件，不依赖焦点与像素 |
| 生命周期 | `launch` `kill` `focus` `wait` | 启动进程（可带参数/工作目录）、结束进程、置前、等待 |
| 杂项 | `clipboard` | 读写剪贴板 |

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

## 构建与自测

```powershell
# 重新编译 C# 桥（用系统自带 .NET Framework 编译器，无需 SDK / NuGet / 联网）
powershell -ExecutionPolicy Bypass -File .\build.ps1

# 连测试夹具一起编（test/target/target.exe，供 input.mjs 用）
powershell -ExecutionPolicy Bypass -File .\build.ps1 -Test

# 插件契约单测：mock 掉引擎，校验 argv 映射/窗口解析/安全闸/干跑/长文本落盘（49 项）
node test\run-tests.mjs

# 真机观察链路：真插件 + 真 spawn + 真 cu.exe，只读不注入
node test\e2e.mjs

# 控制台闭环：launch cmd → 打字 → 回车 → 校验命令真的执行了（会抢焦点）
node test\console.mjs

# 输入闭环：中文/emoji 打字 → 坐标点击 → 回读文件 → UIA SetValue/Invoke → 再回读
node test\input.mjs
```

最近一次全量结果：`49 passed, 0 failed`；`e2e.mjs` 观察链路 OK；`console.mjs` 七步全过；`input.mjs` 两条闭环都 `MATCH`（`SendInput` 键盘与 UIA `SetValue`/`Invoke` 各自独立验证）。

CI（`.github/workflows/ci.yml`，windows-latest）每次 push 会自动跑「编译桥 → 断言 `bin/cu.exe` 存在 → 49 项契约单测」，并把编出来的 `cu.exe` 作为 artifact 上传。它只跑不抢焦点的部分，真机注入脚本 `console.mjs` / `input.mjs` 需要人盯着，不进 CI。

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
├─ cordis.patch.yml      # bundle patch + 默认配置
├─ bridge/cu.cs          # C# 桥源码（单文件，C# 5 语法，csc.exe 可编）
├─ bin/cu.exe            # 编译产物（随仓库提供，装完即用）
├─ build.ps1             # 重新编译（-Test 连测试夹具一起编）
├─ test/                 # 49 项单测 + 三个真机闭环脚本 + mock + WinForms 夹具
└─ docs/                 # README 用图
```

## License

[MIT](LICENSE) © 2026 Wonderow666
