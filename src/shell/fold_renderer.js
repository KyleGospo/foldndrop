/*
 * Fold n' Drop for GNOME Shell — GPL-3.0-or-later
 *
 * Draws what the core describes.
 *
 * Every clone is stacked directly over the window actor it came from, so the
 * drawing order is the desktop's own stacking order. Parking them all in one
 * overlay on top of window_group instead put a folded window above windows
 * that were stacked over it, which looks exactly like the window raising
 * itself, and made clone-versus-clone order depend on which was folded first.
 *
 * A fold is drawn in two layers, because the two halves of a folded sheet do
 * not stay in the same place in the stack:
 *
 *   the sheet — the window's own pixels, cut off at the crease. Drawn by a
 *               clone directly over the window actor, as above.
 *   the flap  — the back of the sheet, and the shadow it casts. Folding turns
 *               the folded part of a stack over, so the flaps end up in the
 *               opposite order to the windows they came off, piled on top of
 *               every sheet: see flapPaintOrder(). Drawing a flap with its own
 *               window instead put the flap of an upper window over the flap
 *               of the window below it, which is not what happens when you
 *               fold two sheets of paper together.
 *
 *   TRANSIENT — effect on the real actor, which stays visible and reactive.
 *               It is only a preview; the window must still accept a drop, and
 *               a lifted corner is one window's alone, so it draws both layers
 *               in place with no clone and no reordering.
 *   FOLDED    — the two layers above draw the fold; the real actor is left in
 *               place at zero opacity so that it goes on being what Clutter
 *               picks. Only where the pointer is over the folded-away part is
 *               it taken out of the pick, and then the drop falls through to
 *               the window underneath. That is the whole mechanism.
 *   DISCARDED — both layers faded out, real actor gone from the pick entirely.
 *
 * The two ways this file can do lasting harm are leaving a real actor hidden
 * and leaving one transparent, so every actor it hides goes in _hidden, every
 * actor it dims goes in _dimmed, and restoreAll() is idempotent.
 */
'use strict';

import Clutter from 'gi://Clutter';

import { FoldEffect, FOLD_SURFACE, FOLD_FLAP } from './fold_effect.js';
import { NORMAL, TRANSIENT, FOLDED, DISCARDED, foldPaintBounds } from '../core/fold.js';
import { flapPaintOrder } from '../core/coherency.js';

const EFFECT_NAME = 'foldndrop-fold';
const MIN_PADDING = 8;
/* A box blur of radius r reaches r out from the silhouette; the shadow is also
 * dropped downward by a share of the radius. Padding by this much times the
 * radius keeps the whole soft edge inside the container. */
const SHADOW_REACH = 1.5;

export class FoldRenderer {
    constructor(settings) {
        this._settings = settings;
        /* A drag is in progress and sync() has windows to draw. */
        this._active = false;
        // id -> {actor, container, clone, effect, flap, flapEffect, mode}
        this._entries = new Map();
        this._hidden = new Set();
        this._dimmed = new Map();    // actor -> the opacity it had before we dimmed it
        this._pendingDone = null;
    }

    begin(windows) {
        this.restoreAll();
        this._active = true;
        for (const win of windows)
            this._entries.set(win.id, {
                actor: win.actor,
                container: null, clone: null, effect: null,
                flap: null, flapEffect: null,
                mode: NORMAL,
            });
    }

    sync(description) {
        if (!this._active)
            return;
        for (const win of description) {
            const entry = this._entries.get(win.id);
            if (!entry)
                continue;
            switch (win.state) {
            case NORMAL:
                this._toNormal(entry);
                break;
            case TRANSIENT:
                this._toInPlace(entry, win);
                break;
            case FOLDED:
                this._toCloned(entry, win);
                break;
            case DISCARDED:
                this._toDiscarded(entry);
                break;
            }
        }
        /* After the loop, not inside it: where a flap belongs depends on every
         * other window's state, so there is nothing to order until they have
         * all been brought up to date. */
        this._restackFlaps(description);
    }

