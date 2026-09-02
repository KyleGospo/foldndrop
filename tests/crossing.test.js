/* Fold n' Drop — GPL-3.0. Boundary crossing detection; no gi imports. */
import { describe, it, assertEqual, assertClose } from './harness.js';
import { vec, makeLine } from '../src/core/geometry.js';
import { makeEdgeBoundaries, makeFoldBoundary, findCrossings } from '../src/core/crossing.js';

const A = { id: 'a', rect: { x: 0, y: 0, width: 100, height: 100 } };
const B = { id: 'b', rect: { x: 200, y: 0, width: 100, height: 100 } };

describe('crossing: boundary construction', () => {
    it('builds four edge boundaries per window', () => {
        const bounds = makeEdgeBoundaries(A);
        assertEqual(bounds.length, 4);
        assertEqual(bounds.map(b => b.edgeId), ['top', 'right', 'bottom', 'left']);
        assertEqual(bounds.every(b => b.windowId === 'a' && b.kind === 'edge'), true);
    });
    it('builds a fold boundary from the chord of the fold line', () => {
        const folded = { id: 'a', rect: A.rect, line: makeLine(vec(60, 0), vec(1, 0)) };
        const bound = makeFoldBoundary(folded);
        assertEqual(bound.kind, 'fold');
        assertEqual(bound.windowId, 'a');
        assertClose(bound.a.x, 60);
        assertClose(bound.b.x, 60);
    });
    it('returns null when the fold line misses the rect', () => {
        const folded = { id: 'a', rect: A.rect, line: makeLine(vec(900, 0), vec(1, 0)) };
        assertEqual(makeFoldBoundary(folded), null);
    });
});

describe('crossing: detection', () => {
    it('reports an outward crossing when leaving a window', () => {
        const hits = findCrossings(vec(50, 50), vec(150, 50), makeEdgeBoundaries(A));
        assertEqual(hits.length, 1);
        assertEqual(hits[0].boundary.edgeId, 'right');
        assertEqual(hits[0].direction, 'outward');
        assertClose(hits[0].point.x, 100);
    });
    it('reports an inward crossing when re-entering', () => {
        const hits = findCrossings(vec(150, 50), vec(50, 50), makeEdgeBoundaries(A));
        assertEqual(hits.length, 1);
        assertEqual(hits[0].boundary.edgeId, 'right');
        assertEqual(hits[0].direction, 'inward');
    });
    it('reports nothing for motion entirely inside a window', () => {
        assertEqual(findCrossings(vec(10, 10), vec(90, 90), makeEdgeBoundaries(A)).length, 0);
    });
    it('reports nothing for a zero-length motion', () => {
        assertEqual(findCrossings(vec(50, 50), vec(50, 50), makeEdgeBoundaries(A)).length, 0);
    });

    /* Figure 6: one fast motion sweeps out of A, across the gap, and into B.
     * Every boundary must be reported, in order, even though a naive
     * enter/leave event model would drop the middle ones. */
    it('reports every boundary crossed by a single motion, ordered along it', () => {
        const bounds = [...makeEdgeBoundaries(A), ...makeEdgeBoundaries(B)];
        const hits = findCrossings(vec(50, 50), vec(250, 50), bounds);
        assertEqual(hits.map(h => [h.boundary.windowId, h.boundary.edgeId, h.direction]), [
            ['a', 'right', 'outward'],
            ['b', 'left', 'inward'],
        ]);
        assertEqual(hits[0].t < hits[1].t, true);
    });

    it('reports both crossings of a single in-and-out sweep through one window', () => {
        const hits = findCrossings(vec(-50, 50), vec(150, 50), makeEdgeBoundaries(A));
        assertEqual(hits.map(h => [h.boundary.edgeId, h.direction]), [
            ['left', 'inward'],
            ['right', 'outward'],
        ]);
    });

    it('treats a fold boundary like any other boundary', () => {
        const folded = { id: 'a', rect: A.rect, line: makeLine(vec(60, 0), vec(1, 0)) };
        const hits = findCrossings(vec(50, 50), vec(70, 50), [makeFoldBoundary(folded)]);
        assertEqual(hits.length, 1);
        assertEqual(hits[0].boundary.kind, 'fold');
        assertEqual(hits[0].direction, 'outward');
    });
});
