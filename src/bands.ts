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
export function compileRegex(rule: string): RegExp {
  return new RegExp(rule, 'i');
}

/** Whether `haystack` matches any regex in the list. Returns the first hit. */
export function matchRule(rules: RegExp[], haystack: string): string | null {
  for (const re of rules) {
    if (re.test(haystack)) return re.source;
  }
  return null;
}

/** Compile a prefix-glob into an anchored RegExp (leading/trailing * wildcards). */
export function compileGlob(pattern: string): RegExp {
  let source = '';
  for (const ch of pattern) {
    if (ch === '*') source += '.*';
    else source += ch.replace(/[.+^${}()|[\]\\]/g, '\\$&');
  }
  return new RegExp(`^${source}$`, 'i');
}

/** Whether `text` matches any compiled glob. */
export function matchAllow(globs: RegExp[], text: string): string | null {
  for (const g of globs) {
    if (g.test(text)) return g.source;
  }
  return null;
}

/** Extract the command field from tool arguments (string or object). */
export function bashCommandOf(args: unknown): string {
  if (typeof args === 'string') {
    try {
      const obj = JSON.parse(args);
      return typeof obj?.command === 'string' ? obj.command : '';
    } catch {
      return args;
    }
  }
  if (args && typeof args === 'object' && typeof (args as Record<string, unknown>).command === 'string') {
    return (args as Record<string, unknown>).command as string;
  }
  return '';
}

/** Detect shell metacharacters that indicate a composite command. */
export function isCompositeShell(text: string): boolean {
  return /[;&|>`$()]/.test(text);
}

/** Whether `text` contains a permanent-deletion command. */
export function matchDeletion(text: string): string | null {
  if (!text) return null;
  const DELETION_RE =
    /(?:^|[;&|]\s*)(?:rm\s+(-[rRfIi]*\s+)*(?!.*node_modules)|unlink\s+|shred\s+|git\s+clean\s+-f)/;
  return DELETION_RE.test(text) ? 'permanent deletion command detected' : null;
}

/** Whether `text` is a read-only tool name. */
export function isReadOnlyTool(toolName: string, readOnlyTools: readonly string[]): boolean {
  return readOnlyTools.includes(toolName);
}

/** Check whether an action matches a deny pattern, an allow pattern, or neither. */
export function classifyBand(
  toolName: string,
  reason: string,
  args: unknown,
  denyPatterns: RegExp[],
  allowGlobs: RegExp[],
  readOnlyTools: readonly string[],
): { action: 'allow' | 'deny' | 'classify'; tier: string; detail: string } {
  const argsText = typeof args === 'string' ? args : JSON.stringify(args ?? '');
  const commandText = bashCommandOf(args);
  const haystack = `${toolName}\n${reason ?? ''}\n${argsText}`;

  // 1. Deny band (regex hard-reject)
  const denyHit = matchRule(denyPatterns, haystack);
  if (denyHit !== null) {
    return { action: 'deny', tier: 'deny', detail: `matched deny pattern /${denyHit}/` };
  }

  // 2. Deletion guard
  if (commandText) {
    const delHit = matchDeletion(`${reason ?? ''}\n${commandText}`);
    if (delHit !== null) {
      return {
        action: 'deny',
        tier: 'deletionGuard',
        detail: 'permanent deletion forbidden — use `trash <file>` instead (moves to Recycle Bin)',
      };
    }
  }

  // 3. Allow band (prefix glob, non-composite commands only)
  if (allowGlobs.length > 0 && commandText && !isCompositeShell(commandText)) {
    const allowHit = matchAllow(allowGlobs, commandText);
    if (allowHit !== null) {
      return { action: 'allow', tier: 'allow', detail: `matched allow glob /${allowHit}/` };
    }
  }

  // 4. Read-only tools default-allow (unless deny matched above)
  if (isReadOnlyTool(toolName, readOnlyTools)) {
    return { action: 'allow', tier: 'readOnlyTool', detail: toolName };
  }

  // 5. Everything else → classifier
  return { action: 'classify', tier: 'classify', detail: 'no deterministic band matched' };
}
