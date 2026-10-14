// The Firefox support window: the current release and the one before it (MIN_FIREFOX in
// server/src/browser/internals.ts).
//   node dev/support-window.mjs --min   prints MIN_FIREFOX (CI installs that version to test the oldest supported)
//   node dev/support-window.mjs         compares it with Mozilla's current release; exits 1 when it should move
// When a new Firefox ships, raise MIN_FIREFOX to (new release - 1); internals.test.ts then lists every
// compat(firefox < N) branch that only the dropped version needed, to remove in the same change.
import fs from 'node:fs';
import path from 'node:path';

const SRC = path.join(import.meta.dirname, '..', 'server', 'src', 'browser', 'internals.ts');
const min = Number(/export const MIN_FIREFOX = (\d+);/.exec(fs.readFileSync(SRC, 'utf8'))?.[1]);
if (!min) { console.error(`no "export const MIN_FIREFOX = <n>;" in ${SRC}`); process.exit(2); }
if (process.argv.includes('--min')) { console.log(min); process.exit(0); }

const gh = !!process.env.GITHUB_ACTIONS;
// (exitCode, not process.exit: exiting with fetch's connection still open trips a libuv assertion on Windows)
process.exitCode = await check();

async function check() {
  let release;
  try {
    const r = await fetch('https://product-details.mozilla.org/1.0/firefox_versions.json');
    release = String((await r.json()).LATEST_FIREFOX_VERSION);
  } catch (e) {
    // not this check's job to fail on a network hiccup
    console.log(`${gh ? '::warning::' : ''}could not read the current Firefox release: ${e.message}`);
    return 0;
  }
  const major = Number(release.split('.')[0]);
  const want = major - 1;
  if (min === want) {
    console.log(`Firefox ${release} is the current release; MIN_FIREFOX ${min} is the release before it: in the window.`);
    return 0;
  }
  const msg = min < want
    ? `Firefox ${major} is out, so the support window is now ${want}+, but MIN_FIREFOX is ${min}. Raise MIN_FIREFOX to ${want} in server/src/browser/internals.ts and remove the compat(firefox < ${want}) code that internals.test.ts then lists.`
    : `MIN_FIREFOX ${min} is ahead of the support window (${want}+: the release before the current ${release}): users one release behind would be unsupported. Lower it to ${want}.`;
  console.log(`${gh ? '::error title=Firefox support window::' : ''}${msg}`);
  return 1;
}
