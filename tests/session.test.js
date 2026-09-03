/* Fold n' Drop — GPL-3.0. Tests for the whole fold session; no gi imports. */
import { describe, it, assert, assertEqual, assertClose } from './harness.js';
import { vec, makeLine, signedDistance, lineChordInRect } from '../src/core/geometry.js';
import {
    NORMAL, TRANSIENT, FOLDED, DISCARDED,
    visibleFraction, cornerFor, cornerDistance,
} from '../src/core/fold.js';
import { Session, DEFAULT_CONFIG } from '../src/core/session.js';

/* Two windows stacked bottom-to-top, both at the same place. */
const WINDOWS = [
    { id: 'under', rect: { x: 0, y: 0, width: 200, height: 100 } },
    { id: 'over', rect: { x: 0, y: 0, width: 200, height: 100 } },
];

/* Same stacking, but the upper window is nowhere near the lower one. */
const SEPARATE = [
    { id: 'under', rect: { x: 0, y: 0, width: 200, height: 100 } },
    { id: 'far', rect: { x: 400, y: 0, width: 100, height: 100 } },
];

/* `over` is shorter than `under`, so a push down at y=150 crosses only under's
 * crease. That isolates the coherency correction: `over` gets no push intent of
 * its own, so if enforceFoldOrder fails to fire, its crease stays put and a
 * strip of it is left painted over a region `under` has already folded away. */
const ASYMMETRIC = [
    { id: 'under', rect: { x: 0, y: 0, width: 200, height: 200 } },
    { id: 'over', rect: { x: 0, y: 0, width: 200, height: 100 } },
];

/* `over` sits inside `under`'s footprint and stops short of `under`'s right
 * edge, so leaving `under` never crosses `over`'s own edge. `over` can only be
 * folded here by the cascade, never by a confirm of its own, which is exactly
 * the case that can leave a lift animation running on a window that is now
 * FOLDED. It is wide enough that `under`'s crease genuinely runs through it —
 * a crease that misses a window no longer carries it. */
const NESTED = [
    { id: 'under', rect: { x: 0, y: 0, width: 200, height: 200 } },
    { id: 'over', rect: { x: 0, y: 0, width: 140, height: 200 } },
];

const stateOf = (desc, id) => desc.find(w => w.id === id).state;

function doubleCross(session, t0) {
    session.updatePointer(vec(100, 50), t0);
    session.updatePointer(vec(260, 50), t0 + 20);   // out through the right edge
    return session.updatePointer(vec(150, 50), t0 + 60); // back in, well inside the timeout
}

describe('session: setup', () => {
    it('starts every window normal', () => {
        const s = new Session();
        const desc = s.begin(WINDOWS, vec(100, 50), 0);
        assertEqual(desc.map(w => w.state), [NORMAL, NORMAL]);
        assertEqual(desc.map(w => w.id), ['under', 'over']);
    });
    it('merges caller config over the defaults', () => {
        const s = new Session({ transientTimeoutMs: 50 });
        assertEqual(s.config.transientTimeoutMs, 50);
        assertEqual(s.config.transientDepthPx, DEFAULT_CONFIG.transientDepthPx);
    });
    it('publishes edges for normal windows and a fold chord for folded ones', () => {
        const s = new Session();
        s.begin(WINDOWS, vec(100, 50), 0);
        assertEqual(s.boundaries().filter(b => b.kind === 'edge').length, 8);
        doubleCross(s, 0);
        assert(s.boundaries().some(b => b.kind === 'fold'), 'a folded window must publish its fold line');
    });
});

describe('session: folding', () => {
    it('folds a window on a fast double-crossing', () => {
        const s = new Session();
        s.begin(WINDOWS, vec(100, 50), 0);
        assertEqual(stateOf(doubleCross(s, 0), 'over'), FOLDED);
    });
    it('leaves the window transient after only leaving it', () => {
        const s = new Session();
        s.begin(WINDOWS, vec(100, 50), 0);
        s.updatePointer(vec(100, 50), 0);
        const desc = s.updatePointer(vec(260, 50), 20);
        assertEqual(stateOf(desc, 'over'), TRANSIENT);
    });
    it('springs a transient fold back once the timeout elapses', () => {
        const s = new Session();
        s.begin(WINDOWS, vec(100, 50), 0);
        s.updatePointer(vec(100, 50), 0);
        s.updatePointer(vec(260, 50), 20);
        assertEqual(stateOf(s.tick(600), 'over'), NORMAL);
    });
    it('does not fold on a slow return', () => {
        const s = new Session();
        s.begin(WINDOWS, vec(100, 50), 0);
        s.updatePointer(vec(100, 50), 0);
        s.updatePointer(vec(260, 50), 20);
        assertEqual(stateOf(s.updatePointer(vec(150, 50), 900), 'over'), NORMAL);
    });
    it('folds every overlapping window above the one that was folded', () => {
        const s = new Session({ discardEnabled: false });
        s.begin(WINDOWS, vec(100, 50), 0);
        const desc = doubleCross(s, 0);
        assertEqual(stateOf(desc, 'under'), FOLDED);
        assertEqual(stateOf(desc, 'over'), FOLDED);
    });
    it('leaves a window above that does not overlap alone', () => {
        const s = new Session({ discardEnabled: false });
        s.begin(SEPARATE, vec(100, 50), 0);
        const desc = doubleCross(s, 0);
        assertEqual(stateOf(desc, 'under'), FOLDED);
        assertEqual(stateOf(desc, 'far'), NORMAL);
    });
    it('leaves the crease behind the pointer so it can be pushed on', () => {
        const s = new Session({ discardEnabled: false });
        s.begin(WINDOWS, vec(100, 50), 0);
        doubleCross(s, 0);
        const over = s.describe().find(w => w.id === 'over');
        /* doubleCross ends at x = 150; the crease sits one push delta behind. */
        assertEqual(Math.round(over.line.point.x), 150 - DEFAULT_CONFIG.pushDeltaPx);
    });
});

