# Stylus 2.4.14 ({7a7a4a92-a2a0-41d1-9fd7-1e92480d612d})
(Reference recipe: the `stylus_*` adapter and the userstyle-loop skill implement this. Use those tools; this file shows how Stylus is driven, for whatever they don't cover.)
- Background: a background page; state in memory: **yes** (styleMap), styles in its own IndexedDB "stylish" (not storage.local), so never touch storage directly.
- One message shape for everything: ext_write(action: "message") {data:{method:"invokeAPI", path:"<ns>.<fn>", args:[...]}, TDM:1} → {data} or {error:{message, line, col, context}}. `path` walks the background's API object.
- List: styles.getCore({sections:true, size:true}); with source: styles.getCore({src:true, vars:true}) (without vars:true, usercssData.vars is only a count). One: styles.getCore({id, src:true, vars:true}).
- Install/update usercss: usercss.install({sourceCode, id?}) → the style. Without id it updates the style with the same @name + @namespace, else adds one. Lenient (skips what it can't parse); usercss.build(code, {strict:true}) parses strictly without saving → {style, dup, logs} or an error with line/col (file lines).
- Toggle: styles.config(id, "enabled", bool) · Remove: styles.remove(id) / styles.removeMany(ids) · Variables: usercss.configVars(id, fullVarsObject) (set .value per var).
- Which styles match a URL: styles.getByUrl(url) → [{style, excluded, excludedScheme, empty, sloppy, tabOvr}].
- Bulk put back (keeps ids): styles.importMany([styles]) (rebuilds usercss sections from sourceCode).
- Page side: apply.js injects <style class="stylus"> (ids only with the exposeStyleName pref), or adoptedStyleSheets with media "screen, <id>" under a strict CSP. Updates apply to open tabs at once.
