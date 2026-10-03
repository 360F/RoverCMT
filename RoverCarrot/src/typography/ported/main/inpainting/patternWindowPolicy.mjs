// Ported from read-only fork fd461737. See source-map.json.
import { mergeRects } from "./maskGeometry.mjs";
export function resolvePatternInpaintWindows(windows, engine, options = {}) {
    if ((engine.model === "codex" && options.preserveBlockOwnership) ||
        (engine.model === "flux-klein" &&
            (engine.backend === "metal-native" || options.preserveBlockOwnership))) {
        return windows.map((window) => ({ ...window }));
    }
    return mergeRects(windows);
}
