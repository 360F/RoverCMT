// Rover adaptation of fd461737 src/main/inpainting/inpaintingRuntimeLogger.ts.
// The Electron app logger is replaced by a sink the CLI binds to the run log.
let sink = () => {};
export function setInpaintingRuntimeLogSink(next) {
    sink = typeof next === "function" ? next : () => {};
}
export function logInpaintingRuntimeInfo(message, detail) {
    sink("info", message, detail);
}
export function logInpaintingRuntimeWarn(message, detail) {
    sink("warn", message, detail);
}
export function logInpaintingRuntimeError(message, detail) {
    sink("error", message, detail);
}
