// ext_dev_build (web-ext build) and ext_dev_sign (web-ext sign: a submission to
// addons.mozilla.org, with the user's OK every time; AMO keys only from environment variables the user set).
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import { workspace } from '../config.js';
import { fail } from '../errors.js';
import { stateDir } from '../audit/audit.js';
import { kb } from '../browser/devtools.js';
import { checkUploadPath } from './input.js';
import { findWebExt, webExtLint } from './extdev.js';
import { tool } from './registry.js';

/** Run web-ext with the server's environment: AMO keys come from there, never from args. */
function runWebExt(args: string[], timeoutMs: number): Promise<{ code: number | null; out: string }> {
  const bin = findWebExt() ?? fail('WEB_EXT_MISSING', 'web-ext is not installed', 'The user installs it once with: npm install -g web-ext (a source checkout of the plugin has it after npm install).');
  return new Promise((res) => {
    const p = spawn(process.execPath, [bin, ...args, '--no-config-discovery', '--no-input'], { windowsHide: true, env: process.env });
    let out = '';
    p.stdout.on('data', (d) => { out += d; });
    p.stderr.on('data', (d) => { out += d; });
    const t = setTimeout(() => { p.kill(); out += `\n(timed out after ${timeoutMs} ms)`; }, timeoutMs);
    p.on('close', (code) => { clearTimeout(t); res({ code, out }); });
    p.on('error', (e) => { clearTimeout(t); res({ code: -1, out: e.message }); });
  });
}

function extFolder(p: string): string {
  const abs = checkUploadPath(p);
  if (!fs.statSync(abs).isDirectory() || !fs.existsSync(path.join(abs, 'manifest.json'))) fail('BAD_ARGS', `${abs} is not a folder with manifest.json`);
  return abs;
}

/** A folder inside the workspace (created if missing). */
function workspaceDir(p: string): string {
  const abs = path.resolve(workspace(), p);
  const root = path.resolve(workspace()).toLowerCase() + path.sep;
  if (!(abs.toLowerCase() + path.sep).startsWith(root)) fail('PATH_REFUSED', `${p} is outside the workspace`);
  fs.mkdirSync(abs, { recursive: true });
  return abs;
}