describe('session: pushing, discarding, unfolding', () => {
    it('deepens the fold when the crease is driven further into the window', () => {
        const s = new Session({ discardEnabled: false });
        s.begin(WINDOWS, vec(100, 50), 0);
        doubleCross(s, 0);
        const before = s.describe().find(w => w.id === 'over');
        const beforeVisible = visibleFraction(before.rect, before.line);
        s.updatePointer(vec(60, 50), 100);
        const after = s.describe().find(w => w.id === 'over');
        assert(visibleFraction(after.rect, after.line) < beforeVisible, 'pushing must reveal more');
    });
    it('discards a window pushed past the threshold', () => {
        const s = new Session();
        s.begin(WINDOWS, vec(100, 50), 0);
        doubleCross(s, 0);
        let desc = s.describe();
        let t = 100;
        for (let x = 140; x >= 0 && stateOf(desc, 'over') !== DISCARDED; x -= 10)
            desc = s.updatePointer(vec(x, 50), t += 20);
        assertEqual(stateOf(desc, 'over'), DISCARDED);
    });
    it('never discards when discarding is disabled', () => {
        const s = new Session({ discardEnabled: false });
        s.begin(WINDOWS, vec(100, 50), 0);
        doubleCross(s, 0);
        let desc = s.describe();
        let t = 100;
        for (let x = 140; x >= 0; x -= 10)
            desc = s.updatePointer(vec(x, 50), t += 20);
        assert(stateOf(desc, 'over') !== DISCARDED, 'discarding is off');
    });
});

/* Ending a drag no longer wipes the session's state: the folds unfold, which
 * is what the tests under "the drag ends by unfolding" cover. Aborting — a
 * workspace switch, the overview — throws the session away and lets the
 * renderer put the actors back, so there is nothing left here for the session
 * itself to be asked about. */
describe('session: teardown', () => {
    it('drops a window that goes away mid-drag', () => {
        const s = new Session();
        s.begin(WINDOWS, vec(100, 50), 0);
        s.removeWindow('over');
        assertEqual(s.describe().map(w => w.id), ['under']);
        s.updatePointer(vec(260, 50), 20);
        assertEqual(s.describe().map(w => w.id), ['under']);
    });
});

describe('session: asymmetric stacks', () => {
    it('drags an upper fold along when only the lower window is pushed', () => {
        const s = new Session({ discardEnabled: false });
        s.begin(ASYMMETRIC, vec(100, 50), 0);
        doubleCross(s, 0);
        s.updatePointer(vec(250, 150), 100);              // below `over`, crossing nothing
        const desc = s.updatePointer(vec(150, 150), 120); // crosses only under's crease
        const under = desc.find(w => w.id === 'under');
        const over = desc.find(w => w.id === 'over');
        for (let x = 0; x <= 200; x += 5) {
            for (const y of [0, 50, 100]) {
                const p = vec(x, y);
                if (signedDistance(under.line, p) > 0)
                    assert(signedDistance(over.line, p) >= -1e-9,
                        `x=${x},y=${y} is folded away below but still painted above`);
            }
        }
    });
});

/* The lift's outbound leg is 30% of the timeout, the return the other 70%. */
const LIFT_OUT_MS = DEFAULT_CONFIG.transientTimeoutMs * 0.3;

function leaveWindow(session, t0) {
    session.updatePointer(vec(100, 50), t0);
    return session.updatePointer(vec(260, 10), t0 + 20);  // out near the top-right
}

describe('session: the corner lift', () => {
    it('leaves the window transient with a lifted corner', () => {
        const s = new Session();
        s.begin(WINDOWS, vec(100, 50), 0);
        const desc = leaveWindow(s, 0);
        assertEqual(stateOf(desc, 'over'), TRANSIENT);
    });
    it('starts the crease at the corner rather than at full depth', () => {
        const s = new Session();
        s.begin(WINDOWS, vec(100, 50), 0);
        leaveWindow(s, 0);
        /* The crossing lands at t0+20; sample the first advanced frame after
         * that, rather than the crossing frame itself, which always reports
         * line === null and would let this pass against the old geometry
         * too. */
        const line = s.tick(21).find(w => w.id === 'over').line;
        assert(line !== null && cornerDistance(WINDOWS[1].rect, line) < 4,
            'the lift must begin at the corner, not at full depth');
    });
    it('cuts the corner the pointer left nearest', () => {
        const s = new Session();
        s.begin(WINDOWS, vec(100, 50), 0);
        leaveWindow(s, 0);
        const line = s.tick(LIFT_OUT_MS).find(w => w.id === 'over').line;
        assertEqual(cornerFor(WINDOWS[1].rect, line.normal), { x: 200, y: 0 });
    });
    it('rolls the crease out over the outbound leg', () => {
        const s = new Session();
        s.begin(WINDOWS, vec(100, 50), 0);
        leaveWindow(s, 0);
        const early = s.tick(30).find(w => w.id === 'over').line;
        const late = s.tick(LIFT_OUT_MS).find(w => w.id === 'over').line;
        const rect = WINDOWS[1].rect;
        assert(cornerDistance(rect, late) > cornerDistance(rect, early),
            'the crease must travel away from the corner');
    });
    it('rolls back and returns the window to normal', () => {
        const s = new Session();
        s.begin(WINDOWS, vec(100, 50), 0);
        leaveWindow(s, 0);
        assertEqual(stateOf(s.tick(20 + DEFAULT_CONFIG.transientTimeoutMs + 1), 'over'), NORMAL);
    });
    it('is still liftable while the return leg is running', () => {
        const s = new Session();
        s.begin(WINDOWS, vec(100, 50), 0);
        leaveWindow(s, 0);
        assertEqual(stateOf(s.tick(20 + LIFT_OUT_MS + 20), 'over'), TRANSIENT);
    });
    it('confirms on a re-entry while the lift is live', () => {
        const s = new Session();
        s.begin(WINDOWS, vec(100, 50), 0);
        leaveWindow(s, 0);
        const desc = s.updatePointer(vec(150, 50), 60);
        assertEqual(stateOf(desc, 'over'), FOLDED);
    });
    it('does nothing on a re-entry after the lift has finished', () => {
        const s = new Session();
        s.begin(WINDOWS, vec(100, 50), 0);
        leaveWindow(s, 0);
        const after = 20 + DEFAULT_CONFIG.transientTimeoutMs + 50;
        s.tick(after);
        assertEqual(stateOf(s.updatePointer(vec(150, 50), after + 10), 'over'), NORMAL);
    });
    it('drops the animation once the fold is confirmed', () => {
        const s = new Session();
        s.begin(WINDOWS, vec(100, 50), 0);
        leaveWindow(s, 0);
        s.updatePointer(vec(150, 50), 60);
        /* Ticking well past the lift's lifetime must not unfold it. */
        assertEqual(stateOf(s.tick(5000), 'over'), FOLDED);
    });
    it('drops a mid-lift animation on a window swept into a confirm cascade', () => {
        const s = new Session({ discardEnabled: false });
        s.begin(NESTED, vec(50, 50), 0);
        s.updatePointer(vec(150, 50), 10);  // leaves `over` only: its lift starts
        s.updatePointer(vec(260, 50), 20);  // leaves `under` too: its lift starts
        /* Back inside `under`'s edge, never touching `over`'s own edge, so
         * `over` is folded only by the cascade, with its own lift still
         * live at the moment it happens. */
        const desc = s.updatePointer(vec(150, 50), 30);
        assertEqual(stateOf(desc, 'under'), FOLDED);
        assertEqual(stateOf(desc, 'over'), FOLDED);
        assertEqual(s.states.get('over').anim, null);
        /* Well past the lift's own lifetime, the cascaded fold must still
         * hold — a leftover lift animation would otherwise complete on its
         * own schedule and silently unfold `over` back to NORMAL. */
        assertEqual(stateOf(s.tick(1000), 'over'), FOLDED);
    });
});

