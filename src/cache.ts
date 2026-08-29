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

/**
 * Deterministic string hash (djb2 → base36). Not for security — used only to
 * fold the user's recent direct instructions into a cache signature so that
 * a NEW explicit user authorization changes the signature and forces the
 * classifier to re-run (a cached DENY must not swallow a user grant).
 */
export function hashString(text: string): string {
  let h = 5381;
  for (let i = 0; i < text.length; i++) {
    h = ((h * 33) ^ text.charCodeAt(i)) >>> 0;
  }
  return h.toString(36);
}

export class VerdictCache {
  private store = new Map<string, Map<string, CachedVerdict>>();

  /**
   * Build a stable signature for a classifier call.
   *
   * `intentHash` (the hash of the user's recent direct instructions, see
   * `hashString`) is optional: when provided it becomes part of the key, so
   * a new human authorization invalidates a previously cached verdict and the
   * classifier is re-run with the fresh intent. Without it the signature is
   * exactly the legacy tool|command form.
   */
  static sig(toolName: string, reason: string, args: unknown, maxChars = 200, intentHash = ''): string {
    const cmd =
      (typeof args === 'object' && args !== null && typeof (args as Record<string, unknown>).command === 'string'
        ? ((args as Record<string, unknown>).command as string)
        : '') ||
      String(reason ?? '');
    const base = `${toolName}|${cmd.slice(0, maxChars).toLowerCase()}`;
    return intentHash ? `${base}|intent:${intentHash}` : base;
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
