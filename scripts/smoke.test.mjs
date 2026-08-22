/**
 * Smoke tests for the pure logic of dsh-auto-mode — runs against the
 * compiled lib/ output with plain node, no DSH runtime needed.
 *
 *   node scripts/smoke.test.mjs
 */
import assert from 'node:assert/strict';
import { findAllowRule, findDenyRule, isAllowlisted, patternMatches } from '../lib/rules.js';
import { parseVerdict, renderTranscript } from '../lib/classifier.js';
import { buildSystemPrompt, buildUserMessage } from '../lib/prompt.js';
import { askHumanForDecision, isAuto, writeAutoMode } from '../lib/index.js';

let passed = 0;
function test(name, fn) {
  fn();
  passed += 1;
  console.log(`  ok - ${name}`);
}

console.log('rules.js');
test('exact tool name matches case-insensitively', () => {
  assert.equal(findAllowRule(['read'], 'Read', undefined), 'read');
  assert.equal(findAllowRule(['READ'], 'read', undefined), 'READ');
});
test('tool:pattern matches reason substring', () => {
  const reason = '[sandbox: file access denied under read-only mode]';
  assert.equal(findAllowRule(['read:/etc/'], 'read', reason), undefined);
  assert.equal(findAllowRule(['read:file access denied'], 'read', reason), 'read:file access denied');
});
test('wildcard pattern matches whole reason', () => {
  assert.equal(patternMatches('/etc/*', '/etc/passwd'), true);
  assert.equal(patternMatches('/etc/*', '/var/log'), false);
  assert.equal(patternMatches('rm -rf *', 'rm -rf /'), true);
});
test('star tool matches any tool', () => {
  assert.equal(findDenyRule(['*:delete'], 'write', 'delete file'), '*:delete');
  assert.equal(findDenyRule(['*'], 'anything', undefined), '*');
});
test('deny and allow are independent', () => {
  assert.equal(findDenyRule(['read:/etc/*'], 'read', '/etc/passwd'), 'read:/etc/*');
  assert.equal(findAllowRule(['read:/etc/*'], 'read', '/home/x'), undefined);
});
test('allowlist is case-insensitive', () => {
  assert.equal(isAllowlisted('Read', ['read', 'glob']), true);
  assert.equal(isAllowlisted('pwsh', ['read', 'glob']), false);
});

console.log('classifier.js');
test('parses three-value decision verdict', () => {
  assert.deepEqual(
    parseVerdict('{"decision": "allow", "reason": "safe read"}'),
    { decision: 'allow', reason: 'safe read' },
  );
  assert.deepEqual(
    parseVerdict('{"decision": "ask", "reason": "may be intended"}'),
    { decision: 'ask', reason: 'may be intended' },
  );
  assert.deepEqual(
    parseVerdict('{"decision": "reject", "reason": "dangerous"}'),
    { decision: 'reject', reason: 'dangerous' },
  );
});
test('parses JSON inside markdown fence', () => {
  const reply = '```json\n{"decision": "reject", "reason": "rm -rf is destructive"}\n```';
  assert.deepEqual(parseVerdict(reply), {
    decision: 'reject',
    reason: 'rm -rf is destructive',
  });
});
test('tolerates surrounding prose', () => {
  const reply = 'Here is my verdict:\n{"decision": "allow", "reason": "ok"}\nHope that helps.';
  assert.deepEqual(parseVerdict(reply), { decision: 'allow', reason: 'ok' });
});
test('legacy boolean verdict still parses', () => {
  assert.deepEqual(parseVerdict('{"allow": true, "reason": "safe read"}'), {
    decision: 'allow',
    reason: 'safe read',
  });
  assert.deepEqual(parseVerdict('{"allow": false, "reason": "x"}'), {
    decision: 'reject',
    reason: 'x',
  });
  assert.deepEqual(parseVerdict('{"allow":true} trailing'), {
    decision: 'allow',
    reason: 'approved by classifier',
  });
});
test('falls back to decision/allow token scan', () => {
  assert.deepEqual(parseVerdict('decision = "ask" definitely'), {
    decision: 'ask',
    reason: 'classifier reply parsed from token scan',
  });
  assert.deepEqual(parseVerdict('allow = false, definitely'), {
    decision: 'reject',
    reason: 'classifier reply parsed from token scan',
  });
});
test('invalid verdict values reject the whole reply', () => {
  assert.equal(parseVerdict('{"allow": "yes", "reason": "x"}'), null);
  assert.equal(parseVerdict('{"decision": "maybe", "reason": "x"}'), null);
});
test('empty reply yields null', () => {
  assert.equal(parseVerdict('   '), null);
});
test('renderTranscript keeps the trailing window', () => {
  const messages = [
    { role: 'user', content: [{ type: 'text', text: 'm1' }] },
    { role: 'assistant', content: [{ type: 'text', text: 'm2' }] },
    { role: 'user', content: [{ type: 'text', text: 'm3' }] },
  ];
  const out = renderTranscript(messages, 2);
  assert.ok(out.includes('m2'));
  assert.ok(out.includes('m3'));
  assert.ok(!out.includes('m1'));
});
test('renderTranscript renders tool calls and results', () => {
  const messages = [
    {
      role: 'assistant',
      content: [{ type: 'tool-call', name: 'read', arguments: '{"path":"a.txt"}', id: 'c1' }],
    },
    {
      role: 'user',
      content: [{ type: 'tool-result', toolCallId: 'c1', isError: false, content: [{ type: 'text', text: 'file contents' }] }],
    },
  ];
  const out = renderTranscript(messages, 10);
  assert.ok(out.includes('[tool call: read {"path":"a.txt"}]'));
  assert.ok(out.includes('[tool result: file contents]'));
});

