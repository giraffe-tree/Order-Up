// index.js — 纯 Node http 服务：静态托管 ../web + GET /api/snapshot + GET /api/events (SSE)

import http from 'node:http';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { KitchenStore } from './parser.js';
import { SessionWatcher } from './watcher.js';
import { startDemo } from './demo.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const WEB_ROOT = path.resolve(__dirname, '..', 'web');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
};

// web/index.html 缺失时的极简占位页（游戏页面由前端 worker 提供）
const PLACEHOLDER = `<!doctype html>
<html lang="zh-CN">
<head><meta charset="utf-8"><title>Codex Overcooked</title>
<style>body{background:#f7efe3;color:#5b4632;font-family:system-ui,sans-serif;display:flex;align-items:center;justify-content:center;min-height:100vh;margin:0}
.box{text-align:center}.emoji{font-size:64px}h1{font-weight:600}</style></head>
<body><div class="box"><div class="emoji">🍳</div><h1>Codex Overcooked</h1>
<p>后端已开火，游戏前端（web/index.html）正在备菜中……</p></div></body></html>`;

function send(res, code, body, type = 'text/plain; charset=utf-8') {
  res.writeHead(code, { 'Content-Type': type });
  res.end(body);
}

export function startServer({ port, demo = false, sessionsDir, replaySessions, replayLines } = {}) {
  return new Promise((resolve, reject) => {
    const clients = new Set();
    const store = new KitchenStore({
      emit: (ev) => {
        const msg = `data: ${JSON.stringify(ev)}\n\n`;
        for (const res of clients) {
          try { res.write(msg); } catch { clients.delete(res); }
        }
      },
    });

    const tickTimer = setInterval(() => store.tick(), 1000);
    let watcher = null;
    let stopDemo = null;
    if (demo) {
      stopDemo = startDemo(store);
    } else {
      watcher = new SessionWatcher({ dir: sessionsDir, store, replaySessions, replayLines });
      watcher.start().catch((e) => console.error(`扫描会话目录失败：${e.message}`));
    }

    const server = http.createServer(async (req, res) => {
      try {
        await handleRequest(req, res);
      } catch (e) {
        // 任何未预料的单请求错误都不应拖垮整个服务
        try { send(res, 500, 'Internal Server Error'); } catch { /* 连接可能已断 */ }
      }
    });
    // 畸形 HTTP 请求（坏头等）直接回 400，不抛未捕获异常
    server.on('clientError', (err, socket) => {
      try { socket.end('HTTP/1.1 400 Bad Request\r\n\r\n'); } catch { /* 忽略 */ }
    });

    async function handleRequest(req, res) {
      let u;
      try { u = new URL(req.url, 'http://localhost'); } catch { send(res, 400, 'Bad Request'); return; }

      if (u.pathname === '/api/snapshot') {
        let body;
        try { body = JSON.stringify(store.snapshot()); }
        catch { send(res, 500, 'snapshot unavailable'); return; }
        send(res, 200, body, 'application/json; charset=utf-8');
        return;
      }

      // 按需加载：GET /api/kitchen/<id>/history —— 占位厨房点击后完整回放其会话文件。
      // 幂等：已加载的厨房直接返回现状；结果同时通过 SSE 广播 kitchen_updated。
      const histMatch = /^\/api\/kitchen\/([^/]+)\/history$/.exec(u.pathname);
      if (histMatch) {
        let id;
        try { id = decodeURIComponent(histMatch[1]); } catch { send(res, 400, 'Bad Request'); return; }
        if (!watcher) {
          send(res, 404, JSON.stringify({ error: 'demo 模式无历史可加载' }), 'application/json; charset=utf-8');
          return;
        }
        try {
          const kitchen = await watcher.loadKitchen(id);
          if (!kitchen) {
            send(res, 404, JSON.stringify({ error: 'unknown kitchen' }), 'application/json; charset=utf-8');
            return;
          }
          send(res, 200, JSON.stringify({ kitchen }), 'application/json; charset=utf-8');
        } catch (e) {
          send(res, 500, JSON.stringify({ error: String((e && e.message) || e) }), 'application/json; charset=utf-8');
        }
        return;
      }

      if (u.pathname === '/api/events') {        res.writeHead(200, {
          'Content-Type': 'text/event-stream; charset=utf-8',
          'Cache-Control': 'no-cache',
          Connection: 'keep-alive',
          'Access-Control-Allow-Origin': '*',
        });
        res.write(`data: ${JSON.stringify({ type: 'snapshot', ...store.snapshot() })}\n\n`);
        clients.add(res);
        const hb = setInterval(() => { try { res.write(': ping\n\n'); } catch { /* 忽略 */ } }, 15000);
        req.on('close', () => { clearInterval(hb); clients.delete(res); });
        res.on('error', () => { clearInterval(hb); clients.delete(res); });
        return;
      }

      // 静态文件
      let pathname;
      try { pathname = decodeURIComponent(u.pathname); } catch { send(res, 400, 'Bad Request'); return; }
      if (pathname === '/') pathname = '/index.html';
      const filePath = path.normalize(path.join(WEB_ROOT, pathname));
      // 防目录穿越：必须严格位于 WEB_ROOT 之内（边界用分隔符，避免 /web-evil 误判）
      if (filePath !== WEB_ROOT && !filePath.startsWith(WEB_ROOT + path.sep)) { send(res, 403, 'Forbidden'); return; }
      try {
        const data = await fsp.readFile(filePath);
        send(res, 200, data, MIME[path.extname(filePath).toLowerCase()] || 'application/octet-stream');
      } catch {
        if (pathname === '/index.html') send(res, 200, PLACEHOLDER, 'text/html; charset=utf-8');
        else send(res, 404, 'Not Found');
      }
    }

    server.on('error', reject);
    server.listen(port, () => {
      resolve({
        port,
        server,
        close() {
          clearInterval(tickTimer);
          if (watcher) watcher.stop();
          if (stopDemo) stopDemo();
          for (const res of clients) { try { res.end(); } catch { /* 忽略 */ } }
          server.close();
        },
      });
    });
  });
}
