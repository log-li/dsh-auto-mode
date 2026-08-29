Status: implemented

# dsh-automode：自主审批插件（借鉴 Nuo-cl/dsh-auto-mode 的设计模式，独立实现）

> 本文档是 dsh-automode 的**当前设计与实现规格**。早前的 `proposed / 待实现 / 审查发现 / 实现确认` 分层已全部落地并合入本文；v0.5.0 审查发现的 7 个 bug、CC 式分类器缺口、熔断器复位缺陷、模型引导改进均已实现，不再单独保留历史 bug 清单。
>
> 2026-08-25 修订：本文档原题「Fork Nuo-cl/dsh-auto-mode 并重构为 dsh-automode」。本插件**并非 fork**——以自身设计为主，借鉴了 Nuo-cl/dsh-auto-mode 与 pi-automode 的思路与模式独立实现；对二者的贡献见下方「致谢与参考」。

## 核心立场

转 TypeScript（与 DSH 生态一致），以**自身设计**为逻辑基础，**参考** Nuo-cl/dsh-auto-mode 与 pi-automode 的决策链、预执行门、熔断器、两阶段分类器等设计模式（借鉴思路，非代码复用），独立实现、减少重写。

## 致谢与参考

本插件为独立实现，**未 fork 任何上游代码库**。设计上借鉴了以下项目，特此致谢：

- **Nuo-cl/dsh-auto-mode**：auto mode 概念、预执行门（pre-execute gate）、裁决缓存、熔断器、deny/allow 频带、CC 式拒绝引导等设计模式。
- **pi-automode**：两阶段分类器、`allowInsideWorkingDirectory`、`$defaults` 规则机制等设计模式。

对外说明建议措辞：`Inspired by Nuo-cl/dsh-auto-mode and pi-automode`。

## 共识（grill 产出）

| 决策 | 选择 |
|---|---|
| 代码库 | 独立实现 dsh-automode；借鉴 Nuo-cl / pi-automode 的设计模式（见「致谢与参考」） |
| npm 名 | `dsh-automode`（无连字符） |
| peerDeps | 精简到最少必需 |
| 语言 | TypeScript |
| 规则体系 | deny（正则硬拒绝）+ allow（前缀 glob 白名单）+ 散文规则给分类器 |
| 读取策略 | 只读工具默认放行，deny 列表里的敏感位置除外 |
| 决策模型 | **二态（allow / reject），无 ask 态**（2026-08-26 定稿：移除三态） |
| 分类器路由 | `classifier.provider` + `classifier.model` 独立配置 |
| pre-execute 门 | 核心差异特性，围栏内外都跑 deny/allow |
| 持久化日志 | JSONL |
| 复盘脚本 | 分析 + 建议 |
| 上游策略 | 先独立维护，后续提 PR |

## 文件结构

```
src/
  index.ts         主入口：preset 管理、审批 answerer、断电器复位、/auto + /auto-status、系统提示影子化
  config.ts        配置 schema（合并两套 + $defaults 机制 + 内置规则清单）
  bands.ts         确定性频带引擎（deny 正则 + allow 前缀 glob + 复合 shell 判定）
  pre-execute.ts   pre-execute 门（真实路径判定、curated allowPaths、分类器预审、断电器跳闸注入）
  classifier.ts    分类器（两阶段 + 鲁棒解析 + reasoningEffort + 诊断日志）
  rules.ts         散文规则匹配（$defaults 展开）
  prompt.ts        提示构造（<recent_user_intent> + 意图权重 + 危险优先）
  cache.ts         裁决缓存（按 tool+command 签名，maxArgsChars）
  breaker.ts       熔断器（3 连续 / 20 总 DENY → 跳闸）
  log.ts           持久化 JSONL 日志（appendDecision）
```

## 决策链

