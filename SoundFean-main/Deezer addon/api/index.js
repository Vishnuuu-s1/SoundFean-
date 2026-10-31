'use strict';

/**
 * Shared Deezer addon for Eclipse / BitPerfect style clients.
 * Inspired by the SoundFean Qobuz addon structure.
 *
 * Credentials live ONLY in environment variables.
 * Users install a public URL – they never see your ARL.
 */

const { createHash } = require('node:crypto');

const PUBLIC_API = 'https://api.deezer.com';
const GW_URL = 'https://www.deezer.com/ajax/gw-light.php';
const MEDIA_URL = 'https://media.deezer.com/v1/get_url';

// Quality order: FLAC → 320 → 128
const QUALITY_MAP = {
  FLAC: ['FLAC', 'MP3_320', 'MP3_128'],
  HI_RES: ['FLAC', 'MP3_320', 'MP3_128'],
  LOSSLESS: ['FLAC', 'MP3_320', 'MP3_128'],
  HIGH: ['MP3_320', 'MP3_128'],
  LOW: ['MP3_128'],
};

function env(key) {
  return (process.env[key] || '').trim();
}

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
  try {
    return new URL(req.url || '/', 'https://local.invalid').searchParams.get(name) || '';
  } catch {
    return '';
  }
}

function paths(req) {
  const candidates = [
    req.url,
    req.originalUrl,
    req.headers?.['x-vercel-original-path'],
    req.headers?.['x-original-uri'],
    req.headers?.['x-forwarded-uri'],
    req.headers?.['x-rewrite-url'],
  ];

  const output = [];
  for (const value of candidates) {
    if (typeof value !== 'string' || !value.startsWith('/')) continue;
    try {
      const path = new URL(value, 'https://local.invalid').pathname.replace(/\/+$/, '') || '/';
      if (!output.includes(path)) output.push(path);
    } catch {}
  }
  return output;
}

function route(req) {
  for (const path of paths(req)) {
    if (['/deezer/health', '/health', '/api/health'].includes(path)) {
      return { action: 'health' };
    }

    // Public routes (no key required) – perfect for shared use
    let match = path.match(
      /^\/(?:api\/)?(?:deezer\/)?(?:api\/)?a\/(manifest\.json|search)$/
    );
    if (match) {
      return {
        action: match[1] === 'manifest.json' ? 'manifest' : 'search',
      };
    }

    match = path.match(
      /^\/(?:api\/)?(?:deezer\/)?(?:api\/)?a\/stream\/([0-9]{1,15})$/
    );
    if (match) {
      return { action: 'stream', id: match[1] };
    }

    // Compatibility with token-in-path style
    match = path.match(
      /^\/(?:api\/)?(?:deezer\/)?(?:api\/)?a\/([^/]+)(?:\/(manifest\.json|search|stream\/([0-9]{1,15})))?$/
    );
    if (!match) continue;

    let key;
    try {
      key = decodeURIComponent(match[1]);
    } catch {
      continue;
    }

    return {
      action: !match[2] || match[2] === 'manifest.json'
        ? 'manifest'
        : match[2] === 'search'
          ? 'search'
          : 'stream',
      key,
      id: match[3] || '',
    };
  }
  return {};
}

function ready() {
  return Boolean(env('DEEZER_ARL'));
}

function manifest() {
  return {
    id: 'dev.shared.deezer',
    name: 'Deezer Shared',
    version: '1.0.0',
    resources: ['search', 'stream'],
    allowDownloads: 0,
    settings: [
      {
        key: 'quality',
        default: 'LOSSLESS',
        options: [
          { value: 'LOSSLESS' },
          { value: 'HI_RES' },
          { value: 'HIGH' },
          { value: 'LOW' },
        ],
      },
    ],
  };
}

/* ---------- Deezer helpers ---------- */

let cachedSession = null; // { apiToken, licenseToken, arl, expires }

async function getSession() {
  const arl = env('DEEZER_ARL');
  if (!arl) throw new Error('DEEZER_ARL not set');

  if (cachedSession && Date.now() < cachedSession.expires) {
    return cachedSession;
  }

  // Login via ARL → get api_token + license_token
  const url = new URL(GW_URL);
  url.searchParams.set('method', 'deezer.getUserData');
  url.searchParams.set('input', '3');
  url.searchParams.set('api_version', '1.0');
  url.searchParams.set('api_token', '');
  url.searchParams.set('cid', String(Math.floor(Math.random() * 1e9)));

  const res = await fetch(url, {
    headers: {
      Cookie: `arl=${arl}`,
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
    },
    signal: AbortSignal.timeout(10000),
  });

  const data = await res.json();
  if (!data?.results?.USER?.USER_ID) {
    throw new Error('Invalid or expired ARL');
  }

  const apiToken = data.results.checkForm;
  const licenseToken = data.results.USER?.OPTIONS?.license_token;

  cachedSession = {
    apiToken,
    licenseToken,
    arl,
    expires: Date.now() + 25 * 60 * 1000, // 25 min
  };

  return cachedSession;
}

