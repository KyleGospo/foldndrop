/*
 * Fold n' Drop for GNOME Shell — GPL-3.0-or-later
 *
 * One drag's worth of fold state. Sees windows only as {id, rect} in
 * bottom-to-top stacking order and returns a description of what should be
 * drawn; it never learns that windows are actors.
 */
'use strict';

import { sub, scale, makeLine, rectEdges, signedDistance } from './geometry.js';
import {
    NORMAL, TRANSIENT, FOLDED, DISCARDED,
    anchorFoldLine, pushFoldLine, visibleFraction,
    cornerLiftNormal, lineAtCornerDistance, liftDistance, cornerDistance,
    foldReaches, foldFade,
} from './fold.js';
import { evaluate, makeAnimation, PRESETS } from './animation.js';
import { makeEdgeBoundaries, makeFoldBoundary, findCrossings } from './crossing.js';
import { computeIntents } from './gesture.js';
import { windowsAbove, windowsBelow, enforceFoldOrder, pointOccluded, foldGroup } from './coherency.js';

export const DEFAULT_CONFIG = {
    transientTimeoutMs: 500,
    transientDepthPx: 48,
    unfoldMs: 300,
    restoreMs: 320,
    pushDeltaPx: 1,
    rotationLerp: 0.1,
    discardThreshold: 0.20,
    discardEnabled: true,
    /* How far apart the creases of two windows folded together are drawn.
     * A sheet's thickness; see _drawnLines. */
    sheetOffsetPx: 1.5,
};

export class Session {
    constructor(config = {}) {
        this.config = { ...DEFAULT_CONFIG, ...config };
        this.order = [];
        this.states = new Map();
        this.lastPoint = null;
        this.lastTimeMs = 0;
        /* Set once the drag is over: the pointer stops arming gestures but
         * still drives the clock. */
        this.frozen = false;
        /* Set once every fold has been sent back to its corner. */
        this.restoring = false;
    }

    begin(windows, point, timeMs) {
        this.order = windows.map(w => w.id);
        this.states = new Map(windows.map(w => [w.id, {
            id: w.id,
            rect: w.rect,
            state: NORMAL,
            line: null,
            anim: null,
            animKind: null,
            animNormal: null,
            /* The window whose crease this one is folded by, or null when it
             * was folded by a gesture of its own. See _syncCascade. */
            leader: null,
        }]));
        this.lastPoint = point;
        this.lastTimeMs = timeMs;
        this.frozen = false;
        this.restoring = false;
        return this.describe();
    }

    boundaries() {
        const out = [];
        for (const id of this.order) {
            const win = this.states.get(id);
            if (!win || win.state === DISCARDED)
                continue;
            /* A window carried by someone else's fold is not a thing the
             * pointer can push. Giving it a boundary of its own puts a second
             * crease in exactly the same place as the leader's, and then the
             * occlusion test — which sees the follower stacked above — throws
             * away the leader's crossing and keeps the follower's. The window
             * you are actually folding stops moving and the one above it runs
             * away instead. */
            if (win.leader !== null)
                continue;
            if (win.state === FOLDED) {
                const bound = makeFoldBoundary(win);
                if (bound)
                    out.push(bound);
            } else {
                out.push(...makeEdgeBoundaries(win));
            }
        }
        return out;
    }

    tick(timeMs) {
        if (!this.lastPoint)
            return this.describe();
        return this.updatePointer(this.lastPoint, timeMs);
    }

    /* Evaluate every live animation at this tick's timestamp and rebuild the
     * crease from the result. Both describe() and boundaries() read what this
     * writes, so what the user sees is what they push against. */
    _advanceAnimations(timeMs) {
        for (const win of this.states.values()) {
            if (!win.anim)
                continue;
            const { value, done } = evaluate(win.anim, timeMs);
            if (!done) {
                /* Still running: the animation owns the crease while it is
                 * live. A non-positive distance is not a crease, though — it
                 * is a fold that has closed. A TRANSIENT window may legally
                 * sit there (a lift begins and ends at distance zero), but a
                 * FOLDED one may not: FOLDED promises the renderer a crease
                 * to draw, so retire the fold rather than blanking its line
                 * and leaving the two disagreeing. */
                if (value > 0)
                    win.line = lineAtCornerDistance(win.rect, win.animNormal, value);
                else if (win.state === FOLDED)
                    this._retireFold(win, timeMs);
                else
                    win.line = null;
                continue;
            }
            const kind = win.animKind;
            this._clearAnimation(win);
            /* Something else may have taken the window over while the
             * animation was running — a lift that got confirmed and cascaded
             * over by a window below, say. Only land the animation's own
             * outcome — state AND line alike — when the state it was driving
             * is still current. Writing win.line before this check, even
             * with the completion value, would let a stale animation hand a
             * FOLDED window a lift's null (or otherwise foreign) line —
             * unreachable today only because the guard below always fires
             * first in every path that can reach here. */
            const expected = kind === 'lift' ? TRANSIENT : FOLDED;
            if (win.state !== expected)
                continue;
            win.state = NORMAL;
            win.line = null;
            if (kind === 'unfold')
                this._cascadeUnfold(win.id, timeMs);
        }
    }