```
工具调用到达
  ├─ [pre-execute 门]（所有工具，第一道防线；仅 auto-mode 会话生效）
  │    ① 只读工具 → 除 deny 列表外直接放行
  │    ② deny 列表（正则）→ 直接拒绝
  │    ③ allow 列表（前缀 glob）→ 直接放行
  │    ④ allowInsideWorkingDirectory → 工作区内文件操作放行（真实 path/symlink 判定）
  │    ⑤ 升级意图 / 越区文件操作 → 裁决缓存命中？→ 分类器预审
  │    ⑥ 其余 → 放行
  └─ [approval/request 路径]
       ① deny rules（散文）→ 拒绝
       ② allow rules（散文）→ 放行
       ③ allowlist → 放行
       ④ 裁决缓存命中 → 复用
       ⑤ 分类器（两阶段：one-token 预筛 → 结构化裁决）
       ⑥ 失败 → failClosed
```

## 关键行为（已实现）

### 两阶段分类器
- `fastFilter`（one-token 预筛）：512 token 预算 + **独立 0/1 数字解析**，避免 reasoning 模型被 token 预算饿死；传入 `classifier.reasoningLevel` 作为 `reasoningEffort`；若路由不支持 effort（dsh-llm 抛 `UNSUPPORTED_REASONING_EFFORT`，或流以 `finish {kind:'error'}` 终结且 `reason.failure.code === UNSUPPORTED_REASONING_EFFORT`）则**安全回退为不传**（`streamTokens` 统一处理，抛异常与 error-finish 两条路径都重试）。
- `classify`（结构化裁决）：鲁棒解析 JSON verdict（**allow / reject 二态**）；失败返回 null → 调用方按 `failClosed` 处理。

### 熔断器
- 3 连续或 20 总 classifier DENY 触发跳闸；跳闸后 auto 暂停，审批转人工。
- **任何一次真实人工决策（allow OR reject）都解除跳闸并清零计数器**（人工参与即打破静默连拒循环）；`cancelled` / `unavailable` 不复位。
- 跳闸瞬间注入 `BREAKER_TRIPPED_HINT`，指示模型**直接在首次尝试就请求 `danger-full-access` 升级**（省去"先试→报错→再升级"往返，立即弹人工窗口）。
- 跳闸/复位分别写 `breaker` / `resume` 事件到 `decisions.jsonl`。

### 模型引导
- deny 时提示模型「尝试更安全方案」；若**没有更安全方案**，则**停止重试并询问用户明确许可**——只有用户明确批准，后续尝试才可能通过（分类器经 `<recent_user_intent>` 读到用户意图）。

### 用户意图
- 分类器经 `<recent_user_intent>`（`renderUserIntent`）读取用户**最近的显式指示**，作为「合法性」强信号；但硬安全边界（泄密/破坏/自身提权沙箱）仍优先。

### 分类器诊断
- `classifier.ts` 把 resolved `provider/model`、底层错误 code/message、以及 `raw` 模型输出写入 **DSH 日志**（不进 decisions.jsonl），用于定位 `classifier returned no verdict` 根因。
- **2026-08-25 增强**：分类器流失败（error-finish 或抛异常）除 DSH 日志外，**同时写入 `decisions.jsonl` 的 `classifier-fail` 事件**（含 `stage` / `effort` / `route` / 错误 message+code / raw 摘要），使「no verdict」可从审计记录直接复盘，不再依赖 DSH 进程内日志。

### 预执行门作用域
- 仅在 `auto-mode` 会话生效；非 auto preset（read-only / workspace-write / danger-full-access）一律放行，不与用户所选沙箱/审批预设冲突。

## 已知问题 / 待办

- **分类器路由解析**：`resolveRoute` 优先级为 `config.classifier → session request header → agent.options`；`classifier.provider/model` 为空时，分类器跟随会话**实际模型**（当前为 DeepSeek），而不是 agent 默认模型。若会话模型本身重/不稳定（reasoning 高开销）导致频繁 `classifier returned no verdict`，建议**固定专用分类器路由**（`classifier.provider/model` 指向支持 `reasoningEffort: off/low` 的轻量非 reasoning 模型，如 `ocg-completions/ox-alpha-free` 或 `ocg/deepseek-v4-flash-vision-exp`）。

## 权限预设图标（2026-08-23 补记）

