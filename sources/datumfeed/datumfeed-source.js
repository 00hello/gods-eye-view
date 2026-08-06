// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Datumfeed
/**
 * Datumfeed source — public traffic-camera feeds, fetched by viewport.
 *
 * Renderer-agnostic on purpose: this file has zero imports and no DOM
 * dependencies beyond `fetch` / `createImageBitmap`, so it can back a deck.gl
 * BitmapLayer, a Cesium material, or a plain <canvas>. The deck.gl binding
 * lives next door in `deckgl-layers.js`.
 *
 * API reference: https://datumfeed.com/llms.txt
 *
 * Three obligations, all enforced here rather than left to the caller:
 *   1. Show `registry.attribution` next to any frame you render.
 *      -> `attributionsFor()` / `FramePoller#attributions`
 *   2. Do not poll a camera faster than its registry's `minPollIntervalS`.
 *      -> `FramePoller` schedules from the registry cadence, never a fixed timer.
 *   3. Stay inside the published rate limits, and slow down when the response
 *      headers say to.
 *      -> `RateLimiter`, one bucket per budget, driven by `X-RateLimit-*`.
 *
 * @module sources/datumfeed
 */

/**
 * @typedef {Object} DatumfeedRegistry
 * @property {string} slug
 * @property {string} name
 * @property {string} city
 * @property {string} country
 * @property {string} attribution     Display this next to every rendered frame.
 * @property {string} licenseName
 * @property {string} licenseUrl
 * @property {boolean|null} commercialOk  null means UNKNOWN, not "yes".
 * @property {boolean|null} proxyOk       false => /frame returns 403 for this source.
 * @property {boolean|null} pixelReadable false => the source's own server blocks
 *   cross-origin pixel reads. Irrelevant if you go through /frame, which is
 *   always CORS-clean; it matters only if you fetch `feedUrl` directly.
 * @property {number} [minPollIntervalS]  Only present on GET /api/registries.
 */

/**
 * @typedef {Object} DatumfeedCamera
 * @property {string} id
 * @property {string} name            Untrusted third-party text. Never innerHTML it.
 * @property {number} lat
 * @property {number} lon
 * @property {number|null} bearingDeg Direction the camera looks, degrees clockwise
 *   from north. Null across every registry as of Aug 2026 — treat it as absent
 *   and see `bearingFallback` in deckgl-layers.js.
 * @property {string} feedUrl
 * @property {string} feedType        'jpeg_poll' is the only type served today.
 * @property {'unverified'|'auto_checked'|'verified'|'contradicted'} verificationStatus
 * @property {string} verificationNotes
 * @property {boolean} active
 * @property {DatumfeedRegistry} registry  No minPollIntervalS on this copy.
 * @property {{uptime24h:number, uptime7d:number, lastOkAt:string, lastCheckedAt:string,
 *            fresh:boolean, trustScore:number|null}} stats
 */

/**
 * @typedef {Object} DatumfeedFrame
 * @property {ImageBitmap} bitmap
 * @property {Date|null} fetchedAt When the API last pulled this frame from the
 *   source (`Last-Modified`), not when you asked for it.
 * @property {number|null} maxAgeS  `Cache-Control: max-age` on this response —
 *   how long until a different image can exist. Asking again sooner re-serves
 *   identical bytes and still costs a request.
 */

const DEFAULT_BASE_URL = 'https://datumfeed.com/api';

/** The API caps `limit` at 500; asking for more is a 400. */
const MAX_PAGE_SIZE = 500;

/**
 * Fallback cadence if /api/registries is unreachable. This is the *slowest*
 * cadence in the catalogue, so falling back to it can never outrun a source.
 * Verified against the live endpoint 2026-08-06: five registries publish 60,
 * tfl-jamcams publishes 180, and nothing publishes more.
 */
const FALLBACK_POLL_INTERVAL_S = 180;

/** Published anonymous budgets, per hour, per IP. Both are per-scope. */
const ANON_LIMITS = { browse: 60, frame: 300 };

