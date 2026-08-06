// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Datumfeed
/**
 * deck.gl binding for the Datumfeed source.
 *
 * Two layers, both optional:
 *   - a ScatterplotLayer of camera positions, coloured by trust score
 *   - a BitmapLayer per live frame, projected onto the ground as a view
 *     footprint so the imagery sits in the scene instead of floating in a HUD
 *
 * Peer dependency: `@deck.gl/layers`. The core client in `datumfeed-source.js`
 * imports nothing and works without deck.gl if you would rather draw frames
 * some other way.
 *
 * @module sources/datumfeed/deckgl-layers
 */

import { BitmapLayer, ScatterplotLayer } from '@deck.gl/layers';

const METERS_PER_DEG_LAT = 111320;
const DEG = Math.PI / 180;

/**
 * Ground footprint for one camera, as the 4 corners a BitmapLayer wants:
 * [bottom-left, top-left, top-right, bottom-right]. The bottom edge of the
 * image lands nearest the camera and the top edge furthest away, which is the
 * orientation a forward-looking street camera actually has.
 *
 * A trapezoid rather than a rectangle because a camera's view widens with
 * distance; it reads as perspective once the globe tilts.
 *
 * Width comes from the frame's own aspect ratio rather than an assumed field of
 * view. None of these sources publish their optics, so a guessed FOV only ever
 * squashes or stretches the picture; sizing the trapezoid so its mean width is
 * `aspect * lengthM` keeps the imagery in its true proportions, and the caller
 * controls scale with one number (`lengthM`) instead of two coupled ones.
 *
 * @param {number} lat
 * @param {number} lon
 * @param {number} bearingDeg Clockwise from north.
 * @param {{nearM: number, lengthM: number, aspect: number}} shape
 * @returns {[number, number][]}
 */
export function footprintCorners(lat, lon, bearingDeg, shape) {
  const { nearM, lengthM, aspect } = shape;
  const farM = nearM + lengthM;

  // Flare rate that makes the mean width equal aspect * lengthM while keeping
  // near/far widths in true perspective proportion (farHalf/nearHalf = farM/nearM).
  const flare = (aspect * lengthM) / (2 * nearM + lengthM);
  const nearHalfW = flare * nearM;
  const farHalfW = flare * farM;

  const theta = bearingDeg * DEG;
  const cos = Math.cos(theta);
  const sin = Math.sin(theta);

  // Guard the pole singularity so cos(lat) never collapses to zero.
  const metersPerDegLon = METERS_PER_DEG_LAT * Math.max(Math.cos(lat * DEG), 1e-6);

  /**
   * @param {number} forward Metres along the bearing.
   * @param {number} right   Metres perpendicular, positive to the camera's right.
   * @returns {[number, number]}
   */
  const offset = (forward, right) => {
    const north = forward * cos - right * sin;
    const east = forward * sin + right * cos;
    return [lon + east / metersPerDegLon, lat + north / METERS_PER_DEG_LAT];
  };

  return [
    offset(nearM, -nearHalfW),
    offset(farM, -farHalfW),
    offset(farM, farHalfW),
    offset(nearM, nearHalfW)
  ];
}

/**
 * Okabe-Ito ramp: bluish green -> orange -> vermillion as trust falls.
 * Chosen to stay distinguishable for red/green colour vision deficiency, which
 * a red-to-green ramp would not.
 *
 * @param {number|null} trustScore
 * @returns {[number, number, number]}
 */
function trustColor(trustScore) {
  if (trustScore === null || trustScore === undefined) return [153, 153, 153];
  if (trustScore >= 80) return [0, 158, 115];
  if (trustScore >= 50) return [230, 159, 0];
  return [213, 94, 0];
}