console.log('prompt.js');
test('system prompt embeds the three rule sections', () => {
  const sys = buildSystemPrompt({
    toolName: 'write',
    reason: 'x',
    allowRules: ['read'],
    denyRules: ['pwsh:rm -rf'],
    environmentFacts: ['Windows host'],
  });
  assert.ok(sys.includes('<standing_approvals>'));
  assert.ok(sys.includes('- read'));
  assert.ok(sys.includes('<standing_rejections>'));
  assert.ok(sys.includes('- pwsh:rm -rf'));
  assert.ok(sys.includes('<environment_notes>'));
  assert.ok(sys.includes('- Windows host'));
});
test('user message carries transcript and action', () => {
  const user = buildUserMessage(
    { toolName: 'pwsh', reason: 'needs admin', allowRules: [], denyRules: [], environmentFacts: [] },
    '<conversation stuff>',
  );
  assert.ok(user.includes('<conversation_so_far>'));
  assert.ok(user.includes('tool: pwsh'));
  assert.ok(user.includes('reason: needs admin'));
});

console.log('auto mode state (index.js)');
function makeAutoHarness({ withService = true, preset, approval } = {}) {
  const events = [];
  if (preset !== undefined) events.push({ type: 'permission/preset', data: { preset } });
  if (approval !== undefined) events.push({ type: 'approval/policy', data: { policy: approval } });
  const session = {
    get events() {
      return events;
    },
    append(type, data) {
      events.push({ type, data });
    },
  };
  const injected = [];
  const agent = {
    session,
    inject(message) {
      injected.push(message);
    },
  };
  const service = {
    set(session_, name) {
      if (name !== 'auto-mode') throw new Error(`unknown preset ${name}`);
      session_.append('permission/preset', { preset: name });
    },
  };
  const ctx = {
    logger() {
      return { info() {}, warn() {} };
    },
    get(name) {
      return name === 'permissionPresets' && withService ? service : undefined;
    },
    approval: { config: { policy: 'ask' } },
  };
  return { events, session, agent, injected, ctx, service };
}

test('isAuto follows the last permission/preset value', () => {
  const { session } = makeAutoHarness({ preset: 'auto-mode' });
  assert.equal(isAuto(session), true);
  session.append('permission/preset', { preset: 'read-only' });
  assert.equal(isAuto(session), false);
  session.append('permission/preset', { preset: 'auto-mode' });
  assert.equal(isAuto(session), true);
});

test('writeAutoMode uses the public permissionPresets.set path', () => {
  const { events, agent, injected, ctx } = makeAutoHarness();
  writeAutoMode(ctx, agent);
  assert.deepEqual(events.map((e) => e.type), ['permission/preset']);
  assert.equal(events[0].data.preset, 'auto-mode');
  assert.equal(injected.length, 1);
});

test('writeAutoMode falls back to direct core-valid knob events', () => {
  const { events, agent, ctx } = makeAutoHarness({ withService: false });
  writeAutoMode(ctx, agent);
  assert.deepEqual(events.map((e) => e.type), [
    'permission/preset',
    'sandbox/mode',
  ]);
  assert.equal(events[0].data.preset, 'auto-mode');
  assert.equal(events[1].data.mode, 'workspace-write');
  // No approval/policy event is appended when the effective policy is
  // already the auto-mode preset's core-valid "ask".
});