    _toNormal(entry) {
        this._dropLayers(entry);
        this._dropInPlaceEffect(entry);
        this._undim(entry.actor);
        this._show(entry.actor);
        entry.mode = NORMAL;
    }

    _toInPlace(entry, win) {
        this._dropLayers(entry);
        this._undim(entry.actor);
        this._show(entry.actor);
        if (!entry.effect || entry.mode !== TRANSIENT) {
            entry.actor.remove_effect_by_name(EFFECT_NAME);
            entry.effect = new FoldEffect();
            entry.actor.add_effect_with_name(EFFECT_NAME, entry.effect);
        }
        const [ax, ay] = entry.actor.get_position();
        const [aw, ah] = entry.actor.get_size();
        entry.effect.setFold({
            size: { width: aw, height: ah },
            /* The content box is the window's frame, not the actor's box. On
             * client-side-decorated windows the actor carries an invisible
             * shadow margin; treating that as content mirrors the flap out
             * over empty pixels and rims it with a transparent band. */
            contentOrigin: { x: win.rect.x - ax, y: win.rect.y - ay },
            contentSize: { width: win.rect.width, height: win.rect.height },
            line: this._toLocal(win.line, ax, ay),
            fade: win.fade ?? 1,
            ...this._appearance(entry),
        });
        entry.mode = TRANSIENT;
    }

    _toCloned(entry, win) {
        /* FOLDED promises a crease; the core keeps that promise. Belt and
         * braces all the same, because the cost of a broken promise here is
         * out of all proportion to it: everything below dereferences the
         * crease, and a throw inside sync() abandons every window still left
         * in the loop, freezing the whole drag rather than just this fold. */
        if (!win.line) {
            this._toNormal(entry);
            return;
        }
        this._dropInPlaceEffect(entry);
        const wasDiscarded = entry.mode === DISCARDED;
        this._dim(entry.actor);
        this._setPickable(entry, win.acceptsPointer);

        const [aw, ah] = entry.actor.get_size();
        const [ax, ay] = entry.actor.get_position();
        const look = this._appearance(entry);

        /* Both layers get the same box, and it is the box the whole fold
         * paints in: the window, the flap, and the blurred shadow. The core
         * works it out exactly.
         *
         * Identical is the point. Clutter renders an effect's actor to an
         * offscreen texture a few pixels larger than the actor, and the
         * shader's only handle on where it is drawing is a texture coordinate
         * across that texture — so actor-local pixels come out a pixel or two
         * off, harmlessly, as long as everything drawn together is off by the
         * same amount. Two boxes of different sizes are off by different
         * amounts, which would leave the flap hinged a pixel or two away from
         * the crease the sheet is cut along, with a seam between them.
         *
         * The old bound measured how far the flap reached along the crease
         * normal, which is not the same question. The displacement is along
         * the normal but the window is a rectangle, so a corner only just
         * behind the crease still gets thrown a long way past the window's own
         * edge — a diagonal fold across a 900x600 window put the flap 160px
         * below a container that had been padded by eight. That is what cut
         * the fold off at the bottom of the window. */
        const paint = foldPaintBounds(win.rect, win.line, look.flapScale,
            look.shadowBlur * SHADOW_REACH + MIN_PADDING);
        const cx = Math.floor(Math.min(ax, paint.x));
        const cy = Math.floor(Math.min(ay, paint.y));
        const cw = Math.ceil(Math.max(ax + aw, paint.x + paint.width)) - cx;
        const ch = Math.ceil(Math.max(ay + ah, paint.y + paint.height)) - cy;

        if (!entry.container) {
            entry.container = new Clutter.Actor({ reactive: false });
            entry.clone = new Clutter.Clone({ source: entry.actor, reactive: false });
            entry.container.add_child(entry.clone);
            entry.effect = new FoldEffect();
            entry.container.add_effect_with_name(EFFECT_NAME, entry.effect);
            /* Without this the clone's own paint volume, not the box set
             * below, is what decides how big the offscreen texture is — and
             * then the sheet and the flap are being drawn through two
             * different mappings again. Clipping to the allocation pins it to
             * the box, which is what both layers agree on. */
            entry.container.set_clip_to_allocation(true);

            /* The flap gets an actor of its own so that it can be stacked
             * apart from the window it came off — that is the whole reason
             * there are two layers. It carries no clone: the back of a sheet
             * is blank, so the flap and its shadow are drawn from the crease
             * and the window's outline alone, with nothing for the shader to
             * sample. An actor with nothing in it still gets an offscreen
             * texture the size of its box, which is all the shader needs. */
            entry.flap = new Clutter.Actor({ reactive: false });
            entry.flapEffect = new FoldEffect();
            entry.flap.add_effect_with_name(EFFECT_NAME, entry.flapEffect);
            entry.flap.set_clip_to_allocation(true);
        }
        this._restack(entry);

        for (const layer of this._layers(entry)) {
            layer.set_position(cx, cy);
            layer.set_size(cw, ch);
        }
        entry.clone.set_position(ax - cx, ay - cy);
        entry.clone.set_size(aw, ah);

        if (wasDiscarded) {
            /* Coming back from having been pushed away entirely. Fade it in
             * under the unfold rather than letting it snap to full opacity. */
            for (const layer of this._layers(entry)) {
                layer.remove_all_transitions();
                layer.ease({
                    opacity: 255,
                    duration: this._settings.discardFadeMs,
                    mode: Clutter.AnimationMode.EASE_OUT_QUAD,
                });
            }
        } else if (entry.mode !== FOLDED) {
            for (const layer of this._layers(entry))
                layer.opacity = 255;
        }

        /* One fold, drawn twice: the same geometry, split only by which
         * layers each pass is allowed to put on screen. */
        const fold = {
            size: { width: cw, height: ch },
            /* The content box is the window's frame, not the actor's box. On
             * client-side-decorated windows the actor carries an invisible
             * shadow margin; treating that as content mirrors the flap out
             * over empty pixels and rims it with a transparent band. */
            contentOrigin: { x: win.rect.x - cx, y: win.rect.y - cy },
            contentSize: { width: win.rect.width, height: win.rect.height },
            line: this._toLocal(win.line, cx, cy),
            /* Thins out as the fold swallows the window, so it is nearly gone
             * by the time it is discarded rather than blinking out solid. */
            fade: win.fade ?? 1,
            ...look,
        };
        entry.effect.setFold({ ...fold, layers: FOLD_SURFACE });
        entry.flapEffect.setFold({ ...fold, layers: FOLD_FLAP });

        entry.mode = FOLDED;
    }

