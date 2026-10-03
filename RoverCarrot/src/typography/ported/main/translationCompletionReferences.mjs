// Ported from read-only fork fd461737. See source-map.json.
export function assertUniqueTranslationBlockIds(blocks, message) {
    const seen = new Set();
    for (const block of blocks) {
        if (seen.has(block.id)) {
            throw new Error(message);
        }
        seen.add(block.id);
    }
}
export function remapTranslationCompletionReferences(current, blockIdMap) {
    return rewriteTranslationCompletionReferences(current, (sourceId) => blockIdMap.get(sourceId));
}
export function normalizeTranslationCompletionReferences(current, blocks) {
    const validIds = new Set(blocks.map((block) => block.id));
    return rewriteTranslationCompletionReferences(current, (sourceId) => validIds.has(sourceId) ? sourceId : undefined);
}
function rewriteTranslationCompletionReferences(current, resolveId) {
    if (!current) {
        return undefined;
    }
    const erased = current.erasedBlockIds;
    if (!erased || erased.length === 0) {
        return {
            workflow: current.workflow,
            status: current.status,
        };
    }
    const rewritten = [];
    for (const sourceId of erased) {
        const destinationId = resolveId(sourceId);
        if (!destinationId) {
            return invalidateUnknownReferences(current);
        }
        rewritten.push(destinationId);
    }
    if (new Set(rewritten).size !== rewritten.length) {
        return invalidateUnknownReferences(current);
    }
    return {
        workflow: current.workflow,
        status: current.status,
        erasedBlockIds: rewritten,
    };
}
function invalidateUnknownReferences(current) {
    if (current.status === "completed") {
        return {
            workflow: current.workflow,
            status: "completed",
        };
    }
    return {
        workflow: current.workflow,
        status: "pending",
    };
}
