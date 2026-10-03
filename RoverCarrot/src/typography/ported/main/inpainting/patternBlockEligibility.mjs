// Ported from read-only fork fd461737. See source-map.json.
import { normalizeTranslationCompletionReferences } from "../translationCompletionReferences.mjs";
import { hasUsableBbox } from "./maskGeometry.mjs";
export function isPatternInpaintingBlockEligible(block, blockId, excludedBlockIds, blockIds) {
    const explicitlySelected = block.id === blockId || Boolean(blockIds?.includes(block.id));
    return ((!blockId || block.id === blockId) &&
        (!blockIds || blockIds.includes(block.id)) &&
        (blockId !== undefined || !excludedBlockIds?.includes(block.id)) &&
        hasUsableBbox(block.bbox) &&
        (!block.inpaintExcluded || explicitlySelected));
}
export function resolveEligiblePatternBlocks(page, blockId, excludedBlockIds, blockIds) {
    return page.blocks.filter((block) => isPatternInpaintingBlockEligible(block, blockId, excludedBlockIds, blockIds));
}
export function countEligiblePatternBlocks(page, blockId, excludedBlockIds, blockIds) {
    return resolveEligiblePatternBlocks(page, blockId, excludedBlockIds, blockIds)
        .length;
}
export function hasInvalidRequiredPatternBlock(page) {
    return page.blocks.some((block) => !block.inpaintExcluded && !hasUsableBbox(block.bbox));
}
export function shouldUseOriginalPatternImage(page) {
    const completion = normalizeTranslationCompletionReferences(page.translationCompletion, page.blocks);
    return Boolean(page.inpaintedImagePath &&
        completion?.status === "pending" &&
        !completion.erasedBlockIds?.length);
}
