/*
 * Fold n' Drop for GNOME Shell — GPL-3.0-or-later
 *
 * Single place where GSettings keys become the plain numbers the core wants.
 */
'use strict';

import Gio from 'gi://Gio';

/* libadwaita's standard accent colours, as @accent_bg_color. GNOME exposes
 * only the name in org.gnome.desktop.interface accent-color, so the value has
 * to be looked up rather than read. */
const ACCENTS = {
    blue: { r: 0.208, g: 0.518, b: 0.894 },   // #3584e4
    teal: { r: 0.129, g: 0.565, b: 0.643 },   // #2190a4
    green: { r: 0.227, g: 0.580, b: 0.290 },  // #3a944a
    yellow: { r: 0.784, g: 0.533, b: 0.000 }, // #c88800
    orange: { r: 0.929, g: 0.357, b: 0.000 }, // #ed5b00
    red: { r: 0.902, g: 0.176, b: 0.259 },    // #e62d42
    pink: { r: 0.835, g: 0.380, b: 0.600 },   // #d56199
    purple: { r: 0.569, g: 0.255, b: 0.675 }, // #9141ac
    slate: { r: 0.435, g: 0.514, b: 0.588 },  // #6f8396
};
const DEFAULT_ACCENT = ACCENTS.blue;

/* The blank back of a sheet, before any accent is mixed in. The rim is darker
 * than the panel in both schemes, which is what gives the flap an edge. */
const PAPER = {
    light: { panel: 0.90, border: 0.55 },
    dark: { panel: 0.24, border: 0.42 },
};

/* A dark desktop wants the accent muted: libadwaita's accents are picked to
 * sit on light chrome, and at full strength the flap glows against everything
 * around it. Thirty percent off puts it back in the scheme. */
const DARK_ACCENT_DIM = 0.7;

function darken(accent, k) {
    return { r: accent.r * k, g: accent.g * k, b: accent.b * k };
}

function mix(base, accent, k) {
    return {
        r: base + (accent.r - base) * k,
        g: base + (accent.g - base) * k,
        b: base + (accent.b - base) * k,
    };
}

export class Settings {
    constructor(gioSettings) {
        this._settings = gioSettings;
        /* The flap is paper: it takes the desktop's light or dark tone, then
         * the accent colour is mixed into it. */
        this._interface = new Gio.Settings({ schema_id: 'org.gnome.desktop.interface' });
        /* Both are read once per window per frame, so they are cached and
         * refreshed on change rather than parsed out of GSettings each time. */
        this._flap = null;
        this._interfaceId = this._interface.connect('changed', () => {
            this._flap = null;
        });
        this._settingsId = this._settings.connect('changed', () => {
            this._flap = null;
        });
    }

    get config() {
        return {
            transientTimeoutMs: this._settings.get_int('transient-fold-timeout-ms'),
            transientDepthPx: this._settings.get_int('transient-fold-depth-px'),
            pushDeltaPx: this._settings.get_int('push-delta-px'),
            rotationLerp: this._settings.get_double('fold-rotation-lerp'),
            discardThreshold: this._settings.get_double('discard-threshold'),
            discardEnabled: this._settings.get_boolean('discard-enabled'),
            unfoldMs: this._settings.get_int('unfold-ms'),
            restoreMs: this._settings.get_int('spring-back-ms'),
        };
    }

    /* accent-color arrived in GNOME 47 and the value is an enum name. An
     * unknown or missing one falls back to blue rather than throwing: a
     * desktop that cannot say what its accent is still has to be able to
     * fold a window. */
    _accent() {
        try {
            return ACCENTS[this._interface.get_string('accent-color')] ?? DEFAULT_ACCENT;
        } catch (e) {
            return DEFAULT_ACCENT;
        }
    }

    _flapColours() {
        if (this._flap)
            return this._flap;
        const dark = this._interface.get_string('color-scheme') === 'prefer-dark';
        const paper = dark ? PAPER.dark : PAPER.light;
        const accent = dark ? darken(this._accent(), DARK_ACCENT_DIM) : this._accent();
        const strength = this._settings.get_double('fold-accent-strength');
        this._flap = {
            panel: mix(paper.panel, accent, strength),
            /* The rim carries the accent harder than the panel, so the fold
             * reads as accented even at a low strength. */
            border: mix(paper.border, accent, Math.min(1, strength * 1.4)),
        };
        return this._flap;
    }

    get flapPanel() {
        return this._flapColours().panel;
    }

    get flapBorder() {
        return this._flapColours().border;
    }

    get shadingStrength() {
        return this._settings.get_double('fold-shading-strength');
    }

    get flapScale() {
        return this._settings.get_double('fold-flap-scale');
    }

    get shadowAlpha() {
        return this._settings.get_double('fold-shadow-alpha');
    }

    /* How far the fold's shadow is blurred, matching the soft shadows GNOME
     * draws around windows. Zero gives the hard-edged silhouette. */
    get shadowBlurPx() {
        return this._settings.get_int('fold-shadow-blur-px');
    }

    /* The radius GNOME rounds window corners to, which the flap has to match
     * or the back of the sheet comes out square against everything else. */
    get cornerRadiusPx() {
        return this._settings.get_int('fold-corner-radius-px');
    }

    get discardFadeMs() {
        return this._settings.get_int('discard-fade-ms');
    }

    get springBackMs() {
        return this._settings.get_int('spring-back-ms');
    }

    get postDropPauseMs() {
        return this._settings.get_int('post-drop-pause-ms');
    }

    destroy() {
        if (this._interfaceId) {
            this._interface.disconnect(this._interfaceId);
            this._interfaceId = null;
        }
        if (this._settingsId) {
            this._settings.disconnect(this._settingsId);
            this._settingsId = null;
        }
        this._settings = null;
        this._interface = null;
        this._flap = null;
    }
}
