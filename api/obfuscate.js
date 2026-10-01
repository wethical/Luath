"use strict";

// ============================================================
//  Ninja Lua Obfuscator - Vercel Serverless 混淆 API
//  与 server/server.js 的 /api/obfuscate 行为一致，
//  供 Vercel 云端函数托管（POST /api/obfuscate）。
// ============================================================

const Obfuscator = require('../server/obfuscator.js');

// 输入上限：256KB 源码（与 server.js 一致）
const MAX_INPUT_SIZE = 256 * 1024;

// 引擎默认配置副本（每次请求前重置，避免脏数据）
const DEFAULT_CONFIG = JSON.parse(JSON.stringify(Obfuscator.config));

function sendJson(res, status, obj) {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  res.end(JSON.stringify(obj));
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

module.exports = async function handler(req, res) {
  if (req.method === 'OPTIONS') {
    res.statusCode = 204;
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    res.end();
    return;
  }

  if (req.method !== 'POST') {
    sendJson(res, 405, { error: '方法不允许' });
    return;
  }

  try {
    const raw = await readBody(req, MAX_INPUT_SIZE);
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

    const result = Obfuscator.obfuscate(code);
    sendJson(res, 200, {
      code: result.code,
      elapsed: result.elapsed,
      overLimit: result.overLimit,
      nearLimit: result.nearLimit,
      stats: result.stats || null,
    });
  } catch (e) {
    const msg = e && e.message ? e.message : String(e);
    if (msg.includes('超过大小限制')) {
      sendJson(res, 413, { error: '请求体超过 256KB 大小限制' });
      return;
    }
    sendJson(res, 500, { error: '混淆失败: ' + msg });
  }
};