import { z } from 'zod';
import { tool, tabArg } from './registry.js';
import { checkUrl } from './page.js';

export const tabTools = [
  tool({
    name: 'tabs_list',
    description: 'List the agent tabs (the "Claude" tab group in the agent window). The user\'s own tabs are listed only with include_user, and may be used only when the user names them.',
    args: { include_user: z.boolean().default(false) },
    async handler(a, ctx) {
      const b = await ctx.browser();
      const tabs = await b.listTabs(a.include_user);
      return tabs.map((t) => `${t.current ? '*' : ' '} tab ${t.tab}${t.agent ? '' : ' [USER TAB]'}: ${JSON.stringify(t.title.slice(0, 80))} ${t.url}`).join('\n') || 'no tabs';
    },
  }),
  tool({
    name: 'tabs_create',
    description: 'Open a new background tab in the agent tab group (never takes focus) and make it current.',
    args: { url: z.string().optional() },
    write: true,
    async handler(a, ctx) {
      const b = await ctx.browser();
      if (a.url) checkUrl(a.url);
      const tab = await b.createTab(a.url);
      b.cur = tab;
      b.save();
      return { text: `tab ${tab} created${a.url ? ` at ${a.url}` : ''} (now current)`, target: { tab, url: a.url } };
    },
  }),
  tool({
    name: 'tabs_close',
    description: 'Close an agent tab. The last agent tab is blanked instead of closed.',
    args: { tab: z.number().int().positive() },
    write: true,
    async handler(a, ctx) {
      const b = await ctx.browser();
      return `tab ${a.tab}: ${await b.closeTab(a.tab)}`;
    },
  }),
  tool({
    name: 'tabs_select',
    description: 'Make a tab the current one for later calls (selects it inside the off-screen agent window; no focus change).',
    args: { tab: tabArg.unwrap() },
    write: true,
    async handler(a, ctx) {
      const b = await ctx.browser();
      await b.selectTab(a.tab);
      return `current tab: ${a.tab}`;
    },
  }),
];
