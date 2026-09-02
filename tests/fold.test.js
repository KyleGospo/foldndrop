/* Fold n' Drop — GPL-3.0. Tests for fold line creation, pushing and coverage; no gi imports. */
import { describe, it, assert, assertEqual, assertClose, assertVecClose } from './harness.js';
import { vec, makeLine, normalize, signedDistance, rectEdges } from '../src/core/geometry.js';
import {
    NORMAL, TRANSIENT, FOLDED, DISCARDED,
    anchorFoldLine, pushFoldLine, visibleFraction, foldPaintBounds,
    cornerFor, cornerDistance, lineAtCornerDistance,
    maxCornerDistance, liftDistance, cornerLiftNormal,
} from '../src/core/fold.js';

const RECT = { x: 0, y: 0, width: 200, height: 100 };
const RIGHT = rectEdges(RECT).find(e => e.id === 'right');

describe('fold: states', () => {
    it('exposes four distinct state constants', () => {
        assertEqual(new Set([NORMAL, TRANSIENT, FOLDED, DISCARDED]).size, 4);
    });
});

describe('fold: anchoring and pushing', () => {
    /* The crease follows the pointer as it moves into the window body. The
     * paper: the fold is "translated by IP' plus a small delta so that P'
     * remains on the same side" — the folded side. */
    it('anchors the crease just behind the pointer', () => {
        const anchored = anchorFoldLine(vec(1, 0), vec(150, 50), 4);
        assertClose(anchored.point.x, 146);
        assertClose(signedDistance(anchored, vec(150, 50)), 4);
    });
    it('leaves the pointer on the folded side by exactly the delta', () => {
        const line = makeLine(vec(100, 0), vec(1, 0));
        const pushed = pushFoldLine(line, vec(130, 50), vec(70, 50), 4, 0);
        assertClose(signedDistance(pushed, vec(70, 50)), 4);
    });
    it('deepens the fold rather than retracting it', () => {
        const line = makeLine(vec(100, 0), vec(1, 0));
        const pushed = pushFoldLine(line, vec(130, 50), vec(70, 50), 4, 0);
        assert(visibleFraction(RECT, pushed) < visibleFraction(RECT, line), 'push must reduce visible area');
    });
    it('turns the fold line toward perpendicular to the motion', () => {
        const line = makeLine(vec(100, 0), vec(1, 0));
        const pushed = pushFoldLine(line, vec(130, 90), vec(70, 50), 4, 0.5);
        assert(pushed.normal.y > 0, 'the normal must tilt to stay opposite an up-and-left push');
        assertClose(Math.hypot(pushed.normal.x, pushed.normal.y), 1);
    });
    it('leaves the normal alone when rotationLerp is zero', () => {
        const line = makeLine(vec(100, 0), vec(1, 0));
        const pushed = pushFoldLine(line, vec(130, 90), vec(70, 50), 4, 0);
        assertVecClose(pushed.normal, { x: 1, y: 0 });
    });
    it('survives a zero-length motion without producing NaN', () => {
        const line = makeLine(vec(100, 0), vec(1, 0));
        const pushed = pushFoldLine(line, vec(70, 50), vec(70, 50), 4, 0.5);
        assertVecClose(pushed.normal, { x: 1, y: 0 });
    });
});

describe('fold: coverage', () => {
    it('reports the full window as visible when nothing is folded', () => {
        assertClose(visibleFraction(RECT, makeLine(vec(500, 0), vec(1, 0))), 1);
    });
    it('reports half visible for a line through the middle', () => {
        assertClose(visibleFraction(RECT, makeLine(vec(100, 0), vec(1, 0))), 0.5);
    });
    it('reports nothing visible when the line is past the far edge', () => {
        assertClose(visibleFraction(RECT, makeLine(vec(-10, 0), vec(1, 0))), 0);
    });
    it('handles a diagonal fold line', () => {
        const line = makeLine(vec(100, 0), normalize(vec(1, -1)));
        assertClose(visibleFraction(RECT, line), 1 - (0.5 * 100 * 100) / (200 * 100));
    });
});