    _clearAnimation(win) {
        win.anim = null;
        win.animKind = null;
        win.animNormal = null;
    }

    /* A fold that has nothing left to show. Drops straight back to NORMAL and
     * cascades to the folds beneath, exactly as a completed unfold does — the
     * only difference is that there was no distance left worth animating. */
    _retireFold(win, timeMs) {
        this._clearAnimation(win);
        win.state = NORMAL;
        win.line = null;
        win.leader = null;
        this._cascadeUnfold(win.id, timeMs);
    }

    /* Unfolding retracts the crease to the corner it cut, where a fold ceases
     * to exist. The window stays FOLDED — real actor hidden, clone drawn —
     * until it lands, which is what stops the flap vanishing in one frame. */
    _startUnfold(win, timeMs, durationMs = this.config.unfoldMs) {
        if (!win.line)
            return;
        /* A crease level with, or past, the corner it cuts has nothing left to
         * retract. anchorFoldLine puts the crease pushDeltaPx beyond the
         * pointer and enforceFoldOrder can slide it further, so this is
         * reachable from an ordinary deep push. Animating it would run a
         * non-positive corner distance, and _advanceAnimations turns every
         * non-positive value into a null crease — on a window that is still
         * FOLDED, which the renderer dereferences. Retire the fold outright
         * instead; there is nothing to show. */
        const from = cornerDistance(win.rect, win.line);
        if (!(from > 0)) {
            this._retireFold(win, timeMs);
            return;
        }
        win.animNormal = win.line.normal;
        win.animKind = 'unfold';
        win.anim = makeAnimation({
            from,
            to: 0,
            startedMs: timeMs,
            durationMs,
            curve: PRESETS.unfold.curve,
        });
    }

    /* The paper cascades an unfold down to every folded window beneath. This
     * starts an unfold on ALL of them at once, not one at a time: the
     * reference sequences the cascade after the landing animation completes
     * rather than alongside it, but it does not serialise the windows below
     * against each other. With more than two windows folded, the lower ones
     * unfold together once the top one lands. */
    _cascadeUnfold(id, timeMs) {
        for (const other of windowsBelow(this.order, id)) {
            const lower = this.states.get(other);
            if (!lower || lower.state !== FOLDED || lower.anim)
                continue;
            this._startUnfold(lower, timeMs);
        }
    }

    updatePointer(point, timeMs) {
        const from = this.lastPoint ?? point;
        this._advanceAnimations(timeMs);
        /* Once the drag is over the pointer is just a clock: the drop has
         * already happened, so nothing the user does with the mouse from here
         * on should fold anything. Animations still have to advance, which is
         * why this ticks rather than stopping. */
        if (this.frozen) {
            this.lastPoint = point;
            this.lastTimeMs = timeMs;
            return this.describe();
        }
        /* Drop crossings the user could not have seen. Without this one
         * stroke folds the entire stack: every window under the pointer has
         * an edge running through that same spot. */
        const crossings = findCrossings(from, point, this.boundaries())
            .filter(c => !pointOccluded(this.order, this.states, c.boundary.windowId, c.point));
        const intents = computeIntents({ windows: this.states, crossings });

        for (const intent of intents)
            this._apply(intent, from, point, timeMs);

        this._syncCascade();
        enforceFoldOrder(this.order, this.states);
        this._applyDiscards();

        this.lastPoint = point;
        this.lastTimeMs = timeMs;
        return this.describe();
    }

    removeWindow(id) {
        this.states.delete(id);
        this.order = this.order.filter(other => other !== id);
    }

    describe() {
        const drawn = this._drawnLines();
        return this.order.map(id => {
            const win = this.states.get(id);
            return {
                id: win.id,
                rect: win.rect,
                state: win.state,
                /* Where the crease is drawn, which is a sheet's thickness away
                 * from where the fold actually is for every window but the top
                 * one — see _drawnLines. Everything that asks where the fold IS
                 * rather than where it looks — the boundaries the pointer
                 * pushes against, the occlusion test, the fade, whether the
                 * window still takes the pointer — reads win.line instead. */
                line: drawn.get(id) ?? win.line,
                /* How solid the window should look. Falls away as the fold
                 * swallows it, so it is nearly gone by the time it is
                 * discarded rather than blinking out at full strength. */
                fade: this._fade(win),
                /* Whether the window itself should still be taking the
                 * pointer where the pointer is now. */
                acceptsPointer: this._acceptsPointer(win),
            };
        });
    }

