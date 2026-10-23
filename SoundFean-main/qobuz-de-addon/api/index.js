'use strict';
// Dedicated Qobuz Germany addon for Bit-Perfect. Credentials stay in Vercel.
const { createHash, timingSafeEqual } = require('node:crypto');
const BASE = 'https://www.qobuz.com/api.json/0.2';
const ENV = {
  appId: 'QOBUZ_DE_APP_ID',
  secret: 'QOBUZ_DE_APP_SECRET',
  token: 'QOBUZ_DE_USER_AUTH_TOKEN',
  key: 'QOBUZ_DE_ACCESS_KEY',
};
const FORMATS = Object.freeze({
  LOW: [5], HIGH: [5], CD: [6], LOSSLESS: [27, 7, 6], HI_RES: [27, 7, 6], HIRES: [27, 7, 6],
});
const env = k => (process.env[k] || '').trim();
function send(res, status, body) {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Accept, Content-Type');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  return res.end(JSON.stringify(body));
}
function param(req, name) {
  if (typeof req.query?.[name] === 'string') return req.query[name];
  try { return new URL(req.url || '/', 'https://local.invalid').searchParams.get(name) || ''; }
  catch { return ''; }
}
function validKey(given, expected) {
  if (!given || !expected) return false;
  const a = Buffer.from(given), b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}
