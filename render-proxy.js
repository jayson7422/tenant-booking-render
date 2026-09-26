require('dotenv').config();

const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');

const PORT = Number(process.env.PORT || 10000);

const PUBLIC = path.join(
  __dirname,
  'public'
);

const ONPREM_BASE_URL = String(
  process.env.ONPREM_BASE_URL || ''
).trim();

const PROXY_SECRET = String(
  process.env.RENDER_PROXY_SECRET || ''
).trim();

if (!ONPREM_BASE_URL) {
  console.error(
    'ONPREM_BASE_URL is required.'
  );
  process.exit(1);
}

if (!PROXY_SECRET) {
  console.error(
    'RENDER_PROXY_SECRET is required.'
  );
  process.exit(1);
}

let upstreamBase;

try {
  upstreamBase =
    new URL(ONPREM_BASE_URL);
} catch {
  console.error(
    'ONPREM_BASE_URL must be a valid URL.'
  );
  process.exit(1);
}

if (
  upstreamBase.protocol !== 'https:' &&
  upstreamBase.protocol !== 'http:'
) {
  console.error(
    'ONPREM_BASE_URL must use HTTP or HTTPS.'
  );
  process.exit(1);
}

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon'
};

function sendJson(
  res,
  status,
  value
) {
  res.writeHead(
    status,
    {
      'Content-Type':
        'application/json; charset=utf-8',

      'Cache-Control':
        'no-store'
    }
  );

  res.end(
    JSON.stringify(value)
  );
}

function serveFile(
  res,
  filename
) {
  const target =
    path.resolve(
      PUBLIC,
      filename
    );

  const publicRoot =
    path.resolve(PUBLIC) +
    path.sep;

  if (
    target !== path.resolve(PUBLIC) &&
    !target.startsWith(publicRoot)
  ) {
    return sendJson(
      res,
      403,
      {
        error: 'Forbidden'
      }
    );
  }

  if (
    !fs.existsSync(target) ||
    !fs.statSync(target).isFile()
  ) {
    return sendJson(
      res,
      404,
      {
        error: 'Not found'
      }
    );
  }

  const extension =
    path
      .extname(target)
      .toLowerCase();

  res.writeHead(
    200,
    {
      'Content-Type':
        TYPES[extension] ||
        'application/octet-stream',

      'Cache-Control':
        'no-store'
    }
  );

  fs
    .createReadStream(target)
    .pipe(res);
}

function cleanRequestHeaders(
  headers
) {
  const result = {
    ...headers
  };

  delete result.host;
  delete result.connection;
  delete result['x-bayan-proxy-key'];
  delete result['proxy-authorization'];
  delete result['proxy-authenticate'];
  delete result['keep-alive'];
  delete result.te;
  delete result.trailer;
  delete result['transfer-encoding'];
  delete result.upgrade;

  result['x-bayan-proxy-key'] =
    PROXY_SECRET;

  return result;
}

function cleanResponseHeaders(
  headers
) {
  const result = {
    ...headers
  };

  delete result.connection;
  delete result['keep-alive'];
  delete result['proxy-authenticate'];
  delete result['proxy-authorization'];
  delete result.te;
  delete result.trailer;
  delete result['transfer-encoding'];
  delete result.upgrade;

  return result;
}

function proxyApi(
  req,
  res
) {
  const destination =
    new URL(
      req.url,
      upstreamBase
    );

  const client =
    destination.protocol ===
    'https:'
      ? https
      : http;

  const upstream =
    client.request(
      {
        protocol:
          destination.protocol,

        hostname:
          destination.hostname,

        port:
          destination.port ||
          (
            destination.protocol ===
            'https:'
              ? 443
              : 80
          ),

        path:
          `${destination.pathname}${destination.search}`,

        method:
          req.method,

        headers:
          cleanRequestHeaders(
            req.headers
          )
      },

      upstreamResponse => {
        res.writeHead(
          upstreamResponse.statusCode ||
          502,

          cleanResponseHeaders(
            upstreamResponse.headers
          )
        );

        upstreamResponse.pipe(
          res
        );
      }
    );

  upstream.setTimeout(
    30000,
    () => {
      upstream.destroy(
        new Error(
          'On-prem request timed out'
        )
      );
    }
  );

  upstream.on(
    'error',
    error => {
      console.error(
        'Render proxy upstream error:',
        error.message
      );

      if (!res.headersSent) {
        return sendJson(
          res,
          502,
          {
            error:
              'The company server is temporarily unavailable.'
          }
        );
      }

      res.end();
    }
  );

  req.pipe(upstream);
}

const server =
  http.createServer(
    (req, res) => {
      const url =
        new URL(
          req.url,
          `http://${req.headers.host || 'localhost'}`
        );

      if (
        req.method === 'GET' &&
        url.pathname === '/health'
      ) {
        return sendJson(
          res,
          200,
          {
            ok: true,
            service:
              'bayan-render-proxy'
          }
        );
      }

      if (
        url.pathname
          .startsWith('/api/')
      ) {
        return proxyApi(
          req,
          res
        );
      }

      if (
        req.method !== 'GET' &&
        req.method !== 'HEAD'
      ) {
        return sendJson(
          res,
          405,
          {
            error:
              'Method not allowed'
          }
        );
      }

      if (
        url.pathname === '/'
      ) {
        return serveFile(
          res,
          'index.html'
        );
      }

      if (
        url.pathname ===
        '/booking'
      ) {
        return serveFile(
          res,
          'booking.html'
        );
      }

      if (
        url.pathname ===
        '/admin'
      ) {
        return serveFile(
          res,
          'booking-admin.html'
        );
      }

      const relative =
        decodeURIComponent(
          url.pathname
        )
          .replace(
            /^\/+/,
            ''
          );

      return serveFile(
        res,
        relative
      );
    }
  );

server.listen(
  PORT,
  '0.0.0.0',
  () => {
    console.log(
      `BayanSpaces Render proxy is running on port ${PORT}`
    );

    console.log(
      `API requests will be forwarded to ${upstreamBase.origin}`
    );
  }
);