# 第一次用：把 v0.14 换成现在这一版，然后按顺序走一遍

工具清单是**会话创建时**装配的，所以升级之后必须重启 DSH 并开一个新会话，旧的会话看不到
`session`、`ocr`、`paint`、`browser`、`assert` 这些新东西。

## 0. 换上新版（一次性）

```powershell
dsh plugin --profile desktop remove dsh-computer-use
dsh plugin --profile desktop add link:F:\Dharness\plugins\dsh-computer-use
```

然后重启 DSH，开一个新会话。判断是否生效：让模型调用 `computer` 的 `action: "session"`，
返回里应该有 `lockedEvidence` 与 `hints`。

## 1. 开场只花一次调用

```
computer action=session
```

一次拿到：前台窗口、屏幕尺寸、DPI、锁屏证据、模态框数量、当前画像。桌面若是锁的，它会说
`lockedEvidence` 而不是吓唬人；仍不放心就 `action=inputcheck`（一次指针移动，看事件到没到屏幕）。

## 2. 先看，再点，坐标只报一种

```
computer action=screenshot            # 图里看中的点
computer action=click imgx=640 imgy=420
```

`imgx/imgy` 是**截图上的像素**，插件用截图记账（`artifacts/shots.json`）换算成屏幕坐标，
不需要你乘 DPI。要更高层的就用 `see` → 图上有 1..N → `clicknum N`；要按名字就 `click name="保存"`。

## 3. 网页别点像素

```
computer action=browser browser="open"
computer action=browser browser="goto https://example.com"
computer action=browser browser="text h1"
computer action=browser browser="fill input[name=q] | dsh"
computer action=browser browser="click button[type=submit]"
```

网页流程可以整段写进计划（`page goto …` / `page wait …` / `page click …`），失败的页面不用重来。

## 4. 计划、配方、验证

```
computer action=run profile="notepad" task="start"
computer action=run profile="notepad" task="write" vars={ "text": "hello dsh" }
computer action=run profile="edge-console" task="search" vars={ "q": "dsh" }
```

配方在 `profiles/recipes.json`（notepad / eclipse / wps / edge-console / packet-tracer），
每个都是真机跑过的。自己写的计划先 `dryRun: true` 看步骤与警告，再真跑：

```
computer action=run plan="type hello\nassert /hello/ 4000"
```

`assert` 不成立时，失败块自带 `last ok` / `screen` / `next` 三行，细节留在
`artifacts/failures/<时间>/`，用 `action="failures"` 翻历史。

## 5. 什么时候别用它

有 CLI / API 的事优先走命令行；`computer` 留给"只有界面"的那一步。这条比任何参数都省 token。
