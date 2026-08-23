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

/** Translate a `*`/`?` wildcard pattern into an anchored regex. */
function wildcardToRegExp(pattern: string): RegExp {
  let source = '';
  for (const char of pattern) {
    if (char === '*') source += '.*';
    else if (char === '?') source += '.';
    else source += char.replace(/[.+^${}()|[\]\\]/g, '\\$&');
  }
  return new RegExp(`^${source}$`, 'i');
}

/** Whether one pattern matches one text. */
export function patternMatches(pattern: string, text: string): boolean {
  if (pattern.includes('*') || pattern.includes('?')) {
    return wildcardToRegExp(pattern).test(text);
  }
  return text.toLowerCase().includes(pattern.toLowerCase());
}

/** Whether one rule entry matches a request's tool name and reason. */
export function ruleMatches(rule: string, toolName: string, reason: string | undefined): boolean {
  const colon = rule.indexOf(':');
  const toolPart = colon === -1 ? rule : rule.slice(0, colon);
  const patternPart = colon === -1 ? undefined : rule.slice(colon + 1);
  if (toolPart !== '*' && toolPart.toLowerCase() !== toolName.toLowerCase()) return false;
  if (patternPart === undefined || patternPart === '') return true;
  if (!reason) return false;
  return patternMatches(patternPart, reason);
}

/** First matching allow rule, or undefined. */
export function findAllowRule(rules: readonly string[], toolName: string, reason: string | undefined): string | undefined {
  return rules.find((rule) => ruleMatches(rule, toolName, reason));
}

/** First matching deny rule, or undefined. */
export function findDenyRule(rules: readonly string[], toolName: string, reason: string | undefined): string | undefined {
  return rules.find((rule) => ruleMatches(rule, toolName, reason));
}

/** Whether the tool is on the safe allowlist (name-only). */
export function isAllowlisted(toolName: string, allowlist: readonly string[]): boolean {
  const name = toolName.toLowerCase();
  return allowlist.some((entry) => entry.toLowerCase() === name);
}

/** Build the environment-facts block for the classifier prompt. */
export function buildEnvironmentText(facts: readonly string[]): string {
  if (facts.length === 0) return '';
  return facts.map((fact) => `- ${fact}`).join('\n');
}
