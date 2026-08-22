/**
 * Circuit breaker — pauses auto mode when the classifier repeatedly denies.
 *
 * CC Repeated-blocks semantics: 3 consecutive or 20 total classifier DENY
 * decisions trip the breaker. While tripped, the approval handler delegates
 * to the human answerer. ONE human approval (allowed-once / always) resumes
 * auto mode and resets the counters.
 *
 * FAIL (classifier timeout/parse error) is NOT counted — CC explicitly
 * excludes classifier faults from the breaker.
 *
 * Ported from dsh-auto-mode v0.4.1 lib/index.js.
 */
export class Breaker {
    sessions = new Map();
    getOrCreate(sessionId) {
        let s = this.sessions.get(sessionId);
        if (!s) {
            s = { consecutive: 0, total: 0, tripped: false };
            this.sessions.set(sessionId, s);
        }
        return s;
    }
    /** Get current state (read-only snapshot). */
    get(sessionId) {
        return { ...this.getOrCreate(sessionId) };
    }
    /** Whether the breaker is currently tripped for this session. */
    isTripped(sessionId) {
        return this.getOrCreate(sessionId).tripped;
    }
    /** Count a classifier DENY. Returns true if the breaker just tripped. */
    countDeny(sessionId, maxConsecutive, maxTotal) {
        const s = this.getOrCreate(sessionId);
        s.consecutive += 1;
        s.total += 1;
        if (s.consecutive >= maxConsecutive || s.total >= maxTotal) {
            s.tripped = true;
            return true;
        }
        return false;
    }
    /** Reset the consecutive counter on a classifier ALLOW (CC semantics). */
    resetConsecutive(sessionId) {
        this.getOrCreate(sessionId).consecutive = 0;
    }
    /** Resume auto mode after human approval — full reset. */
    resume(sessionId) {
        const s = this.getOrCreate(sessionId);
        s.consecutive = 0;
        s.total = 0;
        s.tripped = false;
    }
}