- **动机**：`auto-mode` preset 在权限选择器里应显示一个 ⚡ 图标（之前靠本机 patch 硬编码进 DSH 客户端 bundle，别人装插件拿不到）。
- **方案（决策）**：**不改造 DSH 源码仓库、不加新插件**。采用"插件声明 + 用户指导"：插件在 `cordis.patch.yml` 的 `presets.auto-mode` 声明 `icon`（内层 SVG path `d`），用户可在 README 指导下改成自己的 logo；是否渲染取决于 DSH 是否支持消费预设 `icon`（原生 DSH 硬编码 glyph 映射、会静默忽略该字段；本机 DSH 经 `dsh-permission-preset-icon.mjs` 补丁支持）。
- **DSH 侧**：`dsh-permission-preset-icon.mjs`——host `PresetSpec`/`PresetOption` 增加 `icon`，client `PermissionSelect` 的 `optionGlyph(option)` 优先读 `option.icon`（画在共享 shieldOutline 内），内置三档仍走硬编码映射作回退。
- **插件侧**：`cordis.patch.yml` 的 `presets.auto-mode` 声明 `icon: 'M9.15 3.4L5.85 8.55H7.95L7.05 12.6L10.45 7.25H8.25L9.15 3.4Z'`（bolt）。未支持该字段的 DSH 优雅忽略。
- **README 指导**（EN + ZH）：写明如何设 `icon`、何时显示、无需改 DSH 源码/加插件。图标纯外观，不渲染时 auto mode 行为不变。
- **⚠️ schemastery `.optional()` 坑**：`dsh-permission-presets` 的 **config schema** 用 `import z from "schemastery"`（非 zod），schemastery 的 `Schema` **没有 `.optional()`**（只有 `.required()`/`.default()`），且 `z.object` 字段**默认可选**。所以补丁**必须写 `icon: z.string()`**，不能写 `icon: z.string().optional()`——后者会让 `static Config = z.object(...)` 在模块加载时抛错，拖垮整个 plugin tree（`dsh web` 起不来）。client 侧的 project schema 用的是 `z$1`（zod），那里 `.optional()` 才合法。

## 路径归属 bug 修复（2026-08-23 补记）

- **现象**：写工作区内部路径（如 `~/.dsh/patches/...`）也会被 pre-execute 分类器拦截（`pre-execute-deny`），尽管 `session.cwd` 记录为 `/Users/logan/.dsh`。
- **根因**：pre-execute 门用的是 `session.cwd`，但 DSH `Session` **没有 `cwd` 访问器**——cwd 在 `session.header.cwd`（`SessionHeader`）。`session.cwd` 恒为 `undefined` → `trustRoots` 永远不会把会话工作区加入 trust roots → `allowInsideWorkingDirectory` 从不把工作区内文件操作当作 in-tree → 全被送进分类器。
- **修复**：`src/pre-execute.ts` 将 `trustRoots(config.allowPaths, session.cwd)` 改为 `session.header?.cwd`。
- **🔎 待诊断——越区写入偶发被 fail-open 放行**：某次 E2E 中，写 `~/Documents`（越区）得到裸 sandbox 拒绝，而非分类器裁决（熔断器未跳闸），疑似分类器分支抛错被 catch 兜底 fail-open，或 `collectPaths` 未识别为越区。**已加诊断**：pre-execute 门新增 `pre-execute-fileop`（记录 `esc/targets/inTree/outOfTree/breaker/cwd`）与 `pre-execute-fail-open`（记录错误 message+stack）到 decisions.jsonl，用于下次 auto 模式复现时定位根因。**防御**：`resolveRoute` 改用 `agent.options?.provider/model`，避免 `agent.options` 缺失时抛错导致 fail-open。

## 分类器 effort 回退缺陷修复（2026-08-25 补记）

- **现象**：auto-mode 会话内所有需要 LLM 分类的动作连续 `classifier returned no verdict` → failClosed 拒绝（08-23 10:15 起反复出现；08-25 17:24–17:25 一次会话内 4 次，主模型同一路由 opencode-go/deepseek-v4-flash 全程正常）。
- **诊断证据**（cldiag 动态插件复刻分类器调用）：
  - 不带 `reasoningEffort`：成功（~900ms，finish=stop，返回 `"0"`）；
  - 带 `reasoningEffort: 'low'`：**0ms 失败**，流以 `finish {kind:'error', reason:{kind:'error', failure:{message:'provider "opencode-go" model "deepseek-v4-flash" does not support reasoning effort "low"', code:'UNSUPPORTED_REASONING_EFFORT'}}}` 终结。
