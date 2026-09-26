require('dotenv').config();

const http = require('http');
const crypto = require('crypto');

const GATEWAY_PORT = Number(process.env.GATEWAY_PORT || 6510);
const CORE_HOST = process.env.CORE_HOST || '127.0.0.1';
const CORE_PORT = Number(process.env.CORE_PORT || 5177);

const PROXY_SECRET = String(
  process.env.RENDER_PROXY_SECRET || ''
).trim();

if (!PROXY_SECRET) {
  console.error(
    'RENDER_PROXY_SECRET is required before starting the on-prem gateway.'
  );
  process.exit(1);
}

function sendJson(res, status, value) {
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store'
  });

  res.end(JSON.stringify(value));
}

function secretMatches(received) {
  const expectedBuffer = Buffer.from(PROXY_SECRET);
  const receivedBuffer = Buffer.from(String(received || ''));

  if (expectedBuffer.length !== receivedBuffer.length) {
    return false;
  }

  return crypto.timingSafeEqual(
    expectedBuffer,
    receivedBuffer
  );
}

function cleanRequestHeaders(headers) {
  const result = {
    ...headers
  };

  delete result['x-bayan-proxy-key'];

  delete result.connection;
  delete result['proxy-authorization'];
  delete result['proxy-authenticate'];
  delete result['keep-alive'];
  delete result.te;
  delete result.trailer;
  delete result['transfer-encoding'];
  delete result.upgrade;

  result.host = `${CORE_HOST}:${CORE_PORT}`;

  return result;
}

function cleanResponseHeaders(headers) {
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

function authorized(req) {
  return secretMatches(
    req.headers['x-bayan-proxy-key']
  );
}

function proxyToCore(req, res) {
  const upstream = http.request(
    {
      hostname: CORE_HOST,
      port: CORE_PORT,
      path: req.url,
      method: req.method,
      headers: cleanRequestHeaders(req.headers)
    },
    upstreamResponse => {
      res.writeHead(
        upstreamResponse.statusCode || 502,
        cleanResponseHeaders(upstreamResponse.headers)
      );

      upstreamResponse.pipe(res);
    }
  );

  upstream.setTimeout(30000, () => {
    upstream.destroy(
      new Error('Core application request timed out')
    );
  });

  upstream.on('error', error => {
    console.error(
      'Gateway upstream error:',
      error.message
    );

    if (!res.headersSent) {
      return sendJson(
        res,
        502,
        {
          error:
            'The on-prem BayanSpaces service is temporarily unavailable.'
        }
      );
    }

    res.end();
  });

  req.pipe(upstream);
}

const server = http.createServer(
  (req, res) => {
    const url = new URL(
      req.url,
      `http://${req.headers.host || 'localhost'}`
    );

    // Nothing except API traffic is exposed through this gateway.
    if (
      !url.pathname.startsWith('/api/') &&
      url.pathname !== '/health'
    ) {
      return sendJson(
        res,
        404,
        {
          error: 'Not found'
        }
      );
    }

    // Render must prove that the request came through
    // our trusted Render proxy.
    if (!authorized(req)) {
      return sendJson(
        res,
        403,
        {
          error: 'Forbidden'
        }
      );
    }

    if (
      req.method === 'GET' &&
      url.pathname === '/health'
    ) {
      return sendJson(
        res,
        200,
        {
          ok: true,
          service: 'bayan-onprem-gateway',
          coreHost: CORE_HOST,
          corePort: CORE_PORT
        }
      );
    }

    return proxyToCore(req, res);
  }
);

server.listen(
  GATEWAY_PORT,
  '127.0.0.1',
  () => {
    console.log(
      `BayanSpaces on-prem gateway is running on http://127.0.0.1:${GATEWAY_PORT}`
    );

    console.log(
      `Forwarding authorized API requests to http://${CORE_HOST}:${CORE_PORT}`
    );
  }
);