export const extBuildTools = [
  tool({
    name: 'ext_dev_build',
    description: 'Package a local extension folder into a .zip for AMO or self-distribution (web-ext build: node_modules, dotfiles and earlier builds left out), written to .firefox-use/artifacts/ext-builds/ (or out_dir in the workspace). Runs addons-linter first and reports its error/warning counts (lint:false skips).',
    args: {
      path: z.string().min(1).describe('Extension folder (workspace-relative)'),
      out_dir: z.string().optional().describe('Workspace folder for the .zip (default .firefox-use/artifacts/ext-builds)'),
      lint: z.boolean().default(true),
    },
    write: true,
    async handler(a) {
      const abs = extFolder(a.path);
      const out = a.out_dir ? workspaceDir(a.out_dir) : stateDir('artifacts', 'ext-builds');
      const lines: string[] = [];
      if (a.lint) {
        const wl = await webExtLint(abs);
        if (wl && typeof wl !== 'string') lines.push(`addons-linter: ${wl.errors.length} error(s), ${wl.warnings.length} warning(s)${wl.errors.length ? ` (first: ${wl.errors.slice(0, 3).map((m: any) => `${m.code}${m.file ? ` in ${m.file}` : ''}`).join(', ')}; ext_dev_lint shows all)` : ''}`);
        else if (typeof wl === 'string') lines.push(`addons-linter: ${wl}`);
      }
      const r = await runWebExt(['build', '--source-dir', abs, '--artifacts-dir', out, '--overwrite-dest'], 120000);
      const zip = /ready: (.+\.zip)\s*$/m.exec(r.out)?.[1]?.trim();
      if (r.code !== 0 || !zip) fail('BUILD_FAILED', `web-ext build failed (exit ${r.code})`, undefined, { output: r.out.slice(-1500) });
      const file = path.resolve(out, zip!);
      lines.unshift(`built ${file} (${kb(fs.statSync(file).size)})`);
      return { text: lines.join('\n'), changes: [{ kind: 'file', path: file }] };
    },
  }),
  tool({
    name: 'ext_dev_sign',
    description: 'Submit a local extension to addons.mozilla.org for signing (web-ext sign). Channel "unlisted" (default): signed for self-distribution, not published; "listed": published on AMO after review. Needs the user\'s OK for EVERY submission (an approval dialog, or user_said quoting them from chat) and AMO API keys the USER set as environment variables WEB_EXT_API_KEY / WEB_EXT_API_SECRET for Claude Code: never ask for the keys or write them anywhere. The signed .xpi goes to .firefox-use/artifacts/ext-builds/.',
    args: {
      path: z.string().min(1),
      channel: z.enum(['unlisted', 'listed']).default('unlisted'),
      user_said: z.string().min(1).optional().describe('The user\'s OK for THIS submission, quoted from chat (when no approval dialog is available)'),
      timeout_ms: z.number().int().positive().max(1800000).default(900000).describe('How long to wait for AMO to sign'),
    },
    write: true,
    async handler(a, ctx) {
      const abs = extFolder(a.path);
      if (!process.env.WEB_EXT_API_KEY || !process.env.WEB_EXT_API_SECRET) {
        fail('KEYS_MISSING', 'WEB_EXT_API_KEY / WEB_EXT_API_SECRET are not set for the Claude Code process',
          'The user creates AMO API credentials (addons.mozilla.org > Developer Hub > Manage API Keys), sets both variables in their environment and restarts Claude Code. Never ask for the keys in chat or put them in files.');
      }
      let manifest: any = {};
      try { manifest = JSON.parse(fs.readFileSync(path.join(abs, 'manifest.json'), 'utf8')); } catch { /* web-ext reports it */ }
      const what = `${manifest.name ?? a.path} ${manifest.version ?? ''} (${a.path}) to addons.mozilla.org, channel "${a.channel}"${a.channel === 'listed' ? ' (PUBLISHED on AMO after review)' : ' (signed for self-distribution, not published)'}`;
      let via = '';
      const r0 = ctx.elicit ? await ctx.elicit({
        message: `Claude wants to submit ${what}.\n\nThis uploads the extension's files to Mozilla with your AMO API key.`,
        requestedSchema: { type: 'object', properties: { decision: { type: 'string', title: 'Submit?', enum: ['submit', 'cancel'], enumNames: ['Submit this extension', 'Cancel'] } }, required: ['decision'] },
      }).catch(() => ({ action: 'cancel' as const })) : null;
      if (r0 && r0.action === 'accept' && (r0.content as any)?.decision === 'submit') via = 'the approval dialog';
      else if (r0 && r0.action !== 'cancel') fail('SUBMIT_DECLINED', 'the user declined this submission', 'Do not retry; ask the user in chat what they want.');
      // no dialog in this client (or dismissed / not shown): the user's words from chat
      else if (a.user_said) via = `chat: ${JSON.stringify(a.user_said)}`;
      else fail('APPROVAL_NEEDED', `submitting needs the user's OK each time: ${what}`, 'Ask the user in chat; on yes, call again with user_said quoting them.');
      const out = stateDir('artifacts', 'ext-builds');
      const r = await runWebExt(['sign', '--source-dir', abs, '--artifacts-dir', out, '--channel', a.channel, '--timeout', String(a.timeout_ms)], a.timeout_ms + 60000);
      const xpi = [...r.out.matchAll(/(\S+\.xpi)\b/g)].map((m) => m[1]).pop();
      if (r.code !== 0) fail('SIGN_FAILED', `web-ext sign failed (exit ${r.code})`, undefined, { output: r.out.slice(-2000) });
      return {
        text: `submitted ${what}, approved via ${via}${xpi ? `\nsigned: ${path.resolve(out, xpi)}` : `\n${r.out.slice(-800)}`}`,
        changes: [{ kind: 'amo_submission', path: abs, after: { channel: a.channel, version: manifest.version, via } }],
      };
    },
  }),
];
