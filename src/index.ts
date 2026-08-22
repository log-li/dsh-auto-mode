/**
 * dsh-automode — CC-style auto mode for DeepSeek Harness (v0.5.0).
 *
 * Merges dsh-auto-mode v0.4.1 (deterministic bands, pre-execute gate,
 * robust parser, circuit breaker, verdict cache) with Nuo-cl/dsh-auto-mode
 * (native preset integration, three-state decision, system-prompt shadowing,
 * /auto command) and pi-automode ($defaults, two-stage classifier,
 * allowInsideWorkingDirectory).
 *
 * Two enforcement points:
 *   1. tools/pre-execute gate — ALL tools, first defense
 *   2. approval/request waterfall — triggered approvals, second defense
 */
import type { Context } from '@deepseek-ai/cordis';
import '@deepseek-ai/dsh-commands';
import { createUserMessage } from '@deepseek-ai/dsh-llm';
import type { Agent } from '@deepseek-ai/dsh-agent';
import type { Session } from '@deepseek-ai/dsh-session';
import {
  effectiveApprovalPolicy,
  setApprovalPolicy,
  type ApprovalOutcome,
  type ApprovalPolicy,
  type ApprovalRequest,
} from '@deepseek-ai/dsh-user-approval';
import {
  effectiveSandboxMode,
  setSandboxMode,
} from '@deepseek-ai/dsh-sandbox-policy';
import { effectivePermissionPreset } from '@deepseek-ai/dsh-permission-presets';

