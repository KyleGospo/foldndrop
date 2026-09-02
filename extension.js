/*
 * Fold n' Drop for GNOME Shell — GPL-3.0-or-later
 *
 * Implements Pierre Dragicevic's fold-and-drop technique (UIST '04):
 * quickly crossing a window's boundary back and forth while dragging folds
 * it out of the way, so the drop lands on a window underneath.
 *
 * Wayland only. On X11 the X server routes input directly to windows using
 * their input shapes, so hiding a folded window's actor would not redirect
 * the drop and the technique would silently do the wrong thing.
 */
'use strict';

import GLib from 'gi://GLib';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import { Extension } from 'resource:///org/gnome/shell/extensions/extension.js';

import { Session } from './src/core/session.js';
import { Settings } from './src/shell/settings.js';
import { DndMonitor } from './src/shell/dnd_monitor.js';
import { PointerSource } from './src/shell/pointer_source.js';
import { FoldRenderer } from './src/shell/fold_renderer.js';
import { participatingWindows, WindowWatcher } from './src/shell/window_source.js';

export default class FoldNDropExtension extends Extension {
    enable() {
        /* GNOME 50 removed the X11 session, and Mutter 18 removed
         * Meta.is_wayland_compositor() along with it. Ask the context for its
         * Wayland compositor instead: null means an X11 session, where the X
         * server routes input straight to windows and hiding an actor would
         * not redirect the drop. */
        if (!global.context?.get_wayland_compositor?.()) {
            console.log('[foldndrop] No Wayland compositor; fold-and-drop cannot redirect drops on X11. Doing nothing.');
            return;
        }

        this._settings = new Settings(this.getSettings());
        this._session = null;
        this._holdTimer = null;
        this._renderer = new FoldRenderer(this._settings);

        this._pointer = new PointerSource({
            onPoint: (point, timeMs) => this._onPoint(point, timeMs),
        });

        this._watcher = new WindowWatcher({
            onRemoved: id => {
                this._session?.removeWindow(id);
                this._renderer.removeWindow(id);
            },
        });
        this._watcher.enable();

        this._dnd = new DndMonitor({
            onStart: () => this._startSession(),
            onEnd: () => this._endSession(),
        });
        this._dnd.enable();

        /* Anything that invalidates the snapshot aborts the session. */
        this._abortIds = [
            [global.workspace_manager, global.workspace_manager.connect('active-workspace-changed', () => this._abort())],
            [Main.overview, Main.overview.connect('showing', () => this._abort())],
            [Main.layoutManager, Main.layoutManager.connect('monitors-changed', () => this._abort())],
        ];
    }

    _startSession() {
        /* A new drag while the last one is still unfolding: the hold timer and
         * the restore both belong to a session that is about to be replaced.
         * renderer.begin() cuts the old drawing short; this cuts its clock. */
        this._clearHold();
        const windows = participatingWindows();
        if (windows.length === 0)
            return;
        this._session = new Session(this._settings.config);
        this._windows = windows;
        /* The first onPoint call seeds the session's starting position. */
        this._seeded = false;
        this._renderer.begin(windows);

        /* Must come last: PointerSource.enable() emits a point synchronously,
         * which re-enters _onPoint, so every field _onPoint reads has to be
         * populated before this line. */
        this._pointer.enable();
    }

    _onPoint(point, timeMs) {
        if (!this._session)
            return;
        if (!this._seeded) {
            this._seeded = true;
            this._renderer.sync(this._session.begin(this._windows, point, timeMs));
            return;
        }
        this._renderer.sync(this._session.updatePointer(point, timeMs));
        /* The restore runs on the same tick as the drag did, so the creases
         * retract through exactly the same code that drew them. When the last
         * one runs out there is nothing left to animate and the session can be
         * let go. */
        if (this._session.restoring && this._session.settled())
            this._finishSession();
    }

    /* The drop has landed. Hold the folded arrangement briefly so the result
     * of the drop is visible, then unfold everything.
     *
     * The pointer source keeps running throughout: it is what advances the
     * unfold animations. Stopping it here is what used to leave the windows
     * with no way back except appearing. */
    _endSession() {
        if (!this._session)
            return;
        this._session.hold();
        this._clearHold();
        this._holdTimer = GLib.timeout_add(GLib.PRIORITY_DEFAULT,
            this._settings.postDropPauseMs, () => {
                this._holdTimer = null;
                if (this._session)
                    this._renderer.sync(this._session.beginRestore(this._now()));
                return GLib.SOURCE_REMOVE;
            });
    }

    _finishSession() {
        this._clearHold();
        this._pointer?.disable();
        this._session = null;
        this._windows = null;
        this._renderer.finish(() => {});
    }

    /* The same clock the pointer source stamps its samples with, so a restore
     * started from a timer lines up with the ticks that will advance it. */
    _now() {
        return GLib.get_monotonic_time() / 1000;
    }

    _clearHold() {
        if (this._holdTimer) {
            GLib.Source.remove(this._holdTimer);
            this._holdTimer = null;
        }
    }

    /* Abort differs from end: no pause, no unfolding, just put everything
     * back. The snapshot the session was built on no longer describes the
     * screen, so animating out of it would animate out of the wrong place. */
    _abort() {
        if (!this._session && !this._renderer)
            return;
        this._clearHold();
        this._pointer?.disable();
        this._session = null;
        this._windows = null;
        this._renderer?.restoreAll();
    }

    disable() {
        this._abort();
        this._clearHold();
        if (this._dnd) {
            this._dnd.disable();
            this._dnd = null;
        }
        if (this._watcher) {
            this._watcher.disable();
            this._watcher = null;
        }
        if (this._pointer) {
            this._pointer.disable();
            this._pointer = null;
        }
        for (const [object, id] of this._abortIds ?? [])
            object.disconnect(id);
        this._abortIds = null;
        if (this._renderer) {
            this._renderer.destroy();
            this._renderer = null;
        }
        if (this._settings) {
            this._settings.destroy();
            this._settings = null;
        }
        this._session = null;
    }
}
