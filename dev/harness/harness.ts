// Shell-driven MCP test client.
//
//   npm run harness -- list
//   npm run harness -- call <tool> '<json args>'        (or --args-file <file>, or - to read JSON from stdin)
//   npm run harness -- repl                              (one server kept alive; lines: <tool> <json>)
//
// Options: --profile=claude-dev   use claude-dev: through the live session's proxy if one owns it, else directly
//          --headed               show the (minimised) agent window instead of running headless
//          --proxy                go through server/proxy (to exercise hot reload)
//          --save-images=<dir>    write returned images to files
import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import { McpClient, findProxyFor, readToken, type CallResult } from './client.ts';

const argv = process.argv.slice(2);
const flag = (k: string) => argv.find((a) => a === `--${k}` || a.startsWith(`--${k}=`));
const flagVal = (k: string) => flag(k)?.split('=').slice(1).join('=');
const pos = argv.filter((a) => !a.startsWith('--') || a === '-');
const [cmd, ...rest] = pos;

async function connect(): Promise<McpClient> {
  const profile = flagVal('profile');
  if (profile) {
    const live = findProxyFor(profile);
    if (live) {
      const token = readToken();
      if (!token) throw new Error('no session token');
      process.stderr.write(`[harness] via live proxy ${live.pid}\n`);
      const c = await McpClient.connectPipe(live.pipe, token);
      await c.initialize();
      return c;
    }
    const args = [`--profile=${profile}`, '--profile-mode=named', ...(flag('headed') ? [] : ['--headless'])];
    const c = flag('proxy') ? McpClient.spawnProxy(args) : McpClient.spawnServer(args);
    await c.initialize();
    return c;
  }
  const args = ['--profile-mode=throwaway', ...(flag('headed') ? [] : ['--headless'])];
  const c = flag('proxy') ? McpClient.spawnProxy(args) : McpClient.spawnServer(args);
  await c.initialize();
  return c;
}

function print(r: CallResult) {
  process.stdout.write(`${r.isError ? '[ERROR] ' : ''}${r.text}\n`);
  const dir = flagVal('save-images');
  r.images.forEach((img, i) => {
    if (dir) {
      fs.mkdirSync(dir, { recursive: true });
      const f = path.join(dir, `image-${Date.now()}-${i}.png`);
      fs.writeFileSync(f, Buffer.from(img.data, 'base64'));
      process.stdout.write(`[image ${i}: ${f}]\n`);
    } else process.stdout.write(`[image ${i}: ${img.mimeType}, ${img.data.length} b64 chars]\n`);
  });
}

function parseArgsJson(s: string | undefined): Record<string, unknown> {
  if (flag('args-file')) return JSON.parse(fs.readFileSync(flagVal('args-file')!, 'utf8'));
  if (s === '-') return JSON.parse(fs.readFileSync(0, 'utf8'));
  return s ? JSON.parse(s) : {};
}

const c = await connect();
let code = 0;
try {
  if (cmd === 'list') {
    for (const t of await c.listTools()) process.stdout.write(`${t.name}: ${t.description.split('\n')[0].slice(0, 110)}\n`);
  } else if (cmd === 'call') {
    const r = await c.call(rest[0], parseArgsJson(rest[1]));
    print(r);
    code = r.isError ? 1 : 0;
  } else if (cmd === 'repl') {
    const tty = process.stdin.isTTY;
    const rl = readline.createInterface({ input: process.stdin });
    const prompt = () => { if (tty) process.stdout.write('ff> '); };
    prompt();
    for await (const line of rl) {
      const m = /^\s*(\S+)\s*(.*)$/.exec(line);
      if (m?.[1] === 'exit') break;
      if (m) {
        if (!tty) process.stdout.write(`\n>>> ${m[1]} ${m[2].slice(0, 120)}\n`);
        try { print(await c.call(m[1], m[2] ? JSON.parse(m[2]) : {})); } catch (e: any) { process.stdout.write(`[harness error] ${e.message}\n`); }
      }
      prompt();
    }
  } else {
    process.stdout.write('usage: harness list | call <tool> [json|-] | repl   [--profile=claude-dev] [--headed] [--proxy] [--save-images=dir]\n');
  }
} finally {
  await c.close();
  if (process.env.HARNESS_STDERR) process.stderr.write(c.stderr.join('\n') + '\n');
}
process.exit(code);
