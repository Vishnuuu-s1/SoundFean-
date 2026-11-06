'use strict';

const http = require('node:http');
const handler = require('./api/index.js');

const port = Number(process.env.PORT) || 3000;

http.createServer((req, res) => {
  handler(req, res).catch((error) => {
    console.error(error);

    if (!res.headersSent) {
      res.statusCode = 500;
      res.setHeader('Content-Type', 'application/json');
    }

    res.end(JSON.stringify({
      error: 'Internal server error'
    }));
  });
}).listen(port, '0.0.0.0', () => {
  console.log(`Metadata addon running on ${port}`);
});
