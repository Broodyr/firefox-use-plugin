---
name: userscript-loop
description: Develop, install, run, debug and sync userscripts with Violentmonkey in the claude-dev Firefox profile - write scripts/*.user.js, iterate fast with the companion's userScripts runner, verify on the page, read the script's own logs and GM values, then install for real through Violentmonkey and keep the file and Violentmonkey in two-way sync. Load together with firefox-basics whenever a task involves a userscript.
---

# Userscript loop

The workspace file `scripts/<name>.user.js` is the **source of truth**. Violentmonkey (manager mode) and the companion's userScripts runner (fast mode) are install targets.

Full tool names: `mcp__plugin_firefox-use_firefox__<tool>`. Load these in one search:

| Job | Tools |
|---|---|
| Install / re-push | `us_write(action: "install")`, `us_write(action: "update")` |
| See what's installed | `us_read(kind: "list")`, `us_read(kind: "sync_status")` |
| Check the effect | `verify`, `navigate`, `eval`, `screenshot` |
| The script's own output | `us_read(kind: "logs")`, `console_read`, `console_read(kind: "errors")` |
| GM storage | `us_read(kind: "values")`, `us_write(action: "values_set")` |
| Network (GM_xmlhttpRequest) | `network_read`, `network_read(kind: "body")` |
| Toggle / remove | `us_write(action: "enable" | "disable")`, `us_write(action: "uninstall")` |
| Sync with Violentmonkey's editor | `us_read(kind: "sync_status")`, `us_write(action: "sync")` |
| Compare with / copy from the user's main profile | `us_read(kind: "main_diff") / us_write(action: "sync_main")` |
| Options | `us_write(action: "dev_prelude")`, `us_write(action: "fast_gm")` |
| Approval, rollback | `scope_set`, `undo`, `ff_read(kind: "snapshot_diff")` |
| Into the user's own Firefox (when they ask; personal mode) | `promote(kind: "userscript", path)`: their Violentmonkey shows its install page, they click Install |

## Timing you can rely on

- `verify` waits (up to 3 s) for dev userscripts that started on the same URL at the previous `verify`, and says plainly when one did not start this time (disabled, @match, failed install) instead of only failing checks.
- Fast mode bakes GM values into the registration; `navigate` / `verify` apply pending value changes before loading, and `us_read(kind: "values")` reads until the store is stable (writes arrive asynchronously).

## The loop

1. **Scope, once.** Manager-mode installs change Violentmonkey, so call `scope_set` with a concrete description, e.g. "install and update my userscript in Violentmonkey (claude-dev) for this task", and areas `["ext:vm"]` (add `"ext:ubo"` if uBO filters are involved). Fast mode needs no scope.
2. **Write the file** in `scripts/`, with a full metadata block: `@name`, `@namespace`, `@match` / `@include`, `@grant`, `@run-at`, `@version`.
   - Throwaway probe scripts (not part of the user's project) go in `.firefox-use/scratch/`: it is inside the workspace, so `us_write(action: "install")` accepts it, and git-ignored. Files outside the workspace (e.g. your scratchpad folder) are refused.
3. **Iterate fast.** `us_write(action: "install", path, mode: "fast")`, then `verify(url, checks)`. After each edit: `us_write(action: "update", path)`, then `verify(checks)`, which reloads the current page.
   - Fast mode registers through the companion's userScripts API (USER_SCRIPT world) in well under a second. GM_* are stubs: `us_write(action: "fast_gm", stubs: "persisted")` (default) keeps values and really fetches; `"recorded"` only logs the calls (see them with `us_write(action: "fast_gm")` without stubs).
   - Line numbers in fast-mode errors are the file's own (`claude-fast/<name>.user.js:LINE`).
   - Fast mode ignores `@require` / `@resource` and regex `@include`, and `@inject-into page` loses the GM stubs. Use manager mode for those.
4. **Install for real.** `us_write(action: "install", path)` (manager mode, the default) installs through Violentmonkey's own `ParseScript`, so metadata, `@require` / `@resource` and GM_* behave exactly as in production. Run `verify` again.
5. **Debug.**
   - `verify` reports failed checks, every new error with its stack, userscript activity and uBO activity.
   - `us_read(kind: "logs", script)` shows just this script: its console output, errors, Violentmonkey's complaints about it (such as failed `@require`), and `__claude.mark()` timings. Entries arrive late right after a reload, so it waits until none has come for `settle_ms` (default 800) and notes entries that arrived during the wait; a missing log line is not proof the code didn't run until that wait is over.
   - Evaluate in the script's realm with `eval(code, realm: {kind: "content", extension: "vm"})`. That is Violentmonkey's content sandbox, where `@inject-into content` scripts run; for page-mode scripts use `{kind: "page"}`.
   - `inspect_xray` explains why something is "defined on the page, undefined in my script".
6. **Finish.** `us_read(kind: "sync_status")` should say `synced`. Report what changed (the audit log has every step, and the scope checkpoint is the rollback point).

## Gotchas (measured, not guessed)

- **Violentmonkey's matcher is strict about ports.** `@match http://127.0.0.1/*` does NOT match `http://127.0.0.1:8080/…`. Use `@match http://127.0.0.1:8080/*` or `@include http://127.0.0.1*`. `us_write(action: "install")` warns. Fast mode uses WebExtension patterns, which have no ports: it drops the port (the script then runs on every port of that host) and says so.
- **Stack lines are mapped to the file.** `console_read`, `console_read(kind: "errors")`, `us_read(kind: "logs")` and `verify` show Violentmonkey positions as `scripts/x.user.js:9:9` (Violentmonkey shifts a script by the lines of its `@require`s; the one-line prelude shifts nothing). One exception: an uncaught error in the script's **top-level code** (not inside a function) is reported at Violentmonkey's wrapper, so it reads `scripts/x.user.js (top-level code, line not reported)`. To get the line, reproduce it in fast mode (exact lines), or wrap the code in a function. Fast mode is exact as well.
- **Look inside the script:** `eval(code, realm: {kind: "userscript", script: "<file|name>"})` runs in the script's own scope (its top-level variables and functions), in any injection mode. Synchronous only. Needs the dev prelude (its eval hook, with a per-install secret so pages can't use it).
- **Breakpoints:** load the debugging skill. `bp_set({script, line})` takes file lines; manager mode only (Firefox hides fast-mode sources from the debugger).
- **The dev prelude** (default on; `us_write(action: "dev_prelude", false)` turns it off) adds `__claude.mark(label)` and `__claude.ready()`, the eval hook, and labels `GM_xmlhttpRequest` calls for `network_read`. It is joined onto one line after the metadata (after a leading `'use strict'`), so it shifts no lines, and it is never written to the file.
- **Two-way sync.**
  - While scripts are linked, edits made in Violentmonkey's editor are **pulled into the file automatically** (only if the file itself is unchanged).
  - File edits are pushed with `us_write(action: "update")` / `us_write(action: "sync") push`.
  - If both changed, Violentmonkey's version is saved as `<file>.vm-conflict` and **nothing is overwritten**. Merge by hand, then `us_write(action: "update")`.
- `us_write(action: "uninstall")` moves a Violentmonkey script to its recycle bin; `undo` brings it back. GM values: `us_write(action: "values_set")` (undo-able).
- **One copy at a time.** claude-dev's Violentmonkey usually already has the user's own copy of the script you're developing (copied from their main profile). `us_write(action: "install")` / `us_write(action: "update")` find other installed scripts with the same name (any namespace; a trailing `(dev)` or version is ignored) and **disable them while your dev copy is installed** (needs scope `ext:vm`; without it the call fails with `SHADOWED_SCRIPT` naming the other copy, so two copies never run unnoticed and double the effect on the page). They come back on `us_write(action: "uninstall")` of the dev copy, on `ff_quit` (fast mode) and at the next launch after a crash. `us_read(kind: "list")` shows them as `[disabled: shadowed by …]`. `shadow: "keep"` runs both, with a warning. In manager mode a script with the same name **and** namespace is updated in place; the result names the version it replaced.
- **Drift from the main profile.** claude-dev's userscripts are a one-time copy of the main profile's, so they go stale. Each launch compares them (read-only, from a copy of the main profile's storage) and the launch notes / `ff_status` list differences; `us_read(kind: "list")` shows `(main: <version>)`. `us_read(kind: "main_diff") / us_write(action: "sync_main")` compares again; `us_read(kind: "main_diff") / us_write(action: "sync_main")(script)` shows the diff; `us_read(kind: "main_diff") / us_write(action: "sync_main")(script, apply: true[, values: true])` copies the main profile's version (and GM values) into claude-dev (scope `ext:vm`, undo-able). It refuses a script linked to a workspace file (`LINKED_TO_WORKSPACE`): work in progress is never overwritten. Never edit the main profile.
- Violentmonkey values are stored with a type prefix (`s`, `n`, `b`, `o`). The `us_read(kind: "values")*` tools decode and encode it, so don't write `val:<id>` storage directly.
- Don't use `ext_write(action: "storage_set")` on Violentmonkey: its background keeps the script list in memory. Always go through `us_*`.