/* Named UNFOLD_STACK, not NESTED: Task 3's fix already added a `NESTED` fixture
 * to this file with a different geometry (under 200x200, over 100x100), and a
 * second `const NESTED` at module scope would not parse. The routes below are
 * derived from THIS fixture's dimensions — do not merge the two. */

/* `under` is large enough that leaving `over` keeps the pointer inside it, so
 * each window can be folded on its own and the two creases stay far apart.
 * With both folded, neither publishes edges, so the routes below can leave the
 * screen area entirely without arming anything. */
const UNFOLD_STACK = [
    { id: 'under', rect: { x: 0, y: 0, width: 400, height: 300 } },
    { id: 'over', rect: { x: 0, y: 0, width: 200, height: 100 } },
];

/* Fold `over` alone: out through its right edge at a point still well inside
 * `under`, then straight back in. Leaves over's crease running from about
 * (126, 0) to (166, 100), with the pointer on its folded side. */
function foldOver(s) {
    s.updatePointer(vec(100, 50), 0);
    s.updatePointer(vec(260, 25), 20);
    return s.updatePointer(vec(150, 50), 60);
}

/* Go around the end of over's crease and cross it outward — the paper's
 * Figure 4. Only the last leg touches a boundary: the first stays on the folded
 * side, the second passes below the chord, which spans only y 0..100, and the
 * third runs up at x = 60, left of the chord entirely. */
function unfoldOver(s, t) {
    s.updatePointer(vec(190, 150), t - 30);
    s.updatePointer(vec(60, 150), t - 20);
    s.updatePointer(vec(60, 40), t - 10);
    return s.updatePointer(vec(190, 20), t);
}

const OVER_RECT = UNFOLD_STACK[1].rect;
const lineOf = (desc, id) => desc.find(w => w.id === id).line;

describe('session: unfolding', () => {
    it('keeps the window folded while the crease retracts', () => {
        const s = new Session({ discardEnabled: false });
        s.begin(UNFOLD_STACK, vec(100, 50), 0);
        foldOver(s);
        assertEqual(stateOf(unfoldOver(s, 100), 'over'), FOLDED);
    });
    it('moves the crease back toward the corner', () => {
        const s = new Session({ discardEnabled: false });
        s.begin(UNFOLD_STACK, vec(100, 50), 0);
        foldOver(s);
        unfoldOver(s, 100);
        const early = cornerDistance(OVER_RECT, lineOf(s.tick(140), 'over'));
        const late = cornerDistance(OVER_RECT, lineOf(s.tick(340), 'over'));
        assert(late < early, 'the crease must travel back toward the corner');
    });
    it('reveals more of the window as it unfolds', () => {
        const s = new Session({ discardEnabled: false });
        s.begin(UNFOLD_STACK, vec(100, 50), 0);
        foldOver(s);
        unfoldOver(s, 100);
        const early = visibleFraction(OVER_RECT, lineOf(s.tick(140), 'over'));
        const late = visibleFraction(OVER_RECT, lineOf(s.tick(340), 'over'));
        assert(late > early, 'unfolding must give the window back');
    });
    it('returns to normal once the crease reaches the corner', () => {
        const s = new Session({ discardEnabled: false });
        s.begin(UNFOLD_STACK, vec(100, 50), 0);
        foldOver(s);
        unfoldOver(s, 100);
        assertEqual(stateOf(s.tick(100 + DEFAULT_CONFIG.unfoldMs + 1), 'over'), NORMAL);
    });
    it('does not restart the animation on every tick', () => {
        const s = new Session({ discardEnabled: false });
        s.begin(UNFOLD_STACK, vec(100, 50), 0);
        foldOver(s);
        unfoldOver(s, 100);
        for (let t = 110; t < 340; t += 16)
            s.tick(t);
        assert(cornerDistance(OVER_RECT, lineOf(s.tick(340), 'over')) < 20,
            'repeated ticks must not reset progress');
    });
    it('lets a push take a fold back off an unfold in flight', () => {
        const s = new Session({ discardEnabled: false });
        s.begin(UNFOLD_STACK, vec(100, 50), 0);
        foldOver(s);
        unfoldOver(s, 100);
        s.tick(120);
        /* Come back at the retracting crease from the revealed side. */
        const desc = s.updatePointer(vec(100, 50), 140);
        assertEqual(stateOf(desc, 'over'), FOLDED);
        assertEqual(s.states.get('over').anim, null);
    });
    it('cascades to the window below only once it has landed', () => {
        const s = new Session({ discardEnabled: false });
        s.begin(UNFOLD_STACK, vec(100, 50), 0);
        foldOver(s);

        /* Fold `under` as well, by crossing its own right edge at x = 400.
         * Every leg stays on over's folded side, so nothing gets pushed. */
        s.updatePointer(vec(300, 150), 70);
        s.updatePointer(vec(460, 150), 80);
        s.updatePointer(vec(350, 150), 120);
        assertEqual(stateOf(s.describe(), 'under'), FOLDED);

        /* Round the top ends of both creases, then cross only over's. */
        s.updatePointer(vec(350, -50), 130);
        s.updatePointer(vec(100, -50), 140);
        s.updatePointer(vec(100, 40), 150);
        const desc = s.updatePointer(vec(190, 20), 160);
        assertEqual(stateOf(desc, 'over'), FOLDED);
        assertEqual(stateOf(desc, 'under'), FOLDED, 'under must not unfold yet');

        const landed = s.tick(160 + DEFAULT_CONFIG.unfoldMs + 1);
        assertEqual(stateOf(landed, 'over'), NORMAL);
        assertEqual(stateOf(landed, 'under'), FOLDED, 'under starts only now');
        assertEqual(stateOf(s.tick(160 + 2 * DEFAULT_CONFIG.unfoldMs + 3), 'under'), NORMAL);
    });
});