- **根因**：dsh-llm 对「模型不支持 effort」有两种失败形态——配置解析阶段**抛** `UNSUPPORTED_REASONING_EFFORT`（插件 `streamTokens` 的 catch 已处理，重试不传 effort），以及流式调度阶段**以 error-finish chunk 终结**（不抛异常）。后者绕过了插件的 catch 分支：`streamTokens` 直接把 `{text:'', reasonKind:'error'}` 返回，`classify/fastFilter` 见 `reasonKind==='error'` 返回 null，重试逻辑永不触发。配置 `reasoningLevel: low` 让每次调用 100% 命中该路径。
- **修复（已实现）**：
  1. `streamTokens`：**error-finish 视为可重试失败**——凡 `reasonKind==='error'` 且本次尝试带了 effort，`continue` 到下一次无 effort 尝试（与抛异常路径同语义）；同时把 error-finish 也写入 DSH 日志 warn（此前该路径完全静默）。
  2. **详细错误日志**：`ClassifyOptions` 新增 `onAttemptFail` 回调，每次流失败（error-finish 或抛异常）回调 `{stage, effort, failure:{message, code}, raw}`；pre-execute 门与 approval 瀑布两个调用点把它落进 `decisions.jsonl` 的 `classifier-fail` 事件（`event/stage/effort/route/detail`）。
- **验证**：cldiag 仿真「effort-low 失败 → 无 effort 重试」对真实 provider 成功返回 verdict `"0"`；`npm run build` + `npm test` 通过。运行中的 dsh 进程需重启后加载新 lib 生效。
- **遗留建议 → 已决定（2026-08-25）**：默认 `classifier.reasoningLevel` 改为 **`off`**（显式关闭分类器 reasoning）。实测（cldiag 复刻，opencode-go/deepseek-v4-flash，fast512 与 full2048 两档）：`off` 与不传 effort 均 **~1–1.7s 返回、无 reasoning 块、不超时**——「不给 effort 会导致过度思考/超时」不成立；`off` 同时省掉每次的无效首试。代码侧 error-finish 回退仍保留，其他路由可继续用 low/medium/high。

## 提权人工弹窗触发策略与 breaker 计数修复（2026-08-25 补记）

- **用户定稿策略**：普通操作由分类器自动裁决；**沙箱提权（sandbox_permissions）的「人工弹窗」只在 breaker 跳闸后出现**——即 3 次连续分类器拒绝或会话累计 20 次拒绝之后，提权请求强制走人工审批（弹窗由用户拍板），而非每次提权都弹窗。分类器在跳闸前仍按提示词裁决提权（自我扩权 → 拒绝）。
- **暴露的 bug**：重复提权场景下 breaker 根本跳不了闸——**裁决缓存命中的 DENY（`a prior identical action was judged unsafe`）不计入 breaker**（连续与总计都不计），且中间任何一次 allow 会清零连续计数。观测会话（2026-08-25 09:54–09:56）中模型连续 4 次提权被拒，breaker 从未触发，人工弹窗永远不来，模型只能空转。
- **修复**：`pre-execute.ts` 与 `index.ts` 的 **cache-DENY 分支同样调用 `breaker.countDeny`**（计入连续与总计），跳闸时与普通 reject 分支一致：写 `breaker` 事件、注入 `BREAKER_TRIPPED_HINT`（提示模型直接请求提权 → 人工审批）。修复后上述场景第 3 次缓存/裁决拒绝即跳闸 → 提权进入人工弹窗。
- **验证**：`npm run build` + `npm test` 通过；重启后可在 auto 会话复现「重复提权 3 次 → 弹窗」。

## 风险导向分类 + 用户意图上下文修复（2026-08-25 补记）

