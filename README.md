# Ninja Lua Obfuscator（前后端分离版）

Roblox Lua 5.1 / Luau 代码混淆器。原为单文件 HTML，现拆分为 **Node.js 后端（混淆引擎）** 与 **静态前端（页面交互）** 两部分，支持忍者注入器兼容输出。

## 项目结构

```
ninja-obfuscator-app/
├── package.json          # 项目声明与启动脚本
├── README.md
├── server/               # 后端
│   ├── server.js         # HTTP 服务：混淆 API + 静态托管前端
│   └── obfuscator.js     # 混淆引擎（从原 HTML 迁移，无浏览器依赖）
└── public/               # 前端
    └── index.html        # 页面 UI + 交互（通过 /api/obfuscate 调用后端）
```

## 快速启动

要求 Node.js 18+。

```bash
npm start
# 或
node server/server.js
```

启动后访问：http://127.0.0.1:3000/

自定义端口：`PORT=8080 node server/server.js`

## API 说明

### POST /api/obfuscate

混淆 Lua 代码。

**请求体**（JSON）：

```json
{
  "code": "print('hello')",
  "config": {
    "stringEncrypt": true,
    "varRename": true,
    "varNameLength": 12,
    "junkDensity": 5,
    "strEncStrength": 2,
    "varNameStyle": "long"
  }
}
```

`config` 为可选字段，省略时使用引擎默认配置。所有混淆选项均可传入（与页面左侧面板一一对应）。

**响应**（JSON）：

```json
{
  "code": "do if not(true)then ... end",
  "elapsed": 12,
  "overLimit": false,
  "nearLimit": false,
  "stats": {
    "inputSize": 15,
    "outputSize": 554,
    "stringsEncrypted": 1,
    "steps": ["注释已移除", "..."]
  }
}
```

- `code`：混淆后代码
- `elapsed`：耗时（毫秒）
- `overLimit` / `nearLimit`：输出是否超过/接近 1MB 上限
- `stats`：混淆统计信息

### GET /api/health

健康检查：`{"status":"ok","engine":"Ninja Lua Obfuscator"}`

## 前后端边界

| 职责 | 所在位置 |
| --- | --- |
| UI 渲染、预设、滑块调节、复制/下载/粘贴 | `public/index.html` |
| 混淆算法（变量重命名、字符串加密、虚拟机、反调试套件等 36+ 功能） | `server/obfuscator.js` |
| 混淆选项收集与请求发送 | `public/index.html`（`doObfuscate`） |
| 参数校验、配置合并、混淆执行、结果返回 | `server/server.js` |

引擎内部仅依赖 `Math.random` / `performance.now` / `console`，不含任何 DOM/浏览器 API，可独立于页面运行。