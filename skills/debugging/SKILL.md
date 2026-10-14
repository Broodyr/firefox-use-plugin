---
name: debugging
description: Debug JavaScript in the claude-dev Firefox profile with a real debugger - breakpoints (line, conditional, logpoint, function, event, DOM mutation), pause on exceptions, paused state with scopes, stepping, evaluation in a paused frame, evaluation inside a userscript's own scope, and Xray/realm mix-ups. Works for page scripts, workers (dedicated, shared, service), content scripts, extension backgrounds/pages and Violentmonkey userscripts (lines of the file on disk). Load together with firefox-basics when a bug needs more than console output.
---

# Debugging

Full tool names: `mcp__plugin_firefox-use_firefox__<tool>`. Load these in one search:

| Job | Tools |
|---|---|
| Breakpoints | `bp_set`, `bp_list`, `bp_remove`, `pause_on_exceptions`, `dom_breakpoint` |
| While paused | `debugger_state`, `eval_paused`, `step`, `resume` |
| Evaluate anywhere (not paused) | `eval` (realms: page, content, extension, userscript, worker), `realms_list`, `inspect_xray` |
| Errors and logs | `console_read`, `console_read(kind: "errors")`, `us_read(kind: "logs")` |
| Timing / load order | `trace_load`, `pause_at_start`, `spa_watch`, `resource_latency` |
| Slow pages | `perf_script_cost`, `perf_profile`, `perf_memory` |
| Fake the network | `network_write(action: "mock")`, `network_write(action: "har_replay")` (see firefox-basics) |
| Trigger and check | `navigate`, `click`, `verify`, `eval` |

## Pick the cheapest tool first

1. **Errors with stacks**: `console_read(kind: "errors")`, `console_read(level: "error", detail: "normal")`. Violentmonkey positions are already mapped to file lines (`scripts/x.user.js:9:9`).
2. **A value at a point in time**: a logpoint, `bp_set({url, line}, log_message: "'x', x")`. It logs to `console_read` as `[logpoint bpN] x …` and never pauses.
3. **Inspect state now**: `eval` in the right realm. For a userscript, `realm: {kind: "userscript", script}` evaluates **inside the script's own scope** (its top-level `const`s and functions), whatever its injection mode (Violentmonkey content or page, fast mode). It needs the dev prelude (default on) and the script to have run in this document; it is synchronous (no await).
4. **Walk through code**: a breakpoint, then `debugger_state` / `step` / `eval_paused`.

## Slow pages