/** Published budgets with a free API key, per hour. */
const KEYED_LIMITS = { browse: 3600, frame: 36000 };

/** Wait this long after a 429 that carries no Retry-After. */
const DEFAULT_429_BACKOFF_S = 60;

/** Thrown for any non-2xx API response, with the status left inspectable. */
export class DatumfeedError extends Error {
  /**
   * @param {string} message
   * @param {number} status
   * @param {{retryAfterS?: number, cameraId?: string}} [detail]
   */
  constructor(message, status, detail = {}) {
    super(message);
    this.name = 'DatumfeedError';
    this.status = status;
    this.retryAfterS = detail.retryAfterS;
    this.cameraId = detail.cameraId;
  }
}

/** Human-readable reasons for the /frame error codes, so callers can skip vs. retry. */
const FRAME_ERRORS = {
  403: 'source is directory-only; its terms do not permit proxying',
  404: 'unknown camera id',
  410: 'camera is inactive',
  501: 'unsupported feed type',
  502: 'source unreachable and nothing cached'
};

/** @returns {Error} an AbortError, however this runtime spells one. */
function abortError() {
  if (typeof DOMException === 'function') return new DOMException('Aborted', 'AbortError');
  const error = new Error('Aborted');
  error.name = 'AbortError';
  return error;
}

/** True for the error `fetch` and the sleeps below throw on abort. */
export function isAbortError(error) {
  return Boolean(error) && /** @type {Error} */ (error).name === 'AbortError';
}

/**
 * @param {number} ms
 * @param {AbortSignal} [signal]
 * @returns {Promise<void>}
 */
function sleep(ms, signal) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(abortError());
      return;
    }
    /** @type {any} */
    let timer;
    const onAbort = () => {
      clearTimeout(timer);
      reject(abortError());
    };
    timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

/**
 * A numeric header, or NaN when it is absent.
 *
 * Not `Number(headers.get(name))`: a missing header is `null`, and `Number(null)`
 * is **0**, not NaN. Read that way, one response without rate-limit headers —
 * a CDN error page, a proxy that strips them — looks exactly like "you have 0
 * requests left" and stalls the bucket.
 *
 * @param {Headers} headers
 * @param {string} name
 * @returns {number} NaN when absent or unparseable
 */
function headerNumber(headers, name) {
  const raw = headers.get(name);
  if (raw === null || raw.trim() === '') return NaN;
  const value = Number(raw);
  return Number.isFinite(value) ? value : NaN;
}

/**
 * `X-RateLimit-Reset` is an epoch, but headers like it are a delta about as
 * often, so accept either rather than mis-sleep by 56 years.
 *
 * @param {number} value
 * @param {number} now epoch ms
 * @returns {number} epoch ms, or 0 if unusable
 */
function resetToEpochMs(value, now) {
  if (!Number.isFinite(value) || value <= 0) return 0;
  if (value > 1e12) return value; // already ms
  if (value > 1e9) return value * 1000; // epoch seconds
  return now + value * 1000; // seconds from now
}

/**
 * One shared budget, spent by every caller that goes through it.
 *
 * A concurrency cap is not a rate cap: six-at-a-time still issues hundreds of
 * requests a minute if each finishes fast, which is exactly how a viewport full
 * of cameras walks into a 429 storm. This is a token bucket — a sustained rate
 * plus a small burst — and it also *listens*: every response feeds
 * `X-RateLimit-Remaining` and `X-RateLimit-Reset` back in, so the real server-
 * side budget always wins over our local guess, whoever else on this IP has
 * been spending it.
 *
 * Waiters sleep with jitter, so a bucket that empties does not refill into a
 * thundering herd of simultaneous retries.
 */
export class RateLimiter {
  /**
   * @param {Object} options
   * @param {number} options.limitPerHour Starting guess; corrected by headers.
   * @param {number} [options.burst=6] Requests allowed back-to-back from idle.
   * @param {() => number} [options.now] Injectable clock, for tests.
   */
  constructor({ limitPerHour, burst = 6, now = () => Date.now() }) {
    this._now = now;
    this.burst = Math.max(1, burst);
    this.setLimit(limitPerHour);
    this.tokens = this.burst;
    this._lastRefill = this._now();
    /** Epoch ms before which nothing may go out (429 / exhausted window). */
    this.blockedUntil = 0;
  }

