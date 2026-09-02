/* Fold n' Drop — GPL-3.0. Tests for multi-fold stacking coherency; no gi imports. */
import { describe, it, assert, assertEqual, assertClose } from './harness.js';
import { vec, makeLine, signedDistance } from '../src/core/geometry.js';
import { NORMAL, FOLDED } from '../src/core/fold.js';
import { windowsAbove, windowsBelow, enforceFoldOrder } from '../src/core/coherency.js';

const ORDER = ['bottom', 'middle', 'top'];
const RECT = { x: 0, y: 0, width: 200, height: 100 };

function states(entries) {
    return new Map(entries.map(([id, state, line]) => [id, { rect: RECT, state, line: line ?? null }]));
}

/* Sample the window interior, not just its corners: a violation caused by a
 * crease cutting through the middle is invisible at the corners. */
function interiorSamples() {
    const pts = [];
    for (let x = 0; x <= 200; x += 5)
        for (const y of [0, 50, 100])
            pts.push(vec(x, y));
    return pts;
}

describe('coherency: stacking helpers', () => {
    it('lists windows above, bottom-to-top', () => {
        assertEqual(windowsAbove(ORDER, 'bottom'), ['middle', 'top']);
        assertEqual(windowsAbove(ORDER, 'top'), []);
    });
    it('lists windows below', () => {
        assertEqual(windowsBelow(ORDER, 'top'), ['bottom', 'middle']);
        assertEqual(windowsBelow(ORDER, 'bottom'), []);
    });
    it('returns nothing for an unknown window', () => {
        assertEqual(windowsAbove(ORDER, 'ghost'), []);
        assertEqual(windowsBelow(ORDER, 'ghost'), []);
    });
});

describe('coherency: no fold intersects an upper window', () => {
    it('pushes an upper fold out to cover a deeper lower fold', () => {
        const map = states([
            ['bottom', FOLDED, makeLine(vec(50, 0), vec(1, 0))],
            ['top', FOLDED, makeLine(vec(150, 0), vec(1, 0))],
        ]);
        enforceFoldOrder(['bottom', 'top'], map);
        const topLine = map.get('top').line;
        for (const corner of interiorSamples()) {
            if (signedDistance(map.get('bottom').line, corner) > 0)
                assert(signedDistance(topLine, corner) >= -1e-9,
                    'every pixel folded away below must also be folded away above');
        }
    });
    it('leaves an already-deeper upper fold alone', () => {
        const upper = makeLine(vec(20, 0), vec(1, 0));
        const map = states([
            ['bottom', FOLDED, makeLine(vec(150, 0), vec(1, 0))],
            ['top', FOLDED, upper],
        ]);
        enforceFoldOrder(['bottom', 'top'], map);
        assertEqual(map.get('top').line.point.x, 20);
    });
    it('ignores unfolded windows', () => {
        const map = states([
            ['bottom', FOLDED, makeLine(vec(50, 0), vec(1, 0))],
            ['top', NORMAL, null],
        ]);
        enforceFoldOrder(['bottom', 'top'], map);
        assertEqual(map.get('top').line, null);
    });
    it('ignores a window above that does not overlap the folded one', () => {
        const map = new Map([
            ['bottom', { rect: RECT, state: FOLDED, line: makeLine(vec(50, 0), vec(1, 0)) }],
            ['top', { rect: { x: 900, y: 0, width: 100, height: 100 }, state: FOLDED, line: makeLine(vec(980, 0), vec(1, 0)) }],
        ]);
        enforceFoldOrder(['bottom', 'top'], map);
        assertEqual(map.get('top').line.point.x, 980);
    });
    it('holds after a sequence of pushes on the lowest window', () => {
        const map = states([
            ['bottom', FOLDED, makeLine(vec(190, 0), vec(1, 0))],
            ['middle', FOLDED, makeLine(vec(190, 0), vec(1, 0))],
            ['top', FOLDED, makeLine(vec(190, 0), vec(1, 0))],
        ]);
        for (const x of [150, 110, 70, 30]) {
            map.get('bottom').line = makeLine(vec(x, 0), vec(1, 0));
            enforceFoldOrder(ORDER, map);
        }
        for (const id of ['middle', 'top']) {
            for (const corner of interiorSamples()) {
                if (signedDistance(map.get('bottom').line, corner) > 0)
                    assert(signedDistance(map.get(id).line, corner) >= -1e-9,
                        `${id} must cover everything folded away below it`);
            }
        }
    });
    it('covers a strip the lower fold removed from the middle of the window', () => {
        const map = states([
            ['bottom', FOLDED, makeLine(vec(50, 0), vec(1, 0))],
            ['top', FOLDED, makeLine(vec(150, 0), vec(1, 0))],
        ]);
        enforceFoldOrder(['bottom', 'top'], map);
        /* The strip 50 < x < 150 is gone from the bottom window, so it must be
         * gone from the top one too. No corner of the rect lies in that strip,
         * which is exactly why a corners-only check missed this. */
        for (const p of interiorSamples()) {
            if (signedDistance(map.get('bottom').line, p) > 0)
                assert(signedDistance(map.get('top').line, p) >= -1e-9,
                    `point x=${p.x} is folded away below but still present above`);
        }
        assertClose(map.get('top').line.point.x, 50);
    });
});
