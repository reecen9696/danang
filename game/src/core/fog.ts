import * as THREE from 'three';

/**
 * Ace of Spades distance fog, ported from OpenSpades' `Shaders/Fog.vs`.
 *
 * Three things make it look like the original rather than like generic
 * depth fog:
 *
 *  - It keys off the *horizontal* distance to the camera, not the view
 *    depth. Looking up at the sky or down a shaft stays clear; only ground
 *    distance fogs you out. This is what keeps the sky readable when you
 *    aim up, and it's why the fog wall doesn't swing around as you pitch.
 *  - On top of that, density thins with height above the camera (see
 *    `FOG_LIFT_*`). The original doesn't do this, but with the jungle's
 *    short view distance a tower two streets away washed out as badly at
 *    its top as at its base; real haze pools low, so tall geometry and the
 *    high air read clearer while the ground plane keeps its full murk.
 *  - Density is quadratic in distance and saturates hard at exactly
 *    `fogDistance` blocks (128 in AoS), which is the game's view distance --
 *    there is no "far" beyond it, everything there is solid fog colour.
 *  - The three channels fog at different rates: red climbs linearly, blue
 *    climbs on the fast `1-(1-d)^2` curve, green sits 30% of the way
 *    between. Distant geometry therefore drifts blue *before* it washes
 *    out, which is the tint the original is remembered for.
 *
 * The blend is done in linear light (colours are squared going in and
 * square-rooted coming out) to match OpenSpades, which shades linearly and
 * gamma-corrects at the end. The rest of this renderer works in gamma space
 * -- `THREE.ColorManagement` is off and vertex colours are authored in the
 * final shade -- so the conversion is kept local to the fog blend.
 */

/** AoS view distance, in blocks. OpenSpades' `GLRenderer::fogDistance`. */
export const FOG_DISTANCE = 128;

/**
 * Height above the camera at which the thinning is fully wound in, in blocks,
 * and the factor the *squared* distance is scaled by up there. Everything at or
 * below eye level keeps the full amount.
 *
 * Thinning by shrinking the distance rather than by capping the density is what
 * keeps the horizon intact: the curve still saturates, just further out
 * (`fogDist / sqrt(floor)`, so about 1.18x the ground figure). Capping density
 * instead would leave high geometry faintly visible at any range, and the cloud
 * layer would end in a visible ring at its own radius instead of dissolving.
 */
export const FOG_LIFT_RANGE = 34;
export const FOG_LIFT_FLOOR = 0.72;

/**
 * The density curve, shared by the patched built-in materials and by the
 * particle shader so both fog identically.
 *
 * `sqDist` is the squared horizontal distance from the camera; passing it
 * squared keeps the sqrt out of the fragment shader, exactly as the
 * reference does.
 */
export const ACE_FOG_FUNCTION = /* glsl */ `
  // Scales squared distance: < 1 reads as nearer, i.e. less fogged.
  float aceFogLift( float up ) {
    float t = clamp( up / ${FOG_LIFT_RANGE.toFixed(1)}, 0.0, 1.0 );
    return mix( 1.0, ${FOG_LIFT_FLOOR.toFixed(2)}, t );
  }

  vec3 aceFogDensity( float sqDist, float fogDist ) {
    float d = min( sqDist / ( fogDist * fogDist ), 1.0 );
    float weakened = 1.0 - d;
    weakened *= weakened;
    // r: linear, g: 30% of the way to the fast curve, b: the fast curve.
    return mix( vec3( d ), vec3( 1.0 - weakened ), vec3( 0.0, 0.3, 1.0 ) );
  }
`;

/**
 * Applies the fog to a gamma-space `rgb`, blending in linear light.
 * `ofs` is the camera-relative offset in world units: `xz` drives the
 * distance curve, `y` drives the height thinning.
 */
export const ACE_FOG_APPLY = /* glsl */ `
  vec3 aceFogApply( vec3 rgb, vec3 ofs, vec3 fogCol, float fogDist ) {
    vec3 density = aceFogDensity( dot( ofs.xz, ofs.xz ) * aceFogLift( ofs.y ), fogDist );
    vec3 lin = mix( rgb * rgb, fogCol * fogCol, density );
    return sqrt( lin );
  }
`;

/**
 * `mvPosition` is view-space, and a view matrix's upper 3x3 is a pure
 * rotation, so multiplying from the right (which is a transpose, i.e. an
 * inverse here) rotates back into world space. That gives the camera-to-
 * vertex offset without needing the world position -- which matters because
 * `mvPosition` is the one thing in scope in *every* three.js vertex shader
 * that includes `fog_vertex`, sprites and points included.
 */
const FOG_OFFSET = /* glsl */ `( mvPosition.xyz * mat3( viewMatrix ) )`;

let installed = false;

/**
 * Replaces three.js' fog shader chunks so every `fog: true` material picks
 * this up. `fogFar` is reused as the fog distance uniform, which keeps
 * three's own uniform plumbing (`refreshFogUniforms`) doing the work.
 */
export function installAceFog(): void {
  if (installed) return;
  installed = true;

  THREE.ShaderChunk.fog_pars_vertex = /* glsl */ `
    #ifdef USE_FOG
      varying vec3 vFogOfs;
    #endif
  `;

  THREE.ShaderChunk.fog_vertex = /* glsl */ `
    #ifdef USE_FOG
      vFogOfs = ${FOG_OFFSET};
    #endif
  `;

  THREE.ShaderChunk.fog_pars_fragment = /* glsl */ `
    #ifdef USE_FOG
      uniform vec3 fogColor;
      uniform float fogFar;
      varying vec3 vFogOfs;
      ${ACE_FOG_FUNCTION}
      ${ACE_FOG_APPLY}
    #endif
  `;

  THREE.ShaderChunk.fog_fragment = /* glsl */ `
    #ifdef USE_FOG
      gl_FragColor.rgb = aceFogApply( gl_FragColor.rgb, vFogOfs, fogColor, fogFar );
    #endif
  `;
}

/**
 * `THREE.Fog` is used as the carrier so three keeps updating the uniforms
 * for us; `near` is unused and `far` carries the fog distance.
 */
export function makeAceFog(color: THREE.ColorRepresentation, distance = FOG_DISTANCE): THREE.Fog {
  return new THREE.Fog(color, 0, distance);
}

installAceFog();
