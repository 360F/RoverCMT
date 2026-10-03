// Exact deterministic differential on real bound pages; never edits source data.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { PNG } from 'pngjs';
import { differentialPage, differentialArtifact, differentialRequests, differentialGeometry } from '../tests/erase-differential.mjs';
const [contextFile, destination, mode] = process.argv.slice(2);
if (!contextFile || !destination) throw new Error('Usage: node tools/validate-erase.mjs <Step3-bound-context.json> <new-evidence-directory>');
if (mode !== undefined && mode !== 'geometry-only') throw new Error('Optional mode: geometry-only');
const root = resolve(destination); await mkdir(root); // refuse an existing directory
const context = JSON.parse(await readFile(contextFile, 'utf8'));
const chapterPath = context.bindings[0].chapter, chapterBytes = await readFile(chapterPath), chapter = JSON.parse(chapterBytes);
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const windowsPath = path => /^[a-z]:/i.test(path) ? `/mnt/${path[0].toLowerCase()}${path.slice(2).replace(/\\+/g, '/')}` : path;
const pages = [];
for (const stored of chapter.pages.filter(p => p.blocks.length)) {
  const path = windowsPath(stored.imagePath), bytes = await readFile(path), decoded = PNG.sync.read(bytes);
  // Independent opaque PNG decode: no Rover native-image shim used by either
  // side of this algorithm comparison. Detect alpha rather than flatten it.
  const bitmap = Buffer.alloc(decoded.width * decoded.height * 4);
  for (let i = 0; i < bitmap.length; i += 4) {
    assert.equal(decoded.data[i + 3], 255, 'Real reference page must be opaque');
    bitmap.set([decoded.data[i + 2], decoded.data[i + 1], decoded.data[i], 255], i);
  }
  const page = { ...stored, imagePath: path };
  assert.equal(page.width, decoded.width); assert.equal(page.height, decoded.height);
  const baseline = mode ? differentialGeometry(page, bitmap) : differentialPage(page, bitmap);
  const constrainedIds = page.blocks.filter(b => b.bubbleLayout).map(b => b.id);
  const constrained = mode ? baseline : differentialPage(page, bitmap, { bubbleLayoutConstraintBlockIds: constrainedIds });
  pages.push({ pageId: page.id, path, bytes: bytes.length, sha256: digest(bytes), storedLayouts: constrainedIds.length, baseline, constrained });
  console.log(JSON.stringify({ pageId: page.id, baseline, constrained }));
}
const requests = await differentialRequests(root), artifact = await differentialArtifact(root);
assert.deepEqual(await readFile(chapterPath), chapterBytes);
const summary = { status: 'PASS', mode: mode ?? 'full-fixed-context64', reference: 'fd461737 unmodified TS in-memory', chapterPath, chapterSha256: digest(chapterBytes), pages, requests, artifact,
  limitation: 'Independent PNG codec on opaque inputs; no Electron resize/colour-profile equivalence claim. Diffusion pixels are not compared.' };
await writeFile(join(root, 'summary.json'), JSON.stringify(summary, null, 2) + '\n', { flag: 'wx' });
console.log(JSON.stringify({ status: summary.status, pages: pages.length, summary: join(root, 'summary.json') }));
