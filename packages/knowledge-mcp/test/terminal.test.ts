/**
 * Commands the console's chat runs on this machine, each only after the person approves it (admin/terminal.ts).
 * The model is a local fake that streams as an OpenAI-compatible endpoint does: nothing leaves this machine, and
 * the commands are harmless ones in a temporary folder.
 */
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

for (const k of Object.keys(process.env)) if (/^(GOOGLE_|DRIVE_|QDRANT_|OPENAI_|ANTHROPIC_|LLM_|SEARCH_LLM_|EMBEDDING_|KNOWLEDGE_|KMCP_|TERMINAL_)/.test(k)) delete process.env[k];
const dir = mkdtempSync(join(tmpdir(), 'kmcp-terminal-'));
mkdirSync(join(dir, 'docs'));
writeFileSync(join(dir, 'docs', 'a.md'), '# A\n\nText.\n');
writeFileSync(join(dir, 'mcp.config.json'), JSON.stringify({ orgId: 'acme', folders: [{ path: join(dir, 'docs'), name: 'docs' }] }));

/** A model that asks to run the commands in `script`, one per answer, then says it is done. */
const script: Array<{ command: string; why: string }> = [];
const seen: Array<{ messages: Array<{ role: string; content: string | null }>; tools?: Array<{ function: { name: string } }> }> = [];
const llm = createServer((req: IncomingMessage, res: ServerResponse) => {
  let raw = '';
  req.on('data', (c) => (raw += c));
  req.on('end', () => {
    const body = JSON.parse(raw);
    seen.push(body);
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    const send = (o: unknown) => res.write(`data: ${JSON.stringify(o)}\n\n`);
    const last = body.messages[body.messages.length - 1];
    const next = last.role === 'user' ? script.shift() : undefined;
    if (next) {
      send({ model: 'fake', choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: `call_${seen.length}`, type: 'function', function: { name: 'run_command', arguments: JSON.stringify(next) } }] }, finish_reason: null }] });
      send({ model: 'fake', choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }], usage: { prompt_tokens: 10, completion_tokens: 2 } });
    } else {
      send({ model: 'fake', choices: [{ index: 0, delta: { content: 'Done.' }, finish_reason: null }] });
      send({ model: 'fake', choices: [{ index: 0, delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 10, completion_tokens: 2 } });
    }
    res.end('data: [DONE]\n\n');
  });
});
await new Promise<void>((r) => llm.listen(0, '127.0.0.1', r));

Object.assign(process.env, {
  MCP_STORE: 'sqlite',
  MCP_DATA_DIR: join(dir, 'data'),
  MCP_CONFIG_PATH: join(dir, 'mcp.config.json'),
  MCP_ENV_FILE: 'none',
  KMCP_SUPERVISE: 'false',
  KNOWLEDGE_CONSOLE: 'on',
  KNOWLEDGE_SCAN_ENABLED: 'false',
  PORT: '0',
  LLM_PROVIDER: 'openai',
  LLM_BASE_URL: `http://127.0.0.1:${(llm.address() as AddressInfo).port}/v1`,
  LLM_MODEL: 'fake',
  // A key of the server's: a command must not see it.
  LLM_API_KEY: 'server-secret-123',
});

const { runCommand, decide, plainOutput, commandEnv, workspaceDir, TERMINAL_TOOL } = await import('../src/admin/terminal.js');
const { consoleToken } = await import('../src/admin/auth.js');
const { runHttp } = await import('../src/server/http.js');
const { Registry } = await import('../src/plugin/registry.js');
const { builtinPlugins } = await import('../src/plugins/index.js');

