---
name: ubo-resources-loop
description: Write and debug uBlock Origin user scriptlets (userResourcesLocation resources), My filters, cosmetic/procedural filters and advanced settings in the claude-dev Firefox profile - serve resources/*.js locally, add filters, test filters and scriptlets without saving, read uBO's logger, verify on the page, roll back. Load together with firefox-basics whenever a task involves uBO filters, scriptlets or settings.
---

# uBO resources and filters loop

Everything goes through uBO's own messaging, the same channels its dashboard and logger use. So uBO's in-memory state stays consistent and nothing needs a dashboard tab.

Full tool names: `mcp__plugin_firefox-use_firefox__<tool>`. Load these in one search:

| Job | Tools |
|---|---|
| Overview | `ubo_read(kind: "status")` |
| Serve user scriptlets | `ubo_write(action: "set_resources")`, `ubo_write(action: "reload_resources")` |
| My filters | `ubo_read(kind: "filters")`, `ubo_write(action: "filters_add")`, `ubo_write(action: "filters_remove")`, `ubo_write(action: "filters_set")` |
| Try without saving | `ubo_read(kind: "test_filter")`, `ubo_read(kind: "test_scriptlet")` |
| What uBO did | `ubo_read(kind: "logger")`, `wait_for(kind: "ubo_event")` |
| Check the effect | `verify`, `eval`, `screenshot`, `console_read` |
| Settings and lists | `ubo_read(kind: "advanced")`, `ubo_write(action: "advanced_set")`, `ubo_read(kind: "lists") / ubo_write(action: "lists")`, `ubo_write(action: "trust_my_filters")` |
| Backups, rollback | `ubo_read(kind: "backup")`, `ubo_write(action: "restore")`, `ff_write(action: "snapshot")`, `restore` (part `ubo`), `undo` |

## The loop

1. **Scope, once:** `scope_set` with areas `["ext:ubo"]`, e.g. "change uBO My filters and userResourcesLocation in claude-dev for this task". `ubo_write(action: "trust_my_filters")` additionally needs `"ubo_trust"`; ask for it only when a `trusted-*` scriptlet is really needed.
2. **Write the scriptlet** as `resources/<name>.js`:

   ```js
   /// user-z.js
   function userZ(arg1) {
     // runs at document_start in the page (MAIN world), before page scripts
   }
   ```

   - A `/// name.js` header is added from the filename when missing. `/// alias other.js`, `/// world isolated` and `/// dependency x.js` lines are supported.
   - There is **no naming rule** (no `user-` prefix needed). The function is called with the filter's arguments.
3. **Serve it:** `ubo_write(action: "set_resources")` points `userResourcesLocation` at the local resource server and waits until uBO has fetched exactly this content (by hash).
4. **Add the filter:** `ubo_write(action: "filters_add", ["example.com##+js(user-z.js, arg1)"])`. Lines are checked with uBO's own parser first, and errors read exactly as in uBO's editor.
5. **Check it:** `verify(url, checks)`. It reports `uBO: … N scriptlet injection(s)` with the filter, plus errors and failed checks. Or use `wait_for(kind: "ubo_event", pattern: "user-z", verdict: "injected")` after a reload.
6. **Edit and repeat:** edit `resources/user-z.js`, run `ubo_write(action: "reload_resources")` (bumps the version and confirms uBO loaded the new hash), then `verify()`.

## Testing without saving

- `ubo_read(kind: "test_filter", filter: "example.com##.ad:has-text(Sponsored)", highlight: true)`: cosmetic and procedural filters are compiled by uBO's parser and run against the live page. You get the match count, HTML snippets and an outlined screenshot. A warning appears when the filter's hostnames don't cover the page.
- `ubo_read(kind: "test_filter", filter: "||ads.example^$image")`: network, scriptlet and HTML filters are added as **in-memory filters** (never saved). The tab reloads, and the uBO logger entries for that filter come back.
- `ubo_read(kind: "test_scriptlet", name: "set-constant", args: ["foo", "true"])`: injects once via an in-memory `<host>##+js(…)` and reports the injection log and console output. Works for built-in and user scriptlets.

## Gotchas (measured, not guessed)

- **uBO's resource parser ends a resource at the first blank line**, and drops lines starting with `// ` or `#` at column 0. The bundler turns blank lines into `//` and warns about `#` lines and template literals spanning a blank line. Keep scriptlets plain functions.
- After changing filters, uBO needs `reloadAllFilters`, and the tools do it. A page shows the change only after a **reload**.
- `##+js(user-z.js)` shows up in uBO's logger as `##+js(user-z)`.
- uBO's logger records only while read, and has one owner. The tools own it while in use (`ubo_read(kind: "logger")` / `verify` start it, and it is released after 15 minutes idle). If the user opens uBO's logger, capture pauses (`ubo_read(kind: "status")` says so).
- `trusted-*` built-in scriptlets need trusted My filters (`ubo_write(action: "trust_my_filters")`). User scriptlets from `userResourcesLocation` need no trust.
- New third-party filter-list URLs are refused (`ubo_read(kind: "lists") / ubo_write(action: "lists")` takes known list keys only). Ask the user to add a list.
- **Rollback:**
  - `undo` reverts filter, setting, list and trust changes one by one.
  - `restore(id, ["ubo"])` puts back uBO's whole user state from a ff_write(action: "snapshot") with targeted writes.
  - `ubo_write(action: "restore", file)` is the dashboard's full "Restore from file": uBO wipes itself and re-downloads all lists, so use it only when asked.
