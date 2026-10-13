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
  assert.equal(selectedFormat('LOSSLESS').id, 6);
  assert.equal(selectedFormat('HI_RES').id, 27);
  assert.equal(selectedFormat('HIGH').id, 5);
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
