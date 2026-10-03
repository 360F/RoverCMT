// Ported from read-only fork fd461737. See source-map.json.
// Rover adaptation: Electron app logger -> inpaintingRuntimeLogger sink.
import { logInpaintingRuntimeWarn as logWarn } from "./inpainting/inpaintingRuntimeLogger.mjs";
export async function safeCleanup(label, cleanup) {
    try {
        await cleanup();
    }
    catch (error) {
        logWarn("Cleanup failed", { label, error });
    }
}
