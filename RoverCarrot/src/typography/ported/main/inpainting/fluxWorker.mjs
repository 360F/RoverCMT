// Ported from read-only fork fd461737. See source-map.json.
import { stripVTControlCharacters } from "node:util";
import { basename } from "node:path";
import { buildFluxWorkerEnv } from "./fluxWorkerEnv.mjs";
import { buildFluxRuntimeExitError, buildFluxWorkerResponseError, formatFluxRuntimeDetail, sanitizeFluxRuntimeStderr, } from "./fluxWorkerErrors.mjs";
import { JsonLinesWorkerClient, } from "../runtimeSupport/jsonLinesWorkerClient.mjs";
import { logInpaintingRuntimeInfo, logInpaintingRuntimeWarn, } from "./inpaintingRuntimeLogger.mjs";
const productionDiagnostics = {
    info: logInpaintingRuntimeInfo,
    warn: logInpaintingRuntimeWarn,
};
export class FluxWorker {
    launch;
    client;
    diagnostics;
    stderrBuffer = "";
    engineError;
    constructor(launch, options = {}) {
        this.launch = launch;
        this.diagnostics = options.diagnostics ?? productionDiagnostics;
        this.client = new JsonLinesWorkerClient({
            executable: launch.executable,
            args: launch.args,
            env: buildFluxWorkerEnv(launch),
            workerName: "Flux 인페인팅 런타임",
            requestTimeoutMs: options.requestTimeoutMs,
            buildExitError: (code, stderr) => buildFluxRuntimeExitError(code, stderr, launch.backend),
            buildNotRunningError: (stderr) => new Error(`Flux 인페인팅 런타임이 실행 중이 아닙니다. ${formatFluxRuntimeDetail(stderr)}`),
            sanitizeStderr: sanitizeFluxRuntimeStderr,
            onStderr: (text) => this.observeStderr(text),
            onSpawn: (pid) => this.logProcessStarting(pid),
            onTerminationError: (error) => this.diagnostics.warn("Flux worker process-tree termination failed", {
                backend: this.launch.backend,
                label: this.launch.label,
                error,
            }),
        });
    }
    observeStderr(text) {
        this.stderrBuffer += text;
        let newline;
        while ((newline = this.stderrBuffer.indexOf("\n")) >= 0) {
            const line = stripVTControlCharacters(this.stderrBuffer.slice(0, newline)).trim();
            this.stderrBuffer = this.stderrBuffer.slice(newline + 1);
            if (line) this.diagnostics.info("Flux runtime stderr", { backend: this.launch.backend, label: this.launch.label, line });
            if (this.launch.backend === "cuda-native" && /falling back to CPU/i.test(line)) {
                this.engineError = new Error(`Flux cuda-native engine refused CPU fallback: ${line}`);
                this.client.handlePipeError(this.engineError);
            }
        }
        // Check unterminated/split lines promptly; retain a bounded diagnostic tail.
        if (this.launch.backend === "cuda-native" && /falling back to CPU/i.test(this.stderrBuffer)) {
            this.engineError = new Error(`Flux cuda-native engine refused CPU fallback: ${this.stderrBuffer}`);
            this.client.handlePipeError(this.engineError);
        }
        this.stderrBuffer = this.stderrBuffer.slice(-16000);
    }
    logProcessStarting(pid) {
        this.diagnostics.info("Flux worker process starting", {
            backend: this.launch.backend,
            label: this.launch.label,
            executable: this.launch.executable,
            runtimePath: this.launch.runtimePath,
            args: this.launch.args,
            requestedComputeGpuIndex: this.launch.computeGpuIndex ?? "auto",
            selectedCudaDevice: this.launch.backend === "cuda-native"
                ? this.launch.cudaDevice
                : undefined,
            pid,
        });
    }
    async inpaint(request, signal) {
        if (this.engineError) throw this.engineError;
        const requestSummary = summarizeFluxWorkerRequest(request);
        const { id, response } = this.client.startRequest({
            type: "inpaint",
            input: request.input,
            mask: request.mask,
            output: request.output,
            steps: request.steps,
            strength: request.strength,
            max_pixels: request.maxPixels,
            mask_padding: request.maskPadding,
        }, signal);
        this.diagnostics.info("Flux inpaint crop started", {
            backend: this.launch.backend,
            label: this.launch.label,
            requestId: id,
            ...requestSummary,
        });
        const result = await response;
        if (this.engineError) throw this.engineError;
        this.handleResponse(result, requestSummary);
    }
    async dispose() {
        await this.client.dispose();
    }
    isHealthy() {
        return !this.engineError && this.client.isHealthy();
    }
    handleResponse(response, request) {
        if (response.ok) {
            this.diagnostics.info("Flux inpaint crop completed", {
                backend: this.launch.backend,
                label: this.launch.label,
                requestId: response.id,
                elapsedMs: normalizeElapsedMs(response.elapsed_ms),
                ...request,
            });
            return;
        }
        this.diagnostics.warn("Flux inpaint crop failed", {
            backend: this.launch.backend,
            label: this.launch.label,
            requestId: response.id,
            elapsedMs: normalizeElapsedMs(response.elapsed_ms),
            error: response.error ?? "알 수 없는 오류",
            ...request,
        });
        throw buildFluxWorkerResponseError(response.error ?? "알 수 없는 오류", this.client.getStderr(), this.launch.backend);
    }
}
function summarizeFluxWorkerRequest(request) {
    return {
        inputFile: basename(request.input),
        maskFile: basename(request.mask),
        outputFile: basename(request.output),
        steps: request.steps,
        strength: request.strength,
        maxPixels: request.maxPixels,
        maskPadding: request.maskPadding,
    };
}
function normalizeElapsedMs(value) {
    const elapsedMs = Number(value);
    return Number.isFinite(elapsedMs) && elapsedMs >= 0 ? elapsedMs : undefined;
}
