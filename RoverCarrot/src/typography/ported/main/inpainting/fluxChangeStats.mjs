// Ported from read-only fork fd461737. See source-map.json.
export function isMaskedRegionEffectivelyUnchanged(stats) {
    return (stats.changedPixels <= 0 &&
        stats.changedRatio < 0.0001 &&
        stats.meanDelta < 0.1);
}
export function measureMaskedRegionChange(before, after, mask) {
    let maskedPixels = 0;
    let changedPixels = 0;
    let totalDelta = 0;
    const pixelCount = Math.min(mask.length, Math.floor(before.length / 4), Math.floor(after.length / 4));
    for (let pixel = 0; pixel < pixelCount; pixel += 1) {
        if (!mask[pixel]) {
            continue;
        }
        const offset = pixel * 4;
        const delta = Math.abs((before[offset] ?? 0) - (after[offset] ?? 0)) +
            Math.abs((before[offset + 1] ?? 0) - (after[offset + 1] ?? 0)) +
            Math.abs((before[offset + 2] ?? 0) - (after[offset + 2] ?? 0));
        maskedPixels += 1;
        totalDelta += delta;
        if (delta >= 8) {
            changedPixels += 1;
        }
    }
    return {
        maskedPixels,
        changedPixels,
        changedRatio: maskedPixels > 0 ? changedPixels / maskedPixels : 0,
        meanDelta: maskedPixels > 0 ? totalDelta / maskedPixels : 0,
    };
}
export function measureWindowMaskedRegionChange(before, after, pageWidth, windowMask) {
    const { bounds, data } = windowMask;
    const pageHeight = Math.floor(Math.min(before.length, after.length) / 4 / pageWidth);
    let maskedPixels = 0;
    let changedPixels = 0;
    let totalDelta = 0;
    for (let localY = 0; localY < bounds.h; localY += 1) {
        const pageY = bounds.y + localY;
        if (pageY < 0 || pageY >= pageHeight)
            continue;
        for (let localX = 0; localX < bounds.w; localX += 1) {
            const localPixel = localY * bounds.w + localX;
            if (!data[localPixel])
                continue;
            const pageX = bounds.x + localX;
            if (pageX < 0 || pageX >= pageWidth)
                continue;
            const offset = (pageY * pageWidth + pageX) * 4;
            const delta = pixelRgbDelta(before, after, offset);
            maskedPixels += 1;
            totalDelta += delta;
            if (delta >= 8)
                changedPixels += 1;
        }
    }
    return {
        maskedPixels,
        changedPixels,
        changedRatio: maskedPixels > 0 ? changedPixels / maskedPixels : 0,
        meanDelta: maskedPixels > 0 ? totalDelta / maskedPixels : 0,
    };
}
function pixelRgbDelta(before, after, offset) {
    return (Math.abs((before[offset] ?? 0) - (after[offset] ?? 0)) +
        Math.abs((before[offset + 1] ?? 0) - (after[offset + 1] ?? 0)) +
        Math.abs((before[offset + 2] ?? 0) - (after[offset + 2] ?? 0)));
}
