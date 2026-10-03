// Ported from read-only fork fd461737. See source-map.json.
/** Retained until stream closure: late shutdown errors must also have an owner. */
export function observeProcessErrors(child, onError, onPipeError = onError) {
    child.on("error", onError);
    for (const pipe of [child.stdin, child.stdout, child.stderr])
        pipe?.on("error", onPipeError);
}
