import { createUserMessage } from '@deepseek-ai/dsh-llm';
import { compileRegex, bashCommandOf, matchRule, compileGlob, matchAllow, isCompositeShell } from './bands.js';
import { VerdictCache } from './cache.js';
import { classifyTwoStage, renderUserIntent, resolveRoute } from './classifier.js';
import { buildSystemPrompt, buildUserMessage, promptInputOf } from './prompt.js';
import { expandDefaults } from './config.js';
import { effectivePermissionPreset } from '@deepseek-ai/dsh-permission-presets';
import { appendDecision } from './log.js';
import { realpathSync } from 'node:fs';
import { resolve, sep } from 'node:path';
// ---- File-path trust helpers (Bug 5 real-path check; Bug 6 tighter allowPaths) ----
/** Expand `~` and `${HOME}`/`$HOME` in a path. */
function expandHome(p) {
    const home = process.env.HOME ?? '';
    return p.replace(/^~(?=$|\/)/, home).replace(/\$\{HOME\}|\$HOME/g, home);
}
/** Best-effort realpath (symlink resolution); if the path doesn't exist yet, resolve lexically. */
function realpathSafe(p) {
    try {
        return realpathSync(p);
    }
    catch {
        return resolve(p);
    }
}
/** Expand allowPaths into absolute, symlink-resolved trust roots (cwd + allowPaths). */
function trustRoots(allowPaths, cwd) {
    const roots = [];
    if (cwd)
        roots.push(realpathSafe(cwd));
    for (const p of allowPaths) {
        const expanded = realpathSafe(expandHome(p));
        if (expanded)
            roots.push(expanded);
    }
    return [...new Set(roots)];
}
/** Whether `p` (symlink-resolved) is under any trust root. */
function isInsideTrusted(p, roots) {
    if (!p)
        return false;
    const rp = realpathSafe(p);
    return roots.some((root) => rp === root || rp.startsWith(root.endsWith(sep) ? root : root + sep));
}
/** Collect candidate file/dir path strings from a file-tool call's args. */
function collectPaths(args) {
    if (!args || typeof args !== 'object')
        return [];
    const out = [];
    for (const key of ['file_path', 'path', 'dir', 'root', 'pattern']) {
        const v = args[key];
        if (typeof v === 'string' && v)
            out.push(v);
        else if (Array.isArray(v))
            for (const item of v)
                if (typeof item === 'string')
                    out.push(item);
    }
    return out;
}
/** Collect only definitive filesystem-path argument values (no search patterns).
 * Used for deny scanning so a grep/glob search term is not mistaken for a target. */
function collectDenyPaths(args) {
    if (!args || typeof args !== 'object')
        return [];
    const out = [];
    for (const key of ['file_path', 'path', 'dir', 'root']) {
        const v = args[key];
        if (typeof v === 'string' && v)
            out.push(v);
        else if (Array.isArray(v))
            for (const item of v)
                if (typeof item === 'string')
                    out.push(item);
    }
    return out;
}
/** Denial envelope — reaches the model verbatim. */
function denialText(category, reason) {
    return `dsh-automode denied this action (${category}): ${reason}. ` +
        'Try a safer alternative. If there is NO safer alternative, STOP retrying and ask the user for explicit permission ' +
        '(a denied action will keep failing; only explicit user approval lets a later attempt pass).';
}
/**
 * Injected at the moment the breaker trips so the model stops doing the
 * "try at current level → hit a denied error → then escalate" round-trip
 * and instead requests the sandbox escalation directly, surfacing the human
 * approval window immediately.
 */
export const BREAKER_TRIPPED_HINT = 'Auto mode circuit breaker tripped: the safety classifier denied several actions in a row, so auto mode has paused and this and later approvals go to a human. ' +
    'For any action that needs sandbox escalation (writing/editing outside the workspace, or commands needing more permission), request `danger-full-access` sandbox_permissions DIRECTLY on your first attempt — a human will be asked to approve it. ' +
    'Do NOT first try at the current permission level, hit a "denied" error, and then escalate; that wastes a round-trip. Go straight to the escalation request.';
