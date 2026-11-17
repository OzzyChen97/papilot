import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import Fastify from 'fastify';
import staticFiles from '@fastify/static';
import { chromium, expect } from './playwright.mjs';
import { selectOption, selectedValue } from './select.mjs';
import { readyRequirements } from './required-tools-fixture.mjs';

const server = Fastify();
await server.register(staticFiles, { root: path.resolve('dist') });
await server.listen({ host: '127.0.0.1', port: 0 });
const origin = `http://127.0.0.1:${server.server.address().port}`;
const browser = await chromium.launch({ channel: process.env.PAPILOT_BROWSER_CHANNEL || 'chrome', headless: true });
fs.mkdirSync('test-results', { recursive: true });
const errors = [];
try {
  for (const [width, dark, language] of [[1360, false, 'en'], [390, true, 'en'], [390, false, 'zh-CN']]) {
    const context = await browser.newContext({ viewport: { width, height: 900 }, colorScheme: dark ? 'dark' : 'light', hasTouch: width < 600 });
    const runtime = { connected: true, authenticated: true, installed: true, account: 'Fixture', error: null, models: [{ id: 'gpt-test', name: 'Test model', isDefault: true, efforts: [], defaultEffort: null }] };
    const state = { version: 'test', csrf: 'fixture', projects: [], tasks: [], requests: [], runtime, runtimes: { codex: runtime, collaboration: { ...runtime, hidden: true } } };
    let fail = false, saves = 0;
    await context.addInitScript(language => { localStorage.setItem('papilot:language', language); localStorage.setItem('papilot:setup-seen', '1'); }, language);
    await context.route('**/api/**', route => {
      const url = new URL(route.request().url());
      if (url.pathname === '/api/state') return route.fulfill({ json: state });
      if (url.pathname === '/api/collaboration') {
        saves++;
        if (fail) return route.fulfill({ status: 503, json: { error: 'Fixture save failed' } });
        const { enabled } = route.request().postDataJSON(); state.runtimes.collaboration.hidden = !enabled;
        return route.fulfill({ json: { enabled } });
      }
      if (url.pathname === '/api/diagnostics') return route.fulfill({ json: { checks: [], checkedAt: Date.now() } });
      if (url.pathname === '/api/events') return route.fulfill({ contentType: 'text/event-stream', body: ': fixture\n\n' });
      if (url.pathname === '/api/runtime/requirements') return route.fulfill({ json: readyRequirements });
      return route.fulfill({ json: {} });
    });
    const page = await context.newPage(); page.on('pageerror', error => errors.push(error.message));
    await page.goto(origin);
    if (width < 600) await page.locator('.sidebar-toggle').click();
    await page.locator('.settings-link').click();
    await page.locator('[data-settings-page="agents"]').click();
    await expect(page.locator('[data-agent="collaboration"]')).toHaveCount(0);
    if (width < 600) await page.locator('.settings-mobile-back').click();
    await page.locator('[data-settings-page="about"]').click();
    const disclosure = page.locator('.workflow-experiments'), toggle = disclosure.getByRole('switch');
    await expect(toggle).not.toBeVisible();
    await disclosure.locator('summary').focus(); await page.keyboard.press('Enter');
    await expect(toggle).toBeVisible(); await expect(toggle).not.toBeChecked();
    await expect(toggle).toHaveAccessibleName(language === 'zh-CN' ? '启用协作模式' : 'Enable collaboration mode');
    if (language === 'en') {
      fail = true; await toggle.click(); await expect(disclosure.getByRole('alert')).toContainText('Fixture save failed'); await expect(toggle).not.toBeChecked(); fail = false;
    }
    await toggle.focus(); await page.keyboard.press('Space'); await expect(toggle).toBeChecked();
    await expect(disclosure.getByRole('alert')).toHaveCount(0);
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
    await page.locator('.settings-content').evaluate(element => { element.scrollTop = element.scrollHeight; });
    await page.screenshot({ path: `test-results/collaboration-${width}-${language}.png`, animations: 'disabled' });
    await page.locator('.modal-close').click(); await page.reload(); if (width < 600) await page.locator('.sidebar-toggle').click(); await page.locator('.settings-link').click();
    if (width < 600) await page.locator('[data-settings-page="general"]').click();
    // General settings' second combobox is the default agent/model, after language.
    const model = page.locator('.settings-content-general [role="combobox"]').nth(1);
    await selectOption(model, JSON.stringify(['collaboration', 'gpt-test']));
    assert.equal(await selectedValue(model), JSON.stringify(['collaboration', 'gpt-test']));
    await expect(model).toContainText(language === 'zh-CN' ? '协作模式' : 'Collaboration mode');
    if (width < 600) await page.locator('.settings-mobile-back').click();
    await page.locator('[data-settings-page="about"]').click(); await disclosure.locator('summary').click();
    await expect(toggle).toBeChecked(); await toggle.click(); await expect(toggle).not.toBeChecked();
    if (width < 600) await page.locator('.settings-mobile-back').click();
    await page.locator('[data-settings-page="general"]').click();
    await expect(model).toContainText('Codex');
    assert.equal(saves, language === 'en' ? 3 : 2);
    await context.close();
  }
  assert.deepEqual(errors, []); console.log('Collaboration mode: hidden settings, enable/disable, errors, persistence, keyboard and mobile layouts checked.');
} finally { await browser.close(); await server.close(); }