    _toDiscarded(entry) {
        this._dim(entry.actor);
        this._hide(entry.actor);
        if (entry.mode !== DISCARDED) {
            for (const layer of this._layers(entry)) {
                layer.ease({
                    opacity: 0,
                    duration: this._settings.discardFadeMs,
                    mode: Clutter.AnimationMode.EASE_OUT_QUAD,
                });
            }
        }
        entry.mode = DISCARDED;
    }

    /* The two actors a folded window is drawn with, in whatever order they
     * happen to exist. Everything that treats a fold as one thing — fading it
     * out, bringing it back — goes through here, so neither half can be left
     * behind at the wrong opacity. */
    _layers(entry) {
        const out = [];
        if (entry.container)
            out.push(entry.container);
        if (entry.flap)
            out.push(entry.flap);
        return out;
    }

    /* Pile the flaps up over the sheets, in the order folding leaves them in.
     *
     * The core decides the order (flapPaintOrder); this puts the actors in it.
     * The pile is anchored to the topmost folded window's own sheet rather
     * than to the top of the screen: a window the fold never reached is still
     * lying over all of this, and lifting a flap through it would look like
     * the window underneath raising itself — the very thing keeping each
     * clone with its own actor is there to avoid.
     *
     * Re-checked every frame, for the same reason _restack is: the flaps have
     * to move when the stack does. The comparisons are what make that cheap. */
    _restackFlaps(description) {
        const ids = flapPaintOrder(description)
            .filter(id => this._entries.get(id)?.flap);
        if (ids.length === 0)
            return;
        /* flapPaintOrder hands back the bottom of the pile first, which is the
         * topmost window's flap — so the first entry is also the one whose
         * sheet the whole pile rests on. */
        const anchor = this._entries.get(ids[0]).container;
        const parent = anchor?.get_parent();
        if (!parent)
            return;
        let below = anchor;
        for (const id of ids) {
            const flap = this._entries.get(id).flap;
            if (flap.get_parent() !== parent) {
                flap.get_parent()?.remove_child(flap);
                parent.add_child(flap);
            }
            if (flap.get_previous_sibling() !== below)
                parent.set_child_above_sibling(flap, below);
            below = flap;
        }
    }

