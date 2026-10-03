import type { Page } from '../core/contracts.js';
export type EraseLease = { engine: { model: string; inpaint: (...args: unknown[]) => Promise<void>; dispose(): Promise<void> }; release(): Promise<void> };
export type ErasePlan = { bubbleLayout: boolean; overwrite: string[] };
export const defaultErasePlan: ErasePlan;
export class ErasePartialFailure extends Error { page: Page; constructor(message: string, page: Page); }
export function erasePage(page: Page, options: { plan: ErasePlan; stages: readonly string[]; acquireEngine: () => Promise<EraseLease>;
  runner: unknown; signal?: AbortSignal }): Promise<Page>;
