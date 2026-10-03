// Ported from read-only fork fd461737. See source-map.json.
import { projectWindowMask } from "./bubbleLayoutConstraintMask.mjs";
export function coalesceSharedConstrainedWindows(context) {
    const roots = resolveSharedWindowRoots(context.inpaintWindowGroupIds);
    const windows = [];
    const masks = [];
    const compositeMasks = [];
    const compositeFeatherPx = [];
    const constraints = [];
    const groupIds = [];
    const outputIndexByRoot = new Map();
    for (let index = 0; index < context.inpaintWindows.length; index += 1) {
        const entry = readSharedWindowEntry(context, index);
        const root = roots[index] ?? index;
        const outputIndex = outputIndexByRoot.get(root);
        if (outputIndex === undefined) {
            outputIndexByRoot.set(root, windows.length);
            windows.push(entry.window);
            masks.push(entry.mask);
            compositeMasks.push(entry.compositeMask);
            compositeFeatherPx.push(entry.featherPx);
            constraints.push(entry.constraint);
            groupIds.push(entry.groupIds);
            continue;
        }
        const existingWindow = windows[outputIndex];
        const existingMask = masks[outputIndex];
        windows[outputIndex] = unionRects(existingWindow, entry.window);
        masks[outputIndex] = unionWindowMasks(existingMask, entry.mask);
        compositeMasks[outputIndex] = unionWindowMasks(compositeMasks[outputIndex], entry.compositeMask);
        compositeFeatherPx[outputIndex] = Math.max(compositeFeatherPx[outputIndex] ?? 0, entry.featherPx);
        constraints[outputIndex] = unionOptionalWindowMasks(constraints[outputIndex] ?? null, entry.constraint);
        groupIds[outputIndex] = [
            ...new Set([...(groupIds[outputIndex] ?? []), ...entry.groupIds]),
        ];
    }
    context.inpaintWindows = windows;
    context.inpaintWindowMasks = masks;
    context.inpaintCompositeMasks = compositeMasks;
    context.inpaintCompositeFeatherPx = compositeFeatherPx;
    context.inpaintWindowConstraints = constraints;
    context.inpaintWindowGroupIds = groupIds;
}
function readSharedWindowEntry(context, index) {
    const window = context.inpaintWindows[index];
    const mask = context.inpaintWindowMasks[index];
    const compositeMask = context.inpaintCompositeMasks[index];
    const featherPx = context.inpaintCompositeFeatherPx[index];
    if (!window || !mask || !compositeMask || featherPx === undefined) {
        throw new Error("Inpainting window metadata is incomplete.");
    }
    return {
        compositeMask,
        constraint: context.inpaintWindowConstraints[index] ?? null,
        featherPx,
        groupIds: [...(context.inpaintWindowGroupIds[index] ?? [])],
        mask,
        window,
    };
}
function resolveSharedWindowRoots(groupIds) {
    const parents = groupIds.map((_, index) => index);
    const firstWindowByGroup = new Map();
    for (const [index, ids] of groupIds.entries()) {
        for (const id of ids) {
            const firstIndex = firstWindowByGroup.get(id);
            if (firstIndex === undefined) {
                firstWindowByGroup.set(id, index);
            }
            else {
                joinWindowRoots(parents, firstIndex, index);
            }
        }
    }
    return parents.map((_, index) => findWindowRoot(parents, index));
}
function findWindowRoot(parents, index) {
    let root = index;
    while (parents[root] !== root)
        root = parents[root];
    let cursor = index;
    while (parents[cursor] !== cursor) {
        const parent = parents[cursor];
        parents[cursor] = root;
        cursor = parent;
    }
    return root;
}
function joinWindowRoots(parents, left, right) {
    const leftRoot = findWindowRoot(parents, left);
    const rightRoot = findWindowRoot(parents, right);
    if (leftRoot !== rightRoot)
        parents[rightRoot] = leftRoot;
}
function unionOptionalWindowMasks(left, right) {
    if (!left)
        return right;
    if (!right)
        return left;
    return unionWindowMasks(left, right);
}
function unionWindowMasks(left, right) {
    const bounds = unionRects(left.bounds, right.bounds);
    const data = projectWindowMask(left, bounds);
    mergeLocalMask(data, projectWindowMask(right, bounds));
    return { bounds, data };
}
function unionRects(left, right) {
    const x = Math.min(left.x, right.x);
    const y = Math.min(left.y, right.y);
    const rightEdge = Math.max(left.x + left.w, right.x + right.w);
    const bottomEdge = Math.max(left.y + left.h, right.y + right.h);
    return { x, y, w: rightEdge - x, h: bottomEdge - y };
}
function mergeLocalMask(target, source) {
    for (let index = 0; index < target.length; index += 1) {
        if (source[index])
            target[index] = 1;
    }
}
