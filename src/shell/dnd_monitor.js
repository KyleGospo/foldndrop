/*
 * Fold n' Drop for GNOME Shell — GPL-3.0-or-later
 *
 * Arms the gestures only while a genuine drag-and-drop is in flight, which
 * is what keeps a scrollbar drag near a window edge from folding anything.
 */
'use strict';

import Meta from 'gi://Meta';

export class DndMonitor {
    constructor({ onStart, onEnd }) {
        this._onStart = onStart;
        this._onEnd = onEnd;
        this._selection = null;
        this._id = null;
        this._active = false;
    }

    get active() {
        return this._active;
    }

    enable() {
        this._selection = global.display.get_selection();
        this._id = this._selection.connect('owner-changed', (selection, type, source) => {
            if (type !== Meta.SelectionType.SELECTION_DND)
                return;
            if (source && !this._active) {
                this._active = true;
                this._onStart();
            } else if (!source && this._active) {
                this._active = false;
                this._onEnd();
            }
        });
    }

    disable() {
        if (this._id) {
            this._selection.disconnect(this._id);
            this._id = null;
        }
        this._selection = null;
        this._active = false;
    }
}
