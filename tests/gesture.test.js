// tests/gesture.test.js
/* Fold n' Drop — GPL-3.0. Tests for the timed double-crossing state machine; no gi imports. */
import { describe, it, assertEqual } from './harness.js';
import { vec } from '../src/core/geometry.js';
import { NORMAL, TRANSIENT, FOLDED, DISCARDED } from '../src/core/fold.js';
import { computeIntents } from '../src/core/gesture.js';

function windows(entries) {
    return new Map(entries.map(([id, state]) => [id, { state }]));
}

function edgeCrossing(windowId, edgeId, direction, t = 0.5) {
    return {
        boundary: { windowId, kind: 'edge', edgeId },
        point: vec(0, 0),
        t,
        direction,
    };
}

function foldCrossing(windowId, direction, t = 0.5) {
    return {
        boundary: { windowId, kind: 'fold', edgeId: null },
        point: vec(0, 0),
        t,
        direction,
    };
}

const types = intents => intents.map(i => `${i.type}:${i.windowId}`);

describe('gesture: transient folds', () => {
    it('starts a transient fold when the pointer leaves a normal window', () => {
        const intents = computeIntents({
            windows: windows([['a', NORMAL]]),
            crossings: [edgeCrossing('a', 'right', 'outward')],
        });
        assertEqual(types(intents), ['transient:a']);
        assertEqual(intents[0].edgeId, 'right');
    });
    it('does nothing when the pointer merely enters a normal window', () => {
        const intents = computeIntents({
            windows: windows([['a', NORMAL]]),
            crossings: [edgeCrossing('a', 'left', 'inward')],
        });
        assertEqual(types(intents), []);
    });
    /* A transient intent requires state NORMAL. Leaving again while already
     * TRANSIENT — e.g. a lift still rolling back out — must not start a
     * second one. */
    it('does nothing on an outward crossing while already transient', () => {
        const intents = computeIntents({
            windows: windows([['a', TRANSIENT]]),
            crossings: [edgeCrossing('a', 'right', 'outward')],
        });
        assertEqual(types(intents), []);
    });
});

describe('gesture: timed double-crossing', () => {
    it('confirms an inward crossing while transient', () => {
        const intents = computeIntents({
            windows: windows([['a', TRANSIENT]]),
            crossings: [edgeCrossing('a', 'right', 'inward')],
        });
        assertEqual(types(intents), ['confirm:a']);
    });
    it('does nothing when there are no crossings', () => {
        const intents = computeIntents({
            windows: windows([['a', TRANSIENT]]),
            crossings: [],
        });
        assertEqual(types(intents), []);
    });
    it('confirms an out-and-back sweep contained in a single motion', () => {
        const intents = computeIntents({
            windows: windows([['a', NORMAL]]),
            crossings: [
                edgeCrossing('a', 'right', 'outward', 0.2),
                edgeCrossing('a', 'right', 'inward', 0.8),
            ],
        });
        assertEqual(types(intents), ['transient:a', 'confirm:a']);
    });
});

describe('gesture: folded windows', () => {
    /* Pushing drives the crease deeper into the window, so the pointer
     * approaches it from the revealed side: an inward crossing. */
    it('pushes when the crease is crossed inward, from the revealed side', () => {
        const intents = computeIntents({
            windows: windows([['a', FOLDED]]),
            crossings: [foldCrossing('a', 'inward')],
        });
        assertEqual(types(intents), ['push:a']);
    });
    /* Figure 4: going around the fold and pushing it from inside the window
     * back out again cancels it. */
    it('unfolds when the crease is crossed outward, from inside the window', () => {
        const intents = computeIntents({
            windows: windows([['a', FOLDED]]),
            crossings: [foldCrossing('a', 'outward')],
        });
        assertEqual(types(intents), ['unfold:a']);
    });
    it('ignores crossings on a discarded window', () => {
        const intents = computeIntents({
            windows: windows([['a', DISCARDED]]),
            crossings: [foldCrossing('a', 'inward')],
        });
        assertEqual(types(intents), []);
    });
    it('ignores crossings for a window it does not know about', () => {
        const intents = computeIntents({
            windows: windows([]),
            crossings: [edgeCrossing('ghost', 'right', 'outward')],
        });
        assertEqual(types(intents), []);
    });
});

describe('gesture: multiple windows in one motion', () => {
    it('emits intents for each window in the order they were crossed', () => {
        const intents = computeIntents({
            windows: windows([['a', NORMAL], ['b', FOLDED]]),
            crossings: [
                edgeCrossing('a', 'right', 'outward', 0.1),
                foldCrossing('b', 'inward', 0.9),
            ],
        });
        assertEqual(types(intents), ['transient:a', 'push:b']);
    });
});