    /* Keep the sheet immediately above the window actor it stands in for, so a
     * folded window draws exactly where the real one would have.
     *
     * Re-checked every frame rather than set once: Mutter reorders
     * window_group whenever the real stack changes, and it has no reason to
     * keep a foreign actor of ours in place when it does. The comparison is
     * what makes that cheap — restacking unconditionally would queue a
     * relayout for every folded window on every frame. */
    _restack(entry) {
        /* The actor's own parent, not window_group by name: a window the user
         * has set to stay on top lives in top_window_group instead, and a
         * clone left behind in window_group would be drawn under everything it
         * is supposed to be part of. */
        const parent = entry.actor.get_parent();
        if (!parent)
            return;
        if (entry.container.get_parent() !== parent) {
            entry.container.get_parent()?.remove_child(entry.container);
            parent.add_child(entry.container);
        }
        if (entry.container.get_previous_sibling() !== entry.actor)
            parent.set_child_above_sibling(entry.container, entry.actor);
    }

    /* Everything about how a fold looks rather than where it is. Shared so a
     * lifted corner and a folded window cannot drift apart. */
    _appearance(entry) {
        return {
            shading: this._settings.shadingStrength,
            flapScale: this._settings.flapScale,
            panel: this._settings.flapPanel,
            border: this._settings.flapBorder,
            shadowAlpha: this._settings.shadowAlpha,
            shadowBlur: this._settings.shadowBlurPx,
            cornerRadius: this._cornerRadius(entry),
        };
    }

    /* The flap is the back of the same sheet, so it wants the window's own
     * corners. Mutter squares a window off when it is maximized, tiled or
     * fullscreen, and so must the flap. */
    _cornerRadius(entry) {
        const radius = this._settings.cornerRadiusPx;
        const win = entry?.actor?.meta_window;
        if (!win)
            return radius;
        if (win.is_fullscreen?.())
            return 0;
        /* get_maximized() returns flags; any of them squares the window. */
        if (win.get_maximized?.())
            return 0;
        return radius;
    }

    /* Core fold lines are in screen coordinates; effects work in actor-local
     * pixels. Only the point moves — the normal is direction-only. */
    _toLocal(line, originX, originY) {
        if (!line)
            return null;
        return {
            point: { x: line.point.x - originX, y: line.point.y - originY },
            normal: line.normal,
        };
    }

    /* The drag is over and every crease has retracted to the corner it cut.
     *
     * There is nothing to fade: sync() has already walked each window back to
     * NORMAL as its crease ran out, which drops the clone and shows the real
     * actor at the moment the fold stops existing. This just releases whatever
     * is left. The old spring-back crossfaded the clones away instead, which
     * is why a folded window came back by appearing rather than by unfolding.
     */
    finish(onDone) {
        this._pendingDone = onDone ?? null;
        this.restoreAll();
    }

    removeWindow(id) {
        const entry = this._entries.get(id);
        if (!entry)
            return;
        this._dropLayers(entry);
        this._dropInPlaceEffect(entry);
        /* The window is gone, so forget its actor rather than trying to
         * restore it later. removeWindow is called when a window is
         * unmanaged; a later restoreAll() calling show() on a destroyed actor
         * would warn or throw. */
        this._hidden.delete(entry.actor);
        this._dimmed.delete(entry.actor);
        this._entries.delete(id);
    }

