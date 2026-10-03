// Execute unmodified root TS in memory, never the Rover port. Dependency overrides
// below are platform seams; comparisons of pure functions require no image shim.
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import ts from 'typescript';
const root = resolve('..'), external = createRequire(import.meta.url);
export function createEraseReference(overrides = {}, externals = {}) {
  const cache = new Map();
  function load(path) {
    if (path in overrides) return overrides[path];
    if (cache.has(path)) return cache.get(path).exports;
    const full = resolve(root, path), module = { exports: {} }; cache.set(path, module);
    let source = readFileSync(full, 'utf8');
    if (path === 'src/main/pageWorkflow/pageWorkflowImages.ts') {
      const ast = ts.createSourceFile(path, source, ts.ScriptTarget.Latest, true);
      source = ast.statements.filter(s => ts.isImportDeclaration(s) || ['eraseWorkflowPage', 'workflowBubbleRunner', 'acquireTimedWorkflowErasure', 'measureWorkflowInpainting', 'acquireWorkflowErasure'].includes(s.name?.text)).map(s => s.getText(ast)).join('\n');
    }
    source = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2024 } }).outputText;
    const local = specifier => specifier.startsWith('.') ? load(resolve(dirname(full), specifier + '.ts').slice(root.length + 1)) : (externals[specifier] ?? external(specifier));
    new Function('require', 'module', 'exports', source)(local, module, module.exports);
    return module.exports;
  }
  return load;
}
export const eraseReference = createEraseReference({
  'src/main/inpainting/inpaintingRuntimeLogger.ts': { logInpaintingRuntimeInfo() {}, logInpaintingRuntimeWarn() {} },
  'src/main/logger.ts': { logWarn() {} },
}, { electron: { nativeImage: {} } });
