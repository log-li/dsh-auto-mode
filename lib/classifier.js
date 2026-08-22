import { createUserMessage } from '@deepseek-ai/dsh-llm';
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
 * Resolve the classifier route: explicit config wins, otherwise the agent's
 * own options, otherwise the session's current request header.
 */
export function resolveRoute(agent, configuredProvider, configuredModel) {
    const header = agent.session.requestHeader()?.config;
    const provider = configuredProvider || agent.options.provider || header?.provider || '';
    const model = configuredModel || agent.options.model || header?.model || '';
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
export async function fastFilter(ctx, actionSummary, provider, model, signal) {
    let text = '';
    try {
        for await (const chunk of ctx.llm.stream({
            provider,
            model,
            system: 'You are a safety filter. Reply with exactly one digit: 0 if the action is routine and safe, 1 if it needs careful review. Nothing else.',
            messages: [
                createUserMessage({
                    content: [{ type: 'text', text: actionSummary }],
                    source: { kind: 'plugin', plugin: 'auto-mode' },
                }),
            ],
            temperature: 0,
            maxTokens: 4,
            signal,
        })) {
            if (chunk.type === 'text-delta')
                text += chunk.text;
            if (chunk.type === 'finish') {
                if (chunk.reason.kind === 'error' || chunk.reason.kind === 'aborted')
                    return null;
            }
        }
    }
    catch {
        return null;
    }
    const digit = text.trim()[0];
    if (digit === '0')
        return false; // safe
    if (digit === '1')
        return true; // needs review
    return null; // malformed → caller decides
}
/**
 * Run one classifier call. Returns the verdict, or `null` when the call
 * failed, was aborted, was truncated, or produced an unparsable reply.
 */
export async function classify(ctx, options) {
    let text = '';
    try {
        for await (const chunk of ctx.llm.stream({
            provider: options.provider,
            model: options.model,
            system: options.system,
            messages: [
                createUserMessage({
                    content: [{ type: 'text', text: options.user }],
                    source: { kind: 'plugin', plugin: 'auto-mode' },
                }),
            ],
            temperature: options.temperature,
            maxTokens: options.maxTokens,
            signal: options.signal,
        })) {
            if (chunk.type === 'text-delta') {
                text += chunk.text;
            }
            else if (chunk.type === 'finish') {
                if (chunk.reason.kind === 'error' || chunk.reason.kind === 'aborted') {
                    return null;
                }
                if (chunk.reason.kind === 'max-tokens') {
                    // The reply may be truncated mid-JSON; only a fully parsed verdict
                    // is acceptable, otherwise treat as no verdict.
                    return parseVerdict(text);
                }
            }
        }
    }
    catch {
        return null;
    }
    return parseVerdict(text);
}
