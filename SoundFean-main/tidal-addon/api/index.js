'use strict';

// SoundFean TIDAL addon.
// Uses TIDAL's official API and OAuth refresh-token flow.
// Protected playback still requires a supported official TIDAL playback SDK.
const { timingSafeEqual } = require('node:crypto');

const API = 'https://openapi.tidal.com/v2';
const AUTH = 'https://auth.tidal.com/v1/oauth2/token';
const env = (name, fallback = '') => (process.env[name] || fallback).trim();
const COUNTRY = () => env('TIDAL_COUNTRY_CODE', 'IN').toUpperCase();
const ACCESS_KEY = () => env('TIDAL_ACCESS_KEY');

let cachedAccessToken = '';
let tokenExpiresAt = 0;
let refreshInFlight = null;

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
function paths(req) {
  const candidates = [req.url, req.originalUrl, req.headers?.['x-vercel-original-path'],
    req.headers?.['x-original-uri'], req.headers?.['x-forwarded-uri'], req.headers?.['x-rewrite-url']];
  const out = [];
  for (const value of candidates) {
    if (typeof value !== 'string' || !value.startsWith('/')) continue;
    try {
      const path = new URL(value, 'https://local.invalid').pathname.replace(/\/+$/, '') || '/';
      if (!out.includes(path)) out.push(path);
    } catch {}
  }
  return out;
}
function validKey(given, expected) {
  if (!given || !expected) return false;
  const a = Buffer.from(given), b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}
function route(req) {
  for (const path of paths(req)) {
    if (['/tidal/health', '/health', '/api/health'].includes(path)) return { action: 'health' };
    const m = path.match(/^\/(?:api\/)?(?:tidal\/)?(?:api\/)?a\/([^/]+)(?:\/(manifest\.json|search|stream\/([^/]+)))?$/);
    if (!m) continue;
    let key;
    try { key = decodeURIComponent(m[1]); } catch { continue; }
    const endpoint = m[2] || 'manifest.json';
    return { action: endpoint === 'manifest.json' ? 'manifest' : endpoint === 'search' ? 'search' : 'stream',
      key, id: m[3] || '' };
  }
  return {};
}

async function getAccessToken(forceRefresh = false) {
  const direct = env('TIDAL_ACCESS_TOKEN');
  if (direct && !forceRefresh) return direct;

  if (!forceRefresh && cachedAccessToken && Date.now() < tokenExpiresAt - 60000) {
    return cachedAccessToken;
  }
  if (refreshInFlight) return refreshInFlight;

  const refreshToken = env('TIDAL_REFRESH_TOKEN');
  if (!refreshToken) return direct;
  refreshInFlight = (async () => {
    const body = new URLSearchParams({
      grant_type: 'refresh_token',
      refresh_token: refreshToken
    });
    let response;
    try {
      response = await fetch(AUTH, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
        body,
        signal: AbortSignal.timeout(12000)
      });
    } catch (error) {
      console.error('TIDAL token refresh transport error', { type: error?.name || 'Error' });
      throw new Error('Could not reach TIDAL authorization service.');
    }
    let data;
    try { data = await response.json(); }
    catch { throw new Error('TIDAL authorization service returned invalid JSON.'); }
    if (!response.ok || !data.access_token) {
      console.error('TIDAL token refresh failed', { status: response.status });
      throw new Error('TIDAL token refresh failed. Check that the refresh token is valid and authorized.');
    }
    cachedAccessToken = data.access_token;
    tokenExpiresAt = Date.now() + (Number(data.expires_in) || 3600) * 1000;
    return cachedAccessToken;
  })();

  try { return await refreshInFlight; }
  finally { refreshInFlight = null; }
}

async function tidal(path, params = {}, retried = false) {
  let accessToken;
  try { accessToken = await getAccessToken(retried); }
  catch (error) { return { ok: false, status: 401, error: error.message }; }
  if (!accessToken) return { ok: false, status: 503, error: 'Set TIDAL_ACCESS_TOKEN or TIDAL_REFRESH_TOKEN.' };

  const url = new URL(API + path);
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== null && String(value) !== '') url.searchParams.set(key, String(value));
  }
  let response;
  try {
    response = await fetch(url, { headers: {
      Authorization: `Bearer ${accessToken}`, Accept: 'application/vnd.api+json'
    }, signal: AbortSignal.timeout(12000) });
  } catch (error) {
    console.error('TIDAL transport error', { endpoint: path, type: error?.name || 'Error' });
    return { ok: false, status: 502, error: 'TIDAL API is unreachable.' };
  }
  if (response.status === 401 && !retried && env('TIDAL_REFRESH_TOKEN')) {
    cachedAccessToken = '';
    tokenExpiresAt = 0;
    return tidal(path, params, true);
  }
  let data;
  try { data = await response.json(); }
  catch {
    console.error('TIDAL invalid JSON', { endpoint: path, status: response.status });
    return { ok: false, status: 502, error: 'TIDAL returned an invalid response.' };
  }
  if (!response.ok) {
    console.error('TIDAL upstream error', { endpoint: path, status: response.status });
    return { ok: false, status: response.status === 429 ? 429 : response.status === 401 ? 401 : 502,
      error: response.status === 401 ? 'TIDAL token is invalid or expired.' :
        response.status === 403 ? 'TIDAL denied this operation for the token or app access tier.' :
        'TIDAL API request failed.' };
  }
  return { ok: true, data };
}

