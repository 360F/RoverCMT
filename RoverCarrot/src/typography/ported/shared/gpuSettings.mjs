// Ported from read-only fork fd461737. See source-map.json.
export const MIN_COMPUTE_GPU_INDEX = 0;
export const MAX_COMPUTE_GPU_INDEX = 15;
export function normalizeGraphicsGpuPreference(value, fallback = "auto") {
    return value === "high-performance" || value === "auto" ? value : fallback;
}
export function normalizeComputeGpuIndex(value) {
    if (value === null || value === undefined || value === "") {
        return undefined;
    }
    const parsed = typeof value === "number"
        ? value
        : typeof value === "string"
            ? Number(value)
            : Number.NaN;
    return Number.isInteger(parsed) &&
        parsed >= MIN_COMPUTE_GPU_INDEX &&
        parsed <= MAX_COMPUTE_GPU_INDEX
        ? parsed
        : undefined;
}
/** Full physical-device UUIDs only; never accept an ambiguous CUDA prefix/list. */
export function normalizeNvidiaGpuUuid(value) {
    if (typeof value !== "string")
        return undefined;
    const uuid = value.trim();
    return /^GPU-[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i.test(uuid)
        ? `GPU-${uuid.slice(4).toLowerCase()}`
        : undefined;
}
