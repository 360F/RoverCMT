// Ported from read-only fork fd461737. See source-map.json.
import { unlink } from "node:fs/promises";
export async function removeArtifactAfterFailure(filePath, operationError) {
    try {
        await unlink(filePath);
    }
    catch (cleanupError) {
        if (isMissingFileError(cleanupError))
            throw operationError;
        throw new AggregateError([operationError, cleanupError], `작업 실패 후 불완전한 파일을 정리하지 못했습니다: ${filePath}`, { cause: cleanupError });
    }
    throw operationError;
}
function isMissingFileError(error) {
    return (error instanceof Error &&
        "code" in error &&
        error.code === "ENOENT");
}