  /** @param {number} limitPerHour */
  setLimit(limitPerHour) {
    this.limitPerHour = Math.max(1, limitPerHour);
    this.refillPerMs = this.limitPerHour / 3_600_000;
    this.capacity = Math.min(this.burst, this.limitPerHour);
    if (this.tokens > this.capacity) this.tokens = this.capacity;
  }

  /** @param {number} now epoch ms */
  _refill(now) {
    const elapsed = Math.max(0, now - this._lastRefill);
    this._lastRefill = now;
    this.tokens = Math.min(this.capacity, this.tokens + elapsed * this.refillPerMs);
  }

  /**
   * Spend one request, waiting as long as the budget requires.
   * @param {AbortSignal} [signal]
   */
  async acquire(signal) {
    for (;;) {
      const now = this._now();
      this._refill(now);

      const blockedFor = this.blockedUntil - now;
      if (blockedFor > 0) {
        // Spread wakeups across a second so everything held by one window
        // reset does not fire in the same tick.
        await sleep(blockedFor + Math.random() * 1000, signal);
        continue;
      }
      if (this.tokens >= 1) {
        this.tokens -= 1;
        return;
      }
      const deficitMs = (1 - this.tokens) / this.refillPerMs;
      await sleep(deficitMs + Math.random() * 250, signal);
    }
  }

  /**
   * Fold a response's rate-limit headers back into the bucket. The server is
   * the authority: if it says 3 left, we hold at most 3 whatever we thought.
   *
   * @param {{limit:number, remaining:number, resetAt:number}} info
   */
  observe({ limit, remaining, resetAt }) {
    const now = this._now();
    if (Number.isFinite(limit) && limit > 0 && limit !== this.limitPerHour) {
      this.setLimit(limit);
    }
    if (Number.isFinite(remaining)) {
      this._refill(now);
      this.tokens = Math.min(this.tokens, Math.max(0, remaining));
      if (remaining <= 0) {
        const until = resetToEpochMs(resetAt, now);
        if (until > now) this.blockedUntil = Math.max(this.blockedUntil, until);
      }
    }
  }

  /**
   * Hold everything for a while — used on a 429, whose `Retry-After` is the
   * only trustworthy number in that response.
   * @param {number} [seconds]
   */
  penalize(seconds = DEFAULT_429_BACKOFF_S) {
    const until = this._now() + Math.max(1, seconds) * 1000;
    this.blockedUntil = Math.max(this.blockedUntil, until);
    this.tokens = 0;
  }

  /** Seconds until this bucket will let a request through. 0 when it will now. */
  get delayS() {
    const now = this._now();
    if (this.blockedUntil > now) return (this.blockedUntil - now) / 1000;
    const tokens = Math.min(this.capacity, this.tokens + (now - this._lastRefill) * this.refillPerMs);
    return tokens >= 1 ? 0 : (1 - tokens) / this.refillPerMs / 1000;
  }
}

/**
 * A viewport-driven client for the Datumfeed camera API.
 *
 * Anonymous use needs no key: 60 requests/hour for browsing and 300/hour for
 * frames, per IP. That is enough to build against and enough to keep a handful
 * of cameras live — at a 60 s cadence, 300 frames/hour is about five cameras.
 * A free key lifts it to 3,600 / 36,000, which is where a whole-city viewport
 * becomes possible. Requests are paced to whichever budget applies rather than
 * fired and retried, so exceeding it degrades into slower refreshes instead of
 * a wall of 429s.
 *
 * Keys belong in the host app's config or environment, never in source —
 * nothing here ever writes one to disk or logs it.
 *
 * @example
 * const source = new DatumfeedSource({minTrust: 70});
 * const cams = await source.camerasInBbox([-97.75, 30.26, -97.73, 30.28]);
 */
