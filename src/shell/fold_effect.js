/*
 * Fold n' Drop for GNOME Shell — GPL-3.0-or-later
 *
 * The paper fold, done per-pixel. Clutter.ShaderEffect is gone from Mutter's
 * Clutter, so this rides on Shell.GLSLEffect, which is a Clutter.OffscreenEffect
 * underneath: the actor is rendered to a texture and this shader resamples it.
 *
 * Coordinates are actor-local pixels. uContentOrigin/uContentSize mark where
 * the window content sits inside the (larger) actor, so the flap can overhang
 * the window's far edge once the fold passes halfway. The caller is
 * responsible for making the actor large enough to hold everything drawn here;
 * foldPaintBounds() in the core works out how large that is.
 *
 * One pass draws all three layers, in the order light hits them: the window's
 * own surface, the shadow the raised flap casts on it, then the flap. They
 * used to be two effects on two clones — the shadow on an actor of its own,
 * stacked under the flap's — which cost a second clone of every folded window
 * and could not work at all for a lifted corner, because that draws on the
 * real window actor and our overlay sits above it, so the shadow landed on
 * top of the flap it was supposed to fall under. Compositing them here fixes
 * the order by construction and halves the clones.
 */
'use strict';

import Cogl from 'gi://Cogl';
import GObject from 'gi://GObject';
import Shell from 'gi://Shell';

/* Shell.SnippetHook does not exist in GNOME 50; the enum lives in Cogl. Both
 * shipped GLSL extensions on this system use exactly this fallback. */
const FRAGMENT_HOOK = Cogl.SnippetHook ? Cogl.SnippetHook.FRAGMENT : Shell.SnippetHook.FRAGMENT;

/* Since GNOME 44.2 an offscreen effect does not write the alpha channel by
 * default. This fold depends entirely on alpha: the folded-away region must
 * become transparent so the window underneath shows through. Restoring
 * premultiplied over-blending in vfunc_paint_target is what makes that work. */
const PREMULTIPLIED_OVER =
    'RGBA = ADD (SRC_COLOR * (SRC_COLOR[A]), DST_COLOR * (1-SRC_COLOR[A]))';

