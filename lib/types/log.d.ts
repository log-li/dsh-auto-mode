/**
 * Append a decision record to ~/.dsh/auto-mode/decisions.jsonl.
 * Best-effort and never throws — a logging failure must not change a verdict.
 */
export declare function appendDecision(entry: Record<string, unknown>): void;
