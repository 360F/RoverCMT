// Ported from read-only fork fd461737. See source-map.json.
import { compositeFluxOutput } from "./imageRaster.mjs";
import { expandWindowMaskToPage, } from "./inpaintingWindowMask.mjs";
export function compositeConstrainedFluxOutput(options) {
    const masks = resolveFluxCompositeMasks(options);
    compositeFluxOutput(options.bitmap, options.generated, masks.core, options.width, options.crop.paddedBounds, options.featherPx, options.crop.writeBounds, masks.constraint);
}
function resolveFluxCompositeMasks(options) {
    const constraint = options.compositeConstraints?.[options.index] ?? null;
    if (!options.compositeConstraints && !options.compositeMasks) {
        return { core: options.effectiveMask };
    }
    const coreWindow = options.compositeMasks?.[options.index] ??
        options.windowMask?.core ??
        options.coreWindowMasks?.[options.index];
    if (!coreWindow) {
        throw new Error("Flux composite constraint is missing its owned core mask.");
    }
    return {
        core: expandWindowMaskToPage(coreWindow, options.width, options.height),
        ...(constraint
            ? {
                constraint: expandWindowMaskToPage(constraint, options.width, options.height),
            }
            : {}),
    };
}
