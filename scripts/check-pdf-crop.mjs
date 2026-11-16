import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import Fastify from 'fastify';
import staticFiles from '@fastify/static';
import { chromium, webkit, expect } from './playwright.mjs';
import { readyRequirements } from './required-tools-fixture.mjs';
import { dragPdfText } from './pdf-selection-fixture.mjs';

const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'papilot-pdf-crop-'));
const server = Fastify();
let browser;
try {
  fs.writeFileSync(path.join(directory, 'main.tex'), String.raw`\documentclass{article}
\usepackage[letterpaper,margin=1.3in]{geometry}
\usepackage[hidelinks]{hyperref}
\begin{document}
\section{Introduction}
Crop fixture sentence for selection and notes. Reading on a phone should keep every mark aligned.

\hyperref[method]{Go to Method}
\vspace{2in}

Lower passage for scrolling and saved reading position.
\clearpage
\section{Method}\label{method}
Second page fixture with a different passage for search and links.
\end{document}
`);
  for (let pass = 0; pass < 2; pass++) execFileSync('pdflatex', ['-interaction=batchmode', '-halt-on-error', 'main.tex'], { cwd: directory });
  const pdf = fs.readFileSync(path.join(directory, 'main.pdf'));
  fs.mkdirSync('test-results', { recursive: true });
  await server.register(staticFiles, { root: path.resolve('dist') });
  const origin = await server.listen({ host: '127.0.0.1', port: 0 });
  const useWebkit = process.env.PAPILOT_CROP_WEBKIT === '1';
  browser = await (useWebkit ? webkit : chromium).launch({ ...(useWebkit ? {} : { channel: process.env.PAPILOT_BROWSER_CHANNEL || 'chrome' }), headless: true });
  const errors = [];
  async function open({ width = 390, height = 844, mobile = true, theme = 'light', locale = 'en' } = {}) {
    const context = await browser.newContext({ viewport: { width, height }, hasTouch: mobile, isMobile: mobile, colorScheme: theme, locale: 'en-US' });
    const page = await context.newPage();
    page.on('pageerror', error => errors.push(error.message));
    await page.addInitScript(({ theme, locale }) => {
      localStorage.setItem('papilot:language', locale);
      localStorage.setItem('papilot:theme', theme);
    }, { theme, locale });
    const state = { version: 'test', csrf: 'fixture', projects: [{ id: 'paper', name: 'Crop paper', path: directory }], tasks: [], requests: [], runtime: { connected: true, authenticated: true, models: [] } };
    const manuscript = { git: { branch: 'main', files: [] }, build: { status: 'ready', key: 'pdf', document: 'main.tex', pages: [[612, 792], [612, 792]] }, annotations: [] };
    const sourceRequests = [], mutations = [];
    await page.route('**/api/**', route => {
      const url = new URL(route.request().url()), json = value => route.fulfill({ json: value });
      if (route.request().method() !== 'GET') mutations.push(url.pathname);
      if (url.pathname === '/api/state') return json(state);
      if (url.pathname.endsWith('/events')) return route.fulfill({ contentType: 'text/event-stream', body: ': fixture\n\n' });
      if (url.pathname === '/api/runtime/requirements') return json(readyRequirements);
      if (url.pathname === '/api/updates') return json({ currentVersion: 'test', latestVersion: null, phase: 'idle', canUpdate: false });
      if (url.pathname.endsWith('/files')) return json({ document: 'main.tex', files: [] });
      if (url.pathname.endsWith('/skills')) return json({ skills: [] });
      if (url.pathname.endsWith('/git')) return json(manuscript.git);
      if (url.pathname.endsWith('/manuscript')) return json(manuscript);
      if (url.pathname.endsWith('/manuscript.pdf')) return route.fulfill({ contentType: 'application/pdf', body: pdf });
      if (url.pathname.endsWith('/manuscript/words')) return route.fulfill({ status: 404, json: { error: 'Use PDF text' } });
      if (url.pathname.endsWith('/manuscript/source/locate')) { sourceRequests.push(route.request().postDataJSON()); return json({ source: null }); }
      if (url.pathname === '/api/quick-notes') return json({ quickNotes: null });
      if (url.pathname === '/api/note-alternatives') return json({ noteAlternatives: true, noteAlternativeRange: 'few' });
      if (url.pathname === '/api/indirect-changes') return json({ indirectChanges: false });
      if (url.pathname.endsWith('/annotations')) {
        const note = { ...route.request().postDataJSON(), id: `note-${manuscript.annotations.length + 1}`, projectId: 'paper', source: null, createdAt: 1 };
        manuscript.annotations.push(note); return json(note);
      }
      throw Error(`Unexpected request ${url.pathname}`);
    });
    await page.goto(origin);
    const text = page.locator('.page[data-page-number="1"] .textLayer span').filter({ hasText: 'Crop fixture' }).first();
    await expect(text).toBeVisible();
    const cropButton = page.locator('.pdf-crop-toggle');
    const dialog = page.locator('.pdf-crop-dialog');
    const openCrop = async () => { await cropButton.click(); await expect(dialog.locator('.pdf-crop-preview')).toBeVisible(); await expect(dialog.locator('input')).toHaveCount(0); };
    const dragMargin = async (edge, margin) => {
      const preview = await dialog.locator('.pdf-crop-preview').boundingBox();
      const handle = await dialog.locator('.pdf-crop-handle').nth(edge).boundingBox();
      const start = { x: handle.x + handle.width / 2, y: handle.y + handle.height / 2 };
      const axis = edge % 2 ? 'y' : 'x', size = edge % 2 ? 'height' : 'width';
      const end = { ...start, [axis]: preview[axis] + preview[size] * (edge < 2 ? margin : 1 - margin) };
      // Chromium drives actual touch events on phones; WebKit exercises
      // pointer capture with a mouse in the same mobile context.
      if (mobile && !useWebkit) {
        const session = await page.context().newCDPSession(page);
        await session.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [start] });
        await session.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [end] });
        await session.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
        await session.detach();
      } else {
        await page.mouse.move(start.x, start.y); await page.mouse.down();
        await page.mouse.move(end.x, end.y, { steps: 8 }); await page.mouse.up();
      }
      await expect.poll(async () => {
        const box = await dialog.locator('.pdf-crop-handle').nth(edge).boundingBox();
        return Math.abs(box[axis] + box[size] / 2 - end[axis]);
      }).toBeLessThan(1);
    };
    const apply = async () => { await dialog.getByRole('button', { name: 'Apply', exact: true }).click(); await expect(dialog).toHaveCount(0); await expect(page.locator('.pdf-cropped')).toBeVisible(); await expect(text).toBeVisible(); };
    const saved = () => page.evaluate(() => localStorage.getItem('papilot:pdf-crop:pdf:paper:main.tex'));
    const sync = () => page.evaluate(() => window.dispatchEvent(new Event('focus')));
    return { context, page, manuscript, text, cropButton, dialog, openCrop, dragMargin, apply, saved, sync, mutations, sourceRequests };
  }
  const f = await open();
  try {
    const { page, dialog, text } = f;
    const before = await text.boundingBox();
    const originalText = await text.evaluate(el => {
      const word = el.getBoundingClientRect(), page = el.closest('.page').getBoundingClientRect();
      return [(word.left - page.left) / page.width, (word.top - page.top) / page.height];
    });
    await page.screenshot({ path: 'test-results/pdf-crop-mobile-before.png' });
    await page.getByRole('button', { name: 'Find in PDF', exact: true }).click();
    await page.getByRole('textbox', { name: 'Search the PDF', exact: true }).fill('Crop fixture');
    await expect(page.locator('.pdf-container .highlight')).toHaveCount(1);
    await f.openCrop();
    await f.dragMargin(0, 0.1); await f.dragMargin(2, 0.1);
    await f.dragMargin(1, 0.08); await f.dragMargin(3, 0.08);
    for (const [edge, label] of ['Left margin (10%)', 'Top margin (8%)', 'Right margin (10%)', 'Bottom margin (8%)'].entries()) await expect(dialog.locator('.pdf-crop-handle').nth(edge)).toHaveAccessibleName(label);
    await page.screenshot({ path: 'test-results/pdf-crop-mobile-editor.png' });
    await f.apply();
    await expect(page.locator('.pdf-container .highlight')).toHaveCount(1);
    assert.equal(await page.locator('.page').first().evaluate(el => el.scrollTop + el.scrollLeft), 0, 'search never scrolls inside the cropped page');
    await page.getByRole('button', { name: 'Close search', exact: true }).click();
    await expect.poll(async () => (await text.boundingBox()).height / before.height).toBeGreaterThan(1.2);
    await expect.poll(() => page.locator('.pdf-container').evaluate(el => el.scrollWidth - el.clientWidth)).toBeLessThanOrEqual(2);
    const preference = JSON.parse(await f.saved());
    for (const [edge, expected] of [0.1, 0.08, 0.9, 0.92].entries()) assert.ok(Math.abs(preference[edge] - expected) < 0.005, 'all four dragged edges are saved');
    assert.deepEqual(f.mutations, [], 'cropping sends no server mutation');
    await page.screenshot({ path: 'test-results/pdf-crop-mobile-reading.png' });

    await f.openCrop();
    await f.dragMargin(0, 0.2);
    await dialog.getByRole('button', { name: 'Cancel', exact: true }).click();
    assert.deepEqual(JSON.parse(await f.saved()), preference, 'cancel does not save the draft');
    await expect(f.cropButton).toBeFocused();
    await page.reload(); await expect(page.locator('.pdf-cropped')).toBeVisible(); await expect(text).toBeVisible();
    assert.deepEqual(JSON.parse(await f.saved()), preference);
    const replacement = page.waitForResponse(response => response.url().includes('manuscript.pdf?key=recompiled'));
    f.manuscript.build.key = 'recompiled'; await f.sync(); await replacement;
    await expect(text).toBeVisible();
    await expect(page.locator('.pdf-cropped')).toBeVisible();
    await page.locator('.page[data-page-number="1"] .linkAnnotation a').first().click();
    await expect(page.getByRole('textbox', { name: 'Page number', exact: true })).toHaveValue('2');
    await page.getByRole('textbox', { name: 'Page number', exact: true }).fill('1');
    await page.getByRole('textbox', { name: 'Page number', exact: true }).press('Enter');
    await expect(text).toBeInViewport();
    if (!useWebkit) {
      const session = await page.context().newCDPSession(page), box = await text.boundingBox();
      await session.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: box.x + 20, y: box.y + box.height / 2 }] });
      await page.waitForTimeout(550); // The viewer's real long-press threshold is 450 ms.
      await session.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
      await session.detach();
      await page.locator('.add-note').tap();
      await page.getByRole('textbox', { name: 'Edit note 1', exact: true }).fill('A note made on the cropped page.');
      await page.locator('.pdf-container').tap({ position: { x: 12, y: 100 } });
      await expect.poll(() => f.manuscript.annotations.length).toBe(1);
      const note = f.manuscript.annotations[0];
      assert.equal(note.key, 'recompiled');
      assert.ok(Math.abs(note.rect[0] - originalText[0]) < 0.01);
      assert.ok(Math.abs(note.rect[1] - originalText[1]) < 0.01);
      await expect(page.locator('.note-mark[data-note="note-1"]').first()).toBeVisible();
      const mark = await page.locator('.note-mark[data-note="note-1"]').first().boundingBox(), word = await text.boundingBox();
      assert.ok(Math.abs(mark.x - word.x) < 2 && Math.abs(mark.y - word.y) < 2, 'saved touch annotation aligns with the text');
    }
    await page.setViewportSize({ width: 844, height: 390 });
    await expect.poll(() => page.locator('.pdf-container').evaluate(el => el.scrollWidth - el.clientWidth)).toBeLessThanOrEqual(2);
    await page.screenshot({ path: 'test-results/pdf-crop-mobile-landscape.png' });
    await page.setViewportSize({ width: 390, height: 844 });
    await f.openCrop();
    await dialog.getByRole('button', { name: 'Reset', exact: true }).click();
    await expect(page.locator('.pdf-cropped')).toHaveCount(0);
    assert.equal(await f.saved(), null);
    if (!useWebkit) assert.equal(f.manuscript.annotations.length, 1, 'reset keeps the note');
  } finally { await f.context.close(); }

  const desktop = await open({ width: 1440, height: 1000, mobile: false });
  try {
    const { page, text, dialog } = desktop;
    const original = await text.evaluate(el => {
      const word = el.getBoundingClientRect(), page = el.closest('.page').getBoundingClientRect();
      return [(word.left - page.left) / page.width, (word.top - page.top) / page.height];
    });
    await desktop.openCrop();
    await desktop.dragMargin(0, 0.1); await desktop.dragMargin(2, 0.1); await desktop.dragMargin(1, 0.08);
    await desktop.apply();
    await dragPdfText(page, text);
    await page.locator('.add-source').click();
    await expect.poll(() => desktop.sourceRequests.length).toBe(1);
    const selected = desktop.sourceRequests[0];
    assert.equal(selected.page, 0);
    assert.ok(Math.abs(selected.rect[0] - original[0]) < 0.01, 'source lookup receives original horizontal coordinates');
    assert.ok(Math.abs(selected.rect[1] - original[1]) < 0.01, 'source lookup receives original vertical coordinates');
    await page.screenshot({ path: 'test-results/pdf-crop-desktop.png' });
    await desktop.openCrop();
    const edge = dialog.getByRole('button', { name: 'Left margin (10%)', exact: true });
    const beforeKey = await edge.boundingBox(), preview = await dialog.locator('.pdf-crop-preview').boundingBox();
    const storedCrop = await desktop.saved();
    await edge.focus(); await page.keyboard.press('ArrowRight');
    const movedEdge = dialog.getByRole('button', { name: 'Left margin (11%)', exact: true });
    await expect(movedEdge).toBeFocused();
    await expect.poll(async () => Math.abs((await movedEdge.boundingBox()).x - beforeKey.x - preview.width * 0.01)).toBeLessThan(0.1);
    await page.keyboard.press('Escape');
    await expect(dialog).toHaveCount(0);
    assert.equal(await desktop.saved(), storedCrop, 'Escape discards keyboard adjustments');
    await page.locator('.pdf-container').focus(); await page.keyboard.press('m');
    const region = await text.boundingBox();
    await page.mouse.move(region.x, region.y); await page.mouse.down();
    await page.mouse.move(region.x + region.width / 2, region.y + region.height + 12, { steps: 8 }); await page.mouse.up();
    await page.getByRole('textbox', { name: 'Edit note 1', exact: true }).fill('A region on the cropped page.');
    await page.keyboard.press('Escape');
    await expect.poll(() => desktop.manuscript.annotations.length).toBe(1);
    const regionNote = desktop.manuscript.annotations[0];
    assert.ok(Math.abs(regionNote.rect[0] - original[0]) < 0.01 && Math.abs(regionNote.rect[1] - original[1]) < 0.01, 'regions save original coordinates');
    await page.getByRole('button', { name: 'Zoom in', exact: true }).click();
    const regionMark = page.locator('.note-box[data-note="note-1"]');
    await expect.poll(async () => {
      const mark = await regionMark.boundingBox(), word = await text.boundingBox();
      return Math.abs(mark.x - word.x) + Math.abs(mark.y - word.y);
    }).toBeLessThan(3);
  } finally { await desktop.context.close(); }

  // A crop can end directly below selected text. Actions and their editor
  // must remain clickable outside the clipped page, without scrolling it.
  const tight = await open({ width: 1280, height: 900, mobile: false });
  try {
    const { page, text, dialog } = tight;
    const bottom = await text.evaluate(el => {
      const word = el.getBoundingClientRect(), page = el.closest('.page').getBoundingClientRect();
      return Math.floor((1 - (word.bottom - page.top) / page.height) * 100);
    });
    await tight.openCrop();
    await tight.dragMargin(3, bottom / 100);
    await tight.apply();
    await dragPdfText(page, text);
    const action = page.locator('.add-note');
    await expect(action).toBeVisible();
    const button = await action.boundingBox(), center = { x: button.x + button.width / 2, y: button.y + button.height / 2 };
    assert.equal(await page.evaluate(({ x, y }) => !!document.elementFromPoint(x, y)?.closest('.add-note'), center), true);
    await page.mouse.click(center.x, center.y);
    const editor = page.getByRole('textbox', { name: 'Edit note 1', exact: true });
    await expect(editor).toBeInViewport();
    await editor.fill('A note at the crop boundary.');
    assert.equal(await page.locator('.page').first().evaluate(el => el.scrollTop + el.scrollLeft), 0);
    await page.screenshot({ path: 'test-results/pdf-crop-tight-boundary.png' });
  } finally { await tight.context.close(); }

  for (const options of [{ width: 320, height: 740, locale: 'de', theme: 'dark' }, { width: 390, height: 844, locale: 'zh-CN', theme: 'light' }]) {
    const f = await open(options);
    try {
      await f.openCrop();
      await expect.poll(() => f.dialog.evaluate(el => el.scrollWidth - el.clientWidth)).toBeLessThanOrEqual(1);
      await f.dialog.locator('footer button').last().scrollIntoViewIfNeeded();
      await expect(f.dialog.locator('footer button').last()).toBeInViewport();
      await f.page.screenshot({ path: `test-results/pdf-crop-${options.locale}-${options.theme}.png` });
    } finally { await f.context.close(); }
  }

  const recovery = await open();
  try {
    const { page, dialog } = recovery;
    await page.evaluate(() => {
      window.cropTestGetContext = HTMLCanvasElement.prototype.getContext;
      HTMLCanvasElement.prototype.getContext = function (...args) {
        if (this.closest('.pdf-crop-preview')) throw new Error('Simulated canvas allocation failure');
        return window.cropTestGetContext.apply(this, args);
      };
    });
    await recovery.cropButton.click();
    await expect(dialog.getByRole('alert')).toHaveText('The page preview could not be loaded.');
    await expect(dialog.getByRole('button', { name: 'Apply', exact: true })).toBeDisabled();
    await page.screenshot({ path: 'test-results/pdf-crop-preview-error.png' });
    await page.evaluate(() => { HTMLCanvasElement.prototype.getContext = window.cropTestGetContext; delete window.cropTestGetContext; });
    await dialog.getByRole('button', { name: 'Retry', exact: true }).click();
    await expect(dialog.locator('.pdf-crop-preview')).toBeVisible();
    await expect(dialog.getByRole('button', { name: 'Apply', exact: true })).toBeEnabled();
  } finally { await recovery.context.close(); }
  assert.deepEqual(errors, []);
  console.log('PASS: PDF crop touch handles, fit width, persistence, cancel/reset, recompilation, rotation of the phone, PDF links and original source coordinates.');
} finally {
  await browser?.close(); await server.close(); fs.rmSync(directory, { recursive: true, force: true });
}
