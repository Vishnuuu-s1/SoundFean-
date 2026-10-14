'use strict';

// Bit-Perfect-compatible Qobuz GB addon. Use only with account/API access
// that you own or are explicitly authorized to use.
const { createHash, timingSafeEqual } = require('node:crypto');
const API = 'https://www.qobuz.com/api.json/0.2';
const VERSION = '1.0.0';
const FORMATS = Object.freeze({
  LOW: [5], HIGH: [5], CD: [6],
  LOSSLESS: [27, 7, 6], HI_RES: [27, 7, 6], HIRES: [27, 7, 6],
});
const ENV = Object.freeze({
  id: 'QOBUZ_GB_APP_ID',
  secret: 'QOBUZ_GB_APP_SECRET',
  token: 'QOBUZ_GB_USER_AUTH_TOKEN',
  access: 'QOBUZ_GB_ACCESS_KEY',
});

function output(res, status, data) {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.end(JSON.stringify(data));
}
function query(req, key) {
  const val = req.query?.[key];
  if (typeof val === 'string') return val;
  try { return new URL(req.url, 'https://internal.invalid').searchParams.get(key) || ''; }
  catch { return ''; }
}
function ready() {
  return [ENV.id, ENV.secret, ENV.token].every(k => Boolean(process.env[k]?.trim()));
}
function validAccess(given, expected) {
  if (!given || !expected) return false;
  const a = Buffer.from(given); const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}
function manifest() {
  return {
    id: 'dev.bitperfect.qobuz.gb',
    name: 'Qobuz GB · Personal Account',
    version: VERSION,
    resources: ['search', 'stream'],
    // Do not enable downloads without a separately authorized download path.
    allowDownloads: 0,
    settings: [{ key: 'quality', default: 'LOSSLESS', options: [
      { value: 'LOSSLESS' }, { value: 'HI_RES' },
      { value: 'CD' }, { value: 'HIGH' }, { value: 'LOW' },
    ] }],
  };
}
function route(req) {
  // Vercel may forward the original path with or without the /qobuz-gb prefix.
  // Base URLs should show the protected manifest, rather than an unhelpful 404.
  let pathname;
  try { pathname = new URL(req.url || '/', 'https://internal.invalid').pathname.replace(/\/+$/, '') || '/'; }
  catch { return {}; }
  if (['/qobuz-gb/health', '/health', '/api/health'].includes(pathname)) return { action: 'health' };
  const match = pathname.match(/^\/(?:qobuz-gb\/)?(?:api\/)?a\/([^/]+)(?:\/(manifest\.json|search|stream\/(\d{1,15})))?$/);
  if (!match) return {};
  let key;
  try { key = decodeURIComponent(match[1]); } catch { return {}; }
  return {
    action: !match[2] || match[2] === 'manifest.json' ? 'manifest' : match[2] === 'search' ? 'search' : 'stream',
    key, trackId: match[3] || '',
  };
}
async function qobuz(path, params) {
  const url = new URL(API + path);
  for (const [key, val] of Object.entries(params)) url.searchParams.set(key, String(val));
  // Supply the application ID as an explicit query parameter as well as a header.
  url.searchParams.set('app_id', process.env[ENV.id]);
  let response;
  try {
    response = await fetch(url, {
      headers: {
        'X-App-Id': process.env[ENV.id],
        'X-User-Auth-Token': process.env[ENV.token],
        Accept: 'application/json',
      },
      signal: AbortSignal.timeout(9000),
    });
  } catch { return { ok: false, status: 502, error: 'Qobuz could not be reached.' }; }
  let data;
  try { data = await response.json(); }
  catch { return { ok: false, status: 502, error: 'Invalid Qobuz response.' }; }
  if (!response.ok || data?.status === 'error') {
    // Diagnostic information only: never print credentials or full request URLs.
    console.error('Qobuz GB upstream error', {
      endpoint: path,
      upstreamStatus: response.status,
      code: data?.code ?? 'unknown',
      message: String(data?.message || 'No error detail returned').slice(0, 180),
    });
    const status = response.status;
    const detail = String(data?.message || '') + ' ' + String(data?.code || '');
    const authError = /invalid.{0,16}(signature|token|credential)|expired.{0,16}token|request signature/i.test(detail);
    return {
      ok: false,
      status: status === 429 ? 429 : [401,403].includes(status) ? 401 : 502,
      retryLower: [400, 403, 404, 422].includes(status) && !authError,
      error: 'Qobuz rejected the request. Verify account entitlements and authorized API access.',
    };
  }
  return { ok: true, data };
}
function signature(trackId, formatId, ts) {
  const payload = `trackgetFileUrlformat_id${formatId}intentstreamtrack_id${trackId}${ts}${process.env[ENV.secret]}`;
  return createHash('md5').update(payload).digest('hex');
}
function trackShape(item) {
  const a = item.album?.image || {};
  return {
    id: String(item.id), title: item.title || '',
    artist: item.performer?.name || item.artist?.name || 'Unknown Artist',
    album: item.album?.title || '', duration: Number(item.duration) || 0,
    artworkURL: a.large || a.extralarge || a.medium || null,
    format: '', audioQuality: '',
  };
}
function streamShape(file, streamUrl) {
  const returnedId = Number(file.format_id);
  const mime = typeof file.mime_type === 'string' ? file.mime_type : '';
  const codec = /flac/i.test(mime) ? 'flac'
    : /mp3|mpeg/i.test(mime) ? 'mp3'
    : [6, 7, 27].includes(returnedId) ? 'flac' : returnedId === 5 ? 'mp3' : '';
  const rate = Number(file.sampling_rate);
  const sampleRate = Number.isFinite(rate) && rate > 0 ? (rate < 1000 ? rate * 1000 : rate) : null;
  const bits = Number(file.bit_depth);
  const bitDepth = Number.isInteger(bits) && bits >= 8 && bits <= 32 ? bits : null;
  const quality = [codec === 'flac' ? 'Qobuz FLAC' : codec === 'mp3' ? 'Qobuz MP3' : 'Qobuz audio'];
  if (bitDepth) quality.push(`${bitDepth}-bit`);
  if (sampleRate) quality.push(`${sampleRate / 1000} kHz`);
  if (!bitDepth && codec === 'flac') quality.push('precision unverified');
  return {
    url: streamUrl, format: codec || undefined, codec: codec || undefined,
    container: codec || undefined, quality: quality.join(' · '),
    mimeType: mime || (codec === 'flac' ? 'audio/flac' : 'audio/mpeg'),
    encrypted: false,
    ...(sampleRate ? { sampleRate } : {}),
    ...(bitDepth ? { bitDepth } : {}),
  };
}

