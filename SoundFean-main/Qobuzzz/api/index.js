```javascript
'use strict';

const BASE = 'https://www.qobuz.com/api.json/0.2';

const APP_ID = process.env.QOBUZ_DE_APP_ID;
const APP_SECRET = process.env.QOBUZ_DE_APP_SECRET;
const USER_TOKEN = process.env.QOBUZ_DE_USER_AUTH_TOKEN;

const isConfigured = Boolean(APP_ID && APP_SECRET && USER_TOKEN);

const manifest = {
  id: 'dev.soundfean.qobuz.de.metadata',
  name: 'Qobuz DE Metadata',
  version: '1.0.2',
  description: 'Catalogue metadata only. No audio playback.',
  resources: ['search'],
  metadataOnly: true,
  audioDelivery: false
};

async function searchQobuz(query) {
  if (!isConfigured) {
    throw new Error('Qobuz credentials are not configured.');
  }

  const url = new URL(BASE + '/track/search');
  url.searchParams.set('query', query);
  url.searchParams.set('limit', '20');

  const response = await fetch(url, {
    headers: {
      'X-App-Id': APP_ID,
      'X-User-Auth-Token': USER_TOKEN,
      'Accept': 'application/json'
    }
  });

  if (!response.ok) {
    throw new Error('Qobuz search failed: HTTP ' + response.status);
  }

  return response.json();
}

function mapTrack(track) {
  const album = track.album || {};
  const performer = track.performer || {};

  const bitDepth =
    track.maximum_bit_depth || album.maximum_bit_depth || null;

  const sampleRate =
    track.maximum_sampling_rate || album.maximum_sampling_rate || null;

  return {
    id: String(track.id),
    title: track.title || 'Unknown title',
    artist: performer.name || 'Unknown artist',
    album: album.title || 'Unknown album',
    duration: track.duration || 0,

    artwork: album.image
      ? album.image.large || album.image.small || null
      : null,

    source: 'Qobuz',
    sourceCodec: 'FLAC (catalogue metadata)',
    sourceBitDepth: bitDepth,
    sourceSampleRate: sampleRate,

    sourceQuality: bitDepth && sampleRate
      ? String(bitDepth) + '-bit / ' + String(sampleRate) + ' kHz'
      : 'Quality unavailable',

    metadataOnly: true,
    audioDelivery: false
  };
}

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    res.statusCode = 204;
    return res.end();
  }

  const url = new URL(req.url, 'http://localhost');
  const pathname = url.pathname;

  try {
    if (
      pathname === '/health' ||
      pathname === '/api/health' ||
      pathname === '/qobuz-de/health'
    ) {
      res.setHeader('Content-Type', 'application/json');
      res.statusCode = 200;

      return res.end(JSON.stringify({
        status: 'online',
        configured: isConfigured,
        metadataOnly: true,
        audioDelivery: false
      }));
    }

    if (
      pathname === '/a/manifest.json' ||
      pathname === '/manifest.json'
    ) {
      res.setHeader('Content-Type', 'application/json');
      res.statusCode = 200;
      return res.end(JSON.stringify(manifest));
    }

    if (
      pathname.includes('/stream') ||
      pathname.includes('/play') ||
      pathname.includes('/download')
    ) {
      res.statusCode = 403;
      res.setHeader('Content-Type', 'application/json');

      return res.end(JSON.stringify({
        error: 'Metadata-only addon. Audio delivery is disabled.'
      }));
    }

    if (
      pathname === '/a/search' ||
      pathname === '/search'
    ) {
      const query = url.searchParams.get('query') ||
        url.searchParams.get('q');

      if (!query) {
        res.statusCode = 400;
        res.setHeader('Content-Type', 'application/json');

        return res.end(JSON.stringify({
          error: 'Search query is required.'
        }));
      }

      const data = await searchQobuz(query);
      const tracks = data.tracks && data.tracks.items
        ? data.tracks.items
        : [];

      res.statusCode = 200;
      res.setHeader('Content-Type', 'application/json');

      return res.end(JSON.stringify({
        tracks: tracks.map(mapTrack),
        metadataOnly: true
      }));
    }

    res.statusCode = 404;
    res.setHeader('Content-Type', 'application/json');

    return res.end(JSON.stringify({
      error: 'Endpoint not found.'
    }));

  } catch (error) {
    console.error('Qobuz metadata addon error:', error.message);

    res.statusCode = 500;
    res.setHeader('Content-Type', 'application/json');

    return res.end(JSON.stringify({
      error: error.message || 'Internal server error.'
    }));
  }
};

module.exports._test = {
  manifest,
  mapTrack,
  isConfigured
};
```
