import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execFileSync } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { auditWorkflow, delegateWorkflow, sourceEvidence, workflowNotes, workflowSnapshot, runWorkflowHelper, type WorkflowGenerate } from '../src/server/collaboration.ts';
import { offeredAgents, noAgent, chosenAgent } from '../src/web/agent-choice.ts';
import { AGENT_IDS, type RuntimeStatus } from '../src/shared.ts';

function paper() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'papilot-workflow-test-'));
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
test('parallel proposals for two spans in one file never change the source', async () => {
  const f = paper(); const releases: (() => void)[] = [];
  const generate: WorkflowGenerate = async (executor, prompt) => { assert.match(prompt, /Do not use tools/); await new Promise<void>(resolve => releases.push(resolve)); return executor + ' proposal'; };
  try {
    const before = await workflowSnapshot(f.root);
    const jobs = notes.map((note, i) => delegateWorkflow(f.root, notes, { executor: i ? 'argon' : 'deepseek', annotationIds: [note.id], instruction: note.comment, sources: [{ file: 'main.tex', quote: note.quote }] }, generate, signal()));
    assert.equal(releases.length, 2); releases.forEach(release => release());
    const replies = await Promise.all(jobs); assert.equal(replies.length, 2);
    assert.deepEqual(await workflowSnapshot(f.root), before);
    await assert.rejects(delegateWorkflow(f.root, notes, { executor: 'deepseek', annotationIds: ['unknown'] }, generate, signal()), /Unknown/);
    await assert.rejects(delegateWorkflow(f.root, notes, { executor: 'deepseek', annotationIds: [notes[0].id], instruction: 'Edit', sources: [{ file: 'main.tex', quote: 'stale source' }] }, generate, signal()), /no longer matches/);
  } finally { f.close(); }
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
  async start() { this.ready = true; }
  async request(method: string, params: any): Promise<any> {
    this.calls.push({ method, params });
    if (method === 'model/list') return { data: [{ model: 'opencode-go/deepseek-v4.1-flash' }, { model: 'gemini-4-argon' }] };
    if (method === 'thread/start') { this.cwd = params.cwd; return { thread: { id: 'helper' } }; }
    if (method === 'turn/start') setImmediate(() => { this.emit('notification', { method: 'item/completed', params: { threadId: 'helper', item: { type: 'agentMessage', text: 'Proposal' } } }); this.emit('notification', { method: 'turn/completed', params: { threadId: 'helper', turn: { status: 'completed' } } }); });
    return { turn: { id: 'turn' } };
  }
  respond() {} reject() {} close() { this.closed = true; this.ready = false; }
}
test('native helper pins Go, uses disposable read-only cwd, closes it, and rejects other providers', async () => {
  const helper = new Helper();
  assert.equal(await runWorkflowHelper('deepseek', 'Fix text', signal(), undefined, () => helper), 'Proposal');
  const start = helper.calls.find(call => call.method === 'thread/start').params;
  assert.equal(start.model, 'opencode-go/deepseek-v4.1-flash'); assert.equal(start.sandbox, 'read-only'); assert.equal(helper.closed, true); assert.equal(fs.existsSync(helper.cwd), false);
  const previous = process.env.PAPILOT_COLLABORATION_DEEPSEEK_MODEL;
  try { process.env.PAPILOT_COLLABORATION_DEEPSEEK_MODEL = 'deepseek/deepseek-v4'; await assert.rejects(runWorkflowHelper('deepseek', 'Fix', signal(), undefined, () => new Helper()), /must use an opencode-go/); }
  finally { if (previous === undefined) delete process.env.PAPILOT_COLLABORATION_DEEPSEEK_MODEL; else process.env.PAPILOT_COLLABORATION_DEEPSEEK_MODEL = previous; }
});
test('stopping a native helper closes its process and ignores late results', async () => {
  const helper = new Helper(), controller = new AbortController();
  helper.request = async (method, params) => { if (method === 'model/list') return { data: [] }; if (method === 'thread/start') { helper.cwd = params.cwd; return { thread: { id: 'helper' } }; } if (method === 'turn/start') controller.abort(); return {}; };
  await assert.rejects(runWorkflowHelper('codex', 'Audit', controller.signal, undefined, () => helper), /stopped/);
  assert.equal(helper.closed, true); assert.equal(fs.existsSync(helper.cwd), false);
});
test('a delayed installation probe cannot start a helper after cancellation', async () => {
  const helper = new Helper(), controller = new AbortController(); let resolve!: (value: boolean) => void, starts = 0;
  const runtime = Object.assign(helper, { detect: () => new Promise<boolean>(done => { resolve = done; }) });
  runtime.start = async () => { starts++; helper.ready = true; };
  const work = runWorkflowHelper('codex', 'Audit', controller.signal, undefined, () => runtime);
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
