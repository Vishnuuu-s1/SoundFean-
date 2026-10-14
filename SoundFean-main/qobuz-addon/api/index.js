'use strict';

// Vercel serverless adapter for the BitChord / Bit-Perfect Music addon protocol.
// No Qobuz credentials are embedded in code or sent to addon clients.
const { createHash, timingSafeEqual } = require('node:crypto');

const QOBUZ_BASE = 'https://www.qobuz.com/api.json/0.2';
const MAX_RESULTS = 20;

const QUALITY = Object.freeze({
  LOW: { id: 5, codec: 'mp3', label: 'MP3 320 kbps' },
  HIGH: { id: 5, codec: 'mp3', label: 'MP3 320 kbps' },
  LOSSLESS: { id: 6, codec: 'flac', label: 'FLAC Lossless' },
  HI_RES: { id: 27, codec: 'flac', label: 'FLAC Hi-Res (if entitled)' },
  HIRES: { id: 27, codec: 'flac', label: 'FLAC Hi-Res (if entitled)' },
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
    version: '1.0.0',
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
    return {
      ok: false,
      status: response.status === 429 ? 429 : response.status === 401 || response.status === 403 ? 401 : 502,
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
      version: '1.0.0',
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
  const format = selectedFormat(stringParam(req, 'quality'));
  const timestamp = Math.floor(Date.now() / 1000);
  const result = await qobuzCall('/track/getFileUrl', {
    track_id: trackId,
    format_id: format.id,
    intent: 'stream',
    request_ts: timestamp,
    request_sig: makeSignature(trackId, format.id, timestamp, process.env.QOBUZ_APP_SECRET),
  });
  if (!result.ok) return respond(res, result.status, { error: result.error });
  let streamUrl;
  try {
    streamUrl = new URL(result.data.url);
    if (streamUrl.protocol !== 'https:') throw Error('Expected secure URL');
  } catch { return respond(res, 502, { error: 'No playable streaming URL returned by Qobuz.' }); }
  const mimeType = String(result.data.mime_type || (format.codec === 'flac' ? 'audio/flac' : 'audio/mpeg'));
  const sampleRateKhz = Number(result.data.sampling_rate);
  const bitDepth = Number(result.data.bit_depth);
  const actualCodec = /flac/i.test(mimeType) ? 'flac' : /mp3|mpeg/i.test(mimeType) ? 'mp3' : format.codec;
  return respond(res, 200, {
    url: streamUrl.toString(),
    format: actualCodec,
    codec: actualCodec,
    container: actualCodec,
    quality: actualCodec === 'flac' ? 'FLAC lossless (Qobuz)' : 'MP3 (Qobuz)',
    mimeType,
    encrypted: false,
    ...(Number.isFinite(sampleRateKhz) && sampleRateKhz > 0 ? { sampleRate: sampleRateKhz < 1000 ? sampleRateKhz * 1000 : sampleRateKhz } : {}),
    ...(Number.isFinite(bitDepth) && bitDepth > 0 ? { bitDepth } : {}),
  });
}

module.exports = handler;
module.exports._test = { validKey, configReady, manifest, makeSignature, selectedFormat, makeTrack, routeFromPath };
