'use strict';

// Vercel serverless adapter for the BitChord / Bit-Perfect Music addon protocol.
// No Qobuz credentials are embedded in code or sent to addon clients.
const { createHash, timingSafeEqual } = require('node:crypto');

const QOBUZ_BASE = 'https://www.qobuz.com/api.json/0.2';
const MAX_RESULTS = 20;

// BitChord requests `quality=LOSSLESS` even for its highest-quality source tier.
// Prefer the best Qobuz FLAC that this account/track is entitled to play.
// Requesting a tier does not prove that Qobuz returned it.
const QUALITY = Object.freeze({
  LOW: { ids: [5], codec: 'mp3' },
  HIGH: { ids: [5], codec: 'mp3' },
  CD: { ids: [6], codec: 'flac' },
  LOSSLESS: { ids: [27, 7, 6], codec: 'flac' },
  HI_RES: { ids: [27, 7, 6], codec: 'flac' },
  HIRES: { ids: [27, 7, 6], codec: 'flac' },
});

function respond(res, code, payload) {
  res.statusCode = code;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Accept, Content-Type');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.end(JSON.stringify(payload));
}

function stringParam(req, name) {
  const v = req.query?.[name];
  if (typeof v === 'string') return v;
  try {
    return new URL(req.url || '/', 'https://local.invalid').searchParams.get(name) || '';
  } catch { return ''; }
}

function validKey(given, expected) {
  if (!expected || !given || given.length !== expected.length) return false;
  return timingSafeEqual(Buffer.from(given), Buffer.from(expected));
}

function configReady() {
  return ['QOBUZ_APP_ID', 'QOBUZ_APP_SECRET', 'QOBUZ_USER_AUTH_TOKEN']
    .every((key) => Boolean(process.env[key]?.trim()));
}

function manifest() {
  return {
    id: 'dev.bitperfect.qobuz.personal',
    name: 'Qobuz · Personal Account',
    version: '1.1.0',
    resources: ['search', 'stream'],
    // Bit-Perfect downloads are opt-in. Only enable for tracks you're authorized to save.
    allowDownloads: process.env.ADDON_ALLOW_DOWNLOADS === 'true' ? 1 : 0,
    settings: [{
      key: 'quality',
      default: 'LOSSLESS',
      options: [{ value: 'LOSSLESS' }, { value: 'HI_RES' },
        { value: 'HIGH' }, { value: 'LOW' }],
    }],
  };
}

async function qobuzCall(path, params) {
  const url = new URL(QOBUZ_BASE + path);
  for (const [key, value] of Object.entries(params)) url.searchParams.set(key, String(value));
  let response;
  try {
    response = await fetch(url, {
      method: 'GET',
      headers: {
        'X-App-Id': process.env.QOBUZ_APP_ID,
        'X-User-Auth-Token': process.env.QOBUZ_USER_AUTH_TOKEN,
        Accept: 'application/json',
      },
      signal: AbortSignal.timeout(9000),
    });
  } catch {
    return { ok: false, status: 502, error: 'Qobuz service could not be reached.' };
  }
  let data;
  try { data = await response.json(); }
  catch { return { ok: false, status: 502, error: 'Invalid response from Qobuz.' }; }
  if (!response.ok || data?.status === 'error') {
    // Quality negotiation is permitted only for format/tier denials. A failed
    // signature, missing login, or rate limit should not trigger extra calls.
    const detail = String(data?.message || '') + ' ' + String(data?.code || '');
    const upstreamStatus = response.ok ? Number(data?.code) || 502 : response.status;
    const invalidAuth = /invalid.{0,16}(signature|token|credential)|expired.{0,16}token|request signature/i.test(detail);
    return {
      ok: false,
      status: upstreamStatus === 429 ? 429 : upstreamStatus === 401 || upstreamStatus === 403 ? 401 : 502,
      retryLowerQuality: [400, 403, 404, 422].includes(upstreamStatus) && !invalidAuth,
      error: 'Qobuz rejected the request. Check your account credentials, entitlements and availability.',
    };
  }
  return { ok: true, data };
}

function makeSignature(trackId, formatId, timestamp, secret) {
  const message = `trackgetFileUrlformat_id${formatId}intentstreamtrack_id${trackId}${timestamp}${secret}`;
  return createHash('md5').update(message).digest('hex');
}

function selectedFormat(value) {
  return QUALITY[(value || 'LOSSLESS').toUpperCase()] || QUALITY.LOSSLESS;
}

function makeTrack(track) {
  const art = track.album?.image || {};
  return {
    id: String(track.id),
    title: track.title || '',
    artist: track.performer?.name || track.artist?.name || 'Unknown Artist',
    album: track.album?.title || '',
    duration: Number(track.duration) || 0,
    artworkURL: art.large || art.extralarge || art.medium || null,
    format: '',
    audioQuality: '',
  };
}

// Vercel Services forwards the public path unchanged when destination.path selects /api.
// Match the public /qobuz routes without replacing SoundFean's existing /api backend.
function routeFromPath(req) {
  let pathname;
  try { pathname = new URL(req.url || '/', 'https://local.invalid').pathname; }
  catch { return {}; }
  if (pathname === '/qobuz/health') return { action: 'health' };
  const match = pathname.match(/^\/qobuz\/a\/([^/]+)\/(manifest\.json|search|stream\/([0-9]{1,15}))$/);
  if (!match) return {};
  let key;
  try { key = decodeURIComponent(match[1]); }
  catch { return {}; }
  return {
    action: match[2] === 'manifest.json' ? 'manifest' : match[2] === 'search' ? 'search' : 'stream',
    key,
    id: match[3] || '',
  };
}

