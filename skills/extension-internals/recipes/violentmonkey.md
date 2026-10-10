# Violentmonkey 2.49.0 ({aecec67f-0d10-4fa7-b7c7-609a2db280cf})
(Reference recipe: the `us_*` adapter implements all of this. Use those tools; this file shows what a recipe looks like.)
- Background: event page; state in memory: **yes** (script list), so never write `scr:` / `code:` / `val:` storage directly.
- List scripts: ext_write(action: "message") {cmd:"GetData", data:{ids:null}} → {scripts:[{props:{id,lastModified,uri}, meta:{name,namespace,match,include,runAt,...}, config:{enabled,removed}}], cache:{icons}}
- Install/update: ext_write(action: "message") {cmd:"ParseScript", data:{code, bumpDate:true, url?, config?:{shouldUpdate:0}}} → {isNew, where:{id}, update:{message}, errors}. Updates match by @name + @namespace. Takes effect on the next page load.
- Enable: {cmd:"UpdateScriptInfo", data:{id, config:{enabled:0|1}}} · Recycle bin: {cmd:"MarkRemoved", data:{id, removed:true}} · Code: {cmd:"GetScriptCode", data:id}
- Values: read storage `val:<id>`; write {cmd:"SetValueStores", data:{<id>: {key: encoded}}} (replaces the store). Encoding: s<string> n<number> b<bool> o<JSON>.
- Gotchas: @match without a port does not match http://127.0.0.1:<port>/ (VM's own matcher). Stack lines = file line + 2 + lines of every @require. GM_xmlhttpRequest URLs get a random #VMxhr<base64> fragment.
