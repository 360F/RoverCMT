// Ported from read-only fork fd461737. See source-map.json.
/** One policy for editable overlays and exported artwork. Empty preparation is intentional. */
export function resolveBlockDisplayText(block) {
    return block.textDisplayMode === "translation-only"
        ? block.translatedText
        : block.translatedText || block.sourceText;
}
