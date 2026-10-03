// Ported from read-only fork fd461737. See source-map.json.
import { spawn } from "node:child_process";
import { StringDecoder } from "node:string_decoder";
import { observeProcessErrors } from "./observeProcessErrors.mjs";
import { createChildExitReceipt, forceTerminateChildProcessTree, shouldSpawnInOwnProcessGroup, } from "./processTreeTermination.mjs";
const DEFAULT_WORKER_REQUEST_TIMEOUT_MS = 30 * 60 * 1000;
export const JSON_WORKER_SHUTDOWN_GRACE_MS = 1_500;
const MAX_RESPONSE_LINE_LENGTH = 1024 * 1024;
const MAX_STDERR_CHUNK_LENGTH = 16_000;
export class JsonWorkerRequestTimeoutError extends Error {
    workerName;
    requestId;
    timeoutMs;
    elapsedMs;
    code = "JSON_WORKER_REQUEST_TIMEOUT";
    constructor(workerName, requestId, timeoutMs, elapsedMs) {
        super(`${workerName} 요청 ${requestId}의 절대 응답 제한 ${timeoutMs}ms를 초과했습니다.`);
        this.workerName = workerName;
        this.requestId = requestId;
        this.timeoutMs = timeoutMs;
        this.elapsedMs = elapsedMs;
        this.name = "JsonWorkerRequestTimeoutError";
    }
}
export class JsonLinesWorkerClient {
    options;
    child;
    childExitReceipt;
    pending = new Map();
    stderrTail = [];
    requestTimeoutMs;
    runtime;
    nextId = 1;
    stdoutBuffer = "";
    stdoutDecoder = new StringDecoder("utf8");
    stderrDecoder = new StringDecoder("utf8");
    writeQueue = Promise.resolve();
    state = "running";
    terminationPromise = null;
    disposePromise = null;
    constructor(options) {
        this.options = options;
        this.requestTimeoutMs = normalizeRequestTimeout(options.requestTimeoutMs ?? DEFAULT_WORKER_REQUEST_TIMEOUT_MS);
        this.runtime = resolveClientRuntime(options.runtime);
        this.child = this.runtime.spawnWorker(options);
        this.childExitReceipt = createChildExitReceipt(this.child);
        observeProcessErrors(this.child, (error) => this.handleChildError(error), (error) => this.handlePipeError(error));
        options.onSpawn?.(this.child.pid ?? null);
        this.child.stdout.on("data", (chunk) => this.handleStdout(this.stdoutDecoder.write(chunk)));
        this.child.stdout.on("end", () => this.handleStdout(this.stdoutDecoder.end()));
        this.child.stderr.on("data", (chunk) => this.rememberStderr(this.stderrDecoder.write(chunk)));
        this.child.stderr.on("end", () => this.rememberStderr(this.stderrDecoder.end()));
        this.child.on("exit", (code) => this.handleExit(code));
    }
    startRequest(payload, signal) {
        throwIfAborted(signal);
        this.assertRunning();
        const id = String(this.nextId++);
        const response = new Promise((resolve, reject) => {
            this.registerPendingRequest(id, signal, resolve, reject);
            this.enqueueWrite(`${JSON.stringify({ ...payload, id })}\n`);
        });
        return { id, response };
    }
    dispose() {
        this.disposePromise ??= this.disposeInternal();
        return this.disposePromise;
    }
    isHealthy() {
        return (this.state === "running" &&
            this.child.exitCode === null &&
            this.child.signalCode === null &&
            this.child.stdin.writable);
    }
    getStderr() {
        return this.stderrTail.join("");
    }
    async disposeInternal() {
        if (this.terminationPromise) {
            await this.terminationPromise;
            return;
        }
        if (this.state === "closed") {
            return;
        }
        if (this.state === "termination-failed") {
            throw new Error(`${this.options.workerName} 워커 종료가 이미 실패했습니다.`);
        }
        if (this.pending.size > 0) {
            const error = new Error(`${this.options.workerName} 워커가 종료되었습니다.`);
            await this.beginPermanentFailure({
                primaryRequestId: null,
                primaryError: error,
                otherError: error,
            });
            return;
        }
        this.state = "closing";
        if (this.childExitReceipt.hasExited()) {
            this.state = "closed";
            return;
        }
        const shutdownWrite = this.beginGracefulShutdown();
        const outcome = await waitForGracefulShutdown(this.childExitReceipt.promise, shutdownWrite, this.runtime.shutdownGraceMs, this.runtime);
        if (outcome.kind === "exited") {
            this.state = "closed";
            return;
        }
        try {
            await this.runtime.forceTerminateProcessTree(this.child);
            this.state = "closed";
        }
        catch (error) {
            const terminationError = toError(error);
            this.state = "termination-failed";
            this.options.onTerminationError(terminationError);
            throw terminationError;
        }
    }
    registerPendingRequest(id, signal, resolve, reject) {
        const startedAt = this.runtime.now();
        const onAbort = () => this.abortRequest(id);
        const removeAbortListener = () => signal?.removeEventListener("abort", onAbort);
        const deadlineTimer = this.runtime.schedule(() => this.handleRequestTimeout(id, startedAt), this.requestTimeoutMs);
        this.pending.set(id, {
            id,
            startedAt,
            deadlineTimer,
            removeAbortListener,
            resolve,
            reject,
        });
        signal?.addEventListener("abort", onAbort, { once: true });
        if (signal?.aborted) {
            onAbort();
        }
    }
    abortRequest(id) {
        if (!this.pending.has(id)) {
            return;
        }
        void this.beginPermanentFailure({
            primaryRequestId: id,
            primaryError: createAbortError(),
            otherError: new Error(`${this.options.workerName} 워커가 다른 요청의 취소로 종료되었습니다.`),
        });
    }
    enqueueWrite(line) {
        const write = this.writeQueue.then(() => this.writeLine(line));
        this.writeQueue = write.then(() => undefined, (error) => {
            const failure = toError(error);
            void this.beginPermanentFailure({
                primaryRequestId: null,
                primaryError: failure,
                otherError: failure,
            });
        });
    }
    writeLine(line) {
        return new Promise((resolve, reject) => {
            if (this.state !== "running" || !this.child.stdin.writable) {
                reject(this.options.buildNotRunningError(this.getStderr()));
                return;
            }
            try {
                this.child.stdin.write(line, "utf8", (error) => {
                    if (error) {
                        reject(error);
                    }
                    else {
                        resolve();
                    }
                });
            }
            catch (error) {
                reject(toError(error));
            }
        });
    }
    beginGracefulShutdown() {
        return new Promise((resolve, reject) => {
            if (!this.child.stdin.writable) {
                resolve();
                return;
            }
            try {
                this.child.stdin.write(`${JSON.stringify({ type: "shutdown" })}\n`, "utf8", (error) => {
                    if (error) {
                        reject(error);
                    }
                    else {
                        resolve();
                    }
                });
                this.child.stdin.end();
            }
            catch (error) {
                reject(toError(error));
            }
        });
    }
    handleStdout(text) {
        if (this.state !== "running") {
            return;
        }
        this.stdoutBuffer += text;
        while (this.state === "running") {
            const newlineIndex = this.stdoutBuffer.indexOf("\n");
            if (newlineIndex < 0) {
                if (this.stdoutBuffer.length > MAX_RESPONSE_LINE_LENGTH) {
                    this.failProtocol(`응답 한 줄이 최대 길이 ${MAX_RESPONSE_LINE_LENGTH}자를 초과했습니다.`);
                }
                return;
            }
            if (newlineIndex > MAX_RESPONSE_LINE_LENGTH) {
                this.failProtocol(`응답 한 줄이 최대 길이 ${MAX_RESPONSE_LINE_LENGTH}자를 초과했습니다.`);
                return;
            }
            const line = this.stdoutBuffer.slice(0, newlineIndex).trim();
            this.stdoutBuffer = this.stdoutBuffer.slice(newlineIndex + 1);
            if (line && !this.handleResponseLine(line)) {
                return;
            }
        }
    }
    handleResponseLine(line) {
        const stripped = stripAnsiEscapes(line);
        if (!stripped.startsWith("{")) {
            this.rememberStderr(`${line}\n`);
            return true;
        }
        const parsed = parseResponseLine(stripped);
        if (!parsed.ok) {
            this.failProtocol(parsed.detail);
            return false;
        }
        const response = parsed.response;
        const pending = this.takePending(response.id);
        if (!pending) {
            this.failProtocol(`알 수 없는 요청 ID를 받았습니다: ${response.id}`);
            return false;
        }
        pending.resolve(response);
        return true;
    }
    handleExit(code) {
        if (this.terminationPromise) {
            return;
        }
        if (this.state === "running") {
            this.state = "closed";
            this.rejectAllNow(this.options.buildExitError(code, this.getStderr()));
            return;
        }
        if (this.state === "closing") {
            this.state = "closed";
        }
    }
    handleChildError(error) {
        this.handlePipeError(this.enrichSpawnError(error));
    }
    handlePipeError(error) {
        if (this.state !== "running") {
            return;
        }
        void this.beginPermanentFailure({
            primaryRequestId: null,
            primaryError: error,
            otherError: error,
        });
    }
    handleRequestTimeout(id, startedAt) {
        if (!this.pending.has(id)) {
            return;
        }
        const timeoutError = new JsonWorkerRequestTimeoutError(this.options.workerName, id, this.requestTimeoutMs, Math.max(0, this.runtime.now() - startedAt));
        void this.beginPermanentFailure({
            primaryRequestId: id,
            primaryError: timeoutError,
            otherError: new Error(`${this.options.workerName} 워커가 요청 ${id} timeout 때문에 종료되었습니다.`),
        });
    }
    failProtocol(detail) {
        const error = new Error(`${this.options.workerName} 응답 프로토콜 오류: ${detail}`);
        void this.beginPermanentFailure({
            primaryRequestId: null,
            primaryError: error,
            otherError: error,
        });
    }
    beginPermanentFailure(plan) {
        if (this.terminationPromise) {
            return this.terminationPromise;
        }
        if (this.state === "closed") {
            this.rejectPendingFromPlan(plan, null);
            return Promise.resolve();
        }
        this.state = "closing";
        this.cancelAllPendingWatchdogs();
        this.terminationPromise = this.terminateAndReject(plan);
        void this.terminationPromise.catch((error) => this.options.onTerminationError(toError(error)));
        return this.terminationPromise;
    }
    async terminateAndReject(plan) {
        let terminationError = null;
        try {
            await this.runtime.forceTerminateProcessTree(this.child);
            this.state = "closed";
        }
        catch (error) {
            terminationError = toError(error);
            this.state = "termination-failed";
        }
        finally {
            this.rejectPendingFromPlan(plan, terminationError);
        }
        if (terminationError) {
            throw terminationError;
        }
    }
    rejectPendingFromPlan(plan, terminationError) {
        for (const id of [...this.pending.keys()]) {
            const pending = this.takePending(id);
            if (!pending) {
                continue;
            }
            const error = id === plan.primaryRequestId ? plan.primaryError : plan.otherError;
            if (terminationError) {
                Object.assign(error, { terminationError });
            }
            pending.reject(error);
        }
    }
    takePending(id) {
        const pending = this.pending.get(id);
        if (!pending) {
            return null;
        }
        this.pending.delete(id);
        this.runtime.clearScheduled(pending.deadlineTimer);
        pending.removeAbortListener();
        return pending;
    }
    cancelAllPendingWatchdogs() {
        for (const pending of this.pending.values()) {
            this.runtime.clearScheduled(pending.deadlineTimer);
            pending.removeAbortListener();
        }
    }
    rejectAllNow(error) {
        for (const id of [...this.pending.keys()]) {
            this.takePending(id)?.reject(error);
        }
    }
    /**
     * spawn UNKNOWN 등 child "error" 이벤트는 buildExitError(큐레이션된 백엔드별
     * 메시지)를 거치지 않고 Node의 raw Error를 그대로 reject한다. 실행 파일 경로와
     * 인자, 조치 힌트를 덧붙여 사용자가 백신 차단/누락된 DLL/PATH 문제를 진단할
     * 수 있게 한다. code/errno는 보존한다.
     */
    enrichSpawnError(error) {
        const code = error.code;
        const detail = typeof code === "string" ? code : error.message || "spawn error";
        const enriched = new Error(`${this.options.workerName} 실행 파일을 시작하지 못했습니다 (${detail}): ${this.options.executable} ${this.options.args.join(" ")}. 백신 차단, 누락된 DLL, 또는 PATH를 확인하세요. ${this.getStderr()}`.trim());
        return Object.assign(enriched, {
            code: error.code,
            errno: error.errno,
        });
    }
    assertRunning() {
        if (!this.isHealthy()) {
            throw this.options.buildNotRunningError(this.getStderr());
        }
    }
    rememberStderr(text) {
        if (!text)
            return;
        const sanitized = this.options
            .sanitizeStderr(text)
            .slice(-MAX_STDERR_CHUNK_LENGTH);
        this.stderrTail.push(sanitized);
        if (this.stderrTail.length > 80) {
            this.stderrTail.splice(0, this.stderrTail.length - 80);
        }
        this.options.onStderr(sanitized);
    }
}
async function waitForGracefulShutdown(exitPromise, shutdownWrite, timeoutMs, scheduler) {
    return await new Promise((resolve) => {
        let settled = false;
        const finish = (outcome) => {
            if (settled) {
                return;
            }
            settled = true;
            scheduler.clearScheduled(timeout);
            resolve(outcome);
        };
        const timeout = scheduler.schedule(() => finish({ kind: "timeout" }), timeoutMs);
        void exitPromise.then(() => finish({ kind: "exited" }));
        void shutdownWrite.catch((error) => finish({ kind: "write-error", error: toError(error) }));
    });
}
function stripAnsiEscapes(line) {
    // eslint-disable-next-line no-control-regex -- reference strips ANSI escape sequences
    return line.replace(/\x1b\[[0-9;]*[A-Za-z]/g, "");
}
function parseResponseLine(line) {
    let value;
    try {
        value = JSON.parse(line);
    }
    catch (error) {
        return {
            ok: false,
            detail: `JSON을 해석할 수 없습니다 (${formatInvalidLine(line)}): ${toError(error).message}`,
        };
    }
    if (!isResponseRecord(value)) {
        return {
            ok: false,
            detail: `id와 ok가 올바르지 않습니다 (${formatInvalidLine(line)})`,
        };
    }
    return { ok: true, response: value };
}
function isResponseRecord(value) {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
        return false;
    }
    const candidate = value;
    return (typeof candidate.id === "string" &&
        candidate.id.length > 0 &&
        typeof candidate.ok === "boolean" &&
        (candidate.error == null || typeof candidate.error === "string"));
}
function formatInvalidLine(line) {
    return JSON.stringify(line.slice(0, 240));
}
function normalizeRequestTimeout(timeoutMs) {
    if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
        throw new Error("워커 요청 timeout은 0보다 큰 유한한 값이어야 합니다.");
    }
    return Math.max(1, Math.floor(timeoutMs));
}
function resolveClientRuntime(overrides) {
    const runtime = { ...defaultClientRuntime, ...overrides };
    return {
        ...runtime,
        shutdownGraceMs: normalizeShutdownGrace(runtime.shutdownGraceMs),
    };
}
const defaultClientRuntime = {
    spawnWorker: ({ executable, args, env }) => spawn(executable, args, {
        windowsHide: true,
        stdio: ["pipe", "pipe", "pipe"],
        env,
        detached: shouldSpawnInOwnProcessGroup(),
    }),
    now: () => Date.now(),
    schedule: (callback, delayMs) => setTimeout(callback, delayMs),
    clearScheduled: (timer) => clearTimeout(timer),
    forceTerminateProcessTree: async (child) => {
        await forceTerminateChildProcessTree(child);
    },
    shutdownGraceMs: JSON_WORKER_SHUTDOWN_GRACE_MS,
};
function normalizeShutdownGrace(timeoutMs) {
    if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
        throw new Error("워커 종료 grace는 0보다 큰 유한한 값이어야 합니다.");
    }
    return Math.max(1, Math.floor(timeoutMs));
}
function throwIfAborted(signal) {
    if (signal?.aborted) {
        throw createAbortError();
    }
}
function createAbortError() {
    return new DOMException("Aborted", "AbortError");
}
function toError(value) {
    return value instanceof Error ? value : new Error(String(value));
}
