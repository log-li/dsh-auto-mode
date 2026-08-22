/**
 * Verdict cache — shared between the pre-execute gate and the approval path.
 *
 * Keyed per session by a stable signature (tool + reason + args head).
 * TTL-bounded and size-capped; only positive/negative CLASSIFIER verdicts
 * live here (deterministic bands re-run cheaply and must never be cached).
 *
 * Ported from dsh-auto-mode v0.4.1 lib/index.js.
 */
export interface CachedVerdict {
    decision: 'ALLOW' | 'DENY';
    at: number;
}
export declare class VerdictCache {
    private store;
    /** Build a stable signature for a classifier call. */
    static sig(toolName: string, reason: string, args: unknown): string;
    get(sessionId: string, sig: string): 'ALLOW' | 'DENY' | null;
    put(sessionId: string, sig: string, decision: 'ALLOW' | 'DENY' | null): void;
}
