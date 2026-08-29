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
export function compileRegex(rule) {
    return new RegExp(rule, 'i');
}
/** Whether `haystack` matches any regex in the list. Returns the first hit. */
export function matchRule(rules, haystack) {
    for (const re of rules) {
        if (re.test(haystack))
            return re.source;
    }
    return null;
}
/** Compile a prefix-glob into an anchored RegExp (leading/trailing * wildcards). */
export function compileGlob(pattern) {
    let source = '';
    for (const ch of pattern) {
        if (ch === '*')
            source += '.*';
        else
            source += ch.replace(/[.+^${}()|[\]\\]/g, '\\$&');
    }
    return new RegExp(`^${source}$`, 'i');
}
/** Whether `text` matches any compiled glob. */
export function matchAllow(globs, text) {
    for (const g of globs) {
        if (g.test(text))
            return g.source;
    }
    return null;
}
/** Extract the command field from tool arguments (string or object). */
export function bashCommandOf(args) {
    if (typeof args === 'string') {
        try {
            const obj = JSON.parse(args);
            return typeof obj?.command === 'string' ? obj.command : '';
        }
        catch {
            return args;
        }
    }
    if (args && typeof args === 'object' && typeof args.command === 'string') {
        return args.command;
    }
    return '';
}
/** Detect shell metacharacters that indicate a composite command.
 * Quote-aware: control characters inside quotes are literal — a quoted
 * filename like "GRF 2026 (copy).docx" is NOT a subshell — and only an
 * unquoted `; & | > \` $ ( )` marks the command as composite. */
export function isCompositeShell(text) {
    let quote = null;
    for (let i = 0; i < text.length; i++) {
        const ch = text[i] ?? '';
        if (quote) {
            if (ch === quote)
                quote = null;
            continue;
        }
        if (ch === '"' || ch === "'") {
            quote = ch;
            continue;
        }
        if (/[;&|>`$()]/.test(ch))
            return true;
    }
    return false;
}
/** Quote-aware shell tokenization (no metachar expansion, no env substitution). */
export function tokenizeShell(cmd) {
    const tokens = [];
    let cur = '';
    let quote = null;
    for (let i = 0; i < cmd.length; i++) {
        const ch = cmd[i] ?? '';
        if (quote) {
            if (ch === quote)
                quote = null;
            else
                cur += ch;
        }
        else if (ch === '"' || ch === "'") {
            quote = ch;
        }
        else if (/\s/.test(ch)) {
            if (cur) {
                tokens.push(cur);
                cur = '';
            }
        }
        else {
            cur += ch;
        }
    }
    if (cur)
        tokens.push(cur);
    return tokens;
}
/** Last argv token that does not look like a flag (used as a command's destination). */
function lastPositional(argv) {
    for (let i = argv.length - 1; i >= 0; i--) {
        const a = argv[i];
        if (a && !a.startsWith('-'))
            return a;
    }
    return undefined;
}
/**
 * Bash write-commands that write files at an explicit destination path
 * (used for the curated allowPath trust check on non-file tools).
 * Deletion commands (`rm`, `shred`, `unlink`, `trash`) are intentionally
 * NOT here — allowPaths trust never authorizes removal.
 */
const BASH_WRITE_COMMANDS = new Set([
    'cp', 'mv', 'rsync', 'ditto', 'install', 'tar', 'unzip', 'unar', 'curl', 'wget', 'git',
]);
/**
 * For a NON-composite bash command, return the destination path(s) it writes
 * into, or `[]` when the command is not a recognized file-writing command or
 * has no explicit destination. The destination is only ever the *target* of
 * the write; sources and unrelated path tokens are ignored.
 */
export function bashWriteDestinations(cmd) {
    if (!cmd || isCompositeShell(cmd))
        return [];
    const tokens = tokenizeShell(cmd.trim());
    if (tokens.length < 2)
        return [];
    const first = tokens[0] ?? '';
    const base = first.split('/').pop() ?? first;
    if (!BASH_WRITE_COMMANDS.has(base))
        return [];
    const argv = tokens.slice(1);
    switch (base) {
        case 'cp':
        case 'mv':
        case 'rsync':
        case 'ditto':
        case 'install': {
            // --target-directory=/dest and -t /dest forms
            for (const a of argv) {
                if (a.startsWith('--target-directory='))
                    return [a.slice('--target-directory='.length)];
            }
            const tIdx = argv.findIndex((a) => a === '-t' || a === '--target-directory');
            const tDest = tIdx !== -1 ? argv[tIdx + 1] : undefined;
            if (tDest)
                return [tDest];
            const dest = lastPositional(argv);
            return dest ? [dest] : [];
        }
        case 'tar':
        case 'unzip':
        case 'unar': {
            // tar -C / --directory, unzip/unar -d / --directory (extract target)
            for (const a of argv) {
                if (a.startsWith('--directory='))
                    return [a.slice('--directory='.length)];
            }
            const dIdx = argv.findIndex((a) => a === '-C' || a === '-d' || a === '--directory');
            const dDest = dIdx !== -1 ? argv[dIdx + 1] : undefined;
            if (dDest)
                return [dDest];
            return []; // extracts into cwd by default — not an allowPath destination
        }
        case 'curl': {
            for (const a of argv) {
                if (a.startsWith('--output='))
                    return [a.slice('--output='.length)];
                if (a.startsWith('-o='))
                    return [a.slice(3)];
            }
            const oIdx = argv.findIndex((a) => a === '-o' || a === '--output');
            const oDest = oIdx !== -1 ? argv[oIdx + 1] : undefined;
            if (oDest)
                return [oDest];
            return [];
        }
        case 'wget': {
            for (const a of argv) {
                if (a.startsWith('--output-document='))
                    return [a.slice('--output-document='.length)];
                if (a.startsWith('-O='))
                    return [a.slice(3)];
            }
            const oIdx = argv.findIndex((a) => a === '-O' || a === '--output-document');
            const oDest = oIdx !== -1 ? argv[oIdx + 1] : undefined;
            if (oDest)
                return [oDest];
            return [];
        }
        case 'git': {
            if (argv[0] === 'clone') {
                // git clone <url> [dir] — the destination is the last arg when it is a
                // local path, not the repository URL (clone without a dir writes into cwd).
                const last = argv[argv.length - 1];
                if (last && !last.startsWith('-') && !/^(?:https?|git|ssh):\/\/|git@/.test(last))
                    return [last];
            }
            return [];
        }
        default:
            return [];
    }
}
/** Whether `text` contains a permanent-deletion command. */
export function matchDeletion(text) {
    if (!text)
        return null;
    const DELETION_RE = /(?:^|[;&|]\s*)(?:rm\s+(-[rRfIi]*\s+)*(?!.*node_modules)|unlink\s+|shred\s+|git\s+clean\s+-f)/;
    return DELETION_RE.test(text) ? 'permanent deletion command detected' : null;
}
/** Whether `text` is a read-only tool name. */
export function isReadOnlyTool(toolName, readOnlyTools) {
    return readOnlyTools.includes(toolName);
}
/** Check whether an action matches a deny pattern, an allow pattern, or neither. */
export function classifyBand(toolName, reason, args, denyPatterns, allowGlobs, readOnlyTools) {
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
