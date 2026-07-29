import qrcode from 'qrcode-terminal';
import { createServer, request } from 'http';
import { networkInterfaces } from 'os';

function getLocalIp() {
  const nets = networkInterfaces();
  for (const name of Object.keys(nets)) {
    for (const net of nets[name] || []) {
      if (net.family === 'IPv4' && !net.internal) {
        return net.address;
      }
    }
  }
  return 'localhost';
}

const LOCAL_IP = getLocalIp();
const TARGET_PORT = 7739;
const START_PORT = 6969;
const MAX_PORT = START_PORT + 100;

function tryListen(server, port, maxPort) {
  return new Promise((resolve, reject) => {
    server.listen(port, '0.0.0.0', () => resolve(port));
    server.on('error', (err) => {
      if (err.code === 'EADDRINUSE' && port < maxPort) {
        tryListen(server, port + 1, maxPort).then(resolve).catch(reject);
      } else {
        reject(err);
      }
    });
  });
}

const server = createServer((req, res) => {
  const options = {
    hostname: 'localhost',
    port: TARGET_PORT,
    path: req.url,
    method: req.method,
    headers: req.headers,
  };

  const proxyReq = request(options, (proxyRes) => {
    res.writeHead(proxyRes.statusCode || 200, proxyRes.headers);
    proxyRes.pipe(res);
  });

  proxyReq.on('error', (err) => {
    console.error('Proxy error:', err.message);
    res.writeHead(502);
    res.end(`Bad Gateway: Is the dev server running on port ${TARGET_PORT}?`);
  });

  req.pipe(proxyReq);
});

// Protocol upgrades — the dev server's HMR socket — must cross the proxy too.
// Answering an upgrade as an ordinary request leaves the client stuck on
// "[vite] connecting..." forever.
server.on('upgrade', (req, clientSocket, head) => {
  const proxyReq = request({
    hostname: 'localhost',
    port: TARGET_PORT,
    path: req.url,
    method: req.method,
    headers: req.headers,
  });

  proxyReq.on('upgrade', (proxyRes, upstreamSocket, upstreamHead) => {
    const lines = [`HTTP/1.1 ${proxyRes.statusCode} ${proxyRes.statusMessage}`];
    for (const [key, value] of Object.entries(proxyRes.headers)) {
      for (const one of Array.isArray(value) ? value : [value]) {
        if (one !== undefined) lines.push(`${key}: ${one}`);
      }
    }
    clientSocket.write(`${lines.join('\r\n')}\r\n\r\n`);
    if (upstreamHead?.length) clientSocket.write(upstreamHead);
    if (head?.length) upstreamSocket.write(head);

    const drop = () => { upstreamSocket.destroy(); clientSocket.destroy(); };
    upstreamSocket.on('error', drop);
    clientSocket.on('error', drop);
    upstreamSocket.pipe(clientSocket);
    clientSocket.pipe(upstreamSocket);
  });

  proxyReq.on('error', () => clientSocket.destroy());
  clientSocket.on('error', () => proxyReq.destroy());
  proxyReq.end();
});

tryListen(server, START_PORT, MAX_PORT)
  .then((actualPort) => {
    console.log('\n🚀 Starting proxy server...\n');
    console.log(`   Local:    http://localhost:${TARGET_PORT}`);
    console.log(`   Proxy:    http://0.0.0.0:${actualPort}`);
    console.log(`   Network:  http://${LOCAL_IP}:${actualPort}\n`);
    console.log('📱 Scan QR code to access from mobile:');
    console.log('');
    qrcode.generate(`http://${LOCAL_IP}:${actualPort}`, { small: true });
    console.log('');
    console.log(`✓ Proxy active: localhost:${TARGET_PORT} ←→ 0.0.0.0:${actualPort}\n`);
  })
  .catch((err) => {
    console.error('Failed to start proxy:', err.message);
    process.exit(1);
  });

process.on('SIGINT', () => {
  console.log('\n👋 Shutting down proxy...');
  server.close(() => process.exit(0));
});