describe('fold: the box a fold paints in', () => {
    /* Walk the folded-away half of the window and check that every place the
     * flap and the shadow put a sample lands inside the reported box. This is
     * the shader's own arithmetic, so a box that passes here is a container
     * the flap cannot be clipped by. */
    function assertBoundsCover(rect, line, flapScale) {
        const box = foldPaintBounds(rect, line, flapScale);
        for (let y = 0; y <= rect.height; y++) {
            for (let x = 0; x <= rect.width; x++) {
                const q = vec(rect.x + x, rect.y + y);
                const s = signedDistance(line, q);
                if (s <= 0)
                    continue;
                for (const factor of [1 + flapScale, 2]) {
                    const p = vec(q.x - factor * s * line.normal.x,
                                  q.y - factor * s * line.normal.y);
                    assert(p.x >= box.x - 1e-6 && p.x <= box.x + box.width + 1e-6 &&
                           p.y >= box.y - 1e-6 && p.y <= box.y + box.height + 1e-6,
                        `(${p.x.toFixed(1)},${p.y.toFixed(1)}) falls outside ` +
                        `(${box.x.toFixed(1)},${box.y.toFixed(1)},` +
                        `${box.width.toFixed(1)}x${box.height.toFixed(1)})`);
                }
            }
        }
    }

    it('is the window itself while nothing is folded away', () => {
        const box = foldPaintBounds(RECT, makeLine(vec(210, 0), vec(1, 0)), 0.8);
        assertClose(box.x, RECT.x);
        assertClose(box.y, RECT.y);
        assertClose(box.width, RECT.width);
        assertClose(box.height, RECT.height);
    });

    it('grows along the crease normal once the flap reaches past the far edge', () => {
        /* Three quarters of the window is folded away over the quarter that is
         * left, so the paint runs from x = -100 (the mirror of the far edge)
         * to x = 50 (the crease). Nothing is painted to the right of it. */
        const box = foldPaintBounds(RECT, makeLine(vec(50, 0), vec(1, 0)), 1);
        assertClose(box.x, -100);
        assertClose(box.width, 150);
    });

    it('covers a diagonal fold whose flap swings sideways', () => {
        /* The case that clipped the flap at the bottom of the window. A
         * corner barely behind the crease is still thrown a long way past the
         * window's own edge, so measuring the overhang along the crease
         * normal — which reports nothing at all here — is not enough. */
        const rect = { x: 500, y: 200, width: 900, height: 600 };
        const line = makeLine(vec(950, 500), normalize(vec(0.8, -0.6)));
        const box = foldPaintBounds(rect, line, 0.8);
        assert(box.y + box.height > rect.y + rect.height + 100,
            'the box does not reach past the bottom of the window');
        assertBoundsCover(rect, line, 0.8);
    });

    it('covers the flap for folds at every angle and depth', () => {
        const rect = { x: 0, y: 0, width: 160, height: 120 };
        for (let deg = 0; deg < 360; deg += 30) {
            const normal = normalize(vec(Math.cos(deg * Math.PI / 180),
                                         Math.sin(deg * Math.PI / 180)));
            for (const depth of [10, 60, 140]) {
                const corner = cornerFor(rect, normal);
                const point = vec(corner.x - normal.x * depth, corner.y - normal.y * depth);
                assertBoundsCover(rect, makeLine(point, normal), 0.8);
            }
        }
    });

    it('spreads the box out for a blurred shadow', () => {
        const line = makeLine(vec(150, 0), vec(1, 0));
        const tight = foldPaintBounds(RECT, line, 0.8);
        const spread = foldPaintBounds(RECT, line, 0.8, 12);
        assertClose(spread.x, tight.x - 12);
        assertClose(spread.width, tight.width + 24);
    });
});