import { Config, type ConfigType, expandDefaults } from './config.js';
import { classifyBand, compileRegex, compileGlob, bashCommandOf } from './bands.js';
import { findAllowRule, findDenyRule, isAllowlisted } from './rules.js';
import { buildSystemPrompt, buildUserMessage, promptInputOf } from './prompt.js';
import {
  classify,
  fastFilter,
  parseVerdict,
  renderTranscript,
  resolveRoute,
} from './classifier.js';
import { VerdictCache } from './cache.js';
import { Breaker } from './breaker.js';
import { registerPreExecute } from './pre-execute.js';
import { appendFileSync, mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

export const name = 'dsh-automode';
export { Config };

export const inject = ['approval', 'llm'];

const AUTO_MODE_PRESET = 'auto-mode';
const AUTO_SANDBOX = 'workspace-write';

// ---- System-prompt shadowing (Nuo-cl) ----

const AUTO_SENTENCE =
  'Approval policy: auto. Every tool call that would normally need ' +
  'approval is inspected by a separate reviewer model, which returns one of ' +
  'three rulings: approved, blocked, or needs-human-input. If a tool result ' +
  'later says the user rejected the call, remember that the reviewer may be ' +
  'the one that blocked it — a person did not necessarily object.';

const ASK_SENTENCE =
  'Approval policy: ask. Operations that require approval may ask through ' +
  'the configured answerers; without an available answerer, the request fails closed.';

const NEVER_SENTENCE =
  'Approval prompts are disabled in this session: actions that require ' +
  'approval are rejected automatically — do not request sandbox escalation.';

// ---- Helpers ----

export function isAuto(session: Session): boolean {
  return effectivePermissionPreset(session.events) === AUTO_MODE_PRESET;
}

function policyOf(session: Session): ApprovalPolicy | 'auto' | undefined {
  return isAuto(session) ? 'auto' : effectiveApprovalPolicy(session.events);
}

function writeAutoModeKnobs(ctx: Context, session: Session): void {
  const events = session.events;
  if (effectivePermissionPreset(events) !== AUTO_MODE_PRESET) {
    session.append('permission/preset', { preset: AUTO_MODE_PRESET });
  }
  if (effectiveSandboxMode(events) !== AUTO_SANDBOX) {
    setSandboxMode(session, AUTO_SANDBOX);
  }
  const current = effectiveApprovalPolicy(events) ?? ctx.approval.config.policy ?? 'ask';
  if (current !== 'ask') setApprovalPolicy(session, 'ask');
}

export function writeAutoMode(ctx: Context, agent: Agent): void {
  if (isAuto(agent.session)) return;
  const service = ctx.get('permissionPresets') as { set(s: Session, n: string): void } | undefined;
  if (service) {
    try { service.set(agent.session, AUTO_MODE_PRESET); } catch {
      writeAutoModeKnobs(ctx, agent.session);
    }
  } else {
    writeAutoModeKnobs(ctx, agent.session);
  }
  agent.inject(createUserMessage({
    content: [{ type: 'text', text: 'Auto mode enabled. Permission-gated tool calls will now be decided automatically.' }],
    source: { kind: 'plugin', plugin: 'auto-mode' },
  }));
}

// ---- Human ask (Nuo-cl, for askFallback=true) ----

interface UserQuestionsLike {
  ask(req: {
    agent: Agent;
    signal?: AbortSignal;
    questions: Array<{ id: string; question: string; detail?: string; header?: string; options?: Array<{ label: string; description?: string }> }>;
  }): Promise<{ answers: Array<{ id: string; selected: string[]; custom?: string }> }>;
}

type HumanDecision =
  | { kind: 'allow' }
  | { kind: 'reject' }
  | { kind: 'reject-with-text'; text: string }
  | { kind: 'cancelled' }
  | { kind: 'unavailable' };

export async function askHumanForDecision(ctx: Context, req: ApprovalRequest): Promise<HumanDecision> {
  const uq = ctx.get('userQuestions') as UserQuestionsLike | undefined;
  if (!uq) return { kind: 'unavailable' };
  try {
    const answer = await uq.ask({
      agent: req.agent,
      signal: req.signal,
      questions: [{
        id: 'auto-mode-approval',
        header: 'Auto mode 权限确认',
        question: `工具调用 ${req.toolName} 需要你的确认。${req.reason ? `原因：${req.reason}` : ''}`,
        detail: '分类器无法确定该操作是否符合你的意图，请人工决定。',
        options: [
          { label: '允许', description: '放行本次操作' },
          { label: '拒绝', description: '拒绝本次操作' },
          { label: '拒绝并指示', description: '拒绝操作，并输入你期望的处理方式' },
        ],
      }],
    });
    const item = answer.answers[0];
    const selected = item?.selected ?? [];
    const custom = item?.custom?.trim();
    if (selected.includes('允许')) return { kind: 'allow' };
    if (selected.includes('拒绝并指示') && custom) return { kind: 'reject-with-text', text: custom };
    if (selected.includes('拒绝并指示') || selected.includes('拒绝')) return { kind: 'reject' };
    if (custom) return { kind: 'reject-with-text', text: custom };
    return { kind: 'reject' };
  } catch (error) {
    if (req.signal?.aborted) return { kind: 'cancelled' };
    if ((error as { code?: string } | null)?.code === 'ASK_ABORTED') return { kind: 'reject' };
    return { kind: 'unavailable' };
  }
}

// ---- Main decision chain ----

function denialText(category: string, reason: string): string {
  return `dsh-auto-mode denied this action (${category}): ${reason}. Find a safer alternative approach and retry.`;
}

function classifierUnavailableText(detail: string, toolName: string): string {
  const m = detail.toLowerCase();
  let cat = '';
  if (/timed?\s*out|timeout|stalled/.test(m)) cat = ' (timed out)';
  else if (/rate.?limit|429/.test(m)) cat = ' (rate-limited)';
  else if (/overload|529/.test(m)) cat = ' (overloaded)';
  else if (/server error|\b5\d\d\b/.test(m)) cat = ' (server error)';
  else if (/connect|network|socket|fetch failed|econn/.test(m)) cat = ' (connection failed)';
  return `dsh-auto-mode: the safety classifier is temporarily unavailable${cat}, so auto mode cannot determine the safety of ${toolName} right now. Wait a moment and then try this action again. (detail: ${detail})`;
}

async function decideAuto(
  ctx: Context,
  config: ConfigType,
  req: ApprovalRequest,
  next: () => Promise<ApprovalOutcome>,
  cache: VerdictCache,
  breaker: Breaker,
  logger: { info: (m: string) => void; warn: (m: string) => void },
): Promise<ApprovalOutcome> {
  const { agent, toolName, reason, signal } = req;
  if (signal?.aborted) return 'cancelled';

  // 1. Hard deny rules (deterministic regex bands)
  const denyPatterns = config.deny.map(compileRegex);
  const args = undefined; // approval path doesn't carry raw args
  const denyHit = classifyBand(toolName, reason ?? '', args, denyPatterns, [], []);
  if (denyHit.action === 'deny') {
    logger.info(`deny band "${denyHit.tier}" matched → reject ${toolName}`);
    return 'rejected';
  }

  // 2. Prose deny rules (soft_deny, $defaults expanded)
  const softDenyRules = expandDefaults(config.rules.deny, 'soft_deny');
  const denyRule = findDenyRule(softDenyRules, toolName, reason);
  if (denyRule) {
    logger.info(`soft deny rule "${denyRule}" → reject ${toolName}`);
    return 'rejected';
  }

  // 3. Prose allow rules (soft_allow, $defaults expanded)
  const softAllowRules = expandDefaults(config.rules.allow, 'soft_allow');
  const allowRule = findAllowRule(softAllowRules, toolName, reason);
  if (allowRule) {
    logger.info(`soft allow rule "${allowRule}" → approve ${toolName}`);
    return 'allowed-once';
  }

  // 4. Pre-approved tools (read-only fast path)
  if (isAllowlisted(toolName, config.readOnlyTools)) {
    logger.info(`readOnlyTools fast path → approve ${toolName}`);
    return 'allowed-once';
  }

  // 5. Cache hit (pre-execute already classified)
  const sig = VerdictCache.sig(toolName, reason ?? '', args);
  const sid = String(agent.session.id ?? '?');
  const cached = cache.get(sid, sig);
  if (cached === 'ALLOW') {
    logger.info(`cache hit ALLOW → approve ${toolName}`);
    return 'allowed-once';
  }
  if (cached === 'DENY') {
    logger.info(`cache hit DENY → reject ${toolName}`);
    return 'rejected';
  }

  // 6. Breaker check
  if (breaker.isTripped(sid)) {
    logger.info(`breaker tripped → delegating to human for ${toolName}`);
    return next();
  }

  // 7. Classifier
  const route = resolveRoute(agent, config.classifier.provider, config.classifier.model);
  if (!route.provider || !route.model) {
    logger.warn(`no classifier route — ${config.failClosed ? 'rejecting (failClosed)' : 'falling back to approval chain'}`);
    return config.failClosed ? 'rejected' : next();
  }

  const environmentFacts = expandDefaults(config.rules.environment, 'environment');
  const input = promptInputOf(req, softAllowRules, softDenyRules, environmentFacts);
  const transcript = renderTranscript(agent.session.deriveMessages(), config.classifier.maxTranscriptMessages);

  logger.info(`classifying ${toolName}${reason ? ` (${reason})` : ''} via ${route.provider}/${route.model}`);

  const verdict = await classify(ctx, {
    system: buildSystemPrompt(input),
    user: buildUserMessage(input, transcript),
    provider: route.provider,
    model: route.model,
    temperature: config.classifier.temperature,
    maxTokens: config.classifier.maxTokens,
    signal,
  });

  if (verdict) {
    logger.info(`classifier verdict: ${verdict.decision} — ${verdict.reason}`);

    switch (verdict.decision) {
      case 'allow':
        cache.put(sid, sig, 'ALLOW');
        breaker.resetConsecutive(sid);
        return 'allowed-once';

      case 'reject': {
        cache.put(sid, sig, 'DENY');
        const justTripped = breaker.countDeny(sid, config.breakerConsecutive, config.breakerTotal);
        if (justTripped) {
          logger.warn(`breaker tripped for session ${sid}`);
        }
        // Inject explanation so the model knows it was the reviewer, not a human
        agent.inject(createUserMessage({
          content: [{
            type: 'text',
            text: `Auto mode blocked the ${toolName} call. Reviewer reason: ${verdict.reason}. ` +
              'The tool result may say "the user rejected" — in auto mode that usually means the reviewer, not a person. ' +
              'Try a smaller or safer version, or ask the user for explicit permission.',
          }],
          source: { kind: 'plugin', plugin: 'auto-mode' },
        }));
        return 'rejected';
      }

      case 'ask': {
        if (!config.classifier.askFallback) {
          logger.info(`classifier asked for human confirmation — treating as rejection (askFallback=false)`);
          return 'rejected';
        }
        const decision = await askHumanForDecision(ctx, req);
        switch (decision.kind) {
          case 'allow': return 'allowed-once';
          case 'reject': return 'rejected';
          case 'cancelled': return 'cancelled';
          case 'reject-with-text':
            agent.inject(createUserMessage({
              content: [{ type: 'text', text: decision.text }],
              source: { kind: 'user' },
            }));
            return 'rejected';
          case 'unavailable': return next();
        }
      }
    }
  }

  // 8. No verdict → fail-closed or fallback
  if (signal?.aborted) return 'cancelled';
  logger.warn(`classifier produced no verdict — ${config.failClosed ? 'rejecting (failClosed)' : 'falling back to approval chain'}`);
  return config.failClosed ? 'rejected' : next();
}

// ---- Persistent JSONL logging ----

function appendDecision(entry: Record<string, unknown>): void {
  try {
    const logDir = join(homedir(), '.dsh', 'auto-mode');
    mkdirSync(logDir, { recursive: true });
    appendFileSync(join(logDir, 'decisions.jsonl'), JSON.stringify({ at: new Date().toISOString(), ...entry }) + '\n');
  } catch { /* best effort */ }
}

// ---- Apply ----

export function apply(ctx: Context, rawConfig: unknown): void {
  const config = Config(rawConfig as any) as ConfigType;
  const logger = ctx.logger('auto-mode');
  const cache = new VerdictCache();
  const breaker = new Breaker();

  // --- 1. Pre-execute gate ---
  if (config.preExecuteGate) {
    registerPreExecute(ctx, config, cache, breaker, logger);
  }

  // --- 2. Approval answerer ---
  ctx.on('approval/request', (req, next) => {
    if (!isAuto(req.agent.session)) return next();
    const sid = String(req.agent.session.id ?? '?');

    // Breaker tripped → delegate to human
    if (breaker.isTripped(sid)) {
      const ans = next();
      // Note: we can't await here in the sync handler; the breaker resume
      // happens when the human approves via the UI. This is a simplification.
      return ans;
    }

    return decideAuto(ctx, config, req, next, cache, breaker, logger).then((outcome) => {
      appendDecision({
        event: 'decision',
        outcome,
        tool: req.toolName,
        sessionId: sid,
        reason: req.reason,
      });

      // Breaker resume on human approval
      if (outcome === ('allowed-once' as ApprovalOutcome) || outcome === ('always' as ApprovalOutcome)) {
        if (breaker.isTripped(sid)) {
          breaker.resume(sid);
          appendDecision({ event: 'resume', tool: req.toolName, sessionId: sid });
        }
      }

      return outcome;
    });
  }, { prepend: true });

  // --- 3. System-prompt shadowing (Nuo-cl) ---
  ctx.inject(['systemPrompt'], (scope) => {
    ctx.on('agent/created', ({ agent }) => {
      agent.ctx.inject(['systemPrompt'], (agentScope) => {
        agentScope.systemPrompt.context({
          name: 'approval:policy',
          order: 115,
          text: () => {
            const policy = policyOf(agent.session) ?? 'ask';
            if (policy === 'auto') return AUTO_SENTENCE;
            return policy === 'never' ? NEVER_SENTENCE : ASK_SENTENCE;
          },
        });
      });
    });
  });

  // --- 4. Commands ---
  ctx.inject(['commands'], (scope) => {
    scope.commands.register({
      name: 'auto',
      description: 'Switch this session to auto mode.',
      handler: ({ agent }: { agent: Agent }) => {
        if (isAuto(agent.session)) return { kind: 'success' as const, text: 'Already in auto mode.' };
        writeAutoMode(ctx, agent);
        return { kind: 'success' as const, text: 'Auto mode enabled.' };
      },
    });
    scope.commands.register({
      name: 'auto-status',
      description: 'Show auto-mode diagnostics.',
      handler: ({ agent }: { agent: Agent }) => {
        const auto = isAuto(agent.session);
        const preset = effectivePermissionPreset(agent.session.events);
        const approval = effectiveApprovalPolicy(agent.session.events) ?? ctx.approval.config.policy ?? 'ask';
        const b = breaker.get(String(agent.session.id ?? '?'));
        return {
          kind: 'success' as const,
          text: `auto=${auto}; preset=${preset ?? 'none'}; approval=${approval}; breaker=${b.tripped ? 'TRIPPED' : `c=${b.consecutive}/t=${b.total}`}`,
        };
      },
    });
  });

  // --- 5. Boot log ---
  appendDecision({ event: 'boot', tool: '-', detail: `dsh-automode v0.5.0 active (failClosed=${config.failClosed}, preExecute=${config.preExecuteGate})` });
  logger.info(`dsh-automode v0.5.0 active (failClosed=${config.failClosed}, preExecute=${config.preExecuteGate})`);
}
