---
name: bisect
description: Find which of the claude-dev profile's extensions, userscripts, prefs or extension storage keys make a page or test misbehave, by delta debugging in throwaway Firefox copies (claude-dev is never touched). Load together with regression-tests when "it works in a clean profile but not in claude-dev" or "something broke this page".
---

# Bisect

Tool: `mcp__plugin_firefox-use_firefox__bisect` (plus `test_run`, `test_record` from the regression-tests skill).

## When

- A page or test behaves differently in claude-dev than in a clean profile, and one of many extensions / userscripts / prefs is the suspect.
- A regression test fails only with the user's setup.

## How

1. Get a test that **fails** in claude-dev and states the expected behaviour: a regression test name, or inline `{url, steps?, assert: [...]}` (same assertions as test files).
2. `bisect(test, dimensions)` with any of:
   - `extensions: true` — every enabled extension (uBO and Violentmonkey only with `include_core: true`);
   - `userscripts: true` — enabled Violentmonkey scripts, plus the test's own setup userscripts;
   - `prefs: ["name", …]` — reset to default when switched off;
   - `ext_storage: {extension, keys: [...]}` — those `storage.local` keys removed when switched off.
3. It checks that the test fails with everything on and passes with everything off (otherwise the cause isn't among the items, and it says so), then narrows down with ddmin. The result is the **minimal failing set** plus every probe.

## Notes

- Every probe is a fresh headless throwaway copy of claude-dev with all its extensions (one Firefox launch, a few seconds each); `max_steps` (default 24) caps the work. Narrow the dimensions when there are many items.
- Use `live: false` (default) with a test that has a HAR fixture, so probes don't depend on the network.
- A "minimal set" of two items means they only break the page together (an interaction).
- Throwaway copies are made from claude-dev's files: state changed seconds ago in the running claude-dev may not be on disk yet.
