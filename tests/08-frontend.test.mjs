// The browser app, checked without a browser: it parses, every element it looks
// up exists, ids are unique, and the theme defines what the styles use.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { spawnSync } from 'node:child_process';

const js = fs.readFileSync('public/app.js', 'utf8');
const html = fs.readFileSync('public/index.html', 'utf8');
const css = fs.readFileSync('public/styles.css', 'utf8');
const lineOf = (i) => js.slice(0, i).split('\n').length;

describe('front end', () => {
  it('app.js and the connector parse', () => {
    for (const f of ['public/app.js', 'public/connector/aj-pilot-connector.mjs']) {
      const r = spawnSync(process.execPath, ['--check', f], { encoding: 'utf8' });
      assert.equal(r.status, 0, `${f}: ${r.stderr}`);
    }
  });

  it('index.html has no duplicate ids', () => {
    const ids = [...html.matchAll(/\sid="([^"]+)"/g)].map((m) => m[1]);
    const dup = [...new Set(ids.filter((x, i) => ids.indexOf(x) !== i))];
    assert.deepEqual(dup, []);
  });

  it('every #id the script looks up exists in the page or is made by the script', () => {
    const known = new Set([
      ...[...html.matchAll(/\sid="([^"]+)"/g)].map((m) => m[1]),
      ...[...js.matchAll(/\bid="([A-Za-z][\w-]*)"/g)].map((m) => m[1]),
      ...[...js.matchAll(/\.id\s*=\s*['"]([A-Za-z][\w-]*)['"]/g)].map((m) => m[1]),
      // Ids written into templates from a lookup table, e.g. liveTabPanelId's 'docker-panel'.
      ...[...js.matchAll(/:\s*'([a-z][\w-]*-panel)'/g)].map((m) => m[1]),
    ]);
    const prefixes = [...js.matchAll(/\bid="([A-Za-z][\w-]*?)\$\{/g)].map((m) => m[1]);
    const missing = [];
    // A selector followed by ${ is built at runtime (#view-${name}) and is not checked.
    for (const m of js.matchAll(/(?:\$\$?|querySelector(?:All)?|closest)\(\s*['`"]#([A-Za-z][\w-]*)(\$\{)?/g)) {
      if (m[2] || known.has(m[1]) || prefixes.some((p) => m[1].startsWith(p))) continue;
      missing.push(`${m[1]} (app.js:${lineOf(m.index)})`);
    }
    assert.deepEqual(missing, []);
  });

  it('every CSS variable the styles use is defined', () => {
    const defined = new Set([...css.matchAll(/(--[\w-]+)\s*:/g)].map((m) => m[1]));
    const inline = new Set([...(js + html).matchAll(/(--[\w-]+)\s*:/g)].map((m) => m[1]));
    const missing = [...new Set([...css.matchAll(/var\((--[\w-]+)(?:\s*,[^)]*)?\)/g)]
      .filter((m) => !m[0].includes(',')) // var(--x, fallback) is fine either way
      .map((m) => m[1]))].filter((v) => !defined.has(v) && !inline.has(v));
    assert.deepEqual(missing, []);
  });

  it('both themes define the same colour tokens', () => {
    const block = (sel) => {
      const i = css.indexOf(sel);
      assert.ok(i >= 0, `no ${sel} block`);
      return new Set([...css.slice(i, css.indexOf('}', i)).matchAll(/(--[\w-]+)\s*:/g)].map((m) => m[1]));
    };
    const dark = block(':root[data-theme="dark"] {');
    const light = block(':root[data-theme="light"] {');
    assert.ok(dark.size > 10 && light.size > 10, 'both theme blocks found');
    assert.deepEqual([...dark].filter((v) => !light.has(v)), [], 'defined for dark but not light');
    assert.deepEqual([...light].filter((v) => !dark.has(v)), [], 'defined for light but not dark');
  });

  it('only loads scripts from itself or Razorpay', () => {
    const srcs = [...(js + html).matchAll(/\.src\s*=\s*['"]([^'"]+)['"]|<script[^>]+src="([^"]+)"/g)].map((m) => m[1] || m[2]);
    const foreign = srcs.filter((s) => /^https?:/.test(s) && !/^https:\/\/checkout\.razorpay\.com\//.test(s));
    assert.deepEqual(foreign, []);
  });
});
