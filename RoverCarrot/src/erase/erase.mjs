// Rover port of fd461737 src/main/pageWorkflow/pageWorkflowImages.ts eraseWorkflowPage.
// Engine acquisition and the Koharu bubble runner are injected (Carrot: inpainting
// engine pool + production bubble layout facade). Algorithms are the ported modules.
import { workflowRegionKey, workflowTargetBlocks } from '../typography/ported/shared/pageWorkflowPolicy.mjs';
import { inpaintPatternPage } from '../typography/ported/main/inpainting/patternPage.mjs';
import { runBubbleLayoutMaskPrepass } from '../typography/ported/main/jobs/bubbleLayoutJob.mjs';
import { applyInpaintingLayoutStates } from '../typography/ported/main/inpainting/inpaintingLayoutState.mjs';

// Installed Carrot ui.pageWorkflowDefault: bubbleLayout=true, overwrite=["erase"].
export const defaultErasePlan = { bubbleLayout: true, overwrite: ['erase'] };

export class ErasePartialFailure extends Error {
  constructor(message, page) { super(message); this.page = page; }
}

export async function erasePage(page, { plan, stages, acquireEngine, runner, signal = new AbortController().signal }) {
  const workflowPlan = { ...plan, stages };
  const targets = workflowTargetBlocks(page, 'erase', workflowPlan);
  if (!targets.length) return page;
  const lease = await acquireEngine();
  try {
    const blockIds = targets.map(block => block.id);
    const prepass = lease.engine.model === 'flux-klein' && workflowPlan.bubbleLayout && stages.includes('layout')
      ? await runBubbleLayoutMaskPrepass({ page, blockIds, config: { policy: 'balanced', overwriteManual: false }, runner, signal })
      : { page };
    const result = await inpaintPatternPage(prepass.page, {
      blockIds, signal, inpaintingEngine: lease.engine, preserveExistingInpainting: true,
      ...('bubbleLayoutConstraintBlockIds' in prepass ? { bubbleLayoutConstraintBlockIds: prepass.bubbleLayoutConstraintBlockIds } : {}),
      ...('sharedInpaintGroupIdsByBlock' in prepass ? { sharedInpaintGroupIdsByBlock: prepass.sharedInpaintGroupIdsByBlock } : {}),
      ...('typographySegmentation' in prepass ? { typographySegmentation: prepass.typographySegmentation } : {}),
    });
    const erased = new Set(result.erasedBlockIds);
    const output = 'restoreLayout' in prepass && prepass.restoreLayout
      ? applyInpaintingLayoutStates(result.page, prepass.restoreLayout) : result.page;
    const committed = { ...output, erasedWorkflowRegions: { ...page.erasedWorkflowRegions,
      ...Object.fromEntries(targets.filter(block => erased.has(block.id)).map(block => [block.id, workflowRegionKey(page, block)])) } };
    if (result.incompleteBlockIds?.length)
      throw new ErasePartialFailure(`${result.incompleteBlockIds.length}개 영역의 원문 제거가 완료되지 않았습니다.`, committed);
    return committed;
  } finally {
    await lease.release();
  }
}