/* Named CASCADE_STACK, not UNFOLD_STACK: adds a third window, `far`, sitting
 * bottom-most in stacking order but well off to the side spatially (x from
 * 1000), so folding or unfolding it never interacts with `under` or `over`'s
 * geometry at all. This isolates the one thing under test — that landing an
 * unfold starts every FOLDED window below it, not only the next one down —
 * from the geometric coherency rules already covered above. Stacking order
 * is `far` (bottom), `under` (middle), `over` (top), matching UNFOLD_STACK
 * for the latter two. */
const CASCADE_STACK = [
    { id: 'far', rect: { x: 1000, y: 0, width: 200, height: 100 } },
    { id: 'under', rect: { x: 0, y: 0, width: 400, height: 300 } },
    { id: 'over', rect: { x: 0, y: 0, width: 200, height: 100 } },
];

/* Fold `far` alone, then travel back to `under`/`over`'s territory by way of
 * y = -500 — well above every rect here, so nothing on the way is crossed.
 * The first leg holds x fixed at far's own exit point so it does not cross
 * back over far's own crease while leaving. */
function foldFarAndReturn(s) {
    s.updatePointer(vec(1100, 50), 0);
    s.updatePointer(vec(1260, 50), 20);
    s.updatePointer(vec(1150, 50), 60);
    s.updatePointer(vec(1150, -500), 65);
    s.updatePointer(vec(100, -500), 68);
    return s.updatePointer(vec(100, 50), 70);
}

describe('session: cascading an unfold through three windows', () => {
    it('starts the two lower windows unfolding together, not one at a time', () => {
        const s = new Session({ discardEnabled: false });
        s.begin(CASCADE_STACK, vec(1100, 50), 0);
        foldFarAndReturn(s);
        assertEqual(stateOf(s.describe(), 'far'), FOLDED);

        s.updatePointer(vec(260, 25), 90);
        s.updatePointer(vec(150, 50), 130);
        assertEqual(stateOf(s.describe(), 'over'), FOLDED);

        s.updatePointer(vec(300, 150), 140);
        s.updatePointer(vec(460, 150), 150);
        s.updatePointer(vec(350, 150), 190);
        assertEqual(stateOf(s.describe(), 'under'), FOLDED);

        /* Round the top end of over's crease, then cross only over's. */
        s.updatePointer(vec(350, -50), 200);
        s.updatePointer(vec(100, -50), 210);
        s.updatePointer(vec(100, 40), 220);
        const desc = s.updatePointer(vec(190, 20), 230);
        assertEqual(stateOf(desc, 'over'), FOLDED, 'over stays folded while its crease retracts');
        assertEqual(stateOf(desc, 'under'), FOLDED, 'under must not move yet');
        assertEqual(stateOf(desc, 'far'), FOLDED, 'far must not move yet either');

        const landed = s.tick(230 + DEFAULT_CONFIG.unfoldMs + 1);
        assertEqual(stateOf(landed, 'over'), NORMAL, 'over lands and returns to normal');
        assertEqual(stateOf(landed, 'under'), FOLDED, 'under is still folded the instant over lands');
        assertEqual(stateOf(landed, 'far'), FOLDED, 'far is still folded the instant over lands');
        assert(s.states.get('under').anim !== null, 'under must start unfolding as soon as over lands');
        assert(s.states.get('far').anim !== null, 'far must start unfolding at the same moment as under');

        /* One full unfold duration later, BOTH must be done — not just
         * `under`, with `far` needing a second cycle behind it. That second
         * cycle is exactly what a one-at-a-time cascade would need. */
        const bothDone = s.tick(230 + DEFAULT_CONFIG.unfoldMs + 1 + DEFAULT_CONFIG.unfoldMs + 1);
        assertEqual(stateOf(bothDone, 'under'), NORMAL, 'under finishes unfolding');
        assertEqual(stateOf(bothDone, 'far'), NORMAL, 'far finishes in the same cycle as under');
    });
});

/* Regression: a crease can end up level with, or just past, the corner it
 * cuts — anchorFoldLine puts it pushDeltaPx beyond the pointer, and
 * enforceFoldOrder can slide it further still. Unfolding from there used to
 * animate a non-positive corner distance, which wrote a null crease onto a
 * window that was still FOLDED. The renderer dereferences that crease every
 * frame, so the whole sync() threw for the entire unfold duration: the fold
 * never animated, it just disappeared, and no other window updated either. */
describe('session: a fold never outlives its crease', () => {
    it('retires a fold whose crease has already passed the corner it cuts', () => {
        const s = new Session();
        s.begin([{ id: 'w', rect: { x: 0, y: 0, width: 200, height: 200 } }], vec(100, 100), 0);
        const win = s.states.get('w');
        win.state = FOLDED;
        /* Normal points at the top-left corner, but the crease sits beyond it,
         * so the cut corner is on the kept side: corner distance is negative. */
        win.line = makeLine(vec(-10, -10), vec(-1, -1));
        assert(cornerDistance(win.rect, win.line) < 0, 'precondition: nothing left to unfold');

        s._startUnfold(win, 0);
        assertEqual(win.state, NORMAL, 'an empty fold retires instead of animating');
        assertEqual(win.line, null);
    });

    it('never reports a folded window without a crease, over a long random drag', () => {
        const windows = [
            { id: 1, rect: { x: 100, y: 100, width: 600, height: 400 } },
            { id: 2, rect: { x: 300, y: 200, width: 600, height: 400 } },
        ];
        /* Deterministic PRNG: the same drags every run. */
        let seedState = 0;
        const rnd = () => {
            seedState = (seedState + 0x6D2B79F5) | 0;
            let t = Math.imul(seedState ^ (seedState >>> 15), 1 | seedState);
            t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
            return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
        };

        for (let seed = 0; seed < 4000; seed++) {
            seedState = seed;
            const s = new Session();
            let t = 0;
            let p = vec(400, 300);
            s.begin(windows, p, t);
            for (let step = 0; step < 120; step++) {
                t += 16;
                p = vec(p.x + (rnd() - 0.5) * 260, p.y + (rnd() - 0.5) * 260);
                for (const w of s.updatePointer(p, t)) {
                    assert(w.state !== FOLDED || w.line !== null,
                        `seed ${seed} step ${step}: window ${w.id} folded with no crease`);
                }
            }
        }
    });
});