function manifest() {
  return {
    id: 'in.soundfean.tidal.heisenberg',
    name: 'TIDAL [Heisenberg]',
    version: '1.1.0',
    resources: ['search', 'stream'],
    settings: [{ key: 'quality', default: 'HI_RES_LOSSLESS',
      options: [{ value: 'LOW' }, { value: 'HIGH' }, { value: 'LOSSLESS' }, { value: 'HI_RES_LOSSLESS' }] }],
    allowDownloads: 0
  };
}
function mapTrack(track, included = []) {
  const a = track?.attributes || {};
  const relationships = track?.relationships || {};
  const albumLink = relationships.albums?.data?.[0];
  const album = albumLink ? included.find(x => x.type === albumLink.type && x.id === albumLink.id) : null;
  const artistLinks = relationships.artists?.data || [];
  const artists = artistLinks.map(link => included.find(x => x.type === link.type && x.id === link.id))
    .filter(Boolean).map(x => x.attributes?.name).filter(Boolean);
  return { id: String(track?.id || ''), title: a.title || a.name || '',
    artist: artists.join(', ') || a.artistName || 'Unknown Artist',
    album: album?.attributes?.title || '', duration: typeof a.duration === 'number' ? a.duration : 0,
    artworkURL: null, format: '', audioQuality: a.audioQuality || '', tidal: true };
}

async function handler(req, res) {
  if (req.method === 'OPTIONS') return send(res, 204, {});
  if (req.method !== 'GET') return send(res, 405, { error: 'Method not allowed.' });
  const r = route(req), action = r.action || param(req, 'action');

  if (action === 'health') {
    return send(res, 200, {
      status: 'online',
      configured: Boolean(env('TIDAL_ACCESS_TOKEN') || env('TIDAL_REFRESH_TOKEN')),
      protected: Boolean(ACCESS_KEY()),
      version: '1.1.0',
      playback: 'Protected TIDAL playback requires supported official playback handling.'
    });
  }
  if (!['manifest', 'search', 'stream'].includes(action)) return send(res, 404, { error: 'Unknown endpoint.' });
  if (!ACCESS_KEY()) return send(res, 503, { error: 'Set TIDAL_ACCESS_KEY in deployment environment variables.' });
  if (!validKey(r.key || param(req, 'key'), ACCESS_KEY())) return send(res, 401, { error: 'Invalid addon access key.' });
  if (action === 'manifest') return send(res, 200, manifest());

  if (!env('TIDAL_ACCESS_TOKEN') && !env('TIDAL_REFRESH_TOKEN')) {
    return send(res, 503, { error: 'Set TIDAL_REFRESH_TOKEN in deployment environment variables.' });
  }

  if (action === 'search') {
    const query = param(req, 'q').trim();
    if (!query || query.length > 120) return send(res, 400, { error: 'Search query must be 1–120 characters.' });
    const result = await tidal('/searchResults', { query, countryCode: COUNTRY(), include: 'tracks,artists,albums' });
    if (!result.ok) return send(res, result.status, { error: result.error });
    const primary = Array.isArray(result.data?.data) ? result.data.data : result.data?.data ? [result.data.data] : [];
    const included = Array.isArray(result.data?.included) ? result.data.included : [];
    const links = primary.flatMap(item => item?.relationships?.tracks?.data || []);
    const tracks = links.map(link => included.find(x => x.type === link.type && x.id === link.id)).filter(Boolean);
    const direct = primary.filter(item => item?.type === 'tracks');
    const items = (tracks.length ? tracks : direct).slice(0, Math.min(20, Math.max(1, Number(param(req, 'limit')) || 12)));
    return send(res, 200, { tracks: items.map(item => mapTrack(item, included)) });
  }

  const id = r.id || param(req, 'id');
  if (!id || id.length > 160 || !/^[A-Za-z0-9._:-]+$/.test(id))
    return send(res, 400, { error: 'Invalid TIDAL track ID.' });
  const quality = (param(req, 'quality') || 'HI_RES_LOSSLESS').toUpperCase();
  if (!new Set(['LOW', 'HIGH', 'LOSSLESS', 'HI_RES_LOSSLESS']).has(quality))
    return send(res, 400, { error: 'Unsupported quality setting.' });
  const result = await tidal(`/trackManifests/${encodeURIComponent(id)}`, { countryCode: COUNTRY(), audioQuality: quality });
  if (!result.ok) return send(res, result.status, { error: result.error });
  return send(res, 200, { manifest: result.data, provider: 'TIDAL',
    note: 'Official TIDAL manifest response; use a supported official playback SDK for protected media.' });
}

module.exports = handler;
module.exports._test = { validKey, route, manifest, mapTrack };
