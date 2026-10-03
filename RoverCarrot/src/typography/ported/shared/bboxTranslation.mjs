// Ported from read-only fork fd461737. See source-map.json.
/**
 * Allows boxes to cross the page boundary while retaining a small visible
 * extent on each axis. This is used only for manual render placement; source
 * OCR geometry remains page-confined by its own normalization path.
 */
export function clampTranslationToVisibleBboxes(bboxes, requestedDelta, minimumVisibleExtent) {
    if (bboxes.length === 0) {
        return { x: 0, y: 0 };
    }
    const visible = Math.max(0, Math.min(500, minimumVisibleExtent));
    const minimumX = Math.max(...bboxes.map((bbox) => visible - bbox.x - bbox.w));
    const maximumX = Math.min(...bboxes.map((bbox) => 1000 - visible - bbox.x));
    const minimumY = Math.max(...bboxes.map((bbox) => visible - bbox.y - bbox.h));
    const maximumY = Math.min(...bboxes.map((bbox) => 1000 - visible - bbox.y));
    return {
        x: clamp(requestedDelta.x, minimumX, maximumX),
        y: clamp(requestedDelta.y, minimumY, maximumY),
    };
}
export function translateBbox(bbox, delta) {
    return {
        ...bbox,
        x: bbox.x + delta.x,
        y: bbox.y + delta.y,
    };
}
function clamp(value, min, max) {
    return Math.min(max, Math.max(min, value));
}
