// The live view's page (SPEC §6.23): one self-contained HTML document, no external assets. Its script and style
// carry the response's CSP nonce. Frames arrive as binary (/frame, decoded natively), everything else as Server-Sent
// Events (/events). Nothing on it sends input to the page in Firefox: the only requests are Take over, Show window /
// Run in background, and which of the session's tabs to view.

export function livePage(nonce: string): string {
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="color-scheme" content="light dark">
<title>Claude live view</title>
<style nonce="${nonce}">
:root { --bg: #f6f5f2; --panel: #ffffff; --ink: #1d1c1a; --muted: #6b6862; --line: #dedbd3; --accent: #c4512f; --accent-ink: #fff; --ok: #2f7d4f; --warn: #a86400; --bad: #b3261e; --stage: #e9e7e1; }
@media (prefers-color-scheme: dark) { :root { --bg: #1b1a18; --panel: #24231f; --ink: #ece9e2; --muted: #a29e95; --line: #3a3833; --accent: #e07a55; --accent-ink: #1b1a18; --ok: #6cc290; --warn: #e3a948; --bad: #f08a80; --stage: #121110; } }
* { box-sizing: border-box; }
html, body { margin: 0; height: 100%; background: var(--bg); color: var(--ink); font: 14px/1.4 system-ui, -apple-system, "Segoe UI", sans-serif; }
body { display: flex; flex-direction: column; }
header { display: flex; align-items: center; gap: 10px; padding: 8px 16px; border-bottom: 1px solid var(--line); background: var(--panel); min-width: 0; }
.dot { width: 9px; height: 9px; border-radius: 50%; background: var(--muted); flex: none; }
.dot.running { background: var(--ok); animation: pulse 1s infinite; } .dot.idle { background: var(--muted); }
.dot.handed-off, .dot.login { background: var(--warn); } .dot.stopped { background: var(--bad); }
@keyframes pulse { 50% { opacity: .35; } }
#label { font-weight: 600; white-space: nowrap; }
#state { color: var(--muted); white-space: nowrap; }
#url { color: var(--muted); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; min-width: 0; flex: 1; font-size: 13px; }
main { flex: 1; display: flex; min-height: 0; }
#stagewrap { flex: 1; min-width: 0; display: flex; align-items: center; justify-content: center; padding: 12px; background: var(--stage); position: relative; }
#frame { position: relative; background: #fff; box-shadow: 0 1px 4px rgba(0,0,0,.25); }
#frame img { display: block; width: 100%; height: 100%; }
#overlay { position: absolute; inset: 0; pointer-events: none; overflow: hidden; }
.ripple { position: absolute; width: 36px; height: 36px; margin: -18px 0 0 -18px; border-radius: 50%; border: 3px solid var(--accent); animation: ripple .7s ease-out forwards; }
@keyframes ripple { from { transform: scale(.3); opacity: 1; } to { transform: scale(1.6); opacity: 0; } }
.caret { position: absolute; border: 2px solid var(--accent); border-radius: 3px; animation: fade 1.6s ease-out forwards; }
.trail { position: absolute; height: 3px; background: var(--accent); transform-origin: 0 50%; animation: fade 1s ease-out forwards; }
@keyframes fade { from { opacity: .9; } to { opacity: 0; } }
#placeholder, #empty { position: absolute; inset: 12px; display: none; align-items: center; justify-content: center; text-align: center; padding: 24px; color: var(--muted); }
#placeholder b { color: var(--ink); display: block; margin-bottom: 6px; }
#badge { position: absolute; top: 18px; left: 18px; padding: 2px 8px; border-radius: 4px; background: var(--warn); color: #1b1a18; font-size: 12px; font-weight: 600; display: none; }
aside { width: 300px; flex: none; display: flex; flex-direction: column; border-left: 1px solid var(--line); background: var(--panel); min-height: 0; }
.controls { padding: 12px 14px; border-bottom: 1px solid var(--line); display: flex; flex-direction: column; gap: 8px; }
button { font: inherit; border-radius: 6px; border: 1px solid var(--line); background: var(--panel); color: var(--ink); padding: 6px 10px; cursor: pointer; }
button:disabled { opacity: .5; cursor: default; }
button.primary { background: var(--accent); color: var(--accent-ink); border-color: var(--accent); font-weight: 600; padding: 8px 10px; }
.row { display: flex; gap: 8px; } .row button { flex: 1; }
#hint { color: var(--muted); font-size: 12.5px; min-height: 1.2em; }
#hint.warn { color: var(--warn); }
h2 { font-size: 12px; text-transform: uppercase; letter-spacing: .04em; color: var(--muted); margin: 12px 14px 6px; font-weight: 600; }
#tabs { display: flex; flex-direction: column; gap: 4px; padding: 0 10px; }
#tabs button { text-align: left; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: 13px; padding: 5px 8px; }
#tabs button.viewing { border-color: var(--accent); }
#tabs button .cur { color: var(--accent); font-weight: 600; }
#follow { margin: 6px 10px 0; font-size: 12.5px; display: none; }
#calls { list-style: none; margin: 0; padding: 0 14px 14px; overflow: auto; flex: 1; font-size: 13px; }
#calls li { padding: 4px 0; border-bottom: 1px dashed var(--line); display: flex; gap: 6px; align-items: baseline; }
#calls li .n { font-weight: 600; white-space: nowrap; } #calls li .t { color: var(--muted); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; flex: 1; min-width: 0; }
#calls li .s { white-space: nowrap; font-size: 12px; color: var(--muted); } #calls li .s.err { color: var(--bad); } #calls li .s.run { color: var(--ok); }
@media (max-width: 760px) { main { flex-direction: column; } aside { width: auto; border-left: 0; border-top: 1px solid var(--line); max-height: 45vh; } #stagewrap { min-height: 45vh; } }
</style></head>
<body>
<header><span class="dot" id="dot"></span><span id="label">Claude</span><span id="state">connecting…</span><span id="url"></span></header>
<main>
  <div id="stagewrap">
    <div id="frame"><img id="img" alt="Claude's current tab"><div id="overlay"></div></div>
    <div id="placeholder"></div>
    <div id="empty">Waiting for the first frame…</div>
    <div id="badge">stale</div>
  </div>
  <aside>
    <div class="controls">
      <button class="primary" id="takeover" title="Hand the browser to you, as ff_handoff does: Claude's window comes on-screen on this tab and Claude stops until you hand it back in the chat">Take over</button>
      <div class="row"><button id="show" title="Show Claude's window on-screen (display only)">Show window</button><button id="park" title="Move Claude's window out of the way (display only)">Run in background</button></div>
      <div id="hint"></div>
    </div>
    <h2>Tabs</h2>
    <div id="tabs"></div>
    <button id="follow">Follow Claude</button>
    <h2>Tool calls</h2>
    <ul id="calls"></ul>
  </aside>
</main>
<script nonce="${nonce}">
"use strict";
const $ = (id) => document.getElementById(id);
const img = $("img"), frameBox = $("frame"), overlay = $("overlay"), wrap = $("stagewrap");
let meta = null, viewing = null, tabs = [], state = null, stopped = false;
let want = 0, loading = false, shownSeq = 0, objUrl = null;
const calls = new Map();

function layout() {
  if (!meta || !meta.cssW) return;
  const r = wrap.getBoundingClientRect();
  const aw = Math.max(50, r.width - 24), ah = Math.max(50, r.height - 24);
  const k = Math.min(aw / meta.cssW, ah / meta.cssH);
  frameBox.style.width = Math.floor(meta.cssW * k) + "px";
  frameBox.style.height = Math.floor(meta.cssH * k) + "px";
}
addEventListener("resize", layout);

async function loadFrame() {
  if (loading || want <= shownSeq) return;
  loading = true;
  const seq = want;
  try {
    const r = await fetch("frame?seq=" + seq, { cache: "no-store" });
    if (r.status === 200) {
      const url = URL.createObjectURL(await r.blob());
      const next = new Image();
      next.src = url;
      await next.decode().catch(() => {});
      img.src = url;
      if (objUrl) URL.revokeObjectURL(objUrl);
      objUrl = url;
      shownSeq = seq;
      $("empty").style.display = "none";
      $("placeholder").style.display = "none";
      frameBox.style.visibility = "visible";
    }
  } catch {}
  loading = false;
  if (want > shownSeq) loadFrame();
}

function setHeader() {
  if (!state) return;
  $("dot").className = "dot " + state.state;
  const words = { running: "working", idle: "idle", "handed-off": "you have the browser", login: "login handoff", stopped: "stopped" };
  $("state").textContent = (words[state.state] || state.state) + (state.state === "running" && state.note ? ": " + state.note : "");
  $("label").textContent = state.label || "Claude";
  const t = meta ? (meta.title ? meta.title + " — " : "") + meta.url : "";
  $("url").textContent = t;
  $("url").title = t;
}

function setControls() {
  const c = (state && state.controls) || {};
  const off = stopped || !state;
  $("takeover").disabled = off || !!c.takeover;
  $("show").disabled = off || !!c.window || c.windowMode === "visible";
  $("park").disabled = off || !!c.window || (c.windowMode !== "visible");
  $("takeover").textContent = state && state.state === "handed-off" ? "You have the browser" : "Take over";
  const hint = $("hint");
  hint.className = "";
  if (stopped) hint.textContent = state && state.note ? state.note : "stopped";
  else if (state && state.state === "handed-off") { hint.textContent = state.note; hint.className = "warn"; }
  else if (state && state.dialog) { hint.textContent = "dialog open: " + state.dialog; hint.className = "warn"; }
  else if (c.takeover) hint.textContent = c.takeover;
  else if (state && state.state === "login") hint.textContent = state.note;
  else hint.textContent = c.windowMode ? "Claude's window: " + ({ visible: "on-screen", offscreen: "off-screen", minimized: "minimised" }[c.windowMode] || c.windowMode) : "";
  $("badge").style.display = state && (state.stale || state.dialog) && !stopped ? "block" : "none";
  $("badge").textContent = state && state.dialog ? "dialog open" : "stale";
}

function renderTabs() {
  const box = $("tabs");
  box.textContent = "";
  for (const t of tabs) {
    const b = document.createElement("button");
    if ((viewing == null && t.current) || viewing === t.tab) b.className = "viewing";
    if (t.current) { const s = document.createElement("span"); s.className = "cur"; s.textContent = "● "; b.appendChild(s); }
    b.appendChild(document.createTextNode((t.title || t.url || "(blank)") + "  "));
    b.title = t.url;
    b.addEventListener("click", () => post("view", { tab: t.current && viewing == null ? null : t.tab }));
    box.appendChild(b);
  }
  $("follow").style.display = viewing == null ? "none" : "block";
}
$("follow").addEventListener("click", () => post("view", { tab: null }));

function renderCall(c) {
  let li = calls.get(c.id);
  if (!li) {
    li = document.createElement("li");
    li.innerHTML = '<span class="n"></span><span class="t"></span><span class="s"></span>';
    calls.set(c.id, li);
    $("calls").prepend(li);
    while ($("calls").children.length > 30) { const last = $("calls").lastElementChild; for (const [k, v] of calls) if (v === last) calls.delete(k); last.remove(); }
  }
  li.querySelector(".n").textContent = c.name;
  li.querySelector(".t").textContent = c.target || "";
  li.querySelector(".t").title = c.target || "";
  const s = li.querySelector(".s");
  if (c.phase === "start") { s.textContent = "…"; s.className = "s run"; }
  else { s.textContent = c.status === "error" ? (c.code || "error") : c.ms + " ms"; s.className = "s" + (c.status === "error" ? " err" : ""); }
}

function pointer(p) {
  if (!meta || !meta.cssW) return;
  const cur = viewing != null ? viewing : (tabs.find((t) => t.current) || {}).tab;
  if (p.tab != null && cur != null && p.tab !== cur) return;
  const px = (v) => (v / meta.cssW * 100) + "%", py = (v) => (v / meta.cssH * 100) + "%";
  const el = document.createElement("div");
  if (p.kind === "type" && p.w) {
    el.className = "caret";
    el.style.left = px(p.x); el.style.top = py(p.y); el.style.width = px(p.w); el.style.height = py(p.h);
  } else if (p.kind === "drag" && p.x2 != null) {
    const r = frameBox.getBoundingClientRect();
    const k = r.width / meta.cssW;
    const dx = (p.x2 - p.x) * k, dy = (p.y2 - p.y) * k;
    el.className = "trail";
    el.style.left = px(p.x); el.style.top = py(p.y); el.style.width = Math.hypot(dx, dy) + "px";
    el.style.transform = "rotate(" + Math.atan2(dy, dx) + "rad)";
    const end = document.createElement("div");
    end.className = "ripple"; end.style.left = px(p.x2); end.style.top = py(p.y2);
    overlay.appendChild(end); setTimeout(() => end.remove(), 1200);
  } else {
    el.className = "ripple";
    el.style.left = px(p.x); el.style.top = py(p.y);
  }
  overlay.appendChild(el);
  setTimeout(() => el.remove(), 1800);
}

async function post(what, body) {
  try {
    const r = await fetch(what, { method: "POST", headers: { "X-Live-View": "1", "Content-Type": "application/json" }, body: JSON.stringify(body || {}) });
    const j = await r.json().catch(() => ({}));
    if (!r.ok && j.error) { $("hint").textContent = j.error; $("hint").className = "warn"; }
  } catch {}
}
$("takeover").addEventListener("click", () => post("takeover"));
$("show").addEventListener("click", () => post("window", { action: "show" }));
$("park").addEventListener("click", () => post("window", { action: "park" }));

let es = null;
function connect() {
  es = new EventSource("events");
  es.addEventListener("hello", (e) => { const d = JSON.parse(e.data); $("label").textContent = d.label; });
  es.addEventListener("state", (e) => {
    state = JSON.parse(e.data);
    if (state.state === "stopped") { stopped = true; es.close(); frameBox.style.opacity = ".5"; }
    setHeader(); setControls();
  });
  es.addEventListener("tabs", (e) => { const d = JSON.parse(e.data); tabs = d.tabs; viewing = d.viewing; renderTabs(); });
  es.addEventListener("tool", (e) => renderCall(JSON.parse(e.data)));
  es.addEventListener("pointer", (e) => pointer(JSON.parse(e.data)));
  es.addEventListener("frame", (e) => {
    meta = JSON.parse(e.data);
    layout(); setHeader();
    want = Math.max(want, meta.seq);
    if (meta.seq < shownSeq) shownSeq = 0;
    loadFrame();
  });
  es.addEventListener("placeholder", (e) => {
    const d = JSON.parse(e.data);
    const p = $("placeholder");
    p.textContent = "";
    const b = document.createElement("b"); b.textContent = d.title || "(no title)";
    p.append(b, document.createTextNode(d.url), document.createElement("br"), document.createTextNode(d.reason));
    p.style.display = "flex";
    frameBox.style.visibility = "hidden";
    $("empty").style.display = "none";
  });
  // a backend reload drops the stream; EventSource retries by itself, but not after an HTTP error
  es.onerror = () => {
    if (stopped) return;
    $("dot").className = "dot"; $("state").textContent = "reconnecting…";
    for (const id of ["takeover", "show", "park"]) $(id).disabled = true;
    if (es.readyState === 2) setTimeout(connect, 2000);
  };
}
frameBox.style.visibility = "hidden";
$("empty").style.display = "flex";
connect();
</script>
</body></html>`;
}