const DECLARATIONS = `
uniform vec2 uSize;
uniform vec2 uContentOrigin;
uniform vec2 uContentSize;
uniform vec2 uFoldPoint;
uniform vec2 uFoldNormal;
uniform float uShading;
uniform float uFlapScale;
uniform vec3 uPanel;
uniform vec3 uBorder;
uniform float uShadowAlpha;
uniform float uShadowBlur;
uniform float uCornerRadius;
/* How solid the fold is, from the core: it thins out as the fold swallows
 * the window. */
uniform float uFade;
/* The actor's own paint opacity, sampled each frame in vfunc_paint_target. */
uniform float uActorOpacity;
uniform float uEnabled;

/* Width of the darker rim around the flap, matching the reference's 5 px
 * inset between the back of the sheet and its border. */
const float BORDER_PX = 5.0;
/* How quickly the bright crease highlight falls off, in pixels. */
const float CREASE_FALLOFF_PX = 6.0;
/* Peak brightness added right at the crease. */
const float CREASE_HIGHLIGHT = 0.18;
/* The flap reaches full shading at this fraction of the window's long side. */
const float SHADE_SPAN_FRACTION = 0.5;
/* GNOME drops its window shadows slightly downward rather than casting them
 * straight down onto the surface. Expressed as a share of the blur radius so
 * the two stay in proportion. */
const float SHADOW_DROP = 0.35;
/* The blur reaches its full width this far from the crease, as a share of the
 * shading span. */
const float SHADOW_SPREAD_SPAN = 0.6;
/* The narrowest the blur gets, right at the crease: a contact shadow, not a
 * hard edge. */
const float SHADOW_CONTACT = 0.12;

/* Signed distance to the window's silhouette — a rectangle with GNOME's
 * rounded corners — negative inside it. The inset shrinks the silhouette, taking
 * the corner radius with it so the inset shape stays concentric.
 *
 * This is what rounds the flap. The flap is the back of the same sheet, so its
 * outline has to be the window's outline; testing against a bare rectangle
 * gave it square corners against rounded ones everywhere else on screen. */
float contentSdf(vec2 p, float inset) {
    vec2 halfSize = max(uContentSize * 0.5 - vec2(inset), vec2(0.0));
    vec2 centre = uContentOrigin + uContentSize * 0.5;
    float r = clamp(uCornerRadius - inset, 0.0, min(halfSize.x, halfSize.y));
    vec2 q = abs(p - centre) - halfSize + vec2(r);
    return min(max(q.x, q.y), 0.0) + length(max(q, vec2(0.0))) - r;
}

/* The same silhouette as coverage, with a one-pixel soft edge so a rounded
 * corner is a curve rather than a staircase. */
float contentCoverage(vec2 p, float inset) {
    return clamp(0.5 - contentSdf(p, inset), 0.0, 1.0);
}

/* How much of the raised flap is directly over this point.
 *
 * The caster is the flap at full size: the flap itself is foreshortened to
 * uFlapScale, so the shadow reaches further than the flap that casts it and
 * shows as a band beyond its tip. That difference IS the offset — it grows
 * with the fold, the way a real sheet's shadow does, which a fixed pixel
 * offset could not. */
float castCoverage(vec2 p) {
    float s = dot(p - uFoldPoint, uFoldNormal);
    if (s > 0.0)
        return 0.0;
    return contentCoverage(p - 2.0 * s * uFoldNormal, 0.0);
}

/* Twelve taps on two rings, so the average is smooth rather than banded. The
 * offsets are computed rather than read from a const array: array constructors
 * are a GLSL 1.20 feature and this snippet is compiled against whichever
 * version Cogl picks, which on GLES is 1.00. */
const int SHADOW_TAPS = 12;
const float TAU = 6.2831853;

/* A hard-edged shadow reads as a second window rather than as a shadow, and
 * GNOME's own are broadly blurred. Averaging the caster's coverage over a disk
 * is a box blur of the silhouette, which is all a soft shadow needs. */
float shadowCoverage(vec2 p, float span) {
    if (uShadowBlur <= 0.0)
        return castCoverage(p);
    /* The blur widens with distance from the crease. The sheet is still in
     * contact along the crease and lifted at its tip, so a shadow of one
     * fixed softness reads as a flat cut-out sitting beside the window
     * rather than as paper coming up off it. */
    float depth = max(-dot(p - uFoldPoint, uFoldNormal), 0.0);
    float radius = uShadowBlur * clamp(depth / (span * SHADOW_SPREAD_SPAN),
                                       SHADOW_CONTACT, 1.0);
    vec2 at = p - vec2(0.0, radius * SHADOW_DROP);
    float acc = castCoverage(at);
    for (int i = 0; i < SHADOW_TAPS; i++) {
        float a = float(i) * (TAU / float(SHADOW_TAPS));
        /* Alternate points between an inner and an outer ring. Sampling one
         * ring only leaves the middle of the blur unweighted and the falloff
         * comes out flat-topped. */
        float ring = mod(float(i), 2.0) < 0.5 ? 0.55 : 1.0;
        acc += castCoverage(at + vec2(cos(a), sin(a)) * (radius * ring));
    }
    return acc / float(SHADOW_TAPS + 1);
}
`;