/* The reference gates every fold on isPointVisible(): an edge you cannot see
 * is an edge you cannot have meant to cross. Without that gate one stroke
 * across the top window's interior also crosses the coincident edges of every
 * window stacked underneath it, and folds all of them at once. */
describe('session: only the window you can actually see folds', () => {
    /* `small` sits entirely inside `big`, and underneath it, so none of its
     * edges are visible. */
    const NESTED = [
        { id: 'small', rect: { x: 50, y: 50, width: 100, height: 100 } },
        { id: 'big', rect: { x: 0, y: 0, width: 200, height: 200 } },
    ];

    it('leaves a completely covered window alone when the pointer crosses its edge', () => {
        const s = new Session();
        s.begin(NESTED, vec(100, 100), 0);
        /* Straight out to the right: crosses small's right edge at x=150,
         * which is buried under big, then big's own at x=200. */
        const desc = s.updatePointer(vec(300, 100), 10);
        assertEqual(stateOf(desc, 'small'), NORMAL, 'the buried window must not lift');
        assertEqual(stateOf(desc, 'big'), TRANSIENT, 'the visible window still lifts');
    });

    it('still folds a window whose edge is exposed', () => {
        /* Same pair, but now `big` is the lower one, so its edge is exposed
         * and `small` sits on top of it without covering that edge. */
        const s = new Session();
        s.begin([
            { id: 'big', rect: { x: 0, y: 0, width: 200, height: 200 } },
            { id: 'small', rect: { x: 50, y: 50, width: 100, height: 100 } },
        ], vec(100, 100), 0);
        const desc = s.updatePointer(vec(300, 100), 10);
        assertEqual(stateOf(desc, 'small'), TRANSIENT, 'the top window lifts');
        assertEqual(stateOf(desc, 'big'), TRANSIENT, 'its exposed edge still counts');
    });
});

/* A window in the middle of the screen with a wide one resting on top of it.
 * The wide one reaches the left edge of the screen but stops short of the
 * middle window's right edge, so the fold gesture can be made there without
 * the wide window covering it. Pushing the crease leftward eventually carries
 * the wide window along — the cascade, on a geometry where it is possible to
 * tell the leader's crease from the follower's. */
const CASCADE_REACH = [
    { id: 'mid', rect: { x: 600, y: 200, width: 400, height: 300 } },
    { id: 'wide', rect: { x: 0, y: 150, width: 700, height: 400 } },
];

function foldMidRightEdge(session) {
    session.updatePointer(vec(900, 300), 16);
    session.updatePointer(vec(1020, 320), 32);   // out through mid's right edge
    return session.updatePointer(vec(960, 340), 48);  // back in: confirm
}

/* Fold `mid` and push until its crease has picked `wide` up as well. */
function carryWide(s) {
    foldMidRightEdge(s);
    for (let i = 0; i < 24; i++) {
        const desc = s.updatePointer(vec(950 - i * 16, 340 + i * 3), 64 + i * 16);
        if (stateOf(desc, 'wide') === FOLDED)
            return desc;
    }
    return null;
}

/* Everything a description says apart from where the creases are drawn. */
const strip = desc => desc.map(({ line, ...rest }) => rest);
const creases = s => [...s.states.values()].map(w => w.line);

describe('session: paper has thickness', () => {
    it('draws a lone fold on exactly the crease the core is keeping', () => {
        const s = new Session({ discardEnabled: false });
        s.begin(UNFOLD_STACK, vec(100, 50), 0);
        const desc = foldOver(s);
        assertEqual(stateOf(desc, 'over'), FOLDED);
        assertEqual(lineOf(desc, 'over'), s.states.get('over').line);
    });

    /* The lower window is the one that ends up outermost once the fold turns
     * the stack over, so it is the one that has to reach furthest round. */
    it('draws the lower of two windows folded together one sheet deeper', () => {
        const s = new Session({ discardEnabled: false });
        s.begin(CASCADE_REACH, vec(900, 300), 0);
        const desc = carryWide(s);
        assert(desc !== null, 'the crease never picked the wide window up');
        const lower = lineOf(desc, 'mid');
        const upper = lineOf(desc, 'wide');
        assertEqual(upper, s.states.get('wide').line);
        assertEqual(lower.normal, upper.normal);
        assertClose(signedDistance(lower, upper.point), s.config.sheetOffsetPx);
    });

    it('puts them back on one line when the paper has no thickness', () => {
        const s = new Session({ discardEnabled: false, sheetOffsetPx: 0 });
        s.begin(CASCADE_REACH, vec(900, 300), 0);
        const desc = carryWide(s);
        assert(desc !== null, 'the crease never picked the wide window up');
        assertEqual(lineOf(desc, 'mid'), lineOf(desc, 'wide'));
    });

    /* Thickness is how the fold looks, not where it is. Nothing the session
     * decides from the crease — what the pointer pushes against, how solid a
     * window is drawn, whether it has been folded away far enough to discard,
     * which side of the fold the drop lands on — may move because the paper
     * was drawn thicker. */
    it('changes nothing but where the creases are drawn', () => {
        const thin = new Session({ sheetOffsetPx: 0 });
        thin.begin(CASCADE_REACH, vec(900, 300), 0);
        const thinDesc = carryWide(thin);

        const thick = new Session({ sheetOffsetPx: 40 });
        thick.begin(CASCADE_REACH, vec(900, 300), 0);
        const thickDesc = carryWide(thick);

        assert(thinDesc !== null && thickDesc !== null, 'the cascade did not happen');
        assertEqual(strip(thickDesc), strip(thinDesc));
        assertEqual(creases(thick), creases(thin));
    });
});

