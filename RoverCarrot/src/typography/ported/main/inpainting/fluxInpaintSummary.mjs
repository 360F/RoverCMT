// Ported from read-only fork fd461737. See source-map.json.
export function reportFluxInpaintSummary({ coveredWindows, eligibleWindows, processedWindows, unchangedStats, unchangedWindows, }, diagnostics, requirePixelChange) {
    const skippedWindows = Math.max(0, eligibleWindows - processedWindows - coveredWindows);
    if (skippedWindows > 0) {
        diagnostics.warn(processedWindows === 0
            ? "Flux inpainting skipped every eligible crop"
            : "Flux inpainting skipped one or more eligible crops", {
            eligibleWindows,
            processedWindows,
        });
    }
    if (processedWindows === 0) {
        if (eligibleWindows === 0) {
            diagnostics.warn("Flux inpainting received no eligible crop", {
                eligibleWindows,
            });
        }
        if (requirePixelChange && skippedWindows > 0) {
            throw new Error("인페인팅 결과가 생성되지 않았습니다.");
        }
        return;
    }
    if (processedWindows <= 0 || unchangedWindows <= 0)
        return;
    diagnostics.warn(unchangedWindows === processedWindows
        ? "Flux inpainting left every masked crop effectively unchanged"
        : "Flux inpainting left one or more masked crops effectively unchanged", { eligibleWindows, processedWindows, unchangedStats });
    const changedWindows = processedWindows - unchangedWindows;
    if (requirePixelChange && changedWindows <= 0) {
        throw new Error("인페인팅 결과가 생성되지 않았습니다.");
    }
}
