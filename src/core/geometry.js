/*
 * Fold n' Drop for GNOME Shell — GPL-3.0-or-later
 *
 * Pure 2D geometry. No gi imports: this file must stay unit-testable
 * under plain gjs. Screen coordinates, so y grows downward.
 */
'use strict';

const EPS = 1e-9;

export function vec(x, y) {
    return { x, y };
}

export function add(a, b) {
    return { x: a.x + b.x, y: a.y + b.y };
}

export function sub(a, b) {
    return { x: a.x - b.x, y: a.y - b.y };
}

export function scale(v, k) {
    return { x: v.x * k, y: v.y * k };
}

export function dot(a, b) {
    return a.x * b.x + a.y * b.y;
}

export function cross(a, b) {
    return a.x * b.y - a.y * b.x;
}

export function len(v) {
    return Math.hypot(v.x, v.y);
}

export function normalize(v) {
    const l = len(v);
    if (l < EPS)
        return { x: 0, y: 0 };
    return { x: v.x / l, y: v.y / l };
}

/* A line is {point, normal}; the normal is a unit vector pointing at the
 * folded-away side, so signedDistance > 0 means "this pixel is gone". */
/* Rotate `from` toward `to` by `weight` of the angle between them.
 *
 * Blending the two vectors componentwise and renormalising ("nlerp") is close
 * enough for small angles, but it degenerates as they approach opposite: the
 * sum collapses toward zero and the direction it snaps to swings on rounding
 * error. A crease being pushed while the pointer reverses hits exactly that
 * case. Rotating by angle is well behaved everywhere. */
export function slerpDir(from, to, weight) {
    const a = normalize(from);
    const b = normalize(to);
    if (len(a) < EPS)
        return b;
    if (len(b) < EPS)
        return a;
    const t = Math.atan2(cross(a, b), dot(a, b)) * weight;
    const cos = Math.cos(t);
    const sin = Math.sin(t);
    return { x: a.x * cos - a.y * sin, y: a.x * sin + a.y * cos };
}

export function makeLine(point, normal) {
    return { point: { x: point.x, y: point.y }, normal: normalize(normal) };
}

export function signedDistance(line, p) {
    return dot(sub(p, line.point), line.normal);
}

export function reflect(line, p) {
    return sub(p, scale(line.normal, 2 * signedDistance(line, p)));
}

export function rectCorners(rect) {
    const { x, y, width: w, height: h } = rect;
    return [
        { x, y },
        { x: x + w, y },
        { x: x + w, y: y + h },
        { x, y: y + h },
    ];
}

export function rectEdges(rect) {
    const [tl, tr, br, bl] = rectCorners(rect);
    return [
        { id: 'top', a: tl, b: tr, normal: { x: 0, y: -1 } },
        { id: 'right', a: tr, b: br, normal: { x: 1, y: 0 } },
        { id: 'bottom', a: br, b: bl, normal: { x: 0, y: 1 } },
        { id: 'left', a: bl, b: tl, normal: { x: -1, y: 0 } },
    ];
}

/* Strictly inside — every edge excluded. Used to decide whether one window
 * hides a point on another, where a point sitting exactly on the covering
 * window's own boundary must not count as hidden: two windows with coincident
 * edges do not conceal each other there. The reference gets the same effect
 * from java.awt.Rectangle.contains, which is half-open; strict is that rule
 * made symmetric. */
export function pointStrictlyInRect(rect, p) {
    return p.x > rect.x && p.x < rect.x + rect.width &&
           p.y > rect.y && p.y < rect.y + rect.height;
}

export function rectsOverlap(a, b) {
    return a.x < b.x + b.width && b.x < a.x + a.width &&
           a.y < b.y + b.height && b.y < a.y + a.height;
}

export function segmentIntersect(p0, p1, q0, q1) {
    const r = sub(p1, p0);
    const s = sub(q1, q0);
    const d = cross(r, s);
    if (Math.abs(d) < EPS)
        return null;
    const qp = sub(q0, p0);
    const t = cross(qp, s) / d;
    const u = cross(qp, r) / d;
    if (t < 0 || t > 1 || u < 0 || u > 1)
        return null;
    return { point: add(p0, scale(r, t)), t, u };
}

/* Where an infinite line cuts a rect: walk the edges and collect the points
 * where the signed distance changes sign. */
export function lineChordInRect(rect, line) {
    const corners = rectCorners(rect);
    const points = [];
    for (let i = 0; i < corners.length; i++) {
        const cur = corners[i];
        const nxt = corners[(i + 1) % corners.length];
        const sc = signedDistance(line, cur);
        const sn = signedDistance(line, nxt);
        if (Math.abs(sc) < EPS) {
            points.push(cur);
        } else if ((sc < 0 && sn > 0) || (sc > 0 && sn < 0)) {
            const t = sc / (sc - sn);
            points.push(add(cur, scale(sub(nxt, cur), t)));
        }
    }
    if (points.length < 2)
        return null;
    let best = null;
    for (let i = 0; i < points.length; i++) {
        for (let j = i + 1; j < points.length; j++) {
            const d = len(sub(points[i], points[j]));
            if (!best || d > best.d)
                best = { d, a: points[i], b: points[j] };
        }
    }
    if (!best || best.d < EPS)
        return null;
    return { a: best.a, b: best.b };
}

/* Sutherland-Hodgman, keeping the s <= 0 half-plane (the part still on screen). */
export function clipPolygonByLine(poly, line) {
    const out = [];
    for (let i = 0; i < poly.length; i++) {
        const cur = poly[i];
        const nxt = poly[(i + 1) % poly.length];
        const sc = signedDistance(line, cur);
        const sn = signedDistance(line, nxt);
        if (sc <= 0)
            out.push(cur);
        if ((sc < 0 && sn > 0) || (sc > 0 && sn < 0)) {
            const t = sc / (sc - sn);
            out.push(add(cur, scale(sub(nxt, cur), t)));
        }
    }
    return out;
}

export function polygonArea(poly) {
    if (poly.length < 3)
        return 0;
    let sum = 0;
    for (let i = 0; i < poly.length; i++) {
        const cur = poly[i];
        const nxt = poly[(i + 1) % poly.length];
        sum += cur.x * nxt.y - nxt.x * cur.y;
    }
    return Math.abs(sum) / 2;
}

/* Does the segment [a, b] touch the rect at all? Used to ask whether a fold
 * crease drawn across one window actually reaches another. */
export function segmentIntersectsRect(a, b, rect) {
    if (pointInRectInclusive(rect, a) || pointInRectInclusive(rect, b))
        return true;
    const [tl, tr, br, bl] = rectCorners(rect);
    return !!(segmentIntersect(a, b, tl, tr) || segmentIntersect(a, b, tr, br) ||
              segmentIntersect(a, b, br, bl) || segmentIntersect(a, b, bl, tl));
}

export function pointInRectInclusive(rect, p) {
    return p.x >= rect.x && p.x <= rect.x + rect.width &&
           p.y >= rect.y && p.y <= rect.y + rect.height;
}

/* The axis-aligned bounding box of a set of points. */
export function boundsOf(points) {
    let x1 = Infinity, y1 = Infinity, x2 = -Infinity, y2 = -Infinity;
    for (const p of points) {
        if (p.x < x1) x1 = p.x;
        if (p.y < y1) y1 = p.y;
        if (p.x > x2) x2 = p.x;
        if (p.y > y2) y2 = p.y;
    }
    if (!(x1 <= x2))
        return null;
    return { x: x1, y: y1, width: x2 - x1, height: y2 - y1 };
}
