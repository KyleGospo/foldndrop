/* Fold n' Drop — GPL-3.0. 2D geometry primitives; no gi imports. */
import { describe, it, assert, assertEqual, assertClose, assertVecClose } from './harness.js';
import {
    vec, add, sub, scale, dot, cross, len, normalize,
    makeLine, signedDistance, reflect,
    rectCorners, rectEdges, segmentIntersect, lineChordInRect,
    clipPolygonByLine, polygonArea, rectsOverlap,
} from '../src/core/geometry.js';

const RECT = { x: 100, y: 100, width: 200, height: 100 };

describe('geometry: vectors', () => {
    it('adds, subtracts and scales', () => {
        assertEqual(add(vec(1, 2), vec(3, 4)), { x: 4, y: 6 });
        assertEqual(sub(vec(3, 4), vec(1, 2)), { x: 2, y: 2 });
        assertEqual(scale(vec(1, 2), 3), { x: 3, y: 6 });
    });
    it('computes dot, cross and length', () => {
        assertClose(dot(vec(1, 2), vec(3, 4)), 11);
        assertClose(cross(vec(1, 0), vec(0, 1)), 1);
        assertClose(len(vec(3, 4)), 5);
    });
    it('normalizes to unit length', () => {
        assertVecClose(normalize(vec(0, 5)), { x: 0, y: 1 });
    });
    it('normalizes the zero vector to zero rather than NaN', () => {
        assertEqual(normalize(vec(0, 0)), { x: 0, y: 0 });
    });
});

describe('geometry: lines', () => {
    it('makeLine stores a unit normal', () => {
        const line = makeLine(vec(0, 0), vec(0, 7));
        assertVecClose(line.normal, { x: 0, y: 1 });
    });
    it('signedDistance is positive on the normal side', () => {
        const line = makeLine(vec(0, 0), vec(1, 0));
        assertClose(signedDistance(line, vec(5, 0)), 5);
        assertClose(signedDistance(line, vec(-5, 0)), -5);
        assertClose(signedDistance(line, vec(0, 99)), 0);
    });
    it('reflect mirrors a point across the line', () => {
        const line = makeLine(vec(10, 0), vec(1, 0));
        assertVecClose(reflect(line, vec(4, 3)), { x: 16, y: 3 });
    });
    it('reflect is an involution', () => {
        const line = makeLine(vec(3, 3), normalize(vec(1, 1)));
        assertVecClose(reflect(line, reflect(line, vec(9, 1))), { x: 9, y: 1 }, 1e-9);
    });
});

describe('geometry: rects', () => {
    it('lists corners clockwise from top-left', () => {
        assertEqual(rectCorners(RECT), [
            { x: 100, y: 100 }, { x: 300, y: 100 }, { x: 300, y: 200 }, { x: 100, y: 200 },
        ]);
    });
    it('gives each edge an outward normal', () => {
        const edges = rectEdges(RECT);
        assertEqual(edges.map(e => e.id), ['top', 'right', 'bottom', 'left']);
        assertEqual(edges.map(e => e.normal), [
            { x: 0, y: -1 }, { x: 1, y: 0 }, { x: 0, y: 1 }, { x: -1, y: 0 },
        ]);
    });
    it('detects overlapping rects', () => {
        assertEqual(rectsOverlap(RECT, { x: 250, y: 150, width: 100, height: 100 }), true);
    });
    it('does not count rects that only touch or miss as overlapping', () => {
        assertEqual(rectsOverlap(RECT, { x: 300, y: 100, width: 50, height: 50 }), false);
        assertEqual(rectsOverlap(RECT, { x: 900, y: 900, width: 50, height: 50 }), false);
    });
});

describe('geometry: intersection', () => {
    it('finds a crossing point of two segments', () => {
        const hit = segmentIntersect(vec(0, 0), vec(10, 10), vec(0, 10), vec(10, 0));
        assertVecClose(hit.point, { x: 5, y: 5 });
        assertClose(hit.t, 0.5);
    });
    it('returns null for parallel segments', () => {
        assertEqual(segmentIntersect(vec(0, 0), vec(10, 0), vec(0, 5), vec(10, 5)), null);
    });
    it('returns null when the segments do not overlap', () => {
        assertEqual(segmentIntersect(vec(0, 0), vec(1, 1), vec(50, 0), vec(50, 100)), null);
    });
    it('chords a rect with a vertical line', () => {
        const chord = lineChordInRect(RECT, makeLine(vec(250, 0), vec(1, 0)));
        const ys = [chord.a.y, chord.b.y].sort((p, q) => p - q);
        assertClose(chord.a.x, 250);
        assertClose(chord.b.x, 250);
        assertEqual(ys, [100, 200]);
    });
    it('returns null when the line misses the rect', () => {
        assertEqual(lineChordInRect(RECT, makeLine(vec(900, 0), vec(1, 0))), null);
    });
});

describe('geometry: polygon clipping', () => {
    it('keeps the whole rect when the line is entirely outside', () => {
        const clipped = clipPolygonByLine(rectCorners(RECT), makeLine(vec(900, 0), vec(1, 0)));
        assertClose(polygonArea(clipped), 200 * 100);
    });
    it('halves the rect when the line runs through its middle', () => {
        const clipped = clipPolygonByLine(rectCorners(RECT), makeLine(vec(200, 0), vec(1, 0)));
        assertClose(polygonArea(clipped), 100 * 100);
    });
    it('keeps nothing when the whole rect is on the folded side', () => {
        const clipped = clipPolygonByLine(rectCorners(RECT), makeLine(vec(0, 0), vec(1, 0)));
        assertClose(polygonArea(clipped), 0);
    });
    it('clips correctly along a diagonal line', () => {
        const line = makeLine(vec(200, 100), normalize(vec(1, -1)));
        const clipped = clipPolygonByLine(rectCorners(RECT), line);
        assertClose(polygonArea(clipped), 200 * 100 - 0.5 * 100 * 100);
    });
    it('computes area independent of winding direction', () => {
        assertClose(polygonArea([vec(0, 0), vec(0, 10), vec(10, 10), vec(10, 0)]), 100);
    });
});
