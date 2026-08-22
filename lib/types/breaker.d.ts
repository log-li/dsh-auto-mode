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
export interface BreakerState {
    consecutive: number;
    total: number;
    tripped: boolean;
}
export declare class Breaker {
    private sessions;
    private getOrCreate;
    /** Get current state (read-only snapshot). */
    get(sessionId: string): BreakerState;
    /** Whether the breaker is currently tripped for this session. */
    isTripped(sessionId: string): boolean;
    /** Count a classifier DENY. Returns true if the breaker just tripped. */
    countDeny(sessionId: string, maxConsecutive: number, maxTotal: number): boolean;
    /** Reset the consecutive counter on a classifier ALLOW (CC semantics). */
    resetConsecutive(sessionId: string): void;
    /** Resume auto mode after human approval — full reset. */
    resume(sessionId: string): void;
}
