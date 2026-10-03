// Ported from read-only fork fd461737. See source-map.json.
const EPSILON = 1e-10;
export function createPointWarpEvaluator(source, target) {
    if (source.length !== target.length || source.length < 3) {
        throw new RangeError("Thin plate spline point sets must have equal sizes.");
    }
    if (!source.every(isFinitePoint) || !target.every(isFinitePoint)) {
        throw new RangeError("Thin plate spline points must be finite.");
    }
    const xAxis = solveThinPlateSplineAxis(source, target.map((point) => point.x));
    const yAxis = solveThinPlateSplineAxis(source, target.map((point) => point.y));
    return {
        map: (point) => ({
            x: evaluateAxis(xAxis, point),
            y: evaluateAxis(yAxis, point),
        }),
        jacobian: (point) => {
            const x = evaluateAxisDerivative(xAxis, point);
            const y = evaluateAxisDerivative(yAxis, point);
            return { xx: x.x, xy: x.y, yx: y.x, yy: y.y };
        },
    };
}
function solveThinPlateSplineAxis(anchors, values) {
    const count = anchors.length;
    const size = count + 3;
    const matrix = Array.from({ length: size }, () => Array.from({ length: size }, () => 0));
    const right = Array.from({ length: size }, () => 0);
    for (let row = 0; row < count; row += 1) {
        for (let column = 0; column < count; column += 1) {
            matrix[row][column] = radialBasis(distanceSquared(anchors[row], anchors[column]));
        }
        matrix[row][count] = 1;
        matrix[row][count + 1] = anchors[row].x;
        matrix[row][count + 2] = anchors[row].y;
        matrix[count][row] = 1;
        matrix[count + 1][row] = anchors[row].x;
        matrix[count + 2][row] = anchors[row].y;
        right[row] = values[row];
    }
    const solution = solveLinearSystem(matrix, right);
    return {
        anchors,
        weights: solution.slice(0, count),
        affine: [solution[count], solution[count + 1], solution[count + 2]],
    };
}
function solveLinearSystem(matrix, right) {
    const size = right.length;
    const augmented = matrix.map((row, index) => [...row, right[index]]);
    for (let pivot = 0; pivot < size; pivot += 1) {
        let best = pivot;
        for (let row = pivot + 1; row < size; row += 1) {
            if (Math.abs(augmented[row][pivot]) > Math.abs(augmented[best][pivot])) {
                best = row;
            }
        }
        if (Math.abs(augmented[best][pivot]) <= EPSILON) {
            throw new RangeError("Thin plate spline matrix is singular.");
        }
        [augmented[pivot], augmented[best]] = [augmented[best], augmented[pivot]];
        const divisor = augmented[pivot][pivot];
        for (let column = pivot; column <= size; column += 1) {
            augmented[pivot][column] /= divisor;
        }
        for (let row = 0; row < size; row += 1) {
            if (row === pivot)
                continue;
            const factor = augmented[row][pivot];
            if (Math.abs(factor) <= EPSILON)
                continue;
            for (let column = pivot; column <= size; column += 1) {
                augmented[row][column] -= factor * augmented[pivot][column];
            }
        }
    }
    return augmented.map((row) => row[size]);
}
function evaluateAxis(axis, point) {
    let value = axis.affine[0] + axis.affine[1] * point.x + axis.affine[2] * point.y;
    for (let index = 0; index < axis.anchors.length; index += 1) {
        value +=
            axis.weights[index] *
                radialBasis(distanceSquared(point, axis.anchors[index]));
    }
    return value;
}
function evaluateAxisDerivative(axis, point) {
    let x = axis.affine[1];
    let y = axis.affine[2];
    for (let index = 0; index < axis.anchors.length; index += 1) {
        const anchor = axis.anchors[index];
        const dx = point.x - anchor.x;
        const dy = point.y - anchor.y;
        const radiusSquared = dx * dx + dy * dy;
        if (radiusSquared <= EPSILON)
            continue;
        const factor = axis.weights[index] * 2 * (Math.log(radiusSquared) + 1);
        x += factor * dx;
        y += factor * dy;
    }
    return { x, y };
}
function radialBasis(radiusSquared) {
    return radiusSquared <= EPSILON ? 0 : radiusSquared * Math.log(radiusSquared);
}
function distanceSquared(left, right) {
    const dx = left.x - right.x;
    const dy = left.y - right.y;
    return dx * dx + dy * dy;
}
function isFinitePoint(value) {
    return Boolean(value && Number.isFinite(value.x) && Number.isFinite(value.y));
}