    restoreAll() {
        for (const entry of this._entries.values()) {
            this._dropLayers(entry);
            this._dropInPlaceEffect(entry);
        }
        this._entries.clear();
        /* Go through _show() rather than calling show() directly: it re-checks
         * that the window still wants to be on screen. restoreAll() is the
         * abort path, so this is exactly where a window minimized mid-drag
         * would otherwise be un-hidden. Iterate a copy, since _show() deletes
         * from _hidden as it goes. */
        for (const actor of [...this._hidden])
            this._show(actor);
        this._hidden.clear();
        /* Unconditionally, unlike the showing above: a window that has been
         * minimized mid-drag is one we must not show, but it is emphatically
         * still one we must not leave invisible when it is unminimized. */
        for (const actor of [...this._dimmed.keys()])
            this._undim(actor);
        this._dimmed.clear();
        this._active = false;
        /* Whichever path completed the cleanup owns firing onDone, so it fires
         * exactly once whether the spring-back ran to completion or was cut
         * short by begin()/destroy(). */
        const done = this._pendingDone;
        this._pendingDone = null;
        if (done)
            done();
    }

    destroy() {
        this.restoreAll();
        this._settings = null;
    }

    /* Which side of the crease the pointer is on decides whether a folded
     * window is still the thing under it.
     *
     * Clutter picks whole actors, so a fold cannot be handed to it as a
     * region — but it does not have to be. The only place anything ever asks
     * is under the pointer, and the core has already answered for exactly
     * that point. So the actor stays in the pick while the pointer is over
     * the part of the window still lying flat, which is what lets that part
     * go on taking drops, and drops out of it over the part that has been
     * folded away, which is what sends the drop to the window underneath.
     *
     * Hiding is the only lever there is: reactivity would have to be set on
     * every surface actor Mutter has nested inside the window actor, and it
     * puts them there and takes them away as the client pleases. */
    _setPickable(entry, pickable) {
        if (pickable)
            this._show(entry.actor);
        else
            this._hide(entry.actor);
    }

    _hide(actor) {
        if (this._hidden.has(actor))
            return;
        this._hidden.add(actor);
        actor.hide();
    }

    /* Out of the picture without being out of the pick.
     *
     * A folded window is drawn by its clone, so the real actor must not paint
     * — but hiding it, which is the obvious way to arrange that, is precisely
     * what took the window out of Clutter's picking altogether and left even
     * the part still lying flat unable to take a drop. Zero opacity does the
     * first without the second: Clutter.Clone paints its source through an
     * opacity override, so the clone still comes out solid, and Mutter only
     * lets a window occlude what is under it while its paint opacity is full,
     * so the windows the fold reveals go on drawing. */
    _dim(actor) {
        if (this._dimmed.has(actor))
            return;
        this._dimmed.set(actor, actor.opacity);
        actor.opacity = 0;
    }

    _undim(actor) {
        if (!this._dimmed.has(actor))
            return;
        actor.opacity = this._dimmed.get(actor);
        this._dimmed.delete(actor);
    }

    /* Restore only what we hid, and only if the window still wants to be on
     * screen. A window minimized mid-drag was hidden by Mutter, not by us;
     * showing it again would leave a minimized window visible after the drag
     * and break the promise that the desktop is unchanged afterwards.
     * window_manager's 'destroy' does not fire for minimize, so this check is
     * the only thing covering that case. */
    _show(actor) {
        if (!this._hidden.has(actor))
            return;
        this._hidden.delete(actor);
        const win = actor.meta_window;
        if (win && (win.minimized || !win.showing_on_its_workspace()))
            return;
        actor.show();
    }

    /* Let go of both halves of a fold at once. There is no state in which one
     * of them should outlive the other: the flap is the back of the sheet. */
    _dropLayers(entry) {
        for (const layer of this._layers(entry)) {
            layer.remove_all_transitions();
            layer.destroy();
        }
        entry.container = null;
        entry.clone = null;
        entry.effect = null;
        entry.flap = null;
        entry.flapEffect = null;
    }

    _dropInPlaceEffect(entry) {
        if (entry.mode !== TRANSIENT)
            return;
        if (entry.actor)
            entry.actor.remove_effect_by_name(EFFECT_NAME);
        entry.effect = null;
    }

}
