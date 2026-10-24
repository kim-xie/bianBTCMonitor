/**
 * 构建后复制静态资源到 dist 目录
 * TypeScript 编译只会输出 .js 文件，不会复制 HTML 等静态资源，
 * 因此需要手动将前端页面复制到 dist/dashboard 下，确保生产环境可正常访问。
 */
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const srcDashboard = path.join(root, 'src', 'dashboard');
const distDashboard = path.join(root, 'dist', 'dashboard');

function relative(p) {
  return path.relative(root, p).split(path.sep).join('/');
}

function copyFile(src, dest) {
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.copyFileSync(src, dest);
  console.log(`✅ 复制: ${relative(src)} -> ${relative(dest)}`);
}

function copyDir(src, dest) {
  if (!fs.existsSync(src)) return;
  fs.mkdirSync(dest, { recursive: true });
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    const srcPath = path.join(src, entry.name);
    const destPath = path.join(dest, entry.name);
    if (entry.isDirectory()) {
      copyDir(srcPath, destPath);
    } else {
      fs.copyFileSync(srcPath, destPath);
      console.log(`✅ 复制: ${relative(srcPath)} -> ${relative(destPath)}`);
    }
  }
}

function main() {
  console.log('📦 开始复制静态资源...');

  // 主仪表板页面（React 单页应用，访问 / 时使用）
  const indexHtml = path.join(srcDashboard, 'index.html');
  if (fs.existsSync(indexHtml)) {
    copyFile(indexHtml, path.join(distDashboard, 'index.html'));
  } else {
    console.warn(`⚠️  未找到 ${relative(indexHtml)}，跳过`);
  }

  // public 目录（login/subscription/management/dashboard 等静态页面）
  const publicDir = path.join(srcDashboard, 'public');
  copyDir(publicDir, path.join(distDashboard, 'public'));

  console.log('✅ 静态资源复制完成');
}

main();