describe('fold: corner parameterisation', () => {
    it('cuts the corner furthest into the folded-away direction', () => {
        assertEqual(cornerFor(RECT, normalize(vec(1, -1))), { x: 200, y: 0 });
        assertEqual(cornerFor(RECT, normalize(vec(-1, -1))), { x: 0, y: 0 });
        assertEqual(cornerFor(RECT, normalize(vec(-1, 1))), { x: 0, y: 100 });
        assertEqual(cornerFor(RECT, normalize(vec(1, 1))), { x: 200, y: 100 });
    });
    it('picks a corner on the crossed edge for an axis-aligned normal', () => {
        const corner = cornerFor(RECT, vec(1, 0));
        assertClose(corner.x, 200);
    });
    it('round-trips a distance through the line and back', () => {
        const normal = normalize(vec(1, -1));
        const line = lineAtCornerDistance(RECT, normal, 37);
        assertClose(cornerDistance(RECT, line), 37);
        assertVecClose(line.normal, normal);
    });
    it('puts the crease through the corner at distance zero', () => {
        const line = lineAtCornerDistance(RECT, normalize(vec(1, -1)), 0);
        assertClose(signedDistance(line, vec(200, 0)), 0);
    });
    it('folds nothing away at distance zero', () => {
        const line = lineAtCornerDistance(RECT, normalize(vec(1, -1)), 0);
        assertClose(visibleFraction(RECT, line), 1);
    });
    it('measures the far corner as the deepest', () => {
        /* A 45 degree normal at the top-right: the bottom-left corner is the
         * furthest away, at (200 + 100) / sqrt(2). */
        assertClose(maxCornerDistance(RECT, normalize(vec(1, -1))), 300 / Math.SQRT2, 1e-6);
    });
});

describe('fold: lift depth', () => {
    it('uses the requested depth when the window can afford it', () => {
        assertClose(liftDistance(RECT, normalize(vec(1, -1)), 48), 48);
    });
    it('caps the depth so a small window never folds entirely away', () => {
        const tiny = { x: 0, y: 0, width: 40, height: 40 };
        const normal = normalize(vec(1, -1));
        const capped = liftDistance(tiny, normal, 48);
        assert(capped < 48, 'the request must be capped');
        assert(visibleFraction(tiny, lineAtCornerDistance(tiny, normal, capped)) > 0,
            'a capped lift must leave something visible');
    });
});

describe('fold: corner lift normal', () => {
    /* The reference tilts a corner exit by atan(0.75) = 36.87 degrees, which
     * is the 3-4-5 triangle: normal (0.8, -0.6). */
    it('cuts the corner off when the pointer leaves at one', () => {
        const line = makeLine(vec(0, 0), cornerLiftNormal(RIGHT, vec(200, 0)));
        assertVecClose(line.normal, vec(0.8, -0.6), 1e-6);
    });
    it('runs parallel to the edge when the pointer leaves mid-edge', () => {
        const normal = cornerLiftNormal(RIGHT, vec(200, 50));
        assertVecClose(normal, vec(1, 0), 1e-6);
    });
    it('tilts toward the corner the pointer is heading for', () => {
        /* Same mid-edge exit, but travelling up and out rather than straight
         * out: the crease must lean toward the top-right corner. */
        const straight = cornerLiftNormal(RIGHT, vec(200, 50));
        const aimed = cornerLiftNormal(RIGHT, vec(200, 50), vec(10, -10));
        assertClose(straight.y, 0, 1e-9, 'no motion, no tilt');
        assert(aimed.y < -0.1, 'travel toward the corner must tilt the crease at it');
    });
    it('lifts the corner the pointer left nearest', () => {
        const near = cornerLiftNormal(RIGHT, vec(200, 5));
        const far = cornerLiftNormal(RIGHT, vec(200, 95));
        assertEqual(cornerFor(RECT, near), { x: 200, y: 0 });
        assertEqual(cornerFor(RECT, far), { x: 200, y: 100 });
    });
    it('is steeper near a corner than at mid-edge', () => {
        const atCorner = cornerLiftNormal(RIGHT, vec(200, 0));
        const atMiddle = cornerLiftNormal(RIGHT, vec(200, 50));
        assert(Math.abs(atCorner.y) > Math.abs(atMiddle.y),
            'leaving at the corner must tilt the crease further');
    });
    it('always returns a unit vector', () => {
        for (const y of [0, 1, 25, 50, 75, 99, 100]) {
            const n = cornerLiftNormal(RIGHT, vec(200, y));
            assertClose(Math.hypot(n.x, n.y), 1, 1e-9, `not unit at y=${y}`);
        }
    });
});

