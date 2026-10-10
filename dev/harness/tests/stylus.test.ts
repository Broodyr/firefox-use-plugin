// Stylus adapter: check / install / live update / watch / two-way sync / enable / vars / uninstall, with undo
// and the snapshot "stylus" part. Stylus (pinned in test-addons.json, optional) is installed into the throwaway
// profile as a temporary add-on; the test is skipped when no copy is available (npm run test:setup).
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';
import { addonFile } from '../env.mjs';
import { McpClient, PAGES, makeHome, startFixtures, startServer } from './helpers.ts';

const STYLUS = '{7a7a4a92-a2a0-41d1-9fd7-1e92480d612d}';
const XPI = addonFile(STYLUS);
PAGES['/stylus.html'] = '<!doctype html><title>Stylus fixture</title><h1>Styled</h1><p>text</p>';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const usercss = (prefix: string, version: string, rule: string, extra = '') =>
  `/* ==UserStyle==\n@name        Probe\n@namespace   firefox-use.test\n@version     ${version}\n${extra}==/UserStyle== */\n@-moz-document url-prefix("${prefix}") {\n  ${rule}\n}\n`;

describe('stylus', { skip: !XPI && 'no Stylus .xpi: run npm run test:setup' }, () => {
  let c: McpClient, fx: Awaited<ReturnType<typeof startFixtures>>, h: ReturnType<typeof makeHome>;
  let prefix = '';
  const file = (f: string) => path.join(h.workspace, 'styles', f);
  const write = (f: string, s: string) => fs.writeFileSync(file(f), s);
  // eval prints `[page] (string) "value"`
  const str = (text: string) => /\(string\) "(.*)"/.exec(text)?.[1] ?? text;
  const computed = async (prop: string) => str((await c.call('eval', { code: `getComputedStyle(document.body).${prop}` })).text);
  const until = async (prop: string, want: string, ms = 6000) => {
    let v = '';
    for (let t = 0; t < ms / 200; t++) { v = await computed(prop); if (v === want) return v; await sleep(200); }
    return v;
  };
  const api = (p: string, ...args: unknown[]) => c.call('ext_message', { extension: STYLUS, message: { data: { method: 'invokeAPI', path: p, args }, TDM: 1 } });

  before(async () => {
    h = makeHome(); fx = await startFixtures(); c = await startServer(h.env);
    prefix = fx.url('/stylus');
    fs.mkdirSync(path.join(h.workspace, 'styles'), { recursive: true });
    fs.copyFileSync(XPI!, path.join(h.workspace, 'stylus.xpi'));
    let r = await c.call('addons_install_local', { path: 'stylus.xpi' });
    assert.ok(!r.isError, r.text);
    for (let t = 0; t < 50; t++) { r = await c.call('stylus_read', { kind: 'list' }); if (!r.isError) break; await sleep(200); }
    assert.ok(!r.isError, r.text);
    r = await c.call('scope_set', { description: 'userstyles in Stylus for this test', areas: ['ext:stylus', 'restore'], user_said: 'yes, go ahead' });
    assert.ok(!r.isError, r.text);
  });
  after(async () => { await c.close(); fx.close(); h.cleanup(); });

  it('check: a parse error as file:line:col; a valid file with its sections, nothing installed', async () => {
    write('bad.user.css', usercss(prefix, '1.0.0', 'body {{ outline: 3px solid red; }'));
    let r = await c.call('stylus_read', { kind: 'check', path: 'styles/bad.user.css' });
    assert.ok(r.isError);
    assert.match(r.text, /STYLE_INVALID[\s\S]*styles\/bad\.user\.css:7:\d+ /, r.text);
    write('probe.user.css', usercss(prefix, '1.0.0', 'body { outline: 3px solid rgb(255, 0, 0); }'));
    r = await c.call('stylus_read', { kind: 'check', path: 'styles/probe.user.css' });
    assert.match(r.text, /^OK styles\/probe\.user\.css: "Probe" 1\.0\.0 · 1 section\(s\): url-prefix http:\/\/127\.0\.0\.1:\d+\/stylus\nan install adds a new style/, r.text);
    assert.match((await c.call('stylus_read', { kind: 'list' })).text, /no styles installed/);
  });

  it('install restyles the open tab without a reload; for_url says why it applies', async () => {
    await c.call('navigate', { url: fx.url('/stylus.html') });
    assert.equal(await computed('outlineStyle'), 'none');
    const r = await c.call('stylus_write', { action: 'install', path: 'styles/probe.user.css' });
    assert.match(r.text, /^installed Stylus #\d+ "Probe" 1\.0\.0 from styles\/probe\.user\.css\n {2}1 section\(s\): url-prefix http[^\n]*· enabled · applies to open tabs at once/, r.text);
    assert.equal(await until('outlineColor', 'rgb(255, 0, 0)'), 'rgb(255, 0, 0)');
    const u = await c.call('stylus_read', { kind: 'for_url' });
    assert.match(u.text, /"Probe" 1\.0\.0: APPLIES/);
    assert.match(u.text, /in the page now: 1 <style class="stylus"> element/);
    assert.match((await c.call('stylus_read', { kind: 'list' })).text, /"Probe" 1\.0\.0 · enabled · usercss · url-prefix [^\n]* · file styles\/probe\.user\.css/);
  });

  it('update after an edit restyles live; undo puts the previous code back', async () => {
    write('probe.user.css', usercss(prefix, '1.0.1', 'body { outline: 3px solid rgb(0, 0, 255); }'));
    let r = await c.call('stylus_write', { action: 'update', style: 'styles/probe.user.css' });
    assert.match(r.text, /updated Stylus #\d+ "Probe" 1\.0\.0 -> 1\.0\.1 from styles\/probe\.user\.css/, r.text);
    assert.equal(await until('outlineColor', 'rgb(0, 0, 255)'), 'rgb(0, 0, 255)');
    r = await c.call('undo', { target: 1 });
    assert.match(r.text, /Stylus #\d+ code -> previous version/, r.text);
    assert.equal(await until('outlineColor', 'rgb(255, 0, 0)'), 'rgb(255, 0, 0)');
    // the file follows Stylus again (auto-pull: the file itself didn't change since the last sync)
    for (let t = 0; t < 40 && !fs.readFileSync(file('probe.user.css'), 'utf8').includes('1.0.0'); t++) await sleep(200);
    assert.match(fs.readFileSync(file('probe.user.css'), 'utf8'), /@version {5}1\.0\.0[\s\S]*rgb\(255, 0, 0\)/);
  });

  it('watch: a save restyles the page live; a parse error is reported and the last good version stays', async () => {
    let r = await c.call('stylus_write', { action: 'watch', style: 'styles/probe.user.css' });
    assert.match(r.text, /^watching styles\/probe\.user\.css/, r.text);
    write('probe.user.css', usercss(prefix, '1.0.2', 'body { outline: 3px solid rgb(0, 128, 0); }'));
    assert.equal(await until('outlineColor', 'rgb(0, 128, 0)'), 'rgb(0, 128, 0)');
    const noteFor = async (re: RegExp) => {
      let note = '';
      for (let t = 0; t < 25 && !re.test(note); t++) { await sleep(200); note += (await c.call('stylus_read', { kind: 'sync_status' })).text; }
      return note;
    };
    // no metadata: Stylus refuses it, the last good version stays applied
    write('probe.user.css', 'body { outline: 3px solid rgb(9, 9, 9); }\n');
    assert.match(await noteFor(/FAILED/), /stylus watch: push of styles\/probe\.user\.css FAILED \(the previous version stays applied\)[^\n]*no \/\* ==UserStyle==/);
    assert.equal(await computed('outlineColor'), 'rgb(0, 128, 0)');
    // a CSS error: Stylus installs it, skipping what it can't parse; the strict parse says what
    write('probe.user.css', usercss(prefix, '1.0.3', 'body {{ outline: 3px solid rgb(0, 128, 0); }'));
    assert.match(await noteFor(/parser error/), /stylus watch: pushed styles\/probe\.user\.css with parser error\(s\): styles\/probe\.user\.css:7:\d+ /);
    write('probe.user.css', usercss(prefix, '1.0.2', 'body { outline: 3px solid rgb(0, 128, 0); }'));
    assert.equal(await until('outlineColor', 'rgb(0, 128, 0)'), 'rgb(0, 128, 0)'); // pushed (the broken version had no outline)
    for (let t = 0; t < 25 && !/: synced/.test((await c.call('stylus_read', { kind: 'sync_status' })).text); t++) await sleep(200);
    r = await c.call('stylus_write', { action: 'watch', style: 'styles/probe.user.css', on: false });
    assert.match(r.text, /^stopped watching/);
  });

  it('edits in Stylus are pulled into an unchanged file; changed on both sides -> a conflict file, nothing overwritten', async () => {
    const id = Number(/#(\d+) "Probe"/.exec((await c.call('stylus_read', { kind: 'list' })).text)![1]);
    const edited = usercss(prefix, '1.1.0', 'body { outline: 3px dashed rgb(0, 128, 0); }');
    let r = await api('usercss.install', { id, sourceCode: edited });
    assert.ok(!r.isError, r.text);
    for (let t = 0; t < 40 && !fs.readFileSync(file('probe.user.css'), 'utf8').includes('1.1.0'); t++) await sleep(200);
    assert.equal(fs.readFileSync(file('probe.user.css'), 'utf8'), edited);
    assert.match((await c.call('stylus_read', { kind: 'sync_status' })).text, /styles\/probe\.user\.css <-> Stylus #\d+ "Probe": synced/);
    write('probe.user.css', usercss(prefix, '1.2.0-file', 'body { outline: 3px dotted rgb(0, 128, 0); }'));
    await api('usercss.install', { id, sourceCode: usercss(prefix, '1.2.0-stylus', 'body { outline: 3px double rgb(0, 128, 0); }') });
    r = await c.call('stylus_write', { action: 'sync' });
    assert.match(r.text, /CONFLICT styles\/probe\.user\.css/, r.text);
    assert.match(fs.readFileSync(file('probe.user.css'), 'utf8'), /1\.2\.0-file/);
    assert.match(fs.readFileSync(file('probe.user.css.stylus-conflict'), 'utf8'), /1\.2\.0-stylus/);
    r = await c.call('stylus_write', { action: 'update', style: 'Probe' }); // keep the file's version
    assert.match(r.text, /-> 1\.2\.0-file/);
  });

  it('disable / enable, @var values, uninstall and its undo', async () => {
    await c.call('stylus_write', { action: 'disable', style: 'Probe' });
    assert.equal(await until('outlineStyle', 'none'), 'none');
    await c.call('stylus_write', { action: 'enable', style: 'Probe' });
    assert.equal(await until('outlineStyle', 'dotted'), 'dotted');
    write('vars.user.css', `/* ==UserStyle==\n@name        Vars\n@namespace   firefox-use.test\n@version     1.0.0\n@var color accent "Accent" #ff0000\n==/UserStyle== */\n@-moz-document url-prefix("${prefix}") {\n  h1 { color: var(--accent); }\n}\n`);
    let r = await c.call('stylus_write', { action: 'install', path: 'styles/vars.user.css' });
    assert.ok(!r.isError, r.text);
    const h1 = async () => str((await c.call('eval', { code: 'getComputedStyle(document.querySelector("h1")).color' })).text);
    for (let t = 0; t < 30 && (await h1()) !== 'rgb(255, 0, 0)'; t++) await sleep(200);
    assert.equal(await h1(), 'rgb(255, 0, 0)');
    assert.match((await c.call('stylus_read', { kind: 'source', style: 'Vars' })).text, /variables: accent = "#ff0000"/);
    r = await c.call('stylus_write', { action: 'vars', style: 'Vars', values: { accent: '#00ff00' } });
    assert.match(r.text, /accent: "#ff0000" -> "#00ff00"/, r.text);
    for (let t = 0; t < 30 && (await h1()) !== 'rgb(0, 255, 0)'; t++) await sleep(200);
    assert.equal(await h1(), 'rgb(0, 255, 0)');
    r = await c.call('stylus_write', { action: 'uninstall', style: 'Vars' });
    assert.match(r.text, /"Vars" 1\.0\.0 removed from Stylus \(file styles\/vars\.user\.css kept, no longer linked\)/, r.text);
    for (let t = 0; t < 30 && (await h1()) !== 'rgb(0, 0, 0)'; t++) await sleep(200);
    r = await c.call('undo', { target: 1 });
    assert.match(r.text, /"Vars" put back/, r.text);
    assert.match((await c.call('stylus_read', { kind: 'list' })).text, /"Vars" 1\.0\.0 · enabled/);
  });

  it('snapshot part "stylus": restore removes styles added since and puts changed ones back', async () => {
    let r = await c.call('snapshot', { label: 'styles' });
    const snap = /snapshot (s\S+)/.exec(r.text)![1];
    write('extra.user.css', usercss(prefix, '1.0.0', 'p { color: rgb(1, 2, 3); }').replace('Probe', 'Extra'));
    await c.call('stylus_write', { action: 'install', path: 'styles/extra.user.css' });
    await c.call('stylus_write', { action: 'disable', style: 'Probe' });
    r = await c.call('snapshot_diff', { a: snap });
    assert.match(r.text, /Stylus #\d+ "Extra": absent -> present/, r.text);
    assert.match(r.text, /"Probe" 1\.2\.0-file: enabled -> disabled/, r.text);
    r = await c.call('restore', { id: snap, parts: ['stylus'] });
    assert.match(r.text, /Stylus: removed 1 style\(s\) added since: "Extra"/, r.text);
    assert.match(r.text, /Stylus: put back 1 style\(s\): "Probe"/, r.text);
    const list = (await c.call('stylus_read', { kind: 'list' })).text;
    assert.doesNotMatch(list, /"Extra"/);
    assert.match(list, /"Probe" 1\.2\.0-file · enabled/);
  });
});