- **用户定稿**：**明显无危险、可逆的操作应自动放行**（例：编辑 git 仓库内的 skill 文件）。分类器应**按动作实际风险**裁决（可逆性 + blast radius + 用户对齐），不再因「请求提权」这一机制本身一刀切拒绝。
- **诊断结论**（2026-08-25 实锤）：该场景被拒的根因不是 deny 正则（未命中），而是 `prompt.ts` 把「agent 自我扩权」列进不可覆盖 danger 清单——分类器从不评估动作本身（git 可回退、低风险）就被「提权」信号否决；叠加 `renderUserIntent` bug（工具结果/系统注入 role=user 挤占最近 6 条窗口，用户授权原话读不到，只见到模型 justification 自称授权）。
- **改动（已实现）**：
  1. `prompt.ts`：UNSAFE 清单**去掉「自我扩权」一刀切**，改为按动作风险（保留：不可逆破坏/泄密/持久化/削弱安全/共享生产外部状态）；**新增**「READ-ONLY and REVERSIBLE operations are ALLOWED（GET/HEAD、检视、状态查询、可撤销的本地改动、git 跟踪文件）」+「提权本身不是危险——评估它启用的动作；低风险可逆 + 用户对齐可放行（如编辑工作区外的 git 仓库 skill 文件）；为真危险动作提权仍禁止」。
  2. `classifier.ts` `renderUserIntent`：**只保留 `source.kind === 'user'` 的人类消息**（排除 tool/plugin/system/model 注入），保证用户授权原话稳定进入意图窗口。
- **验证**：`npm run build` + `npm test` 通过；提示词级场景测试（真实 provider）断言：skill 编辑+提权+git 可回退+用户授权 → allow；GET/只读 → allow；泄密/持久化/生产变更 → reject。重启后 E2E 复测。

## 版本 0.7.0（2026-08-25 补记）

- **版本**：0.6.2 → **0.7.0**（行为变更：风险导向分类、人类消息意图窗口、熔断器缓存计数、effort 回退）。
- **边界**：审批通知由 hooks 层过滤（dsh-hooks `notify-approval` + `~/.dsh/scripts/notify-hook.sh`），**插件侧无法拦截**——实测 approval/request answerer 即使 `prepend` + 不调 `next()`（Cordis 瀑布否决）也不能抑制 dsh-hooks 的 `approval/asked` 通知（动态插件验证：answerer 短路了裁决、无 decision 记录，通知仍触发）。过滤语义见 profile `cordis.patch.yml` 的 `notify-approval` 注释。

## 两态化：移除 ask 态 + deny 提示增强（2026-08-26 补记）

### 决策（用户定稿）
- **分类器只输出两态：`allow` / `reject`，删除 `ask` 态**。`classifier.askFallback` 配置项随之移除（不再需要"ask 时是否弹人工"的开关）。
- **理由**（grill 确认）：
  1. prompt 从未定义"何时 ask"的触发契约——ask 只出现在输出格式示例里，分类器输出 ask 是无依据的灰色地带。
  2. `askFallback=false`（原默认）下 ask 行为 ≡ reject（fail-closed），ask 是行为冗余态。
  3. "需要人工"的通道已存在且不依赖 ask：熔断器（3 连拒 / 20 总拒 → 跳闸 → 审批转人工）+ `BREAKER_TRIPPED_HINT` 引导模型直接请求 `danger-full-access` 升级（升级本身弹人工审批窗口）。
  4. ask 态在 `askFallback=true` 时 `resetConsecutive`，会**削弱熔断保护**（分类器不确定→弹窗→计数器清零，连拒跳闸形同虚设）。去掉 ask 后该漏洞消失。
- **deny 提示增强**：deny 时提示 = 分类器拒绝理由 + **主模型当时的操作解释（justification，如有）** + 安全替代引导（找更安全方法；无则停止重试、询问用户明确许可）。
- **justification 透传补全**：原实现只在 **escalation** 场景把 `exec.arguments.justification` 拼进分类器 prompt（`escReason`）；**非 escalation 的越区文件操作**只传路径、不带 justification。两态化时统一补上，让分类器判定与 deny 回显都能看到主模型的操作原因。

