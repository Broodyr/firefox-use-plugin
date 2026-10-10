// Print ff_dev_status of every running proxy (via its token-authenticated pipe).
import fs from 'node:fs';
import path from 'node:path';
import { HOME, McpClient, readToken } from './client.ts';
const dir = path.join(HOME, 'run', 'proxies');
for (const f of fs.existsSync(dir) ? fs.readdirSync(dir) : []) {
  const p = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'));
  try {
    const c = await McpClient.connectPipe(p.pipe, readToken() ?? '');
    await c.initialize();
    const s = JSON.parse((await c.call('ff_dev_status', {})).text);
    console.log(`proxy ${p.pid} (cwd ${p.cwd}): backend gen ${s.backend?.gen} pid ${s.backend?.pid} build ${s.build?.hash} reloads ${s.reloads} crashes ${s.crashes} lastError ${s.lastError}`);
    await c.close();
  } catch (e: any) { console.log(`proxy ${p.pid}: unreachable (${e.message})`); }
}
process.exit(0);