describe('session: a fold only carries the windows its crease runs through', () => {
    it('leaves an overlapping window alone while the crease is nowhere near it', () => {
        const s = new Session({ discardEnabled: false });
        s.begin(CASCADE_REACH, vec(900, 300), 0);
        const desc = foldMidRightEdge(s);
        assertEqual(stateOf(desc, 'mid'), FOLDED);
        /* The crease sits by mid's right edge, six hundred pixels from `wide`.
         * Folding it there hid its real actor behind a clone that had nothing
         * folded away at all, and a crease pointing the other way took the
         * whole window off the screen. */
        assertEqual(stateOf(desc, 'wide'), NORMAL);
        assertEqual(lineOf(desc, 'wide'), null);
    });

    it('picks the window up once the crease reaches it, and not before', () => {
        const s = new Session({ discardEnabled: false });
        s.begin(CASCADE_REACH, vec(900, 300), 0);
        foldMidRightEdge(s);
        let picked = null;
        for (let i = 0; i < 24; i++) {
            const desc = s.updatePointer(vec(950 - i * 16, 340 + i * 3), 64 + i * 16);
            if (stateOf(desc, 'wide') === FOLDED) {
                picked = s.describe().find(w => w.id === 'mid').line;
                break;
            }
        }
        assert(picked !== null, 'the crease never picked the wide window up');
        /* It is only picked up once the crease genuinely cuts it. The crease
         * is tilted, so its anchor point can still be to the right of the wide
         * window when the chord has already crossed into it — the test is
         * whether the line cuts the rect, not where the anchor sits. */
        assert(lineChordInRect(CASCADE_REACH[1].rect, picked) !== null,
            'the window was picked up by a crease that does not cut it');
    });

    it('keeps a carried window one sheet off the crease that carries it', () => {
        const s = new Session({ discardEnabled: false });
        s.begin(CASCADE_REACH, vec(900, 300), 0);
        foldMidRightEdge(s);
        let compared = 0;
        for (let i = 0; i < 24; i++) {
            const desc = s.updatePointer(vec(950 - i * 16, 340 + i * 3), 64 + i * 16);
            if (stateOf(desc, 'wide') !== FOLDED)
                continue;
            const lead = lineOf(desc, 'mid');
            const follow = lineOf(desc, 'wide');
            assert(lead !== null, 'the leader lost its crease');
            /* Stamping the crease on once at confirm time and leaving
             * enforceFoldOrder to keep it honest let the follower ratchet
             * hundreds of pixels deeper than the fold it belongs to. The two
             * are drawn a sheet apart and must stay exactly that: one crease,
             * two sheets of paper, and no drift on top of it. */
            assertEqual(follow.normal, lead.normal, `the carried crease turned at step ${i}`);
            assertClose(signedDistance(lead, follow.point), s.config.sheetOffsetPx, 1e-9,
                `the carried crease drifted at step ${i}`);
            compared++;
        }
        assert(compared > 4, `only ${compared} steps had the window carried`);
    });

    it('drives the crease the pointer is actually pushing', () => {
        const s = new Session({ discardEnabled: false });
        s.begin(CASCADE_REACH, vec(900, 300), 0);
        const at = desc => cornerDistance(CASCADE_REACH[0].rect, lineOf(desc, 'mid'));
        const start = at(foldMidRightEdge(s));
        let last = start;
        for (let i = 0; i < 24; i++) {
            const desc = s.updatePointer(vec(950 - i * 16, 340 + i * 3), 64 + i * 16);
            const now = at(desc);
            /* Once the window above was folded too it published a crease of
             * its own in the very same place, and the occlusion test read that
             * as the leader's crease being hidden. Every push went to the
             * follower and the fold under the pointer stopped dead. */
            assert(now >= last - 1e-9, `the leader's crease went backwards at step ${i}`);
            last = now;
        }
        assert(last > start + 200, `the crease only advanced ${(last - start).toFixed(1)}px`);
    });

    it('lets the window go again when the crease retracts past it', () => {
        const s = new Session({ discardEnabled: false });
        s.begin(CASCADE_REACH, vec(900, 300), 0);
        foldMidRightEdge(s);
        let t = 64;
        for (let i = 0; i < 24; i++, t += 16)
            s.updatePointer(vec(950 - i * 16, 340 + i * 3), t);
        assertEqual(stateOf(s.describe(), 'wide'), FOLDED);
        /* Unfolding the leader retracts the crease to the corner it cut, and
         * the window it was carrying has to come back with it. */
        s.states.get('mid').state = FOLDED;
        s._startUnfold(s.states.get('mid'), t);
        for (let i = 0; i < 40; i++, t += 16)
            s.updatePointer(vec(600, 500), t);
        assertEqual(stateOf(s.describe(), 'wide'), NORMAL);
        assertEqual(s.states.get('wide').leader, null);
    });
});

describe('session: the drag ends by unfolding, not by blinking back', () => {
    it('keeps a folded window folded and retracts its crease', () => {
        const s = new Session({ discardEnabled: false });
        s.begin(WINDOWS, vec(100, 50), 0);
        const folded = doubleCross(s, 0);
        assertEqual(stateOf(folded, 'over'), FOLDED);
        const depth = cornerDistance(WINDOWS[1].rect, lineOf(folded, 'over'));

        const desc = s.beginRestore(100);
        /* Still folded: the crease has to be seen coming back. Dropping
         * straight to normal is what made the windows just appear. */
        assertEqual(stateOf(desc, 'over'), FOLDED);
        assert(lineOf(desc, 'over') !== null, 'the crease vanished at the start of the restore');

        const half = s.tick(100 + DEFAULT_CONFIG.unfoldMs / 2);
        assertEqual(stateOf(half, 'over'), FOLDED);
        const midway = cornerDistance(WINDOWS[1].rect, lineOf(half, 'over'));
        assert(midway < depth && midway > 0,
            `crease at ${midway} is not partway back from ${depth}`);
    });

    it('settles every window once the creases have run out', () => {
        const s = new Session({ discardEnabled: false });
        s.begin(WINDOWS, vec(100, 50), 0);
        doubleCross(s, 0);
        s.beginRestore(100);
        assert(!s.settled(), 'settled while a crease was still retracting');
        const desc = s.tick(100 + DEFAULT_CONFIG.unfoldMs + 50);
        assertEqual(desc.map(w => w.state), [NORMAL, NORMAL]);
        assert(s.settled(), 'never settled');
    });

    it('unfolds a window that was pushed away entirely', () => {
        const s = new Session();
        s.begin(WINDOWS, vec(100, 50), 0);
        doubleCross(s, 0);
        /* Push until it is discarded. */
        let t = 60;
        for (let i = 0; i < 20 && stateOf(s.describe(), 'over') !== DISCARDED; i++) {
            t += 16;
            s.updatePointer(vec(140 - i * 8, 50), t);
        }
        assertEqual(stateOf(s.describe(), 'over'), DISCARDED);

        const desc = s.beginRestore(t + 16);
        /* A discarded window keeps the crease that took it away, so it has
         * something to unfold back along instead of simply reappearing. */
        assertEqual(stateOf(desc, 'over'), FOLDED);
        assert(lineOf(desc, 'over') !== null, 'nothing to unfold along');
        assertEqual(stateOf(s.tick(t + 16 + DEFAULT_CONFIG.unfoldMs + 50), 'over'), NORMAL);
    });

    it('ignores the pointer once the restore has started', () => {
        const s = new Session({ discardEnabled: false });
        s.begin(WINDOWS, vec(100, 50), 0);
        s.beginRestore(100);
        /* The same gesture that folds a window during the drag. */
        s.updatePointer(vec(100, 50), 116);
        s.updatePointer(vec(260, 50), 132);
        const desc = s.updatePointer(vec(150, 50), 148);
        assertEqual(desc.map(w => w.state), [NORMAL, NORMAL]);
    });

    it('drops a half-finished lift without animating it', () => {
        const s = new Session();
        s.begin(WINDOWS, vec(100, 50), 0);
        s.updatePointer(vec(100, 50), 0);
        s.updatePointer(vec(260, 50), 20);
        assertEqual(stateOf(s.describe(), 'over'), TRANSIENT);
        const desc = s.beginRestore(30);
        assertEqual(stateOf(desc, 'over'), NORMAL);
        assert(s.settled(), 'a dropped lift left the session unsettled');
    });
});

