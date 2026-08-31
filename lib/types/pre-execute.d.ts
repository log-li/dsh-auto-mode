/**
 * Pre-execute gate — the first enforcement point for ALL tool calls.
 *
 * Runs before the approval/request waterfall. Catches:
 *   1. Read-only tools → allow (unless deny matched)
 *   2. Deny patterns (regex) → hard reject
 *   3. Allow patterns (prefix glob) → approve
 *   4. allowInsideWorkingDirectory → in-tree file ops approve
 *   5. Escalation intent (sandbox_permissions) → decideRoute → classifier
 *
 * The denial reason reaches the model verbatim via {kind:"deny", reason},
 * unlike the approval waterfall which uses a generic sandbox template.
 *
 * Ported from dsh-auto-mode v0.4.1 lib/index.js.
 */
import type { Context } from '@deepseek-ai/cordis';
import type { ConfigType } from './config.js';
import { VerdictCache } from './cache.js';
import { Breaker } from './breaker.js';
import { AllowPathBridge } from './bridge.js';
/**
 * Injected at the moment the breaker trips so the model stops doing the
 * "try at current level → hit a denied error → then escalate" round-trip
 * and instead requests the sandbox escalation directly, surfacing the human
 * approval window immediately.
 */
export declare const BREAKER_TRIPPED_HINT: string;
export interface PreExecuteResult {
    kind: 'allow' | 'deny';
    reason?: string;
}
/**
 * Register the pre-execute gate as a tools/pre-execute listener.
 */
export declare function registerPreExecute(ctx: Context, config: ConfigType, cache: VerdictCache, breaker: Breaker, logger: {
    info: (msg: string) => void;
    warn: (msg: string) => void;
}, bridge: AllowPathBridge): void;