test('writeAutoMode fallback switches a never policy back to ask', () => {
  const { events, agent, ctx } = makeAutoHarness({ withService: false, approval: 'never' });
  writeAutoMode(ctx, agent);
  const policies = events.filter((e) => e.type === 'approval/policy').map((e) => e.data.policy);
  assert.deepEqual(policies, ['never', 'ask']);
});

test('writeAutoMode is a no-op when auto mode is already selected', () => {
  const { events, agent, injected, ctx } = makeAutoHarness({ preset: 'auto-mode' });
  writeAutoMode(ctx, agent);
  assert.equal(events.length, 1);
  assert.equal(injected.length, 0);
});

console.log('human decision flow (index.js)');

function makeQuestionHarness(answer) {
  const questions = [];
  const ctx = {
    get(name) {
      if (name === 'userQuestions') {
        return {
          ask(request) {
            questions.push(request);
            return Promise.resolve(answer);
          },
        };
      }
      return undefined;
    },
  };
  const req = { agent: { id: 'a1' }, toolName: 'pwsh', reason: 'needs admin' };
  return { ctx, req, questions };
}

test('askHumanForDecision: allow option', async () => {
  const { ctx, req } = makeQuestionHarness({
    answers: [{ id: 'auto-mode-approval', selected: ['允许'], custom: '' }],
  });
  assert.deepEqual(await askHumanForDecision(ctx, req), { kind: 'allow' });
});

test('askHumanForDecision: reject option', async () => {
  const { ctx, req } = makeQuestionHarness({
    answers: [{ id: 'auto-mode-approval', selected: ['拒绝'], custom: '' }],
  });
  assert.deepEqual(await askHumanForDecision(ctx, req), { kind: 'reject' });
});

test('askHumanForDecision: reject-with-instructions', async () => {
  const { ctx, req } = makeQuestionHarness({
    answers: [
      { id: 'auto-mode-approval', selected: ['拒绝并指示'], custom: ' 用 read 代替  ' },
    ],
  });
  assert.deepEqual(await askHumanForDecision(ctx, req), {
    kind: 'reject-with-text',
    text: '用 read 代替',
  });
});

test('askHumanForDecision: custom text alone counts as reject-with-instructions', async () => {
  const { ctx, req } = makeQuestionHarness({
    answers: [{ id: 'auto-mode-approval', selected: [], custom: '换个方式' }],
  });
  assert.deepEqual(await askHumanForDecision(ctx, req), {
    kind: 'reject-with-text',
    text: '换个方式',
  });
});

test('askHumanForDecision: no provider is unavailable', async () => {
  const ctx = { get: () => undefined };
  const req = { agent: { id: 'a1' }, toolName: 'pwsh' };
  assert.deepEqual(await askHumanForDecision(ctx, req), { kind: 'unavailable' });
});

test('askHumanForDecision: skipped question is a rejection (fail closed)', async () => {
  const { ctx, req } = makeQuestionHarness({ answers: [] });
  assert.deepEqual(await askHumanForDecision(ctx, req), { kind: 'reject' });
});

test('askHumanForDecision: unanswered question is a rejection', async () => {
  const { ctx, req } = makeQuestionHarness({
    answers: [{ id: 'auto-mode-approval', selected: [], custom: '' }],
  });
  assert.deepEqual(await askHumanForDecision(ctx, req), { kind: 'reject' });
});

test('askHumanForDecision: ASK_ABORTED (user dismissed) is a rejection', async () => {
  const ctx = {
    get: () => ({
      ask: () =>
        Promise.reject(Object.assign(new Error('dismissed'), { code: 'ASK_ABORTED' })),
    }),
  };
  const req = { agent: { id: 'a1' }, toolName: 'pwsh' };
  assert.deepEqual(await askHumanForDecision(ctx, req), { kind: 'reject' });
});

test('askHumanForDecision: aborted signal is cancelled', async () => {
  const ctx = {
    get: () => ({
      ask: () =>
        Promise.reject(Object.assign(new Error('aborted'), { code: 'ASK_ABORTED' })),
    }),
  };
  const controller = new AbortController();
  controller.abort();
  const req = {
    agent: { id: 'a1' },
    toolName: 'pwsh',
    signal: controller.signal,
  };
  assert.deepEqual(await askHumanForDecision(ctx, req), { kind: 'cancelled' });
});

test('askHumanForDecision: provider throw is unavailable', async () => {
  const ctx = {
    get: () => ({
      ask: () => Promise.reject(new Error('boom')),
    }),
  };
  const req = { agent: { id: 'a1' }, toolName: 'pwsh' };
  assert.deepEqual(await askHumanForDecision(ctx, req), { kind: 'unavailable' });
});

console.log(`\nall ${passed} smoke tests passed`);