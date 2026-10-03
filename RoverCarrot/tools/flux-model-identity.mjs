// Hash each pinned asset once; receipts are consumed by preflightFlux (Step 4 format).
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { readFile, stat, writeFile } from 'node:fs/promises';
import { resolve, basename } from 'node:path';

export async function createModelIdentity(modelPath, vaePath, outputPath, projectRoot = resolve('.')) {
  const output = resolve(outputPath);
  if (!output.startsWith(resolve(projectRoot, 'test-data') + '/')) throw new Error('Receipt must be under Git-ignored test-data/');
  const pins = JSON.parse(await readFile(resolve(projectRoot, 'runtime/flux/model-pins.json'), 'utf8'));
  const receipts = [];
  for (const [index, input] of [modelPath, vaePath].entries()) {
    const path = resolve(input), pin = pins[index], before = await stat(path, { bigint: true });
    if (!before.isFile() || basename(path) !== pin.file || before.size !== BigInt(pin.bytes)) throw new Error(`Pinned asset size/name mismatch: ${path}`);
    const hash = createHash('sha256');
    for await (const chunk of createReadStream(path)) hash.update(chunk);
    const sha256 = hash.digest('hex'), after = await stat(path, { bigint: true });
    if (sha256 !== pin.sha256 || before.size !== after.size || before.mtimeNs !== after.mtimeNs || before.ino !== after.ino)
      throw new Error(`Pinned asset changed or SHA-256 mismatch: ${path}`);
    receipts.push({ path, bytes: Number(after.size), mtimeNs: String(after.mtimeNs), sha256 });
  }
  await writeFile(output, JSON.stringify(receipts, null, 2) + '\n', { flag: 'wx' });
  return receipts;
}
if (process.argv[1] && resolve(process.argv[1]) === new URL(import.meta.url).pathname) {
  const [model, vae, output] = process.argv.slice(2);
  if (!model || !vae || !output) throw new Error('Usage: node tools/flux-model-identity.mjs <model.gguf> <vae.safetensors> <new-test-data-receipt.json>');
  console.log(JSON.stringify(await createModelIdentity(model, vae, output), null, 2));
}
