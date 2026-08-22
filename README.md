# dsh-automode

[![npm](https://img.shields.io/npm/v/dsh-automode)](https://www.npmjs.com/package/dsh-automode)
[![license](https://img.shields.io/npm/l/dsh-automode)](./LICENSE)

CC-style auto-approval for [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness). Deterministic deny/allow rules handle the obvious cases; a **model-agnostic two-stage classifier** decides everything else — with circuit breaker, fail-closed semantics, persistent JSONL logging, and native permission preset integration.

## Install

```bash
dsh plugin add dsh-automode
```

## How it works

```
Tool call arrives
  │
  ├─ [pre-execute gate]  (all tools; deny reason reaches the model verbatim)
  │    ① Read-only tools → allow (unless deny matched)
  │    ② Deny rules (regex) → hard reject
  │    ③ Allow rules (prefix glob) → approve
  │    ④ allowInsideWorkingDirectory → in-tree file ops approve
  │    ⑤ Escalation intent → classifier pre-screen
  │    ⑥ Everything else → pass through
  │
  └─ [approval waterfall]
       ① Soft deny rules (prose) → reject
       ② Soft allow rules (prose) → approve
       ③ Read-only allowlist → approve
       ④ Verdict cache hit → reuse
       ⑤ Classifier (two-stage: one-token filter → structured review)
       ⑥ Failure → failClosed
```

## Rules

Two-layer rule system:

**Hard boundary** (deterministic, never goes to classifier):
- `deny` — regex patterns that hard-reject (exfiltration, secrets, sensitive targets)
- `allow` — prefix-glob patterns that zero-LLM approve (routine commands, curated paths)

**Classifier guidance** (prose, fed to the LLM):
- `rules.deny` — soft-deny descriptions (force push, curl|bash, production deploys)
- `rules.allow` — soft-allow exceptions (local dev, dependency install, standard git)
- `rules.environment` — context facts (trusted repos, infrastructure)

All rule arrays support `$defaults`: `["$defaults", "my custom rule"]` keeps the built-in rules while adding yours.

## Configuration

```yaml
# In cordis.patch.yml
- id: auto-mode
  name: dsh-automode
  config:
    deny: [...]                    # Regex hard-reject patterns
    allow: [...]                   # Prefix-glob allow patterns
    readOnlyTools: [read, glob, grep, list, search]
    allowPaths: ['~/Documents/']   # Curated full-trust directories
    allowInsideWorkingDirectory: true
    failClosed: true
    preExecuteGate: true
    timeoutMs: 45000
    breakerConsecutive: 3
    breakerTotal: 20
    classifier:
      provider: ''                 # Empty = follow session model
      model: ''
      maxTokens: 2048
      askFallback: false           # true = three-state (allow/ask/reject)
    rules:
      deny: ['$defaults']
      allow: ['$defaults']
      environment: ['$defaults']
```

## Commands

- `/auto` — Switch to auto mode
- `/auto-status` — Show diagnostics

## Logging

All decisions are logged to `~/.dsh/auto-mode/decisions.jsonl` (JSONL format, append-only).

## Architecture

```
src/
  index.ts         Main entry: preset management, approval answerer, commands
  config.ts        Config schema + $defaults mechanism + built-in rule lists
  bands.ts         Deterministic band engine (deny regex + allow glob)
  pre-execute.ts   Pre-execute gate (first defense for all tools)
  classifier.ts    Two-stage classifier (one-token filter + structured review)
  rules.ts         Prose rule matching for the classifier
  prompt.ts        Classifier prompt construction
  cache.ts         Verdict cache (shared across enforcement points)
  breaker.ts       Circuit breaker (3 consecutive / 20 total)
```

## License

[MIT](./LICENSE)
