// Model-free protocol fixture. Only its own child/process group is affected.
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { createInterface } from 'node:readline';
import { appendFileSync, readFileSync, writeFileSync } from 'node:fs';
import { PNG } from 'pngjs';
const mode = process.argv[2] ?? 'normal';
const record = value => { if (process.env.REQUEST_LOG) appendFileSync(process.env.REQUEST_LOG, JSON.stringify({ pid: process.pid, ...value }) + '\n'); };
const keepAlive = setInterval(() => {}, 1000);
record({ type: 'startup' });
const descendant = mode === 'tree' ? spawn(process.execPath, ['-e', 'setInterval(()=>{},1000)'], { stdio: 'ignore' }) : undefined;
if (descendant) record({ type: 'descendant', childPid: descendant.pid });
process.stderr.write('mgt-flux-klein: fixture ready\n');
if (mode === 'cpu-fallback') {
  process.stderr.write('WARN koharu_runtime: falling back');
  await new Promise(resolve => setTimeout(resolve, 25));
  process.stderr.write(' to CPU.\n');
  await new Promise(() => {});
}
if (mode === 'startup-crash') process.exit(9);
for await (const line of createInterface({ input: process.stdin })) {
  const request = JSON.parse(line); record(request);
  if (request.type === 'shutdown') {
    if (mode === 'ignore-shutdown') { await new Promise(() => {}); }
    if (descendant) { const closed = once(descendant, 'exit'); descendant.kill('SIGTERM'); await closed; }
    break;
  }
  if (mode === 'crash') process.exit(7);
  if (mode === 'hang') { await new Promise(() => {}); }
  if (mode === 'error') { console.log(JSON.stringify({ id: request.id, ok: false, error: 'fixture failure' })); continue; }
  if (request.input && request.output) {
    const image = PNG.sync.read(readFileSync(request.input));
    if (mode !== 'unchanged') for (let i = 0; i < image.data.length; i += 4) image.data.set([37, 91, 173, 255], i);
    writeFileSync(request.output, PNG.sync.write(image));
  }
  console.log(JSON.stringify({ id: request.id, ok: true, elapsed_ms: 1 }));
}
clearInterval(keepAlive);
record({ type: 'exit' });
