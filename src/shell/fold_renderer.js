/*
 * Fold n' Drop for GNOME Shell — GPL-3.0-or-later
 *
 * Draws what the core describes.
 *
 *   TRANSIENT — effect on the real actor, which stays visible and reactive.
 *               It is only a preview; the window must still accept a drop.
 *   FOLDED    — real actor hidden, a clone drawn in our overlay. Hiding the
 *               actor takes it out of Clutter picking, so the pointer and the
 *               drop fall through to the window underneath. That is the whole
 *               mechanism.
 *   DISCARDED — clone faded out, real actor still hidden.
 *
 * The one way this file can do lasting harm is leaving a real actor hidden,
 * so every hidden actor goes in _hidden and restoreAll() is idempotent.
 */
'use strict';

import Clutter from 'gi://Clutter';

import { FoldEffect } from './fold_effect.js';
import { NORMAL, TRANSIENT, FOLDED, DISCARDED, foldPaintBounds } from '../core/fold.js';

const EFFECT_NAME = 'foldndrop-fold';
const MIN_PADDING = 8;
/* A box blur of radius r reaches r out from the silhouette; the shadow is also
 * dropped downward by a share of the radius. Padding by this much times the
 * radius keeps the whole soft edge inside the container. */
const SHADOW_REACH = 1.5;

export class FoldRenderer {
    constructor(settings) {
        this._settings = settings;
        this._overlay = null;
        this._entries = new Map();   // id -> {actor, container, clone, effect, mode}
        this._hidden = new Set();
        this._pendingDone = null;
    }

    begin(windows) {
        this.restoreAll();
        this._overlay = new Clutter.Actor({ reactive: false });
        global.window_group.add_child(this._overlay);
        for (const win of windows)
            this._entries.set(win.id, {
                actor: win.actor,
                container: null, clone: null, effect: null,
                mode: NORMAL,
            });
    }

    sync(description) {
        if (!this._overlay)
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
    }

    _toNormal(entry) {
        this._dropClone(entry);
        this._dropInPlaceEffect(entry);
        this._show(entry.actor);
        entry.mode = NORMAL;
    }

    _toInPlace(entry, win) {
        this._dropClone(entry);
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
        this._hide(entry.actor);

        const [aw, ah] = entry.actor.get_size();
        const [ax, ay] = entry.actor.get_position();
        const look = this._appearance(entry);

        /* The container has to hold the actor AND everything the fold paints
         * outside it: the flap, and the blurred shadow it casts. The core
         * works that box out exactly.
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
            this._overlay.add_child(entry.container);
            entry.effect = new FoldEffect();
            entry.container.add_effect_with_name(EFFECT_NAME, entry.effect);
        }

        entry.container.set_position(cx, cy);
        entry.container.set_size(cw, ch);
        entry.clone.set_position(ax - cx, ay - cy);
        entry.clone.set_size(aw, ah);
        if (wasDiscarded) {
            /* Coming back from having been pushed away entirely. Fade it in
             * under the unfold rather than letting it snap to full opacity. */
            entry.container.remove_all_transitions();
            entry.container.ease({
                opacity: 255,
                duration: this._settings.discardFadeMs,
                mode: Clutter.AnimationMode.EASE_OUT_QUAD,
            });
        } else if (entry.mode !== FOLDED) {
            entry.container.opacity = 255;
        }

        entry.effect.setFold({
            size: { width: cw, height: ch },
            /* The content box is the window's frame, not the actor's box; see
             * the comment in _toInPlace for why. */
            contentOrigin: { x: win.rect.x - cx, y: win.rect.y - cy },
            contentSize: { width: win.rect.width, height: win.rect.height },
            line: this._toLocal(win.line, cx, cy),
            ...look,
        });

        entry.mode = FOLDED;
    }

    _toDiscarded(entry) {
        this._hide(entry.actor);
        if (entry.container && entry.mode !== DISCARDED) {
            entry.container.ease({
                opacity: 0,
                duration: this._settings.discardFadeMs,
                mode: Clutter.AnimationMode.EASE_OUT_QUAD,
            });
        }
        entry.mode = DISCARDED;
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
        this._dropClone(entry);
        this._dropInPlaceEffect(entry);
        /* The window is gone, so forget its actor rather than trying to
         * restore it later. removeWindow is called when a window is
         * unmanaged; a later restoreAll() calling show() on a destroyed actor
         * would warn or throw. */
        this._hidden.delete(entry.actor);
        this._entries.delete(id);
    }

    restoreAll() {
        for (const entry of this._entries.values()) {
            this._dropClone(entry);
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
        if (this._overlay) {
            this._overlay.destroy();
            this._overlay = null;
        }
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

    _hide(actor) {
        if (this._hidden.has(actor))
            return;
        this._hidden.add(actor);
        actor.hide();
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

    _dropClone(entry) {
        if (!entry.container)
            return;
        entry.container.remove_all_transitions();
        entry.container.destroy();
        entry.container = null;
        entry.clone = null;
        entry.effect = null;
    }

    _dropInPlaceEffect(entry) {
        if (entry.mode !== TRANSIENT)
            return;
        if (entry.actor)
            entry.actor.remove_effect_by_name(EFFECT_NAME);
        entry.effect = null;
    }

}
