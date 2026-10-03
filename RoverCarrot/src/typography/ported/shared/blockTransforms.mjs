// Ported from read-only fork fd461737. See source-map.json.
export { createCurvePreset, createPerspectivePreset, CURVE_PRESETS, MAX_BLOCK_LOCAL_COORDINATE, MAX_CURVE_OFFSET_EM, MIN_BLOCK_LOCAL_COORDINATE, MIN_CURVE_OFFSET_EM, PERSPECTIVE_PRESETS, } from "./blockTransformPresets.mjs";
export { normalizeCurveLayout, quadraticLength, quadraticPathToSvg, quadraticPointAt, quadraticTangentAt, validateQuadraticPath, } from "./curveTransformMath.mjs";
export { isValidPerspectiveTransform, mapPointFromQuad, mapPointToQuad, mapPointWithMatrix3d, matrix3dToCss, normalizePerspectiveTransform, rectToQuadMatrix3d, validatePerspectiveCorners, } from "./perspectiveTransformMath.mjs";
export { createIdentityWarpPoints, createIdentityWarpTransform, createInverseWarpEvaluator, createWarpEvaluator, createWarpPreset, isIdentityWarpTransform, isValidWarpTransform, resetWarpPointIndexes, resampleWarpTransform, validateWarpTransform, warpPointCount, WARP_PRESET_NAMES, } from "./warpTransformMath.mjs";
