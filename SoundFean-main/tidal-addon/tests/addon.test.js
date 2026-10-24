'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const addon = require('../api/index.js');
test('manifest identifies the addon and disables raw downloads', () => {
  const m = addon._test.manifest();
  assert.equal(m.name, 'TIDAL [Heisenberg]');
  assert.equal(m.allowDownloads, 0);
  assert.ok(m.resources.includes('search'));
  assert.ok(m.resources.includes('stream'));
});
test('access key validation works', () => {
  assert.equal(addon._test.validKey('', 'secret'), false);
  assert.equal(addon._test.validKey('wrong', 'secret'), false);
  assert.equal(addon._test.validKey('secret', 'secret'), true);
});
test('route recognises addon endpoints', () => {
  assert.equal(addon._test.route({url:'/tidal/health'}).action, 'health');
  assert.equal(addon._test.route({url:'/tidal/a/demo-key/manifest.json'}).action, 'manifest');
  assert.equal(addon._test.route({url:'/tidal/a/demo-key/search?q=test'}).action, 'search');
  assert.equal(addon._test.route({url:'/tidal/a/demo-key/stream/123'}).id, '123');
});