export class DatumfeedSource {
  /**
   * @param {Object} [options]
   * @param {string} [options.apiKey]   Optional. Sent as `Authorization: Bearer`.
   * @param {string} [options.baseUrl]
   * @param {number} [options.minTrust] 0-100. Cameras that have never been polled
   *   (null trustScore) are excluded by the API, not treated as 0.
   * @param {'unverified'|'auto_checked'|'verified'|'contradicted'} [options.verificationStatus]
   *   Exact match on one status, not a floor: `'auto_checked'` returns *only*
   *   auto-checked cameras and excludes the `'verified'` ones. `minTrust` is
   *   almost always the filter you actually want.
   * @param {typeof fetch} [options.fetch] Injectable for tests.
   * @param {(info: {limit:number, remaining:number, resetAt:number, scope:string, delayS:number}) => void} [options.onRateLimit]
   * @param {{browse?:number, frame?:number}} [options.rateLimits] Override the
   *   assumed per-hour budgets. Rarely needed — headers correct them anyway.
   */
  constructor(options = {}) {
    const {
      apiKey,
      baseUrl = DEFAULT_BASE_URL,
      minTrust,
      verificationStatus,
      fetch: fetchImpl,
      onRateLimit,
      rateLimits = {}
    } = options;

    this.baseUrl = baseUrl.replace(/\/$/, '');
    this.minTrust = minTrust;
    this.verificationStatus = verificationStatus;
    this.onRateLimit = onRateLimit;

    // Held privately so it never lands in a serialized layer prop or a log line.
    this._apiKey = apiKey || null;
    this._fetch = fetchImpl || ((...args) => globalThis.fetch(...args));

    const defaults = this._apiKey ? KEYED_LIMITS : ANON_LIMITS;
    /**
     * One bucket per budget. Browsing and frames drain independently server-
     * side, so they must not share a bucket here either.
     */
    this.limiters = {
      browse: new RateLimiter({ limitPerHour: rateLimits.browse ?? defaults.browse, burst: 4 }),
      frame: new RateLimiter({ limitPerHour: rateLimits.frame ?? defaults.frame, burst: 6 })
    };

    /** @type {Promise<Map<string, DatumfeedRegistry>>|null} */
    this._registriesPromise = null;
  }

  /** @returns {HeadersInit} */
  _headers() {
    return this._apiKey ? { Authorization: `Bearer ${this._apiKey}` } : {};
  }

  /**
   * Every request goes through here: wait for budget, spend it, then feed the
   * response's headers straight back into the bucket.
   *
   * @param {'browse'|'frame'} scope
   * @param {string|URL} url
   * @param {AbortSignal} [signal]
   * @returns {Promise<Response>}
   */
  async _request(scope, url, signal) {
    const limiter = this.limiters[scope];
    await limiter.acquire(signal);

    const response = await this._fetch(url, { headers: this._headers(), signal });

    const limit = headerNumber(response.headers, 'X-RateLimit-Limit');
    const remaining = headerNumber(response.headers, 'X-RateLimit-Remaining');
    const resetAt = headerNumber(response.headers, 'X-RateLimit-Reset');
    limiter.observe({ limit, remaining, resetAt });

    if (response.status === 429) {
      limiter.penalize(headerNumber(response.headers, 'Retry-After') || undefined);
    }
    if (this.onRateLimit && Number.isFinite(remaining)) {
      this.onRateLimit({ limit, remaining, resetAt, scope, delayS: limiter.delayS });
    }
    return response;
  }

  /**
   * @param {string} path
   * @param {Record<string, string|number|undefined>} [params]
   * @param {AbortSignal} [signal]
   */
  async _getJson(path, params = {}, signal) {
    const url = new URL(this.baseUrl + path);
    // Only append params we actually have: the API 400s on unknown *or* empty
    // params rather than ignoring them.
    for (const [key, value] of Object.entries(params)) {
      if (value !== undefined && value !== null) url.searchParams.set(key, String(value));
    }

    const response = await this._request('browse', url, signal);

    if (!response.ok) {
      const retryAfterS = headerNumber(response.headers, 'Retry-After') || undefined;
      let detail = '';
      try {
        detail = (await response.json())?.error ?? '';
      } catch {
        /* non-JSON error body; the status is enough */
      }
      throw new DatumfeedError(
        `GET ${path} failed (${response.status})${detail ? `: ${detail}` : ''}`,
        response.status,
        { retryAfterS }
      );
    }
    return response.json();
  }

