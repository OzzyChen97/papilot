import test from 'node:test';
import assert from 'node:assert/strict';
import { register } from 'node:module';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { parseFragment, serialize, type DefaultTreeAdapterMap } from 'parse5';

// Server rendering checks geometry; check-ui.mjs covers styles and clipping.
register('./fixtures/css-loader.mjs', import.meta.url);
const { PapilotMark } = await import('../src/web/papilot-mark.tsx');

type Element = DefaultTreeAdapterMap['element'];
const attr = (node: Element, name: string) => node.attrs.find(attr => attr.name === name)?.value;
const render = (size: number) => parseFragment(renderToStaticMarkup(createElement(PapilotMark, { size, className: 'brand-mark' }))).childNodes[0] as Element;
const large = render(52);

for (const size of [16, 18, 20, 21, 44, 52]) test(`Papilot keeps the full logo at ${size}px`, () => {
  const svg = render(size);
  const group = svg.childNodes[0] as Element;
  const stripes = group.childNodes as Element[];
  assert.equal(stripes.length, 5, 'Every size uses all five stripes');
  assert.deepEqual(stripes.map(stripe => attr(stripe, 'class')), ['mark-top', 'mark-top', 'mark-line', 'mark-bottom', 'mark-bottom']);
  assert.equal(serialize(svg), serialize(large), 'Only the SVG viewport scales; the geometry and transform stay the same');
  assert.equal(attr(svg, 'viewBox'), '0 0 64 64');
  assert.equal(attr(svg, 'width'), String(size));
  assert.equal(attr(svg, 'height'), String(size));
  assert.equal(attr(svg, 'class'), 'papilot-mark brand-mark');
  assert.equal(attr(svg, 'aria-hidden'), 'true');
});
