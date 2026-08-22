/**
 * LLM classifier: renders the conversation transcript, streams one
 * classifier call through `ctx.llm`, and parses the JSON verdict.
 *
 * The classifier is fail-aware but not fail-closed by itself: it returns
 * `null` when no verdict can be produced (API error, aborted stream,
 * truncated or unparsable reply), and the caller decides what `null` means
 * (`failClosed` config, or falling back to the human approval chain).
 */
import type { Context } from '@deepseek-ai/cordis';
import type { Agent } from '@deepseek-ai/dsh-agent';
import { type Message } from '@deepseek-ai/dsh-llm';
/** A classifier decision: allow, ask a human, or reject. */
export type VerdictDecision = 'allow' | 'ask' | 'reject';
/** A parsed classifier verdict. */
export interface Verdict {
    /** The decision. */
    readonly decision: VerdictDecision;
    /** The classifier's one-sentence justification. */
    readonly reason: string;
}
/** Options for one classifier call. */
export interface ClassifyOptions {
    /** System prompt (see prompt.ts). */
    readonly system: string;
    /** User message: transcript + action (see prompt.ts). */
    readonly user: string;
    /** Provider route for the call (already resolved). */
    readonly provider: string;
    /** Model id for the call (already resolved). */
    readonly model: string;
    /** Sampling temperature. */
    readonly temperature: number;
    /** Output token budget. */
    readonly maxTokens: number;
    /** Cancellation signal (the approval request's signal). */
    readonly signal?: AbortSignal;
}
/**
 * Render a transcript as classifier input: the trailing `maxMessages`
 * messages, oldest first, one per line.
 */
export declare function renderTranscript(messages: readonly Message[], maxMessages: number): string;
/**
 * Resolve the classifier route: explicit config wins, otherwise the agent's
 * own options, otherwise the session's current request header.
 */
export declare function resolveRoute(agent: Agent, configuredProvider: string, configuredModel: string): {
    provider: string;
    model: string;
};
/**
 * Model-agnostic robust verdict parser (v0.5.0).
 *
 * Accepts strict JSON, markdown-fenced JSON, prose with keywords, and
 * alternate key names (verdict, safe/allow/deny/block booleans). Falls
 * back to keyword detection on the full text. Only returns null when
 * there is genuinely no signal at all.
 *
 * CRITICAL: deny patterns are checked BEFORE allow because "unsafe"
 * contains "safe" as a substring — checking allow first would misparse
 * UNSAFE verdicts as ALLOW.
 */
export declare function parseVerdict(reply: string): Verdict | null;
/**
 * One-token fast filter (stage 1 of two-stage classification).
 *
 * Sends a minimal prompt asking for a single digit: 0 = safe, 1 = needs
 * review. Costs ~1 token. Most routine actions return 0 (safe) and skip
 * the expensive structured review. Only actions that return 1 proceed to
 * the full `classify()` call.
 *
 * Returns true if the action needs review, false if safe, null on failure.
 */
export declare function fastFilter(ctx: Context, actionSummary: string, provider: string, model: string, signal?: AbortSignal): Promise<boolean | null>;
/**
 * Run one classifier call. Returns the verdict, or `null` when the call
 * failed, was aborted, was truncated, or produced an unparsable reply.
 */
export declare function classify(ctx: Context, options: ClassifyOptions): Promise<Verdict | null>;
