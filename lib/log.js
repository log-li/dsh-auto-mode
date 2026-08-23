/**
 * Persistent JSONL decision logging (v0.5.1).
 *
 * Shared by the approval waterfall (index.ts) and the pre-execute gate
 * (pre-execute.ts) so BOTH enforcement points land in the audit log.
 * Lives here (not in index.ts) to avoid a circular import: index.ts imports
 * registerPreExecute from pre-execute.ts, and pre-execute.ts imports this.
 *
 * Events: boot / decision / pre-execute-deny / pre-execute-allow / breaker / resume.
 */
import { appendFileSync, mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
/**
 * Append a decision record to ~/.dsh/auto-mode/decisions.jsonl.
 * Best-effort and never throws — a logging failure must not change a verdict.
 */
export function appendDecision(entry) {
    try {
        const logDir = join(homedir(), '.dsh', 'auto-mode');
        mkdirSync(logDir, { recursive: true });
        appendFileSync(join(logDir, 'decisions.jsonl'), JSON.stringify({ at: new Date().toISOString(), ...entry }) + '\n');
    }
    catch {
        /* best effort */
    }
}
