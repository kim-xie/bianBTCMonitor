/**
 * 提交前检查。页面脚本能解析，TypeScript 能通过，服务能启动并返回监控页。
 * 上次少一个逗号时，tsc 仍然通过，但浏览器整页是黑的。这里直接解析监控页脚本。
 */
const { spawn } = require('child_process');
const fs = require('fs');
const http = require('http');
const path = require('path');
const parser = require('@babel/parser');

const root = path.join(__dirname, '..');

function parseDashboard(html, label) {
  const re = /<script\s+type="text\/babel"[^>]*>([\s\S]*?)<\/script>/gi;
  let match;
  let count = 0;
  while ((match = re.exec(html))) {
    count += 1;
    try {
      parser.parse(match[1], {
        sourceType: 'script',
        plugins: ['jsx']
      });
    } catch (error) {
      const message = error && error.message ? error.message : String(error);
      console.error(`${label} 第 ${count} 段脚本无法解析，页面会黑屏:`);
      console.error(message.split('\n').slice(0, 12).join('\n'));
      process.exit(1);
    }
  }
  if (count === 0) {
    console.error(`${label} 没有找到 text/babel 脚本`);
    process.exit(1);
  }
  console.log(`页面脚本解析通过: ${label} (${count} 段)`);
}

function run(command, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd: root, stdio: 'inherit' });
    child.on('error', reject);
    child.on('exit', (code) => {
      if (code === 0) resolve();
      else reject(new Error(`${command} ${args.join(' ')} 退出码 ${code}`));
    });
  });
}

function fetchPage(port) {
  return new Promise((resolve, reject) => {
    const req = http.get(`http://127.0.0.1:${port}/`, (res) => {
      let body = '';
      res.on('data', (chunk) => {
        body += chunk;
      });
      res.on('end', () => {
        if (res.statusCode !== 200) {
          reject(new Error(`监控页 HTTP ${res.statusCode}`));
          return;
        }
        resolve(body);
      });
    });
    req.on('error', reject);
    req.setTimeout(2000, () => {
      req.destroy(new Error('请求监控页超时'));
    });
  });
}

function stopServer(child) {
  if (!child || child.exitCode !== null) return Promise.resolve();
  child.kill('SIGTERM');
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      if (child.exitCode === null) child.kill('SIGKILL');
    }, 2000);
    child.on('exit', () => {
      clearTimeout(timer);
      resolve();
    });
  });
}

async function waitForPage(child, port, logs) {
  const deadline = Date.now() + 20000;
  let lastError = null;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) {
      console.error(logs.slice(-2000));
      throw new Error(`服务启动后退出，退出码 ${child.exitCode}`);
    }
    try {
      return await fetchPage(port);
    } catch (error) {
      lastError = error;
      await new Promise((resolve) => setTimeout(resolve, 300));
    }
  }
  console.error(logs.slice(-2000));
  throw new Error(`服务在 20 秒内没有返回监控页: ${lastError ? lastError.message : ''}`);
}

async function main() {
  const htmlPath = path.join(root, 'src', 'dashboard', 'index.html');
  parseDashboard(fs.readFileSync(htmlPath, 'utf8'), 'src/dashboard/index.html');

  const tsc = path.join(root, 'node_modules', '.bin', 'tsc');
  await run(tsc, ['--noEmitOnError', '--pretty', 'false']);
  await run(process.execPath, [path.join(root, 'scripts', 'copy-assets.js')]);

  const port = process.env.VERIFY_PORT || '3099';
  let logs = '';
  const child = spawn(process.execPath, [path.join(root, 'dist', 'dashboard', 'server.js')], {
    cwd: root,
    env: {
      ...process.env,
      PORT: port,
      MONGODB_URI: process.env.MONGODB_URI || 'mongodb://127.0.0.1:27017/btc-trading-verify'
    },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  child.stdout.on('data', (chunk) => {
    logs += chunk.toString();
  });
  child.stderr.on('data', (chunk) => {
    logs += chunk.toString();
  });

  try {
    const body = await waitForPage(child, port, logs);
    if (!body.includes('id="root"') || !body.includes('text/babel')) {
      throw new Error('返回的页面不是监控页');
    }
    parseDashboard(body, '运行中的监控页');
    console.log(`服务已启动并返回监控页: http://127.0.0.1:${port}/`);
  } finally {
    await stopServer(child);
  }
}

main().catch((error) => {
  console.error(error && error.message ? error.message : error);
  process.exit(1);
});
