// src/core/gesture.js
/*
 * Fold n' Drop for GNOME Shell — GPL-3.0-or-later
 *
 * The timed double-crossing state machine. Pure: it reads window states and
 * crossings and returns intents, changing nothing itself.
 *
 * The paper's slow-versus-fast distinction is exactly the transient timeout:
 * a slow return arrives after the lift animation's lifetime has run out and
 * triggers nothing, so no separate speed threshold is needed.
 */
'use strict';

import { NORMAL, TRANSIENT, FOLDED, DISCARDED } from './fold.js';

export function computeIntents({ windows, crossings }) {
    const intents = [];

    const local = new Map();
    for (const [id, win] of windows)
        local.set(id, win.state);

    for (const crossing of crossings) {
        const id = crossing.boundary.windowId;
        const state = local.get(id);
        if (state === undefined || state === DISCARDED)
            continue;

        if (crossing.boundary.kind === 'edge') {
            if (crossing.direction === 'outward' && state === NORMAL) {
                intents.push({
                    type: 'transient',
                    windowId: id,
                    edgeId: crossing.boundary.edgeId,
                    point: crossing.point,
                });
                local.set(id, TRANSIENT);
            } else if (crossing.direction === 'inward' && state === TRANSIENT) {
                intents.push({ type: 'confirm', windowId: id });
                local.set(id, FOLDED);
            }
        } else if (crossing.boundary.kind === 'fold' && state === FOLDED) {
            /* Inward means the pointer came at the crease from the revealed
             * side and is driving it deeper. Outward means it went around the
             * crease and is pushing it back out from inside — Figure 4. */
            if (crossing.direction === 'inward')
                intents.push({ type: 'push', windowId: id, point: crossing.point });
            else
                intents.push({ type: 'unfold', windowId: id });
        }
    }

    return intents;
}
