/**
 * Deterministic band engine — the fast path that runs before the classifier.
 *
 * Two band types:
 *   deny  — regex patterns that hard-reject (exfiltration, secrets, deletion,
 *           sensitive targets). Evaluated first; first match wins.
 *   allow — prefix-glob patterns that zero-LLM approve (routine commands,
 *           curated paths). Evaluated after deny; first match wins.
 *
 * Read-only tools are allowed by default unless they match a deny pattern.
 * Everything else falls through to the classifier.
 *
 * Ported from dsh-auto-mode v0.4.1 lib/index.js (decideRoute + helpers).
 */
/** Compile a rule string into a case-insensitive RegExp. */
export declare function compileRegex(rule: string): RegExp;
/** Whether `haystack` matches any regex in the list. Returns the first hit. */
export declare function matchRule(rules: RegExp[], haystack: string): string | null;
/** Compile a prefix-glob into an anchored RegExp (leading/trailing * wildcards). */
export declare function compileGlob(pattern: string): RegExp;
/** Whether `text` matches any compiled glob. */
export declare function matchAllow(globs: RegExp[], text: string): string | null;
/** Extract the command field from tool arguments (string or object). */
export declare function bashCommandOf(args: unknown): string;
/** Detect shell metacharacters that indicate a composite command. */
export declare function isCompositeShell(text: string): boolean;
/** Whether `text` contains a permanent-deletion command. */
export declare function matchDeletion(text: string): string | null;
/** Whether `text` is a read-only tool name. */
export declare function isReadOnlyTool(toolName: string, readOnlyTools: readonly string[]): boolean;
/** Check whether an action matches a deny pattern, an allow pattern, or neither. */
export declare function classifyBand(toolName: string, reason: string, args: unknown, denyPatterns: RegExp[], allowGlobs: RegExp[], readOnlyTools: readonly string[]): {
    action: 'allow' | 'deny' | 'classify';
    tier: string;
    detail: string;
};
