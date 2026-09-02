/*
 * Fold n' Drop for GNOME Shell — GPL-3.0-or-later
 *
 * Pointer position straight from the cursor tracker rather than from Clutter
 * events, so it works regardless of which client is receiving the drag.
 */
'use strict';

import GLib from 'gi://GLib';

export class PointerSource {
    constructor({ onPoint, intervalMs = 16 }) {
        this._onPoint = onPoint;
        this._intervalMs = intervalMs;
        this._tracker = null;
        this._timerId = null;
    }

    enable() {
        this._tracker = global.backend.get_cursor_tracker();
        /* One steady tick drives everything: it keeps animations advancing —
         * lifts, unfolds — when the pointer stops moving, and it samples the
         * pointer when it does.
         *
         * Deliberately NOT also driven by 'position-invalidated'. That signal
         * carries no position of its own; _emit reads the tracker either way,
         * so every emission it caused was the same work over again, at
         * whatever rate the mouse reports — 1000 Hz on a gaming mouse, which
         * is some sixty full pipeline runs and sixty queue_repaint calls per
         * frame. It also chopped the motion into slivers, so the crease
         * turned once per report rather than once per unit of travel, and the
         * same gesture landed differently on different hardware. Sampling on
         * a fixed tick makes the drag depend on the gesture, not the mouse. */
        this._timerId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, this._intervalMs, () => {
            this._emit();
            return GLib.SOURCE_CONTINUE;
        });
        this._emit();
    }

    _emit() {
        const point = this._readPointer();
        if (point)
            this._onPoint(point, GLib.get_monotonic_time() / 1000);
    }

    /* Mutter has changed this signature across versions; Task 0 recorded which
     * shape this system returns. Both are handled so the extension does not
     * break on an upgrade. */
    _readPointer() {
        if (!this._tracker)
            return null;
        const result = this._tracker.get_pointer();
        if (Array.isArray(result)) {
            const first = result[0];
            if (first && typeof first === 'object' && 'x' in first)
                return { x: first.x, y: first.y };
            return { x: result[0], y: result[1] };
        }
        if (result && typeof result === 'object' && 'x' in result)
            return { x: result.x, y: result.y };
        return null;
    }

    disable() {
        if (this._timerId) {
            GLib.Source.remove(this._timerId);
            this._timerId = null;
        }
        this._tracker = null;
    }
}
