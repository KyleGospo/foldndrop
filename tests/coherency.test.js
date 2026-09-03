/* Fold n' Drop — GPL-3.0. Tests for multi-fold stacking coherency; no gi imports. */
import { describe, it, assert, assertEqual, assertClose } from './harness.js';
import { vec, makeLine, signedDistance } from '../src/core/geometry.js';
import { NORMAL, TRANSIENT, FOLDED, DISCARDED } from '../src/core/fold.js';
import { windowsAbove, windowsBelow, enforceFoldOrder, flapPaintOrder } from '../src/core/coherency.js';

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

describe('coherency: the order the flaps are drawn in', () => {
    const LINE = makeLine(vec(150, 0), vec(1, 0));

    function described(entries) {
        return entries.map(([id, state, line]) => ({ id, state, line: line ?? null }));
    }

    /* Folding a stack of paper turns the folded part over, so the sheet that
     * was on top of the stack ends up at the bottom of the pile of flaps. */
    it('draws a lower window\'s flap over the flap of the window above it', () => {
        const order = flapPaintOrder(described([
            ['bottom', FOLDED, LINE],
            ['top', FOLDED, LINE],
        ]));
        assertEqual(order, ['top', 'bottom']);
    });

    it('leaves out windows that have no flap', () => {
        const order = flapPaintOrder(described([
            ['flat', NORMAL],
            ['lifted', TRANSIENT],
            ['folded', FOLDED, LINE],
        ]));
        assertEqual(order, ['folded']);
    });

    /* FOLDED promises a crease and the core keeps that promise, but a window
     * without one has no flap to place, and placing it anyway would leave the
     * pile ordered around an actor that is drawing nothing. */
    it('leaves out a folded window with no crease', () => {
        assertEqual(flapPaintOrder(described([['folded', FOLDED, null]])), []);
    });

    /* A discarded window is still fading out along the crease that swallowed
     * it, so it keeps its place in the pile while it goes. */
    it('keeps a discarded window in the pile while it fades', () => {
        const order = flapPaintOrder(described([
            ['bottom', DISCARDED, LINE],
            ['top', FOLDED, LINE],
        ]));
        assertEqual(order, ['top', 'bottom']);
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
