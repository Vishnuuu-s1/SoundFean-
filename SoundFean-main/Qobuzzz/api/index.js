'use strict';

const BASE = 'https://www.qobuz.com/api.json/0.2';

const env = (key) => (process.env[key] || '').trim();

function send(res, status, data) {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json');
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Cache-Control', 'no-store');
  return res.end(JSON.stringify(data));
}

function param(req, key) {
  if (typeof req.query?.[key] === 'string') {
    return req.query[key];
  }

  return new URL(
    req.url,
    'https://local.invalid'
  ).searchParams.get(key) || '';
}

function manifest() {
  return {
    id: 'dev.soundfean.qobuz.de.metadata',
    name: 'Qobuz DE Metadata',
    version: '1.0.0',
    resources: ['search'],
    metadataOnly: true,
    description: 'Qobuz catalogue metadata only. No audio delivery.'
  };
}

function mapTrack(track) {
  const images = track.album?.image || {};

  const bitDepth = Number(
    track.maximum_bit_depth || track.bit_depth
  ) || null;

  const sampleRate = Number(
    track.maximum_sampling_rate || track.sampling_rate
  ) || null;

  return {
    id: String(track.id),
    title: track.title || '',
    artist:
      track.performer?.name ||
      track.artist?.name ||
      'Unknown Artist',

    album: track.album?.title || '',
    duration: Number(track.duration) || 0,

    artworkURL:
      images.large ||
      images.extralarge ||
      images.medium ||
      null,

    source: 'Qobuz DE',
    sourceCodec: bitDepth && sampleRate
      ? 'FLAC (catalogue metadata)'
      : 'Unknown',

    sourceBitDepth: bitDepth,
    sourceSampleRate: sampleRate,

    sourceQuality:
      bitDepth && sampleRate
        ? `${bitDepth}-bit / ${sampleRate} kHz`
        : 'Quality unavailable',

    metadataOnly: true
  };
}

async function searchQobuz(query, limit) {
  const url = new URL(BASE + '/track/search');

  url.searchParams.set('query', query);
  url.searchParams.set('limit', String(limit));
  url.searchParams.set('offset', '0');

  const response = await fetch(url, {
    headers: {
      'X-App-Id': env('QOBUZ_DE_APP_ID'),
      'X-User-Auth-Token': env('QOBUZ_DE_USER_AUTH_TOKEN'),
      'Accept': 'application/json'
    },
    signal: AbortSignal.timeout(9000)
  });

  const data = await response.json();

  if (!response.ok || data?.status === 'error') {
    throw new Error('Qobuz metadata request failed.');
  }

  return data;
}

async function handler(req, res) {
  if (req.method === 'OPTIONS') {
    res.statusCode = 204;
    res.setHeader('Access-Control-Allow-Origin', '*');
    return res.end();
  }

  if (req.method !== 'GET') {
    return send(res, 405, {
      error: 'Method not allowed'
    });
  }

  const path = new URL(
    req.url,
    'https://local.invalid'
  ).pathname;

  if (path === '/health') {
    return send(res, 200, {
      status: 'online',
      mode: 'metadata-only',
      audioDelivery: false,
      configured: Boolean(
        env('QOBUZ_DE_APP_ID') &&
        env('QOBUZ_DE_USER_AUTH_TOKEN')
      )
    });
  }

  if (
    path === '/manifest.json' ||
    path === '/a/manifest.json'
  ) {
    return send(res, 200, manifest());
  }

  // Never provide playback, stream or download endpoints.
  if (/\/(stream|play|download)(\/|$)/i.test(path)) {
    return send(res, 404, {
      error: 'Metadata-only addon. Audio delivery disabled.'
    });
  }

  if (
    path !== '/search' &&
    path !== '/a/search'
  ) {
    return send(res, 404, {
      error: 'Unknown endpoint'
    });
  }

  if (
    !env('QOBUZ_DE_APP_ID') ||
    !env('QOBUZ_DE_USER_AUTH_TOKEN')
  ) {
    return send(res, 503, {
      error: 'Qobuz credentials not configured.'
    });
  }

  const query = param(req, 'q').trim();

  if (!query || query.length > 120) {
    return send(res, 400, {
      error: 'Invalid search query.'
    });
  }

  const limit = Math.min(
    20,
    Math.max(1, Number(param(req, 'limit')) || 12)
  );

  try {
    const data = await searchQobuz(query, limit);

    const items = data?.tracks?.items || [];

    return send(res, 200, {
      tracks: items.map(mapTrack),
      metadataOnly: true,
      audioDelivery: false
    });

  } catch (error) {
    console.error(error.message);

    return send(res, 502, {
      error: 'Qobuz metadata lookup failed.'
    });
  }
}

module.exports = handler;
