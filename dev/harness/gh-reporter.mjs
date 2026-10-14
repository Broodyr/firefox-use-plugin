// node:test reporter for GitHub Actions (run-tests.mjs adds it when GITHUB_ACTIONS is set, next to the usual spec
// output): each failing test becomes an error annotation and a row in the job summary, so a failure can be read
// on the run's page and through the public API without signing in (job logs need a GitHub sign-in).
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..', '..');
const esc = (s) => String(s).replace(/%/g, '%25').replace(/\r/g, '%0D').replace(/\n/g, '%0A');
const escProp = (s) => esc(s).replace(/:/g, '%3A').replace(/,/g, '%2C');

export default async function* githubReporter(source) {
  const failures = [];
  for await (const ev of source) {
    if (ev.type !== 'test:fail') continue;
    const d = ev.data;
    const err = d.details?.error;
    // a suite fails when a test in it does: that test has its own entry
    if (err?.failureType === 'subtestsFailed') continue;
    const cause = err?.cause ?? err;
    const msg = String(cause?.message ?? cause ?? 'failed').slice(0, 6000);
    const file = d.file ? path.relative(ROOT, d.file).replace(/\\/g, '/') : '';
    failures.push({ name: d.name, file, line: d.line, msg, type: err?.failureType });
    // GitHub shows 10 error annotations per step; the summary has all of them
    if (failures.length <= 10) yield `::error ${file ? `file=${escProp(file)},line=${d.line ?? 1},` : ''}title=${escProp(`${path.basename(file, '.test.ts')}: ${d.name}`.slice(0, 200))}::${esc(msg)}\n`;
  }
  if (!process.env.GITHUB_STEP_SUMMARY) return;
  const lines = [failures.length ? `### ${failures.length} failing test(s)` : '### All tests passed', ''];
  for (const f of failures) lines.push(`<details><summary><b>${f.file}</b>: ${f.name}${f.type && f.type !== 'testCodeFailure' ? ` (${f.type})` : ''}</summary>`, '', '```', f.msg.slice(0, 4000), '```', '</details>', '');
  fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, lines.join('\n') + '\n');
}
