// Ported from read-only fork fd461737. See source-map.json.
import { projectWindowMask } from "./bubbleLayoutConstraintMask.mjs";
import { buildKoharuTypographyCompositeMask, resolveKoharuTypographyFeatherPx, unionWindowMasks, } from "./koharuTypographyMask.mjs";
export function resolvePatternFluxCompositePlan(options) {
    const featherPx = resolveKoharuTypographyFeatherPx(options.block, options.page);
    if (options.regionOnly)
        return {
            compositeMask: options.regionMask,
            constraint: options.regionMask,
            featherPx: 0,
            modelMask: options.regionMask,
            usesTypographySegmentation: false,
        };
    const typography = options.segmentation
        ? buildKoharuTypographyCompositeMask({
            block: options.block,
            featherPx,
            height: options.height,
            ...(options.fallbackConstraint
                ? { ownedRegionMask: options.fallbackConstraint }
                : {}),
            page: options.page,
            segmentation: options.segmentation,
            sourceRect: options.sourceRect,
            width: options.width,
        })
        : null;
    if (typography && options.fallbackConstraint) {
        typography.core = intersectWindowMask(typography.core, options.fallbackConstraint);
        typography.featherEnvelope = intersectWindowMask(typography.featherEnvelope, options.fallbackConstraint);
    }
    if (!typography || !typography.core.data.some(Boolean)) {
        return {
            compositeMask: options.regionMask,
            constraint: options.fallbackConstraint,
            featherPx,
            modelMask: options.regionMask,
            usesTypographySegmentation: false,
        };
    }
    return {
        compositeMask: typography.core,
        constraint: typography.featherEnvelope,
        featherPx,
        modelMask: unionWindowMasks(options.regionMask, typography.featherEnvelope),
        usesTypographySegmentation: true,
    };
}
function intersectWindowMask(mask, constraint) {
    const data = projectWindowMask(constraint, mask.bounds);
    for (let index = 0; index < data.length; index += 1) {
        if (!mask.data[index])
            data[index] = 0;
    }
    return { bounds: mask.bounds, data };
}