const CODE = `
if (uEnabled > 0.5) {
    vec2 p = cogl_tex_coord0_in.st * uSize;
    float s = dot(p - uFoldPoint, uFoldNormal);
    vec4 result = vec4(0.0);
    if (s <= 0.0) {
        /* The window's own surface on the side still lying flat.
         *
         * Deliberately not gated on the silhouette: p is a kept-side pixel of
         * the actor itself, not a mirrored sample. Gating it on the frame rect
         * clipped away the invisible-border margin along with everything drawn
         * in it, including the client's own drop shadow. Both call sites make
         * this safe — the in-place path sizes uSize to the actor's own box,
         * and the cloned path pads the container with offscreen texture that
         * is already transparent out there. */
        result = texture2D(cogl_sampler0, p / uSize);

        /* The shadow the raised flap casts. Flat alpha under the blur, as in
         * the reference: fading it with depth made the one part that is
         * actually visible, the deep end past the flap tip, the faintest part
         * of it. Black over the surface, in premultiplied form — it works both
         * over window pixels, which it darkens, and over the transparent
         * padding beyond the window edge, where it lays down translucent black
         * for whatever is stacked below to show through. */
        float span = max(uContentSize.x, uContentSize.y) * SHADE_SPAN_FRACTION;
        float shade = uShadowAlpha * shadowCoverage(p, span);
        result = vec4(result.rgb * (1.0 - shade),
                      result.a * (1.0 - shade) + shade);

        /* The flap: the back of the sheet.
         *
         * Foreshortening — a flap pixel at depth d shows the point at depth
         * d / scale, so a region of depth D occupies scale * D of flap. At
         * scale 1 this is the plain mirror, p - 2 s n. The lookup only decides
         * WHICH part of the sheet is folded over; what gets drawn is the
         * sheet's blank back, not the window's pixels mirrored, exactly as in
         * the reference. That is what makes it read as the underside of a page
         * rather than as a reflection. */
        /* The window and the shadow on it fade faster than the flap does —
         * squared against linear, as in the reference — so the back of the
         * sheet stays readable while what it is covering goes. */
        result *= uFade * uFade;

        vec2 flapSample = p - (1.0 + 1.0 / uFlapScale) * s * uFoldNormal;
        float flap = contentCoverage(flapSample, 0.0);
        if (flap > 0.0) {
            float depth = -s;
            vec3 colour = mix(uBorder, uPanel, contentCoverage(flapSample, BORDER_PX));
            /* Darkens away from the crease, and catches the light at it. */
            colour *= 1.0 - uShading * clamp(depth / span, 0.0, 1.0);
            colour *= 1.0 + CREASE_HIGHLIGHT * exp(-depth / CREASE_FALLOFF_PX);
            /* Premultiplied, so an opaque colour mixes by coverage directly. */
            result = mix(result, vec4(colour, 1.0) * uFade, flap);
        }
    }
    /* Everything above is premultiplied, so scaling the whole vector scales
     * the coverage with it.
     *
     * This is the only thing that makes an opacity animation on the actor
     * visible at all. Our snippet is Cogl's post string, and by then
     * cogl_color_out already holds the generated fragment — texture times the
     * pipeline colour, which is where Clutter puts paint opacity. Overwriting
     * it, as this does, threw that away: every ease on the fold's opacity was
     * silently doing nothing, so a discarded window blinked out rather than
     * fading. */
    cogl_color_out = result * uActorOpacity;
}
`;

export const FoldEffect = GObject.registerClass(
class FoldEffect extends Shell.GLSLEffect {
    vfunc_build_pipeline() {
        this.add_glsl_snippet(FRAGMENT_HOOK, DECLARATIONS, CODE, false);
    }

    vfunc_paint_target(...params) {
        /* Read per paint rather than per setFold: Clutter drives an opacity
         * ease itself, without telling us, so sampling it anywhere else would
         * miss every frame of the animation. */
        const actor = this.get_actor();
        this.set_uniform_float(this.get_uniform_location('uActorOpacity'), 1,
            [actor ? actor.get_paint_opacity() / 255 : 1]);
        this.get_pipeline().set_blend(PREMULTIPLIED_OVER);
        super.vfunc_paint_target(...params);
    }

    setFold({
        size, contentOrigin, contentSize, line, shading,
        flapScale = 1.0, panel, border, shadowAlpha, shadowBlur = 0,
        cornerRadius = 0, fade = 1,
    }) {
        this.set_uniform_float(this.get_uniform_location('uSize'), 2, [size.width, size.height]);
        this.set_uniform_float(this.get_uniform_location('uContentOrigin'), 2,
            [contentOrigin.x, contentOrigin.y]);
        this.set_uniform_float(this.get_uniform_location('uContentSize'), 2,
            [contentSize.width, contentSize.height]);
        this.set_uniform_float(this.get_uniform_location('uShading'), 1, [shading]);
        this.set_uniform_float(this.get_uniform_location('uFlapScale'), 1,
            [Math.max(0.05, flapScale)]);
        this.set_uniform_float(this.get_uniform_location('uPanel'), 3,
            [panel.r, panel.g, panel.b]);
        this.set_uniform_float(this.get_uniform_location('uBorder'), 3,
            [border.r, border.g, border.b]);
        this.set_uniform_float(this.get_uniform_location('uShadowAlpha'), 1, [shadowAlpha]);
        this.set_uniform_float(this.get_uniform_location('uShadowBlur'), 1, [shadowBlur]);
        this.set_uniform_float(this.get_uniform_location('uCornerRadius'), 1, [cornerRadius]);
        this.set_uniform_float(this.get_uniform_location('uFade'), 1, [fade]);

        if (line) {
            this.set_uniform_float(this.get_uniform_location('uFoldPoint'), 2,
                [line.point.x, line.point.y]);
            this.set_uniform_float(this.get_uniform_location('uFoldNormal'), 2,
                [line.normal.x, line.normal.y]);
            this.set_uniform_float(this.get_uniform_location('uEnabled'), 1, [1.0]);
        } else {
            this.set_uniform_float(this.get_uniform_location('uEnabled'), 1, [0.0]);
        }
        this.queue_repaint();
    }
});
