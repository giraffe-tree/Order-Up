// devtool-server.mjs — js3d 自测/截图/perf 专用静态服务器（dev-only，不参与产品运行）
// 用法：node web/js3d/devtool-server.mjs [port]
//   - 静态托管 web/ 目录（ES module 需要 http 协议，file:// 会被 CORS 拦）
//   - GET /__perf?avg=8.2&frames=300 → 把结果写入 web/js3d/.perf-result.txt 并打印 PERF_RESULT
//     （?perf=1&report=1 模式下 test.html 跑完 300 帧后上报；供无头 Chrome 真实时间测帧耗时）
import http from 'node:http';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const WEB = path.resolve(HERE, '..');
const RESULT_FILE = path.join(HERE, '.perf-result.txt');
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.png': 'image/png',
  '.json': 'application/json',
};

const port = Number(process.argv[2] || 8123);
http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, 'http://x');
    if (url.pathname === '/__perf') {
      const line = `PERF_RESULT avg=${url.searchParams.get('avg')} max=${url.searchParams.get('max')} frames=${url.searchParams.get('frames')} errs=${url.searchParams.get('errs')}`;
      await fsp.writeFile(RESULT_FILE, line + '\n');
      console.log(line);
      res.writeHead(200, { 'Content-Type': 'text/plain' });
      res.end('ok');
      return;
    }
    const rel = decodeURIComponent(url.pathname).replace(/^\/+/, '') || 'index.html';
    const file = path.join(WEB, rel);
    if (!file.startsWith(WEB)) { res.writeHead(403); res.end(); return; }
    const data = await fsp.readFile(file);
    res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-store' });
    res.end(data);
  } catch {
    res.writeHead(404); res.end('not found');
  }
}).listen(port, () => console.log(`devtool-server up: http://127.0.0.1:${port}/ (root=${WEB})`));
