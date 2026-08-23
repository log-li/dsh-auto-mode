import { createUserMessage } from '@deepseek-ai/dsh-llm';
/**
 * Combine a request cancellation signal with a hard timeout.
 * Uses AbortSignal.any/timeout (Node >= 20.3). Falls back to just the
 * request signal when no timeout is configured.
 */
function effectiveSignal(signal, timeoutMs) {
    if (timeoutMs != null && timeoutMs > 0) {
        const t = AbortSignal.timeout(timeoutMs);
        return signal ? AbortSignal.any([signal, t]) : t;
    }
    return signal;
}
/** Token budget for the one-token fast filter. Reasoning models consume budget
 * on chain-of-thought, so a tiny budget starves the answer and always degrades
 * to the full classifier; give enough headroom for a low-effort reasoning pass. */
const FAST_FILTER_MAX_TOKENS = 512;
/**
 * Shared streaming helper: runs one classifier call and accumulates text.
 *
 * If a reasoning effort was requested but the route does not support it
 * (dsh-llm throws `UNSUPPORTED_REASONING_EFFORT`), retry once without it so a
 * non-reasoning model is never broken by the effort config.
 *
 * Returns `{ text, reasonKind }` on success, or `null` on a hard failure.
 */
async function streamTokens(ctx, spec) {
    const attempts = spec.reasoningEffort
        ? [spec.reasoningEffort, undefined]
        : [undefined];
    for (const effort of attempts) {
        try {
            let text = '';
            let reasonKind = null;
            for await (const chunk of ctx.llm.stream({
                provider: spec.provider,
                model: spec.model,
                system: spec.system,
                messages: [
                    createUserMessage({
                        content: [{ type: 'text', text: spec.user }],
                        source: { kind: 'plugin', plugin: 'auto-mode' },
                    }),
                ],
                temperature: spec.temperature,
                maxTokens: spec.maxTokens,
                signal: effectiveSignal(spec.signal, spec.timeoutMs),
                ...(effort !== undefined ? { reasoningEffort: effort } : {}),
            })) {
                if (chunk.type === 'text-delta')
                    text += chunk.text;
                else if (chunk.type === 'finish')
                    reasonKind = chunk.reason.kind;
            }
            return { text, reasonKind };
        }
        catch (error) {
            if (error?.code === 'UNSUPPORTED_REASONING_EFFORT' &&
                effort !== undefined) {
                continue; // route doesn't support the effort → retry without it
            }
            const code = error?.code;
            spec.logger?.warn(`classifier stream failed (${spec.provider}/${spec.model}): ${String(error?.message ?? error)}${code ? ` [${code}]` : ''}`);
            return null;
        }
    }
    return null;
}
/** Render one content block into plain text. */
function renderBlock(block) {
    switch (block.type) {
        case 'text':
            return block.text;
        case 'reasoning':
            return `[thinking] ${block.text}`;
        case 'tool-call':
            return `[tool call: ${block.name} ${block.arguments}]`;
        case 'tool-result':
            return `[tool result${block.isError ? ' (error)' : ''}: ${block.content
                .map(renderBlock)
                .join(' ')}]`;
        case 'image':
            return '[image]';
        default:
            return '';
    }
}
/** Render one conversation message into a `role: content` line. */
function renderMessage(message) {
    const content = message.content.map(renderBlock).filter(Boolean).join(' ');
    return `${message.role}: ${content}`;
}
/**
 * Render a transcript as classifier input: the trailing `maxMessages`
 * messages, oldest first, one per line.
 */
export function renderTranscript(messages, maxMessages) {
    const tail = messages.slice(Math.max(0, messages.length - maxMessages));
    return tail.map(renderMessage).join('\n\n');
}
/**
 * Render the user's RECENT explicit instructions (CC-style intent).
 *
 * Unlike the full transcript, this keeps only the most recent `maxMessages`
 * user-role messages, so the classifier can weigh what the user asked for
 * when judging whether an action serves the current request. Standalone
 * assistant/tool turns are dropped on purpose: repository text and tool
 * output MUST NOT grant permission (only direct human messages can).
 */
