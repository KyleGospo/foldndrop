/*
 * Fold n' Drop for GNOME Shell — GPL-3.0-or-later
 *
 * One easing curve, expressed against elapsed time rather than frame count.
 *
 * The reference implementation advances a normalised parameter once per 50 ms
 * frame, each frame adding a share of the distance remaining. That is a
 * geometric approach to 1, and it is frame-rate dependent: our pointer source
 * ticks at 16 ms, which would run every animation three times too fast. Here
 * the same shape is written closed-form, so any tick rate agrees.
 *
 * `curve` is the factor the remaining distance is multiplied by across the
 * whole animation — the reference's per-frame ratio raised to its frame count.
 * Below 1 it eases out, above 1 it eases in.
 */
'use strict';

export function ease(p, curve) {
    const t = p <= 0 ? 0 : p >= 1 ? 1 : p;
    if (!(curve > 0) || curve === 1)
        return t;
    return (1 - Math.pow(curve, t)) / (1 - curve);
}

/* Reference presets. liftOut is 0.2 per frame over 3 frames, liftBack is 1.8
 * per frame over 6.49, unfold is 0.5 per frame over 6. */
export const PRESETS = {
    liftOut: { curve: 0.008, durationMs: 150 },
    liftBack: { curve: 45.4, durationMs: 350 },
    unfold: { curve: 0.015625, durationMs: 300 },
};

export function makeAnimation({ from, to, startedMs, durationMs, curve, reverse = null }) {
    return { from, to, startedMs, durationMs, curve, reverse };
}

/* Pure: the result depends only on the record and the timestamp, never on how
 * often it has been sampled. That is what lets the renderer and the crossing
 * logic read the same crease. */
export function evaluate(anim, timeMs) {
    const elapsed = timeMs - anim.startedMs;

    if (!anim.reverse || elapsed < anim.durationMs) {
        const p = anim.durationMs > 0 ? elapsed / anim.durationMs : 1;
        return {
            value: anim.from + (anim.to - anim.from) * ease(p, anim.curve),
            done: !anim.reverse && p >= 1,
        };
    }

    const back = anim.reverse;
    const p = back.durationMs > 0 ? (elapsed - anim.durationMs) / back.durationMs : 1;
    return {
        value: anim.to + (anim.from - anim.to) * ease(p, back.curve),
        done: p >= 1,
    };
}
