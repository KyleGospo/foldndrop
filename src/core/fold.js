/*
 * Fold n' Drop for GNOME Shell — GPL-3.0-or-later
 *
 * A fold is a straight line across a window with a unit normal pointing at
 * the folded-away side. Everything the technique needs — pushing, rotating,
 * discarding, sizing the flap — falls out of that one representation.
 */
'use strict';

import {
    add, sub, scale, dot, len, normalize, slerpDir, makeLine, signedDistance,
    rectCorners, clipPolygonByLine, polygonArea, lineChordInRect,
    segmentIntersectsRect, boundsOf,
} from './geometry.js';

export const NORMAL = 'normal';
export const TRANSIENT = 'transient';
export const FOLDED = 'folded';
export const DISCARDED = 'discarded';

/* A fold has a second, equivalent description: the corner it cuts off, plus
 * how far the crease sits from that corner. The reference implementation
 * animates exactly that scalar while holding the crease angle fixed, and
 * distance zero — the crease through the corner — is how a fold retires.
 *
 * The corner cut off is the one furthest into the folded-away direction. */
export function cornerFor(rect, normal) {
    const unit = normalize(normal);
    let best = null;
    let bestDistance = -Infinity;
    for (const corner of rectCorners(rect)) {
        const d = dot(corner, unit);
        if (d > bestDistance) {
            bestDistance = d;
            best = corner;
        }
    }
    return best;
}

export function cornerDistance(rect, line) {
    return signedDistance(line, cornerFor(rect, line.normal));
}

export function lineAtCornerDistance(rect, normal, distance) {
    const unit = normalize(normal);
    return makeLine(sub(cornerFor(rect, unit), scale(unit, distance)), unit);
}

/* How far the cut corner is from the corner furthest behind the crease — the
 * whole depth available to a fold in this direction. */
export function maxCornerDistance(rect, normal) {
    const unit = normalize(normal);
    const corner = cornerFor(rect, unit);
    let deepest = 0;
    for (const other of rectCorners(rect)) {
        const d = dot(sub(corner, other), unit);
        if (d > deepest)
            deepest = d;
    }
    return deepest;
}

/* The reference pins a fresh crease between 20 and 60 px from the corner it
 * cuts, whatever the window's size. That upper bound is what keeps a mid-edge
 * exit — where the crease comes out parallel to the edge — from lifting a
 * strip across the entire window instead of a corner. */
export const MIN_LIFT_CORNER_PX = 20;
export const MAX_LIFT_CORNER_PX = 60;

/* Never let a lift swallow the window either: half the available depth still
 * reads as a lifted corner and always leaves something on screen. On a window
 * too small for even the lower bound, that cap wins. */
export function liftDistance(rect, normal, depthPx) {
    const wanted = Math.min(Math.max(depthPx, MIN_LIFT_CORNER_PX), MAX_LIFT_CORNER_PX);
    return Math.min(wanted, 0.5 * maxCornerDistance(rect, normal));
}

/* How far the crease tilts off the edge at a corner, as a tangent. The
 * reference's 0.75 puts a corner exit at atan(0.75) = 36.87 degrees. */
const EXIT_TILT = 0.75;
/* How much of the crease angle comes from the direction of travel rather than
 * from where on the edge the pointer left. The reference blends 0.7 / 0.3. */
const MOTION_WEIGHT = 0.3;

/* The crease seeded by leaving a window.
 *
 * Two things decide it, exactly as in the reference. Where along the edge the
 * pointer left sets a base angle: leaving at a corner tilts the crease
 * EXIT_TILT off the edge so it cuts that corner off, and the tilt falls
 * linearly to zero at mid-edge, where the crease ends up parallel to the edge.
 * The direction of travel then pulls the crease toward perpendicular-to-travel
 * — a diagonal exit reads as aiming at the corner, and gets one.
 *
 * The motion term is aligned to agree with the base angle before blending.
 * The reference unwraps it to within a half turn instead, which lets a 0.3
 * weight swing the crease far enough to cut a different corner than the one
 * the pointer actually left by. Agreeing first bounds the pull to a quarter
 * turn of influence and keeps the corner the user aimed at. */
export function cornerLiftNormal(edge, exitPoint, motion = null) {
    const span = sub(edge.b, edge.a);
    const edgeLength = len(span);
    const outward = normalize(edge.normal);
    if (edgeLength < 1e-9)
        return outward;

    const along = scale(span, 1 / edgeLength);
    const t = Math.min(1, Math.max(0, dot(sub(exitPoint, edge.a), along) / edgeLength));

    /* The crease direction. At t = 0 it leans a full EXIT_TILT toward the
     * outward normal, at t = 1 the same amount the other way, and at mid-edge
     * it lies along the edge. */
    let u = normalize(add(along, scale(outward, EXIT_TILT * (1 - 2 * t))));

    if (motion && len(motion) > 1e-6) {
        /* A crease perpendicular to travel, taken in whichever of its two
         * opposite senses already agrees with u. */
        let aimed = normalize({ x: -motion.y, y: motion.x });
        if (dot(aimed, u) < 0)
            aimed = scale(aimed, -1);
        u = slerpDir(u, aimed, MOTION_WEIGHT);
    }

    /* The folded-away side is the crease direction turned a quarter turn, the
     * sense that puts the cut corner behind the crease. */
    return { x: u.y, y: -u.x };
}

