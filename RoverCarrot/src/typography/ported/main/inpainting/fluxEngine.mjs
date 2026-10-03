// Ported from read-only fork fd461737. See source-map.json.
import { basename, dirname, join, resolve } from "node:path";
import { safeCleanup } from "../safeCleanup.mjs";
import { FluxWorker } from "./fluxWorker.mjs";
import { runFluxInpaint, } from "./fluxEngineRunner.mjs";
import { FLUX_INPAINT_CONTEXT_PX, FLUX_METAL_INPAINT_CONTEXT_PX, } from "./fluxEngineConstants.mjs";
const productionRuntime = {
    runInpaint: runFluxInpaint,
};
export function createFluxEngine(options, runtime = productionRuntime) {
    let worker = null;
    const getWorker = () => {
        if (worker && !worker.isHealthy()) {
            void safeCleanup("dispose unhealthy Flux worker", () => worker?.dispose());
            worker = null;
        }
        worker ??= new FluxWorker(options.launch, {
            diagnostics: options.diagnostics,
        });
        return worker;
    };
    return {
        model: "flux-klein",
        runtimePath: options.launch.runtimePath,
        modelPath: options.modelPath,
        vaePath: options.vaePath,
        backend: options.launch.backend,
        runRootDir: options.runRootDir,
        isHealthy() {
            return !worker || worker.isHealthy();
        },
        async inpaint(bitmap, width, height, mask, windows, runOptions = {}) {
            const resolvedRunOptions = options.launch.backend === "metal-native"
                ? {
                    ...runOptions,
                    contextPx: Math.min(runOptions.contextPx ?? FLUX_INPAINT_CONTEXT_PX, FLUX_METAL_INPAINT_CONTEXT_PX),
                }
                : runOptions;
            await runtime.runInpaint({
                bitmap,
                getWorker,
                height,
                isolateWindowMasks: options.launch.backend === "metal-native",
                tileLargeCrops: options.launch.backend === "metal-native" ||
                    options.launch.backend === "cpu-native" ||
                    options.sm75Fp16Enabled === true,
                mask,
                runOptions: resolvedRunOptions,
                runRootDir: options.runRootDir,
                width,
                windows,
            }, options.diagnostics);
        },
        async dispose() {
            await worker?.dispose();
            worker = null;
        },
    };
}
export function resolveDefaultFluxRunRootDir(runtimeDir) {
    const resolvedRuntimeDir = resolve(runtimeDir);
    const inpaintingDir = dirname(resolvedRuntimeDir);
    const modelsDir = dirname(inpaintingDir);
    if (basename(inpaintingDir).toLowerCase() === "inpainting" &&
        basename(modelsDir).toLowerCase() === "models") {
        return join(dirname(modelsDir), "tmp", "runtime", "flux-inpainting");
    }
    return join(resolvedRuntimeDir, "tmp", "flux-inpainting");
}
