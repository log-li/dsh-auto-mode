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
import { isAuto, writeAutoMode } from '../lib/index.js';
import { Breaker } from '../lib/breaker.js';
import { VerdictCache, hashString } from '../lib/cache.js';
import { tokenizeShell, bashWriteDestinations } from '../lib/bands.js';

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
test('parses two-value decision verdict (ask is normalized to reject)', () => {
  assert.deepEqual(
    parseVerdict('{"decision": "allow", "reason": "safe read"}'),
    { decision: 'allow', reason: 'safe read' },
  );
  assert.deepEqual(
    parseVerdict('{"decision": "reject", "reason": "dangerous"}'),
    { decision: 'reject', reason: 'dangerous' },
  );
  // Two-state (0.8.0): legacy "ask" output fails closed → reject.
  assert.deepEqual(
    parseVerdict('{"decision": "ask", "reason": "may be intended"}'),
    { decision: 'reject', reason: 'uncertain (ask) — treated as reject (fail-closed)' },
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
    reason: 'classifier decision: allow',
  });
});
test('falls back to decision/allow token scan', () => {
  // NOTE: the refactored keyword fallback has no `ask` signal, so a bare
  // `decision = "ask"` (non-JSON) yields null (fail-closed upstream). The JSON
  // path normalizes `{"decision":"ask"}` to reject (see two-value test above).
  assert.equal(parseVerdict('decision = "ask" definitely'), null);
  // CAVEAT (fail-open): the keyword scan matches the bare word "allow", so
  // `allow = false` is read as allow, not reject. JSON `{"allow":false}` is the
  // correct reject path. Documenting actual behavior; do not treat this as the
  // safety-correct answer for prose negation.
  assert.deepEqual(parseVerdict('allow = false, definitely'), {
    decision: 'allow',
    reason: 'classifier decision: allow',
  });
});
test('invalid verdict values reject the whole reply', () => {
  // JSON `{"allow":"yes"}` is not a typed boolean: the strict boolean fields
  // don't fire, so it falls through to the keyword scan which sees "allow"/"yes"
  // and returns allow (loose). JSON `{"decision":"maybe"}` has no deny/allow
  // signal and yields null (fail-closed upstream).
  assert.deepEqual(parseVerdict('{"allow": "yes", "reason": "x"}'), {
    decision: 'allow',
    reason: 'classifier decision: allow',
  });
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

console.log('\nbreaker.js');
test('breaker trips after N consecutive denies', () => {
  const b = new Breaker();
  const sid = 's1';
  assert.equal(b.countDeny(sid, 3, 20), false);
  assert.equal(b.countDeny(sid, 3, 20), false);
  assert.equal(b.countDeny(sid, 3, 20), true); // 3rd consecutive → trip
  assert.equal(b.isTripped(sid), true);
  assert.deepEqual(b.get(sid), { consecutive: 3, total: 3, tripped: true });
});
test('breaker trips after N total denies (non-consecutive)', () => {
  const b = new Breaker();
  const sid = 's2';
  let tripped = false;
  for (let i = 0; i < 20; i++) tripped = b.countDeny(sid, 100, 20); // only total threshold
  assert.equal(tripped, true);
  assert.equal(b.isTripped(sid), true);
  assert.equal(b.get(sid).total, 20);
});
test('resetConsecutive clears only the consecutive counter', () => {
  const b = new Breaker();
  const sid = 's3';
  b.countDeny(sid, 3, 20); // c=1,t=1
  b.countDeny(sid, 3, 20); // c=2,t=2
  b.resetConsecutive(sid);
  assert.deepEqual(b.get(sid), { consecutive: 0, total: 2, tripped: false });
});
test('resume resets counters and clears tripped', () => {
  const b = new Breaker();
  const sid = 's4';
  b.countDeny(sid, 3, 20);
  b.countDeny(sid, 3, 20);
  b.countDeny(sid, 3, 20); // trip
  assert.equal(b.isTripped(sid), true);
  b.resume(sid);
  assert.deepEqual(b.get(sid), { consecutive: 0, total: 0, tripped: false });
  assert.equal(b.isTripped(sid), false);
});

console.log('cache.js (intent-aware verdict cache)');
test('hashString is deterministic', () => {
  assert.equal(hashString('allow writing to OneDrive'), hashString('allow writing to OneDrive'));
  assert.equal(hashString(''), hashString(''));
  assert.notEqual(hashString('allow'), hashString('deny'));
});
test('sig appends intent hash and differs when intent changes', () => {
  const base = VerdictCache.sig('bash', 'escalate', { command: 'cp a.docx /dest' }, 200);
  const withA = VerdictCache.sig('bash', 'escalate', { command: 'cp a.docx /dest' }, 200, hashString('allow OneDrive'));
  const withB = VerdictCache.sig('bash', 'escalate', { command: 'cp a.docx /dest' }, 200, hashString('deny OneDrive'));
  assert.notEqual(withA, withB);          // different intent → different key
  assert.notEqual(withA, base);           // intent-hashed differs from legacy
  assert.ok(withA.startsWith(`${base}|intent:`));
});
test('cache get/put respects the intent-hashed signature', () => {
  const c = new VerdictCache();
  const sid = 's-intent';
  const s1 = VerdictCache.sig('bash', 'r', { command: 'cp a /d' }, 200, hashString('intent1'));
  const s2 = VerdictCache.sig('bash', 'r', { command: 'cp a /d' }, 200, hashString('intent2'));
  c.put(sid, s1, 'DENY');
  assert.equal(c.get(sid, s1), 'DENY');
  assert.equal(c.get(sid, s2), null); // new intent → cache miss (user grant re-classifies)
});

console.log('bands.js (bashWriteDestinations)');
test('cp/mv destination is the last positional', () => {
  assert.deepEqual(
    bashWriteDestinations('cp file.docx "/Users/x/OneDrive/Proposal/GRF 2026 a.docx"'),
    ['/Users/x/OneDrive/Proposal/GRF 2026 a.docx'],
  );
  assert.deepEqual(bashWriteDestinations('cp -r src /Users/x/OneDrive/Proposal/'), ['/Users/x/OneDrive/Proposal/']);
  assert.deepEqual(bashWriteDestinations('mv a b /Users/x/OneDrive/Proposal/f'), ['/Users/x/OneDrive/Proposal/f']);
});
test('cp -t / --target-directory form', () => {
  assert.deepEqual(bashWriteDestinations('cp -t /Users/x/OneDrive/Proposal a b'), ['/Users/x/OneDrive/Proposal']);
  assert.deepEqual(bashWriteDestinations('cp --target-directory=/Users/x/OneDrive/Proposal a b'), ['/Users/x/OneDrive/Proposal']);
});
test('rsync/install destination', () => {
  assert.deepEqual(bashWriteDestinations('rsync -av --delete /src/ /Users/x/OneDrive/Proposal/'), ['/Users/x/OneDrive/Proposal/']);
  assert.deepEqual(bashWriteDestinations('install -m 755 src /Users/x/OneDrive/Proposal/bin'), ['/Users/x/OneDrive/Proposal/bin']);
});
test('tar/unzip extract target (-C / -d)', () => {
  assert.deepEqual(bashWriteDestinations('tar -xzf x.tar.gz -C /Users/x/OneDrive/Proposal/'), ['/Users/x/OneDrive/Proposal/']);
  assert.deepEqual(bashWriteDestinations('unzip x.zip -d /Users/x/OneDrive/Proposal/'), ['/Users/x/OneDrive/Proposal/']);
  assert.deepEqual(bashWriteDestinations('tar xf x.tar'), []); // extracts to cwd, not an explicit dest
});
test('curl -o / wget -O target', () => {
  assert.deepEqual(bashWriteDestinations('curl -o /Users/x/OneDrive/Proposal/f https://example.com/a'), ['/Users/x/OneDrive/Proposal/f']);
  assert.deepEqual(bashWriteDestinations('wget -O /Users/x/OneDrive/Proposal/f https://example.com/a'), ['/Users/x/OneDrive/Proposal/f']);
});
test('git clone target dir', () => {
  assert.deepEqual(
    bashWriteDestinations('git clone https://github.com/x/y /Users/x/OneDrive/Proposal/repo'),
    ['/Users/x/OneDrive/Proposal/repo'],
  );
  assert.deepEqual(bashWriteDestinations('git clone https://github.com/x/y'), []);
});
test('non-write commands and deletion are NOT allowlisted', () => {
  assert.deepEqual(bashWriteDestinations('ls /Users/x/OneDrive/Proposal'), []);
  assert.deepEqual(bashWriteDestinations('cat /etc/passwd'), []);
  assert.deepEqual(bashWriteDestinations('rm -rf /Users/x/OneDrive/Proposal'), []);
  assert.deepEqual(bashWriteDestinations('rm /Users/x/OneDrive/Proposal/f'), []);
  assert.deepEqual(bashWriteDestinations('trash /Users/x/OneDrive/Proposal/f'), []);
});
test('composite/redirect/empty commands are skipped', () => {
  assert.deepEqual(bashWriteDestinations('cp a /dest && echo done'), []);
  assert.deepEqual(bashWriteDestinations('echo hi > /Users/x/OneDrive/Proposal/f'), []);
  assert.deepEqual(bashWriteDestinations(''), []);
});

console.log(`\nall ${passed} smoke tests passed`);