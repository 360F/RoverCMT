// Ported from read-only fork fd461737. See source-map.json.
export function createEmptyPatternMaskContext(width, height) {
    return {
        pageMask: new Uint8Array(width * height),
        inpaintWindows: [],
        inpaintWindowMasks: [],
        inpaintCompositeMasks: [],
        inpaintCompositeFeatherPx: [],
        inpaintWindowConstraints: [],
        inpaintWindowGroupIds: [],
        usesKoharuTypographyComposite: false,
        validationWindowMasks: [],
        validationBlockIds: [],
        sourceGlyphEvidence: [],
        validationBindingsByBlockId: new Map(),
        blocksErased: 0,
        otsuBlocks: 0,
    };
}
