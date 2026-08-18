// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Datumfeed
/**
 * deck.gl binding for the Datumfeed source.
 *
 * Two layers, both optional:
 *   - a ScatterplotLayer of camera positions, coloured by trust score
 *   - one card per live frame, so the imagery sits in the scene instead of
 *     floating in a HUD. Two ways to draw that card:
 *       'billboard' (default) an IconLayer standing upright at the camera
 *       'footprint'           a BitmapLayer projected onto the ground
 *
 * Billboards are the default because these cameras look at mostly vertical
 * content — facades, vehicles, people — and laying that flat on the ground
 * smears it along the view axis and leaves the frame's edges as jagged
 * trapezoid seams. Upright cards keep the picture in its own plane, so it
 * stays legible at any pitch. Reconsider if the app locks to a top-down view,
 * where the footprint is the honest projection and the smear disappears;
 * `mode: 'footprint'` keeps that path available.
 *
 * Peer dependency: `@deck.gl/layers`. The core client in `datumfeed-source.js`
 * imports nothing and works without deck.gl if you would rather draw frames
 * some other way.
 *
 * @module sources/datumfeed/deckgl-layers
 */

import { BitmapLayer, IconLayer, ScatterplotLayer } from '@deck.gl/layers';

const METERS_PER_DEG_LAT = 111320;
const DEG = Math.PI / 180;

// Cards are composited at display size times this, so the GPU samples the
// texture at about 1:1 instead of minifying a 640 px frame down to 150 and
// aliasing every edge. Capped: past 2x it is memory for nothing.
const MAX_CARD_PIXEL_RATIO = 2;

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
 * A 2D drawing surface, off-DOM where the platform has one.
 *
 * @param {number} width
 * @param {number} height
 * @returns {OffscreenCanvas|HTMLCanvasElement}
 */
function drawingSurface(width, height) {
  if (typeof OffscreenCanvas === 'function') return new OffscreenCanvas(width, height);
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  return canvas;
}

/**
 * Composite one frame into the card a billboard draws: the picture, a hairline
 * border, and a short stem below it that lands on the camera's position, so the
 * card reads as pinned there rather than hovering near it.
 *
 * The downscale to card size happens here, in 2D, rather than in the sampler.
 * Canvas downsampling is area-averaged; a minifying texture fetch is not, and
 * that difference is most of what makes small map imagery look chewed.
 *
 * @param {ImageBitmap} bitmap
 * @param {{widthPx: number, borderPx: number, stemPx: number, borderColor: string}} card
 * @returns {{image: ImageBitmap|HTMLCanvasElement|OffscreenCanvas, width: number, height: number, cssHeight: number}}
 *   `width`/`height` are the composited image's own pixels, for the icon
 *   mapping; `cssHeight` is what it should measure on screen.
 */
function billboardCard(bitmap, { widthPx, borderPx, stemPx, borderColor }) {
  const pictureH = Math.max(1, Math.round((widthPx * bitmap.height) / bitmap.width));
  const cssWidth = widthPx + 2 * borderPx;
  const cssHeight = pictureH + 2 * borderPx + stemPx;

  const ratio = Math.min(MAX_CARD_PIXEL_RATIO, globalThis.devicePixelRatio || 1);
  const canvas = drawingSurface(Math.round(cssWidth * ratio), Math.round(cssHeight * ratio));
  const ctx = canvas.getContext('2d');
  ctx.scale(ratio, ratio);
  ctx.imageSmoothingQuality = 'high';

  // Border and stem are one fill: the picture is drawn inset over the plate, so
  // the border is whatever is left showing at the edges.
  ctx.fillStyle = borderColor;
  ctx.fillRect(0, 0, cssWidth, pictureH + 2 * borderPx);
  const stemW = Math.max(1, borderPx);
  ctx.fillRect((cssWidth - stemW) / 2, pictureH + 2 * borderPx, stemW, stemPx);
  ctx.drawImage(bitmap, borderPx, borderPx, widthPx, pictureH);

  return {
    // transferToImageBitmap where it exists: an ImageBitmap is the texture
    // source every renderer accepts, and it releases the canvas as it goes.
    image: canvas.transferToImageBitmap ? canvas.transferToImageBitmap() : canvas,
    width: canvas.width,
    height: canvas.height,
    cssHeight
  };
}

/**
 * Keyed on the frame's own bitmap, which is a fresh object every time a frame
 * lands — so a card is rebuilt exactly when the picture changes and not once
 * per redraw, and the entry retires itself when the poller closes the frame.
 * Weak so a closed frame takes its card with it.
 *
 * @type {WeakMap<ImageBitmap, {signature: string, card: ReturnType<typeof billboardCard>}>}
 */
