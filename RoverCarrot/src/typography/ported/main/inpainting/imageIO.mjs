// Rover adaptation of fd461737 src/main/inpainting/imageIO.ts (see source-map.json).
// Electron nativeImage decode is replaced by the sharp-based adapter; path
// resolution is unchanged. Decode is asynchronous in both versions.
import { mkdtemp, readFile, rm, rmdir, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { dirname, extname, join } from "node:path";
import { tmpdir } from "node:os";
import { nativeImage } from "../../../../adapters/native-image.mjs";
const INPAINTED_ARTIFACT_SUFFIX_MAX_LENGTH = 16;
export async function loadPageImage(filePath, decodeFallback) {
    const direct = await nativeImage.createFromPath(filePath);
    if (!direct.isEmpty()) {
        return direct;
    }
    const bytes = await nativeImage.createFromBuffer(await readFile(filePath));
    if (!bytes.isEmpty())
        return bytes;
    const fallbackBuffer = decodeFallback ? await decodeFallback(filePath) : null;
    if (fallbackBuffer?.length) {
        const fallback = await nativeImage.createFromBuffer(fallbackBuffer);
        if (!fallback.isEmpty()) {
            return fallback;
        }
    }
    throw new Error("인페인팅할 이미지를 읽지 못했습니다.");
}
export async function loadPageImageSnapshot(filePath, bytes, decodeFallback, signal) {
    signal?.throwIfAborted();
    const direct = await nativeImage.createFromBuffer(bytes);
    if (!direct.isEmpty())
        return direct;
    const directory = await mkdtemp(join(tmpdir(), "mgt-inpaint-snapshot-"));
    const snapshotPath = join(directory, `source${extname(filePath)}`);
    try {
        await writeFile(snapshotPath, bytes, { flag: "wx", signal });
        signal?.throwIfAborted();
        const decoded = await loadPageImage(snapshotPath, decodeFallback);
        signal?.throwIfAborted();
        return decoded;
    }
    finally {
        await rm(snapshotPath, { force: true });
        await rmdir(directory);
    }
}
export function resolveInpaintedImagePath(imagePath, suffix = "pattern") {
    const imageDir = dirname(imagePath);
    const chapterDir = dirname(imageDir);
    const safeSuffix = suffix
        .replace(/[^a-z0-9_-]/gi, "-")
        .replace(/^-+|-+$/g, "")
        .slice(0, INPAINTED_ARTIFACT_SUFFIX_MAX_LENGTH) || "image";
    return join(chapterDir, "inpainted", `${safeSuffix}-${randomUUID()}.png`);
}
export function resolveInpaintMaskPath(imagePath, suffix = "mask") {
    const imageDir = dirname(imagePath);
    const chapterDir = dirname(imageDir);
    const safeSuffix = suffix
        .replace(/[^a-z0-9_-]/gi, "-")
        .replace(/^-+|-+$/g, "")
        .slice(0, INPAINTED_ARTIFACT_SUFFIX_MAX_LENGTH) || "mask";
    return join(chapterDir, "mask", `${safeSuffix}-${randomUUID()}.png`);
}
