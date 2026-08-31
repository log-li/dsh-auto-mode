/**
 * AllowPath bridge — connects the pre-execute gate to the approval answerer.
 *
 * The pre-execute gate sees a tool call's raw arguments (so it can prove every
 * target is inside `config.allowPaths`), but the `approval/request` payload
 * only carries `{ agent, toolName, callId, reason }` — no paths. Without a
 * bridge, an allowlisted escalation that the gate already allowed is still
 * re-decided by the classifier in `decideAuto`, which lacks the allowPath
 * context and rejects it (the exact bug documented in the 2026-08-31 spec
 * 补记). This class hands the gate's deterministic "curated allowPath"
 * verdict to the approval answerer for the SAME tool call, keyed by its
 * `callId` (the `tools/pre-execute` `ToolExecution.callId` and the
 * `approval/request` `callId` are the same value — `approveEscalation` in
 * `@deepseek-ai/dsh-sandbox` forwards `exec.callId` verbatim).
 *
 * Safety:
 * - A record is only written by the pre-execute gate after it has
 *   deterministically proven every target sits inside a trust root
 *   (`isInsideTrusted`), and only when the circuit breaker is not tripped.
 * - Deny patterns still run first in both the gate and `decideAuto`, so a
 *   deny-listed path inside an allowPath is still hard-rejected.
 * - Records are consumed-on-grant, short-TTL (60s) and size-capped
 *   with lazy pruning — a record can never be reused by a later, different
 *   call, and the map cannot grow unbounded.
 */
export interface BridgeEntry {
    toolName: string;
    paths: string[];
    at: number;
}
export declare class AllowPathBridge {
    private store;
    /**
     * Record that the pre-execute gate deterministically allowlisted the targets
     * of the tool call identified by `callId`.
     * @param callId - the tool call's identity (shared with approval/request).
     * @param toolName - the tool being allowed, for the answerer's match check.
     * @param paths - the verified allowPath targets (audit only).
     */
    record(callId: string, toolName: string, paths: string[]): void;
    /**
     * Consume a fresh bridge record for `callId` (if any). Returns undefined when
     * there is no record, it is stale, or its tool name does not match `toolName`
     * — in every miss case the caller falls through to the normal decision chain
     * (classifier / human), so a bridge never weakens an unverified call. A
     * record is DELETED only on a genuine hit (the grant): a wrong-tool or stale
     * probe does not destroy the verdict for the real caller. Each callId has at
     * most one approval, so leaving a miss in place cannot be reused elsewhere;
     * the TTL + size cap bound the map regardless.
     * @param callId - the approval request's callId.
     * @param toolName - the tool being approved, to match the gate's verdict.
     * @returns the consumed entry, or undefined on any miss.
     */
    take(callId: string, toolName: string): BridgeEntry | undefined;
    /** Drop stale records. Cheap, best-effort; called lazily on record pressure. */
    private prune;
    /** Number of live records (diagnostics / tests). */
    get size(): number;
    /** Clear every record (tests). */
    clear(): void;
}