async function handler(req, res) {
  if (req.method === 'OPTIONS') return output(res, 204, {});
  if (req.method !== 'GET') return output(res, 405, { error: 'Method not allowed.' });
  const r = route(req);
  const action = r.action || query(req, 'action');
  if (action === 'health') return output(res, 200, {
    status: 'online', configured: ready(),
    protected: Boolean(process.env[ENV.access]), version: VERSION,
  });
  if (!['manifest', 'search', 'stream'].includes(action)) return output(res, 404, { error: 'Unknown endpoint. Use /qobuz-gb/a/YOUR_KEY as the addon URL; /manifest.json or /search?q=... for tests.' });
  if (!process.env[ENV.access]) return output(res, 503, { error: 'GB access key is not configured.' });
  if (!validAccess(r.key || query(req, 'key'), process.env[ENV.access]))
    return output(res, 401, { error: 'Invalid GB addon access key.' });
  if (action === 'manifest') return output(res, 200, manifest());
  if (!ready()) return output(res, 503, { error: 'GB account/API credentials are not configured.' });
  if (action === 'search') {
    const q = query(req, 'q').trim();
    if (!q || q.length > 120) return output(res, 400, { error: 'Search requires a query of at most 120 characters.' });
    const limit = Math.min(20, Math.max(1, Number.parseInt(query(req, 'limit'), 10) || 12));
    const result = await qobuz('/catalog/search', { query: q, type: 'tracks', limit, offset: 0 });
    if (!result.ok) return output(res, result.status, { error: result.error });
    const items = Array.isArray(result.data?.tracks?.items) ? result.data.tracks.items : [];
    return output(res, 200, { tracks: items.filter(t => /^\d+$/.test(String(t.id)) && t.title).slice(0, limit).map(trackShape) });
  }
  const id = r.trackId || query(req, 'id');
  if (!/^\d{1,15}$/.test(id)) return output(res, 400, { error: 'Invalid track ID.' });
  const requested = query(req, 'quality').toUpperCase() || 'LOSSLESS';
  const formats = FORMATS[requested] || FORMATS.LOSSLESS;
  for (const [n, formatId] of formats.entries()) {
    const timestamp = Math.floor(Date.now() / 1000);
    const result = await qobuz('/track/getFileUrl', {
      track_id: id, format_id: formatId, intent: 'stream', request_ts: timestamp,
      request_sig: signature(id, formatId, timestamp),
    });
    if (!result.ok) {
      if (result.retryLower && n < formats.length - 1) continue;
      return output(res, result.status, { error: result.error });
    }
    let streamUrl;
    try {
      streamUrl = new URL(result.data?.url);
      if (streamUrl.protocol !== 'https:') throw Error('Invalid stream URL');
    } catch {
      if (n < formats.length - 1) continue;
      return output(res, 502, { error: 'Qobuz did not return a valid audio URL.' });
    }
    return output(res, 200, streamShape(result.data, streamUrl.toString()));
  }
  return output(res, 502, { error: 'No authorized audio available.' });
}
module.exports = handler;
module.exports._test = { manifest, route, ready, validAccess, streamShape };
