'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const handler = require('./index');
const { validKey, configReady, manifest, makeSignature, selectedFormat } = handler._test;

function mockRes() {
  const headers = {};
  return {
    statusCode: 200,
    setHeader(k, v) { headers[k] = v; },
    end(v) { this.body = v; },
    json() { return this.body ? JSON.parse(this.body) : null; },
    headers,
  };
}

test('known quality settings', () => {
  assert.deepEqual(selectedFormat('LOSSLESS').ids, [27, 7, 6]);
  assert.deepEqual(selectedFormat('HI_RES').ids, [27, 7, 6]);
  assert.deepEqual(selectedFormat('HIGH').ids, [5]);
});

test('signed request deterministic', () => {
  const { createHash } = require('node:crypto');
  const raw = 'trackgetFileUrlformat_id6intentstreamtrack_id1231000secret';
  assert.equal(makeSignature('123', 6, 1000, 'secret'), createHash('md5').update(raw).digest('hex'));
});

test('key comparison and manifest', () => {
  assert.equal(validKey('secret-secret', 'secret-secret'), true);
  assert.equal(validKey('secret-other!', 'secret-secret'), false);
  assert.equal(validKey('', 'secret-secret'), false);
  assert.ok(manifest().resources.includes('search'));
});

test('health and unauthorized manifest', async () => {
  const previous = process.env.ADDON_ACCESS_KEY;
  process.env.ADDON_ACCESS_KEY = 'test-demo-key';
  const res = mockRes();
  await handler({ method: 'GET', url: '/api?action=manifest&key=wrong' }, res);
  assert.equal(res.statusCode, 401);
  const health = mockRes();
  await handler({ method: 'GET', url: '/api?action=health' }, health);
  assert.equal(health.json().protected, true);
  if (previous === undefined) delete process.env.ADDON_ACCESS_KEY;
  else process.env.ADDON_ACCESS_KEY = previous;
});

test('search refuses missing Qobuz secrets', async () => {
  const keyPrev = process.env.ADDON_ACCESS_KEY;
  const appPrev = process.env.QOBUZ_APP_ID;
  process.env.ADDON_ACCESS_KEY = 'test-demo-key';
  delete process.env.QOBUZ_APP_ID;
  assert.equal(configReady(), false);
  const res = mockRes();
  await handler({ method: 'GET', url: '/api?action=search&key=test-demo-key&q=Hello' }, res);
  assert.equal(res.statusCode, 503);
  assert.match(res.json().error, /Qobuz account not configured/);
  if (keyPrev === undefined) delete process.env.ADDON_ACCESS_KEY;
  else process.env.ADDON_ACCESS_KEY = keyPrev;
  if (appPrev === undefined) delete process.env.QOBUZ_APP_ID;
  else process.env.QOBUZ_APP_ID = appPrev;
});

const { test: addedTest } = require('node:test');
const { strict: assert2 } = require('node:assert');
addedTest('parses SoundFean mounted addon URLs', () => {
  const { routeFromPath } = require('./index')._test;
  assert2.deepEqual(routeFromPath({ url: '/qobuz/health' }), { action: 'health' });
  assert2.deepEqual(routeFromPath({ url: '/qobuz/a/token-123/manifest.json' }), { action: 'manifest', key: 'token-123', id: '' });
  assert2.deepEqual(routeFromPath({ url: '/qobuz/a/token-123/search?q=test' }), { action: 'search', key: 'token-123', id: '' });
  assert2.deepEqual(routeFromPath({ url: '/qobuz/a/token-123/stream/12345?quality=LOSSLESS' }), { action: 'stream', key: 'token-123', id: '12345' });
});

// The app respects the addon manifest when selecting sources for downloads.
test('downloading is explicitly opt-in', () => {
  const old = process.env.ADDON_ALLOW_DOWNLOADS;
  try {
    delete process.env.ADDON_ALLOW_DOWNLOADS;
    assert.equal(manifest().allowDownloads, 0);
    process.env.ADDON_ALLOW_DOWNLOADS = 'true';
    assert.equal(manifest().allowDownloads, 1);
    process.env.ADDON_ALLOW_DOWNLOADS = 'false';
    assert.equal(manifest().allowDownloads, 0);
  } finally {
    if (old === undefined) delete process.env.ADDON_ALLOW_DOWNLOADS;
    else process.env.ADDON_ALLOW_DOWNLOADS = old;
  }
});


