import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execFileSync } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { WORKFLOW_TOOLS, auditWorkflow, delegateWorkflow, sourceEvidence, workflowNotes, workflowSnapshot, runWorkflowHelper, workflowOpenCodeConfig, type WorkflowGenerate } from '../src/server/collaboration.ts';
import { offeredAgents, noAgent, chosenAgent } from '../src/web/agent-choice.ts';
import { AGENT_IDS, type RuntimeStatus } from '../src/shared.ts';

function paper() {
  const root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'papilot-workflow-test-')));
  const git = (...args: string[]) => execFileSync('git', args, { cwd: root, stdio: 'pipe', env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' } });
  git('init'); fs.writeFileSync(path.join(root, 'main.tex'), 'First paragraph.\n\nSecond paragraph.\n'); git('add', '.'); git('-c', 'user.name=Test', '-c', 'user.email=test@example.com', 'commit', '-m', 'Base');
  return { root, close: () => fs.rmSync(root, { recursive: true, force: true }) };
}
const notes = workflowNotes([{ id: 'message', meta: { notes: [{ where: 'main.tex', quote: 'First', comment: 'Polish first.' }, { where: 'main.tex', quote: 'Second', comment: 'Check second.' }] } }], 'Edit');
const signal = () => new AbortController().signal;
const outcomes = () => notes.map(note => ({ id: note.id, status: 'unchanged', explanation: 'Already correct.', evidence: [{ file: 'main.tex', quote: note.quote }] }));
const verified: WorkflowGenerate = async (_executor, prompt) => {
  const data = JSON.parse(prompt.slice(prompt.indexOf('\n') + 1));
  return JSON.stringify({ verified: true, outcomes: data.outcomes.map((entry: any) => ({ id: entry.id, status: entry.status, reason: 'Checked the source.' })), issues: [] });
};

test('workflow choices require explicit host enablement, even for saved selections', () => {
  const ready: RuntimeStatus = { connected: true, authenticated: true, models: [], account: null, error: null };
  assert.deepEqual(offeredAgents({ codex: ready, collaboration: ready }), ['codex']);
  assert.deepEqual(offeredAgents({ codex: ready, collaboration: { ...ready, hidden: false } }), ['codex', 'collaboration']);
  assert.equal(chosenAgent('collaboration', offeredAgents({ codex: ready, collaboration: { ...ready, hidden: true } }), { codex: ready }), 'codex');
  assert.equal(noAgent(Object.fromEntries(AGENT_IDS.filter(id => id !== 'collaboration').map(id => [id, { ...ready, installed: false }]))), true);
});
test('annotation ledger retains repeated notes separately and provides a request for plain tasks', () => {
  assert.deepEqual(notes.map(note => note.id), ['message:1', 'message:2']);
  assert.equal(workflowNotes([], 'Explain')[0].comment, 'Explain');
});
test('parallel edits to different words in the same line are merged by the program', async () => {
  const f = paper(), releases: (() => void)[] = [], copies: string[] = [];
  const original = 'First paragraph. Second paragraph. Existing uncommitted text.\n';
  fs.writeFileSync(path.join(f.root, 'main.tex'), original);
  const generate: WorkflowGenerate = async (executor, _prompt, _signal, _model, edit) => {
    assert.ok(edit); copies.push(edit.cwd); assert.deepEqual(edit.files, ['main.tex']);
    const file = path.join(edit.cwd, 'main.tex');
    fs.writeFileSync(file, fs.readFileSync(file, 'utf8').replace(executor === 'deepseek' ? 'First' : 'Second', executor === 'deepseek' ? 'Updated first' : 'Updated second'));
    await new Promise<void>(resolve => releases.push(resolve)); return 'Edited the assigned annotation.';
  };
  try {
    const jobs = notes.map((note, i) => delegateWorkflow(f.root, notes, { executor: i ? 'gemini' : 'deepseek', annotationIds: [note.id], instruction: note.comment, sources: [{ file: 'main.tex', quote: note.quote }] }, generate, signal()));
    assert.equal(releases.length, 2); assert.notEqual(copies[0], copies[1]);
    assert.equal(fs.readFileSync(path.join(f.root, 'main.tex'), 'utf8'), original);
    releases.forEach(release => release());
    const replies = await Promise.all(jobs); assert.ok(replies.every(reply => reply.status === 'applied'));
    assert.equal(fs.readFileSync(path.join(f.root, 'main.tex'), 'utf8'), 'Updated first paragraph. Updated second paragraph. Existing uncommitted text.\n');
    assert.ok(copies.every(copy => !fs.existsSync(copy)));
    await assert.rejects(delegateWorkflow(f.root, notes, { executor: 'deepseek', annotationIds: ['unknown'] }, generate, signal()), /Unknown/);
    await assert.rejects(delegateWorkflow(f.root, notes, { executor: 'deepseek', annotationIds: [notes[0].id], instruction: 'Edit', sources: [{ file: 'main.tex', quote: 'stale source' }] }, generate, signal()), /no longer matches/);
  } finally { f.close(); }
});
const delegateArgs = { executor: 'gemini', annotationIds: [notes[0].id], instruction: 'Edit first.', sources: [{ file: 'main.tex', quote: 'First' }] };
test('Codex edits use the same isolated merge route and inherit only the task Codex model', async () => {
  assert.deepEqual((WORKFLOW_TOOLS[0].inputSchema.properties as { executor: { enum: string[] } }).executor.enum, ['deepseek', 'gemini', 'codex']);
  for (const executor of ['codex', 'gemini', 'deepseek']) {
    const f = paper(); let copy = '';
    try {
      const result = await delegateWorkflow(f.root, notes, { ...delegateArgs, executor }, async (worker, _prompt, _signal, model, edit) => {
        assert.equal(worker, executor); assert.equal(model, executor === 'codex' ? 'task-codex-model' : undefined);
        assert.ok(edit); copy = edit.cwd; assert.notEqual(copy, fs.realpathSync(f.root));
        assert.equal(copy, fs.realpathSync.native(copy), 'workers use the native path identity, including Windows short-name expansion');
        const file = path.join(copy, 'main.tex'); fs.writeFileSync(file, fs.readFileSync(file, 'utf8').replace('First', 'Checked'));
        assert.match(fs.readFileSync(path.join(f.root, 'main.tex'), 'utf8'), /^First/); return 'Checked the annotation.';
      }, signal(), () => true, 'task-codex-model');
      assert.equal(result.executor, executor); assert.equal(result.status, 'applied'); assert.deepEqual(result.appliedFiles, ['main.tex']);
      assert.match(fs.readFileSync(path.join(f.root, 'main.tex'), 'utf8'), /^Checked/); assert.equal(fs.existsSync(copy), false);
    } finally { f.close(); }
  }
});
test('duplicate source excerpts share one snapshot file and case aliases cannot overwrite it', async () => {
  const f = paper();
  try {
    let called = false;
    const generate: WorkflowGenerate = async (_e, _p, _s, _m, edit) => { called = true; assert.deepEqual(edit!.files, ['main.tex']); return 'Unchanged'; };
    await delegateWorkflow(f.root, notes, { ...delegateArgs, sources: [{ file: 'main.tex', quote: 'First' }, { file: './main.tex', quote: 'Second' }] }, generate, signal());
    assert.equal(called, true); called = false;
    if (fs.existsSync(path.join(f.root, 'MAIN.TEX'))) {
      await assert.rejects(delegateWorkflow(f.root, notes, { ...delegateArgs, sources: [{ file: 'main.tex', quote: 'First' }, { file: 'MAIN.TEX', quote: 'First' }] }, generate, signal()), /selected source files/);
      assert.equal(called, false);
    }
  } finally { f.close(); }
});
test('overlapping edits return a conflict without overwriting the first integrated edit', async () => {
  const f = paper(), releases: (() => void)[] = [];
  let calls = 0;
  const generate: WorkflowGenerate = async (_executor, _prompt, _signal, _model, edit) => {
    const file = path.join(edit!.cwd, 'main.tex');
    fs.writeFileSync(file, fs.readFileSync(file, 'utf8').replace('First', calls++ ? 'Overlapping' : 'Integrated'));
    await new Promise<void>(resolve => releases.push(resolve)); return 'Done';
  };
  try {
    const first = delegateWorkflow(f.root, notes, delegateArgs, generate, signal()), second = delegateWorkflow(f.root, notes, delegateArgs, generate, signal());
    releases[0](); assert.equal((await first).status, 'applied');
    releases[1](); const result = await second;
    assert.equal(result.status, 'conflict'); assert.deepEqual(result.appliedFiles, []);
    assert.match(result.conflicts[0].incoming, /Overlapping/); assert.match(result.conflicts[0].current!, /Integrated/);
    assert.match(fs.readFileSync(path.join(f.root, 'main.tex'), 'utf8'), /^Integrated/);
    assert.doesNotMatch(fs.readFileSync(path.join(f.root, 'main.tex'), 'utf8'), /<<<<<<|Overlapping/);
  } finally { f.close(); }
});
test('coordinator edits made while a worker runs are retained by three-way merge', async () => {
  const f = paper();
  try {
    const result = await delegateWorkflow(f.root, notes, delegateArgs, async (_e, _p, _s, _m, edit) => {
      const file = path.join(edit!.cwd, 'main.tex'); fs.writeFileSync(file, fs.readFileSync(file, 'utf8').replace('First', 'Improved'));
      fs.appendFileSync(path.join(f.root, 'main.tex'), 'New coordinator text.\n'); return 'Edited';
    }, signal());
    assert.equal(result.status, 'applied'); assert.match(fs.readFileSync(path.join(f.root, 'main.tex'), 'utf8'), /^Improved[\s\S]*New coordinator text/);
  } finally { f.close(); }
});
test('source changes and cancellation during asynchronous merging prevent stale writes', async () => {
  for (const operation of ['edit', 'cancel']) {
    const f = paper(), controller = new AbortController(), mkdtemp = fs.promises.mkdtemp;
    const current = 'First paragraph.\n\nUpdated coordinator paragraph.\n', latest = current + 'Newer edit.\n';
    try {
      fs.promises.mkdtemp = (async (...args: Parameters<typeof mkdtemp>) => {
        if (String(args[0]).includes('papilot-merge-')) {
          if (operation === 'edit') fs.writeFileSync(path.join(f.root, 'main.tex'), latest); else controller.abort();
        }
        return mkdtemp(...args);
      }) as typeof mkdtemp;
      await assert.rejects(delegateWorkflow(f.root, notes, delegateArgs, async (_e, _p, _s, _m, edit) => {
        const file = path.join(edit!.cwd, 'main.tex'); fs.writeFileSync(file, fs.readFileSync(file, 'utf8').replace('First', 'Improved'));
        fs.writeFileSync(path.join(f.root, 'main.tex'), current); return 'Edited';
      }, controller.signal));
      assert.equal(fs.readFileSync(path.join(f.root, 'main.tex'), 'utf8'), operation === 'edit' ? latest : current);
    } finally { fs.promises.mkdtemp = mkdtemp; f.close(); }
  }
});
test('clean files are applied while conflicted files and deleted targets are retained', async () => {
  const f = paper(); fs.writeFileSync(path.join(f.root, 'other.tex'), 'Other text.');
  try {
    const result = await delegateWorkflow(f.root, notes, { ...delegateArgs, sources: [...delegateArgs.sources, { file: 'other.tex', quote: 'Other' }] }, async (_e, _p, _s, _m, edit) => {
      fs.writeFileSync(path.join(edit!.cwd, 'main.tex'), 'Worker version.'); fs.writeFileSync(path.join(edit!.cwd, 'other.tex'), 'Improved other text.');
      fs.unlinkSync(path.join(f.root, 'main.tex')); return 'Edited both.';
    }, signal());
    assert.equal(result.status, 'conflict'); assert.deepEqual(result.appliedFiles, ['other.tex']); assert.equal(result.conflicts[0].current, null);
    assert.equal(fs.existsSync(path.join(f.root, 'main.tex')), false); assert.equal(fs.readFileSync(path.join(f.root, 'other.tex'), 'utf8'), 'Improved other text.');
  } finally { f.close(); }
});
test('a failed atomic replacement rolls back files already integrated by the same delegate', async () => {
  const f = paper(); fs.writeFileSync(path.join(f.root, 'other.tex'), 'Other text.');
  const before = fs.readFileSync(path.join(f.root, 'main.tex'), 'utf8'), rename = fs.renameSync;
  try {
    fs.renameSync = (from, to) => { if (String(to) === path.join(fs.realpathSync(f.root), 'other.tex')) throw new Error('Simulated write failure'); return rename(from, to); };
    await assert.rejects(delegateWorkflow(f.root, notes, { ...delegateArgs, sources: [...delegateArgs.sources, { file: 'other.tex', quote: 'Other' }] }, async (_e, _p, _s, _m, edit) => {
      fs.writeFileSync(path.join(edit!.cwd, 'main.tex'), 'Improved.'); fs.writeFileSync(path.join(edit!.cwd, 'other.tex'), 'Improved other.'); return 'Edited both.';
    }, signal()), /Simulated write failure/);
    assert.equal(fs.readFileSync(path.join(f.root, 'main.tex'), 'utf8'), before); assert.equal(fs.readFileSync(path.join(f.root, 'other.tex'), 'utf8'), 'Other text.');
  } finally { fs.renameSync = rename; f.close(); }
});
test('OpenCode editing rules allow only selected files and keep unrelated native actions denied', () => {
  const config = JSON.parse(workflowOpenCodeConfig({ cwd: '/isolated', files: ['main.tex'] }));
  const rules = config.agents['papilot-default'].permissions;
  const effect = (action: string, resource: string) => rules.filter((rule: any) => (rule.action === '*' || rule.action === action) && (rule.resource === '*' || rule.resource === resource)).at(-1)?.effect;
  for (const file of ['main.tex', '/isolated/main.tex']) for (const action of ['read', 'edit']) assert.equal(effect(action, file), 'allow');
  for (const [action, resource] of [['edit', '../other.tex'], ['edit', 'new.tex'], ['shell', 'git status'], ['subagent', 'helper'], ['webfetch', 'https://example.com']]) assert.equal(effect(action, resource), 'deny');
  assert.equal(config.agent['papilot-default'].permission.edit['*'], 'deny');
  assert.equal(config.agent['papilot-default'].permission.edit['main.tex'], 'allow');
});
test('cancelled and stale runs never integrate late edits', async () => {
  for (const mode of ['cancel', 'stale']) {
    const f = paper(), controller = new AbortController(); let current = true, copy = '';
    const before = fs.readFileSync(path.join(f.root, 'main.tex'), 'utf8');
    try {
      await assert.rejects(delegateWorkflow(f.root, notes, delegateArgs, async (_e, _p, _s, _m, edit) => {
        copy = edit!.cwd; fs.writeFileSync(path.join(copy, 'main.tex'), 'Late edit.');
        if (mode === 'cancel') controller.abort(); else current = false;
        return 'Edited';
      }, controller.signal, () => current));
      assert.equal(fs.readFileSync(path.join(f.root, 'main.tex'), 'utf8'), before); assert.equal(fs.existsSync(copy), false);
    } finally { f.close(); }
  }
});
test('workers cannot integrate extra files, deleted files or symlink outputs', async () => {
  for (const mode of ['extra', 'deleted', 'symlink']) {
    const f = paper(), before = fs.readFileSync(path.join(f.root, 'main.tex'), 'utf8');
    try {
      await assert.rejects(delegateWorkflow(f.root, notes, delegateArgs, async (_e, _p, _s, _m, edit) => {
        const file = path.join(edit!.cwd, 'main.tex');
        if (mode === 'extra') fs.writeFileSync(path.join(edit!.cwd, 'other.tex'), 'Out of scope');
        else { fs.unlinkSync(file); if (mode === 'symlink') fs.symlinkSync(path.join(f.root, 'main.tex'), file); }
        return 'Edited';
      }, signal()));
      assert.equal(fs.readFileSync(path.join(f.root, 'main.tex'), 'utf8'), before); assert.equal(fs.existsSync(path.join(f.root, 'other.tex')), false);
    } finally { f.close(); }
  }
});
test('a task source replaced by a symlink during delegation cannot be overwritten', async () => {
  const f = paper(), outside = fs.mkdtempSync(path.join(os.tmpdir(), 'papilot-worker-outside-'));
  fs.writeFileSync(path.join(outside, 'other.tex'), 'Protected');
  try {
    await assert.rejects(delegateWorkflow(f.root, notes, delegateArgs, async (_e, _p, _s, _m, edit) => {
      fs.writeFileSync(path.join(edit!.cwd, 'main.tex'), 'Worker edit');
      fs.unlinkSync(path.join(f.root, 'main.tex')); fs.symlinkSync(path.join(outside, 'other.tex'), path.join(f.root, 'main.tex')); return 'Edited';
    }, signal()), /selected source files/);
    assert.equal(fs.readFileSync(path.join(outside, 'other.tex'), 'utf8'), 'Protected');
  } finally { f.close(); fs.rmSync(outside, { recursive: true, force: true }); }
});
test('evidence rejects path escapes, symlinks and stale text', () => {
  const f = paper(), outside = fs.mkdtempSync(path.join(os.tmpdir(), 'papilot-outside-'));
  try {
    fs.writeFileSync(path.join(outside, 'secret'), 'Secret'); fs.symlinkSync(outside, path.join(f.root, 'link'));
    for (const file of ['../secret', path.join(outside, 'secret'), 'link/secret', '.git/config']) assert.throws(() => sourceEvidence(f.root, [{ file, quote: 'Secret' }]), /inside this task/);
  } finally { f.close(); fs.rmSync(outside, { recursive: true, force: true }); }
});
test('audit enforces exact coverage and independent verification, including unresolved notes', async () => {
  const f = paper();
  try {
    await assert.rejects(auditWorkflow(f.root, notes, { outcomes: outcomes().slice(0, 1) }, verified, signal()), /every annotation/);
    await assert.rejects(auditWorkflow(f.root, notes, { outcomes: [outcomes()[0], outcomes()[0]] }, verified, signal()), /exactly once/);
    await assert.rejects(auditWorkflow(f.root, notes, { outcomes: outcomes().map(entry => ({ ...entry, evidence: [] })) }, verified, signal()), /source evidence/);
    const result = await auditWorkflow(f.root, notes, { outcomes: outcomes() }, verified, signal()); assert.equal(result.verified, true);
    fs.appendFileSync(path.join(f.root, 'main.tex'), 'Later edit.'); assert.notEqual((await workflowSnapshot(f.root)).fingerprint, result.fingerprint);
    const blocked = outcomes(); blocked[1] = { ...blocked[1], status: 'blocked', evidence: [], explanation: 'Need a missing reference.' };
    assert.equal((await auditWorkflow(f.root, notes, { outcomes: blocked }, verified, signal())).verified, true);
    const rejected: WorkflowGenerate = async (_executor, prompt) => JSON.stringify({ ...JSON.parse(await verified('codex', prompt, signal())), verified: false, issues: ['First annotation is missed.'] });
    assert.equal((await auditWorkflow(f.root, notes, { outcomes: outcomes() }, rejected, signal())).verified, false);
    const mutate: WorkflowGenerate = async (executor, prompt, signal) => { const result = await verified(executor, prompt, signal); fs.writeFileSync(path.join(f.root, 'new.tex'), 'Untracked change'); return result; };
    await assert.rejects(auditWorkflow(f.root, notes, { outcomes: outcomes() }, mutate, signal()), /changed during/);
  } finally { f.close(); }
});
class Helper extends EventEmitter {
  ready = false; cwd = ''; closed = false; calls: any[] = [];
  models = ['opencode-go/deepseek-v4.1-flash', 'gemini-3.8-flash', 'gemini-4-argon', 'claude-sonnet-4-6'];
  async start() { this.ready = true; }
  async request(method: string, params: any): Promise<any> {
    this.calls.push({ method, params });
    if (method === 'model/list') return { data: this.models.map(model => ({ model })) };
    if (method === 'thread/start') { this.cwd = params.cwd; return { thread: { id: 'helper' } }; }
    if (method === 'turn/start') setImmediate(() => { this.emit('notification', { method: 'item/completed', params: { threadId: 'helper', item: { type: 'agentMessage', text: 'Proposal' } } }); this.emit('notification', { method: 'turn/completed', params: { threadId: 'helper', turn: { status: 'completed' } } }); });
    return { turn: { id: 'turn' } };
  }
  respond() {} reject() {} close() { this.closed = true; this.ready = false; }
}
test('native helper pins Go, uses disposable read-only cwd, closes it, and rejects other providers', async () => {
  const helper = new Helper();
  assert.equal(await runWorkflowHelper('deepseek', 'Fix text', signal(), undefined, undefined, () => helper), 'Proposal');
  const start = helper.calls.find(call => call.method === 'thread/start').params;
  assert.equal(start.model, 'opencode-go/deepseek-v4.1-flash'); assert.equal(start.sandbox, 'read-only'); assert.equal(helper.closed, true); assert.equal(fs.existsSync(helper.cwd), false);
  const previous = process.env.PAPILOT_COLLABORATION_DEEPSEEK_MODEL;
  try { process.env.PAPILOT_COLLABORATION_DEEPSEEK_MODEL = 'deepseek/deepseek-v4'; await assert.rejects(runWorkflowHelper('deepseek', 'Fix', signal(), undefined, undefined, () => new Helper()), /must use an opencode-go/); }
  finally { if (previous === undefined) delete process.env.PAPILOT_COLLABORATION_DEEPSEEK_MODEL; else process.env.PAPILOT_COLLABORATION_DEEPSEEK_MODEL = previous; }
});
test('Gemini helpers default to Flash and allow an explicit available Gemini model', async () => {
  const previous = process.env.PAPILOT_COLLABORATION_GEMINI_MODEL;
  try {
    delete process.env.PAPILOT_COLLABORATION_GEMINI_MODEL;
    for (const model of ['gemini-3.8-flash', 'gemini-4-argon']) {
      if (model !== 'gemini-3.8-flash') process.env.PAPILOT_COLLABORATION_GEMINI_MODEL = model;
      const helper = new Helper();
      assert.equal(await runWorkflowHelper('gemini', 'Polish', signal(), undefined, undefined, () => helper), 'Proposal');
      const start = helper.calls.find(call => call.method === 'thread/start').params;
      assert.equal(start.model, model); assert.equal(start.sandbox, 'read-only');
      assert.equal(helper.closed, true); assert.equal(fs.existsSync(helper.cwd), false);
    }
  } finally { if (previous === undefined) delete process.env.PAPILOT_COLLABORATION_GEMINI_MODEL; else process.env.PAPILOT_COLLABORATION_GEMINI_MODEL = previous; }
});
test('missing or non-Gemini polishing models fail without a fallback or model turn', async () => {
  const previous = process.env.PAPILOT_COLLABORATION_GEMINI_MODEL;
  try {
    for (const model of [undefined, 'gemini-missing', 'claude-sonnet-4-6']) {
      if (model) process.env.PAPILOT_COLLABORATION_GEMINI_MODEL = model; else delete process.env.PAPILOT_COLLABORATION_GEMINI_MODEL;
      const helper = new Helper(); helper.models = ['gemini-4-argon', 'claude-sonnet-4-6'];
      await assert.rejects(runWorkflowHelper('gemini', 'Polish', signal(), undefined, undefined, () => helper), /model is unavailable/);
      assert.equal(helper.calls.some(call => call.method === 'thread/start'), false); assert.equal(helper.closed, true);
    }
  } finally { if (previous === undefined) delete process.env.PAPILOT_COLLABORATION_GEMINI_MODEL; else process.env.PAPILOT_COLLABORATION_GEMINI_MODEL = previous; }
});
test('stopping a native helper closes its process and ignores late results', async () => {
  const helper = new Helper(), controller = new AbortController();
  helper.request = async (method, params) => { if (method === 'model/list') return { data: [] }; if (method === 'thread/start') { helper.cwd = params.cwd; return { thread: { id: 'helper' } }; } if (method === 'turn/start') controller.abort(); return {}; };
  await assert.rejects(runWorkflowHelper('codex', 'Audit', controller.signal, undefined, undefined, () => helper), /stopped/);
  assert.equal(helper.closed, true); assert.equal(fs.existsSync(helper.cwd), false);
});
test('a Codex editor rejects a runtime that keeps host writable roots before starting a turn', async () => {
  const f = paper(), helper = new Helper(), request = helper.request.bind(helper);
  helper.request = async (method, params) => {
    const result = await request(method, params);
    if (method === 'thread/start') return { ...result, approvalPolicy: 'never', sandbox: { type: 'workspaceWrite', writableRoots: ['/host'], networkAccess: false, excludeTmpdirEnvVar: true, excludeSlashTmp: true } };
    return result;
  };
  try {
    await assert.rejects(runWorkflowHelper('codex', 'Edit', signal(), 'task-codex-model', { cwd: f.root, files: ['main.tex'] }, () => helper), /isolated workflow permissions/);
    assert.equal(helper.calls.some(call => call.method === 'turn/start'), false); assert.equal(helper.closed, true);
    assert.equal(fs.existsSync(f.root), true, 'the delegation owns snapshot cleanup');
  } finally { f.close(); }
});
test('Codex helpers reject enabled MCP names that native overrides cannot address and skip disabled ones', async () => {
  for (const enabled of [true, false]) {
    const helper = new Helper(), request = helper.request.bind(helper);
    helper.request = async (method, params) => method === 'config/read' ? { config: { mcp_servers: { 'dot.name': { enabled } } } } : request(method, params);
    const work = runWorkflowHelper('codex', 'Audit', signal(), undefined, undefined, () => helper);
    if (enabled) { await assert.rejects(work, /isolated workflow permissions/); assert.equal(helper.calls.some(call => call.method === 'thread/start'), false); }
    else { assert.equal(await work, 'Proposal'); assert.equal(helper.calls.find(call => call.method === 'thread/start').params.sandbox, 'read-only'); }
    assert.equal(helper.closed, true);
  }
});
test('a delayed installation probe cannot start a helper after cancellation', async () => {
  const helper = new Helper(), controller = new AbortController(); let resolve!: (value: boolean) => void, starts = 0;
  const runtime = Object.assign(helper, { detect: () => new Promise<boolean>(done => { resolve = done; }) });
  runtime.start = async () => { starts++; helper.ready = true; };
  const work = runWorkflowHelper('codex', 'Audit', controller.signal, undefined, undefined, () => runtime);
  controller.abort(); await assert.rejects(work, /stopped/); resolve(true); await new Promise(done => setImmediate(done));
  assert.equal(starts, 0); assert.equal(helper.ready, false);
});
test('an ignored evidence file is included in the audit fingerprint and sources are deduplicated', async () => {
  const f = paper();
  try {
    fs.writeFileSync(path.join(f.root, '.gitignore'), 'generated.tex\n'); fs.writeFileSync(path.join(f.root, 'generated.tex'), 'Generated text.');
    const entries = outcomes().map(entry => ({ ...entry, evidence: [{ file: 'generated.tex', quote: 'Generated' }] }));
    const check: WorkflowGenerate = async (executor, prompt, signal) => { const data = JSON.parse(prompt.slice(prompt.indexOf('\n') + 1)); assert.deepEqual(Object.keys(data.sources), ['generated.tex']); assert.equal(data.outcomes[0].evidence[0].source, undefined); return verified(executor, prompt, signal); };
    const result = await auditWorkflow(f.root, notes, { outcomes: entries }, check, signal());
    fs.writeFileSync(path.join(f.root, 'generated.tex'), 'Changed text.');
    assert.notEqual((await workflowSnapshot(f.root, result.files)).fingerprint, result.fingerprint);
  } finally { f.close(); }
});
test('audit binds the quoted source bytes to the fingerprint before asking the verifier', async () => {
  const f = paper();
  try {
    let called = false;
    const generate: WorkflowGenerate = async (executor, prompt, signal) => { called = true; return verified(executor, prompt, signal); };
    const work = auditWorkflow(f.root, notes, { outcomes: outcomes() }, generate, signal());
    fs.writeFileSync(path.join(f.root, 'main.tex'), 'Different text without the requested quotations.');
    await assert.rejects(work, /no longer matches/); assert.equal(called, false);
  } finally { f.close(); }
});
