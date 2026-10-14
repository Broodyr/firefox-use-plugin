---
name: extension-internals
description: Work with ANY Firefox extension in the claude-dev profile without a dedicated adapter (Dark Reader, Redirector, a password-free settings extension, the user's own extension, ...) - read its source with ext_read(kind: "source"), find how its own pages talk to its background, drive it through those commands (ext_write(action: "message") / eval in its realms) instead of raw storage, verify, roll back, and keep what you learned as a recipe. Load with firefox-basics when a task touches an extension other than Violentmonkey (userscript-loop), Stylus (userstyle-loop) or uBlock Origin (ubo-resources-loop).
---

# Working with any extension

Dedicated adapters exist only for Violentmonkey (`us_*`) and uBlock Origin (`ubo_*`). Everything else is reached with generic tools. They are enough, if you first learn how the extension works internally.

Full tool names: `mcp__plugin_firefox-use_firefox__<tool>`. Load these in one search:

| Job | Tools |
|---|---|
| Find it | `ext_read(kind: "addons")` (id, version, internal UUID, background type, options page) |
| Read its source | `ext_read(kind: "source")` (file list / one file / grep across files) |
| Its state | `ext_read(kind: "storage")` (local, sync, session, managed) |
| Run code in it | `eval` with realm `{kind:"extension", extension, page?}` (background or a page), `{kind:"content", extension}` (its content script in a tab) |
| Talk to it like its own UI | `ext_write(action: "message")` (runtime.sendMessage from one of its pages) |
| Open its pages | `ext_write(action: "page_open")` |
| Watch it | `console_read` (realm `extension:<name>`, `content:<name>`), `network_read` (initiator `ext:<name>`) |
| Change it | `ext_write(action: "storage_set")` / `ext_write(action: "storage_remove")` (only when storage is the API, see below), `ext_write(action: "reload")`, `ext_write(action: "enable" | "disable")` |
| Local builds | `ext_write(action: "install_local")` (temporary add-on from a folder or .xpi in the workspace) |
| Safety net | `scope_set` (area `ext:<id>`), `ff_write(action: "snapshot")`, `ff_read(kind: "snapshot_diff")`, `undo`, `restore` |

## Method

1. **Check for a recipe first:** `.firefox-use/recipes/<extension>.md` in the workspace, then `recipes/` next to this skill. Re-check any recipe against the installed version (`ext_read(kind: "addons")`) before trusting it.
2. **Find out what the extension is.** `ext_read(kind: "addons", detail:"normal")` gives the background type and options page. `ext_read(kind: "source", ext, path:"manifest.json")` gives permissions, background scripts, content scripts and pages.
3. **Find how its UI talks to its background.** Grep for message handlers and see what the options page sends:
   - `ext_read(kind: "source", ext, grep: "runtime\\.onMessage|onConnect|sendMessage|postMessage")`
   - `ext_read(kind: "source", ext, grep: "<a setting or command name you saw in its UI>")`

   Minified code is one long line. Use grep `context`, or `path` with `offset`/`length`.
4. **Decide where to act. This is the key judgement:**
   - **If the background keeps the state in memory** (most extensions with a real background: Violentmonkey's script list, uBO's filters), a raw `ext_write(action: "storage_set")` is NOT picked up until a reload, and may be overwritten. Use its own commands: `ext_write(action: "message", ext, {…}, writes:false)` for reads, `writes:true` (needs scope) for changes. This is exactly what its options page does, sent from a frame with the extension's own origin.
   - **If it reads storage on demand or listens to `storage.onChanged`**, storage *is* the API: `ext_write(action: "storage_set")` fires `onChanged` like the extension's own writes.
   - **For anything else**, `eval` in its background realm can call its internal functions directly. That's powerful but brittle, so prefer messages.
5. **Probe read-only first:** `ext_write(action: "message", ..., writes:false)` and `eval` that only reads. Confirm the shape of replies before writing.
6. **Scope, then change.** Call `scope_set` with area `ext:<id>` and a concrete description. Make the change, then **verify through the extension itself** (its page via `ext_write(action: "page_open")` + `eval`, its effect on a site via `verify`, its storage), not just "no error".
7. **Roll back** with `undo` (storage writes are undo-able) or `restore(ff_write(action: "snapshot"), ["ext_storage:<id>"])`. Extensions holding state in memory are reloaded by restore.
8. **Write the recipe** (below), so the next task starts at step 4.

## Recipe format

Save to `.firefox-use/recipes/<short-name>.md` in the workspace. Copying it next to this skill, so every project shares it, means writing into the plugin's folder: ask the user first.

```markdown
# <Extension name> <version checked> (<id>)
- Background: <event page / persistent / none>; state in memory: <yes/no>
- Read <thing>: ext_write(action: "message") {…}  → reply shape
- Change <thing>: ext_write(action: "message") {…} (scope ext:<id>); takes effect: <immediately / after reload / on next page load>
- Storage keys: <key>: <meaning> (write directly? yes/no, why)
- Gotchas: <measured quirks>
```

## Notes

- `ext_write(action: "message")` sends from a helper frame inside the background document, or from one of its pages when there's no background document. Replies are masked like all output; `unmask` reveals named keys.
- Content scripts: `realms_list(tab)` shows which extensions have one in the page. `eval` there runs in its sandbox, and Xray rules apply (`inspect_xray`).
- Never install add-ons from the web. Local builds only, via `ext_write(action: "install_local")`.
- Extensions handling credentials (password managers) don't belong in claude-dev, and privileged code touching logins is refused.
