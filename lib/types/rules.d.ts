/**
 * Prose rule matching for the classifier (v0.5.0).
 *
 * These are the "soft" rules fed to the classifier as natural-language
 * guidance, not the deterministic regex bands (see bands.ts for those).
 *
 * Rule syntax: `tool:pattern` or `*` (any tool).
 * A pattern is a case-insensitive substring match against the reason text.
 * Patterns with `*` or `?` are wildcard-matched against the whole reason.
 */
/** Whether one pattern matches one text. */
export declare function patternMatches(pattern: string, text: string): boolean;
/** Whether one rule entry matches a request's tool name and reason. */
export declare function ruleMatches(rule: string, toolName: string, reason: string | undefined): boolean;
/** First matching allow rule, or undefined. */
export declare function findAllowRule(rules: readonly string[], toolName: string, reason: string | undefined): string | undefined;
/** First matching deny rule, or undefined. */
export declare function findDenyRule(rules: readonly string[], toolName: string, reason: string | undefined): string | undefined;
/** Whether the tool is on the safe allowlist (name-only). */
export declare function isAllowlisted(toolName: string, allowlist: readonly string[]): boolean;
/** Build the environment-facts block for the classifier prompt. */
export declare function buildEnvironmentText(facts: readonly string[]): string;
