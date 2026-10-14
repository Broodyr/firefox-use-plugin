#!/usr/bin/env node
import { createRequire as __cfCreateRequire } from 'node:module'; const require = __cfCreateRequire(import.meta.url);

// server/src/cli.ts
import fs2 from "node:fs";
import path3 from "node:path";

// server/src/config.ts
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

// server/src/browser/client.ts
import { AsyncLocalStorage } from "node:async_hooks";
var als = new AsyncLocalStorage();

// server/src/config.ts
var REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
var HOME = process.env.FIREFOX_USE_HOME ?? path.join(process.env.LOCALAPPDATA ?? path.join(os.homedir(), ".local", "share"), "firefox-use");
var TOKEN_FILE = path.join(HOME, "token");
var RUN_DIR = path.join(HOME, "run");
var THROWAWAY_DIR = path.join(HOME, "throwaway");
var cached = null;
var cachedMtime = -1;
function loadConfig() {
  const configFile = path.join(HOME, "config.json");
  let mtime = 0;
  try {
    mtime = fs.statSync(configFile).mtimeMs;
  } catch {
  }
  if (cached && mtime === cachedMtime) return cached;
  cachedMtime = mtime;
  let file = {};
  try {
    file = JSON.parse(fs.readFileSync(configFile, "utf8"));
  } catch {
  }
  cached = {
    firefoxPath: file.firefoxPath && fs.existsSync(file.firefoxPath) ? file.firefoxPath : detectFirefox(),
    profiles: file.profiles ?? {},
    addonsDir: file.addonsDir ?? path.join(HOME, "addons"),
    sandboxDir: file.sandboxDir ?? path.join(HOME, "sandbox"),
    runDir: file.runDir ?? RUN_DIR,
    mainProfile: file.mainProfile,
    syncAddonsFromMainProfile: file.syncAddonsFromMainProfile,
    idleQuitMinutes: file.idleQuitMinutes,
    throwawayAddons: process.env.FIREFOX_USE_THROWAWAY_ADDONS ?? file.throwawayAddons,
    approvalDialog: file.approvalDialog,
    personalProfile: file.personalProfile,
    driftReport: file.driftReport,
    agentWindow: file.agentWindow,
    liveView: file.liveView
  };
  return cached;
}
function detectFirefox() {
  if (process.platform === "win32") {
    for (const hive of ["HKLM", "HKCU"]) {
      try {
        const out = execFileSync("reg", ["query", `${hive}\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\App Paths\\firefox.exe`, "/ve"], { encoding: "utf8", windowsHide: true });
        const m = /REG_SZ\s+(.+)$/m.exec(out);
        if (m && fs.existsSync(m[1].trim())) return m[1].trim();
      } catch {
      }
    }
    for (const p of [process.env.ProgramFiles, process.env["ProgramFiles(x86)"]]) {
      const c = p && path.join(p, "Mozilla Firefox", "firefox.exe");
      if (c && fs.existsSync(c)) return c;
    }
  }
  for (const c of ["/usr/bin/firefox", "/Applications/Firefox.app/Contents/MacOS/firefox"]) if (fs.existsSync(c)) return c;
  return "firefox";
}
function ensureDir(d) {
  fs.mkdirSync(d, { recursive: true });
  return d;
}
function setupCommand(script = "setup.ps1", flags = "") {
  let root = REPO_ROOT;
  try {
    root = fs.realpathSync.native(REPO_ROOT);
  } catch {
  }
  return `powershell -ExecutionPolicy Bypass -File "${path.join(root, "setup", script)}"${flags ? ` ${flags}` : ""}`;
}

// server/src/browser/launcher.ts
import { spawn, execFileSync as execFileSync2 } from "node:child_process";
import path2 from "node:path";
function firefoxAlive(s) {
  return isAlive(s.browserPid) || isAlive(s.pid);
}
function killFirefox(s) {
  if (isOurFirefox(s.pid, s.profileDir)) killTree(s.pid);
  if (s.browserPid && s.browserPid !== s.pid && isOurFirefox(s.browserPid, s.profileDir)) killTree(s.browserPid);
}
function isOurFirefox(pid, profileDir) {
  if (!isAlive(pid)) return false;
  try {
    const cmd2 = process.platform === "win32" ? execFileSync2("powershell", ["-NoProfile", "-NonInteractive", "-Command", `(Get-CimInstance Win32_Process -Filter "ProcessId=${Number(pid)}").CommandLine`], { encoding: "utf8", windowsHide: true, timeout: 15e3 }) : execFileSync2("ps", ["-p", String(pid), "-o", "args="], { encoding: "utf8" });
    return /firefox/i.test(cmd2) && cmd2.toLowerCase().includes(path2.resolve(profileDir).toLowerCase());
  } catch {
    return false;
  }
}
function isAlive(pid) {
  if (!pid) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return e.code === "EPERM";
  }
}
function killTree(pid) {
  if (process.platform === "win32") {
    try {
      execFileSync2("taskkill", ["/PID", String(pid), "/T", "/F"], { stdio: "ignore", windowsHide: true });
    } catch {
    }
  } else {
    try {
      process.kill(-pid, "SIGKILL");
    } catch {
      try {
        process.kill(pid, "SIGKILL");
      } catch {
      }
    }
  }
}

// server/src/cli.ts
var [cmd, ...rest] = process.argv.slice(2);
if (cmd === "kill") {
  try {
    fs2.unlinkSync(TOKEN_FILE);
    console.log("token revoked");
  } catch {
    console.log("token already revoked");
  }
  fs2.writeFileSync(path3.join(ensureDir(RUN_DIR), "killed.json"), JSON.stringify({ at: (/* @__PURE__ */ new Date()).toISOString(), restore: !rest.includes("--no-restore"), by: "cli" }));
  const dir = loadConfig().runDir;
  let n = 0;
  for (const f of fs2.existsSync(dir) ? fs2.readdirSync(dir) : []) {
    if (!f.endsWith(".json") || f === "killed.json") continue;
    try {
      const s = JSON.parse(fs2.readFileSync(path3.join(dir, f), "utf8"));
      if (s.personal) continue;
      if (typeof s.pid === "number" && typeof s.bidiPort === "number" && firefoxAlive(s)) {
        killFirefox(s);
        n++;
        console.log(`killed Firefox ${s.browserPid ?? s.pid} (${s.key})`);
      }
      if (typeof s.bidiPort === "number") fs2.unlinkSync(path3.join(dir, f));
    } catch {
    }
  }
  if (!n) console.log("no firefox-use Firefox running");
  console.log(`Re-enable with: ${setupCommand("setup.ps1", "-TokenOnly")}`);
} else {
  console.log("usage: firefox-use kill [--no-restore]");
  process.exit(cmd ? 1 : 0);
}
