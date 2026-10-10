// What the user-run scripts in setup/ import from the server (setup/copy-extension-data.mjs). Its own entry point,
// so a release install (one bundle per entry, no per-module files in dist/) still has it at server/dist/setupLib.js.
export { detectMainProfile, loadConfig } from './config.js';
export { takeColdCopy } from './snapshots/snapshots.js';
