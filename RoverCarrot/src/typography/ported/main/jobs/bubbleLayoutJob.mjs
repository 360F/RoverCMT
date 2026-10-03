// Ported from read-only fork fd461737. See source-map.json.
import { resolveBubbleLayoutPaddingRatio } from "../../shared/bubbleLayoutPadding.mjs";
import { isGeneratedBubbleLayout, isManualBubbleLayout, isUsableBubbleLayout, } from "../../shared/bubbleLayout.mjs";
import { resolveBubbleLayoutPostprocessConfig, runBubbleLayoutPostprocess, } from "../inpainting/bubbleLayoutRunner.mjs";
import { captureInpaintingLayoutStates, } from "../inpainting/inpaintingLayoutState.mjs";
export async function prepareBubbleLayoutJob({ completionWorkflow, context, request, runtime, totalTargetBlocks, }) {
    if (totalTargetBlocks <= 0) {
        return { appSettings: null, config: null, runner: null };
    }
    const appSettings = await runtime.getSettings(context.appPaths);
    const config = resolveJobBubbleLayoutConfig(request, appSettings, completionWorkflow);
    if (!config) {
        return { appSettings, config: null, runner: null };
    }
    if (!runtime.createBubbleLayoutRunner) {
        throw new Error("말풍선 배치 실행기를 사용할 수 없습니다.");
    }
    return {
        appSettings,
        config,
        runner: runtime.createBubbleLayoutRunner({
            dataRoot: context.appPaths.dataRoot,
            decodeFallback: context.decodeImage,
            directMl: {
                ...appSettings.hardware,
                computeGpuBackend: appSettings.ocr.device === "gpu"
                    ? (appSettings.ocr.gpuBackend ?? "cuda")
                    : undefined,
            },
        }),
    };
}
function resolveJobBubbleLayoutConfig(request, appSettings, completionWorkflow) {
    if (request.mode === "page-bubble-layout") {
        return {
            policy: request.policy,
            paddingRatio: resolveBubbleLayoutPaddingRatio(appSettings.inpainting?.bubbleLayoutPaddingRatio),
            overwriteManual: true,
        };
    }
    const configured = resolveBubbleLayoutPostprocessConfig(request, appSettings);
    if (request.postprocess?.bubbleLayout)
        return configured;
    if (completionWorkflow === "erase-original")
        return null;
    if (configured || completionWorkflow !== "bubble-layout")
        return configured;
    return {
        policy: "balanced",
        paddingRatio: resolveBubbleLayoutPaddingRatio(appSettings.inpainting?.bubbleLayoutPaddingRatio),
        overwriteManual: false,
    };
}
export async function runBubbleLayoutOnlyPage({ blockId, config, page, runner, signal, }) {
    if (!config || !runner) {
        throw new Error("말풍선 배치 실행기를 사용할 수 없습니다.");
    }
    const processed = await runBubbleLayoutPostprocess({
        blockId,
        config,
        page,
        runner,
        signal,
    });
    return {
        ...processed,
        blocksErased: processed.afterLayout?.length ?? 0,
    };
}
/**
 * Builds transient, unpadded Bubble geometry for the Flux mask only.
 *
 * The returned layout must never be committed. `restoreLayout` contains the
 * exact pre-pass baseline needed to remove transient geometry from the
 * inpainting result before the configured, persisted postprocess runs.
 */
export async function runBubbleLayoutMaskPrepass({ blockId, blockIds, config, page, runner, signal, }) {
    const targetBlockIds = resolvePrepassBlockIds(page, blockId, blockIds);
    const targetBlockIdSet = new Set(targetBlockIds);
    const hasSubset = blockId !== undefined || blockIds !== undefined;
    const restoreLayout = captureInpaintingLayoutStates(page, targetBlockIds);
    const maskBaselinePage = {
        ...page,
        blocks: page.blocks.map((block) => {
            if (targetBlockIdSet.has(block.id) &&
                isGeneratedBubbleLayout(block.bubbleLayout)) {
                const withoutPersistedLayout = { ...block };
                delete withoutPersistedLayout.bubbleLayout;
                delete withoutPersistedLayout.renderBbox;
                delete withoutPersistedLayout.renderBboxSpace;
                return withoutPersistedLayout;
            }
            return block;
        }),
    };
    const processed = await runBubbleLayoutPostprocess({
        blockId,
        ...(blockId === undefined && blockIds ? { blockIds } : {}),
        config: {
            policy: config.policy,
            // Inpainting uses the detector's raw safe region. User-configured
            // padding is render-only and is applied by the final postprocess.
            paddingRatio: 0,
            // Full-page Flux receives each shared balloon as one grouped region.
            // A one-block retry must keep the normal ownership split so it cannot
            // erase source text owned by a neighboring block.
            sharedOwnershipGapPx: hasSubset ? undefined : 0,
            overwriteManual: false,
        },
        failureMode: "best-effort",
        includeTypographySegmentation: true,
        page: maskBaselinePage,
        runner,
        signal,
    });
    const bubbleLayoutConstraintBlockIds = new Set(page.blocks
        .filter((block) => targetBlockIdSet.has(block.id) &&
        isManualBubbleLayout(block.bubbleLayout) &&
        isUsableBubbleLayout(block.bubbleLayout))
        .map((block) => block.id));
    for (const state of processed.afterLayout ?? []) {
        if (isUsableBubbleLayout(state.bubbleLayout)) {
            bubbleLayoutConstraintBlockIds.add(state.blockId);
        }
    }
    return buildMaskPrepassResult(processed, [...bubbleLayoutConstraintBlockIds], restoreLayout);
}
function buildMaskPrepassResult(processed, bubbleLayoutConstraintBlockIds, restoreLayout) {
    return {
        bubbleLayoutConstraintBlockIds,
        page: processed.page,
        ...(restoreLayout.length ? { restoreLayout } : {}),
        ...(processed.sharedInpaintGroupIdsByBlock
            ? {
                sharedInpaintGroupIdsByBlock: processed.sharedInpaintGroupIdsByBlock,
            }
            : {}),
        ...(processed.typographySegmentation
            ? { typographySegmentation: processed.typographySegmentation }
            : {}),
    };
}
function resolvePrepassBlockIds(page, blockId, blockIds) {
    if (blockId)
        return [blockId];
    if (blockIds)
        return [...blockIds];
    return page.blocks.map((block) => block.id);
}