/** CC errors-doc wording for transient classifier failures. */
function classifierUnavailableText(detail, toolName) {
    const m = detail.toLowerCase();
    let cat = '';
    if (/timed?\s*out|timeout|stalled/.test(m))
        cat = ' (timed out)';
    else if (/rate.?limit|429/.test(m))
        cat = ' (rate-limited)';
    else if (/overload|529/.test(m))
        cat = ' (overloaded)';
    else if (/server error|\b5\d\d\b/.test(m))
        cat = ' (server error)';
    else if (/connect|network|socket|fetch failed|econn/.test(m))
        cat = ' (connection failed)';
    return `dsh-automode: the safety classifier is temporarily unavailable${cat}, so auto mode cannot determine the safety of ${toolName} right now. Wait a moment and then try this action again. (detail: ${detail})`;
}
/**
 * Register the pre-execute gate as a tools/pre-execute listener.
 */
export function registerPreExecute(ctx, config, cache, breaker, logger) {
    // Pre-compile regex patterns for performance
    const denyPatterns = config.deny.map(compileRegex);
    const allowGlobs = config.allow.map(compileGlob);
    // Expand $defaults in prose rules
    const softDenyRules = expandDefaults(config.rules.deny, 'soft_deny');
    const softAllowRules = expandDefaults(config.rules.allow, 'soft_allow');
    const environmentFacts = expandDefaults(config.rules.environment, 'environment');
    ctx.on('tools/pre-execute', async (exec, next) => {
        try {
            if (!exec || typeof exec.name !== 'string')
                return next();
            const toolName = exec.name;
            const session = exec.agent?.session;
            if (!session)
                return next();
            // Preset gate: this guardrail only applies to auto-mode sessions.
            // In other presets (read-only / workspace-write / danger-full-access),
            // the auto-mode pre-execute gate is a no-op so it does not contradict
            // the user's chosen sandbox — e.g. "full access" must not be denied here.
            if (effectivePermissionPreset(session.events) !== 'auto-mode') {
                return next();
            }
            const sid = String(session.id ?? '?');
            const commandText = bashCommandOf(exec.arguments);
            // 1. Read-only tools → allow (unless deny matched)
            if (config.readOnlyTools.includes(toolName)) {
                // Check deny first even for read-only (reading .ssh is blocked).
                // For file tools, scan the *target paths* (not content/command text), so
                // a read of a sensitive file path is caught while a file whose *content*
                // merely mentions a deny word is not.
                const denyHaystack = isFileTool(toolName)
                    ? `${toolName}\n${collectDenyPaths(exec.arguments).join('\n')}`
                    : `${toolName}\n${commandText}`;
                const denyHit = matchRule(denyPatterns, denyHaystack);
                if (denyHit !== null) {
                    appendDecision({
                        event: 'pre-execute-deny',
                        tool: toolName,
                        sessionId: sid,
                        detail: `matched deny pattern /${denyHit}/`,
                    });
                    return {
                        kind: 'deny',
                        reason: denialText('deny', `matched deny pattern /${denyHit}/`),
                    };
                }
                return next(); // read-only, no deny → allow
            }
            // 2. Deny band (regex hard-reject)
            // For file tools scan the target paths, not the full args (content /
            // old_string / new_string). Editing a doc that mentions a deny word must
            // not be a false leak; a sensitive *target path* still is.
            const argsText = typeof exec.arguments === 'string'
                ? exec.arguments
                : JSON.stringify(exec.arguments ?? '');
            const haystack = isFileTool(toolName)
                ? `${toolName}\n${collectDenyPaths(exec.arguments).join('\n')}`
                : `${toolName}\n${commandText || argsText}`;
            const denyHit = matchRule(denyPatterns, haystack);
            if (denyHit !== null) {
                appendDecision({
                    event: 'pre-execute-deny',
                    tool: toolName,
                    sessionId: sid,
                    detail: `matched deny pattern /${denyHit}/`,
                });
                return {
                    kind: 'deny',
                    reason: denialText('deny', `matched deny pattern /${denyHit}/`),
                };
            }
            // 3. Allow band (prefix glob, non-composite)
            if (commandText && !isCompositeShell(commandText)) {
                const allowHit = matchAllow(allowGlobs, commandText);
                if (allowHit !== null) {
                    appendDecision({
                        event: 'pre-execute-allow',
                        tool: toolName,
                        sessionId: sid,
                        detail: `matched allow glob /${allowHit}/`,
                    });
                    return next(); // allow
                }
            }
            // 4. Real trust check for file tools (Bug 5). in-tree OR curated allowPath → allow.
            //    We only take this shortcut when there is NO sandbox escalation request — if the
            //    agent is asking to widen the sandbox (even to an in-tree target), that is itself
            //    a risk signal and must reach the classifier (preserves the original conservatism).
            const isFileToolCall = isFileTool(toolName);
            const perm = exec.arguments && typeof exec.arguments === 'object'
                ? exec.arguments.sandbox_permissions
                : undefined;
            const isEscalation = typeof perm === 'string' && perm !== '';
            const targetPaths = isFileToolCall ? collectPaths(exec.arguments) : [];
            const roots = trustRoots(config.allowPaths, session.header?.cwd);
            const inTrusted = isFileToolCall && targetPaths.length > 0
                && targetPaths.every((p) => isInsideTrusted(p, roots));
            if (config.allowInsideWorkingDirectory && isFileToolCall && inTrusted && !isEscalation) {
                appendDecision({
                    event: 'pre-execute-allow',
                    tool: toolName,
                    sessionId: sid,
                    detail: 'in-tree / allowPath file op (path resolved)',
                });
                return next(); // real in-tree → allow
            }
            // 5. Escalation intent OR out-of-workspace file op → classifier pre-screen.
            const isOutOfTreeFileOp = isFileToolCall && targetPaths.length > 0 && !inTrusted;
            if ((isEscalation || isOutOfTreeFileOp) && !breaker.isTripped(sid)) {
                const escReason = isEscalation
                    ? `escalate sandbox to ${perm}: ${String(exec.arguments?.justification ?? commandText ?? toolName)}`
                    : `file operation outside trusted workspace: ${targetPaths.join(', ')}`;
                // Curated allowPaths trust (Bug 6): real symlink-resolved prefix match, not substring.
                if (targetPaths.length > 0 && targetPaths.every((p) => isInsideTrusted(p, roots))) {
                    appendDecision({
                        event: 'pre-execute-allow',
                        tool: toolName,
                        sessionId: sid,
                        detail: `curated allowPath: ${targetPaths.join(', ')}`,
                    });
                    return next();
                }
                // Cache check (Bug 3: maxArgsChars wired into the signature).
                const sig = VerdictCache.sig(toolName, escReason, exec.arguments, config.maxArgsChars);
                const cached = cache.get(sid, sig);
                if (cached === 'DENY') {
                    appendDecision({ event: 'pre-execute-deny', tool: toolName, sessionId: sid, reason: 'a prior identical action was judged unsafe' });
                    return {
                        kind: 'deny',
                        reason: denialText('classifier:unsafe', 'a prior identical action was judged unsafe'),
                    };
                }
                if (cached === 'ALLOW') {
                    appendDecision({ event: 'pre-execute-allow', tool: toolName, sessionId: sid, detail: 'verdict cache ALLOW' });
                    return next();
                }
                // Classify (two-stage, Bug 1; user intent, CC-style). No transcript here — it is a
                // bounded pre-screen, but we still feed the user's recent instructions for intent.
                const route = resolveRoute(exec.agent, config.classifier.provider, config.classifier.model);
                if (!route.provider || !route.model) {
                    if (config.failClosed) {
                        appendDecision({ event: 'pre-execute-deny', tool: toolName, sessionId: sid, reason: 'no classifier route' });
                        return {
                            kind: 'deny',
                            reason: classifierUnavailableText('no classifier route', toolName),
                        };
                    }
                    return next();
                }
                const userIntent = renderUserIntent(session.deriveMessages(), config.classifier.maxIntentMessages);
                const input = promptInputOf({ toolName, reason: escReason, userIntent }, softAllowRules, softDenyRules, environmentFacts);
                const verdict = await classifyTwoStage(ctx, {
                    system: buildSystemPrompt(input),
                    user: buildUserMessage(input, ''),
                    provider: route.provider,
                    model: route.model,
                    temperature: config.classifier.temperature,
                    maxTokens: config.classifier.maxTokens,
                    timeoutMs: config.timeoutMs,
                    reasoningEffort: config.classifier.reasoningLevel,
                    logger,
                }, `${toolName}${escReason ? ` (${escReason})` : ''}`);
                if (verdict) {
                    cache.put(sid, sig, verdict.decision === 'allow' ? 'ALLOW' : verdict.decision === 'reject' ? 'DENY' : null);
                    if (verdict.decision === 'reject') {
                        const justTripped = breaker.countDeny(sid, config.breakerConsecutive, config.breakerTotal);
                        appendDecision({ event: 'pre-execute-deny', tool: toolName, sessionId: sid, reason: verdict.reason });
                        if (justTripped) {
                            const b = breaker.get(sid);
                            appendDecision({
                                event: 'breaker',
                                action: 'tripped',
                                tool: toolName,
                                sessionId: sid,
                                detail: `consecutive=${b.consecutive} total=${b.total}`,
                            });
                            // Tell the model to escalate directly (skip try→error→escalate).
                            if (exec.agent) {
                                try {
                                    exec.agent.inject(createUserMessage({
                                        content: [{ type: 'text', text: BREAKER_TRIPPED_HINT }],
                                        source: { kind: 'plugin', plugin: 'auto-mode' },
                                    }));
                                }
                                catch { /* best effort */ }
                            }
                        }
                        return {
                            kind: 'deny',
                            reason: denialText(`classifier:${verdict.reason}`, `${verdict.reason} — reshape the command so it fits the allowlist, or drop the escalation`),
                        };
                    }
                    if (verdict.decision === 'allow') {
                        breaker.resetConsecutive(sid);
                        appendDecision({ event: 'pre-execute-allow', tool: toolName, sessionId: sid, detail: verdict.reason });
                        return next();
                    }
                    // Bug 4: "ask" must honor askFallback, not silently allow.
                    if (config.classifier.askFallback) {
                        breaker.resetConsecutive(sid);
                        appendDecision({ event: 'pre-execute-allow', tool: toolName, sessionId: sid, detail: 'classifier ask → delegate (askFallback)' });
                        return next(); // best-effort: let the approval waterfall ask a human
                    }
                    appendDecision({ event: 'pre-execute-deny', tool: toolName, sessionId: sid, reason: 'classifier asked for human confirmation but askFallback is disabled' });
                    return {
                        kind: 'deny',
                        reason: denialText('classifier:ask', 'the classifier requested human confirmation but askFallback is disabled — ask the user directly or re-enable askFallback'),
                    };
                }
                else {
                    // Classifier failure → fail-closed (Bug 1/3: timeout etc. now surface here).
                    if (config.failClosed) {
                        appendDecision({ event: 'pre-execute-deny', tool: toolName, sessionId: sid, reason: 'classifier returned no verdict' });
                        return {
                            kind: 'deny',
                            reason: classifierUnavailableText('classifier returned no verdict', toolName),
                        };
                    }
                }
            }
        }
        catch (error) {
            logger.warn(`pre-execute error (fail-open): ${String(error?.message ?? error)}`);
        }
        return next();
    }, { prepend: true });
}
function isFileTool(name) {
    return ['read', 'write', 'edit', 'glob', 'grep', 'find', 'ls'].includes(name);
}