  /**
   * Registry metadata, fetched once and cached for the process lifetime.
   *
   * This is the only endpoint that carries `minPollIntervalS` — the copy of
   * `registry` embedded in each camera omits it — so the poll cadence has to
   * come from here.
   *
   * @returns {Promise<Map<string, DatumfeedRegistry>>} keyed by slug
   */
  registries() {
    if (!this._registriesPromise) {
      this._registriesPromise = this._getJson('/registries')
        // Bare array, not a {registries: [...]} wrapper.
        .then((list) => new Map(list.map((r) => [r.slug, r])))
        .catch((error) => {
          this._registriesPromise = null; // let a later call retry
          throw error;
        });
    }
    return this._registriesPromise;
  }

  /**
   * Every camera inside a bounding box, following pagination to the end.
   *
   * Dense metros run past 1,000 cameras, so an unpaged request never returns
   * the whole set. `max` is the escape hatch for a viewport you only want a
   * sample of; pagination stops as soon as it is reached. Each page is a
   * request against the browse budget — anonymously that is 60/hour, so a
   * five-page metro sweep is not free.
   *
   * @param {[number, number, number, number]} bbox [minLon, minLat, maxLon, maxLat]
   * @param {Object} [options]
   * @param {number} [options.max=Infinity] Stop after roughly this many cameras.
   * @param {number} [options.pageSize=500]
   * @param {AbortSignal} [options.signal]
   * @returns {Promise<{cameras: DatumfeedCamera[], total: number, truncated: boolean}>}
   */
  async camerasInBbox(bbox, options = {}) {
    const { max = Infinity, pageSize = MAX_PAGE_SIZE, signal } = options;
    const limit = Math.min(pageSize, MAX_PAGE_SIZE, max);

    /** @type {DatumfeedCamera[]} */
    const cameras = [];
    let offset = 0;
    let total = 0;

    for (;;) {
      const page = await this._getJson(
        '/cameras',
        {
          bbox: bbox.join(','),
          limit,
          offset,
          minTrust: this.minTrust,
          verificationStatus: this.verificationStatus
        },
        signal
      );

      total = page.total;
      cameras.push(...page.cameras);
      offset += page.count;

      if (!page.hasMore || cameras.length >= max || page.count === 0) break;
    }

    return {
      cameras: cameras.slice(0, max === Infinity ? undefined : max),
      total,
      truncated: cameras.length < total
    };
  }

  /**
   * Direct URL for a camera's current frame.
   *
   * Fine for `<img src>`, but note that a bare URL bypasses everything this
   * client does about pacing — the browser will fire as many as you give it.
   * Prefer `frameBitmap()`, which spends the shared budget properly and, if an
   * API key is configured, actually sends it (a URL cannot carry a header, so
   * `<img src>` silently spends the lower anonymous budget instead).
   *
   * @param {string} cameraId
   */
  frameUrl(cameraId) {
    return `${this.baseUrl}/cameras/${encodeURIComponent(cameraId)}/frame`;
  }

  /** True when frames must go through `frameBitmap()` to use the configured key. */
  get requiresAuthenticatedFrames() {
    return this._apiKey !== null;
  }

