// Ported from read-only fork fd461737. See source-map.json.
import { prepareFluxWindowCrops, } from "./fluxCropTiling.mjs";
import { isolateMaskToWindow } from "./imageRaster.mjs";
import { expandWindowMaskToPage, } from "./inpaintingWindowMask.mjs";
export function prepareFluxWindow(options) {
    let effectiveMask = options.mask;
    let inputMask;
    if (options.isolateWindowMasks) {
        effectiveMask = options.windowMask
            ? expandWindowMaskToPage(options.windowMask.core, options.width, options.height)
            : isolateMaskToWindow(options.mask, options.width, options.window);
        inputMask = options.windowMask
            ? expandWindowMaskToPage(options.windowMask.input, options.width, options.height)
            : undefined;
    }
    return {
        effectiveMask,
        crops: prepareFluxWindowCrops({
            ...options.cropOptions,
            height: options.height,
            inputMask,
            inputMaskPaddingPx: inputMask ? 0 : undefined,
            mask: effectiveMask,
            tileLargeCrops: options.tileLargeCrops,
            width: options.width,
            window: options.window,
        }),
    };
}
