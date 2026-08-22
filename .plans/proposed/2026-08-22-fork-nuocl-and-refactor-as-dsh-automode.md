Status: proposed

# Fork Nuo-cl/dsh-auto-mode 并重构为 dsh-automode

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

## 复用策略

### 直接复制的文件（最小改动）
- Nuo-cl: tsconfig.json + tsconfig.build.json
- Nuo-cl: src/index.ts 的 preset 管理（isAuto/writeAutoMode/policyOf/systemPrompt 影子化）
- Nuo-cl: src/index.ts 的 /auto + /auto-status 命令
- Nuo-cl: src/index.ts 的 askHumanForDecision()
- Nuo-cl: src/classifier.ts 的 resolveRoute() + renderTranscript() + classify() 框架
- Nuo-cl: src/prompt.ts 的 buildSystemPrompt() + buildUserMessage()
- Nuo-cl: scripts/smoke.test.mjs

### 需要重构的文件（以我们的逻辑为主，转为 TS）
- parseVerdict 鲁棒解析（我们的 lib/index.js → src/classifier.ts）
- decideRoute 确定性频带（我们的 lib/index.js → src/bands.ts）
- deny 正则引擎 + allow 前缀 glob（我们的 lib/index.js → src/bands.ts）
- pre-execute 门（我们的 lib/index.js → src/pre-execute.ts）
- 裁决缓存（我们的 lib/index.js → src/cache.ts）
- 熔断器（我们的 lib/index.js → src/breaker.ts）
- $defaults 机制（pi-automode → src/config.ts）
- 两阶段分类器（pi-automode → src/classifier.ts）
- allowInsideWorkingDirectory（pi-automode → src/pre-execute.ts）
- 持久化 JSONL 日志（我们的 lib/index.js → src/index.ts）

## 文件结构

```
src/
  index.ts         主入口（基于 Nuo-cl，整合我们的决策链）
  config.ts        配置 schema（合并两套 + $defaults）
  bands.ts         确定性频带引擎（从我们的 lib/index.js 转 TS）
  pre-execute.ts   pre-execute 门（从我们的 lib/index.js 转 TS）
  classifier.ts    分类器（基于 Nuo-cl，整合我们的 parseVerdict + 两阶段）
  rules.ts         散文规则匹配（基于 Nuo-cl，整合 pi-automode 默认规则）
  prompt.ts        提示构造（基于 Nuo-cl，整合我们的 SECURITY_MONITOR）
  cache.ts         裁决缓存（从我们的 lib/index.js 转 TS）
  breaker.ts       熔断器（从我们的 lib/index.js 转 TS）
```

## 决策链

```
工具调用到达
  ├─ [pre-execute 门]（所有工具，第一道防线）
  │    ① 只读工具 → 除 deny 列表外直接放行
  │    ② deny 列表（正则）→ 直接拒绝
  │    ③ allow 列表（前缀 glob）→ 直接放行
  │    ④ allowInsideWorkingDirectory → 工作区内文件操作放行
  │    ⑤ 升级意图 → decideRoute → 未命中 → 分类器预审
  │    ⑥ 其余 → 放行
  └─ [approval/request 路径]
       ① deny rules（散文）→ 拒绝
       ② allow rules（散文）→ 放行
       ③ allowlist → 放行
       ④ 裁决缓存命中 → 复用
       ⑤ 分类器（两阶段）
       ⑥ 失败 → failClosed
```
