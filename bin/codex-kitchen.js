#!/usr/bin/env node
// codex-kitchen CLI：解析参数 → 启动 server → 自动打开浏览器

import os from 'node:os';
import path from 'node:path';
import { exec } from 'node:child_process';
import { startServer } from '../server/index.js';

function parseArgs(argv) {
  const opts = { port: 4848, demo: false, noOpen: false, sessionsDir: path.join(os.homedir(), '.codex', 'sessions') };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--port') opts.port = parseInt(argv[++i], 10) || opts.port;
    else if (a.startsWith('--port=')) opts.port = parseInt(a.slice(7), 10) || opts.port;
    else if (a === '--demo') opts.demo = true;
    else if (a === '--no-open') opts.noOpen = true;
    else if (a === '--sessions-dir') opts.sessionsDir = argv[++i];
    else if (a.startsWith('--sessions-dir=')) opts.sessionsDir = a.slice(15);
    else if (a === '--help' || a === '-h') {
      console.log(`用法：codex-kitchen [选项]

选项：
  --port <n>           监听端口（默认 4848，被占用时自动自增）
  --demo               演示模式：模拟 3 间厨房的厨师事件流
  --no-open            启动后不自动打开浏览器
  --sessions-dir <p>   codex 会话目录（默认 ~/.codex/sessions）
  -h, --help           显示帮助`);
      process.exit(0);
    }
  }
  return opts;
}

function openBrowser(url) {
  const platform = process.platform;
  const cmd = platform === 'darwin' ? `open "${url}"`
    : platform === 'win32' ? `start "" "${url}"`
    : `xdg-open "${url}"`;
  exec(cmd, () => { /* 打开失败不影响服务 */ });
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));

  // 端口被占则自增，最多尝试 50 个
  let handle = null;
  let port = opts.port;
  for (let i = 0; i < 50; i++) {
    try {
      handle = await startServer({ port, demo: opts.demo, sessionsDir: opts.sessionsDir });
      break;
    } catch (e) {
      if (e && e.code === 'EADDRINUSE') { port += 1; continue; }
      throw e;
    }
  }
  if (!handle) {
    console.error('错误：连续 50 个端口都被占用，请用 --port 指定其他端口。');
    process.exit(1);
  }

  const url = `http://localhost:${port}/`;
  console.log('');
  console.log('🍳 Codex Overcooked 已开火！');
  console.log(`   厨房地址：${url}`);
  console.log(`   模式：${opts.demo ? '演示（模拟数据）' : '真实会话'}`);
  if (!opts.demo) console.log(`   会话目录：${opts.sessionsDir}`);
  if (port !== opts.port) console.log(`   提示：端口 ${opts.port} 被占用，已自动改用 ${port}`);
  console.log('   按 Ctrl+C 熄火关门。');
  console.log('');

  if (!opts.noOpen) openBrowser(url);

  const shutdown = () => {
    console.log('\n🧯 熄火中……');
    handle.close();
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

main().catch((e) => {
  console.error(`启动失败：${e.message}`);
  process.exit(1);
});