    /* Where each crease is drawn, as against where the fold is.
     *
     * Paper has thickness. Windows folded along one crease are a stack of
     * sheets, and a stack does not fold along a single line: each sheet has to
     * bend around the ones inside it, so its crease comes to rest a sheet's
     * thickness further round than theirs. Drawn on one exact line instead,
     * any number of windows folded together read as a single sheet — the whole
     * point of folding the stack rather than the window is lost.
     *
     * The lowest sheet in the stack is the one that ends up outermost once the
     * fold turns the stack over (see flapPaintOrder), so it is the one that
     * has to reach furthest around, and its crease is drawn deepest into the
     * window. Working down from the top of each fold, that is one sheet's
     * offset per window.
     *
     * Per fold, not per screen: two windows folded along creases of their own
     * are not one stack, and nothing about one says where the other's paper
     * ends.
     *
     * Drawing-only, deliberately. The fold the pointer pushes against, the
     * area that decides a discard and the side of the crease the drop lands on
     * are all still the one crease the core has been keeping all along; this
     * is how thick the paper looks, not where the fold is. */
    _drawnLines() {
        const depths = new Map();
        const out = new Map();
        for (let i = this.order.length - 1; i >= 0; i--) {
            const win = this.states.get(this.order[i]);
            if (!win || !win.line)
                continue;
            if (win.state !== FOLDED && win.state !== DISCARDED)
                continue;
            const fold = foldGroup(win, win.id);
            const depth = depths.get(fold) ?? 0;
            depths.set(fold, depth + 1);
            if (depth === 0)
                continue;
            const back = depth * this.config.sheetOffsetPx;
            out.set(win.id, makeLine(sub(win.line.point, scale(win.line.normal, back)),
                win.line.normal));
        }
        return out;
    }

    /* Is the pointer over the window, or over what the window used to cover?
     *
     * Redirecting the drop is the whole technique, and folding a window is how
     * it is asked for — but a fold only ever swallows part of a window. The
     * part still lying flat is still the window, and has to go on taking drops
     * like any other. This is the same rule pointOccluded() applies to
     * crossings, asked of the pointer rather than of a crossing point: a
     * folded window covers only its kept side.
     *
     * It comes out as one boolean rather than as a region because that is all
     * the renderer can act on. Clutter picks whole actors, so the finest thing
     * it can say is whether this window takes the pointer where the pointer
     * actually is — which is the only place anything ever asks. */
    _acceptsPointer(win) {
        if (win.state === DISCARDED)
            return false;
        if (win.state !== FOLDED || !win.line || !this.lastPoint)
            return true;
        return signedDistance(win.line, this.lastPoint) < 0;
    }

    /* Only fades toward a discard that is actually going to happen: with
     * discarding switched off a deep fold stays solid rather than thinning to
     * nothing and then staying on screen. */
    _fade(win) {
        if (!this.config.discardEnabled || win.state !== FOLDED)
            return 1;
        return foldFade(win.rect, win.line, this.config.discardThreshold);
    }

    _apply(intent, from, to, timeMs) {
        const win = this.states.get(intent.windowId);
        if (!win)
            return;

        switch (intent.type) {
        case 'transient': {
            const edge = rectEdges(win.rect).find(e => e.id === intent.edgeId);
            if (!edge)
                break;
            /* Where the pointer left the edge, and where it was heading:
             * a diagonal exit reads as aiming at a corner and gets one. */
            const normal = cornerLiftNormal(edge, intent.point, sub(to, from));
            const total = this.config.transientTimeoutMs;
            win.state = TRANSIENT;
            win.animNormal = normal;
            win.animKind = 'lift';
            win.anim = makeAnimation({
                from: 0,
                to: liftDistance(win.rect, normal, this.config.transientDepthPx),
                startedMs: timeMs,
                durationMs: total * 0.3,
                curve: PRESETS.liftOut.curve,
                reverse: { durationMs: total * 0.7, curve: PRESETS.liftBack.curve },
            });
            win.line = null;
            break;
        }

        case 'confirm': {
            /* The lift's own angle wins. A window can already have been folded
             * by a cascade from the window below in this same batch of intents,
             * which would otherwise hand it that window's crease angle instead
             * of the one the user lifted. */
            const normal = win.animNormal ?? (win.line ? win.line.normal : null);
            if (!normal)
                break;
            this._clearAnimation(win);
            win.state = FOLDED;
            /* Re-anchor the crease to the pointer so it starts following the
             * pointer inward straight away — the paper's "this can immediately
             * follow the confirmation gesture". */
            win.line = anchorFoldLine(normal, to, this.config.pushDeltaPx);
            /* Folding a window folds the windows over it, but which ones and
             * where is recomputed from the crease every tick — see
             * _syncCascade — rather than stamped once here. */
            win.leader = null;
            break;
        }

        case 'push':
            this._clearAnimation(win);
            if (win.line)
                win.line = pushFoldLine(win.line, from, to, this.config.pushDeltaPx, this.config.rotationLerp);
            break;

        case 'unfold':
            if (win.state === FOLDED && !win.anim)
                this._startUnfold(win, timeMs);
            break;
        }
    }

