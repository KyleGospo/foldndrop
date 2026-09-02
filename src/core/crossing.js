/*
 * Fold n' Drop for GNOME Shell — GPL-3.0-or-later
 *
 * Boundary crossing detection. A boundary is a finite segment plus an
 * outward normal; window edges and fold lines are both just boundaries,
 * which is what lets a fold be pushed with the same code that folds a
 * window in the first place.
 *
 * Crossings are found against the whole motion segment [p0, p1] rather
 * than from enter/leave events, so a single fast motion that sweeps past
 * several windows reports all of them, in order. See Figure 6 of the paper.
 */
'use strict';

import { sub, dot, segmentIntersect, rectEdges, lineChordInRect } from './geometry.js';

export function makeEdgeBoundaries(win) {
    return rectEdges(win.rect).map(edge => ({
        windowId: win.id,
        kind: 'edge',
        edgeId: edge.id,
        a: edge.a,
        b: edge.b,
        normal: edge.normal,
    }));
}

export function makeFoldBoundary(win) {
    if (!win.line)
        return null;
    const chord = lineChordInRect(win.rect, win.line);
    if (!chord)
        return null;
    return {
        windowId: win.id,
        kind: 'fold',
        edgeId: null,
        a: chord.a,
        b: chord.b,
        normal: win.line.normal,
    };
}

export function findCrossings(p0, p1, boundaries) {
    const motion = sub(p1, p0);
    const hits = [];
    for (const boundary of boundaries) {
        const hit = segmentIntersect(p0, p1, boundary.a, boundary.b);
        if (!hit)
            continue;
        const facing = dot(motion, boundary.normal);
        if (facing === 0)
            continue;
        hits.push({
            boundary,
            point: hit.point,
            t: hit.t,
            direction: facing > 0 ? 'outward' : 'inward',
        });
    }
    hits.sort((l, r) => l.t - r.t);
    return hits;
}