// Mock only the Qobuz upstream requests, without contacting a live Qobuz account.
async function testStreamWithMock(upstream) {
  const oldFetch = global.fetch;
  const names = ['QOBUZ_APP_ID', 'QOBUZ_APP_SECRET', 'QOBUZ_USER_AUTH_TOKEN', 'ADDON_ACCESS_KEY'];
  const old = Object.fromEntries(names.map(name => [name, process.env[name]]));
  try {
    process.env.QOBUZ_APP_ID = 'test-app';
    process.env.QOBUZ_APP_SECRET = 'test-secret';
    process.env.QOBUZ_USER_AUTH_TOKEN = 'test-token';
    process.env.ADDON_ACCESS_KEY = 'local-test-key';
    const calls = [];
    global.fetch = async (url) => {
      const format = Number(new URL(url).searchParams.get('format_id'));
      calls.push(format);
      const answer = upstream(format);
      return { ok: answer.status >= 200 && answer.status < 300, status: answer.status,
        json: async () => answer.data };
    };
    const res = mockRes();
    await handler({ method: 'GET', url: '/qobuz/a/local-test-key/stream/123?quality=LOSSLESS' }, res);
    return { res, calls };
  } finally {
    global.fetch = oldFetch;
    for (const name of names) {
      if (old[name] === undefined) delete process.env[name];
      else process.env[name] = old[name];
    }
  }
}

test('LOSSLESS requests highest tier and truthfully labels 24-bit stream', async () => {
  const { res, calls } = await testStreamWithMock(() => ({
    status: 200, data: { url: 'https://media.test/track.flac', format_id: 27,
      mime_type: 'audio/flac', bit_depth: 24, sampling_rate: 96 },
  }));
  assert.deepEqual(calls, [27]);
  assert.equal(res.statusCode, 200);
  assert.equal(res.json().bitDepth, 24);
  assert.equal(res.json().sampleRate, 96000);
  assert.match(res.json().quality, /24-bit/);
});

test('tier denial falls back to 16-bit and labels it accurately', async () => {
  const { res, calls } = await testStreamWithMock(format => format === 6
    ? { status: 200, data: { url: 'https://media.test/cd.flac', format_id: 6,
      mime_type: 'audio/flac', bit_depth: 16, sampling_rate: 44.1 } }
    : { status: 403, data: { status: 'error', message: 'Format not available' } });
  assert.deepEqual(calls, [27, 7, 6]);
  assert.equal(res.statusCode, 200);
  assert.equal(res.json().bitDepth, 16);
  assert.equal(res.json().sampleRate, 44100);
  assert.ok(!/24-bit/i.test(res.json().quality));
});

test('returned 16-bit is not falsely advertised as Hi-Res', async () => {
  const { res, calls } = await testStreamWithMock(() => ({
    status: 200, data: { url: 'https://media.test/cd.flac', format_id: 6,
      mime_type: 'audio/flac', bit_depth: 16, sampling_rate: 44.1 },
  }));
  assert.deepEqual(calls, [27]);
  assert.equal(res.json().bitDepth, 16);
  assert.match(res.json().quality, /16-bit/);
});

test('rate limited upstream must not trigger three more calls', async () => {
  const { res, calls } = await testStreamWithMock(() => ({
    status: 429, data: { status: 'error', message: 'Too many requests' },
  }));
  assert.deepEqual(calls, [27]);
  assert.equal(res.statusCode, 429);
});

test('unknown precision is not invented', async () => {
  const { res } = await testStreamWithMock(() => ({
    status: 200, data: { url: 'https://media.test/audio.flac', mime_type: 'audio/flac' },
  }));
  assert.equal(res.statusCode, 200);
  assert.equal('bitDepth' in res.json(), false);
  assert.match(res.json().quality, /unverified/);
});


test('download policy and health advertise matching 1.2.0 release', async () => {
  const old = process.env.ADDON_ALLOW_DOWNLOADS;
  try {
    process.env.ADDON_ALLOW_DOWNLOADS = 'true';
    assert.equal(manifest().allowDownloads, 1);
    assert.equal(manifest().version, '1.2.0');
    const res = mockRes();
    await handler({method: 'GET', url: '/qobuz/health'}, res);
    assert.equal(res.statusCode, 200);
    assert.equal(res.json().version, '1.2.0');
  } finally {
    if (old === undefined) delete process.env.ADDON_ALLOW_DOWNLOADS;
    else process.env.ADDON_ALLOW_DOWNLOADS = old;
  }
});
