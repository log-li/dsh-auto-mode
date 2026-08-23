Status: implemented

# Fork Nuo-cl/dsh-auto-mode 并重构为 dsh-automode

> 本文档是 dsh-automode 的**当前设计与实现规格**。早前的 `proposed / 待实现 / 审查发现 / 实现确认` 分层已全部落地并合入本文；v0.5.0 审查发现的 7 个 bug、CC 式分类器缺口、熔断器复位缺陷、模型引导改进均已实现，不再单独保留历史 bug 清单。

## 核心立场

转 TypeScript（与 DSH 生态一致），我们的逻辑为基础，Nuo-cl 和 pi-automode 的代码尽可能直接复用（转写为 TS），减少重写。

## 共识（grill 产出）

| 决策 | 选择 |
|---|---|
| 代码库 | Nuo-cl TypeScript 为基础 → merge 到 log-li/dsh-automode |
| npm 名 | `dsh-automode`（无连字符） |
| peerDeps | 精简到最少必需 |
| 语言 | TypeScript |
| 规则体系 | deny（正则硬拒绝）+ allow（前缀 glob 白名单）+ 散文规则给分类器 |
| 读取策略 | 只读工具默认放行，deny 列表里的敏感位置除外 |
| 决策模型 | 二态为主（askFallback=false），可配置开启三态 |
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
- `fastFilter`（one-token 预筛）：512 token 预算 + **独立 0/1 数字解析**，避免 reasoning 模型被 token 预算饿死；传入 `classifier.reasoningLevel` 作为 `reasoningEffort`；若路由不支持 effort（dsh-llm 抛 `UNSUPPORTED_REASONING_EFFORT`）则**安全回退为不传**（`streamTokens` 统一处理）。
- `classify`（结构化裁决）：鲁棒解析 JSON verdict（allow / ask / reject）；失败返回 null → 调用方按 `failClosed` 处理。

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

