# uBlock Origin 1.75.0 (uBlock0@raymondhill.net)
(Reference recipe: the `ubo_*` adapter implements all of this. Use those tools; this file shows what a recipe looks like.)
- Background: persistent page (ES modules; internals not global); state in memory: **yes**.
- Its UI talks over a **port**, not sendMessage: runtime.connect({name}) then postMessage {channel, msgId, msg} → reply {msgId, msg}. Privileged channels (dashboard, loggerUI) are granted by sender.origin = the extension (a frame inside its background qualifies).
- My filters: dashboard readUserFilters / writeUserFilters {content, enabled, trusted}, then default reloadAllFilters (**mandatory**). Advanced settings: readHiddenSettings / writeHiddenSettings (full "name value" lines; uBO replaces the whole object).
- Logger: loggerUI readAll {ownerId} drains the buffer, switches off after 30 s unread, single owner; releaseView frees it. In-memory filters: toggleInMemoryFilter (never saved).
- Storage keys: user-filters (My filters), hiddenSettings, selectedFilterLists; cache/* = downloaded lists (re-fetchable).
- Gotchas: user resources (userResourcesLocation) end at the first blank line; `// ` and `#` lines at column 0 are dropped. backupUserData writes lastBackupFile/Time; restoreUserData wipes everything and re-downloads lists.
