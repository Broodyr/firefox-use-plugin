// promote (SPEC §4.6 "Extensions in the user's Firefox"): put a userscript, userstyle or uBO filter list built in
// claude-dev into the user's own Firefox through the extension's own install flow, the user confirming there.
// Personal mode has no system access, so Claude can list, close and navigate the install page (full getTree) but
// never read or click in it: the confirmation is the user's.
import fs from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import { workspace } from '../config.js';
import { fail } from '../errors.js';
import { sleep } from '../browser/launcher.js';
import { PERSONAL } from '../browser/personal.js';
import type { Browser } from '../browser/session.js';
import { resourceServer } from '../resources/server.js';
import { tool } from './registry.js';

type Kind = 'userscript' | 'userstyle' | 'filters';

const EXT: Record<Kind, RegExp> = { userscript: /\.user\.js$/i, userstyle: /\.user\.css$/i, filters: /\.(txt|filters?)$/i };
const HEADER: Record<'userscript' | 'userstyle', [RegExp, string]> = {
  userscript: [/==UserScript==[\s\S]*?==\/UserScript==/, '// ==UserScript== … // ==/UserScript=='],
  userstyle: [/==UserStyle==[\s\S]*?==\/UserStyle==/, '/* ==UserStyle== … ==/UserStyle== */'],
};
const IN_CLAUDE_DEV: Record<Kind, string> = {
  userscript: 'us_write(action: "install")', userstyle: 'stylus_write(action: "install")', filters: 'ubo_write(action: "filters_add")',
};

/** A workspace file of the right kind (never anything outside the workspace). */
function promotedFile(kind: Kind, p: string): { abs: string; rel: string; src: string } {
  const root = path.resolve(workspace());
  const abs = path.resolve(root, p);
  if (abs !== root && !abs.startsWith(root + path.sep)) fail('BAD_ARGS', `${p} is outside the workspace (${root})`, 'promote serves workspace files only.');
  if (!fs.existsSync(abs) || !fs.statSync(abs).isFile()) fail('FILE_NOT_FOUND', `no file ${abs}`);
  if (!EXT[kind].test(abs)) {
    fail('BAD_ARGS', `a ${kind} file must end in ${kind === 'userscript' ? '.user.js' : kind === 'userstyle' ? '.user.css' : '.txt'} (${path.basename(abs)})`,
      kind === 'filters' ? 'Put the filters in a .txt file, one per line.' : 'The extension catches the install by that ending; rename the file.');
  }
  return { abs, rel: path.relative(root, abs).replace(/\\/g, '/'), src: fs.readFileSync(abs, 'utf8') };
}

const metaName = (src: string) => /^\s*(?:\/\/|\*)?\s*@name\s+(.+?)\s*$/m.exec(src)?.[1];
const filterLines = (src: string) => src.split(/\r?\n/).map((l) => l.trim()).filter((l) => l && !l.startsWith('!') && !l.startsWith('['));

/** The full tree's top-level contexts: Claude may list (not read) extension pages there without system access. */
async function tops(b: Browser): Promise<{ context: string; url: string }[]> {
  return (await b.bidi.send('browsingContext.getTree', { maxDepth: 0 })).contexts;
}

const isExtPage = (u: string) => u.startsWith('moz-extension://');
const pagePath = (u: string) => { try { const x = new URL(u); return x.origin + x.pathname; } catch { return u; } };

