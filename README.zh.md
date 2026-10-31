---
description: "DSH 的 Claude 风格 Ultra 模式：最高推理强度 + Claude 的常驻多智能体编排。"
kind: "package-bundle"
---

# dsh-claude-ultra

[English](README.md) | 中文

## 摘要

为 DSH 加入 Claude 的 **Ultra** 模式。Ultra 是 [Codex 强度切换器](https://github.com/AndyZh0/dsh-codex-effort-switcher/blob/master/README.zh.md)滑条上、位于模型自有档位之上的第五档：选中后本会话以模型最高推理强度运行，并保持多智能体编排常驻，携带的正是 Claude Code 在 ultracode 开启时携带的那段指令。

本包是该模式的 Host 半与浏览器半。浏览器半读取切换器的 `codexModelTiers` 客户端服务，因此**同一 profile 中必须装有 `dsh-codex-effort-switcher` 0.2.0 或更新版本**。没有切换器时本包不贡献任何档位，输入框保持出厂选择器。

## 目录

- [安装](#安装)
- [使用](#使用)
- [工作原理](#工作原理)
- [Claude 源码依据](#claude-源码依据)
- [兼容性](#兼容性)
- [已知限制与后续工作](#已知限制与后续工作)
- [开发与验证](#开发与验证)

-----

<a id="安装"></a>
## 安装

在本目录内构建；开发依赖与产物都留在这里。使用 DSH 支持的 Node.js 版本。

```powershell
npm install --ignore-scripts --workspaces=false
npm run build
npm pack
dsh plugin --profile <profile> add "./dsh-claude-ultra-0.1.6.tgz"
```

装进你实际使用的 profile。`dsh plugin add` 会追加 bundle 行并在 profile 目录内跑 pnpm。profile 在启动时组合 bundle 行，所以之后要重启应用；`patchReload: live` 只重载 patch 与 config，不挂载新的 bundle 行。

`dsh --profile web --dump-config` 应列出 `dsh-codex-effort-switcher` 与 `dsh-claude-ultra`，且不打印 "incompatible"。卡片会在 Max 之上出现第五格 **Ultra**。

重装同一版本对 pnpm 是空操作：重新构建后要先 `dsh plugin --profile web remove dsh-claude-ultra` 再装，否则 profile 仍在用上一份 `lib/client.js`。

<a id="使用"></a>
## 使用

点击模型 chip，选一个声明了推理强度的模型，点最后一格。触发器显示 `<模型> Ultra`，滑条进入紫色顶层皮肤。

下一次模型请求会携带映射后的强度，并在系统提示词里带上一段：Claude 的 ultracode 指令 + DSH 智能体团队用法说明。该模式对后续请求与子智能体持续生效。选任一更低档位（在本卡片或 `/model` 里）会让下一次组装改为materialize Claude 的退出文案。

prompt 里出现整词 `ultracode` 时，即使没有选中该档位，那一轮也会被纳入编排 —— 这就是 Claude 的关键字触发器。出现 `ultrathink` 则把那一轮的强度提到模型顶层，且不动滑条档位。两个关键字各带自己的 section；档位激活时，它们与常驻提醒并存。

两个关键字用的是 Claude 各自的匹配器，**两者并不相同**。`ultracode` 走那套带跨度扫描的匹配（同一套也驱动 Claude 的输入框高亮）：以斜杠指令开头的 prompt 会被忽略，引号、反引号、括号内的关键字同样被忽略，紧贴路径分隔符或文件扩展名的也不算。`ultrathink` 则走它提醒发送处那个朴素的 `/\bultrathink\b/i`，因此带引号、反引号、斜杠前缀或点号的 `ultrathink` 都会触发，而带词形变化的不会。

模式是持久的：它由已记录的 `system/message` 折叠进 `claudeUltraMode` 会话投影，因此刷新或恢复会话都能在没有新请求的情况下还原第五格。

<a id="工作原理"></a>
## 工作原理

1. 切换器把该档位追加到它的强度选项上。模型声明了推理强度时 `available(model)` 为真；`effort(model)` 优先映射 `max`，否则取声明中最高的非 `off` 档。
2. 应用该档位时先走标准模型选择路径提交这个强度。Host 收到的是与 `/model` 完全相同的 `session.selectModel`；不存在第二条选择路径。
3. 浏览器随后以会话、provider、model、映射强度调用 `/api/dsh-claude-ultra/arm`。Host 通过 `llm.resolveModelInfo` 与 `llm.resolveCallConfig` 校验该路由，并为该会话存下一份内存中的 arm。
4. 下一次系统提示词组装把 arm 与该会话的 pending 或 last-used 选择比对。命中则 materialize 进入文案；在进入快照之后又发生选择则 materialize 退出文案；自身没有快照的子智能体继承处于激活状态的父级。
5. 承载这些 section 的 `system/message` 会被记录。`claudeUltraMode` 投影把该文本、`model/selection` 事件、以及最新一条手打 prompt 折叠为 `{ mode, dirty, keyword }`，其中 `mode` 为 `'full'`、`'still'`、`'off'` 或 `null`，`keyword` 记录该 prompt 是否含 ultracode 关键字。档位的激活面是"处于进入态且不 dirty"，所以选低档会立即让第五格熄灭，而下一次请求仍会收到退出文案。
6. `agent/request` 监听器在它武装的那次请求之后消费 arm；之后的选择、智能体销毁或会话拆除都无法复用陈旧的意图。

### 为什么用系统提示词 section

由 `system-prompt/assemble` 瀑布追加的 section 会被组装与之后的 runtime-context 刷新保留，对模型可见，并被记录进 system message。`systemPrompt.context()` 的贡献默认是可选的，作用域内只要有抑制器就会被丢弃，那会让模式对模型不可见。该 section 会一直保留，除非某个已注册 section 设了 `complete: true`；出厂的 Standard preset 不会。

### 不依赖任何 DSH 包

Host 半不 import 任何 `@deepseek-ai/*` 模块：它通过 `src/ports.ts` 的结构化视图从注入的 context 上读取所需服务。这不只是打包上的便利 —— npm 上已发布的 `@deepseek-ai/dsh-llm`、`-session`、`-system-prompt`、`-session-projection` 版本（0.0.1-rc.1）与运行中的运行时（checkout 是 0.2.0-rc.2，桌面运行时是 0.2.1-rc.5）并不匹配，根本装不上。`zod` 是唯一的运行期依赖，且已内联进 `lib/index.js`。

<a id="claude-源码依据"></a>
## Claude 源码依据

提醒文案逐字取自 `@anthropic-ai/claude-code` 2.1.316 的 `bin/claude.exe` —— 也就是 Bun 单文件可执行程序内嵌的那份 JavaScript bundle。该附件表起始于字节偏移 `296490096`；强度标尺与 `ultracode` 别名分别在 `282594834` 与 `286520088`。

Claude 的 ultracode 是一个会话级开关，与强度档位并列在强度滑条上（`effortSlider:toggleUltracode`，绑定 Tab），并在作为强度值传入时映射到 `xhigh`（`{ ultracode: "xhigh" }`）。DSH 模型声明自己的档位，所以本插件取模型的顶层档位 —— DeepSeek-V41-Flash 上是 `max`。

逐字保留，仅一处替换：DSH 没有 Workflow 工具，因此 `the Workflow tool` 改为 `the 'subagent' and 'subagent_fork' tools`，`the workflow authoring reference` 改为 `the DSH agent-team usage notes below`。其余（包括破折号与结尾句）一字未改。

| Claude 附件 | 本插件使用的文本 |
|---|---|
| `ultra_effort_enter`（full） | Ultracode is on: optimize for the most exhaustive, correct answer — not the fastest or cheapest. Use the 'subagent' and 'subagent_fork' tools on every substantive task; token cost is not a constraint. See the **Ultracode** section and quality patterns in the DSH agent-team usage notes below. Solo only on conversational/trivial turns. |
| `ultra_effort_enter`（sparse） | Ultracode is still on — use the 'subagent' and 'subagent_fork' tools; see the Ultracode section of the DSH agent-team usage notes below. |
| `ultra_effort_exit` | Ultracode is off — the standard opt-in rule for multi-agent delegation applies again. Only delegate when the user has explicitly asked for sub-agents, delegation, or parallel agent work; a task that would merely benefit from parallelism does not count. |
| `workflow_keyword_request` | The user included the keyword "ultracode", opting this turn into multi-agent orchestration — use the 'subagent' and 'subagent_fork' tools to fulfill the request. |
| `ultrathink_effort` | The user included the keyword "ultrathink", requesting deeper reasoning on this turn. Reason as thoroughly as the task warrants. |

退出文案的第二句复述了 Claude Workflow 工具描述里的 opt-in 规则（`ONLY call this tool when the user has explicitly opted into multi-agent orchestration…`），也就是第一句所指的那条规则。

Claude 的关键字家族里还有 `ultraplan` 与 `ultrareview`，本插件没有实现。它们不属于提醒家族：attachment 表里 Ultra 相关的条目恰好只有四条（`ultrathink_effort`、`workflow_keyword_request`、`ultra_effort_enter`、`ultra_effort_exit`），那两个词属于 Claude 的计划模式与代码审查功能，在这个层面上没有 DSH 对应物。

提醒节奏同样是 Claude 的，取自同一 bundle 里的 attachment 构造器：进入 Ultra 的第一轮发完整文案，之后每 10 条用户 prompt 发一次短文案，模式结束时发一次退出文案，其余轮次**完全不发** section。Claude 的算法是从对话末尾往回找到最近的 Ultra 提醒、再数它之后的用户消息；本插件则用投影里一个可持久化的 prompt 计数来量，两者是同一个数。

<a id="兼容性"></a>
## 兼容性

- 已在 DSH `0.2.1-rc.5`（服务 `web` profile 的桌面运行时）与 `0.2.0-rc.2` checkout 上验证。
- 同一 profile 中的 `dsh-codex-effort-switcher` 0.2.0 或更新版本。
- Web 平台客户端 bundle；Host 半是普通的 bundle patch 行。
- 无 DSH 核心改动、无新会话事件类型：模式走既有的 `system/message`、`user/message` 与 `model/selection` 事件，`SESSION_FORMAT_VERSION` 不变。

<a id="已知限制与后续工作"></a>
## 已知限制与后续工作

- **必须安装切换器。** `dsh-codex-effort-switcher` 必须在同一 profile 中。浏览器半通过 `ctx.get` 而非 `ctx.inject` 读取它的 `codexModelTiers` 服务，因为 pending 的 inject 会被客户端启动审计判为插件加载失败并让整个界面白屏；因此没有切换器的组合能正常加载，只是不贡献任何档位。
- **`ultrathink` 的 boost 会在该轮结束时撤销。** DSH 把强度存在请求头里，之后的每个请求都会继承，所以只改写请求 config 的 boost 会把整个会话永久抬高。轮结束时插件会提交一次选择，把 boost 顶掉的原值还回去；这一步通过 `ctx.get('sessionController')` 而非注入获取，因此没有该服务的组合仍能加载，只是 boost 会持续到该会话下一次选择。用户在 boost 那一轮里自己做的选择会取消这次撤销，而不是被它覆盖。中途排队的 prompt 会在同一个 `turn/end` 丢掉 boost —— 这点与 `ultracode` 的 opt-in 不同，后者由认领该 prompt 的那一轮消费。
- **默认选择会被保存。** 标准 `session.selectModel` 路径同时会把该选择保存为 profile 默认值，因此选中 Ultra 可能把顶层强度留作新会话的默认。保存的是强度而非模式，所以新会话可能以该强度开始却没有 Ultra 的指令。这是切换器共享的选择路径，不是 Ultra 独有的路径。
- **首次请求前 arm 只在内存里。** 选中 Ultra 后立刻刷新页面会丢掉本地格子；首次请求之后由已记录的 system message 还原。
- **卸载会留下历史。** 移除插件会停止新的 Ultra section 并移除第五格，但既有会话已记录的 system prompt 仍含模式文本；恢复该会话会看到旧指令。
- **没有推理强度的模型无兜底。** 模型未声明任何非 `off` 档时该档位隐藏。
- **`complete: true` 的 section 优先。** 注册了 complete section 的 preset 会在瀑布之后替换掉其他所有 section，从而丢掉本段。出厂的 Standard preset 不会。
- **分叉与并发。** 在首次 Ultra 请求之前分叉的会话没有模式；之后分叉会连同其余记录一起继承投影状态。arm 按会话隔离。

<a id="开发与验证"></a>
## 开发与验证

```powershell
npm run typecheck
npm test
npm run smoke
```

`npm test` 会构建 Host bundle 与可被 Node 加载的浏览器 bundle，并对强度映射、arm 存储、投影折叠、锁定的提示词文本、提醒解析、关键字匹配器与其存储、arm 路由的每个分支、浏览器档位跑 266 条断言。每条 spec 都有已记录的负向证明。

`npm run smoke` 是端到端那条通道，也是唯一能证明"接线正确"而不只是"单元正确"的。它把两个插件通过构建好的 CLI 打包安装进一次性的 `DSH_HOME` profile，把夹具提供商指向一个会记录每个请求体的本地 OpenAI 兼容端点，从 checkout 启动 `dsh web`，并用 Microsoft Edge 真实操作卡片。它断言：第五档 Ultra 存在；选中它会把 `reasoning_effort: max` 发上线并带上进入文案；在较低档位下发含 `ultracode` 的 prompt 会改为带上关键字文案；以及该 opt-in 不会延续到下一轮。它需要切换器与本包并排（或用 `DSH_SWITCHER_TGZ` 指向已打包的归档）、构建好的 DSH checkout、以及 Microsoft Edge；证据落在 `.runtime/browser-*`。

一轮对话还会触发一次会话标题请求，它既不带工具也不带强度，所以冒烟测试按工具 schema 来挑选该轮的主请求。

`tests/decode-session.mjs` 读取会话日志，并把它归约成验证关心的逐轮事实。日志是 zstd 帧的拼接，`zstdDecompressSync` 与流式解码器都跨不过帧边界，因此边界由帧魔数定位；解不出的分片会被并入下一片而不是丢弃，这也顺带吸收了被截断的尾部：

```powershell
node tests/decode-session.mjs "$env:USERPROFILE/.dsh/sessions/<project>/<session>/session.v4.jsonl.zstd"
```

`.runtime/no-switcher.overlay.yml` 是一份禁用切换器的 `--patch` 覆盖层，用于复现降级路径：

```powershell
dsh --profile web --patch ".runtime/no-switcher.overlay.yml" --no-open --port 0
```

发布包只含 `lib/`、patch 与两份 README；测试、冒烟与证据都不进归档。

## License

MIT
