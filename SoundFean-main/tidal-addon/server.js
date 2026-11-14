
'use strict';

const http = require('node:http');
const handler = require('./api/index.js');

const port = Number(process.env.PORT) || 3000;

const server = http.createServer((req, res) => {
  Promise.resolve(handler(req, res)).catch((error) => {
    console.error('Request error:', error.message);

    if (!res.headersSent) {
      res.writeHead(500, {
        'Content-Type': 'application/json'
      });
    }

    if (!res.writableEnded) {
      res.end(JSON.stringify({
        error: 'Internal server error'
      }));
    }
  });
});

server.listen(port, '0.0.0.0', () => {
  console.log(`TIDAL addon running on port ${port}`);
});