    /* Rebuild, from scratch, which windows are being carried by someone
     * else's fold.
     *
     * Folding a window folds the windows resting on it. The reference does
     * this by re-running foldUpperFrames on every push, so a follower's crease
     * is always the leader's current one. Recomputing here has the same effect
     * and cannot drift: there is one crease, owned by the window the pointer is
     * actually pushing, and everything it reaches is redrawn from it.
     *
     * Stamping the crease on once at confirm time instead let the two diverge
     * without bound — the follower ratcheted deeper every frame under
     * enforceFoldOrder while the leader stood still — and marked windows the
     * crease never even touched as folded, so they vanished. */
    _syncCascade() {
        /* Who leads whom, decided before anything is written, so a leader is
         * never chosen on the strength of a crease this same pass installed. */
        const claims = new Map();
        for (const id of this.order) {
            const win = this.states.get(id);
            if (!win || win.state !== FOLDED || win.leader !== null || !win.line)
                continue;
            for (const other of windowsAbove(this.order, id)) {
                const upper = this.states.get(other);
                if (!upper || upper.state === DISCARDED)
                    continue;
                /* A window folded by a gesture of its own keeps its own
                 * crease; enforceFoldOrder is what keeps those coherent. */
                if (upper.state === FOLDED && upper.leader === null)
                    continue;
                if (!foldReaches(win.rect, win.line, upper.rect))
                    continue;
                /* Two folds can reach the same window. The deeper one wins,
                 * which is the single-line reading of the reference's union of
                 * the two folded-away regions. */
                const claim = claims.get(other);
                if (claim && visibleFraction(upper.rect, claim.line) <=
                             visibleFraction(upper.rect, win.line))
                    continue;
                claims.set(other, win);
            }
        }

        for (const win of this.states.values()) {
            const leader = claims.get(win.id);
            if (leader) {
                /* A window mid-lift that gets swept up must give up its own
                 * animation — otherwise _advanceAnimations keeps overwriting
                 * its crease with lift geometry and then unfolds it out from
                 * under the fold once the lift ends. */
                if (win.anim)
                    this._clearAnimation(win);
                win.state = FOLDED;
                win.leader = leader.id;
                win.line = leader.line;
            } else if (win.leader !== null) {
                /* The crease that was carrying it no longer reaches it. */
                win.leader = null;
                if (win.state === FOLDED) {
                    win.state = NORMAL;
                    win.line = null;
                }
            }
        }
    }

    /* The drag is over. Every fold retracts to the corner it cut, which is
     * what makes the windows unfold rather than blink back.
     *
     * The cascade is dissolved first so each window animates its own crease:
     * they all start from the same line, so they still move as one sheet, and
     * nothing is left pointing at a leader that has already landed. */
    beginRestore(timeMs) {
        this.frozen = true;
        this.restoring = true;
        for (const win of this.states.values()) {
            win.leader = null;
            if (win.state === TRANSIENT) {
                this._clearAnimation(win);
                win.state = NORMAL;
                win.line = null;
                continue;
            }
            if (win.state === DISCARDED && win.line)
                win.state = FOLDED;
            if (win.state !== FOLDED) {
                win.state = NORMAL;
                win.line = null;
                continue;
            }
            this._clearAnimation(win);
            this._startUnfold(win, timeMs, this.config.restoreMs);
        }
        this.lastTimeMs = timeMs;
        return this.describe();
    }

    /* The drop has landed. Stop arming gestures, but keep the folds exactly as
     * they are so the result of the drop can be seen before they unfold. */
    hold() {
        this.frozen = true;
        return this.describe();
    }

    /* Everything is back where it started and the renderer can let go. */
    settled() {
        for (const win of this.states.values()) {
            if (win.state !== NORMAL || win.anim)
                return false;
        }
        return true;
    }

    _applyDiscards() {
        if (!this.config.discardEnabled)
            return;
        for (const win of this.states.values()) {
            if (win.state !== FOLDED || !win.line || win.anim)
                continue;
            if (visibleFraction(win.rect, win.line) < this.config.discardThreshold) {
                win.state = DISCARDED;
                /* The crease is deliberately kept. Nothing reads it while the
                 * window is discarded — boundaries(), the intents and the
                 * occlusion test all skip DISCARDED — but it is what the
                 * window unfolds back along when the drag ends. Blanking it
                 * left the window with no way back except appearing. */
            }
        }
    }
}
