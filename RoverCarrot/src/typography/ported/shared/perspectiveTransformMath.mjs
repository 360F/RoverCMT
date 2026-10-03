// Ported from read-only fork fd461737. See source-map.json.
import { createPerspectivePreset, MAX_BLOCK_LOCAL_COORDINATE, MIN_BLOCK_LOCAL_COORDINATE, MIN_PERSPECTIVE_AREA, MIN_PERSPECTIVE_EDGE_LENGTH, PERSPECTIVE_PRESETS, } from "./blockTransformPresets.mjs";
const EPSILON = 1e-9;
const PRECISION = 1_000_000;
export function validatePerspectiveCorners(corners) {
    if (corners.length !== 4)
        return invalid("wrong-corner-count");
    if (!corners.every(isFinitePoint))
        return invalid("non-finite");
    if (!corners.every(isPointWithinBounds))
        return invalid("out-of-range");
    const area = Math.abs(signedArea(corners));
    const minEdgeLength = Math.min(...corners.map((value, index) => distance(value, corners[(index + 1) % corners.length])));
    const result = (reason) => ({
        valid: reason === undefined,
        ...(reason ? { reason } : {}),
        area,
        minEdgeLength,
    });
    return result(resolveShapeError(corners, area, minEdgeLength));
}
function resolveShapeError(corners, area, minEdgeLength) {
    if (minEdgeLength < MIN_PERSPECTIVE_EDGE_LENGTH)
        return "edge-too-short";
    const crosses = segmentsIntersect(corners[0], corners[1], corners[2], corners[3]) ||
        segmentsIntersect(corners[1], corners[2], corners[3], corners[0]);
    if (crosses)
        return "self-intersection";
    if (area < MIN_PERSPECTIVE_AREA)
        return "area-too-small";
    const turns = corners.map((value, index) => cross(value, corners[(index + 1) % corners.length], corners[(index + 2) % corners.length]));
    if (turns.some((value) => Math.abs(value) <= EPSILON))
        return "concave";
    const allPositive = turns.every((value) => value > 0);
    const allNegative = turns.every((value) => value < 0);
    if (!allPositive && !allNegative)
        return "concave";
    if (signedArea(corners) < 0 || allNegative)
        return "flipped";
    return undefined;
}
export function isValidPerspectiveTransform(transform) {
    return Boolean(transform?.version === 1 &&
        Array.isArray(transform.corners) &&
        validatePerspectiveCorners(transform.corners).valid);
}
/** Normalize precision and bounds, falling back to identity if unsafe. */
export function normalizePerspectiveTransform(transform) {
    if (!transform ||
        transform.version !== 1 ||
        !Array.isArray(transform.corners) ||
        transform.corners.length !== 4) {
        return createPerspectivePreset("identity");
    }
    const fallback = PERSPECTIVE_PRESETS.identity.corners;
    const corners = transform.corners.map((value, index) => normalizePoint(value, fallback[index]));
    const normalized = { version: 1, corners };
    return isValidPerspectiveTransform(normalized)
        ? normalized
        : createPerspectivePreset("identity");
}
/** Map a point in the unit source rectangle into a perspective quad. */
export function mapPointToQuad(point, corners) {
    return mapPointWithHomography(point, unitSquareToQuadHomography(corners));
}
/** Map a point in a perspective quad back into the unit source rectangle. */
export function mapPointFromQuad(point, corners) {
    return mapPointWithHomography(point, invertHomography(unitSquareToQuadHomography(corners)));
}
/** Map (0,0)-(width,height) onto normalized corners scaled by that size. */
export function rectToQuadMatrix3d(width, height, corners) {
    if (!Number.isFinite(width) ||
        !Number.isFinite(height) ||
        width <= 0 ||
        height <= 0) {
        throw new RangeError("Perspective source rectangle must have a positive size.");
    }
    const value = unitSquareToQuadHomography(corners);
    return [
        value.a,
        (height / width) * value.d,
        0,
        value.g / width,
        (width / height) * value.b,
        value.e,
        0,
        value.h / height,
        0,
        0,
        1,
        0,
        width * value.c,
        height * value.f,
        0,
        1,
    ];
}
export function mapPointWithMatrix3d(point, matrix) {
    const denominator = matrix[3] * point.x + matrix[7] * point.y + matrix[15];
    if (Math.abs(denominator) <= EPSILON) {
        throw new RangeError("Perspective point maps to infinity.");
    }
    return {
        x: (matrix[0] * point.x + matrix[4] * point.y + matrix[12]) / denominator,
        y: (matrix[1] * point.x + matrix[5] * point.y + matrix[13]) / denominator,
    };
}
export function matrix3dToCss(matrix) {
    return `matrix3d(${matrix.map(formatNumber).join(", ")})`;
}
function invertHomography(value) {
    const determinant = value.a * (value.e - value.f * value.h) -
        value.b * (value.d - value.f * value.g) +
        value.c * (value.d * value.h - value.e * value.g);
    if (Math.abs(determinant) <= EPSILON) {
        throw new RangeError("Perspective quad has no stable inverse homography.");
    }
    return {
        a: (value.e - value.f * value.h) / determinant,
        b: (value.c * value.h - value.b) / determinant,
        c: (value.b * value.f - value.c * value.e) / determinant,
        d: (value.f * value.g - value.d) / determinant,
        e: (value.a - value.c * value.g) / determinant,
        f: (value.c * value.d - value.a * value.f) / determinant,
        g: (value.d * value.h - value.e * value.g) / determinant,
        h: (value.b * value.g - value.a * value.h) / determinant,
    };
}
function unitSquareToQuadHomography(corners) {
    const validation = validatePerspectiveCorners(corners);
    if (!validation.valid) {
        throw new RangeError(`Cannot create a perspective matrix from an unsafe quad (${validation.reason ?? "invalid"}).`);
    }
    const [topLeft, topRight, bottomRight, bottomLeft] = corners;
    const dx1 = topRight.x - bottomRight.x;
    const dx2 = bottomLeft.x - bottomRight.x;
    const dx3 = topLeft.x - topRight.x + bottomRight.x - bottomLeft.x;
    const dy1 = topRight.y - bottomRight.y;
    const dy2 = bottomLeft.y - bottomRight.y;
    const dy3 = topLeft.y - topRight.y + bottomRight.y - bottomLeft.y;
    let g = 0;
    let h = 0;
    if (Math.abs(dx3) > EPSILON || Math.abs(dy3) > EPSILON) {
        const denominator = dx1 * dy2 - dx2 * dy1;
        if (Math.abs(denominator) <= EPSILON) {
            throw new RangeError("Perspective quad has no stable homography.");
        }
        g = (dx3 * dy2 - dx2 * dy3) / denominator;
        h = (dx1 * dy3 - dx3 * dy1) / denominator;
    }
    return {
        a: topRight.x - topLeft.x + g * topRight.x,
        b: bottomLeft.x - topLeft.x + h * bottomLeft.x,
        c: topLeft.x,
        d: topRight.y - topLeft.y + g * topRight.y,
        e: bottomLeft.y - topLeft.y + h * bottomLeft.y,
        f: topLeft.y,
        g,
        h,
    };
}
function mapPointWithHomography(point, value) {
    const denominator = value.g * point.x + value.h * point.y + 1;
    if (Math.abs(denominator) <= EPSILON) {
        throw new RangeError("Perspective point maps to infinity.");
    }
    return {
        x: (value.a * point.x + value.b * point.y + value.c) / denominator,
        y: (value.d * point.x + value.e * point.y + value.f) / denominator,
    };
}
function normalizePoint(value, fallback) {
    return {
        x: normalizeCoordinate(value?.x, fallback.x),
        y: normalizeCoordinate(value?.y, fallback.y),
    };
}
function normalizeCoordinate(value, fallback) {
    const finite = Number.isFinite(value) ? value : fallback;
    const clamped = Math.min(MAX_BLOCK_LOCAL_COORDINATE, Math.max(MIN_BLOCK_LOCAL_COORDINATE, finite));
    const rounded = Math.round((clamped + Number.EPSILON) * PRECISION) / PRECISION;
    return Object.is(rounded, -0) ? 0 : rounded;
}
function isFinitePoint(value) {
    return Boolean(value && Number.isFinite(value.x) && Number.isFinite(value.y));
}
function isPointWithinBounds(value) {
    return (value.x >= MIN_BLOCK_LOCAL_COORDINATE &&
        value.x <= MAX_BLOCK_LOCAL_COORDINATE &&
        value.y >= MIN_BLOCK_LOCAL_COORDINATE &&
        value.y <= MAX_BLOCK_LOCAL_COORDINATE);
}
function distance(a, b) {
    return Math.hypot(b.x - a.x, b.y - a.y);
}
function signedArea(points) {
    let sum = 0;
    for (let index = 0; index < points.length; index += 1) {
        const value = points[index];
        const next = points[(index + 1) % points.length];
        sum += value.x * next.y - next.x * value.y;
    }
    return sum / 2;
}
function cross(a, b, c) {
    return (b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x);
}
function segmentsIntersect(a, b, c, d) {
    const values = [
        cross(a, b, c),
        cross(a, b, d),
        cross(c, d, a),
        cross(c, d, b),
    ];
    const proper = values[0] * values[1] < 0 && values[2] * values[3] < 0;
    if (proper)
        return true;
    return ((Math.abs(values[0]) <= EPSILON && onSegment(c, a, b)) ||
        (Math.abs(values[1]) <= EPSILON && onSegment(d, a, b)) ||
        (Math.abs(values[2]) <= EPSILON && onSegment(a, c, d)) ||
        (Math.abs(values[3]) <= EPSILON && onSegment(b, c, d)));
}
function onSegment(value, start, end) {
    return (value.x >= Math.min(start.x, end.x) - EPSILON &&
        value.x <= Math.max(start.x, end.x) + EPSILON &&
        value.y >= Math.min(start.y, end.y) - EPSILON &&
        value.y <= Math.max(start.y, end.y) + EPSILON);
}
function invalid(reason) {
    return { valid: false, reason, area: 0, minEdgeLength: 0 };
}
function formatNumber(value) {
    const rounded = Math.round((value + Number.EPSILON) * PRECISION) / PRECISION;
    return String(Object.is(rounded, -0) ? 0 : rounded);
}