export const promoteTools = [
  tool({
    name: 'promote',
    description: 'Personal mode only: put a userscript (.user.js), userstyle (.user.css) or uBO filter list (.txt) from the workspace into the user\'s own Firefox through the extension\'s own install flow. userscript / userstyle: serves the file locally, opens it in Claude\'s window (shown, that tab activated) so Violentmonkey / Stylus shows its install page, and waits until the user closes that page (or timeout_s). Claude never clicks there: tell the user BEFORE calling what they will see and to click Install (Update shows the diff), then close the tab. filters: only serves the list and returns its URL and the steps for uBO\'s dashboard. In claude-dev, install directly (us_write / stylus_write / ubo_write).',
    args: {
      kind: z.enum(['userscript', 'userstyle', 'filters']),
      path: z.string().min(1).describe('Workspace file: scripts/x.user.js, styles/x.user.css, or a filter list (.txt, one filter per line)'),
      timeout_s: z.number().int().min(5).max(600).default(180).describe('How long to wait for the user to finish on the install page (userscript / userstyle)'),
    },
    write: true,
    async handler(a, ctx) {
      // refused before anything starts: in claude-dev the adapters install directly
      if (ctx.opts.profile !== PERSONAL) {
        fail('PERSONAL_ONLY', 'promote puts work into the user\'s own Firefox, so it runs in personal mode only',
          `In claude-dev, install it directly: ${IN_CLAUDE_DEV[a.kind]}. For the user's own Firefox (when they ask): ff_quit, ff_launch with profile "personal", then promote.`);
      }
      const f = promotedFile(a.kind, a.path);
      if (a.kind !== 'filters' && !HEADER[a.kind][0].test(f.src)) {
        fail('BAD_FILE', `${f.rel} has no ${a.kind === 'userscript' ? 'userscript' : 'usercss'} metadata block (${HEADER[a.kind][1]})`, 'Without it the extension does not offer to install the file.');
      }
      const b = await ctx.browser();
      if (!b.personal) fail('PERSONAL_ONLY', 'this session is not driving the user\'s own Firefox');
      const srv = await resourceServer(b, true);

      if (a.kind === 'filters') {
        const lines = filterLines(f.src);
        if (!lines.length) fail('BAD_FILE', `${f.rel} has no filters (one per line; "!" lines are comments)`);
        const stem = path.basename(f.abs).replace(/\.[^.]+$/, '');
        const urlPath = `/promote/${encodeURIComponent(stem)}.txt`;
        // uBO names an imported list by its "! Title:" line
        srv.promoted.set(urlPath, {
          file: f.abs, type: 'text/plain; charset=utf-8',
          body: (s) => /^\s*!\s*Title:/im.test(s.toString('utf8').slice(0, 2000)) ? s : Buffer.concat([Buffer.from(`! Title: ${stem}\n`), s]),
        });
        const url = srv.origin + urlPath;
        const shown = lines.slice(0, 40);
        return {
          text: [
            `Serving ${f.rel} as a uBO filter list (${lines.length} filter(s)) at ${url}, only while this personal-mode session runs (no automatic route: uBO subscribes from links on a few filter-list sites only). Nothing was changed in the user's Firefox.`,
            'Tell the user, either:',
            `  a) as a list: uBO's dashboard (uBO icon -> gear) -> Filter lists -> at the bottom "Import…" -> paste ${url} -> Apply changes. uBO keeps the copy it fetched; refreshes from this URL work only while a personal-mode session serves it.`,
            '  b) or for good, without the URL: uBO\'s dashboard -> My filters -> paste the lines below -> Apply changes.',
            ...shown.map((l) => `     ${l}`),
            ...(lines.length > shown.length ? [`     … ${lines.length - shown.length} more (the file has all of them; for many lines, (a) is easier)`] : []),
          ].join('\n'),
          changes: [{ kind: 'promote', path: f.rel, after: { url } }],
        };
      }

      const name = metaName(f.src) ?? path.basename(f.abs);
      const urlPath = `/promote/${encodeURIComponent(path.basename(f.abs))}`;
      srv.promoted.set(urlPath, { file: f.abs, type: a.kind === 'userscript' ? 'text/javascript; charset=utf-8' : 'text/css; charset=utf-8' });
      const url = srv.origin + urlPath;
      const who = a.kind === 'userscript' ? 'the userscript manager (Violentmonkey, Tampermonkey, …)' : 'Stylus';

      await b.context(); // Claude's window with at least one tab, so closing the install tab never closes the window
      const before = new Set((await tops(b)).map((c) => c.context));
      const tab = await b.createTab();
      const context = await b.context(tab);
      b.handoff = { reason: `promote: the user is confirming "${name}" in ${who}'s install page`, tab, since: Date.now() };
      const t0 = Date.now();
      let page: string | null = null, pageUrl = '', installUrl = '', outcome: 'closed' | 'moved' | 'timeout' = 'timeout';
      try {
        // the user has to click in the extension's page: show Claude's window on that tab
        if (!b.state.headless) await b.showWindow(context).catch(() => {});
        // the extension aborts the navigation (Violentmonkey: NS_ERROR_ABORT, Stylus: NS_BINDING_ABORTED)
        await b.bidi.send('browsingContext.navigate', { context, url, wait: 'none' }).catch(() => {});
        // Violentmonkey opens its page in a new tab, Stylus turns this tab into it
        let shownAsText = 0;
        while (!page && Date.now() - t0 < 15000) {
          await sleep(300);
          const all = await tops(b);
          const own = all.find((c) => c.context === context);
          const found = (own && isExtPage(own.url) ? own : null) ?? all.find((c) => !before.has(c.context) && c.context !== context && isExtPage(c.url));
          if (found) { page = found.context; pageUrl = found.url; break; }
          // Firefox showing the file itself: nothing caught it
          if (own?.url === url && ++shownAsText > 10) break;
        }
        if (!page) {
          await b.closeTab(tab).catch(() => {});
          fail('NO_INSTALL_PAGE', `${who} did not catch ${url}: no install page opened in the user's Firefox`,
            a.kind === 'userscript' ? 'Is a userscript manager (Violentmonkey) installed and enabled there? Ask the user; Claude cannot list their add-ons in personal mode.'
              : 'Is Stylus installed and enabled in the user\'s Firefox? Ask the user; Claude cannot list their add-ons in personal mode.');
        }
        if (page !== context) {
          await b.bidi.send('browsingContext.activate', { context: page }).catch(() => {});
          await b.closeTab(tab).catch(() => {});
        }
        // wait for the user: the page closes, moves to another extension page, or the time runs out
        installUrl = pageUrl;
        // tests play the user leaving the page (FIREFOX_USE_TEST_PROMOTE: the kinds to do it for) (Claude can close it, never click in it)
        if (process.env.FIREFOX_USE_TEST_PROMOTE?.split(',').includes(a.kind)) setTimeout(() => void b.bidi.send('browsingContext.close', { context: page, promptUnload: false }).catch(() => {}), 1000);
        const startPath = pagePath(pageUrl);
        while (Date.now() - t0 < a.timeout_s * 1000) {
          if (b.dead) fail('PERSONAL_CLOSED', 'the user\'s Firefox closed while the install page was open');
          const c = (await tops(b)).find((x) => x.context === page);
          if (!c) { outcome = 'closed'; break; }
          if (pagePath(c.url) !== startPath) { outcome = 'moved'; pageUrl = c.url; break; }
          await sleep(500);
        }
      } finally {
        b.handoff = null;
        if (outcome !== 'timeout') await b.afterHandback().catch(() => {});
      }
      const s = Math.round((Date.now() - t0) / 1000);
      const ext = a.kind === 'userscript' ? (managerName(installUrl) ?? 'the userscript manager') : 'Stylus';
      const lines = [
        outcome === 'closed' ? `${ext}'s install page for "${name}" was closed after ${s} s. Whether the user clicked Install (or Update) or cancelled is not visible at page level: ask them, or check the script's effect on a page it matches.`
          : outcome === 'moved' ? `${ext}'s install page for "${name}" moved on after ${s} s, to ${pageUrl} (${a.kind === 'userstyle' ? 'Stylus shows a style\'s own page after installing it' : 'the manager\'s own page'}); ask the user whether it installed.`
            : `${ext}'s install page for "${name}" is still open after ${s} s, in Claude's window: the user can still confirm there and close the tab. Ask them in chat (call promote again for a fresh page if they closed it without installing).`,
        `Served from ${url} (this session's local server, only the promoted files). The extension may keep that URL for update checks; they fail harmlessly when no personal-mode session serves it. To ship a new version, promote again (${a.kind === 'userscript' ? 'Violentmonkey shows the diff' : 'Stylus offers the update'}).`,
      ];
      return { text: lines.join('\n'), target: { tab, url }, changes: [{ kind: 'promote', path: f.rel, after: { url, outcome } }] };
    },
  }),
];

/** "Violentmonkey" when the install page is its confirm page */
function managerName(u: string): string | null {
  return /\/confirm\/index\.html/.test(u) ? 'Violentmonkey' : null;
}
