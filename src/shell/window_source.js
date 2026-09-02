/*
 * Fold n' Drop for GNOME Shell — GPL-3.0-or-later
 *
 * Turns Mutter's window actors into the plain {id, rect} records the core
 * understands, in bottom-to-top stacking order.
 */
'use strict';

import Meta from 'gi://Meta';

function rectOf(metaWindow) {
    const frame = metaWindow.get_frame_rect();
    return { x: frame.x, y: frame.y, width: frame.width, height: frame.height };
}

export function participatingWindows() {
    const workspace = global.workspace_manager.get_active_workspace();
    /* global.get_window_actors() is already bottom-to-top. */
    return global.get_window_actors()
        .filter(actor => {
            const win = actor.meta_window;
            if (!win)
                return false;
            if (win.get_window_type() !== Meta.WindowType.NORMAL)
                return false;
            if (win.minimized)
                return false;
            if (!win.located_on_workspace(workspace))
                return false;
            if (!actor.visible)
                return false;
            const rect = rectOf(win);
            return rect.width > 0 && rect.height > 0;
        })
        .map(actor => ({
            id: actor.meta_window.get_id(),
            actor,
            rect: rectOf(actor.meta_window),
        }));
}

export class WindowWatcher {
    constructor({ onRemoved }) {
        this._onRemoved = onRemoved;
        this._id = null;
    }

    enable() {
        this._id = global.window_manager.connect('destroy', (wm, actor) => {
            if (actor && actor.meta_window)
                this._onRemoved(actor.meta_window.get_id());
        });
    }

    disable() {
        if (this._id) {
            global.window_manager.disconnect(this._id);
            this._id = null;
        }
    }
}