describe('session: the pause after the drop', () => {
    it('holds the folds exactly where they were', () => {
        const s = new Session({ discardEnabled: false });
        s.begin(WINDOWS, vec(100, 50), 0);
        const before = lineOf(doubleCross(s, 0), 'over');
        s.hold();
        const after = lineOf(s.tick(80), 'over');
        assertEqual(after, before);
        assertEqual(stateOf(s.describe(), 'over'), FOLDED);
    });

    it('arms nothing new once the drop has landed', () => {
        const s = new Session({ discardEnabled: false });
        s.begin(WINDOWS, vec(100, 50), 0);
        s.hold();
        /* The drop is over. Moving the pointer across a window's edge and back
         * must not fold it, however deliberate the gesture looks. */
        s.updatePointer(vec(100, 50), 16);
        s.updatePointer(vec(260, 50), 32);
        const desc = s.updatePointer(vec(150, 50), 48);
        assertEqual(desc.map(w => w.state), [NORMAL, NORMAL]);
    });

    it('still advances an animation that was already running', () => {
        const s = new Session();
        s.begin(WINDOWS, vec(100, 50), 0);
        s.updatePointer(vec(100, 50), 0);
        s.updatePointer(vec(260, 50), 20);   // a lift is in flight
        assertEqual(stateOf(s.describe(), 'over'), TRANSIENT);
        s.hold();
        /* The lift has to be allowed to fall back rather than freezing
         * half-raised for the rest of the pause. */
        assertEqual(stateOf(s.tick(20 + DEFAULT_CONFIG.transientTimeoutMs + 50), 'over'), NORMAL);
    });
});

describe('session: the restore always finishes', () => {
    it('settles from any state a random drag can leave behind', () => {
        /* A deterministic pseudo-random walk, so a failure is reproducible
         * from the seed alone. */
        let seed = 20260901;
        const rand = () => {
            seed = (seed * 1103515245 + 12345) & 0x7fffffff;
            return seed / 0x7fffffff;
        };
        const stack = [
            { id: 'a', rect: { x: 0, y: 0, width: 320, height: 240 } },
            { id: 'b', rect: { x: 80, y: 40, width: 300, height: 260 } },
            { id: 'c', rect: { x: 40, y: 100, width: 400, height: 200 } },
        ];
        for (let run = 0; run < 400; run++) {
            const s = new Session();
            let t = 0;
            s.begin(stack, vec(160, 120), t);
            for (let step = 0; step < 40; step++) {
                t += 16;
                s.updatePointer(vec(rand() * 520 - 60, rand() * 400 - 60), t);
                for (const w of s.describe()) {
                    assert(w.state !== FOLDED || w.line !== null,
                        `run ${run} step ${step}: ${w.id} folded with no crease`);
                }
            }
            s.hold();
            t += 16;
            s.beginRestore(t);
            /* However deep the folds were, they have to run out. A follower
             * left pointing at a leader that had already landed, or a crease
             * that never reached zero, would hang the drag here for good. */
            let ticks = 0;
            while (!s.settled() && ticks < 200) {
                t += 16;
                s.tick(t);
                ticks++;
            }
            assert(s.settled(), `run ${run} never settled after ${ticks} ticks`);
            for (const w of s.describe()) {
                assertEqual(w.state, NORMAL, `run ${run}: ${w.id} did not come back`);
                assertEqual(w.line, null, `run ${run}: ${w.id} kept a crease`);
            }
        }
    });
});

describe('session: a window thins out before it is discarded', () => {
    const fadeOf = (desc, id) => desc.find(w => w.id === id).fade;

    it('reports full strength for a window that is not folded', () => {
        const s = new Session();
        const desc = s.begin(WINDOWS, vec(100, 50), 0);
        assertEqual(desc.map(w => w.fade), [1, 1]);
    });

    it('thins the window out as the fold is pushed deeper', () => {
        const s = new Session();
        s.begin(WINDOWS, vec(100, 50), 0);
        doubleCross(s, 0);
        let t = 60;
        let last = 1;
        let sawPartial = false;
        for (let x = 150; x >= 0; x -= 5) {
            t += 16;
            const desc = s.updatePointer(vec(x, 50), t);
            if (stateOf(desc, 'over') !== FOLDED)
                break;
            const now = fadeOf(desc, 'over');
            assert(now <= last + 1e-9, `fade rose from ${last} to ${now} at x=${x}`);
            if (now > 0 && now < 1)
                sawPartial = true;
            last = now;
        }
        assert(sawPartial, 'the window never faded, it went straight from solid to gone');
        /* And by the point it is dropped it is already nearly invisible, which
         * is what stops the discard reading as a window blinking out. */
        assertEqual(stateOf(s.describe(), 'over'), DISCARDED);
        assert(last < 0.25, `still ${last} solid when it was discarded`);
    });

    it('stays solid all the way down when discarding is switched off', () => {
        const s = new Session({ discardEnabled: false });
        s.begin(WINDOWS, vec(100, 50), 0);
        doubleCross(s, 0);
        let t = 60;
        for (let x = 150; x >= 0; x -= 5)
            s.updatePointer(vec(x, 50), t += 16);
        /* Nothing is ever going to remove it, so fading it to nothing would
         * leave an invisible window sitting on screen. */
        assertEqual(fadeOf(s.describe(), 'over'), 1);
    });

    it('comes back to full strength as the fold unwinds', () => {
        const s = new Session();
        s.begin(WINDOWS, vec(100, 50), 0);
        doubleCross(s, 0);
        let t = 60;
        for (let x = 150; x >= 0; x -= 5)
            s.updatePointer(vec(x, 50), t += 16);
        assertEqual(stateOf(s.describe(), 'over'), DISCARDED);
        s.hold();
        s.beginRestore(t += 16);
        assert(fadeOf(s.describe(), 'over') < 0.25, 'revived at full strength');
        const done = s.tick(t + DEFAULT_CONFIG.restoreMs + 50);
        assertEqual(stateOf(done, 'over'), NORMAL);
        assertEqual(fadeOf(done, 'over'), 1);
    });
});

