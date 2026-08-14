// Vytreos preview server.
// Serves /public as static SPA and proxies /api/* to api/*.js (Vercel-style handlers).
// No external dependencies. Honours $PORT injected by Freebuff.

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Load .env.local (dev secrets) if present, mirroring Vercel's env behaviour,
// so keys added via freebuff-env reach the preview process. Existing process
// env (e.g. Vercel production) always wins.
function loadLocalEnv(file) {
  let raw;
  try { raw = fs.readFileSync(file, 'utf8'); } catch { return; }
  for (const line of raw.split('\n')) {
    const m = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line);
    if (!m) continue;
    const key = m[1];
    if (process.env[key] !== undefined) continue;
    let val = m[2].trim();
    if (val.length >= 2 &&
        ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'")))) {
      val = val.slice(1, -1);
    }
    if (val) process.env[key] = val;
  }
}
loadLocalEnv(path.join(__dirname, '.env.local'));

const PORT = Number(process.env.PORT) || 3000;
const HOST = '0.0.0.0';
const PUBLIC_DIR = path.join(__dirname, 'public');
const API_DIR = path.join(__dirname, 'api');
const MAX_BYTES = 5_000_000; // matches api/analyze.js cap

// Map URL → handler file under /api.
const API_ROUTES = {
  '/api/analyze': 'analyze.js',
  '/api/sendcode': 'code.js',
  '/api/verifycode': 'code.js',
};

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js':   'application/javascript; charset=utf-8',
  '.mjs':  'application/javascript; charset=utf-8',
  '.css':  'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg':  'image/svg+xml',
  '.png':  'image/png',
  '.jpg':  'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.ico':  'image/x-icon',
  '.txt':  'text/plain; charset=utf-8',
  '.xml':  'application/xml; charset=utf-8',
  '.map':  'application/json; charset=utf-8',
};

function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    const declared = Number(req.headers['content-length'] ?? 0);
    if (declared > MAX_BYTES) {
      return reject(Object.assign(new Error('Payload too large'), { statusCode: 413 }));
    }
    const chunks = [];
    let total = 0;
    req.on('data', (c) => {
      total += c.length;
      if (total > MAX_BYTES) {
        req.destroy();
        return reject(Object.assign(new Error('Payload too large'), { statusCode: 413 }));
      }
      chunks.push(c);
    });
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      if (!raw) return resolve({});
      try { resolve(JSON.parse(raw)); } catch (e) { reject(e); }
    });
    req.on('error', reject);
  });
}

// Adapter that imitates the Vercel serverless `res` API used by api/*.js.
function makeVercelRes(res) {
  const obj = {
    status(code) { res.statusCode = code; return obj; },
    json(payload) {
      if (!res.getHeader('Content-Type')) {
        res.setHeader('Content-Type', 'application/json; charset=utf-8');
      }
      res.end(JSON.stringify(payload));
      return obj;
    },
    send(body) { res.end(body); return obj; },
    setHeader(k, v) { res.setHeader(k, v); return obj; },
    end() { res.end(); return obj; },
  };
  return obj;
}

async function handleApi(handlerFile, req, res) {
  const url = new URL(req.url, 'http://localhost');
  const body = (req.method === 'GET' || req.method === 'HEAD') ? {} : await readJsonBody(req);
  const vReq = {
    method: req.method,
    headers: req.headers,
    body,
    query: Object.fromEntries(url.searchParams),
  };
  // Cache-bust the dynamic import so edits to api/*.js are picked up without restart.
  const fileUrl = pathToFileURL(path.join(API_DIR, handlerFile)).href;
  const mod = await import(`${fileUrl}?t=${Date.now()}`);
  await mod.default(vReq, makeVercelRes(res));
}

function handleHealth(_req, res) {
  res.statusCode = 200;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  res.end(JSON.stringify({
    ok: true,
    service: 'vytreos-preview',
    time: new Date().toISOString(),
    port: PORT,
  }));
}

function serveStatic(req, res) {
  let urlPath;
  try { urlPath = decodeURIComponent(req.url.split('?')[0]); }
  catch { urlPath = req.url.split('?')[0]; }

  if (urlPath === '/') urlPath = '/index.html';

  // Resolve under PUBLIC_DIR; reject anything that escapes it.
  // PUBLIC_DIR does not end with a separator, so use PUBLIC_DIR + path.sep
  // to avoid sibling-prefix bypass (e.g. /public-evil matching /public).
  const candidate = path.normalize(path.join(PUBLIC_DIR, urlPath));
  if (candidate !== PUBLIC_DIR && !candidate.startsWith(PUBLIC_DIR + path.sep)) {
    res.statusCode = 403;
    res.end('Forbidden');
    return;
  }

  fs.stat(candidate, (err, stat) => {
    if (err || !stat.isFile()) {
      return sendFile(path.join(PUBLIC_DIR, 'index.html'), res);
    }
    sendFile(candidate, res);
  });
}

function sendFile(filePath, res) {
  fs.readFile(filePath, (err, data) => {
    if (err) {
      res.statusCode = 404;
      res.setHeader('Content-Type', 'text/plain; charset=utf-8');
      res.end('Not Found');
      return;
    }
    const ext = path.extname(filePath).toLowerCase();
    res.setHeader('Content-Type', MIME[ext] || 'application/octet-stream');
    if (ext === '.html') {
      res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
    }
    res.end(data);
  });
}

const server = http.createServer(async (req, res) => {
  try {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS, HEAD');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');

    if (req.method === 'OPTIONS') {
      res.statusCode = 204;
      res.end();
      return;
    }

    const urlPath = req.url.split('?')[0];

    if (urlPath === '/api/health' && (req.method === 'GET' || req.method === 'HEAD')) {
      handleHealth(req, res);
      return;
    }

    const apiFile = API_ROUTES[urlPath];
    if (apiFile) {
      try {
        await handleApi(apiFile, req, res);
      } catch (e) {
        if (e && e.statusCode === 413) {
          res.statusCode = 413;
          res.setHeader('Content-Type', 'application/json; charset=utf-8');
          res.end(JSON.stringify({ error: 'Payload too large', maxBytes: MAX_BYTES }));
          return;
        }
        res.statusCode = 400;
        res.setHeader('Content-Type', 'application/json; charset=utf-8');
        res.end(JSON.stringify({ error: 'Bad request: ' + (e.message || 'parse error') }));
      }
      return;
    }
    serveStatic(req, res);
  } catch (e) {
    console.error('[server] error:', e);
    if (!res.headersSent) {
      res.statusCode = 500;
      res.setHeader('Content-Type', 'application/json; charset=utf-8');
      res.end(JSON.stringify({ error: e.message || 'Internal Server Error' }));
    }
  }
});

server.listen(PORT, HOST, () => {
  console.log(`Vytreos preview server listening on http://${HOST}:${PORT}`);
  console.log(`  static: ${PUBLIC_DIR}`);
  console.log(`  api:    ${API_DIR}`);
});