  /**
   * Fetch one frame as an ImageBitmap, ready for `gl.texImage2D` or a deck.gl
   * BitmapLayer `image` prop.
   *
   * /frame is served with `Access-Control-Allow-Origin: *` on every camera,
   * which is what makes the pixel read work at all — most upstream sources send
   * no CORS headers, so fetching `feedUrl` directly would taint the canvas.
   *
   * @param {string} cameraId
   * @param {Object} [options]
   * @param {number} [options.maxWidth=1280] Ceiling, not a target: a frame
   *   narrower than this is left alone. Most of these cameras are 320-640 px
   *   wide, and upscaling them would spend texture memory to add nothing.
   *   Set to 0 to disable resizing entirely.
   * @param {AbortSignal} [options.signal]
   * @returns {Promise<DatumfeedFrame>}
   */
  async frameBitmap(cameraId, options = {}) {
    const { maxWidth = 1280, signal } = options;

    const response = await this._request('frame', this.frameUrl(cameraId), signal);

    if (!response.ok) {
      const retryAfterS = headerNumber(response.headers, 'Retry-After') || undefined;
      const reason = FRAME_ERRORS[response.status] || `HTTP ${response.status}`;
      throw new DatumfeedError(`frame ${cameraId}: ${reason}`, response.status, {
        retryAfterS,
        cameraId
      });
    }

    // Last-Modified is when the frame was actually pulled from the source, which
    // is not the same as now: a down source keeps serving its last good frame.
    const lastModified = response.headers.get('Last-Modified');
    const maxAgeS = parseMaxAgeS(response.headers.get('Cache-Control'));
    const blob = await response.blob();

    // Decode first, then decide. `createImageBitmap(blob, {resizeWidth})` is a
    // resize, not a cap — handing it a 480 px frame would blow it up to 1280.
    const decoded = await createImageBitmap(blob);
    let bitmap = decoded;
    if (maxWidth > 0 && decoded.width > maxWidth) {
      bitmap = await createImageBitmap(decoded, {
        resizeWidth: maxWidth,
        resizeHeight: Math.max(1, Math.round((decoded.height * maxWidth) / decoded.width)),
        resizeQuality: 'medium'
      });
      decoded.close?.();
    }

    return { bitmap, fetchedAt: lastModified ? new Date(lastModified) : null, maxAgeS };
  }

  /**
   * The registry cadence for a camera, in ms. Falls back to the slowest cadence
   * in the catalogue if the registry list has not loaded — erring slow keeps us
   * polite rather than hammering a source we have no metadata for.
   *
   * @param {DatumfeedCamera} camera
   */
  async minPollIntervalMs(camera) {
    let seconds = FALLBACK_POLL_INTERVAL_S;
    try {
      const registry = (await this.registries()).get(camera.registry.slug);
      if (registry?.minPollIntervalS) seconds = registry.minPollIntervalS;
    } catch {
      /* keep the conservative fallback */
    }
    return seconds * 1000;
  }

  /**
   * Distinct attribution strings for a set of cameras — what a credit line has
   * to display. Sorted for a stable render.
   *
   * @param {DatumfeedCamera[]} cameras
   * @returns {string[]}
   */
  attributionsFor(cameras) {
    return [...new Set(cameras.map((c) => c.registry.attribution).filter(Boolean))].sort();
  }
}

/**
 * `Cache-Control: public, max-age=60` -> 60. Null when absent or unparseable.
 * @param {string|null} header
 * @returns {number|null}
 */
function parseMaxAgeS(header) {
  if (!header) return null;
  const match = /(?:^|[\s,])max-age\s*=\s*(\d+)/i.exec(header);
  if (!match) return null;
  const seconds = Number(match[1]);
  return Number.isFinite(seconds) && seconds > 0 ? seconds : null;
}

/** Squared great-circle-ish distance, good enough for ranking within a viewport. */
function approxDistanceSq(camera, [lon, lat]) {
  const scale = Math.cos(lat * (Math.PI / 180));
  const dx = (camera.lon - lon) * scale;
  const dy = camera.lat - lat;
  return dx * dx + dy * dy;
}

