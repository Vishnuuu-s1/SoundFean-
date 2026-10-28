'use strict';

const http = require('node:http');
const handler = require('./api/index.js');

const server = http.createServer((req, res) => {
  Promise.resolve(handler(req, res)).catch((error) => {
    console.error('Qobuz DE error:', error?.message || 'Unknown error');

    if (!res.headersSent) {
      res.statusCode = 500;
      res.setHeader('Content-Type', 'application/json; charset=utf-8');
      res.setHeader('Access-Control-Allow-Origin', '*');
    }

    if (!res.writableEnded) {
      res.end(JSON.stringify({ error: 'Internal server error.' }));
    }
  });
});

const port = Number(process.env.PORT) || 10000;

server.listen(port, '0.0.0.0', () => {
  console.log('Qobuz DE server listening on port', port);
});
