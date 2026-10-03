// Ported from read-only fork fd461737. See source-map.json.
import { normalizeComputeGpuIndex, normalizeNvidiaGpuUuid, } from "../../shared/gpuSettings.mjs";
const GPU_VISIBILITY_ENV_KEYS = [
    "CUDA_VISIBLE_DEVICES",
    "HIP_VISIBLE_DEVICES",
    "ROCR_VISIBLE_DEVICES",
    "GPU_DEVICE_ORDINAL",
];
export function applyComputeGpuVisibilityEnv(env, computeGpuSelection, backend, platform = process.platform) {
    const index = normalizeComputeGpuIndex(computeGpuSelection);
    const isolationKey = resolveGpuIsolationKey(backend, platform);
    const uuid = isolationKey === "CUDA_VISIBLE_DEVICES"
        ? normalizeNvidiaGpuUuid(computeGpuSelection)
        : undefined;
    const device = uuid ?? (index === undefined ? undefined : String(index));
    if (device === undefined || !isolationKey) {
        return;
    }
    for (const key of GPU_VISIBILITY_ENV_KEYS) {
        delete env[key];
    }
    env[isolationKey] = device;
}
function resolveGpuIsolationKey(backend, platform) {
    if (backend === "cuda" || backend === "cuda-native") {
        return "CUDA_VISIBLE_DEVICES";
    }
    if (backend === "rocm-transformers" ||
        backend === "python-rocm" ||
        backend === "zluda-native") {
        return platform === "win32"
            ? "HIP_VISIBLE_DEVICES"
            : "ROCR_VISIBLE_DEVICES";
    }
    return null;
}
