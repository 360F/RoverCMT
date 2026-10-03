// Ported from read-only fork fd461737. See source-map.json.
import { join } from "node:path";
import { writePngFromBitmap, writePngFromMask } from "./imageRaster.mjs";
export function resolveFluxCropPaths(runDir, index, tileIndex) {
    const stem = `${index}-${tileIndex}`;
    return {
        inputPath: join(runDir, `input-${stem}.png`),
        maskPath: join(runDir, `mask-${stem}.png`),
        outputPath: join(runDir, `output-${stem}.png`),
    };
}
export async function writeFluxCropInputs(paths, crop, cropBitmap) {
    await writePngFromBitmap(paths.inputPath, cropBitmap, crop.paddedBounds.w, crop.paddedBounds.h, crop.processSize);
    await writePngFromMask(paths.maskPath, crop.localMask, crop.paddedBounds.w, crop.paddedBounds.h, crop.processSize);
}
