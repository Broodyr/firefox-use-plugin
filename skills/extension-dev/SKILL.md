---
name: extension-dev
description: Develop a browser extension from a local folder in the claude-dev Firefox profile - load it as a temporary add-on that hot-reloads on every file save, see manifest and startup errors per reload, lint it (Firefox's own manifest validation plus addons-linter), inspect its realms, permissions, storage and the messages between its background, pages and content scripts, debug it, verify it on pages, and package / sign it for AMO. Load together with firefox-basics when the task is to write or fix an extension (not just change an installed one: that is extension-internals).
---

# Extension development

Full tool names: `mcp__plugin_firefox-use_firefox__<tool>`. Load these in one search:

| Job | Tools |
|---|---|
| Load, hot reload | `ext_dev_load` |
| Check | `ext_dev_lint`, `ext_dev_inspect` |
| Package, sign | `ext_dev_build`, `ext_dev_sign` |
| Run code in its contexts | `eval` (realm `{kind:"extension", extension, page?}` or `{kind:"content", extension}`), `realms_list`, `ext_write(action: "message")`, `ext_write(action: "page_open")` |
| Its storage | `ext_read(kind: "storage")`, `ext_write(action: "storage_set")` |
| Errors and logs | `console_read`, `console_read(kind: "errors")` |
| Debug | `bp_set({url: "bg.js", extension: "<id>", line})`, `debugger_state`, `trace_load` (see the debugging skill) |
| Verify on a page | `navigate`, `verify`, `screenshot` |

## The loop

1. **Scope once:** `scope_set` with areas `["addons"]` (loading a temporary add-on), e.g. "load and reload my extension from ./ext in claude-dev for this task". Add `ext:<id>` if you will write its storage or send it messages.
2. **Lint first:** `ext_dev_lint("ext")`. "Firefox: REFUSES the manifest" lists what blocks a load; warnings are what Firefox ignores. addons-linter (AMO rules: unsafe innerHTML, deprecated APIs, ...) runs too.
3. **Load:** `ext_dev_load("ext")` installs it temporarily (gone at the next restart) and **reloads it whenever a file in the folder changes**. Startup errors of the background come back in the result.
4. **Edit, then check:** after saving, `ext_dev_inspect(id)` shows the reload history (`reloaded` / `FAILED` with the errors). An invalid manifest is not loaded: the previous version keeps running and the entry says so. Calling `ext_dev_load` again reloads at once.
5. **Content scripts:** a reload does not replace content scripts already injected into open pages. Reload the page (`navigate("reload")` or `verify`) after each change.
6. **Messaging:** `ext_dev_inspect(id, messages: "on")`, exercise the extension, then `ext_dev_inspect(id)` again: every `runtime.sendMessage` / `tabs.sendMessage` with its response (or error, e.g. "Receiving end does not exist"), `runtime.connect` and port messages, with sender and receiver. `messages: "off"` stops it.
7. **Debug:** breakpoints in the background (`{url: "bg.js", extension: id}`) or a content script (`{url: "cs.js", extension: id}`); `trace_load` shows when its content scripts run against the page's own scripts.

## Gotchas

- A temporary add-on needs an id for stable storage across reloads: set `browser_specific_settings.gecko.id` in the manifest.
- `background.service_worker` add-ons are refused by Firefox 157 unless enabled by a pref; use `background.scripts` (event page) for MV3 in Firefox.
- The messaging log covers extension messaging only (not `window.postMessage` between page and content script).

## Shipping

- `ext_dev_build("ext")` writes `.firefox-use/artifacts/ext-builds/<name>-<version>.zip` (web-ext build: node_modules, dotfiles and earlier builds left out) and reports addons-linter's counts.
- `ext_dev_sign("ext", channel)` submits to addons.mozilla.org. `unlisted` (default) = signed .xpi for self-distribution; `listed` = **published** after review. It asks the user every time (dialog, or `user_said` quoting their OK for this submission) and uses AMO keys the user set as `WEB_EXT_API_KEY` / `WEB_EXT_API_SECRET` for Claude Code (`KEYS_MISSING` otherwise: tell them how; never ask for the keys or write them anywhere). AMO rejects a version number it has seen before: bump `version` first.
