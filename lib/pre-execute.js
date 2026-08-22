import { compileRegex, bashCommandOf, matchRule, compileGlob, matchAllow, isCompositeShell } from './bands.js';
import { VerdictCache } from './cache.js';
import { classify, resolveRoute } from './classifier.js';
import { buildSystemPrompt, buildUserMessage, promptInputOf } from './prompt.js';
import { expandDefaults } from './config.js';
/** Denial envelope — reaches the model verbatim. */
function denialText(category, reason) {
    return `dsh-auto-mode denied this action (${category}): ${reason}. Find a safer alternative approach and retry.`;
}
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
    return `dsh-auto-mode: the safety classifier is temporarily unavailable${cat}, so auto mode cannot determine the safety of ${toolName} right now. Wait a moment and then try this action again. (detail: ${detail})`;
}
/**
 * Register the pre-execute gate as a tools/pre-execute listener.
 */
export function registerPreExecute(ctx, config, cache, breaker, logger) {
    // Pre-compile regex patterns for performance
    const denyPatterns = config.deny.map(compileRegex);
    const allowGlobs = config.allow.map(compileGlob);
    const allowPathPrefixes = [...config.allowPaths];
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
            const sid = String(session.id ?? '?');
            const commandText = bashCommandOf(exec.arguments);
            // 1. Read-only tools → allow (unless deny matched)
            if (config.readOnlyTools.includes(toolName)) {
                // Check deny first even for read-only (reading .ssh is blocked)
                const denyHit = matchRule(denyPatterns, `${toolName}\n${commandText}`);
                if (denyHit !== null) {
                    return {
                        kind: 'deny',
                        reason: denialText('deny', `matched deny pattern /${denyHit}/`),
                    };
                }
                return next(); // read-only, no deny → allow
            }
            // 2. Deny band (regex hard-reject)
            const argsText = typeof exec.arguments === 'string'
                ? exec.arguments
                : JSON.stringify(exec.arguments ?? '');
            const haystack = `${toolName}\n${commandText || argsText}`;
            const denyHit = matchRule(denyPatterns, haystack);
            if (denyHit !== null) {
                return {
                    kind: 'deny',
                    reason: denialText('deny', `matched deny pattern /${denyHit}/`),
                };
            }
            // 3. Allow band (prefix glob, non-composite)
            if (commandText && !isCompositeShell(commandText)) {
                const allowHit = matchAllow(allowGlobs, commandText);
                if (allowHit !== null)
                    return next(); // allow
            }
            // 4. allowInsideWorkingDirectory — in-tree file ops
            if (config.allowInsideWorkingDirectory && isFileTool(toolName)) {
                // If the tool doesn't need sandbox escalation, it's in-tree → allow
                const perm = exec.arguments?.sandbox_permissions;
                if (!perm || perm === 'workspace-write') {
                    return next(); // in-tree file op → allow
                }
            }
            // 5. Escalation intent — classifier pre-screen
            const perm = exec.arguments && typeof exec.arguments === 'object'
                ? exec.arguments.sandbox_permissions
                : undefined;
            if (typeof perm === 'string' && perm !== '' && !breaker.isTripped(sid)) {
                const escReason = `escalate sandbox to ${perm}: ${String(exec.arguments?.justification ?? commandText ?? toolName)}`;
                // Check allow paths first (curated trust)
                if (allowPathPrefixes.length > 0) {
                    const escText = `${escReason}\n${argsText}`;
                    // Simple prefix check: does any allowPath appear in the text?
                    const inAllowPath = allowPathPrefixes.some(p => escText.includes(p) || escText.includes(p.replace('~', process.env.HOME ?? '')));
                    if (inAllowPath)
                        return next(); // curated trust → allow
                }
                // Cache check
                const sig = VerdictCache.sig(toolName, escReason, exec.arguments);
                const cached = cache.get(sid, sig);
                if (cached === 'DENY') {
                    return {
                        kind: 'deny',
                        reason: denialText('classifier:unsafe', 'a prior identical escalation was judged unsafe'),
                    };
                }
                if (cached === 'ALLOW')
                    return next();
                // Classify
                const route = resolveRoute(exec.agent, config.classifier.provider, config.classifier.model);
                if (!route.provider || !route.model) {
                    // No classifier route → fail-closed or pass-through
                    if (config.failClosed) {
                        return {
                            kind: 'deny',
                            reason: classifierUnavailableText('no classifier route', toolName),
                        };
                    }
                    return next();
                }
                const input = promptInputOf({ toolName, reason: escReason }, softAllowRules, softDenyRules, environmentFacts);
                const verdict = await classify(ctx, {
                    system: buildSystemPrompt(input),
                    user: buildUserMessage(input, ''),
                    provider: route.provider,
                    model: route.model,
                    temperature: config.classifier.temperature,
                    maxTokens: config.classifier.maxTokens,
                });
                if (verdict) {
                    cache.put(sid, sig, verdict.decision === 'allow' ? 'ALLOW' : verdict.decision === 'reject' ? 'DENY' : null);
                    if (verdict.decision === 'reject') {
                        breaker.countDeny(sid, config.breakerConsecutive, config.breakerTotal);
                        return {
                            kind: 'deny',
                            reason: denialText(`classifier:${verdict.reason}`, `${verdict.reason} — reshape the command so it fits the allowlist, or drop the escalation`),
                        };
                    }
                    if (verdict.decision === 'allow') {
                        breaker.resetConsecutive(sid);
                        return next();
                    }
                    // "ask" → fall through to approval path
                }
                else {
                    // Classifier failure → fail-closed
                    if (config.failClosed) {
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
