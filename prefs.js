/*
 * Fold n' Drop for GNOME Shell — GPL-3.0-or-later
 */
'use strict';

import Adw from 'gi://Adw';
import Gio from 'gi://Gio';
import Gtk from 'gi://Gtk';

import { ExtensionPreferences } from 'resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js';

function spinRow({ title, subtitle, lower, upper, step, digits = 0 }) {
    const row = new Adw.SpinRow({
        title,
        subtitle,
        adjustment: new Gtk.Adjustment({
            lower, upper, step_increment: step, page_increment: step * 10,
        }),
        digits,
    });
    return row;
}

export default class FoldNDropPreferences extends ExtensionPreferences {
    fillPreferencesWindow(window) {
        const settings = this.getSettings();

        const page = new Adw.PreferencesPage({
            title: "Fold n' Drop",
            icon_name: 'preferences-system-symbolic',
        });
        window.add(page);

        const gesture = new Adw.PreferencesGroup({
            title: 'Gesture',
            description: 'How quickly you must cross a window boundary back and forth to fold it.',
        });
        page.add(gesture);

        const timeout = spinRow({
            title: 'Double-crossing timeout',
            subtitle: 'Milliseconds the lifted corner stays available to confirm a fold',
            lower: 100, upper: 2000, step: 25,
        });
        gesture.add(timeout);
        settings.bind('transient-fold-timeout-ms', timeout, 'value', Gio.SettingsBindFlags.DEFAULT);

        const depth = spinRow({
            title: 'Preview fold depth',
            subtitle: 'How far the preview fold reaches into the window, in pixels',
            lower: 8, upper: 200, step: 4,
        });
        gesture.add(depth);
        settings.bind('transient-fold-depth-px', depth, 'value', Gio.SettingsBindFlags.DEFAULT);

        const unfold = spinRow({
            title: 'Unfold duration',
            subtitle: 'Milliseconds a fold takes to retract to its corner',
            lower: 0, upper: 2000, step: 25,
        });
        gesture.add(unfold);
        settings.bind('unfold-ms', unfold, 'value', Gio.SettingsBindFlags.DEFAULT);

        const pushDelta = spinRow({
            title: 'Push clearance',
            subtitle: 'How far past the pointer a pushed fold settles, in pixels',
            lower: 0, upper: 50, step: 1,
        });
        gesture.add(pushDelta);
        settings.bind('push-delta-px', pushDelta, 'value', Gio.SettingsBindFlags.DEFAULT);

        const rotation = spinRow({
            title: 'Fold rotation',
            subtitle: 'How strongly a pushed fold turns toward the direction you are moving',
            lower: 0, upper: 1, step: 0.05, digits: 2,
        });
        gesture.add(rotation);
        settings.bind('fold-rotation-lerp', rotation, 'value', Gio.SettingsBindFlags.DEFAULT);

        const discard = new Adw.PreferencesGroup({
            title: 'Discarding',
            description: 'Pushing a fold far enough makes the window fade away for the rest of the drag.',
        });
        page.add(discard);

        const discardEnabled = new Adw.SwitchRow({ title: 'Allow discarding' });
        discard.add(discardEnabled);
        settings.bind('discard-enabled', discardEnabled, 'active', Gio.SettingsBindFlags.DEFAULT);

        const threshold = spinRow({
            title: 'Discard threshold',
            subtitle: 'Fraction of the window that must remain before it is discarded',
            lower: 0, upper: 0.5, step: 0.01, digits: 2,
        });
        discard.add(threshold);
        settings.bind('discard-threshold', threshold, 'value', Gio.SettingsBindFlags.DEFAULT);

        const appearance = new Adw.PreferencesGroup({ title: 'Appearance and timing' });
        page.add(appearance);

        const shading = spinRow({
            title: 'Fold shading',
            subtitle: 'How much the folded flap darkens away from the crease',
            lower: 0, upper: 1, step: 0.05, digits: 2,
        });
        appearance.add(shading);
        settings.bind('fold-shading-strength', shading, 'value', Gio.SettingsBindFlags.DEFAULT);

        const flapScale = spinRow({
            title: 'Flap foreshortening',
            subtitle: 'How much the folded flap is squashed; one is a flat mirror',
            lower: 0.2, upper: 1, step: 0.05, digits: 2,
        });
        appearance.add(flapScale);
        settings.bind('fold-flap-scale', flapScale, 'value', Gio.SettingsBindFlags.DEFAULT);

        const accent = spinRow({
            title: 'Accent tint',
            subtitle: 'How much of the desktop accent colour tints the back of a folded window',
            lower: 0, upper: 1, step: 0.05, digits: 2,
        });
        appearance.add(accent);
        settings.bind('fold-accent-strength', accent, 'value', Gio.SettingsBindFlags.DEFAULT);

        const shadow = spinRow({
            title: 'Fold shadow',
            subtitle: 'How dark a shadow the raised flap casts on what lies beneath it',
            lower: 0, upper: 1, step: 0.02, digits: 2,
        });
        appearance.add(shadow);
        settings.bind('fold-shadow-alpha', shadow, 'value', Gio.SettingsBindFlags.DEFAULT);

        const shadowBlur = spinRow({
            title: 'Fold shadow blur',
            subtitle: 'How far the fold shadow is blurred, to match GNOME window shadows',
            lower: 0, upper: 80, step: 1,
        });
        appearance.add(shadowBlur);
        settings.bind('fold-shadow-blur-px', shadowBlur, 'value', Gio.SettingsBindFlags.DEFAULT);

        const cornerRadius = spinRow({
            title: 'Fold corner radius',
            subtitle: 'How far the corners of the folded flap are rounded, to match window corners',
            lower: 0, upper: 40, step: 1,
        });
        appearance.add(cornerRadius);
        settings.bind('fold-corner-radius-px', cornerRadius, 'value', Gio.SettingsBindFlags.DEFAULT);

        const discardFade = spinRow({
            title: 'Discard fade',
            subtitle: 'Milliseconds a discarded window takes to fade out',
            lower: 0, upper: 2000, step: 25,
        });
        appearance.add(discardFade);
        settings.bind('discard-fade-ms', discardFade, 'value', Gio.SettingsBindFlags.DEFAULT);

        const springBack = spinRow({
            title: 'Spring-back',
            subtitle: 'Milliseconds windows take to unfold when the drag ends',
            lower: 0, upper: 2000, step: 25,
        });
        appearance.add(springBack);
        settings.bind('spring-back-ms', springBack, 'value', Gio.SettingsBindFlags.DEFAULT);

        const pause = spinRow({
            title: 'Pause after dropping',
            subtitle: 'Milliseconds to hold the folded arrangement so you can see the result of the drop',
            lower: 0, upper: 3000, step: 25,
        });
        appearance.add(pause);
        settings.bind('post-drop-pause-ms', pause, 'value', Gio.SettingsBindFlags.DEFAULT);
    }
}
