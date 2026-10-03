// Ported from read-only fork fd461737. See source-map.json.
import { createHash } from "node:crypto";
import { SOURCE_GLYPH_RESIDUAL_CONTRACT_VERSION, } from "./sourceGlyphResidual.mjs";
const SOURCE_GLYPH_EVIDENCE_RECEIPT_CONTRACT_VERSION = "source-glyph-evidence-receipt-v1";
const SOURCE_GLYPH_EVIDENCE_DECODER_CONTRACT = "electron-native-image-bgra8-v1";
export function createPatternBitmapBaseline(options) {
    if (!options.assetPath ||
        !Number.isInteger(options.width) ||
        !Number.isInteger(options.height) ||
        options.width <= 0 ||
        options.height <= 0 ||
        options.bitmap.length !== options.width * options.height * 4) {
        throw new Error("Invalid pattern bitmap baseline contract.");
    }
    return {
        assetPath: options.assetPath,
        assetSha256: options.assetBytes ? sha256(options.assetBytes) : null,
        bitmap: Buffer.from(options.bitmap),
        bitmapSha256: sha256(options.bitmap),
        height: options.height,
        width: options.width,
    };
}
export function buildPatternSourceGlyphEvidenceReceipt(options) {
    const blockEntries = [...options.validationBindingsByBlockId.entries()].sort(([left], [right]) => left.localeCompare(right));
    const blocksById = Object.fromEntries(blockEntries.map(([blockId, binding]) => {
        if (blockId !== binding.blockId) {
            throw new Error("Source evidence block-key binding mismatch.");
        }
        return [
            blockId,
            {
                blockId,
                firstPassCoreBounds: { ...binding.firstPassCore.bounds },
                firstPassCoreSha256: hashWindowMask(binding.firstPassCore),
                sourceEvidenceBounds: {
                    ...binding.sourceGlyphEvidence.windowMask.bounds,
                },
                sourceEvidenceSha256: hashSourceGlyphEvidence(binding.sourceGlyphEvidence),
                sourceEvidenceStrategy: binding.sourceGlyphEvidence.strategy,
                sourceAssetSha256: options.source.assetSha256,
                sourceBitmapSha256: options.source.bitmapSha256,
            },
        ];
    }));
    const sealingErrors = resolveSealingErrors(options, blockEntries.length);
    const receiptWithoutBinding = {
        contractVersion: SOURCE_GLYPH_EVIDENCE_RECEIPT_CONTRACT_VERSION,
        diagnosticOnly: true,
        promotionEligible: false,
        resolutionNormalized: false,
        sealed: sealingErrors.length === 0,
        sealingErrors,
        decoderContract: SOURCE_GLYPH_EVIDENCE_DECODER_CONTRACT,
        sourceEvidenceProfileContract: "pattern-text-mask-zero-dilation-v1",
        residualProfileContract: SOURCE_GLYPH_RESIDUAL_CONTRACT_VERSION,
        pageId: options.pageId,
        source: {
            ...withoutBitmap(options.source),
            baselineKind: "immutable-original",
        },
        before: {
            ...withoutBitmap(options.before),
            baselineKind: options.before.assetPath === options.source.assetPath
                ? "immutable-original"
                : "retry-cleaned",
        },
        after: {
            baselineKind: "cleaned-output-bitmap",
            bitmapSha256: sha256(options.afterBitmap),
            cleanedAssetPath: options.cleanedAssetPath ?? null,
            cleanedAssetSha256: options.cleanedAssetBytes
                ? sha256(options.cleanedAssetBytes)
                : null,
        },
        blocksById,
        blockIdsSha256: sha256Canonical(blockEntries.map(([blockId]) => blockId)),
    };
    return {
        ...receiptWithoutBinding,
        bindingSha256: sha256Canonical(receiptWithoutBinding),
    };
}
function hashWindowMask(mask) {
    const hash = createHash("sha256");
    hash.update(JSON.stringify({
        contract: "inpainting-window-mask-v1",
        bounds: mask.bounds,
        length: mask.data.length,
    }));
    hash.update(Buffer.from(mask.data));
    return hash.digest("hex");
}
export function assertPatternValidationBindings(mask) {
    const blockCount = mask.validationBlockIds.length;
    if (mask.validationWindowMasks.length !== blockCount) {
        throw new Error("Inpainting validation mask ownership is incomplete.");
    }
    if (mask.sourceGlyphEvidence.length !== blockCount) {
        throw new Error("Source-glyph validation evidence ownership is incomplete.");
    }
    if (mask.validationBindingsByBlockId.size !== blockCount) {
        throw new Error("Source-glyph keyed evidence ownership is incomplete.");
    }
    if (new Set(mask.validationBlockIds).size !== blockCount) {
        throw new Error("Source-glyph keyed evidence contains duplicate blocks.");
    }
    for (let index = 0; index < blockCount; index += 1) {
        assertPatternValidationBinding(mask, index);
    }
}
export function verifyPatternSourceGlyphEvidenceReceipt(value) {
    const reasons = [];
    if (!value || typeof value !== "object" || Array.isArray(value)) {
        return { valid: false, reasons: ["receipt-object-invalid"] };
    }
    const receipt = value;
    const source = objectValue(receipt.source);
    const before = objectValue(receipt.before);
    const after = objectValue(receipt.after);
    const blocks = objectValue(receipt.blocksById);
    if (receipt.contractVersion !== SOURCE_GLYPH_EVIDENCE_RECEIPT_CONTRACT_VERSION) {
        reasons.push("receipt-contract-invalid");
    }
    if (receipt.diagnosticOnly !== true ||
        receipt.promotionEligible !== false ||
        receipt.resolutionNormalized !== false ||
        receipt.sealed !== true ||
        !Array.isArray(receipt.sealingErrors) ||
        receipt.sealingErrors.length !== 0) {
        reasons.push("receipt-safety-state-invalid");
    }
    if (receipt.decoderContract !== SOURCE_GLYPH_EVIDENCE_DECODER_CONTRACT ||
        receipt.sourceEvidenceProfileContract !==
            "pattern-text-mask-zero-dilation-v1" ||
        receipt.residualProfileContract !== SOURCE_GLYPH_RESIDUAL_CONTRACT_VERSION) {
        reasons.push("receipt-profile-invalid");
    }
    if (typeof receipt.pageId !== "string" ||
        !receipt.pageId ||
        !validSourceBaseline(source) ||
        !validBeforeBaseline(before, source) ||
        !validAfterBaseline(after)) {
        reasons.push("receipt-baseline-invalid");
    }
    const blockIds = Object.keys(blocks).sort();
    if (blockIds.length === 0 || !validReceiptBlocks(blocks, blockIds, source)) {
        reasons.push("receipt-block-bindings-invalid");
    }
    if (receipt.blockIdsSha256 !== sha256Canonical(blockIds)) {
        reasons.push("receipt-block-id-sha-mismatch");
    }
    const { bindingSha256, ...receiptWithoutBinding } = receipt;
    if (!isSha256(bindingSha256) ||
        bindingSha256 !== sha256Canonical(receiptWithoutBinding)) {
        reasons.push("receipt-binding-sha-mismatch");
    }
    return { valid: reasons.length === 0, reasons };
}
function validReceiptBlocks(blocks, blockIds, source) {
    return blockIds.every((blockId) => {
        const block = objectValue(blocks[blockId]);
        return (block.blockId === blockId &&
            validBounds(block.firstPassCoreBounds) &&
            isSha256(block.firstPassCoreSha256) &&
            validBounds(block.sourceEvidenceBounds) &&
            isSha256(block.sourceEvidenceSha256) &&
            ["adaptive", "otsu", "none"].includes(String(block.sourceEvidenceStrategy)) &&
            block.sourceAssetSha256 === source.assetSha256 &&
            block.sourceBitmapSha256 === source.bitmapSha256);
    });
}
function validSourceBaseline(value) {
    return (value.baselineKind === "immutable-original" && validAssetBaseline(value));
}
function validBeforeBaseline(value, source) {
    return ((value.baselineKind === "immutable-original" ||
        value.baselineKind === "retry-cleaned") &&
        validAssetBaseline(value) &&
        value.width === source.width &&
        value.height === source.height);
}
function validAfterBaseline(value) {
    return (value.baselineKind === "cleaned-output-bitmap" &&
        typeof value.cleanedAssetPath === "string" &&
        value.cleanedAssetPath.length > 0 &&
        isSha256(value.bitmapSha256) &&
        isSha256(value.cleanedAssetSha256));
}
function validAssetBaseline(value) {
    return (typeof value.assetPath === "string" &&
        value.assetPath.length > 0 &&
        isSha256(value.assetSha256) &&
        isSha256(value.bitmapSha256) &&
        typeof value.width === "number" &&
        Number.isInteger(value.width) &&
        value.width > 0 &&
        typeof value.height === "number" &&
        Number.isInteger(value.height) &&
        value.height > 0);
}
function validBounds(value) {
    const bounds = objectValue(value);
    return (typeof bounds.x === "number" &&
        Number.isInteger(bounds.x) &&
        bounds.x >= 0 &&
        typeof bounds.y === "number" &&
        Number.isInteger(bounds.y) &&
        bounds.y >= 0 &&
        typeof bounds.w === "number" &&
        Number.isInteger(bounds.w) &&
        bounds.w > 0 &&
        typeof bounds.h === "number" &&
        Number.isInteger(bounds.h) &&
        bounds.h > 0);
}
function assertPatternValidationBinding(mask, index) {
    const blockId = mask.validationBlockIds[index];
    const core = mask.validationWindowMasks[index];
    const evidence = mask.sourceGlyphEvidence[index];
    if (!blockId || !core || !evidence) {
        throw new Error("Source-glyph array evidence binding is invalid.");
    }
    const keyed = mask.validationBindingsByBlockId.get(blockId);
    if (!keyed || keyed.blockId !== blockId) {
        throw new Error("Source-glyph block-key evidence binding is invalid.");
    }
    if (hashWindowMask(keyed.firstPassCore) !== hashWindowMask(core)) {
        throw new Error("Source-glyph block-key core hash mismatch.");
    }
    if (keyed.sourceGlyphEvidence.strategy !== evidence.strategy) {
        throw new Error("Source-glyph block-key strategy mismatch.");
    }
    if (hashWindowMask(keyed.sourceGlyphEvidence.windowMask) !==
        hashWindowMask(evidence.windowMask)) {
        throw new Error("Source-glyph block-key evidence hash mismatch.");
    }
}
export function hashSourceGlyphEvidence(evidence) {
    return sha256Canonical({
        contract: "source-glyph-evidence-v1",
        strategy: evidence.strategy,
        windowMaskSha256: hashWindowMask(evidence.windowMask),
    });
}
function resolveSealingErrors(options, blockCount) {
    const errors = [];
    if (!options.pageId.trim())
        errors.push("source-page-id-missing");
    if (!options.source.assetSha256)
        errors.push("source-asset-sha-missing");
    if (!options.before.assetSha256)
        errors.push("before-asset-sha-missing");
    if (options.source.bitmapSha256 !== sha256(options.source.bitmap)) {
        errors.push("source-bitmap-sha-mismatch");
    }
    if (options.before.bitmapSha256 !== sha256(options.before.bitmap)) {
        errors.push("before-bitmap-sha-mismatch");
    }
    if (options.source.width !== options.before.width) {
        errors.push("source-before-width-mismatch");
    }
    if (options.source.height !== options.before.height) {
        errors.push("source-before-height-mismatch");
    }
    if (options.afterBitmap.length !== options.source.bitmap.length) {
        errors.push("source-after-bitmap-length-mismatch");
    }
    if (blockCount <= 0)
        errors.push("block-bindings-missing");
    const expectedBlockIds = [...new Set(options.expectedBlockIds)].sort();
    const actualBlockIds = [...options.validationBindingsByBlockId.keys()].sort();
    if (JSON.stringify(expectedBlockIds) !== JSON.stringify(actualBlockIds)) {
        errors.push("eligible-block-membership-mismatch");
    }
    if (!options.cleanedAssetPath || !options.cleanedAssetBytes) {
        errors.push("cleaned-asset-sha-missing");
    }
    return errors;
}
function withoutBitmap(baseline) {
    // eslint-disable-next-line @typescript-eslint/no-unused-vars -- reference destructuring excludes bitmap from the receipt
    const { bitmap: _bitmap, ...receipt } = baseline;
    return receipt;
}
function objectValue(value) {
    return value && typeof value === "object" && !Array.isArray(value)
        ? value
        : {};
}
function isSha256(value) {
    return typeof value === "string" && /^[a-f0-9]{64}$/u.test(value);
}
function sha256(value) {
    return createHash("sha256").update(value).digest("hex");
}
function sha256Canonical(value) {
    return sha256(Buffer.from(stableStringify(value)));
}
function stableStringify(value) {
    if (Array.isArray(value)) {
        return `[${value.map(stableStringify).join(",")}]`;
    }
    if (value && typeof value === "object") {
        const record = value;
        return `{${Object.keys(record)
            .sort()
            .map((key) => `${JSON.stringify(key)}:${stableStringify(record[key])}`)
            .join(",")}}`;
    }
    return JSON.stringify(value) ?? "null";
}
