# firefox-use

A Claude Code plugin that gives Claude deep control of Firefox, for developing and debugging userscripts and browser extensions. It drives a dedicated Firefox profile, and goes past page automation: privileged browser access, extension internals, Violentmonkey, Stylus and uBlock Origin workflows, and a real debugger.

Unofficial: not affiliated with Anthropic or Mozilla.

> **Windows only for now.** Process handling, window management and the setup scripts use Windows APIs and PowerShell. Pull requests adding macOS or Linux support are welcome.

## Install

You need Windows 10 or 11, Firefox (the current release), Node.js 22.13 or later on `PATH`, and Claude Code. For the userscript, userstyle and uBlock Origin workflows, also Violentmonkey, Stylus and uBlock Origin in your own Firefox: setup offers to copy them into the plugin's profile (or you install them there by hand).

1. In Claude Code, add this repository's marketplace and install the plugin:

   ```
   /plugin marketplace add Broodyr/firefox-use-plugin
   /plugin install firefox-use@broodyr
   ```

   Then run `/reload-plugins`, or start a new session.

2. Run the setup script once, in PowerShell. Claude can't run it for you, because it changes browser security settings. To get the exact command, ask Claude to open any page in Firefox: the first call fails with the command, including the script's path in your plugin folder. It looks like this:

   ```
   powershell -ExecutionPolicy Bypass -File "%USERPROFILE%\.claude\plugins\cache\broodyr\firefox-use\<version>\setup\setup.ps1"
   ```

   Setup:
   - creates a Firefox profile named `claude-dev` under `%LOCALAPPDATA%\firefox-use\profiles\`;
   - writes its `user.js`: remote debugging and devtools on, add-on auto-updates off, downloads into a sandbox folder, no saved logins;
   - offers to copy uBlock Origin, Violentmonkey and Stylus from your main profile, and keeps them at your versions at each launch;
   - writes a session token (the kill switch revokes it) and a config file.

   Your own Firefox profile is only read, never changed.

3. Ask Claude to do something in Firefox. No restart is needed after setup.

4. Optional, fewer prompts: in Claude Code's default permission mode, every tool asks the first time, browsing included. To allow browsing and reading without prompts (privileged code, `eval` and lasting changes still ask), add this to `~/.claude/settings.json`:

   ```json
   {
     "permissions": {
       "allow": [
         "mcp__plugin_firefox-use_firefox__*_read",
         "mcp__plugin_firefox-use_firefox__navigate",
         "mcp__plugin_firefox-use_firefox__tabs",
         "mcp__plugin_firefox-use_firefox__read_page",
         "mcp__plugin_firefox-use_firefox__find",
         "mcp__plugin_firefox-use_firefox__get_page_text",
         "mcp__plugin_firefox-use_firefox__screenshot",
         "mcp__plugin_firefox-use_firefox__click",
         "mcp__plugin_firefox-use_firefox__type",
         "mcp__plugin_firefox-use_firefox__key",
         "mcp__plugin_firefox-use_firefox__hover",
         "mcp__plugin_firefox-use_firefox__scroll",
         "mcp__plugin_firefox-use_firefox__scroll_to",
         "mcp__plugin_firefox-use_firefox__form_input",
         "mcp__plugin_firefox-use_firefox__wait_for",
         "mcp__plugin_firefox-use_firefox__batch",
         "mcp__plugin_firefox-use_firefox__ff_status"
       ]
     }
   }
   ```

   Allowing `batch` is safe with the rest of this list: a batch step beyond these still asks on its own (see Safety).

**Updates.** Claude Code doesn't auto-update plugins from third-party marketplaces unless you turn that on for the marketplace in `/plugin` (Marketplaces). Otherwise, update with `claude plugin update firefox-use@broodyr` and restart the session.

## What it does

- **Browsing at Claude-in-Chrome level**: tabs, accessibility-tree reading with element refs, trusted mouse and keyboard input, screenshots, forms, waits, dialogs, downloads, file uploads.
- **Privileged access**: prefs, add-ons, any extension's storage, the Browser Console, managed storage, site storage (cookies, localStorage, IndexedDB, service workers).
- **Extension internals**: read any installed extension's source, drive it through its own messaging, evaluate code in its background, pages and content scripts, log the messages between them.
- **Extension development**: load a local folder as a temporary add-on that hot-reloads on save, lint, build and sign with `web-ext`.
- **Userscripts (Violentmonkey)**: a sub-second iteration loop, install for real, two-way sync between workspace files and Violentmonkey's editor, evaluation inside a script's own scope, the script's own logs and `GM_*` values.
- **Userstyles (Stylus)**: workspace `.user.css` files installed through Stylus itself (preprocessors and variables as in production), open tabs restyled live, a watch mode that pushes every save, which styles apply to a page and why, two-way sync with Stylus's editor.
- **uBlock Origin**: My filters, advanced settings, user scriptlets served from your workspace, filter testing without saving, the logger.
- **Debugger**: breakpoints, logpoints, event and DOM-mutation breakpoints, pause on exceptions, stepping and evaluation in a paused frame, for page scripts, content scripts, userscripts and workers.
- **Timing**: one ordered load timeline of page scripts, userscripts and extension scripts; pausing before the first page script runs.
- **Network**: every request including extension-made ones, mocking, HAR record and replay, CSP analysis.
- **Tests**: regression tests that run headless in throwaway copies of the profile against recorded traffic; bisecting which extension, userscript, pref or storage key breaks a page; performance profiles and before/after script cost.
- **Safety net**: an approval per task for lasting changes, masking of secrets in all output, an audit log, snapshots with rollback, and a kill switch.

If you only need page automation, Mozilla's [firefox-devtools-mcp](https://github.com/mozilla/firefox-devtools-mcp) is simpler to set up. This plugin is for working on what runs inside the browser.

**Userscripts: Violentmonkey only.** Tampermonkey isn't supported. It's closed source, so the internals the userscript tools rely on (how it installs, stores and runs scripts) can't be read, and would break unnoticed with its updates. Violentmonkey is open source, and the tools detect its internals as they use them, so an update that changes one fails with a clear error instead of misbehaving.

## Using it

Ask in plain words. The plugin's skills tell Claude how to work, and load when a task needs them. For example:

- "Open example.com in Firefox and tell me what its cookie banner does to the page."
- "Write a userscript that hides the sidebar on this site, install it in Violentmonkey and check that it works."
- "This page breaks with my extensions on. Find out which one."
- "My extension's content script can't see the page's `config` object. Find out why."
- "Write a uBlock Origin scriptlet that stops this site's scroll lock, and test it."
- "Make a userstyle that gives this site a dark sidebar, and keep it live while we tweak it."

The browser runs in its own window, parked off-screen so it never takes focus. For a login, CAPTCHA or 2FA, Claude hands the window to you and waits; it never types credentials.

**Personal mode** (optional): when you ask, Claude can also drive your own Firefox, at page level only: no privileged access, extension internals or debugger. It needs a one-time `setup\personal-mode.ps1`, which also adds a "Firefox (Claude can browse)" shortcut.

## Safety

- **A separate profile.** Everything runs in `claude-dev`, which has no saved passwords and no sync account. Your main profile is never automated, except in personal mode.
- **Approval for lasting changes.** Before the first change that lasts (prefs, extension state, userscripts, filters, site data), Claude asks once, with a concrete scope: approve for the task, for the rest of the session, or decline. Reading, browsing and clicking need no approval.
- **Permission checks for what a call runs.** Claude Code asks for a tool by its name. A few tools run other tools or privileged code: `batch` and `test_record` run tool steps, `bisect` runs test steps, and `eval`, `wait_for` and `verify` can run code in the privileged realm. A hook checks each of those against your permission rules first, and Claude Code asks once, naming only the steps your rules don't pre-approve; when they all are, there's no prompt. A deny rule for any of them blocks the call. Page actions (navigate, click, type, ...) and reads inside a batch are covered by approving the batch itself; `eval` and `verify` run code, so they need their own approval there too.
- **Masking.** Cookie values, auth headers, tokens and password values are masked in every result, and password fields are blacked out in screenshots.
- **Audit and rollback.** Every call is logged to `.firefox-use/audit/` in your project, with before/after diffs for changes; snapshots and `undo` roll changes back.
- **Kill switch.** The `ff_kill` tool, `setup\kill.ps1` from any terminal, or `node server\dist\cli.js kill` in the plugin folder: revokes the token, closes every connection and kills the dev profile's Firefox.

What to keep in mind:

- **Privileged code has your reach.** `eval_privileged` (and `eval` in the privileged realm, which is checked the same way) runs JavaScript inside Firefox's own chrome, which can read and write files and start programs as you. Approve it the way you would approve a shell command.
- **Logins persist.** A site you log into in `claude-dev` stays logged in there. Don't sign it into accounts you wouldn't hand to an agent.
- **Local ports.** While `claude-dev` runs, it listens on local ports (WebDriver BiDi and the devtools server, 127.0.0.1 only) that other programs running as you can connect to.

## Development

This section is for working on the plugin itself.

```
git clone https://github.com/Broodyr/firefox-use-plugin
cd firefox-use-plugin
powershell -ExecutionPolicy Bypass -File setup\setup.ps1
```

In a source checkout, setup also installs the dependencies and builds the server if needed, and adds the checkout to `CLAUDE_CODE_PLUGIN_DIRS` in your user environment (the variable form of `--plugin-dir`). Claude Code then loads the plugin from the checkout in place, as `firefox-use@inline`, ahead of an installed copy, so a rebuild reaches running sessions. Restart Claude Code once afterwards; re-run setup if you move the checkout. Then:

- `npm run build` rebuilds the server; running sessions hot-reload it without reconnecting.
- `npm run harness -- call <tool> '<json>'` calls one tool against a throwaway headless profile.
- `npm run test:core` runs the fast integration suite; `npm run test:integration` runs all of it.
- `npm run release` builds the release tree in `.release-build/` (the server bundled with esbuild, no `node_modules` needed); `npm run test:release` also runs the core suite against it.

**Tests.** The integration suites run headless, in throwaway copies of a clean template profile, so they don't need setup or your claude-dev profile. They need Node 22.18 or later (the test files are TypeScript that Node runs directly), Firefox, and uBlock Origin and Violentmonkey for the template:

- If you ran setup and it copied them from your Firefox, the tests use those (the versions you run).
- Otherwise run `npm run test:setup` once: it puts the versions pinned in `dev/harness/test-addons.json` into `dev/harness/.test-addons/`, from a local copy with the same SHA-256 when there is one, else downloaded from addons.mozilla.org and checked against the pin. `npm run test:setup -- --latest` moves the pins to AMO's current versions.

A runner that's missing something says what, and how to get it, before starting. CI (`.github/workflows/test.yml`) runs the same way on a clean Windows runner: `test:setup`, then the core suite against the source build and the release bundle. `npm run test:live` is the exception: it checks your real claude-dev profile (read-only steps, nothing lasting), so it needs setup.

**Releasing.** The marketplace installs the `release` branch, and Claude Code only updates an installed plugin when its version changes. So every release bumps `version` in `package.json` (patch for fixes, minor for features, major for changes that break existing setups or tool calls). Commit, then:

```
npm run release -- --commit
git push origin release v<version>
```

`--commit` puts the release tree on the `release` branch as one commit, tagged `v<version>`. It refuses uncommitted changes and a version that isn't newer than the last release.

## License

MIT. The release bundle includes third-party packages; their licenses are in `THIRD_PARTY_LICENSES.md` in the release tree.
