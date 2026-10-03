// Provenance check, not independent behavioral review. Read-only source/ Git probes.
import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { resolve, join } from 'node:path';
import ts from 'typescript';
const root = resolve('..'), mirror = resolve('src/typography/ported');
const mapping = JSON.parse(await readFile(join(mirror, 'source-map.json'), 'utf8'));
const baseline = JSON.parse(execFileSync('git', ['show', '45797b19:RoverCarrot/src/typography/ported/source-map.json'], { encoding: 'utf8' }));
assert.deepEqual(Object.keys(mapping).slice(0, Object.keys(baseline).length), Object.keys(baseline), 'Step 5 entry order must stay unchanged');
for (const [key, value] of Object.entries(baseline)) assert.equal(mapping[key], value);
const adaptations = JSON.parse(await readFile(join(mirror, 'erase-adaptations.json'), 'utf8'));
const printer = ts.createPrinter({ removeComments: true });
const canonical = source => printer.printFile(ts.createSourceFile('port.mjs', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS));
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const mechanical = [], adapted = [];
for (const [port, reference] of Object.entries(mapping).filter(([p]) => !(p in baseline))) {
  const bytes = await readFile(join(root, reference)), actual = await readFile(join(mirror, port));
  if (port in adaptations) {
    assert.equal(hash(bytes), adaptations[port].referenceSha256); assert.equal(hash(actual), adaptations[port].portSha256);
    adapted.push(port); continue;
  }
  const expected = ts.transpileModule(String(bytes), { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2024 } }).outputText
    .replace(/(from\s+['"])(\.[^'"]+)(['"])/g, '$1$2.mjs$3');
  assert.equal(canonical(String(actual)), canonical(expected), `Undocumented algorithm change: ${port}`);
  mechanical.push(port);
}
let rustFiles = 0;
async function compareTrees(relative) {
  const reference = join(root, 'tools', relative), port = resolve('runtime/flux', relative);
  const sourceEntries = await readdir(reference, { withFileTypes: true });
  const relevant = sourceEntries.filter(e => e.name !== 'target' && !e.name.startsWith('.'));
  // Reference build outputs are ignored; copied source tree must match per file.
  for (const entry of relevant) {
    const next = join(relative, entry.name);
    if (entry.isDirectory()) await compareTrees(next);
    else { assert.deepEqual(await readFile(resolve('runtime/flux', next)), await readFile(join(root, 'tools', next)), next); rustFiles++; }
  }
  void port;
}
await compareTrees('mgt-flux-klein-runner'); await compareTrees('runner-runtime-policy');
const cargoLockSha256 = hash(await readFile('runtime/flux/mgt-flux-klein-runner/Cargo.lock'));
assert.equal(cargoLockSha256, '79be450b73763f9219a0fd0dec4006135e5d0d1a361cd16e643f2279a974ed86');
console.log(JSON.stringify({ status: 'PASS', mechanical, adapted, rustFiles, cargoLockSha256 }, null, 2));
