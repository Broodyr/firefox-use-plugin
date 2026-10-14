---
name: regression-tests
description: Write, record and run regression tests for userscripts and extensions in Firefox - tests/<name>.test.json with setup (userscripts, local extensions, extension storage, prefs), HAR fixtures replayed offline, and assertions in any realm (page, userscript, content script, extension), console counts and marker order; each run in a fresh headless throwaway copy of claude-dev. Also version pins (re-run after a Firefox or add-on update) and screenshot diffs. Load together with firefox-basics when a fix should stay fixed.
---

# Regression tests

Full tool names: `mcp__plugin_firefox-use_firefox__<tool>`. Load these in one search:

| Job | Tools |
|---|---|
| Record a test from a page | `test_record` (or `network_write(action: "har_record")` / `network_write(action: "har_stop")` for just the fixture) |
| Run | `test_run` |
| Compare screenshots | `visual_diff`, `screenshot` |
| After a Firefox / add-on update | `ff_status` (shows the re-run), `ff_write(action: "pins")` |
| Which extension/userscript breaks it | `bisect` (bisect skill) |

## Test files

`tests/<name>.test.json` in the workspace:

```json
{
  "name": "x-removes-banner",
  "setup": {
    "userscripts": ["scripts/x.user.js"],
    "extensions": [{ "local": "ext/" }],
    "ext_storage": [{ "extension": "my-ext@x", "items": { "enabled": true } }],
    "prefs": { "dom.webnotifications.enabled": false }
  },
  "fixtures": { "har": "x-home", "mode": "strict" },
  "cases": [{
    "url": "https://example.com/",
    "steps": [{ "wait_for(kind: "selector")": "#main" }, { "click": { "target": { "x": 10, "y": 10 }, "coords": "viewport" } }],
    "assert": [
      { "selector": ".banner", "state": "absent" },
      { "expr": "document.title", "equals": "Example" },
      { "expr": "removed === 1", "realm": { "kind": "userscript", "script": "x" } },
      { "expr": "state.ready", "realm": { "kind": "content", "extension": "my-ext@x" } },
      { "text": "Welcome" },
      { "console": { "level": "error", "count": 0 } },
      { "order": ["mark:ext-ready", "mark:x-started"] }
    ]
  }]
}
```

- **Steps** are tool calls `{tool: args}`; shorthands: `{"wait_for(kind: "selector")": "#id"}`, `{"wait_for": "expr"}`, `{"wait_for(kind: "text")": "…"}`, `{"navigate": "url"}`, `{"eval": "code"}`. Refs don't survive into a fresh profile: use selectors, `eval`, or viewport coordinates.
- **Assertions:** `expr` (truthy, or `equals`) in any realm — a userscript's own scope with `{kind:"userscript", script}`; `selector` (`present`/`absent`/`visible`/`hidden`); `text` (`absent: true` to negate); `console` counts entries of the tested tab and of extensions at or above `level` (browser-internal messages don't count); `order` checks console order: `mark:<label>` is a `__claude.mark(label)` from a dev userscript, anything else a substring of a console message (an extension can `console.log("ext-ready")`).
- `fixtures.har` is `tests/fixtures/<name>.har`; `strict` fails (and lists) requests the HAR lacks, `fallthrough` sends them to the network. `/favicon.ico` is answered with a 404.

## Workflow

1. **Record:** `test_record(name, url, steps, userscripts?, extensions?)` loads the URL while recording the HAR, runs the steps, and writes the test with suggested assertions (title, heading, marks seen, no console errors). **Edit the assertions** so they check the behaviour that matters (the userscript's effect, the extension's state), not incidental page details.
2. **Run:** `test_run(["name"])` (or `"all"`). Each file runs in a fresh headless throwaway copy of claude-dev with only uBO and Violentmonkey active (`addons: "all"` for every extension), the setup applied, the HAR replayed (`live: true` for the network). A failure lists each assertion with its value, the errors, and a screenshot path.
3. **Keep it green:** run it after every fix. Results are kept in `.firefox-use/test-results.json`.

## Version changes

`.firefox-use/pins.json` records the Firefox and add-on versions last accepted (commit it). When a launch of claude-dev finds other versions, the launch notes say so and **every test re-runs headless in the background**; `ff_status` then shows the result and the tests that **newly** fail (likely the update, not your edit). After checking, `ff_write(action: "pins", accept: true)` makes the new versions the baseline.

## Screenshots

`visual_diff(a, b)` compares two PNGs (e.g. two `screenshot` files from `.firefox-use/artifacts/`): percent changed and a diff image (changed pixels red).