async function handler(req, res) {
  if (req.method === 'OPTIONS') return respond(res, 204, {});
  if (req.method !== 'GET') return respond(res, 405, { error: 'Method not allowed.' });
  const route = routeFromPath(req);
  const action = route.action || stringParam(req, 'action');
  if (action === 'health') {
    return respond(res, 200, {
      status: 'online',
      configured: configReady(),
      protected: Boolean(process.env.ADDON_ACCESS_KEY),
      version: '1.1.0',
    });
  }
  if (!['manifest', 'search', 'stream'].includes(action)) {
    return respond(res, 404, { error: 'Unknown endpoint.' });
  }
  if (!process.env.ADDON_ACCESS_KEY) {
    return respond(res, 503, { error: 'Server owner must set ADDON_ACCESS_KEY in Vercel environment variables.' });
  }
  if (!validKey(route.key || stringParam(req, 'key'), process.env.ADDON_ACCESS_KEY)) {
    return respond(res, 401, { error: 'Invalid addon access key.' });
  }
  if (action === 'manifest') return respond(res, 200, manifest());
  if (!configReady()) {
    return respond(res, 503, {
      error: 'Qobuz account not configured. Set QOBUZ_APP_ID, QOBUZ_APP_SECRET and QOBUZ_USER_AUTH_TOKEN in Vercel.',
    });
  }
  if (action === 'search') {
    const query = stringParam(req, 'q').trim();
    if (query.length < 1 || query.length > 120) return respond(res, 400, { error: 'Search query must be 1–120 characters.' });
    const limit = Math.min(MAX_RESULTS, Math.max(1, parseInt(stringParam(req, 'limit'), 10) || 12));
    const result = await qobuzCall('/track/search', { query, limit, offset: 0 });
    if (!result.ok) return respond(res, result.status, { error: result.error });
    return respond(res, 200, {
      tracks: (Array.isArray(result.data?.tracks?.items) ? result.data.tracks.items : [])
        .filter((track) => Number.isSafeInteger(Number(track.id)) && Boolean(track.title))
        .slice(0, limit).map(makeTrack),
    });
  }
  const trackId = route.id || stringParam(req, 'id');
  if (!/^\d{1,15}$/.test(trackId)) return respond(res, 400, { error: 'Invalid Qobuz track ID.' });
  const selected = selectedFormat(stringParam(req, 'quality'));
  let file = null;
  let streamUrl = null;

  for (const [index, formatId] of selected.ids.entries()) {
    const timestamp = Math.floor(Date.now() / 1000);
    const result = await qobuzCall('/track/getFileUrl', {
      track_id: trackId,
      format_id: formatId,
      intent: 'stream',
      request_ts: timestamp,
      request_sig: makeSignature(trackId, formatId, timestamp, process.env.QOBUZ_APP_SECRET),
    });
    if (!result.ok) {
      if (index < selected.ids.length - 1 && result.retryLowerQuality) continue;
      return respond(res, result.status, { error: result.error });
    }
    try {
      streamUrl = new URL(result.data?.url);
      if (streamUrl.protocol !== 'https:') throw Error('Expected secure URL');
    } catch {
      // Sometimes Qobuz answers a format it cannot serve without a URL.
      if (index < selected.ids.length - 1) continue;
      return respond(res, 502, { error: 'No playable streaming URL returned by Qobuz.' });
    }
    file = result.data;
    break;
  }
  if (!file || !streamUrl) return respond(res, 502, { error: 'No playable audio available.' });

  // Use Qobuz's *returned* audio metadata, not the requested format ID.
  const responseFormatId = Number(file.format_id);
  const reportedMimeType = typeof file.mime_type === 'string' ? file.mime_type : '';
  const actualCodec = /flac/i.test(reportedMimeType) ? 'flac'
    : /mp3|mpeg/i.test(reportedMimeType) ? 'mp3'
    : [6, 7, 27].includes(responseFormatId) ? 'flac'
    : responseFormatId === 5 ? 'mp3'
    : selected.codec;
  const mimeType = reportedMimeType || (actualCodec === 'flac' ? 'audio/flac' : 'audio/mpeg');
  const sampleRateKhz = Number(file.sampling_rate);
  const sampleRate = Number.isFinite(sampleRateKhz) && sampleRateKhz > 0
    ? (sampleRateKhz < 1000 ? sampleRateKhz * 1000 : sampleRateKhz) : null;
  const reportedBits = Number(file.bit_depth);
  const bitDepth = Number.isInteger(reportedBits) && reportedBits >= 8 && reportedBits <= 32
    ? reportedBits : null;
  const parts = actualCodec === 'flac' ? ['Qobuz FLAC'] : ['Qobuz MP3'];
  if (actualCodec === 'flac' && bitDepth) parts.push(`${bitDepth}-bit`);
  if (actualCodec === 'flac' && sampleRate) parts.push(`${sampleRate / 1000} kHz`);
  if (actualCodec === 'flac' && !bitDepth) parts.push('precision unverified');

  return respond(res, 200, {
    url: streamUrl.toString(),
    format: actualCodec,
    codec: actualCodec,
    container: actualCodec,
    quality: parts.join(' · '),
    mimeType,
    encrypted: false,
    ...(sampleRate ? { sampleRate } : {}),
    ...(bitDepth ? { bitDepth } : {}),
  });
}

module.exports = handler;
module.exports._test = { validKey, configReady, manifest, makeSignature, selectedFormat, makeTrack, routeFromPath };
