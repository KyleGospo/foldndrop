/*
 * Fold n' Drop for GNOME Shell — GPL-3.0-or-later
 *
 * The paper's multi-fold rules. Folding a window folds everything over it;
 * unfolding a window unfolds everything folded beneath it; and no fold ever
 * intersects a window above it, which is what stops an upper window from
 * hiding a lower window's crease.
 *
 * The cascades live in session.js, which owns the state; this file supplies
 * the stacking queries and enforces the invariant.
 */
'use strict';

import { add, scale, makeLine, signedDistance, rectCorners, rectsOverlap, pointStrictlyInRect, clipPolygonByLine } from './geometry.js';
import { FOLDED, DISCARDED } from './fold.js';

/* The order the flaps are drawn in, bottom of the pile first.
 *
 * Folding a stack of paper turns the folded part of it over. The sheet that
 * was on top of the stack has the corner that ends up at the bottom of the
 * pile of flaps, and the lowest sheet's corner ends up on top of it — so the
 * flaps lie in exactly the opposite order to the windows they came off, and
 * the whole pile rests on top of everything still lying flat.
 *
 * Drawing each flap with its own window instead, which is where it started,
 * put the flap of an upper window over the flap of a lower one: two sheets
 * that had just been folded together, with the wrong one on top.
 *
 * Takes what describe() hands the renderer — {id, state, line} in
 * bottom-to-top stacking order — so the rule can be read off the same
 * description the drawing is. */
export function flapPaintOrder(description) {
    const flaps = [];
    for (const win of description) {
        /* No crease, no flap. FOLDED promises one and the core keeps that
         * promise; a window without one has nothing to place, and placing it
         * anyway would order the pile around an actor drawing nothing. */
        if (!win.line)
            continue;
        /* A discarded window is still fading out along the crease that
         * swallowed it, so it keeps its place in the pile while it goes. */
        if (win.state !== FOLDED && win.state !== DISCARDED)
            continue;
        flaps.push(win.id);
    }
    return flaps.reverse();
}

export function windowsAbove(order, id) {
    const i = order.indexOf(id);
    if (i < 0)
        return [];
    return order.slice(i + 1);
}

export function windowsBelow(order, id) {
    const i = order.indexOf(id);
    if (i < 0)
        return [];
    return order.slice(0, i);
}

/* Is `point` hidden from window `id` by something stacked over it?
 *
 * This is the reference's isPointVisible(), and it is what keeps a drag from
 * folding the whole stack at once. Window edges are geometric lines, not
 * pixels: a stroke through the middle of the top window also crosses the
 * coincident edges of every window buried underneath, and each of those
 * crossings reads as a deliberate exit unless something rules it out. An edge
 * the user cannot see is an edge the user cannot have aimed at.
 *
 * A folded window covers only the part of itself still lying flat. Its flap
 * lies on that same kept side, so mirroring it needs no separate test. */
export function pointOccluded(order, states, id, point) {
    const self = states.get(id);
    if (!self)
        return false;
    for (const other of windowsAbove(order, id)) {
        const upper = states.get(other);
        if (!upper || upper.state === DISCARDED)
            continue;
        /* Windows folded along one crease are one sheet. A window carried by
         * this window's fold sits on exactly the same crease, so asking
         * whether it covers the crease is asking whether a line covers itself:
         * the answer came out "yes", the pointer's push was thrown away as
         * unseen, and the fold the user was actually pushing stopped moving
         * while the one above it ran away. */
        if (foldGroup(self, id) === foldGroup(upper, other))
            continue;
        if (!pointStrictlyInRect(upper.rect, point))
            continue;
        if (upper.state === FOLDED && upper.line &&
            signedDistance(upper.line, point) >= 0)
            continue;
        return true;
    }
    return false;
}

/* Which fold a window belongs to: the one carrying it, or its own. Takes the
 * id rather than reading win.id, so it is right for any record the caller
 * already has a key for. */
export function foldGroup(win, id) {
    return win.leader ?? id;
}

export function enforceFoldOrder(order, states) {
    for (let upper = 0; upper < order.length; upper++) {
        const u = states.get(order[upper]);
        /* A window mid-animation owns its own crease; correcting it here would
         * fight the animation frame by frame. Once the animation ends the
         * window either is no longer FOLDED (an unfold lands at NORMAL with
         * no crease, so there is nothing left to correct) or is FOLDED again
         * with `anim` cleared, at which point this same check picks it up on
         * the next call — no separate "landing" step needed. */
        if (!u || u.state !== FOLDED || !u.line || u.anim)
            continue;
        for (let lower = 0; lower < upper; lower++) {
            const l = states.get(order[lower]);
            if (!l || l.state !== FOLDED || !l.line)
                continue;
            /* One crease folded through both of them already. There is nothing
             * to correct, and correcting it anyway would re-derive a line that
             * is meant to be shared, leaving the two a rounding error apart. */
            if (foldGroup(u, order[upper]) === foldGroup(l, order[lower]))
                continue;
            /* Windows that do not overlap cannot hide each other's crease. */
            if (!rectsOverlap(u.rect, l.rect))
                continue;

            /* The worst-case point is not necessarily a corner of u.rect. When
             * l's crease cuts through u.rect's interior, the deepest violation
             * sits where that crease crosses u.rect's edges. So clip u.rect
             * down to l's folded-away side and minimise over THAT polygon's
             * vertices. clipPolygonByLine keeps the s <= 0 side, so flip the
             * normal to keep the folded-away side instead. */
            const flipped = makeLine(l.line.point, scale(l.line.normal, -1));
            const region = clipPolygonByLine(rectCorners(u.rect), flipped);
            if (region.length < 3)
                continue;

            let shortfall = Infinity;
            for (const vertex of region)
                shortfall = Math.min(shortfall, signedDistance(u.line, vertex));
            if (shortfall >= 0)
                continue;

            /* Sliding the line's point along +normal by |shortfall| raises
             * every signed distance by that amount. */
            u.line = makeLine(add(u.line.point, scale(u.line.normal, shortfall)), u.line.normal);
        }
    }
    return states;
}