function paths(req) {
  const candidates = [req.url, req.originalUrl, req.headers?.['x-vercel-original-path'],
    req.headers?.['x-original-uri'], req.headers?.['x-forwarded-uri'], req.headers?.['x-rewrite-url']];
  const out = [];
  for (const v of candidates) {
    if (typeof v !== 'string' || !v.startsWith('/')) continue;
    try {
      const p = new URL(v, 'https://local.invalid').pathname.replace(/\/+$/, '') || '/';
      if (!out.includes(p)) out.push(p);
    } catch {}
  }
  return out;
}
function route(req) {
  for (const p of paths(req)) {
    if (['/qobuz-de/health', '/health', '/api/health'].includes(p)) return { action: 'health' };
    const m = p.match(/^\/(?:api\/)?(?:qobuz-de\/)?(?:api\/)?a\/([^/]+)(?:\/(manifest\.json|search|stream\/([0-9]{1,15})))?$/);
    if (!m) continue;
    let key; try { key = decodeURIComponent(m[1]); } catch { continue; }
    return { action: !m[2] || m[2] === 'manifest.json' ? 'manifest' : m[2] === 'search' ? 'search' : 'stream', key, id: m[3] || '' };
  }
  return {};
}
function ready() { return [ENV.appId, ENV.secret, ENV.token].every(k => Boolean(env(k))); }
function manifest() {
  return {
    id: 'dev.bitperfect.qobuz.de.personal',
   name: 'Qobuz [Heisenbergg]',
    version: '1.0.0-de',
    resources: ['search', 'stream'],
    // A streaming subscription does not itself authorize permanent file downloads.
    allowDownloads: 1,
    settings: [{ key: 'quality', default: 'LOSSLESS', options: [
      { value: 'LOSSLESS' }, { value: 'HI_RES' }, { value: 'HIGH' }, { value: 'LOW' },
    ] }],
  };
}
async function qobuz(path, params) {
  const url = new URL(BASE + path);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, String(v));
  let response;
  try {
    response = await fetch(url, { headers: {
      'X-App-Id': env(ENV.appId), 'X-User-Auth-Token': env(ENV.token), Accept: 'application/json',
    }, signal: AbortSignal.timeout(9000) });
  } catch (e) {
    console.error('Qobuz DE transport error', { endpoint: path, type: e?.name || 'Error' });
    return { ok: false, status: 502, error: 'Qobuz service unreachable.' };
  }
  let data;
  try { data = await response.json(); }
  catch {
    console.error('Qobuz DE invalid JSON', { endpoint: path, status: response.status });
    return { ok: false, status: 502, error: 'Invalid Qobuz response.' };
  }
  if (!response.ok || data?.status === 'error') {
    const status = response.ok ? Number(data?.code) || 502 : response.status;
    const message = String(data?.message || 'No detail').slice(0, 120);
    console.error('Qobuz DE upstream error', { endpoint: path, upstreamStatus: status, message });
    const authFailure = /invalid.{0,16}(signature|token|credential)|expired.{0,16}token|request signature|account is blocked/i.test(message);
    return { ok: false, status: status === 429 ? 429 : [401, 403].includes(status) ? 401 : 502,
      retryLower: [400, 403, 404, 422].includes(status) && !authFailure,
      error: 'Qobuz rejected the request; check account authorization, region, and entitlements.' };
  }
  return { ok: true, data };
}
function signature(id, format, ts, secret) {
  return createHash('md5').update(`trackgetFileUrlformat_id${format}intentstreamtrack_id${id}${ts}${secret}`).digest('hex');
}
function trackMap(t) {
  const images = t.album?.image || {};
  const bits = Number(t.maximum_bit_depth || t.bit_depth);
  const rate = Number(t.maximum_sampling_rate || t.sampling_rate);
  const quality = bits > 0 && rate > 0 ? `${bits}-bit / ${rate} kHz` : '';
  return { id: String(t.id), title: t.title || '', artist: t.performer?.name || t.artist?.name || 'Unknown Artist',
    album: t.album?.title || '', duration: Number(t.duration) || 0,
    artworkURL: images.large || images.extralarge || images.medium || null, format: '', audioQuality: quality };
}
async function handler(req, res) {
  if (req.method === 'OPTIONS') return send(res, 204, {});
  if (req.method !== 'GET') return send(res, 405, { error: 'Method not allowed.' });
  const r = route(req), action = r.action || param(req, 'action');
  if (action === 'health') return send(res, 200, { status: 'online', configured: ready(),
    protected: Boolean(env(ENV.key)), version: '1.0.0-de', requestPath: paths(req)[0] || '/' });
  if (!['manifest', 'search', 'stream'].includes(action)) return send(res, 404, { error: 'Unknown endpoint.' });
  if (!env(ENV.key)) return send(res, 503, { error: 'Set QOBUZ_DE_ACCESS_KEY in Vercel.' });
  if (!validKey(r.key || param(req, 'key'), env(ENV.key))) return send(res, 401, { error: 'Invalid addon access key.' });
  if (action === 'manifest') return send(res, 200, manifest());
  if (!ready()) return send(res, 503, { error: 'Qobuz DE is not configured. Check QOBUZ_DE_APP_ID, QOBUZ_DE_APP_SECRET and QOBUZ_DE_USER_AUTH_TOKEN.' });
  if (action === 'search') {
    const query = param(req, 'q').trim();
    if (!query || query.length > 120) return send(res, 400, { error: 'Search query must be 1–120 characters.' });
    const limit = Math.min(20, Math.max(1, parseInt(param(req, 'limit'), 10) || 12));
    const result = await qobuz('/track/search', { query, limit, offset: 0 });
    if (!result.ok) return send(res, result.status, { error: result.error });
    const items = result.data?.tracks?.items;
    return send(res, 200, { tracks: (Array.isArray(items) ? items : []).filter(t => Number.isSafeInteger(Number(t.id)) && t.title).slice(0, limit).map(trackMap) });
  }
  const id = r.id || param(req, 'id');
  if (!/^\d{1,15}$/.test(id)) return send(res, 400, { error: 'Invalid Qobuz track ID.' });
  const quality = (param(req, 'quality') || 'LOSSLESS').toUpperCase();
  const formats = FORMATS[quality] || FORMATS.LOSSLESS;
  let file = null, stream = null;
  for (const [i, formatId] of formats.entries()) {
    const ts = Math.floor(Date.now() / 1000);
    const result = await qobuz('/track/getFileUrl', { track_id: id, format_id: formatId, intent: 'stream',
      request_ts: ts, request_sig: signature(id, formatId, ts, env(ENV.secret)) });
    if (!result.ok) {
      if (i < formats.length - 1 && result.retryLower) continue;
      return send(res, result.status, { error: result.error });
    }
    try { stream = new URL(result.data?.url); if (stream.protocol !== 'https:') throw Error(); }
    catch { if (i < formats.length - 1) continue; return send(res, 502, { error: 'Qobuz returned no secure playable URL.' }); }
    file = result.data; break;
  }
  if (!file || !stream) return send(res, 502, { error: 'No playable stream available.' });
  const formatId = Number(file.format_id), mime = typeof file.mime_type === 'string' ? file.mime_type : '';
  const codec = /flac/i.test(mime) ? 'flac' : /mp3|mpeg/i.test(mime) ? 'mp3'
    : [6, 7, 27].includes(formatId) ? 'flac' : formatId === 5 ? 'mp3' : 'unknown';
  const sr = Number(file.sampling_rate), sampleRate = Number.isFinite(sr) && sr > 0 ? (sr < 1000 ? sr * 1000 : sr) : null;
  const bd = Number(file.bit_depth), bitDepth = Number.isInteger(bd) && bd >= 8 && bd <= 32 ? bd : null;
  const labels = [codec === 'unknown' ? 'Qobuz audio · codec unverified' : `Qobuz ${codec.toUpperCase()}`];
  if (bitDepth) labels.push(`${bitDepth}-bit`);
  if (sampleRate) labels.push(`${sampleRate / 1000} kHz`);
  return send(res, 200, { url: stream.toString(), format: codec, codec, container: codec,
    quality: labels.join(' · '), mimeType: mime || (codec === 'flac' ? 'audio/flac' : codec === 'mp3' ? 'audio/mpeg' : 'application/octet-stream'),
    encrypted: false, ...(sampleRate ? { sampleRate } : {}), ...(bitDepth ? { bitDepth } : {}) });
}
module.exports = handler;
module.exports._test = { validKey, ready, manifest, signature, trackMap, route };
