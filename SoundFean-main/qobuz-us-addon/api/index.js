'use strict';
// Dedicated Bit-Perfect Qobuz US addon. Personal authorized access only.
// Keep credentials in the Vercel service environment; never hardcode or expose them.
const { createHash, timingSafeEqual } = require('node:crypto');
const QOBUZ_BASE = 'https://www.qobuz.com/api.json/0.2';
const MAX_RESULTS = 20;
const FORMATS = Object.freeze({
  LOW: [5], HIGH: [5], CD: [6], LOSSLESS: [27, 7, 6], HI_RES: [27, 7, 6], HIRES: [27, 7, 6],
});
const VARS = Object.freeze({
  appId: 'QOBUZ_US_APP_ID', secret: 'QOBUZ_US_APP_SECRET',
  token: 'QOBUZ_US_USER_AUTH_TOKEN', key: 'QOBUZ_US_ACCESS_KEY',
});
const env = (name) => (process.env[name] || '').trim();
function respond(res, status, data) {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Accept, Content-Type');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  return res.end(JSON.stringify(data));
}
function param(req, name) {
  if (typeof req.query?.[name] === 'string') return req.query[name];
  try { return new URL(req.url || '/', 'https://placeholder.invalid').searchParams.get(name) || ''; }
  catch { return ''; }
}
function validKey(input, expected) {
  if (!input || !expected || Buffer.byteLength(input) !== Buffer.byteLength(expected)) return false;
  return timingSafeEqual(Buffer.from(input), Buffer.from(expected));
}
function pathCandidates(req) {
  const values = [
    req.url, req.originalUrl, req.headers?.['x-vercel-original-path'],
    req.headers?.['x-original-uri'], req.headers?.['x-forwarded-uri'], req.headers?.['x-rewrite-url'],
  ];
  const paths = [];
  for (const value of values) {
    if (typeof value !== 'string' || !value.startsWith('/')) continue;
    try {
      const path = new URL(value, 'https://placeholder.invalid').pathname.replace(/\/+$/, '') || '/';
      if (!paths.includes(path)) paths.push(path);
    } catch { /* Ignore malformed path metadata. */ }
  }
  return paths;
}
function route(req) {
  for (const path of pathCandidates(req)) {
    if (['/qobuz-us/health', '/health', '/api/health'].includes(path)) return { action: 'health' };
    // Accommodates Vercel's public path and service-forwarded path variants.
    const match = path.match(/^\/(?:api\/)?(?:qobuz-us\/)?(?:api\/)?a\/([^/]+)(?:\/(manifest\.json|search|stream\/([0-9]{1,15})))?$/);
    if (!match) continue;
    let key;
    try { key = decodeURIComponent(match[1]); } catch { continue; }
    return {
      action: !match[2] || match[2] === 'manifest.json' ? 'manifest'
        : match[2] === 'search' ? 'search' : 'stream',
      key, id: match[3] || '',
    };
  }
  return {};
}
function ready() { return [VARS.appId, VARS.secret, VARS.token].every(x => Boolean(env(x))); }
function manifest() {
  return {
    id: 'dev.bitperfect.qobuz.us.personal',
    name: 'Qobuz US · Personal Account',
    version: '1.0.0-us',
    resources: ['search', 'stream'],
    allowDownloads: 0,
    settings: [{ key: 'quality', default: 'LOSSLESS', options: [
      { value: 'LOSSLESS' }, { value: 'HI_RES' }, { value: 'HIGH' }, { value: 'LOW' },
    ] }],
  };
}
async function upstream(path, params) {
  const url = new URL(QOBUZ_BASE + path);
  for (const [key, value] of Object.entries(params)) url.searchParams.set(key, String(value));
  let response;
  try {
    response = await fetch(url, {
      headers: {
        'X-App-Id': env(VARS.appId),
        'X-User-Auth-Token': env(VARS.token),
        Accept: 'application/json',
      },
      signal: AbortSignal.timeout(9000),
    });
  } catch (e) {
    console.error('Qobuz US transport error', { endpoint: path, type: e?.name || 'Error' });
    return { ok: false, status: 502, error: 'Qobuz service unreachable.' };
  }
  let data;
  try { data = await response.json(); }
  catch {
    console.error('Qobuz US invalid JSON', { endpoint: path, status: response.status });
    return { ok: false, status: 502, error: 'Invalid upstream response.' };
  }
  if (!response.ok || data?.status === 'error') {
    const upstreamStatus = response.ok ? Number(data?.code) || 502 : response.status;
    const message = String(data?.message || 'No detail').slice(0, 160);
    // These logs are diagnostic, and deliberately never include URLs or credentials.
    console.error('Qobuz US upstream error', { endpoint: path, upstreamStatus, message });
    const deniedAuth = /invalid.{0,16}(signature|token|credential)|expired.{0,16}token|request signature/i.test(message);
    return {
      ok: false,
      status: upstreamStatus === 429 ? 429 : [401, 403].includes(upstreamStatus) ? 401 : 502,
      retryLowerQuality: [400, 403, 404, 422].includes(upstreamStatus) && !deniedAuth,
      error: 'Qobuz rejected the request; check account authorization, access, and entitlements.',
    };
  }
  return { ok: true, data };
}
function makeSignature(trackId, formatId, timestamp, secret) {
  const content = `trackgetFileUrlformat_id${formatId}intentstreamtrack_id${trackId}${timestamp}${secret}`;
  return createHash('md5').update(content).digest('hex');
}
function mapTrack(track) {
  const art = track.album?.image || {};
  return {
    id: String(track.id), title: track.title || '',
    artist: track.performer?.name || track.artist?.name || 'Unknown Artist',
    album: track.album?.title || '', duration: Number(track.duration) || 0,
    artworkURL: art.large || art.extralarge || art.medium || null,
    format: '', audioQuality: '',
  };
}
async function handler(req, res) {
  if (req.method === 'OPTIONS') return respond(res, 204, {});
  if (req.method !== 'GET') return respond(res, 405, { error: 'Method not allowed.' });
  const current = route(req);
  const action = current.action || param(req, 'action');
  if (action === 'health') return respond(res, 200, {
    status: 'online', configured: ready(), protected: Boolean(env(VARS.key)),
    version: '1.0.0-us', requestPath: pathCandidates(req)[0] || '/',
  });
  if (!['manifest', 'search', 'stream'].includes(action)) {
    return respond(res, 404, { error: 'Unknown endpoint.' });
  }
  if (!env(VARS.key)) return respond(res, 503, { error: 'Set QOBUZ_US_ACCESS_KEY in Vercel.' });
  if (!validKey(current.key || param(req, 'key'), env(VARS.key))) {
    return respond(res, 401, { error: 'Invalid addon access key.' });
  }
  if (action === 'manifest') return respond(res, 200, manifest());
  if (!ready()) return respond(res, 503, { error: 'Qobuz US account is not configured.' });
  if (action === 'search') {
    const query = param(req, 'q').trim();
    if (!query || query.length > 120) return respond(res, 400, { error: 'Search query must be 1–120 characters.' });
    const limit = Math.min(MAX_RESULTS, Math.max(1, parseInt(param(req, 'limit'), 10) || 12));
    const result = await upstream('/track/search', { query, limit, offset: 0 });
    if (!result.ok) return respond(res, result.status, { error: result.error });
    const list = result.data?.tracks?.items;
    return respond(res, 200, { tracks: (Array.isArray(list) ? list : [])
      .filter(t => Number.isSafeInteger(Number(t.id)) && Boolean(t.title))
      .slice(0, limit).map(mapTrack) });
  }
  const trackId = current.id || param(req, 'id');
  if (!/^\d{1,15}$/.test(trackId)) return respond(res, 400, { error: 'Invalid track ID.' });
  const tier = param(req, 'quality').toUpperCase() || 'LOSSLESS';
  const formatIds = FORMATS[tier] || FORMATS.LOSSLESS;
  let file, streamUrl;
  for (const [index, formatId] of formatIds.entries()) {
    const ts = Math.floor(Date.now() / 1000);
    const result = await upstream('/track/getFileUrl', {
      track_id: trackId, format_id: formatId, intent: 'stream', request_ts: ts,
      request_sig: makeSignature(trackId, formatId, ts, env(VARS.secret)),
    });
    if (!result.ok) {
      if (index < formatIds.length - 1 && result.retryLowerQuality) continue;
      return respond(res, result.status, { error: result.error });
    }
    try {
      streamUrl = new URL(result.data?.url);
      if (streamUrl.protocol !== 'https:') throw Error('Not HTTPS');
    } catch {
      if (index < formatIds.length - 1) continue;
      return respond(res, 502, { error: 'Qobuz returned no secure playable URL.' });
    }
    file = result.data;
    break;
  }
  if (!file || !streamUrl) return respond(res, 502, { error: 'No playable stream.' });
  const formatId = Number(file.format_id);
  const advertisedMime = typeof file.mime_type === 'string' ? file.mime_type : '';
  // Avoid claiming FLAC simply because the user *requested* it.
  const codec = /flac/i.test(advertisedMime) ? 'flac'
    : /mp3|mpeg/i.test(advertisedMime) ? 'mp3'
    : [6, 7, 27].includes(formatId) ? 'flac'
    : formatId === 5 ? 'mp3' : 'unknown';
  const sampleRateKhz = Number(file.sampling_rate);
  const sampleRate = Number.isFinite(sampleRateKhz) && sampleRateKhz > 0
    ? (sampleRateKhz < 1000 ? sampleRateKhz * 1000 : sampleRateKhz) : null;
  const bits = Number(file.bit_depth);
  const bitDepth = Number.isInteger(bits) && bits >= 8 && bits <= 32 ? bits : null;
  return respond(res, 200, {
    url: streamUrl.toString(), format: codec, codec, container: codec,
    quality: codec === 'flac' ? 'Qobuz FLAC' : codec === 'mp3' ? 'Qobuz MP3' : 'Qobuz audio · codec unverified',
    mimeType: advertisedMime || (codec === 'flac' ? 'audio/flac' : codec === 'mp3' ? 'audio/mpeg' : 'application/octet-stream'),
    encrypted: false,
    ...(sampleRate ? { sampleRate } : {}),
    ...(bitDepth ? { bitDepth } : {}),
  });
}
module.exports = handler;
module.exports._test = { route, ready, validKey, manifest, makeSignature, mapTrack };