describe('session: stacking order is fixed for the whole drag', () => {
    it('never reorders the windows it was given, whatever the drag does', () => {
        const stack = [
            { id: 'a', rect: { x: 0, y: 0, width: 320, height: 240 } },
            { id: 'b', rect: { x: 80, y: 40, width: 300, height: 260 } },
            { id: 'c', rect: { x: 40, y: 100, width: 400, height: 200 } },
        ];
        const expected = ['a', 'b', 'c'];
        let seed = 4242;
        const rand = () => {
            seed = (seed * 1103515245 + 12345) & 0x7fffffff;
            return seed / 0x7fffffff;
        };
        const s = new Session();
        let t = 0;
        assertEqual(s.begin(stack, vec(160, 120), t).map(w => w.id), expected);
        /* Folding, cascading, discarding and unfolding all leave the order
         * alone: it is the drawing order the renderer stacks the clones by, so
         * a window that changed places here would look like it had raised
         * itself over its neighbours. */
        for (let i = 0; i < 300; i++) {
            t += 16;
            assertEqual(s.updatePointer(vec(rand() * 520 - 60, rand() * 400 - 60), t)
                .map(w => w.id), expected, `order changed at step ${i}`);
        }
        s.hold();
        assertEqual(s.describe().map(w => w.id), expected);
        s.beginRestore(t += 16);
        for (let i = 0; i < 60; i++)
            assertEqual(s.tick(t += 16).map(w => w.id), expected,
                `order changed while restoring, step ${i}`);
    });

    it('keeps the rest in order when a window goes away mid-drag', () => {
        const s = new Session();
        s.begin([
            { id: 'a', rect: { x: 0, y: 0, width: 200, height: 200 } },
            { id: 'b', rect: { x: 0, y: 0, width: 200, height: 200 } },
            { id: 'c', rect: { x: 0, y: 0, width: 200, height: 200 } },
        ], vec(100, 100), 0);
        s.removeWindow('b');
        assertEqual(s.describe().map(w => w.id), ['a', 'c']);
    });
});

/* Folding a window is only half of the technique: the drop has to land on the
 * window underneath, and the part still lying flat has to go on taking drops
 * itself. The description says which of the two the pointer is over, as a
 * boolean rather than a region, because that is all the renderer can act on —
 * Clutter picks whole actors, and the pointer is the only place the question
 * is ever asked. */
describe('session: what still takes the pointer', () => {
    const takesPointer = (desc, id) => desc.find(w => w.id === id).acceptsPointer;

    /* A small window resting on a large one. Leaving the small one never
     * leaves the large one, so only the window on top ever folds and the one
     * underneath is there to catch the drop. */
    const RESTING = [
        { id: 'under', rect: { x: 0, y: 0, width: 400, height: 300 } },
        { id: 'over', rect: { x: 0, y: 0, width: 200, height: 100 } },
    ];

    /* Out through `over`'s right edge and straight back in. */
    function foldOver(s) {
        s.updatePointer(vec(100, 50), 0);
        s.updatePointer(vec(260, 50), 20);
        return s.updatePointer(vec(150, 50), 60);
    }

    it('leaves an unfolded window taking the pointer', () => {
        const s = new Session();
        const desc = s.begin(WINDOWS, vec(100, 50), 0);
        assertEqual(desc.map(w => w.acceptsPointer), [true, true]);
    });

    it('leaves a lifted corner taking the pointer, since it is only a preview', () => {
        const s = new Session();
        s.begin(RESTING, vec(100, 50), 0);
        s.updatePointer(vec(100, 50), 0);
        const desc = s.updatePointer(vec(260, 50), 20);
        assertEqual(stateOf(desc, 'over'), TRANSIENT);
        assert(takesPointer(desc, 'over'), 'a lift must not redirect the drop');
    });

    it('takes it away where the fold has swallowed the window', () => {
        const s = new Session();
        s.begin(RESTING, vec(100, 50), 0);
        const desc = foldOver(s);
        assertEqual(stateOf(desc, 'over'), FOLDED);
        /* The crease is anchored just behind the pointer, so the pointer is
         * over the folded-away side. This is the redirection the whole
         * technique exists for. */
        assert(!takesPointer(desc, 'over'), 'the folded-away side belongs to the window below');
        assert(takesPointer(desc, 'under'), 'which has to be there to catch it');
    });

    it('keeps it on the part still lying flat', () => {
        const s = new Session();
        s.begin(RESTING, vec(100, 50), 0);
        foldOver(s);
        /* Around the crease rather than through it — crossing it would push
         * the fold — and back into the part of `over` still lying flat. */
        s.updatePointer(vec(150, 150), 80);
        s.updatePointer(vec(20, 150), 100);
        const desc = s.updatePointer(vec(20, 50), 120);
        assertEqual(stateOf(desc, 'over'), FOLDED);
        assert(takesPointer(desc, 'over'), 'the flat part is still the window');
    });

    it('takes it away from a window the fold swallowed entirely', () => {
        const s = new Session();
        s.begin(WINDOWS, vec(100, 50), 0);
        doubleCross(s, 0);
        let desc = s.describe();
        let t = 100;
        for (let x = 140; x >= 0 && stateOf(desc, 'over') !== DISCARDED; x -= 10)
            desc = s.updatePointer(vec(x, 50), t += 20);
        assertEqual(stateOf(desc, 'over'), DISCARDED);
        assert(!takesPointer(desc, 'over'), 'a window that is gone takes nothing');
    });
});
