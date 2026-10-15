'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const addon = require('../api/index.js');
const helpers = addon._test;
for (const [name, req, expected] of [
  ['public manifest', {url:'/qobuz-us/a/k/manifest.json',headers:{}}, {action:'manifest',key:'k',id:''}],
  ['public search', {url:'/qobuz-us/a/k/search?q=a',headers:{}}, {action:'search',key:'k',id:''}],
  ['public stream', {url:'/qobuz-us/a/k/stream/123',headers:{}}, {action:'stream',key:'k',id:'123'}],
  ['bare addon', {url:'/qobuz-us/a/k',headers:{}}, {action:'manifest',key:'k',id:''}],
  ['rewritten API path', {url:'/api',headers:{'x-original-uri':'/qobuz-us/a/k/search?q=a'}}, {action:'search',key:'k',id:''}],
  ['service internal path', {url:'/a/k/search?q=a',headers:{}}, {action:'search',key:'k',id:''}],
  ['prefixed api path', {url:'/api/qobuz-us/a/k/search?q=a',headers:{}}, {action:'search',key:'k',id:''}],
  ['health', {url:'/qobuz-us/health',headers:{}}, {action:'health'}],
]) test(name, () => assert.deepEqual(helpers.route(req),expected));
function response() {
  const out={headers:{},statusCode:0,body:null,setHeader(k,v){this.headers[k]=v;},end(s){this.body=JSON.parse(s);}};
  return out;
}
const oldEnv={...process.env};
function configure() {
  process.env.QOBUZ_US_APP_ID='example-id';
  process.env.QOBUZ_US_APP_SECRET='example-secret';
  process.env.QOBUZ_US_USER_AUTH_TOKEN='example-token';
  process.env.QOBUZ_US_ACCESS_KEY='secret-key';
}
test('unauthenticated manifest rejected',async()=>{
  configure();const r=response();await addon({method:'GET',url:'/qobuz-us/a/wrong/manifest.json',headers:{}},r);
  assert.equal(r.statusCode,401);
});
test('manifest works with access key',async()=>{
  configure();const r=response();await addon({method:'GET',url:'/qobuz-us/a/secret-key/manifest.json',headers:{}},r);
  assert.equal(r.statusCode,200);assert.deepEqual(r.body.resources,['search','stream']);
  assert.equal(r.body.allowDownloads,0);
});
test('search via original public route and fake upstream',async()=>{
  configure();const original=global.fetch;let target='';
  global.fetch=async(url,opts)=>{target=String(url);assert.equal(opts.headers['X-App-Id'],'example-id');return {ok:true,status:200,json:async()=>({tracks:{items:[{id:123,title:'Dracula',performer:{name:'Artist'},album:{title:'Album'}}]}})};};
  try {const r=response();await addon({method:'GET',url:'/qobuz-us/a/secret-key/search?q=dracula',headers:{}},r);assert.equal(r.statusCode,200);assert.equal(r.body.tracks[0].title,'Dracula');assert.match(target,/track\/search/);}finally{global.fetch=original;}
});
test('stream via original public route and fake upstream',async()=>{
  configure();const original=global.fetch;
  global.fetch=async(url)=>({ok:true,status:200,json:async()=>({url:'https://cdn.example.test/audio.flac',format_id:6,mime_type:'audio/flac',bit_depth:16,sampling_rate:44.1})});
  try {const r=response();await addon({method:'GET',url:'/qobuz-us/a/secret-key/stream/123?quality=LOSSLESS',headers:{}},r);assert.equal(r.statusCode,200);assert.equal(r.body.codec,'flac');assert.equal(r.body.sampleRate,44100);}finally{global.fetch=original;}
});