### prompt 契约（两态）
- 输出格式仅两种：`{"decision":"allow","reason":"<sentence>"}` / `{"decision":"reject","reason":"<sentence>"}`。
- **明确指示"何时 reject"新增一条：不确定时 REJECT（fail-closed）**——拒绝可重试或升级到用户，误放不可逆；宁拒勿放。
- **类别只是倾向，具体内容为准（2026-08-26 修正）**：原 "EVERYTHING routine — installs, builds, tests, file edits, git add/commit/status — is SAFE" 是**绝对化断言**，存在**伪装绕过风险**——`curl|sh` 可包装成 install、git push 到未知 remote 可包装成 git 操作、未知包安装可带任意 postinstall 脚本、edit 可写 secrets。改为：routine 类别**通常**安全/可逆（倾向基准），但**必须判断具体命令与参数**，并显式列出"看似 routine 实则危险"的伪装特征（下载执行远程代码、未知包安装、写 secrets、不可逆删除、推未知 remote、关闭保护、触达共享/生产/外部状态）。
- 原有指示保留：可逆/用户明确要求 → allow；不可逆破坏/泄密/持久化/削弱安全/共享生产外部状态/不服务当前请求 → reject。

### 代码改动
- `classifier.ts`：`VerdictDecision = 'allow' | 'reject'`；`parseVerdict` 中 `raw==='ask'` **映射为 reject**（reason 注明 "uncertain (ask) — treated as reject (fail-closed)"），保证老模型输出 ask 时 fail-closed。
- `prompt.ts`：输出格式示例删 ask 行；新增不确定→reject 指示。
- `pre-execute.ts`：删 ask 分支（原 400-410）；`cache.put` 三态三目简化为二态；deny 提示（`denialText`）回显分类器 reason + 主模型 justification；非 escalation 越区文件操作的 `escReason` 补 justification。
- `index.ts`：approval 瀑布删 `case 'ask'` 与 `askHumanForDecision`/`HumanDecision`/`UserQuestionsLike`（无其他引用）；`index.ts:104/452/478` 的 `'ask'` 是 DSH 审批策略枚举（非分类器态），**保留不动**。
- `config.ts`：删 `classifier.askFallback` 字段；`cordis.patch.yml` 删对应配置行（zod object 默认 strip 未知 key，残留不报错但为整洁一并删除）。
- README（EN/ZH）同步：删 askFallback 说明，决策模型改两态。
- **版本**：0.7.0 → **0.8.0**（行为变更：移除 ask 态、deny 提示增强、justification 透传）。
- **验证**：`npm run build` + `npm test`；提示词级场景测试断言：常规 → allow；危险 → reject；**模型输出 ask → 归一为 reject**；越区文件操作带 justification → 分类器 prompt 可见。重启 dsh 后 E2E。

## 裁决缓存意图感知 + allowPaths 覆盖 bash 写命令（2026-08-29 补记）

### 背景（实测复现）
向 OneDrive（`~/Library/CloudStorage/OneDrive-TheHongKongPolytechnicUniversity/Projects/GRF 2026/Proposal/`）导出文件时：
- `08:47:29` 分类器判 DENY（`Writing to an external OneDrive path outside the working tree modifies shared/external state...`，tool=bash，带 danger-full-access 提权）；
- `08:48:38` 同命令重试命中**缓存 DENY**（`a prior identical action was judged unsafe`）——用户已显式授权，仍被旧缓存拦截。

### 问题 1（bug）：裁决缓存不感知用户授权意图
- **根因**：`pre-execute.ts` 的缓存检查（`VerdictCache.sig`）发生在 classifier 之前，且签名**不含用户意图**——`cache.ts::sig` 只基于 `tool + 命令前 maxArgsChars 字符小写`。用户授权后命令签名与之前被拒的完全相同 → 命中缓存 DENY → classifier 根本没被重新调用（classifier 经 `<recent_user_intent>` 本可读到授权）。
- **修复（已实现）**：`cache.ts` 新增 `hashString(text)`（djb2 → base36）；`VerdictCache.sig(toolName, reason, args, maxChars, intentHash?)` 在提供 `intentHash` 时追加 `|intent:<hash>`。`pre-execute.ts` 与 `index.ts`（approval 路径）把 `renderUserIntent(...)` **提前到缓存检查之前**，对最近直接人类消息（`source.kind==='user'`）渲染结果做 hash 并入签名；新用户授权消息进入意图窗口 → hash 变化 → 缓存 miss → classifier 以新意图重跑。工具结果/系统注入（role=user 但非 human）被 `renderUserIntent` 过滤，不破坏缓存；同一意图窗口内的重复命令仍命中缓存。
- **验证**：`npm test`（cache 签名 + 意图 hash 用例）；`npm run build` + `npm run typecheck`。

