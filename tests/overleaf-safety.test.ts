import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { insert, setup, until } from './fixtures/overleaf-sync-setup.ts';

const pause = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

test('a folder left with only build output deletes nothing on Overleaf when Papilot starts', async () => {
  const t = await setup(server => { server.addDoc('main.tex', 'Main\n'); server.addDoc('sections/intro.tex', 'Intro\n'); server.addFile('fig.png', Buffer.from([1, 2, 3])); });
  let sync = t.sync().start();
  await until(() => sync.state === 'synced', 'the first sync');
  await sync.stop();
  // A branch without the sources, with the last build's output left over.
  for (const file of ['main.tex', 'sections/intro.tex', 'fig.png']) fs.rmSync(path.join(t.root, file));
  t.write('main.pdf', '%PDF'); t.write('main.log', 'log'); t.write('main.aux', 'aux');
  sync = t.sync().start();
  await until(() => sync.state === 'paused', 'the pause');
  await pause(2000);
  assert.deepEqual(t.server.paths(), ['fig.png', 'main.tex', 'sections/intro.tex']);
  assert.ok(!t.server.requests.some(request => request.startsWith('DELETE')));
  await t.close(sync);
});

test('renaming the folder that holds the paper moves the files on Overleaf, keeping their history', async () => {
  const t = await setup(server => { server.addDoc('paper/main.tex', 'Main\n'); server.addDoc('paper/intro.tex', 'Intro\n'); server.addFile('paper/fig.png', Buffer.from([1, 2, 3])); });
  const sync = t.sync().start();
  await until(() => sync.state === 'synced', 'the first sync');
  const ids = ['paper/main.tex', 'paper/intro.tex', 'paper/fig.png'].map(file => t.server.byPath(file)!.entity.id);
  fs.renameSync(path.join(t.root, 'paper'), path.join(t.root, 'manuscript'));
  await until(() => t.server.paths().join() === 'manuscript/fig.png,manuscript/intro.tex,manuscript/main.tex', 'the moves');
  assert.deepEqual(['manuscript/main.tex', 'manuscript/intro.tex', 'manuscript/fig.png'].map(file => t.server.byPath(file)!.entity.id), ids);
  assert.ok(!t.server.requests.some(request => request.startsWith('DELETE') || request.includes('/upload')));
  await t.close(sync);
});

test('a coauthor renaming a file onto a local file Papilot does not sync never uploads that file', async () => {
  const t = await setup(server => { server.addDoc('main.tex', 'Main\n'); server.addDoc('draft.tex', 'Coauthor draft\n'); }, { ignored: ['notes.tex'] });
  const sync = t.sync().start();
  await until(() => sync.state === 'synced', 'the first sync');
  t.write('notes.tex', 'PRIVATE: my reviewer notes\n');
  await pause(1500);
  t.server.rename('draft.tex', 'notes.tex');
  await until(() => t.read('notes.tex') === 'Coauthor draft\n', 'the coauthor’s file under its new name');
  await pause(2500);
  assert.equal(t.server.text('notes.tex'), 'Coauthor draft\n');
  assert.deepEqual(t.server.paths(), ['main.tex', 'notes.tex']);
  assert.ok(sync.status('paper').conflicts.some(conflict => conflict.path === 'notes.tex'), 'the private file is kept to put back');
  await t.close(sync);
});

test('a file whose merge cannot be written is set aside without undoing the coauthor’s edit', { skip: process.platform === 'win32' || process.getuid?.() === 0 }, async () => {
  const t = await setup(server => { server.addDoc('main.tex', 'one\ntwo\nthree\n'); });
  let sync = t.sync().start();
  await until(() => sync.state === 'synced', 'the first sync');
  await sync.stop();
  t.server.forgetUpdates();
  t.server.edit('main.tex', doc => [{ p: doc.length, i: 'coauthor four\n' }]);
  t.write('main.tex', 'ONE\ntwo\nthree\n');
  fs.chmodSync(t.root, 0o555);
  try {
    sync = t.sync().start();
    await until(() => sync.state === 'synced' && sync.status('paper').skipped.includes('main.tex'), 'the file set aside');
    await pause(2500);
    assert.equal(t.server.text('main.tex'), 'one\ntwo\nthree\ncoauthor four\n');
  } finally { fs.chmodSync(t.root, 0o755); }
  await t.close(sync);
});

test('a burst of coauthor edits reaches the file at once', async () => {
  const t = await setup(server => { server.addDoc('main.tex', 'start\n'); });
  const sync = t.sync().start();
  await until(() => sync.state === 'synced', 'the first sync');
  for (let i = 0; i < 60; i++) t.server.edit('main.tex', insert('start', ` ${i}`));
  const sent = Date.now();
  await until(() => t.read('main.tex') === t.server.text('main.tex'), 'the burst in the file', 8000);
  assert.ok(Date.now() - sent < 3000, `the burst took ${Date.now() - sent} ms`);
  await t.close(sync);
});
