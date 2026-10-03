// Ported from read-only fork fd461737. See source-map.json.
import { FLUX_INPAINT_MULTIPLE, FLUX_METAL_TILE_SIZE_PX, } from "./fluxEngineConstants.mjs";
import { buildLocalMask, maskBoundsInRect } from "./imageRaster.mjs";
import { alignRectToMultiple, expandRect, rectHasMask, resolveContextTiles, resolveFluxProcessSize, } from "./maskGeometry.mjs";
export function prepareFluxWindowCrops(options) {
    if (!rectHasMask(options.mask, options.width, options.window)) {
        return [];
    }
    const maskBounds = maskBoundsInRect(options.mask, options.width, options.window);
    if (!maskBounds) {
        return [];
    }
    const paddedBounds = alignRectToMultiple(expandRect(maskBounds, options.width, options.height, options.contextPx + options.maskPaddingPx), options.width, options.height, FLUX_INPAINT_MULTIPLE);
    const tiles = resolveCropTiles(options, maskBounds, paddedBounds);
    return tiles.flatMap(({ cropBounds, writeBounds }) => {
        const localMask = buildLocalMask(options.inputMask ?? options.mask, options.width, cropBounds, options.inputMaskPaddingPx ?? options.maskPaddingPx);
        if (!localMask.some((value) => value > 0)) {
            return [];
        }
        return [
            {
                localMask,
                paddedBounds: cropBounds,
                processSize: options.tileLargeCrops
                    ? { width: cropBounds.w, height: cropBounds.h }
                    : resolveFluxProcessSize(cropBounds.w, cropBounds.h, options.maxPixels, FLUX_INPAINT_MULTIPLE),
                validationMask: buildValidationMask(options.mask, options.width, cropBounds, writeBounds),
                writeBounds,
            },
        ];
    });
}
function resolveCropTiles(options, maskBounds, paddedBounds) {
    if (!options.tileLargeCrops ||
        (paddedBounds.w <= FLUX_METAL_TILE_SIZE_PX &&
            paddedBounds.h <= FLUX_METAL_TILE_SIZE_PX)) {
        return [{ cropBounds: paddedBounds, writeBounds: paddedBounds }];
    }
    return resolveContextTiles(expandRect(maskBounds, options.width, options.height, options.featherPx), options.width, options.height, FLUX_METAL_TILE_SIZE_PX, options.contextPx + options.maskPaddingPx, FLUX_INPAINT_MULTIPLE);
}
function buildValidationMask(mask, pageWidth, cropBounds, writeBounds) {
    const validationMask = buildLocalMask(mask, pageWidth, cropBounds, 0);
    const startX = Math.max(0, writeBounds.x - cropBounds.x);
    const startY = Math.max(0, writeBounds.y - cropBounds.y);
    const endX = Math.min(cropBounds.w, startX + writeBounds.w);
    const endY = Math.min(cropBounds.h, startY + writeBounds.h);
    for (let y = 0; y < cropBounds.h; y += 1) {
        for (let x = 0; x < cropBounds.w; x += 1) {
            if (x < startX || x >= endX || y < startY || y >= endY) {
                validationMask[y * cropBounds.w + x] = 0;
            }
        }
    }
    return validationMask;
}