/**
 * Build the deck.gl layers for a set of cameras and whatever frames have
 * arrived so far.
 *
 * Frames are drawn only for cameras that already have one, so the globe fills
 * in progressively as the poller works through the viewport rather than
 * blocking on a complete set.
 *
 * @param {Object} params
 * @param {import('./datumfeed-source.js').DatumfeedCamera[]} params.cameras
 * @param {Map<string, import('./datumfeed-source.js').DatumfeedFrame>} params.frames
 *   From `FramePoller#frames`. Only the cameras it is actually polling appear
 *   here; the rest of `cameras` renders as points, which is the intended
 *   behaviour when a viewport holds more cameras than the frame budget allows.
 * @param {Object} [params.options]
 * @param {boolean} [params.options.showPoints=true]
 * @param {number} [params.options.nearM=40]   Distance from the camera to the
 *   near edge of the footprint, metres. Also sets how much the trapezoid flares.
 * @param {number} [params.options.lengthM=150] How far the footprint runs, metres.
 *   This is the size knob; width follows from the frame's aspect ratio.
 * @param {number} [params.options.opacity=0.92]
 * @param {'viewport'|'north'|number} [params.options.bearingFallback='viewport']
 *   What to do when `camera.bearingDeg` is null — which, as of Aug 2026, is
 *   every camera in the catalogue. 'viewport' lays the footprint out along the
 *   current view direction so imagery stays upright and legible from any angle;
 *   'north' pins it; a number forces a fixed heading. Picks up the real bearing
 *   automatically the day the field is populated — no code change needed, the
 *   null check just stops firing.
 * @param {number} [params.options.viewportBearing=0] Current view bearing, for
 *   the 'viewport' fallback.
 * @returns {any[]} deck.gl layers
 */
export function createDatumfeedLayers({ cameras, frames, options = {} }) {
  const {
    showPoints = true,
    nearM = 40,
    lengthM = 150,
    opacity = 0.92,
    bearingFallback = 'viewport',
    viewportBearing = 0
  } = options;

  /** @param {import('./datumfeed-source.js').DatumfeedCamera} camera */
  const bearingFor = (camera) => {
    if (typeof camera.bearingDeg === 'number') return camera.bearingDeg;
    if (typeof bearingFallback === 'number') return bearingFallback;
    if (bearingFallback === 'north') return 0;
    // Lay the footprint out along the view direction: its far edge — which is
    // the top of the image — then sits away from the viewer, so the frame reads
    // upright on screen. Using the opposite heading flips it.
    return viewportBearing;
  };

  const layers = [];

  if (showPoints) {
    layers.push(
      new ScatterplotLayer({
        id: 'datumfeed-cameras',
        data: cameras,
        pickable: true,
        radiusUnits: 'meters',
        getPosition: (d) => [d.lon, d.lat],
        getRadius: 8,
        radiusMinPixels: 2,
        radiusMaxPixels: 10,
        getFillColor: (d) => trustColor(d.stats?.trustScore)
        // No updateTriggers: trust scores arrive with the camera objects, so a
        // new `data` array is the only thing that can change a colour, and
        // deck.gl already re-runs accessors on that.
      })
    );
  }

  for (const camera of cameras) {
    const frame = frames.get(camera.id);
    if (!frame) continue;

    layers.push(
      new BitmapLayer({
        // fetchedAt in the id retires the old texture when a fresh frame lands.
        id: `datumfeed-frame-${camera.id}-${frame.fetchedAt?.getTime() ?? 0}`,
        image: frame.bitmap,
        bounds: footprintCorners(camera.lat, camera.lon, bearingFor(camera), {
          nearM,
          lengthM,
          aspect: frame.bitmap.width / frame.bitmap.height
        }),
        opacity,
        pickable: true
      })
    );
  }

  return layers;
}

/**
 * Credit line for whatever is currently on screen.
 *
 * The API asks that `registry.attribution` be shown next to any frame rendered,
 * so this is not decoration — wire it to a visible element and keep it in sync
 * with the camera set.
 *
 * Returns plain text, never markup: camera and registry strings are
 * third-party data and must not be interpolated into HTML.
 *
 * @param {string[]} attributions From `DatumfeedSource#attributionsFor`.
 * @returns {string}
 */
export function attributionText(attributions) {
  if (attributions.length === 0) return '';
  return `Camera imagery: ${attributions.join(' · ')}`;
}
