'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const api = require('../api/index.js')._test;
test('manifest has unique DE identity and does not claim permanent downloads', () => {
  const m = api.manifest();
  assert.equal(m.id, 'dev.bitperfect.qobuz.de.personal');
  assert.equal(m.allowDownloads, 0);
  assert.deepEqual(m.resources, ['search', 'stream']);
});
test('routes public and forwarded paths', () => {
  assert.equal(api.route({url:'/qobuz-de/a/abc/search?q=hello'}).action,'search');
  assert.equal(api.route({url:'/api/a/abc/stream/123'}).action,'stream');
  assert.equal(api.route({url:'/qobuz-de/health'}).action,'health');
});
test('maps track metadata', () => {
  const t=api.trackMap({id:123,title:'Song',duration:120,maximum_bit_depth:24,maximum_sampling_rate:96,
    album:{title:'Album',image:{large:'https://img.test/a.jpg'}},performer:{name:'Artist'}});
  assert.equal(t.audioQuality,'24-bit / 96 kHz');
  assert.equal(t.artist,'Artist');
  assert.equal(t.artworkURL,'https://img.test/a.jpg');
});

