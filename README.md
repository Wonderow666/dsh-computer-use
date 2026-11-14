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

重启之后**还要开一个新会话**：工具清单在会话创建时装配，正在进行中的对话不会热更新，所以“重启了但老会话里依旧没有 `computer`”是正常现象，不是插件没装上（判断依据：`DSH_COMPUTER_USE_DEBUG=1` 会让插件在挂载时把 `apply` + `registered tool 'computer'` 打到 stderr）。

`dsh` 就是 DSH 自带的启动器，例如
`& "$env:LOCALAPPDATA\Programs\DeepSeek Harness\resources\runtime\cli\bin\dsh.cmd" plugin --profile desktop add ...`。

仓库里带了编译好的 `bin/cu.exe`，**装完即用，不需要任何构建工具**。想自己编（或改了 `bridge/cu.cs`）见下面的“构建与自测”。

重启后模型侧多出一个 `computer` 工具。插件配置在 `cordis.patch.yml`（`blockedProcesses`、`refuseFullscreenForeground`、`allowProcessControl`、`timeoutMs`、`enginePath`、`artifactsDir`），profile 自己的 `cordis.patch.yml` 可以按 id 覆盖这些字段。

## 工具面（单一 `computer`，30 个 action）

| 类别 | action | 返回 |
| --- | --- | --- |
| 预检 | `inputcheck` | 移动光标再复位，回报 `landed`/`integrity`/`locked`/`pointerDrifting` 与一句结论。**动手前先跑它** |
| | **`state`** | 一次调用给出“我现在能不能动手”：`locked`/`lockAppRunning`/`privileged`/`foreground`/目标窗口 `geom`/**该应用的模态框计数**（实测 351–547 字节） |
| 观察 | `info` | 屏幕/虚拟桌面尺寸、每台显示器 dpi 与缩放、光标、前台窗口、`locked`、输入桌面名 |
| | `windows` / `procs` | 顶层窗口（hwnd/title/class/process/pid/rect/foreground）或进程列表 |
| | **`ui`** | **紧凑控件清单**：只列可操作控件（按钮/输入框/下拉/菜单/列表…）与短文本，带 `value`，默认 60 条上限。同一窗口比 `snapshot` 小 5–7 倍 |
| | `screenshot` | PNG 路径 + `srcW/srcH/w/h/scale`，默认缩到 1600 宽；支持 `region` 裁剪、**`trim`（按内容裁剪）** 与 **`minBytes`（拒绝空白图）** |
| | `snapshot` | UI Automation 控制树，元素 id 形如 `0.2.1`，带类型与矩形（**只在需要结构/父级关系时才用**） |
| | `find` / `hit` | 按名称找控件 / 查某坐标下是什么窗口与控件 |
| | `geom` | 窗口矩形 + **客户区原点** + dpi，几何断言的唯一来源 |
| | `modals` | 枚举可见的 `#32770` 对话框、带 owner 的弹窗、被禁用的顶层窗口（“输入被吞”的第一嫌疑人） |
| | `hover` | 移到目标控件驻留后读 UIA 的 name/helpText/acceleratorKey 与 `tooltips_class32` 文本 |
| | **`readtext`** | 把窗口的文字读回来（UIA Text/Value → win32 `WM_GETTEXT` 兜底），返回 `text`/`strategy`/`sources` |
| | **`waittext`** | 轮询 `readtext` 直到正则命中，返回 `matched`/`waitedMs`/`text`；超时给出已读到的尾部文本 |
| 批量 | **`run`** | **一次调用执行整份计划**（`wait`/`type`/`key`/`click`/`clickrel`/`invoke`/`read`/`shot`），只回每步一行 transcript；输入前自动置前 |
| 输入 | `click` `move` `scroll` `drag` | SendInput 注入，物理像素坐标；支持 `hwnd`/`title` 定位与 **`relx`/`rely`（客户区相对坐标）** |
| | `type` `key` | Unicode 键入（中文安全）；**`type` 可加 `verify`** 回读校验；`key` 走组合键 `"ctrl+shift+s"` |
| | `invoke` | 通过 UIA 的 Invoke/Toggle/Select/SetValue 模式驱动控件，不依赖焦点与像素 |
| 生命周期 | `launch` `kill` `focus` `wait` | 启动进程（可带参数/工作目录）、结束进程、置前、等待 |
| 杂项 | `clipboard` | 读写剪贴板 |

`click`/`move`/`drag` 会**验证注入是否真的落地**：注入后读回光标，偏差超过 2px 就报错并附诊断，而不是假装成功。窗口移动/缩放后坐标失效的问题，用 `relx`/`rely` 解决——它们是相对目标窗口客户区的偏移，引擎每次实时解析成屏幕坐标。

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
| **工作站已锁屏** | 同上，且前台窗口是锁屏界面 | `inputcheck` → `locked: true`（输入桌面不是 `Default`，或 `LockApp`/`LogonUI` 在跑） | 解锁屏幕，没有别的办法 |
| **目标进程已提权（UIPI）** | 目标窗口收不到输入 | `inputcheck` → 前台进程提权而引擎没有 | 提权运行目标，或别用提权程序 |

**锁屏这一条最容易误判**：现代 Windows 在 `Default` 桌面上渲染锁屏，所以 `OpenInputDesktop` 明明返回 `Default`、`locked` 曾经也会报 false，而 `SetCursorPos` 照样失败。现在引擎会同时看 `LockApp`/`LogonUI` 进程是否存在，`inputcheck` 里多一个 `lockAppRunning` 字段；两个证人一致才敢说“没锁”。

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

# 插件契约单测：mock 掉引擎，校验 argv 映射/窗口解析/安全闸/干跑/长文本落盘（71 项）
node test\run-tests.mjs

# 真机观察链路：真插件 + 真 spawn + 真 cu.exe，只读不注入
node test\e2e.mjs

# 文本通道与裁剪：launch cmd → readtext → waittext → trim（只读，不抢焦点）
node test\readtext.mjs

# 一次调用跑完一份计划：wait → type → key → wait → read（会抢焦点，1.2 秒）
node test\plan.mjs

# 面板：token、白名单、截图路由、目录外文件拒绝、前缀挂载与宿主挂载（22 项）
node test\panel.mjs

# 控制台闭环：launch cmd → 打字 → 回车 → 校验命令真的执行了（会抢焦点）
node test\console.mjs

# 输入闭环：中文/emoji 打字 → 坐标点击 → 回读文件 → UIA SetValue/Invoke → 再回读
node test\input.mjs
```

最近一次全量结果：`71 passed, 0 failed`；`e2e.mjs` 观察链路 OK；`readtext.mjs` 10 项全过（控制台读到 400 字符、`waittext` 109 ms 命中提示符、`--trim` 1440×720 → 483×720 且 PNG 678 KB → 12 KB）；`plan.mjs` 9 项全过（5 步计划一次调用 108 字节 transcript、`done 5/5 in 1.2s`、失败时带上窗口尾部文本）；`panel.mjs` 15 项全过（无 token 401、目录外文件 404、`kill` 403、带面板时插件照常 `info`）；`console.mjs` 七步全过；`input.mjs` 两条闭环都 `MATCH`（`SendInput` 键盘与 UIA `SetValue`/`Invoke` 各自独立验证）。

CI（`.github/workflows/ci.yml`，windows-latest）每次 push 会自动跑「编译桥 → 断言 `bin/cu.exe` 存在 → 71 项契约单测」，并把编出来的 `cu.exe` 作为 artifact 上传。它只跑不抢焦点的部分，真机注入脚本 `console.mjs` / `input.mjs` / `plan.mjs` 需要人盯着，不进 CI。

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
├─ lib/panel.js          # 面板请求处理器（宿主挂载 / 回环挂载共用）
├─ lib/panel-html.js     # 面板单页（字符串，无构建）
├─ lib/client.js         # DSH 客户端标签页（手写 IIFE，右侧栏 iframe）
├─ cordis.patch.yml      # bundle patch + 默认配置
├─ bridge/cu.cs          # C# 桥源码（单文件，C# 5 语法，csc.exe 可编）
├─ bin/cu.exe            # 编译产物（随仓库提供，装完即用）
├─ build.ps1             # 重新编译（-Test 连测试夹具一起编）
├─ test/                 # 71 项契约单测 + 只读/闭环脚本 + mock + WinForms 夹具
└─ docs/                 # README 用图
```

## License

[MIT](LICENSE) © 2026 Wonderow666
