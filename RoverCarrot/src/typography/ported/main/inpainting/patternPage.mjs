// Ported from read-only fork fd461737. See source-map.json.
// Rover adaptation: Electron nativeImage -> adapters/native-image.mjs; async decode/encode/resize call sites await.
import { nativeImage } from "../../../../adapters/native-image.mjs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { removeArtifactAfterFailure } from "../artifactCleanup.mjs";
import { logInpaintingRuntimeInfo } from "./inpaintingRuntimeLogger.mjs";
import { loadPageImage, resolveInpaintedImagePath } from "./imageIO.mjs";
import { measureWindowMaskedRegionChange } from "./fluxChangeStats.mjs";
import { resolveEligiblePatternBlocks, shouldUseOriginalPatternImage, } from "./patternBlockEligibility.mjs";
import { runPatternInpaintingEngine } from "./patternEngineRunner.mjs";
import { buildPatternPageMask, } from "./patternPageMask.mjs";
import { attachRequiredPatternSourceDiagnostics, cleanupStrictDiagnosticOutput, } from "./patternPageSourceDiagnostics.mjs";
import { createPatternBitmapBaseline, } from "./sourceGlyphEvidenceReceipt.mjs";
import { persistActualInpaintMask, buildMaskFromBitmapDifference, } from "./inpaintMaskArtifact.mjs";
export async function inpaintPatternPage(page, options = {}) {
    const patternBlockIds = resolvePatternBlockIds(page, options);
    if (patternBlockIds.length === 0)
        return { page, blocksErased: 0 };
    const working = await loadPatternWorkingBitmap(page, options.decodeFallback, options.sourceEvidenceMode === "required", options.preserveExistingInpainting === true);
    const size = { width: working.width, height: working.height };
    const bitmap = Buffer.from(working.bitmap);
    const maskContext = createPatternMaskContext(page, bitmap, size, options);
    if (maskContext.blocksErased === 0)
        return { page, blocksErased: 0 };
    await runPatternInpaintingEngine({
        ...options,
        ...size,
        sourceImagePath: page.imagePath,
        inputImagePath: working.assetPath,
        bitmap,
        engine: options.inpaintingEngine,
        maskContext,
    });
    const changes = resolvePatternPixelChanges(working.bitmap, bitmap, maskContext, options.inpaintingEngine, size.width);
    if (changes.erasedBlockIds.length === 0) {
        const unchangedResult = {
            page,
            blocksErased: 0,
            blocksIncomplete: changes.incompleteBlockIds.length,
            erasedBlockIds: [],
            incompleteBlockIds: changes.incompleteBlockIds,
        };
        if (options.sourceEvidenceMode !== "required")
            return unchangedResult;
        return attachRequiredSourceDiagnostics(unchangedResult, {
            afterBitmap: bitmap,
            maskContext,
            options,
            page,
            patternBlockIds,
            working,
        });
    }
    if (options.inpaintingEngine?.model === "codex")
        maskContext.pageMask = buildMaskFromBitmapDifference(working.bitmap, bitmap, size.width, size.height);
    const { completedResult, output } = await persistPatternResult({
        bitmap,
        changes,
        maskContext,
        options,
        page,
        size,
    });
    if (options.sourceEvidenceMode !== "required")
        return completedResult;
    return attachRequiredSourceDiagnostics(completedResult, {
        afterBitmap: bitmap,
        maskContext,
        options,
        output,
        page,
        patternBlockIds,
        working,
    });
}
async function persistPatternResult({ bitmap, changes, maskContext, options, page, size, }) {
    const output = await writePatternInpaintedImage(page, bitmap, size);
    let persistedMask;
    try {
        persistedMask = await persistActualInpaintMask({
            page,
            mask: maskContext.pageMask,
            width: size.width,
            height: size.height,
            suffix: "pattern",
            decodeFallback: options.decodeFallback,
        });
    }
    catch (error) {
        return removeArtifactAfterFailure(output.path, error);
    }
    return {
        output,
        completedResult: {
            blocksErased: changes.erasedBlockIds.length,
            blocksIncomplete: changes.incompleteBlockIds.length,
            erasedBlockIds: changes.erasedBlockIds,
            incompleteBlockIds: changes.incompleteBlockIds,
            page: {
                ...page,
                inpaintedImagePath: output.path,
                inpaintMaskPath: persistedMask.path,
                maskProvenance: persistedMask.provenance,
                updatedAt: new Date().toISOString(),
            },
        },
    };
}
function resolvePatternBlockIds(page, options) {
    return resolveEligiblePatternBlocks(page, options.blockId, options.excludedBlockIds, options.blockIds).map((block) => block.id);
}
function createPatternMaskContext(page, bitmap, size, options) {
    return buildPatternPageMask({
        blockId: options.blockId,
        blockIds: options.blockIds,
        page,
        bitmap,
        collectSourceGlyphEvidence: false,
        width: size.width,
        height: size.height,
        mode: options.inpaintingEngine?.model === "codex"
            ? "codex-region"
            : options.inpaintingEngine?.model === "flux-klein" ||
                options.typographySegmentation
                ? "flux-region"
                : "glyph",
        bubbleLayoutConstraintBlockIds: options.bubbleLayoutConstraintBlockIds,
        excludedBlockIds: options.excludedBlockIds,
        sharedInpaintGroupIdsByBlock: options.sharedInpaintGroupIdsByBlock,
        typographySegmentation: options.typographySegmentation,
        signal: options.signal,
    });
}
async function loadPatternWorkingBitmap(page, decodeFallback, strictEvidence, preserveExistingInpainting) {
    const beforePath = !preserveExistingInpainting && shouldUseOriginalPatternImage(page)
        ? page.imagePath
        : (page.inpaintedImagePath ?? page.imagePath);
    if (strictEvidence) {
        const strictBaseline = await loadPatternBitmapBaseline(page, beforePath, decodeFallback);
        return { ...strictBaseline, strictBaseline };
    }
    const image = await loadPageImage(beforePath, decodeFallback);
    const size = image.getSize();
    if (!size.width || !size.height) {
        throw new Error(`페이지 이미지를 읽지 못했습니다: ${page.name}`);
    }
    const bitmap = image.toBitmap();
    if (bitmap.length < size.width * size.height * 4) {
        throw new Error(`페이지 이미지 비트맵을 만들지 못했습니다: ${page.name}`);
    }
    return {
        assetPath: beforePath,
        bitmap,
        height: size.height,
        width: size.width,
    };
}
async function loadPatternBitmapBaseline(page, assetPath, decodeFallback) {
    const assetBytesBeforeDecode = await tryReadFile(assetPath);
    const image = await loadPageImage(assetPath, decodeFallback);
    const assetBytesAfterDecode = await tryReadFile(assetPath);
    if (assetBytesBeforeDecode &&
        assetBytesAfterDecode &&
        !assetBytesBeforeDecode.equals(assetBytesAfterDecode)) {
        throw new Error(`이미지 파일이 디코딩 중 변경되었습니다: ${page.name}`);
    }
    const size = image.getSize();
    if (!size.width || !size.height) {
        throw new Error(`페이지 이미지를 읽지 못했습니다: ${page.name}`);
    }
    const bitmap = image.toBitmap();
    if (bitmap.length < size.width * size.height * 4) {
        throw new Error(`페이지 이미지 비트맵을 만들지 못했습니다: ${page.name}`);
    }
    return createPatternBitmapBaseline({
        assetPath,
        assetBytes: assetBytesAfterDecode ?? assetBytesBeforeDecode,
        bitmap,
        height: size.height,
        width: size.width,
    });
}
async function attachRequiredSourceDiagnostics(result, context) {
    try {
        return await attachRequiredPatternSourceDiagnostics(result, {
            afterBitmap: context.afterBitmap,
            before: context.working.strictBaseline,
            engine: context.options.inpaintingEngine,
            loadImmutableSource: async () => {
                if (context.working.assetPath === context.page.imagePath &&
                    context.working.strictBaseline) {
                    return context.working.strictBaseline;
                }
                return loadPatternBitmapBaseline(context.page, context.page.imagePath, context.options.decodeFallback);
            },
            maskContext: context.maskContext,
            output: context.output,
            page: context.page,
            patternBlockIds: context.patternBlockIds,
            required: true,
        });
    }
    catch (error) {
        if (!context.output)
            throw error;
        return cleanupStrictDiagnosticOutput(context.output.path, error);
    }
}
function resolvePatternPixelChanges(before, after, mask, engine, width) {
    const stats = mask.validationWindowMasks.map((windowMask, index) => {
        const blockId = mask.validationBlockIds[index];
        if (!blockId)
            throw new Error("Pattern validation block binding is incomplete.");
        return {
            blockId,
            ...measureWindowMaskedRegionChange(before, after, width, windowMask),
        };
    });
    const unchangedTargets = stats.filter((item) => item.changedPixels <= 0);
    const incompleteBlockIds = stats
        .filter((item) => item.changedPixels <= 0)
        .map((item) => item.blockId);
    if (unchangedTargets.length > 0) {
        logInpaintingRuntimeInfo("Selected inpainting model left one or more target masks unchanged", {
            model: engine?.model,
            blocks: mask.blocksErased,
            targetMasks: stats.length,
            unchangedTargetMasks: unchangedTargets.length,
            unchangedStats: unchangedTargets,
        });
    }
    if (stats.length > incompleteBlockIds.length)
        logInpaintingRuntimeInfo("Selected inpainting model processing completed", {
            model: engine?.model,
            blocks: mask.blocksErased,
            blocksErased: stats.length - incompleteBlockIds.length,
            blocksIncomplete: incompleteBlockIds.length,
            otsuBlocks: mask.otsuBlocks,
        });
    return {
        erasedBlockIds: stats
            .filter((item) => item.changedPixels > 0)
            .map((item) => item.blockId),
        incompleteBlockIds,
    };
}
async function writePatternInpaintedImage(page, bitmap, size) {
    const outputImage = nativeImage.createFromBitmap(bitmap, size);
    if (outputImage.isEmpty())
        throw new Error(`인페인팅 결과 이미지를 만들지 못했습니다: ${page.name}`);
    const outputPath = resolveInpaintedImagePath(page.imagePath, "pattern");
    const png = await outputImage.toPNG();
    await mkdir(dirname(outputPath), { recursive: true });
    await writeFile(outputPath, png, { flag: "wx" });
    return { bytes: png, path: outputPath };
}
async function tryReadFile(filePath) {
    try {
        return await readFile(filePath);
    }
    catch (error) {
        if (error instanceof Error &&
            error.code === "ENOENT")
            return null;
        throw error;
    }
}
