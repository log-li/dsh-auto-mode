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

const BRIDGE_TTL_MS = 60_000; // 60 seconds — pre-execute → approval is same-turn
const MAX_ENTRIES = 2000;

export class AllowPathBridge {
  private store = new Map<string, BridgeEntry>();

  /**
   * Record that the pre-execute gate deterministically allowlisted the targets
   * of the tool call identified by `callId`.
   * @param callId - the tool call's identity (shared with approval/request).
   * @param toolName - the tool being allowed, for the answerer's match check.
   * @param paths - the verified allowPath targets (audit only).
   */
  record(callId: string, toolName: string, paths: string[]): void {
    if (!callId) return;
    if (this.store.size >= MAX_ENTRIES) this.prune();
    if (this.store.size >= MAX_ENTRIES) {
      // Still full after pruning live entries? Drop the oldest entry so the
      // map stays bounded under a pathological burst of simultaneous calls.
      let oldestKey: string | undefined;
      let oldestAt = Infinity;
      for (const [k, v] of this.store) {
        if (v.at < oldestAt) {
          oldestAt = v.at;
          oldestKey = k;
        }
      }
      if (oldestKey !== undefined) this.store.delete(oldestKey);
    }
    this.store.set(callId, { toolName, paths: [...paths], at: Date.now() });
  }

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
  take(callId: string, toolName: string): BridgeEntry | undefined {
    if (!callId) return undefined;
    const entry = this.store.get(callId);
    if (!entry) return undefined;
    if (entry.toolName !== toolName) return undefined;
    if (Date.now() - entry.at > BRIDGE_TTL_MS) return undefined;
    this.store.delete(callId); // consume-on-grant — never reusable
    return entry;
  }

  /** Drop stale records. Cheap, best-effort; called lazily on record pressure. */
  private prune(): void {
    const now = Date.now();
    for (const [k, v] of this.store) {
      if (now - v.at > BRIDGE_TTL_MS) this.store.delete(k);
    }
  }

  /** Number of live records (diagnostics / tests). */
  get size(): number {
    return this.store.size;
  }

  /** Clear every record (tests). */
  clear(): void {
    this.store.clear();
  }
}
