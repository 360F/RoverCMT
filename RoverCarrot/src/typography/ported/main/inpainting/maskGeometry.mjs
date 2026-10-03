// Ported from read-only fork fd461737. See source-map.json.
import { bboxToPixels, clamp, resolveBlockRenderBbox, } from "../../shared/geometry.mjs";
export function mergeMaskIntoPage(pageMask, pageWidth, rect, rectMask) {
    for (let y = 0; y < rect.h; y += 1) {
        for (let x = 0; x < rect.w; x += 1) {
            if (rectMask[y * rect.w + x]) {
                pageMask[(rect.y + y) * pageWidth + rect.x + x] = 1;
            }
        }
    }
}
export function mergeRects(rects) {
    const pending = rects
        .map((rect) => ({ ...rect }))
        .sort((left, right) => left.y - right.y || left.x - right.x);
    const merged = [];
    while (pending.length > 0) {
        const current = pending.shift();
        if (current)
            merged.push(absorbTouchingRects(current, pending));
    }
    return merged;
}
function absorbTouchingRects(initial, pending) {
    let current = initial;
    while (true) {
        const index = pending.findIndex((candidate) => rectsTouchOrOverlap(current, candidate));
        if (index < 0)
            return current;
        const candidate = pending.splice(index, 1)[0];
        if (candidate)
            current = unionRects(current, candidate);
    }
}
function unionRects(left, right) {
    const x1 = Math.min(left.x, right.x);
    const y1 = Math.min(left.y, right.y);
    const x2 = Math.max(left.x + left.w, right.x + right.w);
    const y2 = Math.max(left.y + left.h, right.y + right.h);
    return { x: x1, y: y1, w: x2 - x1, h: y2 - y1 };
}
export function rectHasMask(mask, pageWidth, rect) {
    for (let y = rect.y; y < rect.y + rect.h; y += 1) {
        for (let x = rect.x; x < rect.x + rect.w; x += 1) {
            if (mask[y * pageWidth + x]) {
                return true;
            }
        }
    }
    return false;
}
export function hasUsableBbox(bbox) {
    return (Number.isFinite(bbox.x) &&
        Number.isFinite(bbox.y) &&
        Number.isFinite(bbox.w) &&
        Number.isFinite(bbox.h) &&
        bbox.w > 0 &&
        bbox.h > 0);
}
export function bboxToPixelRect(bbox, page) {
    const pixelBbox = bboxToPixels(bbox, page.width, page.height);
    const x1 = clamp(Math.floor(pixelBbox.x), 0, Math.max(0, page.width - 1));
    const y1 = clamp(Math.floor(pixelBbox.y), 0, Math.max(0, page.height - 1));
    const x2 = clamp(Math.ceil(pixelBbox.x + pixelBbox.w), x1 + 1, page.width);
    const y2 = clamp(Math.ceil(pixelBbox.y + pixelBbox.h), y1 + 1, page.height);
    return {
        x: x1,
        y: y1,
        w: Math.max(1, x2 - x1),
        h: Math.max(1, y2 - y1),
    };
}
export function resolveBlockRenderBboxInPixels(block, page, imageWidth, imageHeight) {
    return bboxToPixels(resolveBlockRenderBbox(block, page), imageWidth, imageHeight);
}
export function resolvePatternBlockMarginPx(block, page) {
    const rect = bboxToPixelRect(block.bbox, page);
    const byBox = Math.round(Math.max(rect.w, rect.h) * 0.12);
    const byFont = Math.round((block.fontSizePx || 20) * 0.45);
    return clamp(Math.max(8, byBox, byFont), 8, 42);
}
export function resolvePatternRegionPaddingPx(block, page) {
    const rect = bboxToPixelRect(block.bbox, page);
    const byBox = Math.round(Math.max(rect.w, rect.h) * 0.04);
    const byFont = Math.round((block.fontSizePx || 20) * 0.18);
    return clamp(Math.max(2, byBox, byFont), 2, 14);
}
export function resolvePatternWindowMarginPx(block, page) {
    const rect = bboxToPixelRect(block.bbox, page);
    const byBox = Math.round(Math.max(rect.w, rect.h) * 0.32);
    const byFont = Math.round((block.fontSizePx || 20) * 2.8);
    return clamp(Math.max(96, byBox, byFont), 96, 240);
}
export function resolvePatternDilationRadius(block) {
    return clamp(Math.round((block.fontSizePx || 20) / 7), 2, 9);
}
export function expandRect(rect, imageWidth, imageHeight, margin) {
    const x1 = clamp(rect.x - margin, 0, Math.max(0, imageWidth - 1));
    const y1 = clamp(rect.y - margin, 0, Math.max(0, imageHeight - 1));
    const x2 = clamp(rect.x + rect.w + margin, x1 + 1, imageWidth);
    const y2 = clamp(rect.y + rect.h + margin, y1 + 1, imageHeight);
    return {
        x: x1,
        y: y1,
        w: Math.max(1, x2 - x1),
        h: Math.max(1, y2 - y1),
    };
}
export function alignRectToMultiple(rect, imageWidth, imageHeight, multiple) {
    const targetW = Math.min(imageWidth, Math.max(multiple, Math.ceil(rect.w / multiple) * multiple));
    const targetH = Math.min(imageHeight, Math.max(multiple, Math.ceil(rect.h / multiple) * multiple));
    const centerX = rect.x + rect.w / 2;
    const centerY = rect.y + rect.h / 2;
    const x = clamp(Math.round(centerX - targetW / 2), 0, Math.max(0, imageWidth - targetW));
    const y = clamp(Math.round(centerY - targetH / 2), 0, Math.max(0, imageHeight - targetH));
    return {
        x,
        y,
        w: targetW,
        h: targetH,
    };
}
export function resolveContextTiles(bounds, imageWidth, imageHeight, maxTileSize, contextPx, multiple) {
    if (bounds.w <= maxTileSize && bounds.h <= maxTileSize) {
        return [{ cropBounds: bounds, writeBounds: bounds }];
    }
    const safeMultiple = Math.max(1, Math.round(multiple));
    const safeTileSize = Math.max(safeMultiple, Math.round(maxTileSize));
    const safeContext = clamp(Math.round(contextPx), 0, Math.max(0, Math.floor((safeTileSize - safeMultiple) / 2)));
    const coreSize = Math.max(safeMultiple, Math.floor((safeTileSize - safeContext * 2 - (safeMultiple - 1)) / safeMultiple) * safeMultiple);
    const tiles = [];
    for (let y = bounds.y; y < bounds.y + bounds.h; y += coreSize) {
        const height = Math.min(coreSize, bounds.y + bounds.h - y);
        for (let x = bounds.x; x < bounds.x + bounds.w; x += coreSize) {
            const width = Math.min(coreSize, bounds.x + bounds.w - x);
            const writeBounds = { x, y, w: width, h: height };
            const cropBounds = alignRectToMultiple(expandRect(writeBounds, imageWidth, imageHeight, safeContext), imageWidth, imageHeight, safeMultiple);
            tiles.push({ cropBounds, writeBounds });
        }
    }
    return tiles;
}
export function resolveFluxProcessSize(width, height, maxPixels, multiple) {
    const safeWidth = Math.max(1, width);
    const safeHeight = Math.max(1, height);
    const safeMaxPixels = Math.max(multiple * multiple, maxPixels);
    const maxDimension = 2048;
    const scale = Math.min(1, Math.sqrt(safeMaxPixels / (safeWidth * safeHeight)), maxDimension / safeWidth, maxDimension / safeHeight);
    let scaledWidth = Math.max(multiple, Math.round((safeWidth * scale) / multiple) * multiple);
    let scaledHeight = Math.max(multiple, Math.round((safeHeight * scale) / multiple) * multiple);
    while (scaledWidth * scaledHeight > safeMaxPixels) {
        if (scaledWidth / safeWidth >= scaledHeight / safeHeight) {
            scaledWidth = Math.max(multiple, scaledWidth - multiple);
        }
        else {
            scaledHeight = Math.max(multiple, scaledHeight - multiple);
        }
    }
    return {
        width: scaledWidth,
        height: scaledHeight,
    };
}
function rectsTouchOrOverlap(left, right) {
    return (left.x <= right.x + right.w &&
        left.x + left.w >= right.x &&
        left.y <= right.y + right.h &&
        left.y + left.h >= right.y);
}