/* Place a crease just behind a point, leaving that point on the folded side
 * by deltaPx. Used both when a fold is confirmed and every time it is pushed,
 * so the crease tracks the pointer continuously. */
export function anchorFoldLine(normal, point, deltaPx) {
    const unit = normalize(normal);
    return makeLine(sub(point, scale(unit, deltaPx)), unit);
}

/* Pushing enlarges a fold. The pointer comes at the crease from the revealed
 * side and drives it further into the window, so the motion runs against the
 * normal; the paper says the fold "remains on the same side" of the pointer.
 * The line also turns toward perpendicular-to-motion, which is the same as
 * the normal turning to face the pointer's approach. */
/* How far the pointer must travel in one step to earn the full turn. */
export const ROTATION_SPEED_PX = 90;

export function pushFoldLine(line, p0, p1, deltaPx, rotationLerp) {
    let normal = line.normal;
    const motion = sub(p1, p0);
    const travelled = len(motion);
    if (travelled > 1e-6 && rotationLerp > 0) {
        const target = normalize(sub(p0, p1));
        /* Turn by a share of the angle proportional to how far the pointer
         * actually moved, capped at rotationLerp — the reference's
         * min(0.1, distance / 90). A fixed step per crossing instead ties the
         * turn rate to how often the pointer happens to be sampled, so the
         * same gesture turns the crease further on a mouse that reports more
         * often. Scaling by distance makes it depend on the gesture alone. */
        const weight = Math.min(rotationLerp, travelled / ROTATION_SPEED_PX);
        normal = slerpDir(normal, target, weight);
    }
    return anchorFoldLine(normal, p1, deltaPx);
}

export function visibleFraction(rect, line) {
    const total = rect.width * rect.height;
    if (total <= 0)
        return 0;
    return polygonArea(clipPolygonByLine(rectCorners(rect), line)) / total;
}

/* Does a crease drawn across `rect` reach `other`?
 *
 * A fold only carries the windows its crease actually runs through. This is
 * the reference's gate, in two parts: the crease has to cut `other` at all
 * (getIntersections returning null is what makes forceFolding refuse), and
 * the piece of the crease that exists — the chord inside the window being
 * folded, not the infinite line — has to run through `other`'s bounds.
 *
 * Without it a crease anywhere on screen folds every window it happens to
 * overlap, including ones lying wholly on its folded-away side, which vanish
 * outright. */
export function foldReaches(rect, line, other) {
    const chord = lineChordInRect(rect, line);
    if (!chord)
        return false;
    if (!segmentIntersectsRect(chord.a, chord.b, other))
        return false;
    return lineChordInRect(other, line) !== null;
}

/* Every pixel a fold puts on screen, as a box in the same coordinates as
 * `rect`: the part still lying flat, the flap, and the shadow the flap casts.
 *
 * The flap sends a content point q at depth s behind the crease to
 * q - (1 + scale) * s * n, and the shadow — an unforeshortened mirror — sends
 * it to q - 2 * s * n. Both are affine, so the extremes sit on the vertices of
 * the folded-away polygon and this box is exact.
 *
 * The obvious shortcut, measuring the overhang along the crease normal, is
 * wrong: the displacement is along the normal but the region is a rectangle,
 * so a corner barely behind the crease can still be thrown far past the
 * window's own edge. That is what clipped the flap at the bottom of the
 * window. */
export function foldPaintBounds(rect, line, flapScale = 1, shadowSpreadPx = 0) {
    const corners = rectCorners(rect);
    const points = clipPolygonByLine(corners, line);   /* the part still flat */
    const flipped = makeLine(line.point, scale(line.normal, -1));
    for (const q of clipPolygonByLine(corners, flipped)) {
        const s = Math.max(0, signedDistance(line, q));
        points.push(sub(q, scale(line.normal, (1 + flapScale) * s)));
        points.push(sub(q, scale(line.normal, 2 * s)));
    }
    const box = boundsOf(points) ?? { ...rect };
    return {
        x: box.x - shadowSpreadPx,
        y: box.y - shadowSpreadPx,
        width: box.width + 2 * shadowSpreadPx,
        height: box.height + 2 * shadowSpreadPx,
    };
}
