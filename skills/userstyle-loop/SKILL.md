---
name: userstyle-loop
description: Write, install, live-edit, debug and sync userstyles with Stylus in the claude-dev Firefox profile - workspace styles/*.user.css (usercss) as the source of truth, Stylus's own install so preprocessors and @var work as in production, live restyling of open tabs, a watch mode that pushes every save, checking which styles apply to a page and why, and two-way sync with Stylus's editor. Load together with firefox-basics whenever a task involves a userstyle or Stylus.
---

# Userstyle loop

The workspace file `styles/<name>.user.css` is the **source of truth**; Stylus is the install target. Everything goes through Stylus's own API (the messages its pages send to its background), never its database.

Full tool names: `mcp__plugin_firefox-use_firefox__<tool>`. Load these in one search:

| Job | Tools |
|---|---|
| Check a file without installing | `stylus_read(kind: "check", path)` |
| Install / re-push | `stylus_write(action: "install", path, watch?)`, `stylus_write(action: "update", style)` |
| Live editing | `stylus_write(action: "watch", style, on?)` |
| See what's installed | `stylus_read(kind: "list")`, `stylus_read(kind: "source", style)` |
| Does it apply here, and why not | `stylus_read(kind: "for_url", url? \| tab?)` |
| Check the effect | `eval` (getComputedStyle), `screenshot`, `read_page`, `find` |
| Variables (@var) | `stylus_read(kind: "source")` lists them; `stylus_write(action: "vars", style, values)` |
| Toggle / remove | `stylus_write(action: "enable" \| "disable" \| "uninstall", style)` |
| Sync with Stylus's editor | `stylus_read(kind: "sync_status")`, `stylus_write(action: "sync")` |
| Approval, rollback | `scope_set`, `undo`, `snapshot` / `restore` (part `"stylus"`) |

`style` is the workspace path of a linked file, the style's name, or its Stylus id.

## The loop

1. **Scope, once.** Installing changes Stylus: `scope_set` with a concrete description ("install and update my userstyle in Stylus (claude-dev) for this task") and areas `["ext:stylus"]`.
2. **Write the file** in `styles/`, as usercss: a metadata block, then `@-moz-document` sections.
   ```css
   /* ==UserStyle==
   @name        Site tweaks
   @namespace   github.com/<user>
   @version     1.0.0
   @var color accent "Accent" #0a84ff
   ==/UserStyle== */
   @-moz-document domain("example.com") {
     a { color: var(--accent); }
   }
   ```
   `@name` + `@namespace` identify the style: Stylus updates an installed style with the same pair instead of adding a second one. Matchers: `domain()`, `url-prefix()`, `url()`, `regexp()`; several in one rule apply to any of them. `@preprocessor stylus` or `less` work too (Stylus compiles them).
   Throwaway probe styles go in `.firefox-use/scratch/` (inside the workspace, git-ignored).
3. **Check it.** `stylus_read(kind: "check", path)` parses and compiles as Stylus does, without installing: errors come back as `file:line:col` with the offending text, or the sections and where they apply, plus which installed style an install would update.
4. **Install.** `stylus_write(action: "install", path)`. Open tabs restyle at once; **no reload is needed**. The result names the version it replaced and warns when another enabled style has the same name (both apply).
   - Stylus installs leniently: like its editor's save, it skips what it can't parse. The result adds a WARNING with Stylus's strict parse error, since that rule then has no effect. Only a missing or broken metadata block refuses the install.
5. **Verify on the page.** `eval` with `getComputedStyle(el).prop` is the precise check; `screenshot` for the look. When nothing changes, `stylus_read(kind: "for_url")` tells why: disabled, excluded, matching sections empty, turned off for the tab, or no match at all (it also counts the Stylus sheets injected in the tab).
6. **Edit and re-push**: `stylus_write(action: "update", style)` after each edit. For a longer session, **watch** instead: `stylus_write(action: "install", path, watch: true)` (or `action: "watch"` on a linked file) pushes every save, so the page restyles while you edit. A save that fails (e.g. the metadata block broke) is reported in the next tool result and the last good version stays applied; a save with a CSS error is pushed with the parser warning. `action: "watch", on: false` stops.
7. **Variables.** `stylus_write(action: "vars", style, values: {accent: "#ff0066"})`, as the style's configure dialog does; the page updates at once.

## Two-way sync

- Edits the user makes in Stylus's editor are pulled into the file automatically (every few seconds) when the file itself hasn't changed since the last sync.
- A style changed on both sides is never overwritten: `stylus_write(action: "sync")` saves Stylus's version as `<file>.stylus-conflict` and leaves the file alone. Merge, then `stylus_write(action: "update")` (the file wins) or `action: "sync", direction: "pull", force: true` (Stylus wins).
- `stylus_read(kind: "sync_status")`: synced, file changed, stylus changed, both changed, missing; and which files are watched.

## Rollback

`install`, `update`, `enable`/`disable`, `uninstall` and `vars` are audited and undo-able (`undo`, scope `"restore"`). Warm snapshots include a `stylus` part (every style with its source and variables): `restore(id, parts: ["stylus"])` removes styles added since and puts changed or removed ones back.

## Pitfalls

- **Specificity and order.** A page rule with higher specificity, or `!important`, wins over yours. Check the computed value, not the source; add `!important` or a more specific selector when the page's own rule wins.
- **Shadow DOM.** Page CSS doesn't reach into shadow roots. Style the host, or use `::part()` where the component exposes parts.
- **Two copies.** The user's own copy of a style (same name, other namespace) applies alongside yours; disable one (the install result warns).
- **Classic styles** (non-usercss, from userstyles.org or created in Stylus's editor) can be listed, read, toggled and removed, but only usercss files are installed from the workspace.