const cardCache = new WeakMap();

/**
 * @param {ImageBitmap} bitmap
 * @param {{widthPx: number, borderPx: number, stemPx: number, borderColor: string}} shape
 * @returns {ReturnType<typeof billboardCard>}
 */
function cachedBillboardCard(bitmap, shape) {
  const signature = `${shape.widthPx}|${shape.borderPx}|${shape.stemPx}|${shape.borderColor}`;
  const hit = cardCache.get(bitmap);
  if (hit && hit.signature === signature) return hit.card;

  const card = billboardCard(bitmap, shape);
  cardCache.set(bitmap, { signature, card });
  return card;
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
 * @param {'billboard'|'footprint'} [params.options.mode='billboard']
 *   'billboard' stands each frame upright at its camera; 'footprint' lays it on
 *   the ground as a view trapezoid, which is worth having for a top-down view
 *   and misleading for anything else. See the module note.
 * @param {boolean} [params.options.showPoints=true]
 * @param {number} [params.options.widthPx=150] Billboard: card width on screen,
 *   in pixels. Height follows from the frame's aspect ratio.
 * @param {number} [params.options.borderPx=2] Billboard: border thickness.
 * @param {number} [params.options.stemPx=12] Billboard: length of the stem from
 *   the bottom of the card down to the camera position. 0 sits the card on it.
 * @param {string} [params.options.borderColor='#0b0e12'] Billboard: border and
 *   stem colour, as a CSS colour.
 * @param {number} [params.options.nearM=40]   Footprint: distance from the
 *   camera to the near edge, metres. Also sets how much the trapezoid flares.
 * @param {number} [params.options.lengthM=150] Footprint: how far it runs,
 *   metres. This is the size knob; width follows from the frame's aspect ratio.
 * @param {number} [params.options.opacity] Defaults to 1 for billboards, which
 *   are chrome and want to be crisp, and 0.92 for footprints, which sit on the
 *   basemap and want to let it through.
 * @param {'viewport'|'north'|number} [params.options.bearingFallback='viewport']
 *   Footprint only: what to do when `camera.bearingDeg` is null — which, as of
 *   Aug 2026, is every camera in the catalogue. 'viewport' lays the footprint
 *   out along the current view direction so imagery stays upright and legible
 *   from any angle; 'north' pins it; a number forces a fixed heading. Picks up
 *   the real bearing automatically the day the field is populated — no code
 *   change needed, the null check just stops firing. Billboards never need it:
 *   a card faces the viewer whatever the camera is pointed at.
 * @param {number} [params.options.viewportBearing=0] Current view bearing, for
 *   the 'viewport' fallback.
 * @returns {any[]} deck.gl layers
 */
export function createDatumfeedLayers({ cameras, frames, options = {} }) {
  const {
    mode = 'billboard',
    showPoints = true,
    widthPx = 150,
    borderPx = 2,
    stemPx = 12,
    borderColor = '#0b0e12',
    nearM = 40,
    lengthM = 150,
    opacity = mode === 'billboard' ? 1 : 0.92,
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
      // Every camera, polled or not: the unpolled ones are the whole point of
      // the frame cap, and under a billboard the dot is what its stem lands on.
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

    // fetchedAt in the id retires the old texture when a fresh frame lands.
    const id = `datumfeed-frame-${camera.id}-${frame.fetchedAt?.getTime() ?? 0}`;

    if (mode === 'footprint') {
      layers.push(
        new BitmapLayer({
          id,
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
      continue;
    }

    const card = cachedBillboardCard(frame.bitmap, { widthPx, borderPx, stemPx, borderColor });

    layers.push(
      new IconLayer({
        id,
        data: [camera],
        getPosition: (d) => [d.lon, d.lat],
        // One card per layer rather than one atlas for all of them: frames
        // arrive and expire independently, and repacking a shared atlas on
        // every arrival costs more than the extra draw calls do.
        iconAtlas: card.image,
        iconMapping: {
          card: {
            x: 0,
            y: 0,
            width: card.width,
            height: card.height,
            // Anchored at the tip of the stem, so that is what sits on the
            // camera and the card stands above it.
            anchorX: card.width / 2,
            anchorY: card.height
          }
        },
        getIcon: () => 'card',
        sizeUnits: 'pixels',
        getSize: card.cssHeight,
        // The whole mode in one prop: upright and facing the viewer, whatever
        // the map's pitch and bearing are doing.
        billboard: true,
        // Composited at display size already, so no mipmap chain to sample
        // from — asking for one on a texture that has none renders black.
        textureParameters: { minFilter: 'linear', magFilter: 'linear' },
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
