import type { InpaintingConfig } from '../core/contracts.js';
export type FluxPrepared = { binary: string; libraryDir: string; driverLibraryDir: string; identity: { sha256: string; bytes: number; computeCap: string; cudaVersion: string } };
export type FluxEngineHandle = { model: 'flux-klein'; inpaint: (...args: unknown[]) => Promise<void>; dispose(): Promise<void>; isHealthy(): boolean };
export function fluxLaunchArgs(config: InpaintingConfig): string[];
export function preflightFlux(config: InpaintingConfig, projectRoot: string): Promise<FluxPrepared>;
export function fluxEngine(config: InpaintingConfig, prepared: FluxPrepared, runRootDir: string): FluxEngineHandle;

export function fluxLaunchEnv(prepared: Pick<FluxPrepared, 'libraryDir' | 'driverLibraryDir'>, inherited?: NodeJS.ProcessEnv): NodeJS.ProcessEnv;