async function gwCall(method, body = {}) {
  const session = await getSession();

  const url = new URL(GW_URL);
  url.searchParams.set('method', method);
  url.searchParams.set('input', '3');
  url.searchParams.set('api_version', '1.0');
  url.searchParams.set('api_token', session.apiToken);
  url.searchParams.set('cid', String(Math.floor(Math.random() * 1e9)));

  const res = await fetch(url, {
    method: 'POST',
    headers: {
      Cookie: `arl=${session.arl}`,
      'Content-Type': 'application/json',
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(10000),
  });

  return res.json();
}

async function publicSearch(query, limit = 12) {
  const url = new URL(`${PUBLIC_API}/search/track`);
  url.searchParams.set('q', query);
  url.searchParams.set('limit', String(limit));

  const res = await fetch(url, { signal: AbortSignal.timeout(8000) });
  if (!res.ok) throw new Error('Deezer public search failed');
  return res.json();
}

function trackMap(track) {
  return {
    id: String(track.id),
    title: track.title || '',
    artist: track.artist?.name || track.artist?.name || 'Unknown Artist',
    album: track.album?.title || '',
    duration: Number(track.duration) || 0,
    artworkURL: track.album?.cover_xl || track.album?.cover_big || track.album?.cover_medium || null,
    format: '',
    audioQuality: '',
  };
}

async function getStreamUrl(trackId, preferredQuality) {
  const session = await getSession();
  const formats = QUALITY_MAP[preferredQuality] || QUALITY_MAP.LOSSLESS;

  // Get track token via gateway
  const trackData = await gwCall('song.getListData', {
    sng_ids: [Number(trackId)],
  });

  const song = trackData?.results?.data?.[0];
  if (!song) throw new Error('Track not found');

  const trackToken = song.TRACK_TOKEN;
  if (!trackToken) throw new Error('No track token');

  // Ask media.deezer.com for a playable URL
  for (const format of formats) {
    const payload = {
      license_token: session.licenseToken,
      media: [
        {
          type: 'FULL',
          formats: [{ cipher: 'BF_CBC_STRIPE', format }],
        },
      ],
      track_tokens: [trackToken],
    };

    const res = await fetch(MEDIA_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(10000),
    });

    const data = await res.json();
    const media = data?.data?.[0]?.media?.[0];
    const source = media?.sources?.[0];

    if (source?.url) {
      return {
        url: source.url,
        format: format.startsWith('FLAC') ? 'flac' : 'mp3',
        quality: format,
      };
    }
  }

  throw new Error('No playable stream available for this quality / account');
}

/* ---------- Main handler ---------- */

async function handler(req, res) {
  if (req.method === 'OPTIONS') {
    res.statusCode = 204;
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Accept, Content-Type');
    return res.end();
  }

  if (req.method !== 'GET') {
    return send(res, 405, { error: 'Method not allowed.' });
  }

  const matched = route(req);
  const action = matched.action || param(req, 'action');

  if (action === 'health') {
    return send(res, 200, {
      status: 'online',
      configured: ready(),
      protected: false,
      version: '1.0.0',
      requestPath: paths(req)[0] || '/',
    });
  }

  if (!['manifest', 'search', 'stream'].includes(action)) {
    return send(res, 404, { error: 'Unknown endpoint.' });
  }

  if (action === 'manifest') {
    return send(res, 200, manifest());
  }

  if (!ready()) {
    return send(res, 503, {
      error: 'Deezer addon is not configured. Set DEEZER_ARL environment variable.',
    });
  }

  if (action === 'search') {
    const query = param(req, 'q').trim();
    if (!query || query.length > 120) {
      return send(res, 400, { error: 'Search query must be 1–120 characters.' });
    }

    const limit = Math.min(20, Math.max(1, parseInt(param(req, 'limit'), 10) || 12));

    try {
      const result = await publicSearch(query, limit);
      const items = result?.data || [];
      return send(res, 200, {
        tracks: items
          .filter((t) => t.id && t.title)
          .slice(0, limit)
          .map(trackMap),
      });
    } catch (err) {
      console.error('Search error', err.message);
      return send(res, 502, { error: 'Search failed.' });
    }
  }

  // stream
  const id = matched.id || param(req, 'id');
  if (!/^\d{1,15}$/.test(id)) {
    return send(res, 400, { error: 'Invalid Deezer track ID.' });
  }

  const quality = (param(req, 'quality') || 'LOSSLESS').toUpperCase();

  try {
    const stream = await getStreamUrl(id, quality);
    return send(res, 200, {
      url: stream.url,
      format: stream.format,
      codec: stream.format,
      container: stream.format,
      quality: stream.quality,
      mimeType: stream.format === 'flac' ? 'audio/flac' : 'audio/mpeg',
      encrypted: false,
    });
  } catch (err) {
    console.error('Stream error', err.message);
    return send(res, 502, { error: err.message || 'Stream failed.' });
  }
}

module.exports = handler;
    
