/* Fold n' Drop — GPL-3.0. Tests for the fold animation curve; no gi imports. */
import { describe, it, assert, assertEqual, assertClose } from './harness.js';
import { ease, PRESETS, makeAnimation, evaluate } from '../src/core/animation.js';

/* A transient lift: out to 48, then straight back to 0. */
function lift() {
    return makeAnimation({
        from: 0, to: 48, startedMs: 0,
        durationMs: PRESETS.liftOut.durationMs, curve: PRESETS.liftOut.curve,
        reverse: { durationMs: PRESETS.liftBack.durationMs, curve: PRESETS.liftBack.curve },
    });
}

describe('animation: curve shape', () => {
    it('runs from zero to one', () => {
        assertClose(ease(0, PRESETS.liftOut.curve), 0);
        assertClose(ease(1, PRESETS.liftOut.curve), 1);
    });
    it('clamps outside the unit interval', () => {
        assertClose(ease(-3, PRESETS.liftOut.curve), 0);
        assertClose(ease(9, PRESETS.liftOut.curve), 1);
    });
    it('eases out when the curve is below one', () => {
        assert(ease(0.5, PRESETS.liftOut.curve) > 0.5, 'most distance covered early');
    });
    it('eases in when the curve is above one', () => {
        assert(ease(0.5, PRESETS.liftBack.curve) < 0.5, 'most distance covered late');
    });
    it('degrades to linear when the curve is one', () => {
        assertClose(ease(0.25, 1), 0.25);
    });
    it('degrades to linear rather than producing NaN for a zero curve', () => {
        assertClose(ease(0.25, 0), 0.25);
    });
});

/* The reference demo advances its parameter once per 50 ms frame. These are
 * its values at whole frames, which the closed form must track. */
describe('animation: tracks the reference demo', () => {
    it('matches the outbound lift at each of its three frames', () => {
        assertClose(ease(1 / 3, PRESETS.liftOut.curve), 0.818, 0.02);
        assertClose(ease(2 / 3, PRESETS.liftOut.curve), 0.982, 0.02);
    });
    it('matches the unfold at its six frames', () => {
        assertClose(ease(1 / 6, PRESETS.unfold.curve), 0.515, 0.02);
        assertClose(ease(3 / 6, PRESETS.unfold.curve), 0.901, 0.02);
    });
    it('matches the return leg, which barely moves at first', () => {
        assertClose(ease(1 / 6.49, PRESETS.liftBack.curve), 0.018, 0.02);
    });
    it('carries the reference durations', () => {
        assertEqual(PRESETS.liftOut.durationMs, 150);
        assertEqual(PRESETS.liftBack.durationMs, 350);
        assertEqual(PRESETS.unfold.durationMs, 300);
    });
});

describe('animation: evaluation', () => {
    it('starts at the from value', () => {
        assertClose(evaluate(lift(), 0).value, 0);
    });
    it('depends only on elapsed time, not on how often it was sampled', () => {
        const anim = lift();
        for (let t = 0; t < 120; t += 16)
            evaluate(anim, t);
        assertClose(evaluate(anim, 120).value, evaluate(lift(), 120).value);
    });
    it('is not finished when the outbound leg completes', () => {
        assertEqual(evaluate(lift(), 150).done, false);
    });
    it('holds the target value at the turn', () => {
        assertClose(evaluate(lift(), 150).value, 48);
    });
    it('returns to the start value and reports done', () => {
        const result = evaluate(lift(), 500);
        assertClose(result.value, 0);
        assertEqual(result.done, true);
    });
    it('stays done and clamped long past the end', () => {
        const result = evaluate(lift(), 99999);
        assertClose(result.value, 0);
        assertEqual(result.done, true);
    });
    it('finishes a one-legged animation at its duration', () => {
        const anim = makeAnimation({
            from: 90, to: 0, startedMs: 1000,
            durationMs: PRESETS.unfold.durationMs, curve: PRESETS.unfold.curve,
        });
        assertEqual(evaluate(anim, 1299).done, false);
        const end = evaluate(anim, 1300);
        assertClose(end.value, 0);
        assertEqual(end.done, true);
    });
    it('does not divide by zero for a zero duration', () => {
        const anim = makeAnimation({
            from: 0, to: 10, startedMs: 0, durationMs: 0, curve: 0.5,
        });
        const result = evaluate(anim, 0);
        assertClose(result.value, 10);
        assertEqual(result.done, true);
    });
});
