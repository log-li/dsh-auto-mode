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
/**
 * Deterministic string hash (djb2 → base36). Not for security — used only to
 * fold the user's recent direct instructions into a cache signature so that
 * a NEW explicit user authorization changes the signature and forces the
 * classifier to re-run (a cached DENY must not swallow a user grant).
 */
export declare function hashString(text: string): string;
export declare class VerdictCache {
    private store;
    /**
     * Build a stable signature for a classifier call.
     *
     * `intentHash` (the hash of the user's recent direct instructions, see
     * `hashString`) is optional: when provided it becomes part of the key, so
     * a new human authorization invalidates a previously cached verdict and the
     * classifier is re-run with the fresh intent. Without it the signature is
     * exactly the legacy tool|command form.
     */
    static sig(toolName: string, reason: string, args: unknown, maxChars?: number, intentHash?: string): string;
    get(sessionId: string, sig: string): 'ALLOW' | 'DENY' | null;
    put(sessionId: string, sig: string, decision: 'ALLOW' | 'DENY' | null): void;
}