/**
 * Keeps a set of cameras' frames current without ever outrunning the sources —
 * or the rate limit.
 *
 * Two independent brakes, because they solve different problems:
 *
 *   - **Cadence** comes from each camera's registry (`minPollIntervalS`), and
 *     from that response's own `Cache-Control: max-age` when it asks for more.
 *     Polling faster than that re-serves identical cached bytes, so the limit
 *     costs nothing in freshness.
 *   - **Fan-out** is capped by `maxFrames`. Cadence alone does not bound spend:
 *     600 cameras at 60 s is 36,000 requests an hour, which is the whole keyed
 *     budget and 120x the anonymous one. Only the `maxFrames` cameras nearest
 *     the view centre are polled; everything else stays a point on the map,
 *     which costs nothing. Anonymously, ~5 cameras at a 60 s cadence is what
 *     300 frames/hour actually buys.
 *
 * Underneath both, `DatumfeedSource`'s token bucket paces the requests and
 * backs off on `Retry-After`, so overshooting degrades into slower refreshes
 * rather than a 429 storm. Retries are jittered so a window reset does not wake
 * every camera in the same tick.
 *
 * @example
 * const poller = new FramePoller(source, {onFrame: () => deck.setProps({layers: build()})});
 * poller.setCameras(visibleCameras, {center: [viewState.longitude, viewState.latitude]});
 */
export class FramePoller {
  /**
   * @param {DatumfeedSource} source
   * @param {Object} [options]
   * @param {(cameraId: string, frame: DatumfeedFrame) => void} [options.onFrame]
   * @param {(cameraId: string, error: DatumfeedError|Error) => void} [options.onError]
   * @param {number} [options.maxWidth=1280] Ceiling on decoded frame width.
   * @param {number} [options.concurrency=6] Parallel frame fetches.
   * @param {number} [options.maxFrames=24] Poll at most this many cameras — the
   *   ones nearest the view centre. The rest are left as points.
   */
  constructor(source, options = {}) {
    const { onFrame, onError, maxWidth = 1280, concurrency = 6, maxFrames = 24 } = options;
    this.source = source;
    this.onFrame = onFrame;
    this.onError = onError;
    this.maxWidth = maxWidth;
    this.concurrency = concurrency;
    this.maxFrames = maxFrames;

    /** @type {Map<string, {camera: DatumfeedCamera, timer: any, token: number}>} */
    this._tracked = new Map();
    /** @type {Map<string, DatumfeedFrame>} */
    this.frames = new Map();
    /** @type {string[]} */
    this.attributions = [];
    /** Cameras actually being polled, nearest-first. The rest render as points. */
    this.polled = [];
    this._inFlight = 0;
    this._queue = [];
    this._stopped = false;
    this._nextToken = 1;
    this._abort = new AbortController();
  }

  /**
   * Replace the tracked set — call this on viewport change.
   *
   * Cameras that stay in view keep their existing schedule rather than
   * restarting, so panning around does not re-trigger fetches.
   *
   * @param {DatumfeedCamera[]} cameras Everything in view.
   * @param {Object} [options]
   * @param {[number, number]} [options.center] [lon, lat] of the view centre.
   *   Without it, the first `maxFrames` cameras are polled instead of the
   *   nearest ones.
   */
  setCameras(cameras, options = {}) {
    const { center } = options;
    this.polled = this._selectPolled(cameras, center);
    const next = new Set(this.polled.map((c) => c.id));

    for (const [id, entry] of this._tracked) {
      if (!next.has(id)) {
        clearTimeout(entry.timer);
        this._tracked.delete(id);
        this.frames.get(id)?.bitmap?.close?.();
        this.frames.delete(id);
      }
    }

    for (const camera of this.polled) {
      if (!this._tracked.has(camera.id)) this._track(camera);
    }

    // Credit every registry on screen, points included — the points are their
    // data too, not just the frames.
    this.attributions = this.source.attributionsFor(cameras);
  }

  /**
   * @param {DatumfeedCamera[]} cameras
   * @param {[number, number]} [center]
   * @returns {DatumfeedCamera[]}
   */
  _selectPolled(cameras, center) {
    if (cameras.length <= this.maxFrames) return [...cameras];
    if (!center) return cameras.slice(0, this.maxFrames);
    return [...cameras]
      .sort((a, b) => approxDistanceSq(a, center) - approxDistanceSq(b, center))
      .slice(0, this.maxFrames);
  }

