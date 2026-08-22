/**
 * dsh-automode — CC-style auto mode for DeepSeek Harness (v0.5.0).
 *
 * Merges dsh-auto-mode v0.4.1 (deterministic bands, pre-execute gate,
 * robust parser, circuit breaker, verdict cache) with Nuo-cl/dsh-auto-mode
 * (native preset integration, three-state decision, system-prompt shadowing,
 * /auto command) and pi-automode ($defaults, two-stage classifier,
 * allowInsideWorkingDirectory).
 *
 * Two enforcement points:
 *   1. tools/pre-execute gate — ALL tools, first defense
 *   2. approval/request waterfall — triggered approvals, second defense
 */
import type { Context } from '@deepseek-ai/cordis';
import '@deepseek-ai/dsh-commands';
import type { Agent } from '@deepseek-ai/dsh-agent';
import type { Session } from '@deepseek-ai/dsh-session';
import { type ApprovalRequest } from '@deepseek-ai/dsh-user-approval';
import { Config } from './config.js';
export declare const name = "dsh-automode";
export { Config };
export declare const inject: string[];
export declare function isAuto(session: Session): boolean;
export declare function writeAutoMode(ctx: Context, agent: Agent): void;
type HumanDecision = {
    kind: 'allow';
} | {
    kind: 'reject';
} | {
    kind: 'reject-with-text';
    text: string;
} | {
    kind: 'cancelled';
} | {
    kind: 'unavailable';
};
export declare function askHumanForDecision(ctx: Context, req: ApprovalRequest): Promise<HumanDecision>;
export declare function apply(ctx: Context, rawConfig: unknown): void;
