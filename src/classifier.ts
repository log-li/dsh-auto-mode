/**
 * LLM classifier: renders the conversation transcript, streams one
 * classifier call through `ctx.llm`, and parses the JSON verdict.
 *
 * The classifier is fail-aware but not fail-closed by itself: it returns
 * `null` when no verdict can be produced (API error, aborted stream,
 * truncated or unparsable reply), and the caller decides what `null` means
 * (`failClosed` config, or falling back to the human approval chain).
 */
import type { Context } from '@deepseek-ai/cordis';
import type { Agent } from '@deepseek-ai/dsh-agent';
import { createUserMessage, type ContentBlock, type Message } from '@deepseek-ai/dsh-llm';

/** A classifier decision: allow, ask a human, or reject. */
export type VerdictDecision = 'allow' | 'ask' | 'reject';

/** A parsed classifier verdict. */
export interface Verdict {
  /** The decision. */
  readonly decision: VerdictDecision;
  /** The classifier's one-sentence justification. */
  readonly reason: string;
}

/** Options for one classifier call. */
export interface ClassifyOptions {
  /** System prompt (see prompt.ts). */
  readonly system: string;
  /** User message: transcript + action (see prompt.ts). */
  readonly user: string;
  /** Provider route for the call (already resolved). */
  readonly provider: string;
  /** Model id for the call (already resolved). */
  readonly model: string;
  /** Sampling temperature. */
  readonly temperature: number;
  /** Output token budget. */
  readonly maxTokens: number;
  /** Cancellation signal (the approval request's signal). */
  readonly signal?: AbortSignal;
}

/** Render one content block into plain text. */
function renderBlock(block: ContentBlock): string {
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
function renderMessage(message: Message): string {
  const content = message.content.map(renderBlock).filter(Boolean).join(' ');
  return `${message.role}: ${content}`;
}

/**
 * Render a transcript as classifier input: the trailing `maxMessages`
 * messages, oldest first, one per line.
 */
export function renderTranscript(
  messages: readonly Message[],
  maxMessages: number,
): string {
  const tail = messages.slice(Math.max(0, messages.length - maxMessages));
  return tail.map(renderMessage).join('\n\n');
}

/**
 * Resolve the classifier route: explicit config wins, otherwise the agent's
 * own options, otherwise the session's current request header.
 */
export function resolveRoute(
  agent: Agent,
  configuredProvider: string,
  configuredModel: string,
): { provider: string; model: string } {
  const header = agent.session.requestHeader()?.config;
  const provider =
    configuredProvider || agent.options.provider || header?.provider || '';
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
export function parseVerdict(reply: string): Verdict | null {
  const trimmed = reply.trim();
  if (trimmed === '') return null;

  // Strip markdown code fences (```json … ```).
  let t = trimmed.replace(/```(?:json)?\s*/gi, '').replace(/```/g, '');

  // Try the first balanced JSON object.
  const firstBrace = t.indexOf('{');
  const lastBrace = t.lastIndexOf('}');
  if (firstBrace !== -1 && lastBrace > firstBrace) {
    const candidate = t.slice(firstBrace, lastBrace + 1);
    try {
      const parsed = JSON.parse(candidate) as Record<string, unknown>;
      const raw = String(
        parsed.decision ?? parsed.verdict ?? parsed.classification ?? '',
      ).toLowerCase();

      // Boolean fields: safe/allow → allow; safe:false/deny/block → reject
      if (parsed.safe === true || parsed.allow === true)
        return verdict('allow', parsed.reason);
      if (
        parsed.safe === false ||
        parsed.allow === false ||
        parsed.block === true ||
        parsed.deny === true
      )
        return verdict('reject', parsed.reason);

      if (raw) {
        // CRITICAL: deny-first ordering — "unsafe" contains "safe"
        if (/unsafe|deny|block|reject|forbid/.test(raw))
          return verdict('reject', parsed.reason);
        if (/safe|allow|permit|approve|yes/.test(raw))
          return verdict('allow', parsed.reason);
        if (raw === 'ask') return verdict('ask', parsed.reason);
      }
    } catch {
      // not valid JSON — fall through to keyword scan
    }
  }

  // Keyword fallback on the whole text (model-agnostic last resort).
  const low = t.toLowerCase();
  const denySignal =
    /(^|[^a-z])(unsafe|den(y|ies)|block(ed|ing)?|reject(ed)?|forbid(den)?|malicious|danger(ous)?)([^a-z]|$)/.test(
      low,
    );
  const allowSignal =
    /(^|[^a-z])(safe|allow(ed)?|permit(ted)?|approve[ds]?|benign|okay?)([^a-z]|$)/.test(
      low,
    );

  if (denySignal && !allowSignal) return verdict('reject');
  if (allowSignal && !denySignal) return verdict('allow');
  if (denySignal && allowSignal) return verdict('reject'); // conflict → fail closed

  return null; // no signal → caller fails closed

  function verdict(
    decision: VerdictDecision,
    reason?: unknown,
  ): Verdict {
    return {
      decision,
      reason:
        typeof reason === 'string' && reason.length > 0
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
export async function fastFilter(
  ctx: Context,
  actionSummary: string,
  provider: string,
  model: string,
  signal?: AbortSignal,
): Promise<boolean | null> {
  let text = '';
  try {
    for await (const chunk of ctx.llm.stream({
      provider,
      model,
      system:
        'You are a safety filter. Reply with exactly one digit: 0 if the action is routine and safe, 1 if it needs careful review. Nothing else.',
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
      if (chunk.type === 'text-delta') text += chunk.text;
      if (chunk.type === 'finish') {
        if (chunk.reason.kind === 'error' || chunk.reason.kind === 'aborted')
          return null;
      }
    }
  } catch {
    return null;
  }
  const digit = text.trim()[0];
  if (digit === '0') return false; // safe
  if (digit === '1') return true; // needs review
  return null; // malformed → caller decides
}

/**
 * Run one classifier call. Returns the verdict, or `null` when the call
 * failed, was aborted, was truncated, or produced an unparsable reply.
 */
export async function classify(
  ctx: Context,
  options: ClassifyOptions,
): Promise<Verdict | null> {
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
      } else if (chunk.type === 'finish') {
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
  } catch {
    return null;
  }
  return parseVerdict(text);
}
