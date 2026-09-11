const http = require('http');
const fs = require('fs');
const path = require('path');

const PORT = Number(process.env.BOOKING_PORT || 6500);
const CORE_PORT = Number(process.env.CORE_PORT || 5177);
const PUBLIC = path.join(__dirname, 'public');
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8' };

function serve(res, name) {
  const file = path.join(PUBLIC, name);
  if (!file.startsWith(PUBLIC) || !fs.existsSync(file)) { res.writeHead(404); return res.end('Not found'); }
  res.writeHead(200, { 'Content-Type': TYPES[path.extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-store' });
  fs.createReadStream(file).pipe(res);
}
function proxy(req, res) {
  const upstream = http.request({ hostname: '127.0.0.1', port: CORE_PORT, path: req.url, method: req.method, headers: req.headers }, response => {
    res.writeHead(response.statusCode || 502, response.headers);
    response.pipe(res);
  });
  upstream.on('error', () => { res.writeHead(503, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: 'Booking service is temporarily unavailable. Start the main server on port 5177.' })); });
  req.pipe(upstream);
}

http.createServer((req, res) => {
  const pathname = new URL(req.url, `http://${req.headers.host}`).pathname;
  if (pathname.startsWith('/api/tenant/') || pathname === '/api/login' || pathname === '/api/booking-admin' || pathname === '/api/tenants' || pathname.startsWith('/api/tenants/') || pathname === '/api/rooms' || pathname.startsWith('/api/rooms/') || pathname.startsWith('/api/bookings/') || pathname.startsWith('/api/tenant-reports/')) return proxy(req, res);
  if (pathname === '/' || pathname === '/booking') return serve(res, 'booking.html');
  if (pathname === '/admin') return serve(res, 'booking-admin.html');
  if (req.method === 'GET' && ['booking.js', 'booking.css', 'booking-admin.js', 'booking-admin.css'].includes(pathname.slice(1))) return serve(res, pathname.slice(1));
  if (pathname === '/health') { res.writeHead(200, { 'Content-Type': 'application/json' }); return res.end(JSON.stringify({ ok: true, service: 'tenant-booking', corePort: CORE_PORT })); }
  res.writeHead(404, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: 'Not found' }));
}).listen(PORT, '0.0.0.0', () => console.log(`Tenant booking service is running on http://0.0.0.0:${PORT}`));
