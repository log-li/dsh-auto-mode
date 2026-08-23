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

const VERDICT_TTL_MS = 300_000; // 5 minutes
const MAX_ENTRIES_PER_SESSION = 50;

export class VerdictCache {
  private store = new Map<string, Map<string, CachedVerdict>>();

  /** Build a stable signature for a classifier call. */
  static sig(toolName: string, reason: string, args: unknown, maxChars = 200): string {
    const cmd =
      (typeof args === 'object' && args !== null && typeof (args as Record<string, unknown>).command === 'string'
        ? ((args as Record<string, unknown>).command as string)
        : '') ||
      String(reason ?? '');
    return `${toolName}|${cmd.slice(0, maxChars).toLowerCase()}`;
  }

  get(sessionId: string, sig: string): 'ALLOW' | 'DENY' | null {
    const m = this.store.get(sessionId);
    if (!m) return null;
    const hit = m.get(sig);
    if (!hit) return null;
    if (Date.now() - hit.at > VERDICT_TTL_MS) {
      m.delete(sig);
      return null;
    }
    return hit.decision;
  }

  put(sessionId: string, sig: string, decision: 'ALLOW' | 'DENY' | null): void {
    if (decision === null) return; // FAILs are never cached — retry next time
    let m = this.store.get(sessionId);
    if (!m) {
      m = new Map();
      this.store.set(sessionId, m);
    }
    m.set(sig, { decision, at: Date.now() });
    if (m.size > MAX_ENTRIES_PER_SESSION) {
      m.delete(m.keys().next().value!);
    }
  }
}