export function renderUserIntent(messages, maxMessages) {
    const userMsgs = [];
    for (let i = messages.length - 1; i >= 0 && userMsgs.length < maxMessages; i--) {
        const m = messages[i];
        if (!m)
            continue; // noUncheckedIndexedAccess guard
        if (m.role !== 'user')
            continue;
        const text = m.content.map(renderBlock).filter(Boolean).join(' ');
        if (text.trim())
            userMsgs.unshift(`${m.role}: ${text}`);
    }
    return userMsgs.join('\n\n');
}
/** Truncate a rendered context block to a char budget (classifyContextChars). */
export function truncateToChars(text, maxChars) {
    if (!text || maxChars <= 0)
        return text;
    return text.length > maxChars ? text.slice(0, maxChars) + '\n…(truncated)' : text;
}
/**
 * Resolve the classifier route: explicit config wins, otherwise the SESSION's
 * current request header (the model the user is actually running), otherwise
 * the agent's configured options. This lets the classifier follow the model the
 * session uses rather than a stale/default one.
 */
export function resolveRoute(agent, configuredProvider, configuredModel) {
    const header = agent.session.requestHeader()?.config;
    const provider = configuredProvider || header?.provider || agent.options.provider || '';
    const model = configuredModel || header?.model || agent.options.model || '';
    return { provider, model };
}
/**
 * Model-agnostic robust verdict parser (v0.5.0).
 *
 * Accepts strict JSON, markdown-fenced JSON, prose with keywords, and
 * alternate key names (verdict, safe/allow/deny/block booleans). Falls
 * back to keyword detection on the full text. Only returns null when
 * there is genuinely no signal at all.
 *
 * CRITICAL: deny patterns are checked BEFORE allow because "unsafe"
 * contains "safe" as a substring — checking allow first would misparse
 * UNSAFE verdicts as ALLOW.
 */
export function parseVerdict(reply) {
    const trimmed = reply.trim();
    if (trimmed === '')
        return null;
    // Strip markdown code fences (```json … ```).
    let t = trimmed.replace(/```(?:json)?\s*/gi, '').replace(/```/g, '');
    // Try the first balanced JSON object.
    const firstBrace = t.indexOf('{');
    const lastBrace = t.lastIndexOf('}');
    if (firstBrace !== -1 && lastBrace > firstBrace) {
        const candidate = t.slice(firstBrace, lastBrace + 1);
        try {
            const parsed = JSON.parse(candidate);
            const raw = String(parsed.decision ?? parsed.verdict ?? parsed.classification ?? '').toLowerCase();
            // Boolean fields: safe/allow → allow; safe:false/deny/block → reject
            if (parsed.safe === true || parsed.allow === true)
                return verdict('allow', parsed.reason);
            if (parsed.safe === false ||
                parsed.allow === false ||
                parsed.block === true ||
                parsed.deny === true)
                return verdict('reject', parsed.reason);
            if (raw) {
                // CRITICAL: deny-first ordering — "unsafe" contains "safe"
                if (/unsafe|deny|block|reject|forbid/.test(raw))
                    return verdict('reject', parsed.reason);
                if (/safe|allow|permit|approve|yes/.test(raw))
                    return verdict('allow', parsed.reason);
                if (raw === 'ask')
                    return verdict('ask', parsed.reason);
            }
        }
        catch {
            // not valid JSON — fall through to keyword scan
        }
    }
    // Keyword fallback on the whole text (model-agnostic last resort).
    const low = t.toLowerCase();
    const denySignal = /(^|[^a-z])(unsafe|den(y|ies)|block(ed|ing)?|reject(ed)?|forbid(den)?|malicious|danger(ous)?)([^a-z]|$)/.test(low);
    const allowSignal = /(^|[^a-z])(safe|allow(ed)?|permit(ted)?|approve[ds]?|benign|okay?)([^a-z]|$)/.test(low);
    if (denySignal && !allowSignal)
        return verdict('reject');
    if (allowSignal && !denySignal)
        return verdict('allow');
    if (denySignal && allowSignal)
        return verdict('reject'); // conflict → fail closed
    return null; // no signal → caller fails closed
    function verdict(decision, reason) {
        return {
            decision,
            reason: typeof reason === 'string' && reason.length > 0
                ? reason.slice(0, 200)
                : `classifier decision: ${decision}`,
        };
    }
}
/**
 * One-token fast filter (stage 1 of two-stage classification).
 *
 * Sends a minimal prompt asking for a single digit: 0 = safe, 1 = needs
 * review. Costs ~1 token. Most routine actions return 0 (safe) and skip
 * the expensive structured review. Only actions that return 1 proceed to
 * the full `classify()` call.
 *
 * Returns true if the action needs review, false if safe, null on failure.
 */
