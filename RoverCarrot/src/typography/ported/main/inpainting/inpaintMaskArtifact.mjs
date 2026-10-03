// Ported from read-only fork fd461737. See source-map.json.
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { PNG } from "pngjs";
import { loadPageImage, resolveInpaintMaskPath } from "./imageIO.mjs";
export async function persistActualInpaintMask({ page, mask, width, height, suffix, decodeFallback, }) {
    assertMaskSize(mask, width, height);
    const previous = await loadCurrentPageMask(page, width, height, decodeFallback);
    const combined = previous ? unionMasks(previous.mask, mask) : mask;
    const provenance = resolveCombinedProvenance(page, previous?.provenance);
    return {
        path: await writeMaskArtifact(page.imagePath, combined, width, height, suffix),
        provenance,
    };
}
export async function persistRetouchDifferenceMask({ page, originalBitmap, outputBitmap, width, height, }) {
    const mask = buildMaskFromBitmapDifference(originalBitmap, outputBitmap, width, height);
    return {
        path: await writeMaskArtifact(page.imagePath, mask, width, height, "retouch"),
        provenance: "retouch-updated",
    };
}
export async function deriveLegacyInpaintMask({ page, decodeFallback, }) {
    if (!page.inpaintedImagePath)
        return null;
    const original = await loadPageImage(page.imagePath, decodeFallback);
    const inpainted = await loadPageImage(page.inpaintedImagePath, decodeFallback);
    const size = original.getSize();
    const inpaintedSize = inpainted.getSize();
    if (size.width <= 0 ||
        size.height <= 0 ||
        size.width !== inpaintedSize.width ||
        size.height !== inpaintedSize.height) {
        throw new Error("기존 인페인팅 결과와 원본 이미지 크기가 일치하지 않습니다.");
    }
    const mask = buildMaskFromBitmapDifference(Buffer.from(original.toBitmap()), Buffer.from(inpainted.toBitmap()), size.width, size.height);
    return {
        path: await writeMaskArtifact(page.imagePath, mask, size.width, size.height, "derived"),
        provenance: "derived-diff",
    };
}
export async function loadMaskArtifact(filePath, expectedWidth, expectedHeight) {
    const decoded = PNG.sync.read(await readFile(filePath), {
        skipRescale: true,
    });
    if (decoded.width !== expectedWidth || decoded.height !== expectedHeight) {
        throw new Error("저장된 인페인팅 마스크 크기가 페이지와 일치하지 않습니다.");
    }
    const mask = new Uint8Array(expectedWidth * expectedHeight);
    const channels = decoded.data.length / mask.length;
    if (!Number.isInteger(channels) || channels < 1) {
        throw new Error("저장된 인페인팅 마스크 형식이 올바르지 않습니다.");
    }
    for (let index = 0; index < mask.length; index += 1) {
        mask[index] = decoded.data[index * channels] > 0 ? 1 : 0;
    }
    return mask;
}
export function buildMaskFromBitmapDifference(originalBitmap, outputBitmap, width, height) {
    const pixelCount = width * height;
    if (originalBitmap.length < pixelCount * 4 ||
        outputBitmap.length < pixelCount * 4) {
        throw new Error("인페인팅 차이 마스크를 만들 이미지 데이터가 부족합니다.");
    }
    const mask = new Uint8Array(pixelCount);
    for (let index = 0; index < pixelCount; index += 1) {
        const offset = index * 4;
        if (Math.abs(originalBitmap[offset] - outputBitmap[offset]) > 2 ||
            Math.abs(originalBitmap[offset + 1] - outputBitmap[offset + 1]) > 2 ||
            Math.abs(originalBitmap[offset + 2] - outputBitmap[offset + 2]) > 2 ||
            Math.abs(originalBitmap[offset + 3] - outputBitmap[offset + 3]) > 2) {
            mask[index] = 1;
        }
    }
    return mask;
}
async function loadCurrentPageMask(page, width, height, decodeFallback) {
    if (page.inpaintMaskPath) {
        return {
            mask: await loadMaskArtifact(page.inpaintMaskPath, width, height),
            provenance: page.maskProvenance ?? "derived-diff",
        };
    }
    if (!page.inpaintedImagePath)
        return null;
    try {
        const original = await loadPageImage(page.imagePath, decodeFallback);
        const inpainted = await loadPageImage(page.inpaintedImagePath, decodeFallback);
        const originalSize = original.getSize();
        const inpaintedSize = inpainted.getSize();
        if (originalSize.width !== width ||
            originalSize.height !== height ||
            inpaintedSize.width !== width ||
            inpaintedSize.height !== height) {
            throw new Error("기존 인페인팅 결과와 새 마스크 크기가 일치하지 않습니다.");
        }
        return {
            mask: buildMaskFromBitmapDifference(Buffer.from(original.toBitmap()), Buffer.from(inpainted.toBitmap()), width, height),
            provenance: "derived-diff",
        };
    }
    catch {
        // A pre-mask legacy page may no longer have a decodable immutable source.
        // Keep the new inpainting result usable, persist this operation's mask, and
        // let resolveCombinedProvenance label it as derived rather than exact.
        return null;
    }
}
async function writeMaskArtifact(imagePath, mask, width, height, suffix) {
    assertMaskSize(mask, width, height);
    const filePath = resolveInpaintMaskPath(imagePath, suffix);
    const grayscale = Buffer.alloc(mask.length);
    for (let index = 0; index < mask.length; index += 1) {
        grayscale[index] = mask[index] ? 255 : 0;
    }
    const png = new PNG({ width, height });
    png.data = grayscale;
    const bytes = PNG.sync.write(png, {
        bitDepth: 8,
        colorType: 0,
        inputColorType: 0,
        inputHasAlpha: false,
    });
    await mkdir(dirname(filePath), { recursive: true });
    await writeFile(filePath, bytes, { flag: "wx" });
    return filePath;
}
function unionMasks(left, right) {
    if (left.length !== right.length) {
        throw new Error("합칠 인페인팅 마스크의 크기가 일치하지 않습니다.");
    }
    const result = new Uint8Array(left.length);
    for (let index = 0; index < result.length; index += 1) {
        result[index] = left[index] || right[index] ? 1 : 0;
    }
    return result;
}
function resolveCombinedProvenance(page, previous) {
    if (previous === "derived-diff" ||
        (!page.inpaintMaskPath && page.inpaintedImagePath)) {
        return "derived-diff";
    }
    if (previous === "retouch-updated")
        return "retouch-updated";
    return "actual-mask";
}
function assertMaskSize(mask, width, height) {
    if (width <= 0 || height <= 0 || mask.length !== width * height) {
        throw new Error("인페인팅 마스크 크기가 페이지와 일치하지 않습니다.");
    }
}
