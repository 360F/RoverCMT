// Ported from read-only fork fd461737. See source-map.json.
export function assertFluxMaskContracts(options) {
    const { isolateWindowMasks, runOptions, windowCount } = options;
    if (isolateWindowMasks &&
        runOptions.windowMasks &&
        runOptions.windowMasks.length !== windowCount) {
        throw new Error("Block-owned mask count does not match Flux window count.");
    }
    if (runOptions.compositeMasks &&
        runOptions.compositeMasks.length !== windowCount) {
        throw new Error("Composite mask count does not match Flux window count.");
    }
    if (!runOptions.compositeConstraints)
        return;
    if (runOptions.compositeConstraints.length !== windowCount ||
        runOptions.windowMasks?.length !== windowCount ||
        (runOptions.compositeFeatherPx !== undefined &&
            runOptions.compositeFeatherPx.length !== windowCount)) {
        throw new Error("Composite constraint count does not match Flux window count.");
    }
}