- **`perf_script_cost(url?)`** reloads (or loads) the page under the Firefox Profiler and lists, per script (page inline, page files, each extension's content scripts, each userscript): self and total main-thread time, MutationObserver callback time / runs, layout or style flushes it forced (`offsetHeight`, `getComputedStyle` after a DOM change) and long tasks (>= 50 ms) with who ran in them. 0.5 ms samples: compare scripts, don't trust single milliseconds.
- **Did a change make it faster?** `perf_script_cost(runs: 5, save_as: "before")`, make the change, then `perf_script_cost(runs: 5, compare_to: "before")`: per script, median self/total before -> after with the change in ms and %, NEW/GONE scripts, and each side's spread (a difference smaller than the spreads is noise).
- **`perf_profile(action: "start")` … `"stop"`** around any interaction: summary by origin and top functions, plus a `.json.gz` to open at profiler.firefox.com for flame graphs.
- **`perf_memory`**: the tab's window (page JS, DOM, layout) and each extension's content scripts in it.

## Load order and races

- **`trace_load(url, watch: [".banner"])`** answers "what ran when": every script execution in order (page inline/external, extension content scripts, userscripts with their workspace file), `DOMContentLoaded`/`load`, script elements inserted, when each watched selector first matched, `__claude.mark` markers, console and network, all in ms from navigation start. Nothing is paused, so the trace doesn't change the race. Measured: Violentmonkey's content-mode `document-start` scripts run *after* the page's first inline script.
- **`pause_at_start(url)`**: stops at the first script of the page (or a document-start userscript) before anything else of the page runs; set breakpoints, then `resume`. Other extensions' content scripts are skipped unless `include_extensions`.
- **Make a race reproducible:** `resource_latency("resources/x.js", 800)` delays a file from the local resource server; `network_write(action: "mock", [{url, action: "delay", ms}])` delays a page request.
- **SPA navigations:** `spa_watch(on: true)`, act, `spa_watch()` lists pushState/replaceState/hash changes.

## Breakpoints

- `bp_set({url, line, column?})`: `url` is a full URL or a unique substring of a loaded source (`"app.js"`, `"dbg.html"`). Add `extension: "<id|alias>"` for an extension's file (`{url: "bg.js", extension: "my-ext@x"}`). Without a column, the first breakable position on the line is used; a line with no code moves to the next one (reported).
- `bp_set({script, line})`: a Violentmonkey userscript by workspace file, name or id; `line` is **the line in the file**. The script must have run in a page (its source is loaded); reload to hit top-level code.
- `bp_set({function: "name", realm?})`: breaks at the function's first statement (found by its source text).
- `bp_set({event: "click"})`: any `click` listener; also `DOMContentLoaded`, `setTimeout`, … or full ids (`event.mouse.click`).
- `condition: "n > 100"` pauses only when truthy.
- `dom_breakpoint(ref, "attribute" | "subtree" | "removal")`: pause when that element changes ("something removed my element").
- `pause_on_exceptions("uncaught" | "all" | "none")`.
- A source that isn't loaded yet: pass the full URL; the breakpoint applies when it loads (its top-level code included: the column is worked out from the fetched source).
- **Workers** (dedicated, shared, service): `bp_set({url: "worker.js", line})` like any script; a worker created later stops on its top-level code too. `eval` in `{kind: "worker", url}` when not paused.
- `bp_list(detail: "normal", sources: "<substring>")` shows the loaded source URLs, to find the right one.

## When something pauses

- The tool that triggered it (`click`, `navigate`, `verify`, `eval`, …) returns at once: `PAUSED during click: paused (breakpoint bp1) in work at …`. The call finishes on its own after the page resumes.
- `debugger_state`: reason, location (file lines for userscripts), source around it, the stack (browser-internal frames counted, not listed), and the top frame's variables. `detail: "full"` for more.
- `eval_paused(code, frame?)` sees the frame's locals. `step("over" | "into" | "out")`, `resume`.
- While paused, other page tools still work but say `NOTE: the page is paused`. **A pause auto-resumes after 60 s**, so the page is never left frozen. Don't leave it paused while you think at length; read state, then resume.
- `bp_remove("all")` removes everything and closes the debugger connection (pages run uninstrumented again).

## Limits

- **Fast-mode userscripts can't take breakpoints**: Firefox doesn't show userScripts-API sources to the debugger. Install the script in manager mode with `@inject-into content` while debugging. `eval` with `{kind: "userscript"}` works in fast mode.
- Violentmonkey scripts in content and page mode both take breakpoints (their sources are named `%20<name>.user.js#<id>`).
- Browser chrome code (`chrome://`, `resource://`) is refused: a pause there would freeze the browser.
- A pause stops the whole content process (every tab in it), as in DevTools.
- Breakpoints survive a server hot reload (`npm run build`): the next backend sets line, logpoint, function and event breakpoints and pause-on-exceptions again, with the same ids, and the next result says `debugger: re-applied N breakpoint(s)`. DOM breakpoints can't be carried over (set them again). A Firefox restart (`ff_restart`, a crash) drops them all.

## Realms and Xray (the classic "works on the page, undefined in my script")

- `realms_list` shows every realm of a tab: the page, frames, each extension's content sandbox, workers, extension pages.
- `inspect_xray(expr, realm)` compares the sandbox's Xray view, the waived view (`wrappedJSObject`) and the page. Page expandos (`window.myLib`) are invisible through Xray: in Violentmonkey use `unsafeWindow.myLib`; pass objects into the page with `cloneInto`, functions with `exportFunction`.