### 问题 2（功能）：OneDrive allowPaths 白名单
- **关键事实（与 handoff 预判不同）**：被拒动作是 `tool=bash`（cp），而 `pre-execute.ts` 的 curated allowPath 分支（line 274-282）**只对文件工具生效**（`targetPaths` 仅由 `collectPaths` 填充，bash 为空数组）——仅把 OneDrive 加入 `allowPaths` 对 `bash cp` 无效。
- **修复（已实现）**：`bands.ts` 新增 `tokenizeShell` + `bashWriteDestinations(cmd)`——对**非复合** bash 命令识别写命令族（`cp/mv/rsync/ditto/install/tar -x(-C)/unzip(-d)/unar(-d)/curl -o/wget -O/git clone`），提取目标目录/文件路径；`pre-execute.ts` 的 curated allowPath 判定改为「文件工具用 `targetPaths`，bash 用 `bashWriteDestinations` 的结果」，任一路径经 `isInsideTrusted`（真实 symlink-resolve 前缀匹配）命中 allowPath → `pre-execute-allow`（`curated allowPath`），不经过 classifier。
- **安全边界**：仅限白名单写命令 + 目标在用户 curated allowPath 内 + deny 频带仍最先执行（`/etc`/`mv|trash` 系统目录、`.ssh/`/`.env`/`credentials` 等仍硬拒绝）；删除类命令（`rm`）不在写命令白名单，不被放行；复合命令/重定向（`>`）不进此分支（回退 classifier）。**权衡**：allowPath 是用户显式声明的全信任目录，写入其中是声明意图；误放风险限于「把文件写进用户自己信任的目录」。
- **配置归属（重要，不回退 9bb483c）**：**不把个人 OneDrive 路径写进 `DEFAULT_ALLOW_PATHS` / 插件默认 `cordis.patch.yml`**（9bb483c 已移除个人路径，默认保持通用、仅 `/tmp/`）。OneDrive 路径改由**用户 profile 覆盖**：`~/.dsh/profiles/web/cordis.patch.yml` 中 `- id: auto-mode` 覆写 `config.allowPaths`（loader patch 语义：`config` 整体替换；因其余字段与代码默认完全一致，只覆写 `allowPaths` 即可，`/tmp/` 一并保留）。README 补充该配置方法。
  - **2026-08-29 用户定稿范围**：白名单采用**两个 OneDrive 根目录**（PolyU + 个人），而非最初的单个 Proposal 目录——`config.allowPaths = ['/tmp/', '/Users/logan/Library/CloudStorage/OneDrive-TheHongKongPolytechnicUniversity', '/Users/logan/Library/CloudStorage/OneDrive-个人']`。即任一 OneDrive 下**任意子目录**的写操作都跳过分类器；deny 频带与删除类命令保护不受影响。该选择仅在用户本地 profile，不进入 repo 默认。
- **验证**：`npm test`（bashWriteDestinations 用例：cp/mv/-t/rsync/tar -C/curl -o/git clone/非写命令/复合命令）；node 脚本断言「最小 profile 覆写（仅 allowPaths）解析出的完整 config 与 bundle 默认一致——**唯一差异**：bundle 的 `trash|mv` 系统目录 deny 模式缺 `[:…]` 里的 `:` 分支，代码默认更严格，属 fail-closed（更安全）方向，可接受」；`npm run build`。重启 dsh 后 E2E：`cp x.docx .../Proposal/` 应落 `pre-execute-allow (curated allowPath)`。