export async function fastFilter(ctx, actionSummary, provider, model, signal, timeoutMs, reasoningEffort, logger) {
    const res = await streamTokens(ctx, {
        provider,
        model,
        system: 'You are a safety filter. Reply with exactly one digit: 0 if the action is routine and safe, 1 if it needs careful review. Nothing else.',
        user: actionSummary,
        temperature: 0,
        maxTokens: FAST_FILTER_MAX_TOKENS,
        signal,
        timeoutMs,
        reasoningEffort,
        logger,
    });
    if (!res)
        return null;
    if (res.reasonKind === 'error' || res.reasonKind === 'aborted')
        return null;
    // Parse a standalone 0/1 digit (reasoning models may emit prose around it).
    const m = res.text.match(/(^|\D)([01])(\D|$)/);
    const d = m?.[2];
    if (d === '0')
        return false; // safe
    if (d === '1')
        return true; // needs review
    logger?.warn(`fastFilter no 0/1 digit (${provider}/${model}); raw=${JSON.stringify(res.text.slice(0, 300))} (length=${res.text.length}, reason=${res.reasonKind})`);
    return null; // malformed → caller decides
}
/**
 * Run one classifier call. Returns the verdict, or `null` when the call
 * failed, was aborted, was truncated, or produced an unparsable reply.
 */
export async function classify(ctx, options) {
    const res = await streamTokens(ctx, {
        provider: options.provider,
        model: options.model,
        system: options.system,
        user: options.user,
        temperature: options.temperature,
        maxTokens: options.maxTokens,
        signal: options.signal,
        timeoutMs: options.timeoutMs,
        reasoningEffort: options.reasoningEffort,
        logger: options.logger,
    });
    if (!res)
        return null;
    if (res.reasonKind === 'error' || res.reasonKind === 'aborted')
        return null;
    // max-tokens / normal finish → parse whatever text was produced.
    const verdict = parseVerdict(res.text);
    if (!verdict) {
        options.logger?.warn(`classifier no parseable verdict (${options.provider}/${options.model}); raw=${JSON.stringify(res.text.slice(0, 400))}`);
    }
    return verdict;
}
/**
 * Two-stage classification (spec decision chain, and README "two-stage
 * classifier"): run the cheap one-token fast filter first; only flagged or
 * failed-filter actions proceed to the full structured review.
 *
 * - fastFilter returns `false`  → routine/safe → ALLOW (no full review).
 * - fastFilter returns `true`   → needs review → full classify().
 * - fastFilter returns `null`   → filter failed → be conservative: run the
 *   full classify() (fail-closed upstream decides what a null verdict means).
 *
 * This is what wires the previously-dead `fastFilter` (Bug 1) into both the
 * approval waterfall and the pre-execute escalation pre-screen.
 */
export async function classifyTwoStage(ctx, options, actionSummary) {
    options.logger?.info(`classifier route: ${options.provider}/${options.model} (reasoningEffort=${options.reasoningEffort ?? 'default'})`);
    const needsReview = await fastFilter(ctx, actionSummary, options.provider, options.model, options.signal, options.timeoutMs, options.reasoningEffort, options.logger);
    if (needsReview === false) {
        return { decision: 'allow', reason: 'one-token filter: routine/safe action' };
    }
    // true (needs review) or null (filter failed) → full structured review.
    return classify(ctx, options);
}