const registry = new Registry(builtinPlugins);
const server = await runHttp(registry);
const base = `http://localhost:${server.port}`;
const token = consoleToken();
after(async () => {
  llm.close();
  await server.close();
});
const api = async (method: string, path: string, body?: unknown) => {
  const res = await fetch(`${base}/console/api${path}`, { method, headers: { Authorization: `Bearer ${token}`, ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await res.text();
  let json: any = null;
  try {
    json = JSON.parse(text);
  } catch {
    /* not JSON */
  }
  return { status: res.status, json, text };
};

type Said = { type: string; id?: string; [k: string]: unknown };
/** runCommand with the person's answer given as soon as it is asked for (or never). */
async function run(command: string, answer: boolean | null, opts: { chatId?: string; signal?: AbortSignal; why?: string } = {}) {
  const said: Said[] = [];
  const r = await runCommand(
    { command, why: opts.why ?? 'A test.' },
    {
      chatId: opts.chatId ?? 'chat-1',
      callId: 'call-1',
      signal: opts.signal ?? new AbortController().signal,
      say: (e) => {
        said.push(e as Said);
        if (e.type === 'approve' && answer !== null) setImmediate(() => decide(e.id, answer));
      },
    },
  );
  return { ...r, said, output: said.filter((e) => e.type === 'output').map((e) => e.text).join('') };
}
const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};
const until = async (what: () => boolean, ms = 10_000) => {
  const end = Date.now() + ms;
  while (!what()) {
    if (Date.now() > end) throw new Error('waited too long');
    await new Promise((r) => setTimeout(r, 25));
  }
};

test('a command runs only when approved, in its own folder, without the server keys', { skip: process.platform === 'win32' }, async () => {
  const ran = await run('echo "key=[$LLM_API_KEY]"; echo "skills=$KNOWLEDGE_SKILLS_DIR"; pwd; printf "%s%s\\n" wh oops >&2', true);
  assert.equal(ran.ok, true, ran.text);
  assert.match(ran.text, /^It ended with exit code 0 after \d+ s\./);
  assert.match(ran.text, /key=\[\]/);
  assert.ok(!ran.text.includes('server-secret-123'));
  assert.match(ran.text, /skills=.*skills/);
  assert.ok(ran.text.includes(workspaceDir()) || ran.text.includes(workspaceDir().replace(/^\/private/, '')), ran.text);
  assert.match(ran.text, /whoops/);
  assert.deepEqual(ran.said.map((e) => e.type).filter((t) => t !== 'output'), ['approve', 'decided', 'ran']);
  assert.match(ran.output, /key=\[\]/);
  assert.equal(commandEnv({ PATH: '/bin', OPENAI_API_KEY: 'x', GITHUB_PAT: 'y' }).OPENAI_API_KEY, undefined);

  // Declined: it does not run, and the model is told not to try another way.
  const marker = join(workspaceDir(), 'declined.txt');
  const no = await run(`touch "${marker}"`, false);
  assert.deepEqual([no.ok, existsSync(marker)], [false, false]);
  assert.match(no.text, /chose not to run it/);

  // A failing command says its exit code.
  const bad = await run('echo nope; exit 3', true);
  assert.equal(bad.ok, false);
  assert.match(bad.text, /exit code 3/);

  // Every command asked for is in the log as it happens, the output is not.
  const log = readFileSync(join(dir, 'data', 'terminal.log'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  assert.deepEqual(log.map((l) => l.event), ['asked', 'started', 'ended', 'asked', 'declined', 'asked', 'started', 'ended']);
  assert.deepEqual(log.filter((l) => l.event === 'ended').map((l) => l.exit), [0, 3]);
  assert.ok(!JSON.stringify(log).includes('whoops'));
});

test('what is refused, and what stops a command', { skip: process.platform === 'win32' }, async () => {
  // No reason given: the person would approve without knowing why.
  assert.match((await run('echo hi', true, { why: ' ' })).text, /Say in `why`/);
  // One command per conversation at a time.
  process.env.TERMINAL_ASK_MS = '300';
  const waiting = run('echo first', null, { chatId: 'busy' });
  await new Promise((r) => setTimeout(r, 50));
  assert.match((await run('echo second', true, { chatId: 'busy' })).text, /waiting or running already/);
  // Not answered in time: not run.
  assert.match((await waiting).text, /No one approved it within/);
  delete process.env.TERMINAL_ASK_MS;

  // Stopping the conversation stops the command and what it started.
  const stop = new AbortController();
  const pidFile = join(workspaceDir(), 'child.pid');
  const going = run(`sleep 30 & echo $! > "${pidFile}"; wait`, true, { signal: stop.signal });
  await until(() => existsSync(pidFile) && readFileSync(pidFile, 'utf8').trim() !== '');
  const child = Number(readFileSync(pidFile, 'utf8'));
  assert.ok(alive(child));
  const t0 = Date.now();
  stop.abort();
  const stopped = await going;
  assert.match(stopped.text, /It was stopped: the person stopped the conversation/);
  assert.ok(Date.now() - t0 < 5_000);
  await until(() => !alive(child), 5_000);

  // The time limit.
  process.env.TERMINAL_TIMEOUT_MS = '300';
  const late = await run('sleep 20', true);
  delete process.env.TERMINAL_TIMEOUT_MS;
  assert.deepEqual([late.ok, /stopped after/.test(late.text)], [false, true]);

  // Turned off.
  process.env.KNOWLEDGE_TERMINAL = 'false';
  assert.match((await run('echo hi', true)).text, /turned off/);
  delete process.env.KNOWLEDGE_TERMINAL;

  // Output as a page shows it: no colour codes, a redrawn line as its last state.
  assert.equal(plainOutput('\x1b[32mok\x1b[0m\nload 10%\rload 100%\n'), 'ok\nload 100%\n');
});

test('in the chat: the command waits for Run, is shown when the page is opened again, and connectors never see it', { skip: process.platform === 'win32' }, async () => {
  // Not an MCP tool: an assistant connected with a key cannot list or call it.
  const { pingTool } = await import('../src/plugin/ping.js');
  assert.ok(!registry.listTools(pingTool).some((t) => t.name === TERMINAL_TOOL));
  const byHand = await api('POST', '/run', { name: TERMINAL_TOOL, args: { command: 'echo hi', why: 'x' } });
  assert.equal(byHand.json?.ok, false, byHand.text);
  // The console's chat is offered it.
  assert.ok((await api('GET', '/chat')).json.tools.includes(TERMINAL_TOOL));

  script.push({ command: 'echo made > made.txt && cat made.txt', why: 'Writes a file to show it ran.' });
  const res = await fetch(`${base}/console/api/chat`, { method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ message: 'Make a file.' }) });
  const reader = res.body!.getReader();
  const events: Said[] = [];
  let rest = '';
  const read = async (until: (e: Said) => boolean) => {
    for (;;) {
      const found = events.find(until);
      if (found) return found;
      const { value, done } = await reader.read();
      if (done) throw new Error(`the stream ended: ${JSON.stringify(events.map((e) => e.type))}`);
      rest += new TextDecoder().decode(value);
      const lines = rest.split('\n');
      rest = lines.pop()!;
      for (const l of lines) if (l.trim()) events.push(JSON.parse(l));
    }
  };
  const chatId = (await read((e) => e.type === 'chat')).id!;
  const ask = await read((e) => e.type === 'approve');
  assert.deepEqual([ask.command, ask.why, ask.callId], ['echo made > made.txt && cat made.txt', 'Writes a file to show it ran.', 'call_1']);
  // Nothing ran yet; the conversation opened elsewhere shows the command waiting.
  assert.equal(existsSync(join(workspaceDir(), 'made.txt')), false);
  const opened = await api('GET', `/chats/${chatId}`);
  assert.deepEqual(opened.json.commands.map((c: { id: string; state: string }) => [c.id, c.state]), [[ask.id, 'waiting']]);
  // An answer for a command that does not wait is refused.
  assert.equal((await api('POST', '/chat/commands/nope', { run: true })).status, 404);
  assert.equal((await api('POST', `/chat/commands/${ask.id}`, { run: 'yes' })).status, 400);

  assert.equal((await api('POST', `/chat/commands/${ask.id}`, { run: true })).status, 200);
  const result = await read((e) => e.type === 'result');
  assert.equal(result.ok, true, String(result.text));
  assert.match(String(result.text), /made/);
  await read((e) => e.type === 'done');
  assert.equal(readFileSync(join(workspaceDir(), 'made.txt'), 'utf8'), 'made\n');
  // The model was told how to use it, and got the output back.
  assert.match(seen[0].messages[0].content ?? '', /use run_command/);
  // Answered twice: refused, it no longer waits.
  assert.equal((await api('POST', `/chat/commands/${ask.id}`, { run: true })).status, 404);
  // Kept with the conversation like any tool call.
  const kept = (await api('GET', `/chats/${chatId}`)).json;
  assert.deepEqual([kept.commands, kept.turns[1].calls[0].name, kept.turns[1].calls[0].ok], [[], TERMINAL_TOOL, true]);
});

test('what the review found: hidden characters, background jobs, long lines, the server stopping', { skip: process.platform === 'win32' }, async () => {
  // What the person reads is what runs: a direction mark could show "echo ... # touch pwned" and run touch.
  const pwned = join(workspaceDir(), 'pwned');
  for (const command of [
    `echo 'Skill installed ⁧' ;touch "${pwned}" #⁦`,
    `touch "${pwned}"​`,
    `echo ok\rtouch "${pwned}"`,
    `touch "${pwned}"${'\n'.repeat(3)}echo 'Font installed'`,
    `echo hi${' '.repeat(80)}; touch "${pwned}"`,
    Array.from({ length: 61 }, (_, i) => `echo ${i}`).join('\n'),
  ]) {
    const r = await run(command, true);
    assert.equal(r.ok, false, command);
    assert.match(r.text, /cannot be seen|blank lines|run of spaces|more than 60 lines/);
    assert.ok(!r.said.some((e) => e.type === 'approve'), 'never shown, never asked');
  }
  assert.equal(existsSync(pwned), false);
  // Korean and other letters are fine (the page warns about letters that are not plain ASCII).
  assert.equal((await run('echo "설치했습니다"', true)).ok, true);

  // A job left in the background holds the output open: the command still ends, and so does the job.
  const pidFile = join(workspaceDir(), 'bg.pid');
  const t0 = Date.now();
  const bg = await run(`sleep 25 & echo $! > "${pidFile}"`, true);
  assert.ok(Date.now() - t0 < 8_000, `${Date.now() - t0} ms`);
  assert.equal(bg.ok, true, bg.text);
  await until(() => !alive(Number(readFileSync(pidFile, 'utf8'))), 6_000);
  // One that ignores the polite signal, after its shell is gone, is made to stop.
  const stop = new AbortController();
  const stubborn = run(`(trap '' TERM; exec sleep 20) >/dev/null 2>&1 & echo $! > "${pidFile}"; wait`, true, { signal: stop.signal });
  await until(() => existsSync(pidFile) && readFileSync(pidFile, 'utf8').trim() !== '' && alive(Number(readFileSync(pidFile, 'utf8'))));
  const stubbornPid = Number(readFileSync(pidFile, 'utf8'));
  stop.abort();
  await stubborn;
  await until(() => !alive(stubbornPid), 8_000);

  // A long output without line breaks costs time in proportion to its length.
  const t1 = Date.now();
  plainOutput('x'.repeat(1_000_000));
  plainOutput('\r'.repeat(200_000) + 'y'.repeat(200_000));
  assert.ok(Date.now() - t1 < 500, `${Date.now() - t1} ms`);

  // A page is sent a bounded amount at a time; text split between chunks is put together again.
  const big = await run(`i=0; while [ $i -lt 4000 ]; do printf '한국어 출력 줄 %s\\n' "$i"; i=$((i+1)); done`, true);
  assert.equal(big.ok, true, big.text.slice(0, 200));
  assert.ok(!big.output.includes('�') && !big.text.includes('�'));
  assert.ok(big.said.filter((e) => e.type === 'output').every((e) => String(e.text).length <= 16_100));

  // Not the person's own shell: its start-up files (and keys in them) are not read.
  const home = mkdtempSync(join(tmpdir(), 'kmcp-home-'));
  writeFileSync(join(home, '.zshenv'), 'export ZSH_SECRET=leaked\n');
  const was = { HOME: process.env.HOME, SHELL: process.env.SHELL };
  Object.assign(process.env, { HOME: home, SHELL: '/bin/zsh' });
  const shell = await run('echo "[$ZSH_SECRET]"', true);
  Object.assign(process.env, was);
  assert.match(shell.text, /\[\]/);

  // Refused before asking is logged as well.
  const log = readFileSync(join(dir, 'data', 'terminal.log'), 'utf8');
  assert.match(log, /"event":"refused"/);
});

test('when the server is stopped with Ctrl+C, the command it runs stops too, and the log says so', { skip: process.platform === 'win32' }, async () => {
  const here = mkdtempSync(join(tmpdir(), 'kmcp-sigint-'));
  const pidFile = join(here, 'child.pid');
  const terminal = fileURLToPath(new URL('../src/admin/terminal.ts', import.meta.url));
  writeFileSync(
    join(here, 'run.mts'),
    `const { runCommand, decide } = await import(${JSON.stringify(terminal)});
     setInterval(() => undefined, 1000);
     await runCommand({ command: 'sleep 30 & echo $! > ${pidFile}; wait', why: 'A test.' }, { chatId: 'c', callId: 'k', signal: new AbortController().signal, say: (e) => { if (e.type === 'approve') setImmediate(() => decide(e.id, true)); } });`,
  );
  writeFileSync(join(here, 'mcp.config.json'), JSON.stringify({ folders: [] }));
  const server = spawn(process.execPath, ['--import', 'tsx', join(here, 'run.mts')], {
    cwd: process.cwd(),
    env: { ...process.env, MCP_DATA_DIR: join(here, 'data'), MCP_CONFIG_PATH: join(here, 'mcp.config.json'), MCP_ENV_FILE: 'none' },
    stdio: 'ignore',
  });
  await until(() => existsSync(pidFile) && readFileSync(pidFile, 'utf8').trim() !== '', 20_000);
  const child = Number(readFileSync(pidFile, 'utf8'));
  assert.ok(alive(child));
  server.kill('SIGINT');
  const how = await new Promise<string>((r) => server.on('exit', (code, sig) => r(String(sig ?? code))));
  assert.equal(how, 'SIGINT');
  await until(() => !alive(child), 5_000);
  const log = readFileSync(join(here, 'data', 'terminal.log'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  assert.deepEqual(log.map((l) => l.event), ['asked', 'started', 'ended']);
  assert.equal(log[2].because, 'the server got SIGINT');
});
