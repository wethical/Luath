"use strict";

// ============================================================
//  Ninja Lua Obfuscator - 后端服务
//  职责：
//    1. 加载混淆引擎（obfuscator.js），提供混淆 API
//    2. 静态托管前端页面（../public）
//  用法：
//    node server.js           # 默认 3000 端口
//    PORT=8080 node server.js # 指定端口
// ============================================================

const http = require('http');
const fs = require('fs');
const path = require('path');
const Obfuscator = require('./obfuscator.js');

const PORT = parseInt(process.env.PORT || '3000', 10);
const HOST = process.env.HOST || '127.0.0.1';
const PUBLIC_DIR = path.join(__dirname, '..', 'public');

// 输入上限：256KB 源码；输出上限 1MB（与引擎一致）
const MAX_INPUT_SIZE = 256 * 1024;

// 引擎默认配置副本（每次请求前重置，避免脏数据）
const DEFAULT_CONFIG = JSON.parse(JSON.stringify(Obfuscator.config));

// ============================================================
//  工具函数
// ============================================================

function sendJson(res, status, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
  });
  res.end(body);
}

function readBody(req, limit) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > limit) {
        reject(new Error('请求体超过大小限制'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.txt': 'text/plain; charset=utf-8',
};

function serveStatic(res, urlPath) {
  // 防目录穿越
  let rel = decodeURIComponent(urlPath);
  if (rel === '/' || rel === '') rel = '/index.html';
  const filePath = path.normalize(path.join(PUBLIC_DIR, rel));
  if (!filePath.startsWith(PUBLIC_DIR + path.sep) && filePath !== path.join(PUBLIC_DIR, 'index.html')) {
    sendJson(res, 403, { error: '禁止访问' });
    return;
  }
  fs.readFile(filePath, (err, data) => {
    if (err) {
      sendJson(res, 404, { error: '资源不存在' });
      return;
    }
    const ext = path.extname(filePath).toLowerCase();
    res.writeHead(200, {
      'Content-Type': MIME[ext] || 'application/octet-stream',
      'Cache-Control': 'no-cache',
    });
    res.end(data);
  });
}

// ============================================================
//  混淆 API
// ============================================================

function handleObfuscate(req, res) {
  readBody(req, MAX_INPUT_SIZE).then((raw) => {
    let payload;
    try {
      payload = JSON.parse(raw);
    } catch (e) {
      sendJson(res, 400, { error: '请求体必须是合法 JSON' });
      return;
    }
    const code = typeof payload.code === 'string' ? payload.code : '';
    if (!code.trim()) {
      sendJson(res, 400, { error: '源代码不能为空' });
      return;
    }
    if (code.length > MAX_INPUT_SIZE) {
      sendJson(res, 413, { error: '源代码超过 256KB 输入上限' });
      return;
    }

    // 重置配置，再合并前端传入的配置（白名单字段）
    Obfuscator.config = JSON.parse(JSON.stringify(DEFAULT_CONFIG));
    if (payload.config && typeof payload.config === 'object') {
      for (const key of Object.keys(Obfuscator.config)) {
        if (key in payload.config) {
          Obfuscator.config[key] = payload.config[key];
        }
      }
    }

    try {
      const result = Obfuscator.obfuscate(code);
      sendJson(res, 200, {
        code: result.code,
        elapsed: result.elapsed,
        overLimit: result.overLimit,
        nearLimit: result.nearLimit,
        stats: result.stats || null,
      });
    } catch (e) {
      sendJson(res, 500, { error: '混淆失败: ' + (e && e.message ? e.message : String(e)) });
    }
  }).catch((err) => {
    sendJson(res, 413, { error: err.message || '请求体读取失败' });
  });
}

// ============================================================
//  路由
// ============================================================

const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://' + req.headers.host || 'localhost');
  const pathname = url.pathname;

  if (req.method === 'OPTIONS') {
    res.writeHead(204, {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
    });
    res.end();
    return;
  }

  if (req.method === 'POST' && pathname === '/api/obfuscate') {
    handleObfuscate(req, res);
    return;
  }

  if (req.method === 'GET') {
    if (pathname === '/api/health') {
      sendJson(res, 200, { status: 'ok', engine: 'Ninja Lua Obfuscator' });
      return;
    }
    serveStatic(res, pathname);
    return;
  }

  sendJson(res, 405, { error: '方法不允许' });
});

server.listen(PORT, HOST, () => {
  console.log('[Ninja Obfuscator] 后端服务已启动');
  console.log('  前端页面: http://' + HOST + ':' + PORT + '/');
  console.log('  混淆 API: POST http://' + HOST + ':' + PORT + '/api/obfuscate');
});