  /** @param {DatumfeedCamera} camera */
  async _track(camera) {
    // A pan away and back can re-enter this before the await below resolves.
    // The token is what tells the stale call that its entry is gone, so it does
    // not schedule a second timer for a camera that already has one.
    const token = this._nextToken++;
    this._tracked.set(camera.id, { camera, timer: null, token });

    const intervalMs = await this.source.minPollIntervalMs(camera);

    const entry = this._tracked.get(camera.id);
    if (this._stopped || !entry || entry.token !== token) return;
    // Straight to the queue: the concurrency cap and the client's token bucket,
    // not an artificial delay, are what stop a large viewport from bursting.
    this._schedule(camera.id, 0, intervalMs, token);
  }

  /**
   * @param {string} cameraId
   * @param {number} delayMs
   * @param {number} intervalMs
   * @param {number} token
   */
  _schedule(cameraId, delayMs, intervalMs, token) {
    const entry = this._tracked.get(cameraId);
    if (!entry || entry.token !== token) return;
    entry.timer = setTimeout(() => this._enqueue(cameraId, intervalMs, token), delayMs);
  }

  /**
   * @param {string} cameraId
   * @param {number} intervalMs
   * @param {number} token
   */
  _enqueue(cameraId, intervalMs, token) {
    this._queue.push({ cameraId, intervalMs, token });
    this._drain();
  }

  _drain() {
    while (this._inFlight < this.concurrency && this._queue.length > 0) {
      const job = this._queue.shift();
      this._inFlight += 1;
      this._fetchOnce(job.cameraId, job.intervalMs, job.token).finally(() => {
        this._inFlight -= 1;
        this._drain();
      });
    }
  }

  /**
   * @param {string} cameraId
   * @param {number} intervalMs
   * @param {number} token
   */
  async _fetchOnce(cameraId, intervalMs, token) {
    const current = () => {
      const entry = this._tracked.get(cameraId);
      return !this._stopped && entry && entry.token === token ? entry : null;
    };
    if (!current()) return;

    try {
      const frame = await this.source.frameBitmap(cameraId, {
        maxWidth: this.maxWidth,
        signal: this._abort.signal
      });
      if (!current()) {
        frame.bitmap.close?.();
        return;
      }
      this.frames.get(cameraId)?.bitmap?.close?.();
      this.frames.set(cameraId, frame);
      this.onFrame?.(cameraId, frame);

      // The response says how long this exact image is valid for; asking again
      // before then spends a request to receive identical bytes.
      const nextMs = Math.max(intervalMs, (frame.maxAgeS ?? 0) * 1000);
      // +0-10% jitter so cameras that started together do not stay in lockstep.
      this._schedule(cameraId, nextMs * (1 + Math.random() * 0.1), intervalMs, token);
    } catch (error) {
      if (isAbortError(error)) return; // stop() — not a failure worth reporting
      this.onError?.(cameraId, /** @type {Error} */ (error));

      const status = /** @type {DatumfeedError} */ (error).status;
      // 403/404/410/501 are permanent for this camera — stop asking.
      if ([403, 404, 410, 501].includes(status)) {
        const entry = this._tracked.get(cameraId);
        if (entry) clearTimeout(entry.timer);
        this._tracked.delete(cameraId);
        return;
      }

      // 429 hands back an explicit wait; anything else gets a slow retry. Both
      // are jittered by up to half again: a rate-limit window resets for every
      // camera at once, and retrying in unison is how you earn a second 429.
      const retryAfterS = /** @type {DatumfeedError} */ (error).retryAfterS;
      const baseMs = retryAfterS ? retryAfterS * 1000 : intervalMs * 2;
      this._schedule(cameraId, baseMs * (1 + Math.random() * 0.5), intervalMs, token);
    }
  }

  /** Stop all polling, abort anything in flight, and release decoded frames. */
  stop() {
    this._stopped = true;
    this._abort.abort();
    for (const entry of this._tracked.values()) clearTimeout(entry.timer);
    this._tracked.clear();
    this._queue.length = 0;
    this.polled = [];
    for (const frame of this.frames.values()) frame.bitmap?.close?.();
    this.frames.clear();
  }
}
