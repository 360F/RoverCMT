import type { Page, Stage } from '../core/contracts.js';
import { ErasePartialFailure, erasePage, type EraseLease, type ErasePlan } from './erase.mjs';
export type EraseOptions = { plan: ErasePlan; stages: readonly string[]; acquireEngine: () => Promise<EraseLease>; runner: unknown };
// Reference runtime order typography -> erase -> layout (stage-major). An incomplete
// block keeps the partial result and fails the page, as PageWorkflowPartialFailure does.
export function eraseStage(options: EraseOptions): Stage {
  return { id: 'erase',
    reads: ['imagePath', 'inpaintedImagePath', 'width', 'height', 'blocks', 'bbox', 'fontSizePx', 'inpaintExcluded', 'erasedWorkflowRegions', 'bubbleLayout'],
    writes: ['inpaintedImagePath', 'inpaintMaskPath', 'maskProvenance', 'erasedWorkflowRegions', 'updatedAt', 'inpainted/mask PNG artifacts'],
    resources: ['owned Flux.2 Klein CUDA runner (JSON-lines worker)', 'Koharu CPU bubble prepass', 'page BGRA bitmap'],
    async execute(page: Page) {
      try {
        const next = await erasePage(page, options);
        return { status: page.blocks.length ? 'completed' : 'empty', page: next };
      } catch (error) {
        if (!(error instanceof ErasePartialFailure)) throw error;
        return { status: 'failed', page: error.page, message: error.message, retryable: true };
      }
    } };
}
