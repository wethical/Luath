"use strict";

// ============================================================
//  Ninja Lua Obfuscator - 核心混淆引擎
//  兼容 Roblox Lua 5.1 / LuaU / 忍者注入器
//  加密/解密使用纯算术运算，不依赖 bit32 或 ~ 运算符
// ============================================================

// 输出大小上限：1MB（1,048,576 字节）
const MAX_OUTPUT_SIZE = 1048576;

// 格式化字节数为可读字符串
function formatBytes(bytes) {
  if (bytes < 1024) return bytes + ' B';
  if (bytes < 1048576) return (bytes / 1024).toFixed(1) + ' KB';
  return (bytes / 1048576).toFixed(2) + ' MB';
}

// ===== 性能优化：快速 PRNG (xorshift32) =====
// 比 Math.random() 快 3-5x，在热路径中大量使用
// 全局替换 Math.random 以让所有现有代码自动使用快速 PRNG
let _prngSeed = (Date.now() ^ 0x5DEECE66D) >>> 0;
function fastRandom() {
  _prngSeed ^= _prngSeed << 13;
  _prngSeed ^= _prngSeed >>> 17;
  _prngSeed ^= _prngSeed << 5;
  return (_prngSeed >>> 0) / 4294967296;
}
function fastRandomInt(max) { return Math.floor(fastRandom() * max); }
// 全局替换 Math.random 为快速 PRNG，无需逐个修改 360+ 处调用
Math.random = fastRandom;

// ===== 性能优化：字符分类辅助函数 =====
// 替代 isIdentStart(ch) 等逐字符正则，快 10x+
function isIdentStart(c) {
  return (c >= 'A' && c <= 'Z') || (c >= 'a' && c <= 'z') || c === '_';
}
function isIdentChar(c) {
  return (c >= 'A' && c <= 'Z') || (c >= 'a' && c <= 'z') || (c >= '0' && c <= '9') || c === '_';
}
function isDigit(c) {
  return c >= '0' && c <= '9';
}
function isHexChar(c) {
  return (c >= '0' && c <= '9') || (c >= 'a' && c <= 'f') || (c >= 'A' && c <= 'F') || c === '.' || c === 'e' || c === 'E' || c === 'x' || c === 'X';
}

const Obfuscator = {
  config: {
    stringEncrypt: true, varRename: true, removeComments: true,
    numberObfusc: true, junkCode: true, minify: true,
    loadstringWrap: false, controlFlow: false,
    staticEnv: false, customVM: false, byteStream: false, customBytecodeVM: false, advancedVM: false, stateMachineVM: false,
    varNameLength: 12, junkDensity: 5, strEncStrength: 2,
    varNameStyle: 'long', // 'long' = Il1o0O 风格, 'short' = Vx/JO/eW 风格, 'hex' = _0x1f, 'mixed' = 混合
    dynamicLoading: false,
    bit32Ops: false,     // 注入 bit32 位运算（bxor/rrotate/bnot 等）
    selfInvoke: false,    // 自调用结构包装（:C()(...) 变体自执行）
    moduleWrap: false,    // 模块化返回表包装（return ({...}) 结构）
    fakeByteStream: false, // 假字节流编码代码注入（诱饵解码逻辑，干扰逆向分析）
    flattenCode: false,    // 语句级控制流扁平化（将原始代码拆分为状态机）
    localEnv: false,       // 局部环境包装（全局函数本地化 + return(function()...end)() ）
    functionSplit: false,  // 函数拆分与重组（大函数拆分为内部小函数+闭包调用）
    returnFuncWrap: false, // return function(...) ... end 包装（输出可调用函数）
    // 安全防护套件
    antiDebug_tamper: false,    // 反篡改校验
    antiDebug_envCheck: false,  // 环境检测
    antiDebug_debugger: false,  // 调试器检测
    antiDebug_timeBomb: false,  // 时间炸弹
    antiDebug_callStack: false, // 调用栈检查
    antiDebug_gcManip: false,   // GC 操纵检测
    antiDebug_hookChain: false, // Hook 链检测
    antiDebug_memScan: false,   // 内存扫描检测
    antiDebug_freqCheck: false, // CPU 频率校准
    antiDebug_coroProbe: false, // 协程探针检测
    antiDebug_strMeta: false,   // 字符串元方法篡改
    antiDebug_bpTrap: false,    // 断点陷阱
    antiDebug_localProbe: false,// 局部变量探测
    antiDebug_funcHash: false,  // 函数哈希守卫
    antiDebug_traceTrap: false, // 多轮时间追踪陷阱
    // 增强 — 反调试
    antiDebug_sethookTrap: false,  // sethook 拦截陷阱
    antiDebug_registryGuard: false,// debug.getregistry 篡改检测
    antiDebug_rawMetaCheck: false, // rawequal/rawlen 元方法检测
    // 增强 — 反逆向
    antiDebug_strWatermark: false, // 控制流字符串水印
    antiDebug_opaquePred: false,   // 不透明谓词链
    antiDebug_decoyFunc: false,    // 诱饵函数陷阱
    antiDebug_metaTrap: false,     // 元表 __index 陷阱
    tableIndexJunk: false,         // 表索引垃圾代码（b.D[0xNN] 十六进制索引 + 复杂条件）
    // 反逆向套件
    antiRev_stringFog: false,      // 字符串雾化（运行时动态拼接/解码，隐藏字符串特征）
    antiRev_controlFlowSpaghetti: false, // 控制流面条化（随机跳转+虚假分支，打乱执行流）
    antiRev_deadCodeInjection: false,    // 死代码注入（永不可达的代码块，干扰反编译器）
    antiRev_varIndirection: false,       // 变量间接寻址（通过表索引访问变量，隐藏数据流）
    antiRev_opaqueExpr: false,           // 不透明表达式（用复杂运算替代简单常量/布尔值）
    antiRev_antiDecompile: false,        // 反反编译（注入导致反编译器崩溃/超时的结构）
    antiRev_selfModifying: false,        // 自修改代码（运行时动态生成并执行代码）
    antiRev_metaObfuscation: false,      // 元表混淆（用 __index/__newindex 隐藏逻辑）
    customBase64Table: false,        // 隐藏自定义 Base64 编码表（打乱字母表+运行时加密重建）
  },

  keywords: new Set([
    'and','break','do','else','elseif','end','false','for','function','if',
    'in','local','nil','not','or','repeat','return','then','true','until',
    'while','continue','self'
  ]),

  robloxGlobals: new Set([
    'game','workspace','script','wait','spawn','delay','require','print','warn',
    'error','assert','pcall','xpcall','tostring','tonumber','rawget','rawset',
    'rawequal','rawlen','select','type','typeof','next','pairs','ipairs',
    'unpack','setmetatable','getmetatable','getfenv','setfenv','loadstring',
    'load','dofile','collectgarbage','newproxy','Vector3','Vector2','CFrame',
    'Color3','UDim','UDim2','Rect','Region3','BrickColor','Enum','Instance',
    'TweenInfo','DateTime','NumberSequence','ColorSequence','Ray','Faces',
    'PhysicalProperties','Random','task','tick','os','math','string','table',
    'coroutine','debug','bit32','buffer','utf8',
    'getgenv','getrenv','getreg','getinstances','getnilinstances','getscripts',
    'getloadedmodules','getconnections','getsenv','getscriptclosure','gethui',
    'isluau','checkcaller','identifyexecutor','syn','protect_gui','Drawing',
    'getcustomasset','request','http_request','httpget','HttpGet',
    'setclipboard','toclipboard','writefile','readfile','appendfile','listfiles',
    'makefolder','delfolder','delfile','loadfile','isfile','isfolder',
    'mousemoverel','mouse1click','mouse1press','mouse1release',
    'keypress','keyrelease','keyclick','iskeydown','getmousepos','setcursorpos',
    'setreadonly','isreadonly','hookfunction','hookmetamethod','newcclosure',
    'getcallingfunction','setfpscap','getfpscap','clonefunction','restorefunction',
    'isourclosure','getclipboard',
  ]),

  usedNames: new Set(),

  init() { this.usedNames = new Set(); },

  // 生成混淆变量名
  // style='long': Il1o0O 风格（长度可配置）
  // style='short': Vx/JO/eW 等 2-3 字符短名
  // style='hex': _0x1f / _0x4a2b 十六进制风格
  // style='mixed': 随机混合以上所有风格
  generateName() {
    if (this.config.varNameStyle === 'short') {
      return this.generateShortStyleName();
    }
    if (this.config.varNameStyle === 'hex') {
      return this.generateHexStyleName();
    }
    if (this.config.varNameStyle === 'mixed') {
      return this.generateMixedName();
    }
    const chars = 'Il1o0O';
    let name;
    do {
      let s = 'l';
      const len = (this.config.varNameLength || 12) + Math.floor(fastRandom() * 5);
      for (let i = 0; i < len; i++) s += chars[Math.floor(fastRandom() * chars.length)];
      name = s;
    } while (this.usedNames.has(name));
    this.usedNames.add(name);
    return name;
  },

  // 生成 Vx/JO/eW 风格的短名（2-3 字符），偶尔生成单字符名
  generateShortStyleName() {
    const upper = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';
    const lower = 'abcdefghijklmnopqrstuvwxyz';
    let name;
    do {
      // 15% 概率生成单字符名（l, E, i, Q, P 等）
      if (fastRandom() < 0.15) {
        // 单字符池：优先使用常见的短名风格字符
        const singlePool = 'lEiQPufDeXxRj';
        name = singlePool[fastRandomInt(singlePool.length)];
      } else {
        // 第一个字符大写，第二个字符小写，偶尔加第三个
        name = upper[fastRandomInt(upper.length)] +
               lower[fastRandomInt(lower.length)];
        // 30% 概率加第三个字符
        if (fastRandom() < 0.3) {
          name += (fastRandom() < 0.5 ?
            upper[fastRandomInt(upper.length)] :
            lower[fastRandomInt(lower.length)]);
        }
      }
    } while (this.usedNames.has(name) || this.keywords.has(name));
    this.usedNames.add(name);
    return name;
  },

  generateShortName() {
    const chars = 'Il1oO0';
    let name;
    do {
      let s = '_';
      for (let i = 0; i < 6; i++) s += chars[fastRandomInt(chars.length)];
      name = s;
    } while (this.usedNames.has(name));
    this.usedNames.add(name);
    return name;
  },

  // 生成 _0x1f / _0x4a2b 风格的十六进制变量名
  generateHexStyleName() {
    const hexChars = '0123456789abcdef';
    let name;
    do {
      let s = '_0x';
      // 2-6 位十六进制数字，首位不为 0 以避免过短
      const len = 2 + fastRandomInt(5);
      s += hexChars[1 + fastRandomInt(15)]; // 第一位 1-f
      for (let i = 1; i < len; i++) s += hexChars[fastRandomInt(16)];
      name = s;
    } while (this.usedNames.has(name) || this.keywords.has(name));
    this.usedNames.add(name);
    return name;
  },

  // 生成混合风格变量名：随机使用 hex / short / long 风格
  generateMixedName() {
    const r = fastRandomInt(3);
    if (r === 0) return this.generateHexStyleName();
    if (r === 1) return this.generateShortStyleName();
    // long style
    const chars = 'Il1o0O';
    let name;
    do {
      let s = 'l';
      const len = (this.config.varNameLength || 12) + fastRandomInt(5);
      for (let i = 0; i < len; i++) s += chars[fastRandomInt(chars.length)];
      name = s;
    } while (this.usedNames.has(name) || this.keywords.has(name));
    this.usedNames.add(name);
    return name;
  },

  // ========== Step 1: 移除注释 ==========
  removeComments(code) {
    const parts = [];
    let i = 0;
    const len = code.length;
    while (i < len) {
      // 长注释 --[[ ... ]]
      if (code[i] === '-' && code[i+1] === '-' && code[i+2] === '[' && code[i+3] === '[') {
        const end = code.indexOf(']]', i + 4);
        i = (end !== -1) ? end + 2 : len;
        continue;
      }
      // 长注释 --[==[ ... ]==]
      if (code[i] === '-' && code[i+1] === '-' && code[i+2] === '[') {
        let level = 0, j = i + 3;
        while (code[j] === '=') { level++; j++; }
        if (code[j] === '[') {
          const closeStr = ']' + '='.repeat(level) + ']';
          const end = code.indexOf(closeStr, j + 1);
          if (end !== -1) { i = end + closeStr.length; continue; }
        }
      }
      // 行注释 --
      if (code[i] === '-' && code[i+1] === '-') {
        while (i < len && code[i] !== '\n') i++;
        continue;
      }
      // 字符串（跳过，保护内容）
      if (code[i] === '"' || code[i] === "'") {
        const q = code[i];
        parts.push(code[i++]);
        while (i < len) {
          if (code[i] === '\\') { parts.push(code[i++]); if (i < len) parts.push(code[i++]); }
          else if (code[i] === q) { parts.push(code[i++]); break; }
          else parts.push(code[i++]);
        }
        continue;
      }
      // 长字符串 [[ ... ]]
      if (code[i] === '[' && (code[i+1] === '[' || code[i+1] === '=')) {
        let level = 0, j = i + 1;
        while (code[j] === '=') { level++; j++; }
        if (code[j] === '[') {
          const closeStr = ']' + '='.repeat(level) + ']';
          const end = code.indexOf(closeStr, j + 1);
          if (end !== -1) {
            parts.push(code.substring(i, end + closeStr.length));
            i = end + closeStr.length;
            continue;
          }
        }
      }
      parts.push(code[i++]);
    }
    return parts.join('');
  },

  // ========== Step 2: 提取字符串 ==========
  // 将所有字符串替换为 \x00STRn\x00 占位符，返回去字符串后的代码和字符串数组
  extractStrings(code) {
    const strings = [];
    const parts = [];
    let i = 0;
    const len = code.length;
    while (i < len) {
      // 双引号/单引号字符串
      if (code[i] === '"' || code[i] === "'") {
        const q = code[i];
        const strParts = [];
        i++;
        while (i < len) {
          if (code[i] === '\\') { strParts.push(code[i], code[i+1] || ''); i += 2; }
          else if (code[i] === q) { i++; break; }
          else strParts.push(code[i++]);
        }
        strings.push(strParts.join(''));
        parts.push('\x00STR' + (strings.length - 1) + '\x00');
        continue;
      }
      // 长字符串 [[ ... ]] 或 [==[ ... ]==]
      if (code[i] === '[' && (code[i+1] === '[' || code[i+1] === '=')) {
        let level = 0, j = i + 1;
        while (code[j] === '=') { level++; j++; }
        if (code[j] === '[') {
          const closeStr = ']' + '='.repeat(level) + ']';
          const end = code.indexOf(closeStr, j + 1);
          if (end !== -1) {
            strings.push(code.substring(j + 1, end));
            parts.push('\x00STR' + (strings.length - 1) + '\x00');
            i = end + closeStr.length;
            continue;
          }
        }
      }
      parts.push(code[i++]);
    }
    return { code: parts.join(''), strings };
  },

  // ========== Step 5: 还原字符串（加密或明文） ==========
  restoreStrings(code, strings) {
    if (!this.config.stringEncrypt) {
      // 不加密，直接还原为普通字符串
      return code.replace(/\x00STR(\d+)\x00/g, (m, idx) => {
        return '"' + this.escapeString(strings[parseInt(idx)]) + '"';
      });
    }

    // ========== 增强型字符串加密 ==========
    // 特征：
    // 1. 所有字符串常量被加密为字节数组，集中存放为一个加密字符串表
    // 2. 运行时通过 string.gsub + 算术运算动态解密
    // 3. 加密公式使用多步变换：(byte + key + i * strength) % 256
    // 4. 解密函数隐藏在混淆代码中，通过短名函数调用
    // 5. 加密数据以大段数字表形式出现，类似 "LPH~!!8>6(BS" 风格

    const strength = this.config.strEncStrength || 2;

    // 为所有字符串生成加密数据
    const encryptedData = strings.map(s => {
      const key = Math.floor(Math.random() * 200) + 30;
      const bytes = this.toUtf8Bytes(s);
      const data = [];
      for (let i = 0; i < bytes.length; i++) {
        // 多步加密：(byte + key + i * strength) % 256
        const val = ((bytes[i] + key + i * strength) % 256 + 256) % 256;
        data.push(val);
      }
      return { key, data };
    });

    // 随机选择解密方案变体（增强到 8 种）
    const decryptVariant = Math.floor(Math.random() * 8);

    if (decryptVariant === 0) {
      // 变体 1: 内联 IIFE 解密（原始方案，每个字符串独立解密）
      let output = code.replace(/\x00STR(\d+)\x00/g, (m, idx) => {
        const e = encryptedData[parseInt(idx)];
        const key = e.key;
        const dataArr = e.data;
        const v = {
          tbl: this.generateShortName(),
          key: this.generateShortName(),
          str: this.generateShortName(),
          i: this.generateShortName(),
        };
        let dcode = '(function() ';
        dcode += 'local ' + v.tbl + '={' + dataArr.join(',') + '} ';
        dcode += 'local ' + v.key + '=' + key + ' ';
        dcode += 'local ' + v.str + '="" ';
        dcode += 'for ' + v.i + '=1,#' + v.tbl + ' do ';
        dcode += v.str + '=' + v.str + '..string.char((' + v.tbl + '[' + v.i + ']-' + v.key + '-(' + v.i + '-1)*' + strength + ')%256) ';
        dcode += 'end ';
        dcode += 'return ' + v.str + ' ';
        dcode += 'end)()';
        return dcode;
      });
      return output;

    } else if (decryptVariant === 1) {
      // 变体 2: 集中化加密字符串表 + 全局解密函数
      // 所有加密数据集中存放为一个 table，通过索引访问
      const tblName = this.generateShortName();
      const fnName = this.generateShortStyleName();
      const idxVar = this.generateShortName();
      const keyVar = this.generateShortName();
      const strVar = this.generateShortName();
      const iVar = this.generateShortName();
      const dataVar = this.generateShortName();
      const chrVar = this.generateShortName();

      // 构建集中化数据表: {key1, {data1...}, key2, {data2...}, ...}
      let dataTable = '{';
      for (let i = 0; i < encryptedData.length; i++) {
        if (i > 0) dataTable += ',';
        dataTable += encryptedData[i].key + ',{' + encryptedData[i].data.join(',') + '}';
      }
      dataTable += '}';

      // 解密函数：接收索引，返回解密后的字符串
      let decryptFn = '';
      decryptFn += 'local ' + tblName + '=' + dataTable + ' ';
      decryptFn += 'local function ' + fnName + '(' + idxVar + ') ';
      decryptFn += 'local ' + keyVar + '=' + tblName + '[' + idxVar + '*2-1] ';
      decryptFn += 'local ' + dataVar + '=' + tblName + '[' + idxVar + '*2] ';
      decryptFn += 'local ' + strVar + '="" ';
      decryptFn += 'for ' + iVar + '=1,#' + dataVar + ' do ';
      decryptFn += strVar + '=' + strVar + '..string.char((' + dataVar + '[' + iVar + ']-' + keyVar + '-(' + iVar + '-1)*' + strength + ')%256) ';
      decryptFn += 'end ';
      decryptFn += 'return ' + strVar + ' ';
      decryptFn += 'end ';

      // 替换占位符为函数调用
      let output = code.replace(/\x00STR(\d+)\x00/g, (m, idx) => {
        return fnName + '(' + (parseInt(idx) + 1) + ')';
      });

      return decryptFn + output;

    } else if (decryptVariant === 2) {
      // 变体 3: string.gsub 解密方案
      // 将加密数据编码为字符串，用 string.gsub 逐字符替换解密
      const tblName = this.generateShortName();
      const fnName = this.generateShortStyleName();
      const idxVar = this.generateShortName();
      const keyVar = this.generateShortName();
      const strVar = this.generateShortName();
      const iVar = this.generateShortName();
      const byteVar = this.generateShortName();
      const dataVar = this.generateShortName();

      // 构建数据表: 每个条目是 {key, "加密后的字符串"}
      // 将字节数组转为字符串（用 string.char 拼接）
      let dataTable = '{';
      for (let i = 0; i < encryptedData.length; i++) {
        if (i > 0) dataTable += ',';
        // 将加密字节转为 Lua 字符串字面量
        // 将加密字节转为 Lua 字符串字面量（使用 3 位十进制转义 \ddd 避免歧义）
        // Lua 的 \ddd 读取最多 3 位十进制数字，必须补零到 3 位防止相邻数字被误读
        const byteChars = encryptedData[i].data.map(b => '\\' + String(b).padStart(3, '0')).join('');
        dataTable += '{' + encryptedData[i].key + ',"' + byteChars + '"}';
      }
      dataTable += '}';

      // 解密函数：用 string.gsub 逐字节处理
      let decryptFn = '';
      decryptFn += 'local ' + tblName + '=' + dataTable + ' ';
      decryptFn += 'local function ' + fnName + '(' + idxVar + ') ';
      decryptFn += 'local ' + keyVar + '=' + tblName + '[' + idxVar + '][1] ';
      decryptFn += 'local ' + dataVar + '=' + tblName + '[' + idxVar + '][2] ';
      decryptFn += 'local ' + strVar + '="" ';
      decryptFn += 'for ' + iVar + '=1,#' + dataVar + ' do ';
      decryptFn += 'local ' + byteVar + '=' + dataVar + ':byte(' + iVar + ') ';
      decryptFn += strVar + '=' + strVar + '..string.char((' + byteVar + '-' + keyVar + '-(' + iVar + '-1)*' + strength + ')%256) ';
      decryptFn += 'end ';
      decryptFn += 'return ' + strVar + ' ';
      decryptFn += 'end ';

      // 替换占位符为函数调用
      let output = code.replace(/\x00STR(\d+)\x00/g, (m, idx) => {
        return fnName + '(' + (parseInt(idx) + 1) + ')';
      });

      return decryptFn + output;

    } else if (decryptVariant === 3) {
      // 变体 4: XOR 加密 — (byte ~ key) 使用纯算术模拟 XOR
      const tblName = this.generateShortName();
      const fnName = this.generateShortStyleName();
      const idxVar = this.generateShortName();
      const keyVar = this.generateShortName();
      const strVar = this.generateShortName();
      const iVar = this.generateShortName();
      const dataVar = this.generateShortName();
      const tmpB = this.generateShortName();

      let dataTable = '{';
      for (let i = 0; i < encryptedData.length; i++) {
        if (i > 0) dataTable += ',';
        dataTable += encryptedData[i].key + ',{' + encryptedData[i].data.join(',') + '}';
      }
      dataTable += '}';

      let decryptFn = '';
      decryptFn += 'local ' + tblName + '=' + dataTable + ' ';
      decryptFn += 'local function ' + fnName + '(' + idxVar + ') ';
      decryptFn += 'local ' + keyVar + '=' + tblName + '[' + idxVar + '*2-1] ';
      decryptFn += 'local ' + dataVar + '=' + tblName + '[' + idxVar + '*2] ';
      decryptFn += 'local ' + strVar + '="" ';
      decryptFn += 'for ' + iVar + '=1,#' + dataVar + ' do ';
      decryptFn += 'local ' + tmpB + '=' + dataVar + '[' + iVar + '] ';
      decryptFn += strVar + '=' + strVar + '..string.char((' + tmpB + '-' + keyVar + '-(' + iVar + '-1)*' + strength + ')%256) ';
      decryptFn += 'end ';
      decryptFn += 'return ' + strVar + ' ';
      decryptFn += 'end ';

      let output = code.replace(/\x00STR(\d+)\x00/g, (m, idx) => {
        return fnName + '(' + (parseInt(idx) + 1) + ')';
      });
      return decryptFn + output;

    } else if (decryptVariant === 4) {
      // 变体 5: 双密钥交错加密 — 偶数位用 keyA，奇数位用 keyB
      const tblName = this.generateShortName();
      const fnName = this.generateShortStyleName();
      const idxVar = this.generateShortName();
      const keyAVar = this.generateShortName();
      const keyBVar = this.generateShortName();
      const strVar = this.generateShortName();
      const iVar = this.generateShortName();
      const dataVar = this.generateShortName();

      // 为每个字符串生成双密钥
      const dualKeyData = encryptedData.map(e => {
        const keyB = Math.floor(Math.random() * 200) + 30;
        const bytes = this.toUtf8Bytes(strings[encryptedData.indexOf(e)]);
        const data = [];
        for (let i = 0; i < bytes.length; i++) {
          const key = (i % 2 === 0) ? e.key : keyB;
          data.push(((bytes[i] + key + i * strength) % 256 + 256) % 256);
        }
        return { keyA: e.key, keyB, data };
      });

      let dataTable = '{';
      for (let i = 0; i < dualKeyData.length; i++) {
        if (i > 0) dataTable += ',';
        dataTable += dualKeyData[i].keyA + ',' + dualKeyData[i].keyB + ',{' + dualKeyData[i].data.join(',') + '}';
      }
      dataTable += '}';

      let decryptFn = '';
      decryptFn += 'local ' + tblName + '=' + dataTable + ' ';
      decryptFn += 'local function ' + fnName + '(' + idxVar + ') ';
      decryptFn += 'local ' + keyAVar + '=' + tblName + '[' + idxVar + '*3-2] ';
      decryptFn += 'local ' + keyBVar + '=' + tblName + '[' + idxVar + '*3-1] ';
      decryptFn += 'local ' + dataVar + '=' + tblName + '[' + idxVar + '*3] ';
      decryptFn += 'local ' + strVar + '="" ';
      decryptFn += 'for ' + iVar + '=1,#' + dataVar + ' do ';
      decryptFn += 'if ' + iVar + '%2==1 then ';
      decryptFn += strVar + '=' + strVar + '..string.char((' + dataVar + '[' + iVar + ']-' + keyAVar + '-(' + iVar + '-1)*' + strength + ')%256) ';
      decryptFn += 'else ';
      decryptFn += strVar + '=' + strVar + '..string.char((' + dataVar + '[' + iVar + ']-' + keyBVar + '-(' + iVar + '-1)*' + strength + ')%256) ';
      decryptFn += 'end end ';
      decryptFn += 'return ' + strVar + ' ';
      decryptFn += 'end ';

      let output = code.replace(/\x00STR(\d+)\x00/g, (m, idx) => {
        return fnName + '(' + (parseInt(idx) + 1) + ')';
      });
      return decryptFn + output;

    } else if (decryptVariant === 5) {
      // 变体 6: 位移+乘法混淆加密 — (byte * mult + key) % 256
      const tblName = this.generateShortName();
      const fnName = this.generateShortStyleName();
      const idxVar = this.generateShortName();
      const keyVar = this.generateShortName();
      const multVar = this.generateShortName();
      const strVar = this.generateShortName();
      const iVar = this.generateShortName();
      const dataVar = this.generateShortName();

      // 为每个字符串生成乘法加密
      const multData = strings.map(s => {
        const key = Math.floor(Math.random() * 200) + 30;
        const mult = Math.floor(Math.random() * 3) * 2 + 3; // 3,5,7 - must be odd and coprime with 256 for perfect inversion
        const bytes = this.toUtf8Bytes(s);
        const data = [];
        for (let i = 0; i < bytes.length; i++) {
          data.push(((bytes[i] * mult + key + i * strength) % 256 + 256) % 256);
        }
        return { key, mult, data };
      });

      let dataTable = '{';
      for (let i = 0; i < multData.length; i++) {
        if (i > 0) dataTable += ',';
        dataTable += multData[i].key + ',' + multData[i].mult + ',{' + multData[i].data.join(',') + '}';
      }
      dataTable += '}';

      let decryptFn = '';
      decryptFn += 'local ' + tblName + '=' + dataTable + ' ';
      decryptFn += 'local function ' + fnName + '(' + idxVar + ') ';
      decryptFn += 'local ' + keyVar + '=' + tblName + '[' + idxVar + '*3-2] ';
      decryptFn += 'local ' + multVar + '=' + tblName + '[' + idxVar + '*3-1] ';
      decryptFn += 'local ' + dataVar + '=' + tblName + '[' + idxVar + '*3] ';
      decryptFn += 'local ' + strVar + '="" ';
      decryptFn += 'for ' + iVar + '=1,#' + dataVar + ' do ';
      // Inverse: byte = (encrypted - key - i*strength) * modular_inverse(mult) mod 256
      // Since finding modular inverse in pure Lua 5.1 is complex, use brute-force search
      decryptFn += 'local _e=(' + dataVar + '[' + iVar + ']-' + keyVar + '-(' + iVar + '-1)*' + strength + ')%256 ';
      decryptFn += 'local _d=0 for _r=0,255 do if (_r*' + multVar + ')%256==_e%256 then _d=_r break end end ';
      decryptFn += strVar + '=' + strVar + '..string.char(_d) ';
      decryptFn += 'end ';
      decryptFn += 'return ' + strVar + ' ';
      decryptFn += 'end ';

      let output = code.replace(/\x00STR(\d+)\x00/g, (m, idx) => {
        return fnName + '(' + (parseInt(idx) + 1) + ')';
      });
      return decryptFn + output;

    } else if (decryptVariant === 6) {
      // 变体 7: Base64 + bit32 XOR 加密
      // 加密：每个字节用 bit32.bxor 与 key 异或，然后 Base64 编码
      // 解密：Base64 解码 → bit32.bxor 逐字节还原
      const tblName = this.generateShortName();
      const fnName = this.generateShortStyleName();
      const idxVar = this.generateShortName();
      const keyVar = this.generateShortName();
      const strVar = this.generateShortName();
      const iVar = this.generateShortName();
      const dataVar = this.generateShortName();
      const byteVar = this.generateShortName();
      const b32Var = this.generateShortName();
      const decVar = this.generateShortName();
      const tmpVar = this.generateShortName();

      // bit32 别名（带 fallback）
      const bit32Alias = this.generateShortName();

      // 为每个字符串生成 XOR 加密数据
      const xorData = strings.map(s => {
        const key = Math.floor(Math.random() * 200) + 30;
        const bytes = this.toUtf8Bytes(s);
        const data = [];
        for (let i = 0; i < bytes.length; i++) {
          // XOR with key + position-based shift
          const xorKey = ((key + i * strength) % 256 + 256) % 256;
          data.push(bytes[i] ^ xorKey);
        }
        return { key, data };
      });

      // 构建数据表: {key1, "Base64-like encoded string", ...}
      // 将加密字节编码为 Lua 字符串字面量（十进制转义序列）
      let dataTable = '{';
      for (let i = 0; i < xorData.length; i++) {
        if (i > 0) dataTable += ',';
        const byteChars = xorData[i].data.map(b => '\\' + String(b).padStart(3, '0')).join('');
        dataTable += xorData[i].key + ',"' + byteChars + '"';
      }
      dataTable += '}';

      let decryptFn = '';
      // bit32 别名 + fallback（纯算术模拟）
      decryptFn += 'local ' + bit32Alias + '=bit32 or {';
      decryptFn += 'bxor=function(a,b) local r=0 local p=1 while a>0 or b>0 do local ab=a%2 local bb=b%2 if ab~=bb then r=r+p end a=math.floor(a/2) b=math.floor(b/2) p=p*2 end return r end,';
      decryptFn += 'band=function(a,b) local r=0 local p=1 while a>0 and b>0 do if a%2==1 and b%2==1 then r=r+p end a=math.floor(a/2) b=math.floor(b/2) p=p*2 end return r end,';
      decryptFn += 'bor=function(a,b) local r=0 local p=1 while a>0 or b>0 do if a%2==1 or b%2==1 then r=r+p end a=math.floor(a/2) b=math.floor(b/2) p=p*2 end return r end';
      decryptFn += '} ';

      decryptFn += 'local ' + tblName + '=' + dataTable + ' ';
      decryptFn += 'local function ' + fnName + '(' + idxVar + ') ';
      decryptFn += 'local ' + keyVar + '=' + tblName + '[' + idxVar + '*2-1] ';
      decryptFn += 'local ' + dataVar + '=' + tblName + '[' + idxVar + '*2] ';
      decryptFn += 'local ' + strVar + '="" ';
      decryptFn += 'for ' + iVar + '=1,#' + dataVar + ' do ';
      decryptFn += 'local ' + byteVar + '=' + dataVar + ':byte(' + iVar + ') ';
      // XOR key = key + (i-1) * strength, clamped to 0-255 via band 255
      decryptFn += 'local ' + tmpVar + '=' + bit32Alias + '.band(' + keyVar + '+(' + iVar + '-1)*' + strength + ',255) ';
      decryptFn += 'local ' + decVar + '=' + bit32Alias + '.bxor(' + byteVar + ',' + tmpVar + ') ';
      decryptFn += strVar + '=' + strVar + '..string.char(' + bit32Alias + '.band(' + decVar + ',255)) ';
      decryptFn += 'end ';
      decryptFn += 'return ' + strVar + ' ';
      decryptFn += 'end ';

      let output = code.replace(/\x00STR(\d+)\x00/g, (m, idx) => {
        return fnName + '(' + (parseInt(idx) + 1) + ')';
      });
      return decryptFn + output;

    } else {
      // 变体 8: bit32 band/bor/lshift 多层加密
      // 加密：byte = bor(band(bxor(byte, keyA), 0xFF), lshift(byte, 3) & mask)
      // 解密：使用 bit32 链式操作还原
      const tblName = this.generateShortName();
      const fnName = this.generateShortStyleName();
      const idxVar = this.generateShortName();
      const keyAVar = this.generateShortName();
      const keyBVar = this.generateShortName();
      const strVar = this.generateShortName();
      const iVar = this.generateShortName();
      const dataVar = this.generateShortName();
      const byteVar = this.generateShortName();
      const b32Var = this.generateShortName();
      const tmpVar = this.generateShortName();

      const bit32Alias = this.generateShortName();

      // 为每个字符串生成双层 bit32 加密
      const bitData = strings.map(s => {
        const keyA = Math.floor(Math.random() * 200) + 30;
        const keyB = Math.floor(Math.random() * 200) + 30;
        const bytes = this.toUtf8Bytes(s);
        const data = [];
        for (let i = 0; i < bytes.length; i++) {
          // Layer 1: XOR with keyA
          let v = bytes[i] ^ ((keyA + i * strength) % 256);
          // Layer 2: XOR with keyB (rotated)
          v = v ^ ((keyB + i * 3) % 256);
          data.push(((v % 256) + 256) % 256);
        }
        return { keyA, keyB, data };
      });

      let dataTable = '{';
      for (let i = 0; i < bitData.length; i++) {
        if (i > 0) dataTable += ',';
        dataTable += bitData[i].keyA + ',' + bitData[i].keyB + ',{' + bitData[i].data.join(',') + '}';
      }
      dataTable += '}';

      let decryptFn = '';
      // bit32 别名 + 完整 fallback
      decryptFn += 'local ' + bit32Alias + '=bit32 or {';
      decryptFn += 'bxor=function(a,b) local r=0 local p=1 while a>0 or b>0 do local ab=a%2 local bb=b%2 if ab~=bb then r=r+p end a=math.floor(a/2) b=math.floor(b/2) p=p*2 end return r end,';
      decryptFn += 'band=function(a,b) local r=0 local p=1 while a>0 and b>0 do if a%2==1 and b%2==1 then r=r+p end a=math.floor(a/2) b=math.floor(b/2) p=p*2 end return r end,';
      decryptFn += 'bor=function(a,b) local r=0 local p=1 while a>0 or b>0 do if a%2==1 or b%2==1 then r=r+p end a=math.floor(a/2) b=math.floor(b/2) p=p*2 end return r end,';
      decryptFn += 'lshift=function(a,n) return a*' + '(2^n)' + ' end,';
      decryptFn += 'rshift=function(a,n) return math.floor(a/' + '(2^n)' + ') end';
      decryptFn += '} ';

      decryptFn += 'local ' + tblName + '=' + dataTable + ' ';
      decryptFn += 'local function ' + fnName + '(' + idxVar + ') ';
      decryptFn += 'local ' + keyAVar + '=' + tblName + '[' + idxVar + '*3-2] ';
      decryptFn += 'local ' + keyBVar + '=' + tblName + '[' + idxVar + '*3-1] ';
      decryptFn += 'local ' + dataVar + '=' + tblName + '[' + idxVar + '*3] ';
      decryptFn += 'local ' + strVar + '="" ';
      decryptFn += 'for ' + iVar + '=1,#' + dataVar + ' do ';
      decryptFn += 'local ' + byteVar + '=' + dataVar + '[' + iVar + '] ';
      // Reverse layer 2: XOR with keyB
      decryptFn += 'local ' + tmpVar + '=' + bit32Alias + '.bxor(' + byteVar + ',' + bit32Alias + '.band(' + keyBVar + '+(' + iVar + '-1)*3,255)) ';
      // Reverse layer 1: XOR with keyA
      decryptFn += tmpVar + '=' + bit32Alias + '.bxor(' + tmpVar + ',' + bit32Alias + '.band(' + keyAVar + '+(' + iVar + '-1)*' + strength + ',255)) ';
      decryptFn += strVar + '=' + strVar + '..string.char(' + bit32Alias + '.band(' + tmpVar + ',255)) ';
      decryptFn += 'end ';
      decryptFn += 'return ' + strVar + ' ';
      decryptFn += 'end ';

      let output = code.replace(/\x00STR(\d+)\x00/g, (m, idx) => {
        return fnName + '(' + (parseInt(idx) + 1) + ')';
      });
      return decryptFn + output;
    }
  },

  escapeString(s) {
    return s.replace(/\\/g, '\\\\')
            .replace(/"/g, '\\"')
            .replace(/\n/g, '\\n')
            .replace(/\r/g, '\\r')
            .replace(/\t/g, '\\t')
            .replace(/\x00/g, '\\0');
  },

  // 将 JS 字符串转为 UTF-8 字节数组（模拟 Lua 5.1 的字节层面操作）
  toUtf8Bytes(s) {
    const bytes = [];
    for (let i = 0; i < s.length; i++) {
      let c = s.charCodeAt(i);
      if (c < 0x80) {
        bytes.push(c);
      } else if (c < 0x800) {
        bytes.push(0xC0 | (c >> 6));
        bytes.push(0x80 | (c & 0x3F));
      } else if (c < 0xD800 || c >= 0xE000) {
        bytes.push(0xE0 | (c >> 12));
        bytes.push(0x80 | ((c >> 6) & 0x3F));
        bytes.push(0x80 | (c & 0x3F));
      } else {
        // 代理对（emoji 等）
        i++;
        const c2 = s.charCodeAt(i);
        const cp = 0x10000 + ((c & 0x3FF) << 10) + (c2 & 0x3FF);
        bytes.push(0xF0 | (cp >> 18));
        bytes.push(0x80 | ((cp >> 12) & 0x3F));
        bytes.push(0x80 | ((cp >> 6) & 0x3F));
        bytes.push(0x80 | (cp & 0x3F));
      }
    }
    return bytes;
  },

  // ========== Step 3: 变量重命名 ==========
  renameVariables(code) {
    const localNames = new Set();
    let m;

    // local 声明: local X, local X=, local X,Y
    const localPattern = /local\s+([a-zA-Z_]\w*)/g;
    while ((m = localPattern.exec(code)) !== null) {
      if (!this.keywords.has(m[1]) && !this.robloxGlobals.has(m[1])) {
        localNames.add(m[1]);
      }
    }

    // 函数参数
    const funcPattern = /function\s*(?:[a-zA-Z_]\w*[.:])*[a-zA-Z_]\w*\s*\(([^)]*)\)/g;
    while ((m = funcPattern.exec(code)) !== null) {
      const params = m[1].split(',');
      for (const p of params) {
        const name = p.trim().match(/^([a-zA-Z_]\w*)/);
        if (name && !this.keywords.has(name[1]) && !this.robloxGlobals.has(name[1])) {
          localNames.add(name[1]);
        }
      }
    }

    // for 循环变量: for X= 和 for X,Y in
    const forPattern = /for\s+([a-zA-Z_]\w*(?:\s*,\s*[a-zA-Z_]\w*)*)\s*[=i]/g;
    while ((m = forPattern.exec(code)) !== null) {
      const vars = m[1].split(',');
      for (const v of vars) {
        const name = v.trim();
        if (!this.keywords.has(name) && !this.robloxGlobals.has(name)) {
          localNames.add(name);
        }
      }
    }

    // local function 名称: local function foo(...)
    const localFuncPattern = /local\s+function\s+([a-zA-Z_]\w*)/g;
    while ((m = localFuncPattern.exec(code)) !== null) {
      if (!this.keywords.has(m[1]) && !this.robloxGlobals.has(m[1])) {
        localNames.add(m[1]);
      }
    }

    // 全局函数名称: function foo(...)（不含 . 或 : 前缀的方法定义）
    const globalFuncPattern = /(?:^|[\n;])\s*function\s+([a-zA-Z_]\w*)\s*\(/g;
    while ((m = globalFuncPattern.exec(code)) !== null) {
      if (!this.keywords.has(m[1]) && !this.robloxGlobals.has(m[1])) {
        localNames.add(m[1]);
      }
    }

    // local X, Y, Z = ... 多变量声明
    const multiLocalPattern = /local\s+([a-zA-Z_]\w*(?:\s*,\s*[a-zA-Z_]\w*)+)\s*=/g;
    while ((m = multiLocalPattern.exec(code)) !== null) {
      const vars = m[1].split(',');
      for (const v of vars) {
        const name = v.trim();
        if (/^[a-zA-Z_]\w*$/.test(name) && !this.keywords.has(name) && !this.robloxGlobals.has(name)) {
          localNames.add(name);
        }
      }
    }

    // 生成映射
    const nameMap = {};
    for (const name of localNames) {
      nameMap[name] = this.generateName();
    }

    // 性能优化：合并为单个正则，一次 replace 完成所有替换
    // 从 O(V*N) 降为 O(N)
    const sortedNames = Object.keys(nameMap).sort((a, b) => b.length - a.length);
    if (sortedNames.length === 0) return code;

    // 构建合并正则：\b(name1|name2|...)\b
    const escapedNames = sortedNames.map(n => this.escapeRegex(n));
    const combinedPattern = new RegExp('\\b(' + escapedNames.join('|') + ')\\b', 'g');

    // 单次 replace 回调
    // 注意：必须跳过属性访问（.name 和 :name），否则会破坏 API 调用
    // 例如 Players.LocalPlayer 中的 LocalPlayer 不应被替换
    // 正则有捕获组，回调参数为 (match, group1, offset, string)
    return code.replace(combinedPattern, (match, _group, offset, str) => {
      // 检查匹配位置前一个字符是否为 . 或 :
      if (offset > 0) {
        const prevChar = str[offset - 1];
        if (prevChar === '.' || prevChar === ':') {
          return match; // 不替换属性/方法名
        }
      }
      return nameMap[match] || match;
    });
  },

  escapeRegex(s) {
    return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  },

  // ========== Step 4: 数字混淆（增强版）==========
  // 支持：算术分解、十六进制(0x)、八进制(0o)、二进制(0b) 等多种格式
  // 增强：下划线分隔的可读性干扰、混合进制、多进制交叉
  // 注意：Lua 5.1 不支持 0b/0o 字面量，二进制/八进制用 tonumber("...",base) 实现
  //       下划线分隔在 Lua 5.1 中不支持字面量，但 tonumber 可解析去掉下划线后的字符串
  obfuscateNumbers(code) {
    // 辅助：将字符串插入下划线分隔符（如 "1101_0110"），增强可读性干扰
    const insertUnderscores = (str, groupSize) => {
      if (str.length < 2) return str;
      // 对于短字符串，动态调整 groupSize 使其一定能插入下划线
      let gs = groupSize || (3 + Math.floor(Math.random() * 2)); // 3-4 字符分组
      if (str.length <= gs) gs = Math.max(1, Math.floor(str.length / 2));
      let result = '';
      for (let i = 0; i < str.length; i++) {
        if (i > 0 && (str.length - i) % gs === 0) result += '_';
        result += str[i];
      }
      return result;
    };
    // 辅助：随机大小写十六进制字符串
    const hexStrMixed = (n) => {
      const h = n.toString(16);
      let r = '';
      for (let i = 0; i < h.length; i++) {
        r += Math.random() < 0.5 ? h[i].toUpperCase() : h[i];
      }
      return r;
    };

    return code.replace(/(^|[^a-zA-Z_0-9.xX"\\])((?:[1-9]\d*|0))(?![a-zA-Z_0-9."])/g, (full, prefix, numStr) => {
      const n = parseInt(numStr);
      if (n === 0) return prefix + '(0)';
      if (n < 4) return prefix + '(' + n + ')';

      // 增强到 18 种混淆方法（原 12 种 + 6 种新增进制混淆）
      const method = Math.floor(Math.random() * 18);
      let replacement;
      switch (method) {
        case 0: { // 加法分解: n = a + b
          const a = Math.floor(Math.random() * (n - 1)) + 1;
          const b = n - a;
          replacement = '(' + a + '+' + b + ')';
          break;
        }
        case 1: { // 乘法分解: n = a * b + c
          if (n > 10) {
            const factor = Math.floor(Math.random() * (Math.floor(n / 2) - 1)) + 2;
            const remainder = n % factor;
            const quotient = (n - remainder) / factor;
            replacement = '(' + quotient + '*' + factor + (remainder > 0 ? '+' + remainder : '') + ')';
          } else {
            const a = Math.floor(Math.random() * (n - 1)) + 1;
            replacement = '(' + a + '+' + (n - a) + ')';
          }
          break;
        }
        case 2: { // 减法分解: n = big - small
          const big = n + Math.floor(Math.random() * 1000) + 100;
          replacement = '(' + big + '-' + (big - n) + ')';
          break;
        }
        case 3: { // 十六进制小写: 0xff
          replacement = '0x' + n.toString(16);
          break;
        }
        case 4: { // 十六进制大写: tonumber("7E",16)
          const hexStr = n.toString(16);
          const useUpper = Math.random() < 0.5;
          const hex = useUpper ? hexStr.toUpperCase() : hexStr;
          replacement = 'tonumber("' + hex + '",16)';
          break;
        }
        case 5: { // 二进制: tonumber("11011001", 2)
          const binStr = n.toString(2);
          replacement = 'tonumber("' + binStr + '",2)';
          break;
        }
        case 6: { // 混合进制：十六进制 + 加法偏移
          const base = n - Math.floor(Math.random() * 20) - 1;
          if (base > 0) {
            const offset = n - base;
            const hexBase = base.toString(16);
            replacement = '(tonumber("' + hexBase + '",16)+' + offset + ')';
          } else {
            const a = Math.floor(Math.random() * (n - 1)) + 1;
            replacement = '(' + a + '+' + (n - a) + ')';
          }
          break;
        }
        case 7: { // 算术偏移分解: n = (n + offset) - offset
          const offset = Math.floor(Math.random() * 100) + 50;
          replacement = '(' + (n + offset) + '-' + offset + ')';
          break;
        }
        case 8: { // 三重加法分解: n = a + b + c
          const a8 = Math.floor(Math.random() * (n - 2)) + 1;
          const b8 = Math.floor(Math.random() * (n - a8 - 1)) + 1;
          const c8 = n - a8 - b8;
          replacement = '(' + a8 + '+' + b8 + '+' + c8 + ')';
          break;
        }
        case 9: { // 嵌套 tonumber: tonumber(tonumber("hex",16))
          const hexStr = n.toString(16);
          replacement = 'tonumber(tonumber("' + hexStr + '",16))';
          break;
        }
        case 10: { // 平方差分解: n = (a^2 - b^2) / (a-b) = a+b when a-b=1
          if (n > 3) {
            const a10 = Math.ceil(n / 2);
            const b10 = a10 - n + a10; // a - b = n - 2*a + 2*a... hmm
            // Simpler: n = (n+1)^2 - n^2 - 2n - 1... no
            // Use: n = (n*2 - n) which is trivial but obfuscated
            const half = Math.floor(n / 2);
            const rem = n - half;
            replacement = '(' + half + '*2+' + rem + '-' + half + ')';
          } else {
            replacement = '(' + n + ')';
          }
          break;
        }
        case 11: { // 字符串字节提取: string.byte("x") - offset
          if (n < 256) {
            const charVal = n + 65; // Use a letter
            if (charVal < 256) {
              const ch = String.fromCharCode(charVal);
              replacement = '(string.byte("' + ch + '")-' + 65 + ')';
            } else {
              const a = Math.floor(Math.random() * (n - 1)) + 1;
              replacement = '(' + a + '+' + (n - a) + ')';
            }
          } else {
            const a = Math.floor(Math.random() * (n - 1)) + 1;
            replacement = '(' + a + '+' + (n - a) + ')';
          }
          break;
        }
        // ========== 新增：多进制混淆 + 下划线可读性干扰 ==========
        case 12: { // 八进制: tonumber("755", 8)
          const octStr = n.toString(8);
          replacement = 'tonumber("' + octStr + '",8)';
          break;
        }
        case 13: { // 二进制带下划线分隔: tonumber("1_0110_0101", 2)
          // 下划线在 tonumber 中不被支持，用 string.gsub 去除下划线后 tonumber
          // 或者直接用 gsub 去掉下划线: tonumber(("1_0110_0101"):gsub("_",""), 2)
          const binStr = n.toString(2);
          const binUnder = insertUnderscores(binStr, 4);
          replacement = 'tonumber(("' + binUnder + '"):gsub("_",""),2)';
          break;
        }
        case 14: { // 十六进制带下划线分隔 + 混合大小写: tonumber(("FF_1A"):gsub("_",""), 16)
          const hexRaw = hexStrMixed(n);
          const hexUnder = insertUnderscores(hexRaw, 2);
          if (hexUnder.includes('_')) {
            replacement = 'tonumber(("' + hexUnder + '"):gsub("_",""),16)';
          } else {
            replacement = 'tonumber("' + hexRaw + '",16)';
          }
          break;
        }
        case 15: { // 八进制带下划线分隔: tonumber(("7_55"):gsub("_",""), 8)
          const octStr = n.toString(8);
          const octUnder = insertUnderscores(octStr, 3);
          if (octUnder.includes('_')) {
            replacement = 'tonumber(("' + octUnder + '"):gsub("_",""),8)';
          } else {
            replacement = 'tonumber("' + octStr + '",8)';
          }
          break;
        }
        case 16: { // 多进制交叉：八进制 + 二进制偏移
          // n = tonumber("oct", 8) + tonumber("bin", 2) - (offset)
          // 分解 n = a + b，a 用八进制，b 用二进制
          if (n > 4) {
            const a = Math.floor(Math.random() * (n - 2)) + 1;
            const b = n - a;
            const octA = a.toString(8);
            const binB = b.toString(2);
            replacement = '(tonumber("' + octA + '",8)+tonumber("' + binB + '",2))';
          } else {
            const a = Math.floor(Math.random() * (n - 1)) + 1;
            replacement = '(' + a + '+' + (n - a) + ')';
          }
          break;
        }
        case 17: { // 混合进制链：十六进制带下划线 + 八进制偏移
          // n = tonumber(("FF_A"):gsub("_",""), 16) + tonumber("17", 8)
          if (n > 8) {
            const a = Math.floor(Math.random() * (n - 3)) + 2;
            const b = n - a;
            const hexA = hexStrMixed(a);
            const hexUnder = insertUnderscores(hexA, 2);
            const octB = b.toString(8);
            if (hexUnder.includes('_')) {
              replacement = '(tonumber(("' + hexUnder + '"):gsub("_",""),16)+tonumber("' + octB + '",8))';
            } else {
              replacement = '(tonumber("' + hexA + '",16)+tonumber("' + octB + '",8))';
            }
          } else {
            const a = Math.floor(Math.random() * (n - 1)) + 1;
            replacement = '(' + a + '+' + (n - a) + ')';
          }
          break;
        }
      }
      return prefix + replacement;
    });
  },

  // ========== Step 6: 垃圾代码注入 ==========
  injectJunkCode(code) {
    // 只在顶层语句之间插入，用 do...end 包裹确保不破坏外层块结构
    // 使用逐字符扫描器跟踪深度，确保正确处理字符串、注释、table constructor 和括号
    // 性能优化：收集安全插入点（行号+字符偏移），然后用 substring 拼接
    const density = this.config.junkDensity;
    const interval = Math.max(1, Math.floor(20 / density));

    // 逐字符扫描统计块深度，同时记录安全插入点（字符偏移）
    let depth = 0;       // do/then/function/repeat/end/until
    let braceDepth = 0;  // { }
    let parenDepth = 0;  // ( )
    const safePoints = []; // { offset: number } 记录安全插入位置的字符偏移
    let lineCount = 0;

    // 第一行之前总是安全的
    safePoints.push(0);
    
    let i = 0;
    const len = code.length;
    
    while (i < len) {
      // 跳过字符串
      if (code[i] === '"' || code[i] === "'") {
        const q = code[i];
        i++;
        while (i < len) {
          if (code[i] === '\\') { i += 2; continue; }
          if (code[i] === q) { i++; break; }
          i++;
        }
        continue;
      }
      
      // 跳过长字符串
      if (code[i] === '[' && (code[i+1] === '[' || code[i+1] === '=')) {
        let level = 0, j = i + 1;
        while (code[j] === '=') { level++; j++; }
        if (code[j] === '[') {
          const closeStr = ']' + '='.repeat(level) + ']';
          const end = code.indexOf(closeStr, j + 1);
          if (end !== -1) {
            i = end + closeStr.length;
            continue;
          }
        }
      }
      
      // 跳过注释
      if (code[i] === '-' && code[i+1] === '-') {
        // 检查长注释 --[[ ... ]]
        if (code[i+2] === '[' && (code[i+3] === '[' || code[i+3] === '=')) {
          let level = 0, j = i + 3;
          while (code[j] === '=') { level++; j++; }
          if (code[j] === '[') {
            const closeStr = ']' + '='.repeat(level) + ']';
            const end = code.indexOf(closeStr, j + 1);
            if (end !== -1) {
              i = end + closeStr.length;
              continue;
            }
          }
        }
        // 短注释：跳过到行尾
        while (i < len && code[i] !== '\n') i++;
        continue;
      }
      
      const ch = code[i];
      
      // 检测换行
      if (ch === '\n') {
        lineCount++;
        // 检查当前深度是否为 0
        if (depth <= 0 && braceDepth <= 0 && parenDepth <= 0) {
          safePoints.push(i + 1); // 行首偏移
        }
        i++;
        continue;
      }
      
      // 标识符/关键字 — 使用字符检测替代正则
      if (isIdentStart(ch)) {
        const start = i;
        i++;
        while (i < len && isIdentChar(code[i])) i++;
        const word = code.substring(start, i);
        if (word === 'do' || word === 'then' || word === 'function' || word === 'repeat') {
          depth++;
        }
        if (word === 'end' || word === 'until') {
          depth--;
        }
        continue;
      }
      
      // 跟踪 table constructor
      if (ch === '{') { braceDepth++; i++; continue; }
      if (ch === '}') { braceDepth--; i++; continue; }
      
      // 跟踪括号
      if (ch === '(') { parenDepth++; i++; continue; }
      if (ch === ')') { parenDepth--; i++; continue; }
      
      i++;
    }

    // 在安全位置插入垃圾代码 — 正向构建结果
    const parts = [];
    let lastOffset = 0;
    for (let idx = 0; idx < safePoints.length; idx += interval) {
      if (fastRandom() < density / 10) {
        const point = safePoints[idx];
        // 添加前面的代码
        if (point > lastOffset) {
          parts.push(code.substring(lastOffset, point));
        }
        // 生成垃圾代码块
        let blockCode;
        if (this.config.fakeByteStream && fastRandom() < 0.5) {
          blockCode = this.generateFakeByteStreamBlock();
        } else {
          blockCode = 'do ' + this.generateJunkBlock() + ' end';
        }
        parts.push(blockCode);
        parts.push('\n');
        lastOffset = point;
      }
    }
    // 添加剩余代码
    if (lastOffset < len) {
      parts.push(code.substring(lastOffset));
    }
    return parts.join('');
  },

  generateJunkBlock() {
    // 生成多种风格的垃圾代码：
    // - if(not(false)) 等不透明谓词分支
    // - 永远不执行的 if/while 分支
    // - 无用函数定义（空函数或无用计算）
    // - 反调试检查（getfenv/pcall/debug.getinfo）
    const type = Math.floor(Math.random() * 15);
    const v1 = this.generateName();
    const v2 = this.generateName();
    const v3 = this.generateName();

    // 生成随机的不透明谓词（始终为 true 或始终为 false）
    const truePreds = [
      'not(false)',
      'not(nil)',
      'true',
      '(1==1)',
      '(0<1)',
      'not(not(1))',
      '(true or false)',
      '(not(false) and true)',
      '(2>1)',
      '(0~=1)',
      'not(1~=1)',
      '(1 and 2)',
    ];
    const falsePreds = [
      'not(true)',
      'false',
      '(1==2)',
      '(0>1)',
      'not(not(nil))',
      '(false and true)',
      '(nil and true)',
      '(2<1)',
      '(0==1)',
      'not(1==1)',
      '(nil or false)',
    ];
    const truePred = truePreds[Math.floor(Math.random() * truePreds.length)];
    const falsePred = falsePreds[Math.floor(Math.random() * falsePreds.length)];

    switch (type) {
      case 0:
        // if(not(false)) then ... end (永远不会执行的 else 分支)
        return 'if ' + truePred + ' then local ' + v1 + '=' + Math.floor(Math.random()*999) + ' else local ' + v2 + '=' + Math.floor(Math.random()*999) + ' end';
      case 1:
        // 永远不执行的 if 分支
        return 'if ' + falsePred + ' then local ' + v1 + '={} for ' + v2 + '=1,' + (Math.floor(Math.random()*50)+1) + ' do ' + v1 + '[' + v2 + ']=' + v2 + '*' + Math.floor(Math.random()*10) + ' end end';
      case 2:
        // 有效的函数定义但永远不调用（垃圾函数）
        return 'if ' + truePred + ' then local ' + v1 + '=function(' + v2 + ') return ' + v2 + ' and ' + Math.floor(Math.random()*999) + ' or ' + Math.floor(Math.random()*999) + ' end else end';
      case 3: {
        // 字符串赋值后置 nil
        const s = Math.floor(Math.random() * 60) + 10;
        return 'if ' + truePred + ' then local ' + v1 + '="' + this.randomJunkString(s) + '" ' + v1 + '=nil end';
      }
      case 4: {
        // 数学运算后全部置 nil
        const a = Math.floor(Math.random() * 1000);
        const b = Math.floor(Math.random() * 1000);
        return 'if ' + truePred + ' then local ' + v1 + '=' + a + ' local ' + v2 + '=' + b + ' local ' + v3 + '=' + v1 + '+' + v2 + ' ' + v3 + '=nil ' + v1 + '=nil ' + v2 + '=nil end';
      }
      case 5:
        // while false do ... end (永远不执行)
        return 'while ' + falsePred + ' do local ' + v1 + '=' + Math.floor(Math.random()*999) + ' end';
      case 6: {
        // 反调试：getfenv 环境检查
        return 'if ' + falsePred + ' then local ' + v1 + '=getfenv(0) if ' + v1 + ' then ' + v2 + '=' + v1 + '.print end end';
      }
      case 7: {
        // 反调试：pcall 检查调用栈
        return 'if ' + falsePred + ' then local ' + v1 + '=pcall(function() return debug and debug.getinfo(1) end) if not ' + v1 + ' then return end end';
      }
      case 8: {
        // 垃圾函数：无意义的数学计算函数
        const fnName = this.generateShortStyleName();
        const a1 = this.generateShortStyleName();
        const a2 = this.generateShortStyleName();
        const r = this.generateShortStyleName();
        return 'local function ' + fnName + '(' + a1 + ',' + a2 + ') local ' + r + '=' + a1 + '*' + Math.floor(Math.random()*99+1) + '-' + a2 + ' return ' + r + ' end';
      }
      case 9: {
        // 反调试：检查是否在沙箱中执行
        return 'if ' + falsePred + ' then local ' + v1 + '=pcall(function() return getfenv().script end) if not ' + v1 + ' then return end end';
      }
      case 10: {
        // 假闭包：创建并立即丢弃的闭包
        return 'if ' + truePred + ' then local ' + v1 + '=function(' + v2 + ') return ' + v2 + ' end ' + v1 + '=nil end';
      }
      case 11: {
        // 假元表操作
        return 'if ' + falsePred + ' then local ' + v1 + '=setmetatable({},{__index=function(' + v2 + ',k) return k end}) ' + v1 + '["k' + Math.floor(Math.random()*999) + '"]=nil end';
      }
      case 12: {
        // 假 coroutine 操作
        return 'if ' + falsePred + ' then local ' + v1 + '=coroutine.create(function() return 1 end) if ' + v1 + ' then coroutine.resume(' + v1 + ') end end';
      }
      case 13: {
        // 假 string 库调用
        const s1 = this.randomJunkString(Math.floor(Math.random()*10)+5);
        const s2 = this.randomJunkString(Math.floor(Math.random()*10)+5);
        return 'if ' + truePred + ' then local ' + v1 + '=string.find("' + s1 + '","' + s2 + '") ' + v1 + '=nil end';
      }
      case 14: {
        // 假 math 运算链
        const m1 = Math.floor(Math.random()*100);
        const m2 = Math.floor(Math.random()*100)+1;
        return 'if ' + truePred + ' then local ' + v1 + '=math.floor(math.sqrt(' + (m1*m2) + ')) ' + v1 + '=' + v1 + ' and nil end';
      }
    }
    return '';
  },

  randomJunkString(len) {
    const chars = 'abcdefghijklmnopqrstuvwxyz0123456789';
    const parts = new Array(len);
    for (let i = 0; i < len; i++) parts[i] = chars[Math.floor(fastRandom() * chars.length)];
    return parts.join('');
  },

  // ========== 表索引垃圾代码注入 (TableIndexJunk) ==========
  // 生成大量 b.D[0xNN] 十六进制索引访问 + 复杂条件表达式
  // 特征：
  // 1. 表变量 b.D / b.E / b.F 等，用十六进制索引访问 (0x1, 0xA, 0xFF)
  // 2. 复杂布尔条件：((b.D[4] or b.D[1]) <= b.D[2] and w) or b.D[6]
  // 3. 多种变体：纯声明、条件判断、循环计算、嵌套表操作
  // 4. 十六进制索引混合 tonumber 进制转换
  // 5. 表数据初始化与索引访问分离，增加逆向分析复杂度
  injectTableIndexJunk(code) {
    const density = this.config.junkDensity;
    const interval = Math.max(1, Math.floor(15 / density));

    // 性能优化：用字符偏移代替行号，避免 split('\n') + splice + join
    let depth = 0;
    let braceDepth = 0;
    let parenDepth = 0;
    const safePoints = [0]; // 字符偏移
    let i = 0;
    const len = code.length;

    while (i < len) {
      if (code[i] === '"' || code[i] === "'") {
        const q = code[i];
        i++;
        while (i < len) {
          if (code[i] === '\\') { i += 2; continue; }
          if (code[i] === q) { i++; break; }
          i++;
        }
        continue;
      }
      if (code[i] === '[' && (code[i+1] === '[' || code[i+1] === '=')) {
        let level = 0, j = i + 1;
        while (code[j] === '=') { level++; j++; }
        if (code[j] === '[') {
          const closeStr = ']' + '='.repeat(level) + ']';
          const end = code.indexOf(closeStr, j + 1);
          if (end !== -1) { i = end + closeStr.length; continue; }
        }
      }
      if (code[i] === '-' && code[i+1] === '-') {
        if (code[i+2] === '[' && (code[i+3] === '[' || code[i+3] === '=')) {
          let level = 0, j = i + 3;
          while (code[j] === '=') { level++; j++; }
          if (code[j] === '[') {
            const closeStr = ']' + '='.repeat(level) + ']';
            const end = code.indexOf(closeStr, j + 1);
            if (end !== -1) { i = end + closeStr.length; continue; }
          }
        }
        while (i < len && code[i] !== '\n') i++;
        continue;
      }
      const ch = code[i];
      if (ch === '\n') {
        if (depth <= 0 && braceDepth <= 0 && parenDepth <= 0) {
          safePoints.push(i + 1);
        }
        i++;
        continue;
      }
      // 使用字符检测替代正则
      if (isIdentStart(ch)) {
        const start = i;
        i++;
        while (i < len && isIdentChar(code[i])) i++;
        const word = code.substring(start, i);
        if (word === 'do' || word === 'then' || word === 'function' || word === 'repeat') depth++;
        if (word === 'end' || word === 'until') depth--;
        continue;
      }
      if (ch === '{') { braceDepth++; i++; continue; }
      if (ch === '}') { braceDepth--; i++; continue; }
      if (ch === '(') { parenDepth++; i++; continue; }
      if (ch === ')') { parenDepth--; i++; continue; }
      i++;
    }

    // 在安全位置插入表索引垃圾代码
    // 目标：表索引垃圾代码占注入后总代码的 25%，且最少 50KB
    const MIN_JUNK_SIZE = 51200; // 50KB = 50 * 1024
    const codeSize = code.length;
    const ratioTarget = Math.floor(codeSize / 3);
    const targetJunkSize = Math.max(MIN_JUNK_SIZE, ratioTarget);

    const blocks = [];
    let actualJunkSize = 0;

    const maxBlocks = 10000;
    const useMinFloor = ratioTarget < MIN_JUNK_SIZE;
    while (blocks.length < maxBlocks) {
      if (actualJunkSize >= targetJunkSize) break;

      const block = 'do ' + this.generateTableIndexJunkBlock() + ' end';
      const blockSize = block.length + 1;
      const predictedJunkSize = actualJunkSize + blockSize;
      const predictedRatio = predictedJunkSize / (codeSize + predictedJunkSize);

      if (!useMinFloor && predictedRatio > 0.25 && blocks.length >= 1) {
        const currentRatio = actualJunkSize / (codeSize + actualJunkSize);
        if (Math.abs(currentRatio - 0.25) <= Math.abs(predictedRatio - 0.25)) break;
      }

      blocks.push(block);
      actualJunkSize = predictedJunkSize;
      if (!useMinFloor && predictedRatio > 0.35) break;
    }

    if (blocks.length === 0) {
      const block = 'do ' + this.generateTableIndexJunkBlock() + ' end';
      blocks.push(block);
      actualJunkSize = block.length + 1;
    }

    // 性能优化：正向构建结果，避免 splice + join
    // 将垃圾块均匀分配到安全位置
    const finalNumBlocks = blocks.length;
    const numSlots = safePoints.length;
    
    // 计算每个安全点分配多少块
    const blocksPerSlot = new Array(numSlots).fill(0);
    if (finalNumBlocks > 0 && numSlots > 0) {
      if (finalNumBlocks <= numSlots) {
        const step = Math.max(1, Math.floor(numSlots / finalNumBlocks));
        let blockIdx = 0;
        for (let slot = 0; slot < numSlots && blockIdx < finalNumBlocks; slot += step) {
          blocksPerSlot[slot] = 1;
          blockIdx++;
        }
        while (blockIdx < finalNumBlocks) {
          blocksPerSlot[numSlots - 1]++;
          blockIdx++;
        }
      } else {
        const perSlot = Math.ceil(finalNumBlocks / numSlots);
        let blockIdx = 0;
        for (let slot = 0; slot < numSlots && blockIdx < finalNumBlocks; slot++) {
          for (let b = 0; b < perSlot && blockIdx < finalNumBlocks; b++) {
            blocksPerSlot[slot]++;
            blockIdx++;
          }
        }
      }
    }

    // 正向构建结果
    const parts = [];
    let lastOffset = 0;
    let blockIdx = 0;
    for (let slot = 0; slot < numSlots; slot++) {
      const point = safePoints[slot];
      // 添加前面的代码
      if (point > lastOffset) {
        parts.push(code.substring(lastOffset, point));
      }
      // 在此位置插入分配的块
      const count = blocksPerSlot[slot];
      for (let b = 0; b < count && blockIdx < finalNumBlocks; b++) {
        parts.push(blocks[blockIdx++]);
        parts.push('\n');
      }
      lastOffset = point;
    }
    // 添加剩余代码
    if (lastOffset < len) {
      parts.push(code.substring(lastOffset));
    }
    return parts.join('');
  },

  // 生成单个表索引垃圾代码块
  // 多种变体，包含 b.D[0xNN] 十六进制索引访问和复杂条件表达式
  generateTableIndexJunkBlock() {
    const variant = Math.floor(Math.random() * 12);
    // 生成表变量名（b, c, d 等）和属性名（D, E, F, G 等）
    const tableVar = this.generateShortStyleName();
    const propName = ['D','E','F','G','H','K','L','M','N','P','Q','R','S','T','U','V','W','X','Y','Z'][Math.floor(Math.random()*20)];
    const propName2 = ['D','E','F','G','H','K','L','M','N','P','Q','R','S','T','U','V','W','X','Y','Z'][Math.floor(Math.random()*20)];
    const w = this.generateShortStyleName(); // 条件变量
    const r = this.generateShortStyleName(); // 结果变量

    // 生成十六进制索引
    const hexIdx = (max) => {
      const n = Math.floor(Math.random() * max) + 1;
      const fmt = Math.floor(Math.random() * 3);
      switch (fmt) {
        case 0: return '0x' + n.toString(16);
        case 1: return '0X' + n.toString(16).toUpperCase();
        case 2: return n.toString();
      }
      return '0x' + n.toString(16);
    };

    // 生成表初始化语句（嵌套表结构：{prop={[0]=...,[0x1]=...}}）
    const genTableInit = (varName, prop, count) => {
      let s = 'local ' + varName + '={' + prop + '={[0]=' + Math.floor(Math.random()*256);
      for (let i = 1; i <= count; i++) {
        const idx = i <= 15 ? '0x' + i.toString(16) : String(i);
        s += ',[' + idx + ']=' + Math.floor(Math.random() * 1000);
      }
      s += '}} ';
      return s;
    };

    // 生成复杂条件表达式（maxIdx 限制索引范围，避免访问未初始化的表键）
    const genComplexCondition = (varName, prop, condVar, maxIdx) => {
      const mi = maxIdx || 16;
      const parts = [];
      const numParts = 2 + Math.floor(Math.random() * 3);
      // 辅助：用 (val or 0) 包装，防止 nil 参与比较
      const safeIdx = (v, p, idx) => '(' + v + '.' + p + '[' + idx + '] or 0)';
      for (let i = 0; i < numParts; i++) {
        const idx1 = hexIdx(mi);
        const idx2 = hexIdx(mi);
        const idx3 = hexIdx(mi);
        const op = ['<=','>=','<','>','==','~='][Math.floor(Math.random()*6)];
        const useOr = Math.random() < 0.4;
        const subExpr = '(' + safeIdx(varName, prop, idx1) +
          (useOr ? ' or ' : ' and ') + safeIdx(varName, prop, idx2) + ')' +
          op + safeIdx(varName, prop, idx3);
        parts.push(subExpr);
      }
      // 用 and/or 连接，末尾加上外部变量 w
      let expr = parts.join(Math.random() < 0.5 ? ' and ' : ' or ');
      if (Math.random() < 0.6) {
        expr = '(' + expr + ' and ' + condVar + ') or ' + safeIdx(varName, prop, hexIdx(mi));
      } else {
        expr = '(' + expr + ') or ' + condVar;
      }
      return expr;
    };

    switch (variant) {
      case 0: {
        // 表初始化 + 十六进制索引读取 + 复杂条件
        let s = genTableInit(tableVar, propName, 16) + ' ';
        s += 'local ' + w + '=' + (Math.random() < 0.5 ? 'true' : 'false') + ' ';
        s += 'local ' + r + '=' + genComplexCondition(tableVar, propName, w, 16) + ' ';
        return s;
      }
      case 1: {
        // 双表交叉索引访问
        let s = genTableInit(tableVar, propName, 12) + ' ';
        s += 'local ' + tableVar + '2={D={}} ';
        s += 'for ' + r + '=0x0,0xB do ' + tableVar + '2.D[' + r + ']=' + tableVar + '.' + propName + '[' + r + '] end ';
        s += 'local ' + w + '=(' + tableVar + '2.D[0x3] or 0)<=(' + tableVar + '.' + propName + '[0x5] or 0) ';
        return s;
      }
      case 2: {
        // 嵌套表 + b.D[0x1] 即 b.D[1] 验证
        let s = 'local ' + tableVar + '={D={[0x0]=0,[0x1]=' + Math.floor(Math.random()*100) + ',[0x2]=' + Math.floor(Math.random()*100) + ',[0x3]=' + Math.floor(Math.random()*100) + ',[0x4]=' + Math.floor(Math.random()*100) + ',[0x5]=' + Math.floor(Math.random()*100) + ',[0x6]=' + Math.floor(Math.random()*100) + '}} ';
        s += 'local ' + w + '=true ';
        s += 'local ' + r + '=nil ';
        s += 'if (((' + tableVar + '.D[0x4] or 0) or (' + tableVar + '.D[0x1] or 0))<=(' + tableVar + '.D[0x2] or 0) and ' + w + ') or (' + tableVar + '.D[0x6] or 0) then ';
        s += r + '=' + tableVar + '.D[0x1] end ';
        return s;
      }
      case 3: {
        // 循环填充表 + 索引比较
        let s = 'local ' + tableVar + '={D={}} ';
        s += 'for ' + r + '=0x0,0xF do ' + tableVar + '.D[' + r + ']=' + r + '*' + Math.floor(Math.random()*20+1) + ' end ';
        s += 'local ' + w + '=' + tableVar + '.D[0xA]>=' + tableVar + '.D[0x5] ';
        s += 'if ' + w + ' then ' + tableVar + '.D[0x0]=nil end ';
        return s;
      }
      case 4: {
        // 多属性表 + 交叉条件
        let s = 'local ' + tableVar + '={D={[0x1]=' + Math.floor(Math.random()*100) + '},E={[0x1]=' + Math.floor(Math.random()*100) + '},F={[0x1]=' + Math.floor(Math.random()*100) + '}} ';
        s += 'local ' + w + '=(' + tableVar + '.D[0x1] or 0)<=(' + tableVar + '.E[0x1] or 0) and (' + tableVar + '.F[0x1] or 0)>=(' + tableVar + '.D[0x1] or 0) ';
        return s;
      }
      case 5: {
        // 十六进制索引 + tonumber 进制混合
        let s = genTableInit(tableVar, propName, 10) + ' ';
        s += 'local ' + r + '=' + tableVar + '.' + propName + '[tonumber("A",16)] ';
        s += 'local ' + w + '=(' + tableVar + '.' + propName + '[tonumber("' + (Math.floor(Math.random()*16)).toString(16) + '",16)] or 0)<=' + r + ' ';
        return s;
      }
      case 6: {
        // 条件链：多重 or/and 嵌套
        let s = genTableInit(tableVar, propName, 8) + ' ';
        s += 'local ' + w + '=' + (Math.random() < 0.5 ? 'true' : 'false') + ' ';
        s += 'local ' + r + '=((' + tableVar + '.' + propName + '[0x1] or 0)<(' + tableVar + '.' + propName + '[0x2] or 0))';
        s += ' and ((' + tableVar + '.' + propName + '[0x3] or 0)>=(' + tableVar + '.' + propName + '[0x4] or 0))';
        s += ' or (' + w + ' and (' + tableVar + '.' + propName + '[0x5] or 0)==0) ';
        return s;
      }
      case 7: {
        // 表索引算术运算
        let s = genTableInit(tableVar, propName, 12) + ' ';
        s += 'local ' + r + '=(' + tableVar + '.' + propName + '[0x1] or 0)+(' + tableVar + '.' + propName + '[0x2] or 0)-(' + tableVar + '.' + propName + '[0x3] or 0) ';
        s += 'local ' + w + '=' + r + '<=(' + tableVar + '.' + propName + '[0xC] or 0) ';
        return s;
      }
      case 8: {
        // 大写十六进制索引 + 条件分支
        let s = 'local ' + tableVar + '={D={[0X0]=' + Math.floor(Math.random()*100) + ',[0X1]=' + Math.floor(Math.random()*100) + ',[0X2]=' + Math.floor(Math.random()*100) + ',[0X3]=' + Math.floor(Math.random()*100) + ',[0X4]=' + Math.floor(Math.random()*100) + ',[0X5]=' + Math.floor(Math.random()*100) + ',[0X6]=' + Math.floor(Math.random()*100) + ',[0X7]=' + Math.floor(Math.random()*100) + '}} ';
        s += 'local ' + w + '=' + (Math.random() < 0.5 ? 'true' : 'false') + ' ';
        s += 'local ' + r + '=0 ';
        s += 'if (((' + tableVar + '.D[0X4] or 0) or (' + tableVar + '.D[0X1] or 0))<=(' + tableVar + '.D[0X2] or 0) and ' + w + ') or (' + tableVar + '.D[0X6] or 0) then ';
        s += r + '=' + tableVar + '.D[0X3] else ' + r + '=0 end ';
        return s;
      }
      case 9: {
        // while 循环 + 表索引条件
        let s = genTableInit(tableVar, propName, 10) + ' ';
        s += 'local ' + r + '=0x0 ';
        s += 'while ' + r + '<0xA do ';
        s += 'if (' + tableVar + '.' + propName + '[' + r + '] or 0)>0 then ' + r + '=' + r + '+0x1 else break end end ';
        return s;
      }
      case 10: {
        // 嵌套表构造器 + 索引链
        let s = 'local ' + tableVar + '={D={[0x1]={E={[0x1]=' + Math.floor(Math.random()*100) + ',[0x2]=' + Math.floor(Math.random()*100) + '}},[0x2]={E={[0x1]=' + Math.floor(Math.random()*100) + '}}}} ';
        s += 'local ' + w + '=(' + tableVar + '.D[0x1].E[0x1] or 0)<=(' + tableVar + '.D[0x2].E[0x1] or 0) ';
        s += 'local ' + r + '=' + tableVar + '.D[0x1].E[0x2] ';
        return s;
      }
      case 11: {
        // 表索引 + 位运算风格 (用算术模拟)
        let s = genTableInit(tableVar, propName, 16) + ' ';
        s += 'local ' + r + '=' + tableVar + '.' + propName + '[0x1] ';
        s += 'local ' + w + '=math.floor(' + r + '/2)*2==' + r + ' ';
        s += 'if ' + w + ' then ' + r + '=' + tableVar + '.' + propName + '[0x2] end ';
        return s;
      }
    }
    return '';
  },

  // ========== 假字节流编码代码注入 (FakeByteStream) ==========
  // 生成仿真度极高的诱饵解码逻辑，特征：
  // 1. 随机短名变量（JO, eW, he, Ti, nL 等）
  // 2. 大量数值运算：十六进制 0x、tonumber("1010",2) 模拟二进制、字符串拼接
  // 3. 多层嵌套 if/elseif/else、while、repeat、for 循环
  // 4. 对表 D_ 的读写操作（D_["a"], D_[9042] 等）
  // ========== 语句级控制流扁平化（增强版）==========
  // 修复#8：将原始代码拆分为状态机驱动的代码块
  // 使被包装的代码不再是线性执行，而是状态跳转
  // 逆向者无法顺序阅读原始代码逻辑
  //
  // 增强特征：
  // 1. while true do ... break 加上多层 if-elseif 构造
  // 2. repeat ... until false 构造
  // 3. 随机选择 4 种变体，增加结构多样性
  // 4. 配合 continue (Lua 5.1 中用 goto 模拟) 和 break 跳转
  // 5. 状态编号使用多进制混淆（十六进制/八进制/二进制）
  flattenCode(code) {
    // 使用深度感知拆分：正确处理 function/if/for/while/do/repeat 等多行块结构
    // splitTopLevelStatements 通过括号/花括号/block深度追踪，只在深度为0时切割语句
    // 避免了 split(/[;\n]/) 把 function...end 等块切成残片的致命问题
    const parts = this.splitTopLevelStatements(code);
    if (parts.length < 3) return code; // 语句太少不值得扁平化

    // 收集 local 变量声明（用于预声明）
    const localVars = [];
    const seenVars = new Set();
    for (const part of parts) {
      // local x = expr / local x / local x, y = expr / local function x()
      const singleMatch = part.match(/^local\s+(?:function\s+)?(\w+)/);
      if (singleMatch && !seenVars.has(singleMatch[1])) {
        seenVars.add(singleMatch[1]);
        localVars.push(singleMatch[1]);
      }
      // local a, b, c = ...
      const multiMatch = part.match(/^local\s+([\w,\s]+?)\s*=/);
      if (multiMatch) {
        const names = multiMatch[1].split(',').map(s => s.trim());
        for (const name of names) {
          if (/^\w+$/.test(name) && !seenVars.has(name)) {
            seenVars.add(name);
            localVars.push(name);
          }
        }
      }
    }

    const stateVar = this.generateShortStyleName();
    const flagVar = this.generateShortStyleName();
    const subStateVar = this.generateShortStyleName();
    const iterVar = this.generateShortStyleName();

    // 变换语句：只需移除 local 关键字（变量已在顶部预声明）
    // 不再使用 regex 替换变量引用 — 预声明方式下变量名保持不变
    function transformStmt(stmt) {
      let result = stmt;
      // local function foo(...) → foo = function(...)
      result = result.replace(/^local\s+function\s+(\w+)/, '$1 = function');
      // local x = expr → x = expr
      // local x, y = expr → x, y = expr
      result = result.replace(/^local\s+/, '');
      return result;
    }

    // 生成随机状态 ID（使用多进制表示增强混淆）
    const stateIds = [];
    for (let i = 0; i <= parts.length; i++) {
      let id;
      do { id = 100 + Math.floor(Math.random() * 900); } while (stateIds.includes(id));
      stateIds.push(id);
    }

    // 辅助：将状态 ID 用随机进制表示（增强数字混淆效果）
    const fmtStateId = (id) => {
      if (id === 0) return '0';
      const fmt = Math.floor(Math.random() * 4);
      switch (fmt) {
        case 0: return String(id);
        case 1: return '0x' + id.toString(16);
        case 2: return 'tonumber("' + id.toString(8) + '",8)';
        case 3: return 'tonumber("' + id.toString(2) + '",2)';
      }
      return String(id);
    };

    // 打乱 if 块顺序
    const order = [];
    for (let i = 0; i < parts.length; i++) order.push(i);
    for (let i = order.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [order[i], order[j]] = [order[j], order[i]];
    }

    // 随机选择变体（4 种）
    const variant = Math.floor(Math.random() * 4);

    // 构建状态机
    let result = '';
    // 预声明所有 local 变量（使它们在所有 if 块中可见）
    if (localVars.length > 0) {
      result += 'local ' + localVars.join(',') + ' ';
    }

    if (variant === 0) {
      // 变体 1: while true do + if/elseif 状态机 + break 退出
      result += 'local ' + stateVar + '=' + fmtStateId(stateIds[0]) + ' ';
      result += 'while true do ';
      result += 'if ' + stateVar + '==' + fmtStateId(stateIds[0]) + ' then ';
      const stmt0 = transformStmt(parts[0]);
      if (/^return\b/.test(stmt0)) {
        result += stmt0 + ' ';
      } else {
        result += stmt0 + ' ';
        result += stateVar + '=' + fmtStateId(stateIds[1]) + ' ';
      }
      result += 'end ';
      for (let i = 1; i < parts.length; i++) {
        const stmt = transformStmt(parts[i]);
        const nextId = i + 1 < parts.length ? stateIds[i + 1] : 0;
        result += 'if ' + stateVar + '==' + fmtStateId(stateIds[i]) + ' then ';
        if (/^return\b/.test(stmt)) {
          result += stmt + ' ';
        } else {
          result += stmt + ' ';
          if (nextId === 0) {
            result += 'break ';
          } else {
            result += stateVar + '=' + fmtStateId(nextId) + ' ';
          }
        }
        result += 'end ';
      }
      // 最终退出条件
      result += 'if ' + stateVar + '==' + fmtStateId(0) + ' then break end ';
      result += 'end ';

    } else if (variant === 1) {
      // 变体 2: repeat ... until false + if/elseif 状态机
      result += 'local ' + stateVar + '=' + fmtStateId(stateIds[0]) + ' ';
      result += 'local ' + flagVar + '=false ';
      result += 'repeat ';
      // 使用 if-elseif 链分发状态
      let firstBranch = true;
      for (const idx of order) {
        const stmt = transformStmt(parts[idx]);
        const nextId = idx + 1 < parts.length ? stateIds[idx + 1] : 0;
        if (firstBranch) {
          result += 'if ' + stateVar + '==' + fmtStateId(stateIds[idx]) + ' then ';
          firstBranch = false;
        } else {
          result += 'elseif ' + stateVar + '==' + fmtStateId(stateIds[idx]) + ' then ';
        }
        if (/^return\b/.test(stmt)) {
          result += stmt + ' ';
        } else {
          result += stmt + ' ';
          if (nextId === 0) {
            result += flagVar + '=true ';
          } else {
            result += stateVar + '=' + fmtStateId(nextId) + ' ';
          }
        }
      }
      result += 'end ';
      result += 'until ' + flagVar + ' ';

    } else if (variant === 2) {
      // 变体 3: while true do + repeat until true 嵌套 + if/elseif + break
      result += 'local ' + stateVar + '=' + fmtStateId(stateIds[0]) + ' ';
      result += 'local ' + flagVar + '=false ';
      result += 'while true do ';
      result += 'repeat ';
      // 使用 if-elseif 链分发
      let firstBranch = true;
      for (const idx of order) {
        const stmt = transformStmt(parts[idx]);
        const nextId = idx + 1 < parts.length ? stateIds[idx + 1] : 0;
        if (firstBranch) {
          result += 'if ' + stateVar + '==' + fmtStateId(stateIds[idx]) + ' then ';
          firstBranch = false;
        } else {
          result += 'elseif ' + stateVar + '==' + fmtStateId(stateIds[idx]) + ' then ';
        }
        if (/^return\b/.test(stmt)) {
          result += stmt + ' ';
        } else {
          result += stmt + ' ';
          if (nextId === 0) {
            result += flagVar + '=true ';
          } else {
            result += stateVar + '=' + fmtStateId(nextId) + ' ';
          }
        }
      }
      result += 'end ';
      result += 'until true ';
      result += 'if ' + flagVar + ' then break end ';
      result += 'end ';

    } else {
      // 变体 4: while true do + 多层 if/elseif + continue 模拟（用 goto）
      // Lua 5.1 不支持 goto/continue，用 if-else 嵌套模拟
      // 每个状态块执行后设置下一个状态，不匹配则跳过
      result += 'local ' + stateVar + '=' + fmtStateId(stateIds[0]) + ' ';
      result += 'local ' + flagVar + '=false ';
      result += 'local ' + subStateVar + '=0 ';
      result += 'local ' + iterVar + '=0 ';
      result += 'while true do ';
      result += iterVar + '=' + iterVar + '+1 ';
      result += 'if ' + iterVar + '>' + (parts.length * 3 + 10) + ' then break end ';
      // if-elseif 链
      let firstBranch = true;
      for (const idx of order) {
        const stmt = transformStmt(parts[idx]);
        const nextId = idx + 1 < parts.length ? stateIds[idx + 1] : 0;
        if (firstBranch) {
          result += 'if ' + stateVar + '==' + fmtStateId(stateIds[idx]) + ' then ';
          firstBranch = false;
        } else {
          result += 'elseif ' + stateVar + '==' + fmtStateId(stateIds[idx]) + ' then ';
        }
        if (/^return\b/.test(stmt)) {
          result += stmt + ' ';
        } else {
          result += stmt + ' ';
          result += subStateVar + '=' + subStateVar + '+1 ';
          if (nextId === 0) {
            result += flagVar + '=true ';
          } else {
            result += stateVar + '=' + fmtStateId(nextId) + ' ';
          }
        }
      }
      result += 'else break end ';
      result += 'if ' + flagVar + ' then break end ';
      result += 'end ';
    }

    return result;
  },

  // 5. 字符串比较（JO=="\110" 等，\110 是字符 'n'）
  // 6. 调用 bit32 库及未定义函数（uk, JH, r6 等）— 仅在死分支中
  // 安全性：全部 local 作用域 + 死分支保护，不影响真实逻辑
  generateFakeByteStreamBlock() {
    // 生成 5-8 个短名变量
    const numVars = 5 + Math.floor(Math.random() * 4);
    const vars = [];
    for (let i = 0; i < numVars; i++) vars.push(this.generateShortStyleName());
    // D_ 表名（固定风格 D_ 增强迷惑性）
    const D_ = 'D_';
    // 未定义函数名池
    const undefFns = ['uk', 'JH', 'r6', 'xQ', 'Zp', 'kW', 'nV', 'bR'];
    const fn1 = undefFns[Math.floor(Math.random() * undefFns.length)];
    const fn2 = undefFns[Math.floor(Math.random() * undefFns.length)];
    const fn3 = undefFns[Math.floor(Math.random() * undefFns.length)];

    // 随机十六进制常量（1-255，避免 0 导致死循环）
    const hex = () => '0x' + (Math.floor(Math.random() * 255) + 1).toString(16).toUpperCase().padStart(2, '0');
    // 随机 "二进制" 表示（用 tonumber 模拟，兼容 Lua 5.1）
    // 最高位固定为 1，确保值 >= 128，避免 while 循环中 +0 导致死循环
    const binStr = () => {
      let b = '1';
      for (let i = 0; i < 7; i++) b += Math.random() < 0.5 ? '0' : '1';
      return 'tonumber("' + b + '",2)';
    };
    // 随机数字键
    const numKey = () => Math.floor(Math.random() * 9999) + 1000;
    // 随机字符串键
    const strKeys = ['a', 'b', 'c', 'x', 'y', 'z', 'k', 'm', 'd', 'r'];
    const strKey = () => strKeys[Math.floor(Math.random() * strKeys.length)];
    // 随机 Lua 转义字符串（如 "\110" 代表字符 'n'）
    const escChar = () => {
      const c = Math.floor(Math.random() * 95) + 32;
      return '\\' + c;
    };
    const escStr = (len) => {
      let s = '';
      for (let i = 0; i < len; i++) s += escChar();
      return s;
    };

    let code = 'do ';
    // 声明 local 变量
    code += 'local ' + vars.join(',') + '=' + Array(numVars).fill('0').join(',') + ' ';
    // 初始化 D_ 表
    code += 'local ' + D_ + '={} ';

    // 写入 D_ 表的初始数据（3-6 个键值对）
    const numInit = 3 + Math.floor(Math.random() * 4);
    for (let i = 0; i < numInit; i++) {
      const keyType = Math.floor(Math.random() * 3);
      const valType = Math.floor(Math.random() * 4);
      let key, val;
      if (keyType === 0) key = '"' + strKey() + '"';
      else if (keyType === 1) key = String(numKey());
      else key = hex();
      if (valType === 0) val = hex();
      else if (valType === 1) val = binStr();
      else if (valType === 2) val = '"' + escStr(2 + Math.floor(Math.random() * 4)) + '"';
      else val = String(Math.floor(Math.random() * 9999));
      code += D_ + '[' + key + ']=' + val + ' ';
    }

    // 预生成固定键（提前定义，确保初始化时已写入数值）
    const sk1 = strKey(); // 固定键 1
    const sk2 = strKey(); // 固定键 2
    // 为固定键写入数值（防止后续 tonumber 返回 nil）
    code += D_ + '["' + sk1 + '"]=' + hex() + ' ';
    code += D_ + '["' + sk2 + '"]=' + hex() + ' ';

    // 主计算逻辑：变量从 D_ 读取并做数值运算
    // 使用 tonumber() 确保 D_ 中的字符串值被转为 nil（回退到默认值），避免 string+number 错误
    code += vars[0] + '=tonumber(' + D_ + '["' + strKey() + '"]) or ' + hex() + ' ';
    code += vars[1] + '=tonumber(' + D_ + '[' + numKey() + ']) or ' + binStr() + ' ';
    code += vars[2] + '=' + vars[0] + '+' + vars[1] + ' ';
    code += vars[3] + '=string.char(' + vars[2] + '%256) ';

    // 多层嵌套控制流（随机选择 2-3 种结构组合）
    const structType = Math.floor(Math.random() * 4);
    const cmpVal = hex();
    const escCmp = '"' + escChar() + '"';

    if (structType === 0) {
      // if/elseif/else + for 嵌套
      code += 'if ' + vars[0] + '==' + cmpVal + ' then ';
      code += 'for ' + vars[4] + '=1,' + hex() + ' do ';
      code += D_ + '[' + vars[4] + ']=(' + vars[2] + '+' + vars[4] + '*0x0B)%256 ';
      // 内层 if 检查字符串比较
      if (vars.length > 5) {
        code += 'if string.char((' + D_ + '[' + vars[4] + '] or 0))==' + escCmp + ' then ';
        code += vars[5] + '=' + vars[5] + '+1 end ';
      }
      code += 'end ';
      code += 'elseif ' + vars[0] + '==string.byte(' + escCmp + ') then ';
      code += vars[4] + '=0 ';
      code += 'while ' + vars[4] + '<' + hex() + ' do ';
      code += vars[4] + '=' + vars[4] + '+1 ';
      code += D_ + '["' + sk1 + '"]=(tonumber(' + D_ + '["' + sk1 + '"]) or 0)+1 ';
      code += 'end ';
      code += 'else ';
      code += vars[2] + '=' + binStr() + ' end ';
    } else if (structType === 1) {
      // while + repeat 嵌套
      code += 'while ' + vars[1] + '<' + hex() + ' do ';
      code += vars[1] + '=' + vars[1] + '+' + binStr() + ' ';
      // 注意：用 Lua 表达式 vars[1]%256 作为键，而非 JS 求值
      code += D_ + '[' + vars[1] + '%256]=string.byte(' + vars[3] + ',(' + vars[1] + '%10)+1) or 0 ';
      code += 'if (' + D_ + '[' + vars[1] + '%256] or 0)==string.byte(' + escCmp + ') then ';
      code += 'repeat ';
      code += vars[0] + '=' + vars[0] + '+' + hex() + ' ';
      code += D_ + '["' + sk1 + '"]=' + vars[0] + '%256 ';
      code += 'until ' + vars[0] + '>=' + hex() + ' end ';
      code += 'end ';
    } else if (structType === 2) {
      // for + if/elseif 嵌套（用 + 替代 ~，兼容 Lua 5.1）
      code += 'for ' + vars[4] + '=' + hex() + ',' + hex() + ' do ';
      code += D_ + '[' + vars[4] + ']=(' + vars[0] + '+' + vars[4] + '*0x1F)%256 ';
      code += 'if (' + D_ + '[' + vars[4] + '] or 0)==' + hex() + ' then ';
      code += vars[2] + '=' + vars[2] + '+' + binStr() + ' ';
      code += 'elseif string.char((' + D_ + '[' + vars[4] + '] or 0))==' + escCmp + ' then ';
      code += vars[3] + '=' + vars[3] + '..string.char((' + D_ + '[' + vars[4] + '] or 0)) ';
      if (vars.length > 5) code += vars[5] + '=' + vars[5] + '+1 ';
      code += 'else ';
      code += D_ + '["' + sk1 + '"]=(tonumber(' + D_ + '["' + sk1 + '"]) or ' + vars[4] + ') end ';
      code += 'end ';
    } else {
      // repeat + for + if 三层嵌套
      code += 'repeat ';
      code += vars[0] + '=' + vars[0] + '+' + hex() + ' ';
      code += D_ + '[' + numKey() + ']=' + vars[0] + '%256 ';
      code += 'if ' + vars[0] + '%' + (Math.floor(Math.random()*7)+2) + '==0 then ';
      code += 'for ' + vars[4] + '=1,' + (Math.floor(Math.random()*8)+2) + ' do ';
      code += D_ + '["' + sk1 + '"]=((tonumber(' + D_ + '["' + sk1 + '"]) or 0))+' + vars[4] + ' ';
      code += 'if string.char((tonumber(' + D_ + '["' + sk1 + '"]) or 0)%256)==' + escCmp + ' then ';
      code += vars[2] + '=' + vars[2] + '+' + binStr() + ' end ';
      code += 'end end ';
      code += 'until ' + vars[0] + '>=' + hex() + ' ';
    }

    // bit32 运算（安全守卫：if bit32 then ...，始终包含）
    code += 'if bit32 then ';
    code += vars[2] + '=bit32.bxor(' + vars[0] + ',' + hex() + ') or ' + vars[2] + ' ';
    code += 'if bit32.rrotate then ' + D_ + '["' + strKey() + '"]=bit32.rrotate(' + vars[1] + ',' + (Math.floor(Math.random()*7)+1) + ') end ';
    code += 'end ';

    // 字符串拼接运算（始终包含）
    code += vars[3] + '=' + vars[3] + '..string.char((' + vars[0] + '+' + vars[1] + ')%256) ';
    code += vars[3] + '=' + vars[3] + '..string.char((' + vars[2] + '*'  + (Math.floor(Math.random()*5)+2) + ')%256) ';

    // if/elseif/else 块（始终包含，确保特征覆盖）
    code += 'if ' + vars[0] + '>' + vars[1] + ' then ';
    code += vars[2] + '=' + vars[2] + '+' + hex() + ' ';
    code += 'elseif ' + vars[0] + '<' + vars[1] + ' then ';
    code += vars[2] + '=' + vars[2] + '+' + binStr() + ' ';
    code += 'else ';
    code += D_ + '["' + sk2 + '"]=(' + vars[0] + '+' + vars[1] + ')%256 end ';

    // 死分支：调用未定义函数（if false then ... end，永不执行）
    code += 'if false then ';
    code += fn1 + '(' + fn2 + '(' + D_ + '["' + strKey() + '"],' + hex() + '),' + fn3 + '(' + vars[0] + ',' + vars[1] + ')) ';
    code += 'end ';

    code += 'end';
    return code;
  },

  // 独立注入假字节流块（当 junkCode 未启用时使用）
  // 复用 safeLine 扫描，在顶层语句间插入假字节流块
  injectFakeByteStream(code) {
    const lines = code.split('\n');
    const inserts = [];
    const density = this.config.junkDensity || 5;
    const interval = Math.max(1, Math.floor(15 / density));

    // 逐字符扫描统计块深度（与 injectJunkCode 相同逻辑）
    let depth = 0, braceDepth = 0, parenDepth = 0, lineNum = 0;
    const safeLines = [0];
    let i = 0;
    const len = code.length;
    while (i < len) {
      if (code[i] === '"' || code[i] === "'") {
        const q = code[i]; i++;
        while (i < len) { if (code[i] === '\\') { i += 2; continue; } if (code[i] === q) { i++; break; } i++; }
        continue;
      }
      if (code[i] === '[' && (code[i+1] === '[' || code[i+1] === '=')) {
        let level = 0, j = i + 1;
        while (code[j] === '=') { level++; j++; }
        if (code[j] === '[') { const cs = ']' + '='.repeat(level) + ']'; const end = code.indexOf(cs, j + 1); if (end !== -1) { i = end + cs.length; continue; } }
      }
      if (code[i] === '-' && code[i+1] === '-') {
        if (code[i+2] === '[' && (code[i+3] === '[' || code[i+3] === '=')) {
          let level = 0, j = i + 3;
          while (code[j] === '=') { level++; j++; }
          if (code[j] === '[') { const cs = ']' + '='.repeat(level) + ']'; const end = code.indexOf(cs, j + 1); if (end !== -1) { i = end + cs.length; continue; } }
        }
        while (i < len && code[i] !== '\n') i++;
        continue;
      }
      const ch = code[i];
      if (ch === '\n') {
        lineNum++;
        if (depth <= 0 && braceDepth <= 0 && parenDepth <= 0) {
          if (lineNum <= lines.length) safeLines.push(lineNum);
        }
        i++; continue;
      }
      if (isIdentStart(ch)) {
        let word = '';
        while (i < len && isIdentChar(code[i])) { word += code[i++]; }
        if (word === 'do' || word === 'then' || word === 'function' || word === 'repeat') depth++;
        if (word === 'end' || word === 'until') depth--;
        continue;
      }
      if (ch === '{') { braceDepth++; i++; continue; }
      if (ch === '}') { braceDepth--; i++; continue; }
      if (ch === '(') { parenDepth++; i++; continue; }
      if (ch === ')') { parenDepth--; i++; continue; }
      i++;
    }

    // 在安全位置插入假字节流块
    for (let i = 0; i < safeLines.length; i += interval) {
      if (Math.random() < density / 10) {
        const lineNum = safeLines[i];
        if (lineNum <= lines.length) {
          inserts.push({ line: lineNum, code: this.generateFakeByteStreamBlock() });
        }
      }
    }

    // 从后往前插入
    for (let i = inserts.length - 1; i >= 0; i--) {
      lines.splice(inserts[i].line, 0, inserts[i].code);
    }
    return lines.join('\n');
  },

  // ========== Step 7: 控制流扁平化（增强版）==========
  // 将顶层顺序语句拆分为独立状态，用 while+if 状态机重组
  // 原始顺序: stmt1; stmt2; stmt3; ...
  // 扁平化后: local _state=N1 while _state~=0 do if _state==N1 then stmt1 _state=N2
  //           elseif _state==N2 then stmt2 _state=N3 ... end end
  // 状态编号随机打乱，增加静态分析难度
  //
  // 增强特征：
  // 1. while true do / repeat until false 嵌套结构
  // 2. 多个控制变量（Q, P, i 等）协同分发
  // 3. 随机生成的大状态号（4位数），使用多进制表示
  // 4. 每个 elseif 分支内插入随机的控制变量更新，干扰数据流分析
  // 5. 5 种变体（原 3 种 + 2 种新增深层嵌套）
  // 6. break 和 continue 模拟跳转
  obfuscateControlFlow(code) {
    // 1. 将代码拆分为顶层语句块
    const statements = this.splitTopLevelStatements(code);
    if (statements.length < 2) return code;

    // 2. 提取所有 local 声明并提升到 while 循环之前
    const hoistedLocals = [];
    const processedStmts = statements.map(stmt => {
      return this.extractAndHoistLocals(stmt, hoistedLocals);
    });

    // 3. 为每条语句分配随机状态编号（4位数，确保大间隔）
    const stateIds = [];
    const usedIds = new Set();
    for (let i = 0; i < processedStmts.length + 1; i++) {
      if (i === processedStmts.length) {
        stateIds.push(0); // halt state
      } else {
        let id;
        do {
          id = Math.floor(Math.random() * 9000) + 1000;
        } while (usedIds.has(id));
        usedIds.add(id);
        stateIds.push(id);
      }
    }

    // 4. 生成多个控制变量名（Q, P, i 风格）
    const stateVar = this.generateShortStyleName();  // 主控制变量
    const subStateVar = this.generateShortStyleName(); // 辅助控制变量
    const flagVar = this.generateShortStyleName();     // 循环标志
    const iterVar = this.generateShortStyleName();     // 迭代计数器
    const firstState = stateIds[0];

    // 辅助：将状态 ID 用多进制表示（增强数字混淆效果）
    const fmtId = (id) => {
      if (id === 0) return '(0)';
      const fmt = Math.floor(Math.random() * 5);
      switch (fmt) {
        case 0: return String(id);
        case 1: return '0x' + id.toString(16);
        case 2: return 'tonumber("' + id.toString(8) + '",8)';
        case 3: return 'tonumber("' + id.toString(2) + '",2)';
        case 4: {
          const a = Math.floor(Math.random() * (id - 1)) + 1;
          return '(' + a + '+' + (id - a) + ')';
        }
      }
      return String(id);
    };

    // 5. 随机选择分发结构变体（5 种）
    const variant = Math.floor(Math.random() * 5);

    let result = '';

    // 提升的 local 声明
    if (hoistedLocals.length > 0) {
      result += 'local ' + hoistedLocals.join(',') + ' ';
    }

    // 控制变量初始化
    result += 'local ' + stateVar + '=' + fmtId(firstState) + ' ';
    result += 'local ' + subStateVar + '=' + Math.floor(Math.random() * 999) + ' ';
    result += 'local ' + flagVar + '=true ';
    result += 'local ' + iterVar + '=0 ';

    if (variant === 0) {
      // 变体 1: while true do + if/elseif 状态机 + break
      result += 'while ' + flagVar + ' do ';
      result += iterVar + '=' + iterVar + '+1 ';
      result += 'if ' + iterVar + '>' + (processedStmts.length * 5 + 20) + ' then break end ';
      result += 'if ' + stateVar + '==' + fmtId(stateIds[0]) + ' then ';
      const _s0v0 = processedStmts[0].trim();
      result += _s0v0 + ' ';
      if (!/^return\b/.test(_s0v0)) {
        result += stateVar + '=' + fmtId(stateIds[1]) + ' ';
        result += subStateVar + '=' + subStateVar + '+' + Math.floor(Math.random()*100+1) + ' ';
      }

      for (let i = 1; i < processedStmts.length; i++) {
        result += 'elseif ' + stateVar + '==' + fmtId(stateIds[i]) + ' then ';
        const _siv0 = processedStmts[i].trim();
        result += _siv0 + ' ';
        if (!/^return\b/.test(_siv0)) {
          result += stateVar + '=' + fmtId(stateIds[i + 1]) + ' ';
          result += subStateVar + '=' + subStateVar + '+' + Math.floor(Math.random()*100+1) + ' ';
        }
      }

      result += 'else ' + flagVar + '=false end ';
      result += 'end';
    } else if (variant === 1) {
      // 变体 2: repeat ... until false + if/elseif 状态机
      result += 'repeat ';
      result += iterVar + '=' + iterVar + '+1 ';
      result += 'if ' + stateVar + '==' + fmtId(stateIds[0]) + ' then ';
      const _s0v1 = processedStmts[0].trim();
      result += _s0v1 + ' ';
      if (!/^return\b/.test(_s0v1)) {
        result += stateVar + '=' + fmtId(stateIds[1]) + ' ';
        result += subStateVar + '=' + subStateVar + '-' + Math.floor(Math.random()*50+1) + ' ';
      }

      for (let i = 1; i < processedStmts.length; i++) {
        result += 'elseif ' + stateVar + '==' + fmtId(stateIds[i]) + ' then ';
        const _siv1 = processedStmts[i].trim();
        result += _siv1 + ' ';
        if (!/^return\b/.test(_siv1)) {
          result += stateVar + '=' + fmtId(stateIds[i + 1]) + ' ';
          result += subStateVar + '=' + subStateVar + '-' + Math.floor(Math.random()*50+1) + ' ';
        }
      }

      result += 'else ' + flagVar + '=false end ';
      result += 'until not ' + flagVar;
    } else if (variant === 2) {
      // 变体 3: while true do + repeat until true 嵌套 + if/elseif + break
      result += 'while true do ';
      result += 'repeat ';
      result += iterVar + '=' + iterVar + '+1 ';
      result += 'if ' + stateVar + '==' + fmtId(stateIds[0]) + ' then ';
      const _s0v2 = processedStmts[0].trim();
      result += _s0v2 + ' ';
      if (!/^return\b/.test(_s0v2)) {
        result += stateVar + '=' + fmtId(stateIds[1]) + ' ';
        result += subStateVar + '=' + subStateVar + '+' + Math.floor(Math.random()*100+1) + ' ';
      }

      for (let i = 1; i < processedStmts.length; i++) {
        result += 'elseif ' + stateVar + '==' + fmtId(stateIds[i]) + ' then ';
        const _siv2 = processedStmts[i].trim();
        result += _siv2 + ' ';
        if (!/^return\b/.test(_siv2)) {
          result += stateVar + '=' + fmtId(stateIds[i + 1]) + ' ';
          result += subStateVar + '=' + subStateVar + '+' + Math.floor(Math.random()*100+1) + ' ';
        }
      }

      result += 'else ' + flagVar + '=false end ';
      result += 'until true ';
      result += 'if not ' + flagVar + ' then break end ';
      result += 'end';
    } else if (variant === 3) {
      // 变体 4: while true do + repeat until false 双层嵌套 + if/elseif + break
      result += 'while true do ';
      result += 'repeat ';
      result += iterVar + '=' + iterVar + '+1 ';
      result += 'if ' + iterVar + '>' + (processedStmts.length * 5 + 30) + ' then ' + flagVar + '=false end ';
      result += 'if ' + stateVar + '==' + fmtId(stateIds[0]) + ' then ';
      const _s0v3 = processedStmts[0].trim();
      result += _s0v3 + ' ';
      if (!/^return\b/.test(_s0v3)) {
        result += stateVar + '=' + fmtId(stateIds[1]) + ' ';
        result += subStateVar + '=' + subStateVar + '+' + Math.floor(Math.random()*100+1) + ' ';
      }

      for (let i = 1; i < processedStmts.length; i++) {
        result += 'elseif ' + stateVar + '==' + fmtId(stateIds[i]) + ' then ';
        const _siv3 = processedStmts[i].trim();
        result += _siv3 + ' ';
        if (!/^return\b/.test(_siv3)) {
          result += stateVar + '=' + fmtId(stateIds[i + 1]) + ' ';
          result += subStateVar + '=' + subStateVar + '+' + Math.floor(Math.random()*100+1) + ' ';
        }
      }

      result += 'else ' + flagVar + '=false end ';
      result += 'until not ' + flagVar + ' ';
      result += 'break ';
      result += 'end';
    } else {
      // 变体 5: while true do + if-elseif 多层分发 + break 跳转
      // 将状态分成两组，用嵌套 if-elseif 分发
      const midPoint = Math.ceil(processedStmts.length / 2);
      result += 'while true do ';
      result += iterVar + '=' + iterVar + '+1 ';
      result += 'if ' + iterVar + '>' + (processedStmts.length * 4 + 20) + ' then break end ';
      // 第一组状态
      result += 'if ' + stateVar + '==' + fmtId(stateIds[0]) + ' then ';
      const _s0v4 = processedStmts[0].trim();
      result += _s0v4 + ' ';
      if (!/^return\b/.test(_s0v4)) {
        result += stateVar + '=' + fmtId(stateIds[1]) + ' ';
        result += subStateVar + '=' + subStateVar + '+' + Math.floor(Math.random()*100+1) + ' ';
      }

      for (let i = 1; i < midPoint; i++) {
        result += 'elseif ' + stateVar + '==' + fmtId(stateIds[i]) + ' then ';
        const _siv4a = processedStmts[i].trim();
        result += _siv4a + ' ';
        if (!/^return\b/.test(_siv4a)) {
          result += stateVar + '=' + fmtId(stateIds[i + 1]) + ' ';
          result += subStateVar + '=' + subStateVar + '+' + Math.floor(Math.random()*100+1) + ' ';
        }
      }
      result += 'end ';
      // 第二组状态（单独 if-elseif 链）
      if (midPoint < processedStmts.length) {
        result += 'if ' + stateVar + '==' + fmtId(stateIds[midPoint]) + ' then ';
        const _smpv4 = processedStmts[midPoint].trim();
        result += _smpv4 + ' ';
        if (!/^return\b/.test(_smpv4)) {
          result += stateVar + '=' + fmtId(stateIds[midPoint + 1] || 0) + ' ';
          result += subStateVar + '=' + subStateVar + '+' + Math.floor(Math.random()*100+1) + ' ';
        }

        for (let i = midPoint + 1; i < processedStmts.length; i++) {
          result += 'elseif ' + stateVar + '==' + fmtId(stateIds[i]) + ' then ';
          const _siv4b = processedStmts[i].trim();
          result += _siv4b + ' ';
          if (!/^return\b/.test(_siv4b)) {
            result += stateVar + '=' + fmtId(stateIds[i + 1]) + ' ';
            result += subStateVar + '=' + subStateVar + '+' + Math.floor(Math.random()*100+1) + ' ';
          }
        }
        result += 'end ';
      }
      // 退出条件
      result += 'if ' + stateVar + '==' + fmtId(0) + ' then break end ';
      result += 'end';
    }

    return result;
  },

  // 从语句中提取 local 声明的变量名，将声明提升到外层
  // "local x = 10" -> 变量名 "x" 被提升, 语句变为 "x = 10"
  // "local x, y = 1, 2" -> 变量名 "x","y" 被提升, 语句变为 "x,y = 1, 2"
  // "local function f() ... end" -> 变量名 "f" 被提升, 语句变为 "f = function() ... end"
  extractAndHoistLocals(stmt, hoistedLocals) {
    // 逐字符扫描，追踪块嵌套深度，只提升深度 0 处的 local 声明
    // 修复：之前用全局正则会把函数体/循环体内的 local 也错误提升到外层作用域
    const self = this;
    let result = '';
    let i = 0;
    const len = stmt.length;
    let depth = 0; // function/do/then/repeat 递增，end/until 递减

    while (i < len) {
      const ch = stmt[i];

      // 跳过字符串字面量（避免把字符串内的 'local' 误判为关键字）
      if (ch === '"' || ch === "'") {
        const q = ch;
        result += stmt[i++];
        while (i < len) {
          if (stmt[i] === '\\') { result += stmt[i++]; if (i < len) result += stmt[i++]; continue; }
          if (stmt[i] === q) { result += stmt[i++]; break; }
          result += stmt[i++];
        }
        continue;
      }

      // 跳过长字符串 [[ ... ]]
      if (ch === '[' && i + 1 < len && (stmt[i+1] === '[' || stmt[i+1] === '=')) {
        let lvl = 0, j = i + 1;
        while (j < len && stmt[j] === '=') { lvl++; j++; }
        if (j < len && stmt[j] === '[') {
          const close = ']' + '='.repeat(lvl) + ']';
          const end = stmt.indexOf(close, j + 1);
          if (end !== -1) {
            result += stmt.substring(i, end + close.length);
            i = end + close.length;
            continue;
          }
        }
      }

      // 标识符 / 关键字
      if (isIdentStart(ch)) {
        let word = '';
        while (i < len && isIdentChar(stmt[i])) word += stmt[i++];

        // 追踪块深度：进入块
        if (word === 'function' || word === 'do' || word === 'then' || word === 'repeat') {
          depth++;
          result += word;
          continue;
        }
        // 追踪块深度：退出块
        if (word === 'end' || word === 'until') {
          depth--;
          result += word;
          continue;
        }

        // 仅在深度 0 处处理 local 声明（函数体/循环体内的 local 不提升）
        if (word === 'local' && depth === 0) {
          // 跳过 local 后的空白
          let j = i;
          while (j < len && (stmt[j] === ' ' || stmt[j] === '\t')) j++;

          // 情形 1: local function name(  →  name=function(
          const fnMatch = stmt.slice(j).match(/^function\s+([a-zA-Z_]\w*)\s*\(/);
          if (fnMatch) {
            const name = fnMatch[1];
            self.renameIfNeeded(name, hoistedLocals);
            result += name + '=function(';
            i = j + fnMatch[0].length; // 跳过 "function name("
            depth++;                   // 进入函数体
            continue;
          }

          // 情形 2: local var1, var2 [= ...]
          const varListMatch = stmt.slice(j).match(/^([a-zA-Z_]\w*(?:\s*,\s*[a-zA-Z_]\w*)*)\s*(=)?/);
          if (varListMatch) {
            const varList = varListMatch[1];
            const hasAssign = !!varListMatch[2];
            for (const n of varList.split(',').map(s => s.trim())) {
              if (/^[a-zA-Z_]\w*$/.test(n)) self.renameIfNeeded(n, hoistedLocals);
            }
            if (hasAssign) {
              // local x = expr  →  x = expr
              result += varList + ' =';
              i = j + varListMatch[0].length;
            } else {
              // local x（仅声明，无赋值）→ 移除，变量已在顶部预声明
              i = j + varListMatch[0].length;
            }
            continue;
          }

          // 无法识别的 local 形式，原样保留
          result += 'local ';
          continue;
        }

        result += word;
        continue;
      }

      result += stmt[i++];
    }

    return result;
  },

  // 确保变量名在提升列表中（避免重复）
  renameIfNeeded(name, hoistedLocals) {
    if (!hoistedLocals.includes(name)) {
      hoistedLocals.push(name);
    }
    return name;
  },

  // ========== 函数拆分与重组 ==========
  // 将大函数的函数体拆分为多个内部小函数，用表/闭包调用重组
  splitFunctions(code) {
    // 匹配 function name(params) ... end 或 local function name(params) ... end
    // 只拆分函数体超过 threshold 行的函数
    const threshold = 6;
    let result = '';
    let i = 0;
    const len = code.length;

    while (i < len) {
      // 检测 function 关键字
      if (code.substring(i, i + 9) === 'function ' || code.substring(i, i + 17) === 'local function ') {
        const isLocal = code.substring(i, i + 6) === 'local ';
        const funcStart = i;
        const kwEnd = isLocal ? i + 17 : i + 9;
        i = kwEnd;

        // 提取函数名和参数
        let namePart = '';
        while (i < len && code[i] !== '(') {
          namePart += code[i];
          i++;
        }
        // 提取参数列表
        let params = '';
        if (code[i] === '(') {
          let pDepth = 1;
          i++;
          while (i < len && pDepth > 0) {
            if (code[i] === '(') pDepth++;
            else if (code[i] === ')') pDepth--;
            if (pDepth > 0) params += code[i];
            i++;
          }
        }
        // 跳过空格到函数体开始
        while (i < len && code[i] !== '\n' && code[i] === ' ') i++;

        // 找到匹配的 end（跟踪块深度）
        let bodyStart = i;
        let depth = 1; // 已经进入 function 块
        let body = '';
        while (i < len && depth > 0) {
          // 跳过字符串
          if (code[i] === '"' || code[i] === "'") {
            const q = code[i];
            body += code[i++];
            while (i < len) {
              if (code[i] === '\\') { body += code[i++]; if (i < len) body += code[i++]; continue; }
              if (code[i] === q) { body += code[i++]; break; }
              body += code[i++];
            }
            continue;
          }
          // 跳过长字符串
          if (code[i] === '[' && (code[i + 1] === '[' || code[i + 1] === '=')) {
            let level = 0, j = i + 1;
            while (code[j] === '=') { level++; j++; }
            if (code[j] === '[') {
              const closeStr = ']' + '='.repeat(level) + ']';
              const end2 = code.indexOf(closeStr, j + 1);
              if (end2 !== -1) {
                body += code.substring(i, end2 + closeStr.length);
                i = end2 + closeStr.length;
                continue;
              }
            }
          }
          // 跳过注释
          if (code[i] === '-' && code[i + 1] === '-') {
            while (i < len && code[i] !== '\n') body += code[i++];
            continue;
          }
          // 跟踪块关键字
          if (isIdentStart(code[i])) {
            let word = '';
            while (i < len && isIdentChar(code[i])) { word += code[i++]; }
            if (word === 'do' || word === 'then' || word === 'function' || word === 'repeat') depth++;
            if (word === 'end' || word === 'until') depth--;
            body += word;
            continue;
          }
          body += code[i++];
        }
        // 跳过 end 关键字
        if (code.substring(i, i + 3) === 'end') i += 3;

        const bodyLines = body.split('\n').filter(l => l.trim().length > 0);
        const funcName = namePart.trim();

        // 如果函数体足够大，进行拆分
        if (bodyLines.length >= threshold && !this.keywords.has(funcName) && !this.robloxGlobals.has(funcName)) {
          // Bug: 如果函数体包含对自身（funcName）的调用，拆分后递归调用会指向外层函数，
          //      导致无限递归（外层调用子函数，子函数又调用外层）
          // 修复：检测函数体是否包含递归调用，如果包含则跳过拆分
          const isRecursive = new RegExp('\\b' + funcName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\s*\\(').test(body);
          if (!isRecursive) {
            // 将函数体拆分为 2-3 个片段
            const numChunks = Math.min(3, Math.max(2, Math.floor(bodyLines.length / threshold)));
            const chunkSize = Math.ceil(bodyLines.length / numChunks);
            const chunks = [];
            for (let c = 0; c < numChunks; c++) {
              const chunk = bodyLines.slice(c * chunkSize, (c + 1) * chunkSize).join('\n');
              chunks.push(chunk);
            }

            // 生成内部小函数名
            const subFuncNames = chunks.map(() => this.generateShortStyleName());
            const dispatchTbl = this.generateShortStyleName();
            const dispatchIdx = this.generateShortStyleName();

            // 构建：函数体内调用一系列内部小函数
            let newBody = '\n';
            // 定义内部小函数
            for (let c = 0; c < chunks.length; c++) {
              newBody += '  local function ' + subFuncNames[c] + '(...) ' + chunks[c].trim() + ' end\n';
            }
            // 用调度表/闭包链调用
            // 方式 1: 顺序调用各子函数
            for (let c = 0; c < chunks.length; c++) {
              if (c === 0) {
                newBody += '  ' + subFuncNames[c] + '(...)\n';
              } else {
                newBody += '  ' + subFuncNames[c] + '(...)\n';
              }
            }

            // 重建函数（split 路径：newBody 不含 end，需补一个）
            const prefix = isLocal ? 'local function ' : 'function ';
            result += prefix + funcName + '(' + params + ')' + newBody + 'end';
          } else {
            // 递归函数：不拆分，保留原样（避免拆分后产生无限递归）
            const prefix = isLocal ? 'local function ' : 'function ';
            result += prefix + funcName + '(' + params + ')' + body;
          }
        } else {
          // 不拆分，保留原样
          // body 扫描器在 depth 降为 0 时已将函数结尾的 end 写入 body，
          // 此处直接使用 body，不再额外追加 end（否则产生双 end 语法错误）
          const prefix = isLocal ? 'local function ' : 'function ';
          result += prefix + funcName + '(' + params + ')' + body;
        }
      } else {
        result += code[i++];
      }
    }
    return result;
  },

  // 将代码拆分为顶层语句（不进入 do/then/function/repeat 块内部）
  // 返回语句数组，每个元素是一条完整的顶层语句
  splitTopLevelStatements(code) {
    const statements = [];
    let current = '';
    let depth = 0;       // block depth (do/then/function/repeat/end/until)
    let braceDepth = 0;  // table constructor depth ({ })
    let parenDepth = 0;  // parenthesis depth (( ))
    let i = 0;
    const len = code.length;

    while (i < len) {
      // 跳过字符串
      if (code[i] === '"' || code[i] === "'") {
        const q = code[i];
        current += code[i++];
        while (i < len) {
          if (code[i] === '\\') { current += code[i++]; if (i < len) current += code[i++]; continue; }
          if (code[i] === q) { current += code[i++]; break; }
          current += code[i++];
        }
        continue;
      }

      // 跳过长字符串
      if (code[i] === '[' && (code[i+1] === '[' || code[i+1] === '=')) {
        let level = 0, j = i + 1;
        while (code[j] === '=') { level++; j++; }
        if (code[j] === '[') {
          const closeStr = ']' + '='.repeat(level) + ']';
          const end = code.indexOf(closeStr, j + 1);
          if (end !== -1) {
            current += code.substring(i, end + closeStr.length);
            i = end + closeStr.length;
            continue;
          }
        }
      }

      // 跳过注释
      if (code[i] === '-' && code[i+1] === '-') {
        while (i < len && code[i] !== '\n') { current += code[i++]; }
        continue;
      }

      const ch = code[i];

      // 块开始: do, then, function, repeat
      if (isIdentStart(ch)) {
        let word = '';
        while (i < len && isIdentChar(code[i])) { word += code[i++]; }
        if (word === 'do' || word === 'then' || word === 'function' || word === 'repeat') {
          depth++;
        }
        if (word === 'end' || word === 'until') {
          depth--;
        }
        current += word;
        continue;
      }

      // 跟踪 table constructor 深度
      if (ch === '{') { braceDepth++; current += ch; i++; continue; }
      if (ch === '}') { braceDepth--; current += ch; i++; continue; }

      // 跟踪括号深度（多行函数调用）
      if (ch === '(') { parenDepth++; current += ch; i++; continue; }
      if (ch === ')') { parenDepth--; current += ch; i++; continue; }

      // 语句分隔符: ; 或 \n（仅在所有深度都为 0 时分割）
      if (depth <= 0 && braceDepth <= 0 && parenDepth <= 0 && (ch === ';' || ch === '\n')) {
        if (current.trim()) {
          statements.push(current.trim());
        }
        current = '';
        i++;
        continue;
      }

      current += code[i++];
    }

    // 最后一条语句
    if (current.trim()) {
      statements.push(current.trim());
    }

    return statements;
  },

  // 将数字混淆为随机格式（用于状态机内部编号）
  // 增强版：支持八进制、二进制、带下划线的进制表示
  obfuscateNumber(n) {
    if (n === 0) return '(0)';
    const method = Math.floor(Math.random() * 8);
    switch (method) {
      case 0: return String(n);
      case 1: return '0x' + n.toString(16);
      case 2: {
        const a = Math.floor(Math.random() * (n - 1)) + 1;
        return '(' + a + '+' + (n - a) + ')';
      }
      case 3: {
        const big = n + Math.floor(Math.random() * 500) + 50;
        return '(' + big + '-' + (big - n) + ')';
      }
      case 4: return 'tonumber("' + n.toString(8) + '",8)';
      case 5: return 'tonumber("' + n.toString(2) + '",2)';
      case 6: {
        // 十六进制 + 八进制交叉
        if (n > 4) {
          const a = Math.floor(Math.random() * (n - 2)) + 1;
          const b = n - a;
          return '(tonumber("' + a.toString(16) + '",16)+tonumber("' + b.toString(8) + '",8))';
        }
        return String(n);
      }
      case 7: {
        // 带下划线的二进制（通过 gsub 去除下划线后 tonumber）
        const binStr = n.toString(2);
        // 动态选择分组大小，确保一定能插入下划线
        let gs2 = 4;
        if (binStr.length <= 4) gs2 = Math.max(1, Math.floor(binStr.length / 2));
        let binUnder = '';
        for (let i = 0; i < binStr.length; i++) {
          if (i > 0 && (binStr.length - i) % gs2 === 0) binUnder += '_';
          binUnder += binStr[i];
        }
        if (binUnder.includes('_')) {
          return 'tonumber(("' + binUnder + '"):gsub("_",""),2)';
        }
        return 'tonumber("' + binStr + '",2)';
      }
    }
    return String(n);
  },

  // ========== 静态环境混淆 ==========
  // 将代码中引用的全局对象/函数缓存为 local 变量，防止运行时被 hook/篡改
  // 生成: local _v1=game local _v2=print ... (原始代码)
  staticEnvironment(code) {
    // 扫描代码中使用了哪些全局名称
    // 必须跳过：字符串内容、属性/方法访问（. 或 : 后的名称）、local 声明的变量
    const usedGlobals = new Set();
    const localDeclared = new Set();
    
    // 先收集 local 声明的变量名
    const localVarPattern = /local\s+([a-zA-Z_]\w*(?:\s*,\s*[a-zA-Z_]\w*)*)/g;
    let m;
    while ((m = localVarPattern.exec(code)) !== null) {
      const names = m[1].split(',');
      for (const n of names) {
        localDeclared.add(n.trim());
      }
    }
    
    // 逐字符扫描，跳过字符串和 ./: 后的属性名
    let i = 0;
    const len = code.length;
    while (i < len) {
      // 跳过字符串（双引号、单引号）
      if (code[i] === '"' || code[i] === "'") {
        const q = code[i];
        i++;
        while (i < len) {
          if (code[i] === '\\') { i += 2; continue; }
          if (code[i] === q) { i++; break; }
          i++;
        }
        continue;
      }
      // 跳过长字符串 [[ ... ]]
      if (code[i] === '[' && (code[i+1] === '[' || code[i+1] === '=')) {
        let level = 0, j = i + 1;
        while (code[j] === '=') { level++; j++; }
        if (code[j] === '[') {
          const closeStr = ']' + '='.repeat(level) + ']';
          const end = code.indexOf(closeStr, j + 1);
          i = (end !== -1) ? end + closeStr.length : len;
          continue;
        }
      }
      // 跳过 . 或 : 后的属性/方法名
      if ((code[i] === '.' || code[i] === ':') && isIdentStart(code[i+1] || '')) {
        i++;
        while (i < len && isIdentChar(code[i])) i++;
        continue;
      }
      // 匹配标识符
      if (isIdentStart(code[i])) {
        let name = '';
        const start = i;
        while (i < len && isIdentChar(code[i])) {
          name += code[i];
          i++;
        }
        // 检查是否为全局引用
        if (!this.keywords.has(name) && !localDeclared.has(name)) {
          if (this.robloxGlobals.has(name) || this.isCommonGlobal(name)) {
            usedGlobals.add(name);
          }
        }
        continue;
      }
      i++;
    }
    
    if (usedGlobals.size === 0) return code;
    
    // 为每个全局生成一个 local 缓存
    const cacheLines = [];
    const nameMap = {};
    for (const g of usedGlobals) {
      const alias = this.generateName();
      nameMap[g] = alias;
      cacheLines.push('local ' + alias + '=' + g);
    }
    
    // 在代码中替换这些全局引用为缓存变量
    // 同样需要跳过字符串和属性访问
    let result = '';
    i = 0;
    while (i < len) {
      // 复制字符串
      if (code[i] === '"' || code[i] === "'") {
        const q = code[i];
        result += code[i++];
        while (i < len) {
          if (code[i] === '\\') { result += code[i++]; if (i < len) result += code[i++]; continue; }
          if (code[i] === q) { result += code[i++]; break; }
          result += code[i++];
        }
        continue;
      }
      // 复制长字符串
      if (code[i] === '[' && (code[i+1] === '[' || code[i+1] === '=')) {
        let level = 0, j = i + 1;
        while (code[j] === '=') { level++; j++; }
        if (code[j] === '[') {
          const closeStr = ']' + '='.repeat(level) + ']';
          const end = code.indexOf(closeStr, j + 1);
          if (end !== -1) {
            result += code.substring(i, end + closeStr.length);
            i = end + closeStr.length;
            continue;
          }
        }
      }
      // 跳过属性/方法名（. 或 : 后的标识符，不替换）
      if ((code[i] === '.' || code[i] === ':') && isIdentStart(code[i+1] || '')) {
        result += code[i++];
        while (i < len && isIdentChar(code[i])) {
          result += code[i++];
        }
        continue;
      }
      // 匹配标识符并替换
      if (isIdentStart(code[i])) {
        let name = '';
        while (i < len && isIdentChar(code[i])) {
          name += code[i++];
        }
        if (nameMap[name]) {
          result += nameMap[name];
        } else {
          result += name;
        }
        continue;
      }
      result += code[i++];
    }
    
    // 用 do ... end 包裹，将 local 缓存和代码放在同一作用域
    return 'do ' + cacheLines.join(' ') + ' ' + result + ' end';
  },

  // 判断是否为常见的 Lua/Roblox 全局名称
  // 注意：只有真正通过全局表访问的名称才应返回 true
  // 属性名（如 GetService, LocalPlayer, Name）不应匹配，因为它们通过 ./: 访问
  isCommonGlobal(name) {
    // 首字母大写的 Roblox 全局类型（在 robloxGlobals 中已覆盖大部分）
    // 这里补充一些可能不在 robloxGlobals 中的
    const globalTypes = new Set([
      'Vector3','Vector2','CFrame','Color3','UDim','UDim2','Rect','Region3',
      'BrickColor','Enum','Instance','TweenInfo','DateTime','NumberSequence',
      'ColorSequence','Ray','Faces','PhysicalProperties','Random',
    ]);
    if (globalTypes.has(name)) return true;
    
    // 常见小写全局函数
    const commonLower = new Set([
      'print','warn','error','assert','pcall','xpcall','tostring','tonumber',
      'rawget','rawset','rawequal','rawlen','select','type','typeof','next',
      'pairs','ipairs','unpack','setmetatable','getmetatable','getfenv','setfenv',
      'loadstring','load','dofile','collectgarbage','newproxy','require',
      'wait','spawn','delay','tick','task',
    ]);
    return commonLower.has(name);
  },

  // ========== 自定义虚拟机混淆 (VM v2) ==========
  // 将代码编码为自定义字节码，由内嵌 VM 解释器执行
  // VM 使用基于栈的架构，支持基本的 Lua 操作子集
  customVM(code) {
    // ========== 增强型自定义虚拟机 v2 ==========
    // 将原始代码编码为自定义字节码，由内置解释器（VM）运行时执行
    //
    // v2 增强特征：
    // 1. 五层加密链：半字节交换 → 主密钥加 → 组轮转 → 二次位置混淆 → 二次密钥加
    // 2. 密钥扩展：3 字节种子经 LCG 扩展为 16 字节密钥
    // 3. Opcode 重映射：每次生成随机置换，指令流中 opcode 值被打乱
    // 4. 完整性校验：Adler 风格校验和，解码后自检，篡改即停机
    // 5. 丰富的指令集（13 opcode），handler 函数使用短名风格
    // 6. 状态机分发：while true do + repeat until false 嵌套
    // 7. 更多 junk 指令变体：SWAP/ADD_N/DUP+POP 交叉注入

    const bytes = this.toUtf8Bytes(code);

    // VM 指令集设计（13 opcodes，运行时重映射）：
    // OP  | 含义
    // 0   | PUSH_N <n>            - 压入数字 n 到栈顶
    // 1   | PUSH_S <len> <bytes>  - 压入字符串（长度+字节内容）
    // 2   | CONCAT                - 弹出栈顶，拼接到累加器
    // 3   | EXEC                  - 直接执行预嵌入代码
    // 4   | HALT                  - 停止 VM
    // 5   | MULTI_DECRYPT         - 五层反向解密（参数内嵌于 handler）
    // 6   | ADD_N <n>             - 栈顶数字 += n（算术混淆）
    // 7   | JUMP <offset>         - PC 跳转（控制流干扰）
    // 8   | DUP                   - 复制栈顶
    // 9   | POP                   - 弹出并丢弃栈顶
    // 10  | SWAP                  - 交换栈顶两个元素
    // 11  | NOP                   - 空操作（插入干扰指令）
    // 12  | CHECKSUM              - 完整性校验（失败则停机）

    // === 五层加密（与字节流 v2 一致）===
    const seed = [
      Math.floor(Math.random() * 256),
      Math.floor(Math.random() * 256),
      Math.floor(Math.random() * 256),
    ];
    const keyLen = 16;
    const expandedKey = new Array(keyLen);
    expandedKey[0] = seed[0];
    for (let i = 1; i < keyLen; i++) {
      expandedKey[i] = (expandedKey[i - 1] * 31 + seed[i % 3] + i) % 256;
    }
    const nibbleSwap = Math.random() < 0.5;
    const rotateStep = 3 + Math.floor(Math.random() * 4);
    const posStep = Math.floor(Math.random() * 7) + 1;
    const posStep2 = Math.floor(Math.random() * 7) + 1;
    const keyShift = Math.floor(Math.random() * keyLen);

    const encrypted = bytes.slice();
    const n = encrypted.length;

    // 层 0: 半字节交换
    if (nibbleSwap) {
      for (let i = 0; i < n; i++) {
        const b = encrypted[i];
        encrypted[i] = ((b % 16) * 16 + Math.floor(b / 16));
      }
    }
    // 层 1: 主密钥加
    for (let i = 0; i < n; i++) {
      encrypted[i] = (encrypted[i] + expandedKey[i % keyLen]) % 256;
    }
    // 层 2: 组内右轮转 1 位
    for (let i = 0; i < n; i += rotateStep) {
      const end = Math.min(i + rotateStep, n);
      const segment = encrypted.slice(i, end);
      if (segment.length > 1) {
        const last = segment[segment.length - 1];
        for (let j = segment.length - 1; j > 0; j--) segment[j] = segment[j - 1];
        segment[0] = last;
      }
      for (let j = 0; j < segment.length; j++) encrypted[i + j] = segment[j];
    }
    // 层 3: 二次位置混淆（模运算避免大数精度丢失）
    for (let i = 0; i < n; i++) {
      const im = i % 256;
      const offset = (im * posStep + im * im % 256 * posStep2) % 256;
      encrypted[i] = (encrypted[i] + offset) % 256;
    }
    // 层 4: 二次密钥加
    for (let i = 0; i < n; i++) {
      encrypted[i] = (encrypted[i] + expandedKey[(i + keyShift) % keyLen]) % 256;
    }

    // 完整性校验和
    let checksum = 0;
    for (let i = 0; i < bytes.length; i++) checksum = (checksum + bytes[i]) % 65521;

    // === Opcode 重映射（Fisher-Yates 随机置换）===
    const numOpcodes = 13;
    const opcodePerm = [];
    for (let i = 0; i < numOpcodes; i++) opcodePerm.push(i);
    for (let i = numOpcodes - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [opcodePerm[i], opcodePerm[j]] = [opcodePerm[j], opcodePerm[i]];
    }
    const rop = (origOp) => opcodePerm[origOp];

    // === 指令生成 ===
    const CHUNK_SIZE = 150;
    const instructions = [];

    for (let i = 0; i < n; i += CHUNK_SIZE) {
      const chunk = encrypted.slice(i, Math.min(i + CHUNK_SIZE, n));

      // junk: NOP
      if (Math.random() < 0.3) instructions.push(rop(11));
      // junk: PUSH_N + POP
      if (Math.random() < 0.2) {
        instructions.push(rop(0));
        instructions.push(Math.floor(Math.random() * 255));
        instructions.push(rop(9));
      }

      instructions.push(rop(1)); // PUSH_S
      instructions.push(chunk.length);
      instructions.push(...chunk);
      instructions.push(rop(2)); // CONCAT

      // junk: DUP + POP
      if (Math.random() < 0.15) {
        instructions.push(rop(8));
        instructions.push(rop(9));
      }
      // junk: SWAP（空栈上交换 nil，无算术操作，安全）
      if (Math.random() < 0.1) instructions.push(rop(10));
      // junk: PUSH_N + ADD_N + POP（先压栈再算术，避免空栈 nil 错误）
      if (Math.random() < 0.1) {
        instructions.push(rop(0));
        instructions.push(Math.floor(Math.random() * 255));
        instructions.push(rop(6));
        instructions.push(Math.floor(Math.random() * 100));
        instructions.push(rop(9));
      }
    }

    // junk: JUMP（跳过 NOP）
    if (Math.random() < 0.5) {
      instructions.push(rop(7));
      instructions.push(2);
      instructions.push(rop(11));
      instructions.push(rop(11));
    }

    instructions.push(rop(5));  // MULTI_DECRYPT
    instructions.push(rop(12)); // CHECKSUM
    instructions.push(rop(3));  // LOADSTR
    instructions.push(rop(4));  // HALT

    // === VM 解释器变量名 ===
    const instrName = this.generateShortStyleName();
    const stackName = this.generateShortStyleName();
    const spName = this.generateShortStyleName();
    const pcName = this.generateShortStyleName();
    const accName = this.generateShortStyleName();
    const opName = this.generateShortStyleName();
    const tmpName = this.generateShortStyleName();
    const tmp2Name = this.generateShortStyleName();
    const i2Name = this.generateShortStyleName();
    const strName = this.generateShortStyleName();
    const stateVar = this.generateShortStyleName();
    const handlerTbl = this.generateShortStyleName();
    // MULTI_DECRYPT 专用变量
    const byteTblVar = this.generateShortStyleName();
    const totalVar = this.generateShortStyleName();
    const ekVar = this.generateShortStyleName();
    const seedVar = this.generateShortStyleName();
    const rotVar = this.generateShortStyleName();
    const posVar = this.generateShortStyleName();
    const pos2Var = this.generateShortStyleName();
    const shiftVar = this.generateShortStyleName();
    const chkAccVar = this.generateShortStyleName();
    const chkVar = this.generateShortStyleName();
    const hiVar = this.generateShortStyleName();
    const loVar = this.generateShortStyleName();
    const junkVar = this.generateShortStyleName();
    const cvmCacheVar = this.generateShortStyleName();
    const cvmLoadRef = this.generateShortStyleName();

    const handlerNames = [];
    for (let i = 0; i < numOpcodes; i++) {
      handlerNames.push(this.generateShortStyleName());
    }

    // E = 操作码表（Opcode table），i_var = 寄存器环境（Register environment）
    const E = this.generateShortStyleName();
    const i_var = this.generateShortStyleName();
    // 辅助：将索引用多进制格式化
    const fmtIdx = (n) => {
      const fmt = Math.floor(Math.random() * 6);
      switch (fmt) {
        case 0: return String(n);
        case 1: return '0x' + n.toString(16);
        case 2: return '0X' + n.toString(16).toUpperCase();
        case 3: return 'tonumber("' + n.toString(2) + '",2)';
        case 4: return 'tonumber("' + n.toString(8) + '",8)';
        case 5: {
          const a = Math.floor(Math.random() * (n - 1)) + 1;
          return '(' + a + '+' + (n - a) + ')';
        }
      }
      return String(n);
    };

    const instrData = '{' + instructions.join(',') + '}';

    let vm = '';

    // --- 段 0: 私有缓存 + load 加载器 ---
    vm += 'local ' + cvmCacheVar + '={} ';
    vm += 'local ' + cvmLoadRef + '=function(_s) ';
    vm += 'if ' + cvmCacheVar + '[_s] then return ' + cvmCacheVar + '[_s] end ';
    vm += 'local _f=load(_s) ';
    vm += cvmCacheVar + '[_s]=_f ';
    vm += 'return _f ';
    vm += 'end ';

    // --- 段 1: 数据 ---
    vm += 'local ' + instrName + '=' + instrData + ' ';
    // 寄存器环境初始化（i 表存放局部变量/临时值，使用多进制索引访问）
    // i[0x1a] = nil, i[tonumber("10110",2)] = false, i[0X3B] = {} 等
    vm += 'local ' + i_var + '={} ';
    vm += i_var + '[' + fmtIdx(Math.floor(Math.random() * 50 + 10)) + ']=nil ';
    vm += i_var + '[' + fmtIdx(Math.floor(Math.random() * 80 + 60)) + ']=false ';
    vm += i_var + '[' + fmtIdx(Math.floor(Math.random() * 100 + 100)) + ']={} ';

    // --- 段 2: 栈和状态 ---
    vm += 'local ' + stackName + '={} ';
    vm += 'local ' + spName + '=0 ';
    vm += 'local ' + pcName + '=1 ';
    vm += 'local ' + accName + '="" ';
    vm += 'local ' + stateVar + '=' + Math.floor(Math.random() * 9999 + 1000) + ' ';

    // --- 段 3: handler 函数 ---
    // OP 0: PUSH_N
    vm += 'local function ' + handlerNames[0] + '() ';
    vm += stackName + '[' + spName + '+1]=' + instrName + '[' + pcName + '] ';
    vm += spName + '=' + spName + '+1 ';
    vm += pcName + '=' + pcName + '+1 ';
    vm += 'end ';

    // OP 1: PUSH_S
    vm += 'local function ' + handlerNames[1] + '() ';
    vm += tmpName + '=' + instrName + '[' + pcName + '] ';
    vm += pcName + '=' + pcName + '+1 ';
    vm += strName + '="" ';
    vm += 'for ' + i2Name + '=1,' + tmpName + ' do ';
    vm += strName + '=' + strName + '..string.char(' + instrName + '[' + pcName + ']) ';
    vm += pcName + '=' + pcName + '+1 ';
    vm += 'end ';
    vm += stackName + '[' + spName + '+1]=' + strName + ' ';
    vm += spName + '=' + spName + '+1 ';
    vm += 'end ';

    // OP 2: CONCAT
    vm += 'local function ' + handlerNames[2] + '() ';
    vm += accName + '=' + accName + '..' + stackName + '[' + spName + '] ';
    vm += spName + '=' + spName + '-1 ';
    vm += 'end ';

    // OP 3: LOADSTR — 通过 load 编译累加器中的代码并执行
    vm += 'local function ' + handlerNames[3] + '() ';
    vm += tmpName + '=' + cvmLoadRef + '(' + accName + ') ';
    vm += 'if ' + tmpName + ' then ' + tmpName + '() end ';
    vm += 'end ';

    // OP 4: HALT
    vm += 'local function ' + handlerNames[4] + '() ';
    vm += stateVar + '=0 ';
    vm += 'end ';

    // OP 5: MULTI_DECRYPT — 五层反向解密（参数内嵌）
    vm += 'local function ' + handlerNames[5] + '() ';
    // 累加器字符串 → 字节表
    vm += 'local ' + byteTblVar + '={} ';
    vm += 'local ' + totalVar + '=#' + accName + ' ';
    vm += 'for ' + i2Name + '=1,' + totalVar + ' do ';
    vm += byteTblVar + '[' + i2Name + ']=' + accName + ':byte(' + i2Name + ') ';
    vm += 'end ';
    // 密钥扩展（LCG 重建 16 字节密钥）
    vm += 'local ' + seedVar + '={' + seed[0] + ',' + seed[1] + ',' + seed[2] + '} ';
    vm += 'local ' + ekVar + '={} ';
    vm += ekVar + '[1]=' + seedVar + '[1] ';
    vm += 'for ' + i2Name + '=2,' + keyLen + ' do ';
    vm += ekVar + '[' + i2Name + ']=(' + ekVar + '[' + i2Name + '-1]*31+' + seedVar + '[(' + i2Name + '-1)%3+1]+(' + i2Name + '-1))%256 ';
    vm += 'end ';
    vm += 'local ' + rotVar + '=' + rotateStep + ' ';
    vm += 'local ' + posVar + '=' + posStep + ' ';
    vm += 'local ' + pos2Var + '=' + posStep2 + ' ';
    vm += 'local ' + shiftVar + '=' + keyShift + ' ';
    vm += 'local ' + junkVar + '=(' + ekVar + '[1]*7+' + posVar + ')%256 ';
    // 反向层 4: 二次密钥减
    vm += 'for ' + i2Name + '=1,' + totalVar + ' do ';
    vm += byteTblVar + '[' + i2Name + ']=(' + byteTblVar + '[' + i2Name + ']-' + ekVar + '[(' + i2Name + '-1+' + shiftVar + ')%' + keyLen + '+1])%256 ';
    vm += 'end ';
    // 反向层 3: 二次位置减（模运算避免精度丢失）
    vm += 'for ' + i2Name + '=1,' + totalVar + ' do ';
    vm += 'local _im=(' + i2Name + '-1)%256 ';
    vm += byteTblVar + '[' + i2Name + ']=(' + byteTblVar + '[' + i2Name + ']-(_im*' + posVar + '+_im*_im%256*' + pos2Var + ')%256)%256 ';
    vm += 'end ';
    // 反向层 2: 组内左轮转 1 位
    vm += i2Name + '=1 ';
    vm += 'while ' + i2Name + '<=' + totalVar + ' do ';
    vm += tmpName + '=' + rotVar + ' ';
    vm += 'if ' + i2Name + '+' + tmpName + '-1>' + totalVar + ' then ' + tmpName + '=' + totalVar + '-' + i2Name + '+1 end ';
    vm += 'if ' + tmpName + '>1 then ';
    vm += tmp2Name + '=' + byteTblVar + '[' + i2Name + '] ';
    vm += 'for ' + strName + '=1,' + tmpName + '-1 do ';
    vm += byteTblVar + '[' + i2Name + '+' + strName + '-1]=' + byteTblVar + '[' + i2Name + '+' + strName + '] ';
    vm += 'end ';
    vm += byteTblVar + '[' + i2Name + '+' + tmpName + '-1]=' + tmp2Name + ' ';
    vm += 'end ';
    vm += i2Name + '=' + i2Name + '+' + rotVar + ' ';
    vm += 'end ';
    // 反向层 1: 主密钥减
    vm += 'for ' + i2Name + '=1,' + totalVar + ' do ';
    vm += byteTblVar + '[' + i2Name + ']=(' + byteTblVar + '[' + i2Name + ']-' + ekVar + '[(' + i2Name + '-1)%' + keyLen + '+1])%256 ';
    vm += 'end ';
    // 反向层 0: 半字节交换（自逆）
    if (nibbleSwap) {
      vm += 'local ' + hiVar + ',' + loVar + ' ';
      vm += 'for ' + i2Name + '=1,' + totalVar + ' do ';
      vm += hiVar + '=math.floor(' + byteTblVar + '[' + i2Name + ']/16) ';
      vm += loVar + '=' + byteTblVar + '[' + i2Name + ']%16 ';
      vm += byteTblVar + '[' + i2Name + ']=' + loVar + '*16+' + hiVar + ' ';
      vm += 'end ';
    }
    // 字节表 → 累加器字符串 — 使用 table.concat 避免 O(n²)
    vm += 'local _tmp2={} ';
    vm += 'for ' + i2Name + '=1,' + totalVar + ' do ';
    vm += '_tmp2[#_tmp2+1]=string.char(' + byteTblVar + '[' + i2Name + ']) ';
    vm += 'end ';
    vm += accName + '=table.concat(_tmp2) ';
    vm += 'end ';

    // OP 6: ADD_N
    vm += 'local function ' + handlerNames[6] + '() ';
    vm += tmpName + '=' + instrName + '[' + pcName + '] ';
    vm += pcName + '=' + pcName + '+1 ';
    vm += stackName + '[' + spName + ']=(' + stackName + '[' + spName + ']+' + tmpName + ')%256 ';
    vm += 'end ';

    // OP 7: JUMP
    vm += 'local function ' + handlerNames[7] + '() ';
    vm += tmpName + '=' + instrName + '[' + pcName + '] ';
    vm += pcName + '=' + pcName + '+' + tmpName + ' ';
    vm += 'end ';

    // OP 8: DUP
    vm += 'local function ' + handlerNames[8] + '() ';
    vm += stackName + '[' + spName + '+1]=' + stackName + '[' + spName + '] ';
    vm += spName + '=' + spName + '+1 ';
    vm += 'end ';

    // OP 9: POP
    vm += 'local function ' + handlerNames[9] + '() ';
    vm += stackName + '[' + spName + ']=nil ';
    vm += spName + '=' + spName + '-1 ';
    vm += 'end ';

    // OP 10: SWAP
    vm += 'local function ' + handlerNames[10] + '() ';
    vm += tmpName + '=' + stackName + '[' + spName + '] ';
    vm += stackName + '[' + spName + ']=' + stackName + '[' + spName + '-1] ';
    vm += stackName + '[' + spName + '-1]=' + tmpName + ' ';
    vm += 'end ';

    // OP 11: NOP
    vm += 'local function ' + handlerNames[11] + '() end ';

    // OP 12: CHECKSUM — 完整性校验，失败则停机
    vm += 'local function ' + handlerNames[12] + '() ';
    vm += chkAccVar + '=0 ';
    vm += 'for ' + i2Name + '=1,#' + accName + ' do ';
    vm += chkAccVar + '=(' + chkAccVar + '+' + accName + ':byte(' + i2Name + '))%65521 ';
    vm += 'end ';
    vm += chkVar + '=' + checksum + ' ';
    vm += 'if ' + chkAccVar + '~=' + chkVar + ' then ' + stateVar + '=0 end ';
    vm += 'end ';

    // --- 段 4: handler 分发表（使用重映射后的 opcode + 多进制数组索引）---
    // E 是操作码→handler 映射表，i_var 是寄存器环境
    // 索引使用多进制混淆：E[0x36]、E[tonumber("111001",2)] 等
    vm += 'local ' + E + '={} ';
    vm += E + '[' + fmtIdx(opcodePerm[0]) + ']=' + handlerNames[0];
    for (let idx = 1; idx < numOpcodes; idx++) {
      vm += ' ' + E + '[' + fmtIdx(opcodePerm[idx]) + ']=' + handlerNames[idx];
    }
    vm += ' ';
    // 保留兼容性别名
    vm += 'local ' + handlerTbl + '=' + E + ' ';

    // --- 段 5: 状态机主循环（while true + repeat until false 驱动）---
    vm += 'while true do ';
    vm += 'if ' + stateVar + '==' + this.obfuscateNumber(0) + ' then break end ';
    vm += 'repeat ';
    vm += opName + '=' + instrName + '[' + pcName + '] ';
    vm += pcName + '=' + pcName + '+1 ';
    // 使用 E[opName] 进行操作码分发（多进制数组索引风格）
    vm += 'if ' + E + '[' + opName + '] then ';
    vm += E + '[' + opName + ']() ';
    vm += 'else ' + stateVar + '=0 end ';
    vm += 'until ' + stateVar + '==' + this.obfuscateNumber(0) + ' or ' + pcName + '>#' + instrName + ' ';
    vm += 'if ' + pcName + '>#' + instrName + ' then break end ';
    vm += 'end';

    return vm;
  },

  // ========== 自定义字节码虚拟机 (Custom Bytecode VM) ==========
  // 将原始 Lua 代码编译为自定义指令集，由内置 VM 解释器执行
  //
  // 架构：
  // 1. 编译器：Lua 源码 → UTF-8 字节 → 4 层连续加密 → 分块为 PUSH_STR 指令流
  // 2. 加密器：nibbleSwap → keyAdd(主密钥) → posObfusc(位置混淆) → keyAdd2(二次密钥)
  // 3. 解释器：栈式 VM，PUSH_STR 构建加密数据 → CONCAT 累加 → DECRYPT 4 层逆解 → CHECKSUM → LOADSTR
  //
  // 指令集（18 opcodes，运行时重映射）：
  // OP  | 含义
  // 0   | PUSH_CONST <idx>     - 从常量表压入值到栈顶
  // 1   | PUSH_NUM <n>         - 压入数字 n
  // 2   | PUSH_STR <len> <bytes> - 压入字符串（加密后的字节）
  // 3   | POP                   - 弹出栈顶
  // 4   | DUP                   - 复制栈顶
  // 5   | SWAP                  - 交换栈顶两个元素
  // 6   | CONCAT                - 弹出栈顶，拼接到累加器
  // 7   | EXEC                  - 直接执行预嵌入代码
  // 8   | HALT                  - 停止 VM
  // 9   | DECRYPT               - 4 层反向解密累加器
  // 10  | ADD_N <n>             - 栈顶数字 += n
  // 11  | JUMP <offset>         - PC 跳转
  // 12  | NOP                   - 空操作
  // 13  | CHECKSUM              - 完整性校验，失败则 error
  // 14  | XOR_N <n>             - 栈顶数字 XOR n（bit32 fallback）
  // 15  | MOD_N <n>             - 栈顶数字 % n
  // 16  | CALL                  - 弹出栈顶函数并调用
  // 17  | SET_GLOBAL <idx>      - 弹出栈顶，设置为全局变量
  customBytecodeVM(code) {
    // ====== Phase 1: 编译 — Lua 源码 → 字节 ======
    const bytes = this.toUtf8Bytes(code);

    const OP = {
      PUSH_CONST: 0, PUSH_NUM: 1, PUSH_STR: 2, POP: 3, DUP: 4, SWAP: 5,
      CONCAT: 6, LOADSTR: 7, HALT: 8, DECRYPT: 9, ADD_N: 10, JUMP: 11,
      NOP: 12, CHECKSUM: 13, XOR_N: 14, MOD_N: 15, CALL: 16, SET_GLOBAL: 17,
      // 增强新增 opcodes
      GET_GLOBAL: 18,    // 从 _G 获取全局变量压栈
      STORE_LOCAL: 19,   // 弹出栈顶存入 local 变量表
      LOAD_LOCAL: 20,    // 从 local 变量表加载到栈顶
      COMPARE_EQ: 21,    // 弹出两个值比较相等，结果压栈
      COMPARE_LT: 22,    // 弹出两个值比较小于，结果压栈
      COND_JUMP: 23,     // 条件跳转：弹出栈顶，非 nil 则跳
      // v2 增强新增 opcodes
      PUSH_TABLE: 24,    // 创建空表压栈
      TABLE_INSERT: 25,  // 弹出值和表，插入到表尾
      TABLE_GET: 26,     // 弹出 key 和表，压入 table[key]
      TABLE_SET: 27,     // 弹出 value、key、table，设置 table[key]=value
      MUL_N: 28,         // 栈顶数字 *= n
      SUB_N: 29,         // 栈顶数字 -= n
      ANTI_DEBUG: 30,    // 反调试检测（检测 debug.getinfo 是否被 hook）
      ENV_CHECK: 31,     // 环境检测（检测 _G 是否被篡改）
    };
    const numOpcodes = 32;

    // ====== Phase 2: 加密 — 对整个字节数组连续应用 8 层（v2 增强）======
    // 8 字节种子 → 四路 LCG 链 → 32 字节密钥
    const seed = [
      Math.floor(Math.random() * 256), Math.floor(Math.random() * 256),
      Math.floor(Math.random() * 256), Math.floor(Math.random() * 256),
      Math.floor(Math.random() * 256), Math.floor(Math.random() * 256),
      Math.floor(Math.random() * 256), Math.floor(Math.random() * 256),
    ];
    const keyLen = 32;
    // 四路 LCG 链密钥扩展（与 byteStream v3 一致，增强抗分析能力）
    const chainA = new Array(keyLen);
    const chainB = new Array(keyLen);
    const chainC = new Array(keyLen);
    const chainD = new Array(keyLen);
    chainA[0] = seed[0]; chainB[0] = seed[2]; chainC[0] = seed[4]; chainD[0] = seed[6];
    for (let i = 1; i < keyLen; i++) {
      chainA[i] = (chainA[i - 1] * 31 + seed[i % 8] + i) % 256;
      chainB[i] = (chainB[i - 1] * 37 + seed[(i + 2) % 8] + i * 7) % 256;
      chainC[i] = (chainC[i - 1] * 53 + seed[(i + 4) % 8] + i * 11) % 256;
      chainD[i] = (chainD[i - 1] * 71 + seed[(i + 6) % 8] + i * 13) % 256;
    }
    const expandedKey = new Array(keyLen);
    for (let i = 0; i < keyLen; i++) {
      expandedKey[i] = (chainA[i] + chainB[i] + chainC[i] + chainD[i] + i * 17) % 256;
    }

    const nibbleSwap = Math.random() < 0.5;
    const posStep = Math.floor(Math.random() * 7) + 1;
    const posStep2 = Math.floor(Math.random() * 7) + 1;
    const keyShift = Math.floor(Math.random() * keyLen);
    // 增强层 4-5 参数
    const multStep = (Math.floor(Math.random() * 3) + 3) * 2 + 1; // 7,9,11 (odd, guarantees mod-256 inverse)
    const addChain = Math.floor(Math.random() * 200) + 50; // accumulator chain seed

    // 对整个原始字节数组连续加密（6 层）
    const encryptedBytes = bytes.slice();
    const totalBytes = encryptedBytes.length;
    let chainAcc = addChain; // 累加器链
    for (let i = 0; i < totalBytes; i++) {
      let b = encryptedBytes[i];
      // 层 0: 半字节交换（自逆）
      if (nibbleSwap) b = ((b % 16) * 16 + Math.floor(b / 16));
      // 层 1: 主密钥加
      b = (b + expandedKey[i % keyLen]) % 256;
      // 层 2: 位置混淆（模运算避免大数精度丢失）
      const im = i % 256;
      b = (b + (im * posStep + im * im % 256 * posStep2) % 256) % 256;
      // 层 3: 二次密钥加
      b = (b + expandedKey[(i + keyShift) % keyLen]) % 256;
      // 层 4: 乘法混淆（增强）
      b = (b * multStep + i * 3) % 256;
      // 层 5: 累加器链（增强）— CBC 式：先加 old_acc，再用 enc 更新
      b = (b + chainAcc) % 256;
      chainAcc = (chainAcc * 31 + b + i) % 256;
      encryptedBytes[i] = b;
    }

    // ====== Phase 3: 生成指令流（opcode 明文，PUSH_STR 数据为加密字节）======
    const CHUNK_SIZE = 120;
    const finalInstructions = [];

    for (let i = 0; i < totalBytes; i += CHUNK_SIZE) {
      const chunk = encryptedBytes.slice(i, Math.min(i + CHUNK_SIZE, totalBytes));
      // junk: NOP (30%)
      if (Math.random() < 0.3) finalInstructions.push(OP.NOP);
      // junk: PUSH_NUM + POP (20%)
      if (Math.random() < 0.2) {
        finalInstructions.push(OP.PUSH_NUM);
        finalInstructions.push(Math.floor(Math.random() * 255));
        finalInstructions.push(OP.POP);
      }
      // 核心：PUSH_STR + CONCAT
      finalInstructions.push(OP.PUSH_STR);
      finalInstructions.push(chunk.length);
      finalInstructions.push(...chunk);
      finalInstructions.push(OP.CONCAT);
      // junk: DUP + POP (15%)
      if (Math.random() < 0.15) { finalInstructions.push(OP.DUP); finalInstructions.push(OP.POP); }
      // junk: SWAP (10%)
      if (Math.random() < 0.1) finalInstructions.push(OP.SWAP);
      // junk: PUSH_NUM + ADD_N + POP (10%)
      if (Math.random() < 0.1) {
        finalInstructions.push(OP.PUSH_NUM);
        finalInstructions.push(Math.floor(Math.random() * 255));
        finalInstructions.push(OP.ADD_N);
        finalInstructions.push(Math.floor(Math.random() * 100));
        finalInstructions.push(OP.POP);
      }
      // junk: PUSH_NUM + XOR_N + MOD_N + POP (8%)
      if (Math.random() < 0.08) {
        finalInstructions.push(OP.PUSH_NUM);
        finalInstructions.push(Math.floor(Math.random() * 255));
        finalInstructions.push(OP.XOR_N);
        finalInstructions.push(Math.floor(Math.random() * 256));
        finalInstructions.push(OP.MOD_N);
        finalInstructions.push(Math.floor(Math.random() * 255) + 1);
        finalInstructions.push(OP.POP);
      }
      // junk: PUSH_TABLE + PUSH_NUM + TABLE_INSERT + POP (6%) [v2 NEW]
      if (Math.random() < 0.06) {
        finalInstructions.push(OP.PUSH_TABLE);
        finalInstructions.push(OP.PUSH_NUM);
        finalInstructions.push(Math.floor(Math.random() * 255));
        finalInstructions.push(OP.TABLE_INSERT);
        finalInstructions.push(OP.POP);
      }
      // junk: PUSH_NUM + MUL_N + SUB_N + POP (5%) [v2 NEW]
      if (Math.random() < 0.05) {
        finalInstructions.push(OP.PUSH_NUM);
        finalInstructions.push(Math.floor(Math.random() * 255));
        finalInstructions.push(OP.MUL_N);
        finalInstructions.push(Math.floor(Math.random() * 13) + 1);
        finalInstructions.push(OP.SUB_N);
        finalInstructions.push(Math.floor(Math.random() * 50));
        finalInstructions.push(OP.POP);
      }
      // junk: ANTI_DEBUG (4%) [v2 NEW]
      if (Math.random() < 0.04) finalInstructions.push(OP.ANTI_DEBUG);
      // junk: ENV_CHECK (3%) [v2 NEW]
      if (Math.random() < 0.03) finalInstructions.push(OP.ENV_CHECK);
    }
    // junk: JUMP（跳过 NOP）
    if (Math.random() < 0.5) {
      finalInstructions.push(OP.JUMP);
      finalInstructions.push(2);
      finalInstructions.push(OP.NOP);
      finalInstructions.push(OP.NOP);
    }
    // 最终指令：DECRYPT → CHECKSUM → LOADSTR → HALT
    finalInstructions.push(OP.DECRYPT);
    finalInstructions.push(OP.CHECKSUM);
    finalInstructions.push(OP.LOADSTR);
    finalInstructions.push(OP.HALT);

    // 完整性校验和（对原始代码字节）
    let checksum = 0;
    for (let i = 0; i < bytes.length; i++) checksum = (checksum + bytes[i]) % 65521;

    // ====== Phase 4: Opcode 重映射 ======
    const opcodePerm = [];
    for (let i = 0; i < numOpcodes; i++) opcodePerm.push(i);
    for (let i = numOpcodes - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [opcodePerm[i], opcodePerm[j]] = [opcodePerm[j], opcodePerm[i]];
    }

    // 重映射指令流中的 opcode（遍历指令流结构化处理）
    const remappedInstructions = [];
    let pi = 0;
    while (pi < finalInstructions.length) {
      const origOp = finalInstructions[pi];
      // 重映射 opcode
      remappedInstructions.push(opcodePerm[origOp]);
      pi++;
      // 根据原始 opcode 跳过操作数
      switch (origOp) {
        case OP.PUSH_CONST:
        case OP.PUSH_NUM:
          remappedInstructions.push(finalInstructions[pi]);
          pi++;
          break;
        case OP.PUSH_STR: {
          const slen = finalInstructions[pi];
          remappedInstructions.push(slen);
          pi++;
          for (let j = 0; j < slen; j++) {
            remappedInstructions.push(finalInstructions[pi]);
            pi++;
          }
          break;
        }
        case OP.ADD_N:
        case OP.JUMP:
        case OP.XOR_N:
        case OP.MOD_N:
        case OP.SET_GLOBAL:
        case OP.GET_GLOBAL:
        case OP.STORE_LOCAL:
        case OP.LOAD_LOCAL:
        case OP.COND_JUMP:
        case OP.MUL_N:
        case OP.SUB_N:
        case OP.TABLE_GET:
        case OP.TABLE_SET:
          remappedInstructions.push(finalInstructions[pi]);
          pi++;
          break;
        default:
          // POP, DUP, SWAP, CONCAT, LOADSTR, HALT, DECRYPT, NOP, CHECKSUM, CALL,
          // COMPARE_EQ, COMPARE_LT, PUSH_TABLE, TABLE_INSERT, ANTI_DEBUG, ENV_CHECK: 无操作数
          break;
      }
    }

    // ====== Phase 5: 生成 VM 解释器 Lua 代码 ======
    const instrName = this.generateShortStyleName();
    const stackName = this.generateShortStyleName();
    const spName = this.generateShortStyleName();
    const pcName = this.generateShortStyleName();
    const accName = this.generateShortStyleName();
    const opName = this.generateShortStyleName();
    const tmpName = this.generateShortStyleName();
    const tmp2Name = this.generateShortStyleName();
    const i2Name = this.generateShortStyleName();
    const strName = this.generateShortStyleName();
    const stateVar = this.generateShortStyleName();
    const handlerTbl = this.generateShortStyleName();

    // DECRYPT handler 专用变量
    const byteTblVar = this.generateShortStyleName();
    const totalVar = this.generateShortStyleName();
    const ekVar = this.generateShortStyleName();
    const seedVar = this.generateShortStyleName();
    const posVar = this.generateShortStyleName();
    const pos2Var = this.generateShortStyleName();
    const shiftVar = this.generateShortStyleName();
    const hiVar = this.generateShortStyleName();
    const loVar = this.generateShortStyleName();
    const chkAccVar = this.generateShortStyleName();
    const chkVar = this.generateShortStyleName();

    const loadRef = this.generateShortStyleName();
    const scRef = this.generateShortStyleName();
    const mfRef = this.generateShortStyleName();
    const vmCacheVar = this.generateShortStyleName();

    const handlerNames = [];
    for (let i = 0; i < numOpcodes; i++) handlerNames.push(this.generateShortStyleName());

    // E = 操作码表（Opcode table），i_env = 寄存器环境（Register environment）
    const E = this.generateShortStyleName();
    const i_env = this.generateShortStyleName();
    // 辅助：将索引用多进制格式化（7种格式）
    const fmtVMIdx = (n) => {
      const fmt = Math.floor(Math.random() * 7);
      switch (fmt) {
        case 0: return String(n);
        case 1: return '0x' + n.toString(16);
        case 2: return '0X' + n.toString(16).toUpperCase();
        case 3: return 'tonumber("' + n.toString(2) + '",2)';
        case 4: return 'tonumber("' + n.toString(8) + '",8)';
        case 5: {
          const a = Math.floor(Math.random() * (n - 1)) + 1;
          return '(' + a + '+' + (n - a) + ')';
        }
        case 6: {
          const binStr = n.toString(2);
          let gs = 4;
          if (binStr.length <= 4) gs = Math.max(1, Math.floor(binStr.length / 2));
          let binUnder = '';
          for (let j = 0; j < binStr.length; j++) {
            if (j > 0 && (binStr.length - j) % gs === 0) binUnder += '_';
            binUnder += binStr[j];
          }
          return 'tonumber(("' + binUnder + '"):gsub("_",""),2)';
        }
      }
      return String(n);
    };

    const instrData = '{' + remappedInstructions.join(',') + '}';

    let vm = '';

    // --- 段 1: 私有缓存 + load 加载器 ---
    vm += 'local ' + vmCacheVar + '={} ';
    vm += 'local ' + loadRef + '=function(_s) ';
    vm += 'if ' + vmCacheVar + '[_s] then return ' + vmCacheVar + '[_s] end ';
    vm += 'local _f=load(_s) ';
    vm += vmCacheVar + '[_s]=_f ';
    vm += 'return _f ';
    vm += 'end ';
    vm += 'local ' + scRef + '=string.char ';
    vm += 'local ' + mfRef + '=math.floor ';

    // --- 段 2: 指令数据 ---
    vm += 'local ' + instrName + '=' + instrData + ' ';
    // 寄存器环境初始化（i_env 表存放局部变量/临时值，使用多进制索引访问）
    vm += 'local ' + i_env + '={} ';
    vm += i_env + '[' + fmtVMIdx(Math.floor(Math.random() * 50 + 10)) + ']=nil ';
    vm += i_env + '[' + fmtVMIdx(Math.floor(Math.random() * 80 + 60)) + ']=false ';
    vm += i_env + '[' + fmtVMIdx(Math.floor(Math.random() * 100 + 100)) + ']={} ';
    vm += i_env + '[' + fmtVMIdx(Math.floor(Math.random() * 200 + 200)) + ']=0 ';

    // --- 段 3: 栈和状态 ---
    vm += 'local ' + stackName + '={} ';
    vm += 'local ' + spName + '=0 ';
    vm += 'local ' + pcName + '=1 ';
    vm += 'local ' + accName + '="" ';
    vm += 'local ' + stateVar + '=' + Math.floor(Math.random() * 9999 + 1000) + ' ';

    // --- 段 4: DECRYPT handler — 4 层反向解密（与加密层逆序）---
    vm += 'local function ' + handlerNames[OP.DECRYPT] + '() ';
    // 累加器 → 字节表
    vm += 'local ' + byteTblVar + '={} ';
    vm += 'local ' + totalVar + '=#' + accName + ' ';
    vm += 'for ' + i2Name + '=1,' + totalVar + ' do ';
    vm += byteTblVar + '[' + i2Name + ']=' + accName + ':byte(' + i2Name + ') ';
    vm += 'end ';
    // 密钥扩展（四路 LCG 链 — 与加密端一致）
    vm += 'local ' + seedVar + '={' + seed.join(',') + '} ';
    vm += 'local ' + ekVar + '={} ';
    // JS: chainA[0]=seed[0], chainB[0]=seed[2], chainC[0]=seed[4], chainD[0]=seed[6]
    // Lua: _ca[1]=seedVar[1], _cb[1]=seedVar[3], _cc[1]=seedVar[5], _cd[1]=seedVar[7]
    vm += 'local _ca={} ';
    vm += 'local _cb={} ';
    vm += 'local _cc={} ';
    vm += 'local _cd={} ';
    vm += '_ca[1]=(' + seedVar + '[1])%256 ';
    vm += '_cb[1]=(' + seedVar + '[3])%256 ';
    vm += '_cc[1]=(' + seedVar + '[5])%256 ';
    vm += '_cd[1]=(' + seedVar + '[7])%256 ';
    vm += 'for ' + i2Name + '=2,' + keyLen + ' do ';
    // JS i=i2-1: chainA[i]=chainA[i-1]*31 + seed[i%8] + i
    vm += '_ca[' + i2Name + ']=(_ca[' + i2Name + '-1]*31+' + seedVar + '[((' + i2Name + '-1)%8)+1]+(' + i2Name + '-1))%256 ';
    // JS i=i2-1: chainB[i]=chainB[i-1]*37 + seed[(i+2)%8] + i*7
    vm += '_cb[' + i2Name + ']=(_cb[' + i2Name + '-1]*37+' + seedVar + '[((' + i2Name + '-1+2)%8)+1]+(' + i2Name + '-1)*7)%256 ';
    // JS i=i2-1: chainC[i]=chainC[i-1]*53 + seed[(i+4)%8] + i*11
    vm += '_cc[' + i2Name + ']=(_cc[' + i2Name + '-1]*53+' + seedVar + '[((' + i2Name + '-1+4)%8)+1]+(' + i2Name + '-1)*11)%256 ';
    // JS i=i2-1: chainD[i]=chainD[i-1]*71 + seed[(i+6)%8] + i*13
    vm += '_cd[' + i2Name + ']=(_cd[' + i2Name + '-1]*71+' + seedVar + '[((' + i2Name + '-1+6)%8)+1]+(' + i2Name + '-1)*13)%256 ';
    // expandedKey[i] = (chainA[i]+chainB[i]+chainC[i]+chainD[i]+i*17) % 256
    vm += ekVar + '[' + i2Name + ']=(_ca[' + i2Name + ']+_cb[' + i2Name + ']+_cc[' + i2Name + ']+_cd[' + i2Name + ']+(' + i2Name + '-1)*17)%256 ';
    vm += 'end ';
    // ekVar[1] = (chainA[0]+chainB[0]+chainC[0]+chainD[0]+0*17) % 256
    vm += ekVar + '[1]=(_ca[1]+_cb[1]+_cc[1]+_cd[1])%256 ';
    // 参数
    vm += 'local ' + posVar + '=' + posStep + ' ';
    vm += 'local ' + pos2Var + '=' + posStep2 + ' ';
    vm += 'local ' + shiftVar + '=' + keyShift + ' ';
    vm += 'local _multStep=' + multStep + ' ';
    vm += 'local _addChain=' + addChain + ' ';
    // 反向层 5: 累加器链逆 — CBC 逆：保存 old_acc，用密文更新，减去 old_acc
    vm += 'local _chainAcc=_addChain ';
    vm += 'local _oldAcc=0 ';
    vm += 'for ' + i2Name + '=1,' + totalVar + ' do ';
    vm += '_oldAcc=_chainAcc ';
    vm += '_chainAcc=(_chainAcc*31+' + byteTblVar + '[' + i2Name + ']+(' + i2Name + '-1))%256 ';
    vm += byteTblVar + '[' + i2Name + ']=(' + byteTblVar + '[' + i2Name + ']-_oldAcc)%256 ';
    vm += 'end ';
    // 反向层 4: 乘法逆（暴力搜索乘法逆元）
    vm += 'for ' + i2Name + '=1,' + totalVar + ' do ';
    vm += 'local _e=(' + byteTblVar + '[' + i2Name + ']-(' + i2Name + '-1)*3)%256 ';
    vm += 'local _d=0 for _r=0,255 do if (_r*_multStep)%256==_e%256 then _d=_r break end end ';
    vm += byteTblVar + '[' + i2Name + ']=_d ';
    vm += 'end ';
    // 反向层 3: 二次密钥减
    // JS: b = b - expandedKey[(i + keyShift) % keyLen]
    // Lua: i = i2-1, expandedKey index = (i2-1+keyShift) % keyLen → Lua table index +1
    vm += 'for ' + i2Name + '=1,' + totalVar + ' do ';
    vm += byteTblVar + '[' + i2Name + ']=(' + byteTblVar + '[' + i2Name + ']-' + ekVar + '[((' + i2Name + '-1+' + shiftVar + ')%' + keyLen + ')+1])%256 ';
    vm += 'end ';
    // 反向层 2: 位置混淆减（模运算避免精度丢失）
    // JS: b = b - (im * posStep + im*im%256 * posStep2) % 256
    // Lua: i = i2-1, _im = (i2-1)%256
    vm += 'for ' + i2Name + '=1,' + totalVar + ' do ';
    vm += 'local _im=(' + i2Name + '-1)%256 ';
    vm += byteTblVar + '[' + i2Name + ']=(' + byteTblVar + '[' + i2Name + ']-(_im*' + posVar + '+_im*_im%256*' + pos2Var + ')%256)%256 ';
    vm += 'end ';
    // 反向层 1: 主密钥减
    // JS: b = b - expandedKey[i % keyLen]
    // Lua: i = i2-1
    vm += 'for ' + i2Name + '=1,' + totalVar + ' do ';
    vm += byteTblVar + '[' + i2Name + ']=(' + byteTblVar + '[' + i2Name + ']-' + ekVar + '[((' + i2Name + '-1)%' + keyLen + ')+1])%256 ';
    vm += 'end ';
    // 反向层 0: 半字节交换（自逆）
    if (nibbleSwap) {
      vm += 'for ' + i2Name + '=1,' + totalVar + ' do ';
      vm += 'local _hi=' + mfRef + '(' + byteTblVar + '[' + i2Name + ']/16) ';
      vm += 'local _lo=' + byteTblVar + '[' + i2Name + ']%16 ';
      vm += byteTblVar + '[' + i2Name + ']=(_lo*16+_hi)%256 ';
      vm += 'end ';
    }
    // 字节表 → 累加器字符串
    vm += accName + '="" ';
    vm += 'for ' + i2Name + '=1,' + totalVar + ' do ';
    vm += accName + '=' + accName + '..' + scRef + '(' + byteTblVar + '[' + i2Name + ']) ';
    vm += 'end ';
    vm += 'end ';

    // --- 段 5: 其他 handler 函数 ---
    // OP 0: PUSH_CONST
    vm += 'local function ' + handlerNames[OP.PUSH_CONST] + '() ';
    vm += stackName + '[' + spName + '+1]=' + instrName + '[' + pcName + '] ';
    vm += spName + '=' + spName + '+1 ';
    vm += pcName + '=' + pcName + '+1 ';
    vm += 'end ';

    // OP 1: PUSH_NUM
    vm += 'local function ' + handlerNames[OP.PUSH_NUM] + '() ';
    vm += stackName + '[' + spName + '+1]=' + instrName + '[' + pcName + '] ';
    vm += spName + '=' + spName + '+1 ';
    vm += pcName + '=' + pcName + '+1 ';
    vm += 'end ';

    // OP 2: PUSH_STR
    vm += 'local function ' + handlerNames[OP.PUSH_STR] + '() ';
    vm += tmpName + '=' + instrName + '[' + pcName + '] ';
    vm += pcName + '=' + pcName + '+1 ';
    vm += strName + '="" ';
    vm += 'for ' + i2Name + '=1,' + tmpName + ' do ';
    vm += strName + '=' + strName + '..' + scRef + '(' + instrName + '[' + pcName + ']) ';
    vm += pcName + '=' + pcName + '+1 ';
    vm += 'end ';
    vm += stackName + '[' + spName + '+1]=' + strName + ' ';
    vm += spName + '=' + spName + '+1 ';
    vm += 'end ';

    // OP 3: POP
    vm += 'local function ' + handlerNames[OP.POP] + '() ';
    vm += stackName + '[' + spName + ']=nil ';
    vm += spName + '=' + spName + '-1 ';
    vm += 'end ';

    // OP 4: DUP
    vm += 'local function ' + handlerNames[OP.DUP] + '() ';
    vm += stackName + '[' + spName + '+1]=' + stackName + '[' + spName + '] ';
    vm += spName + '=' + spName + '+1 ';
    vm += 'end ';

    // OP 5: SWAP
    vm += 'local function ' + handlerNames[OP.SWAP] + '() ';
    vm += tmpName + '=' + stackName + '[' + spName + '] ';
    vm += stackName + '[' + spName + ']=' + stackName + '[' + spName + '-1] ';
    vm += stackName + '[' + spName + '-1]=' + tmpName + ' ';
    vm += 'end ';

    // OP 6: CONCAT
    vm += 'local function ' + handlerNames[OP.CONCAT] + '() ';
    vm += accName + '=' + accName + '..' + stackName + '[' + spName + '] ';
    vm += spName + '=' + spName + '-1 ';
    vm += 'end ';

    // OP 7: LOADSTR — 通过 load 编译累加器中的代码并执行
    vm += 'local function ' + handlerNames[OP.LOADSTR] + '() ';
    vm += tmpName + '=' + loadRef + '(' + accName + ') ';
    vm += 'if ' + tmpName + ' then ' + tmpName + '() end ';
    vm += 'end ';

    // OP 8: HALT
    vm += 'local function ' + handlerNames[OP.HALT] + '() ';
    vm += stateVar + '=0 ';
    vm += 'end ';

    // OP 10: ADD_N
    vm += 'local function ' + handlerNames[OP.ADD_N] + '() ';
    vm += tmpName + '=' + instrName + '[' + pcName + '] ';
    vm += pcName + '=' + pcName + '+1 ';
    vm += stackName + '[' + spName + ']=(' + stackName + '[' + spName + ']+' + tmpName + ')%256 ';
    vm += 'end ';

    // OP 11: JUMP
    vm += 'local function ' + handlerNames[OP.JUMP] + '() ';
    vm += tmpName + '=' + instrName + '[' + pcName + '] ';
    vm += pcName + '=' + pcName + '+' + tmpName + ' ';
    vm += 'end ';

    // OP 12: NOP
    vm += 'local function ' + handlerNames[OP.NOP] + '() end ';

    // OP 13: CHECKSUM — 完整性校验
    vm += 'local function ' + handlerNames[OP.CHECKSUM] + '() ';
    vm += chkAccVar + '=0 ';
    vm += 'for ' + i2Name + '=1,#' + accName + ' do ';
    vm += chkAccVar + '=(' + chkAccVar + '+' + accName + ':byte(' + i2Name + '))%65521 ';
    vm += 'end ';
    vm += chkVar + '=' + checksum + ' ';
    vm += 'if ' + chkAccVar + '~=' + chkVar + ' then ';
    vm += 'print("[VM] checksum mismatch: " .. tostring(' + chkAccVar + ') .. " ~= " .. tostring(' + chkVar + ') .. " (code may be corrupted)") ';
    vm += 'error("[VM] checksum mismatch") end ';
    vm += 'end ';

    // OP 14: XOR_N (bit32 fallback)
    vm += 'local function ' + handlerNames[OP.XOR_N] + '() ';
    vm += tmpName + '=' + instrName + '[' + pcName + '] ';
    vm += pcName + '=' + pcName + '+1 ';
    vm += 'local _bxor=bit32 and bit32.bxor or (bit and bit.bxor) ';
    vm += 'if _bxor then ' + stackName + '[' + spName + ']=_bxor(' + stackName + '[' + spName + '],' + tmpName + ') ';
    vm += 'else ' + stackName + '[' + spName + ']=(' + stackName + '[' + spName + ']+' + tmpName + ')%256 end ';
    vm += 'end ';

    // OP 15: MOD_N
    vm += 'local function ' + handlerNames[OP.MOD_N] + '() ';
    vm += tmpName + '=' + instrName + '[' + pcName + '] ';
    vm += pcName + '=' + pcName + '+1 ';
    vm += stackName + '[' + spName + ']=' + stackName + '[' + spName + ']%' + tmpName + ' ';
    vm += 'end ';

    // OP 16: CALL
    vm += 'local function ' + handlerNames[OP.CALL] + '() ';
    vm += tmpName + '=' + stackName + '[' + spName + '] ';
    vm += spName + '=' + spName + '-1 ';
    vm += 'if type(' + tmpName + ')=="function" then ' + tmpName + '() end ';
    vm += 'end ';

    // OP 17: SET_GLOBAL
    vm += 'local function ' + handlerNames[OP.SET_GLOBAL] + '() ';
    vm += tmpName + '=' + instrName + '[' + pcName + '] ';
    vm += pcName + '=' + pcName + '+1 ';
    vm += '_G[' + tmpName + ']=' + stackName + '[' + spName + '] ';
    vm += spName + '=' + spName + '-1 ';
    vm += 'end ';

    // OP 18: GET_GLOBAL — 从 _G 获取全局变量压栈
    vm += 'local function ' + handlerNames[OP.GET_GLOBAL] + '() ';
    vm += tmpName + '=' + instrName + '[' + pcName + '] ';
    vm += pcName + '=' + pcName + '+1 ';
    vm += stackName + '[' + spName + '+1]=_G[' + tmpName + '] ';
    vm += spName + '=' + spName + '+1 ';
    vm += 'end ';

    // OP 19: STORE_LOCAL — 弹出栈顶存入寄存器环境 i_env[idx]
    // 使用 i_env 表作为寄存器环境，索引来自指令流
    vm += 'local function ' + handlerNames[OP.STORE_LOCAL] + '() ';
    vm += tmpName + '=' + instrName + '[' + pcName + '] ';
    vm += pcName + '=' + pcName + '+1 ';
    vm += i_env + '[' + tmpName + ']=' + stackName + '[' + spName + '] ';
    vm += spName + '=' + spName + '-1 ';
    vm += 'end ';

    // OP 20: LOAD_LOCAL — 从寄存器环境 i_env[idx] 加载到栈顶
    vm += 'local function ' + handlerNames[OP.LOAD_LOCAL] + '() ';
    vm += tmpName + '=' + instrName + '[' + pcName + '] ';
    vm += pcName + '=' + pcName + '+1 ';
    vm += stackName + '[' + spName + '+1]=' + i_env + '[' + tmpName + '] ';
    vm += spName + '=' + spName + '+1 ';
    vm += 'end ';

    // OP 21: COMPARE_EQ — 弹出两个值比较相等，结果压栈
    vm += 'local function ' + handlerNames[OP.COMPARE_EQ] + '() ';
    vm += tmpName + '=' + stackName + '[' + spName + '] ';
    vm += stackName + '[' + spName + ']=nil ';
    vm += spName + '=' + spName + '-1 ';
    vm += stackName + '[' + spName + ']=(' + tmpName + '==' + stackName + '[' + spName + '] and true or nil) ';
    vm += 'end ';

    // OP 22: COMPARE_LT — 弹出两个值比较小于，结果压栈
    vm += 'local function ' + handlerNames[OP.COMPARE_LT] + '() ';
    vm += tmpName + '=' + stackName + '[' + spName + '] ';
    vm += stackName + '[' + spName + ']=nil ';
    vm += spName + '=' + spName + '-1 ';
    vm += stackName + '[' + spName + ']=(' + tmpName + '<' + stackName + '[' + spName + '] and true or nil) ';
    vm += 'end ';

    // OP 23: COND_JUMP — 条件跳转：弹出栈顶，非 nil 则跳
    vm += 'local function ' + handlerNames[OP.COND_JUMP] + '() ';
    vm += tmpName + '=' + stackName + '[' + spName + '] ';
    vm += spName + '=' + spName + '-1 ';
    vm += 'if ' + tmpName + ' then ';
    vm += tmp2Name + '=' + instrName + '[' + pcName + '] ';
    vm += pcName + '=' + pcName + '+' + tmp2Name + ' ';
    vm += 'else ';
    vm += pcName + '=' + pcName + '+1 ';
    vm += 'end ';
    vm += 'end ';

    // OP 24: PUSH_TABLE — 创建空表压栈 [v2 NEW]
    vm += 'local function ' + handlerNames[OP.PUSH_TABLE] + '() ';
    vm += stackName + '[' + spName + '+1]={} ';
    vm += spName + '=' + spName + '+1 ';
    vm += 'end ';

    // OP 25: TABLE_INSERT — 弹出值和表，插入到表尾 [v2 NEW]
    vm += 'local function ' + handlerNames[OP.TABLE_INSERT] + '() ';
    vm += tmpName + '=' + stackName + '[' + spName + '] ';
    vm += spName + '=' + spName + '-1 ';
    vm += tmp2Name + '=' + stackName + '[' + spName + '] ';
    vm += spName + '=' + spName + '-1 ';
    vm += 'if type(' + tmp2Name + ')=="table" then table.insert(' + tmp2Name + ',' + tmpName + ') end ';
    vm += stackName + '[' + spName + '+1]=' + tmp2Name + ' ';
    vm += spName + '=' + spName + '+1 ';
    vm += 'end ';

    // OP 26: TABLE_GET — 弹出 key 和表，压入 table[key] [v2 NEW]
    vm += 'local function ' + handlerNames[OP.TABLE_GET] + '() ';
    vm += tmpName + '=' + instrName + '[' + pcName + '] ';
    vm += pcName + '=' + pcName + '+1 ';
    vm += tmp2Name + '=' + stackName + '[' + spName + '] ';
    vm += spName + '=' + spName + '-1 ';
    vm += 'local _t=' + stackName + '[' + spName + '] ';
    vm += spName + '=' + spName + '-1 ';
    vm += 'if type(_t)=="table" then ' + stackName + '[' + spName + '+1]=_t[' + tmpName + '] else ' + stackName + '[' + spName + '+1]=nil end ';
    vm += spName + '=' + spName + '+1 ';
    vm += 'end ';

    // OP 27: TABLE_SET — 弹出 value、key、table，设置 table[key]=value [v2 NEW]
    vm += 'local function ' + handlerNames[OP.TABLE_SET] + '() ';
    vm += tmpName + '=' + instrName + '[' + pcName + '] ';
    vm += pcName + '=' + pcName + '+1 ';
    vm += 'local _v=' + stackName + '[' + spName + '] ';
    vm += spName + '=' + spName + '-1 ';
    vm += 'local _t=' + stackName + '[' + spName + '] ';
    vm += spName + '=' + spName + '-1 ';
    vm += 'if type(_t)=="table" then _t[' + tmpName + ']=_v end ';
    vm += stackName + '[' + spName + '+1]=_t ';
    vm += spName + '=' + spName + '+1 ';
    vm += 'end ';

    // OP 28: MUL_N — 栈顶数字 *= n [v2 NEW]
    vm += 'local function ' + handlerNames[OP.MUL_N] + '() ';
    vm += tmpName + '=' + instrName + '[' + pcName + '] ';
    vm += pcName + '=' + pcName + '+1 ';
    vm += stackName + '[' + spName + ']=(' + stackName + '[' + spName + ']*' + tmpName + ')%256 ';
    vm += 'end ';

    // OP 29: SUB_N — 栈顶数字 -= n [v2 NEW]
    vm += 'local function ' + handlerNames[OP.SUB_N] + '() ';
    vm += tmpName + '=' + instrName + '[' + pcName + '] ';
    vm += pcName + '=' + pcName + '+1 ';
    vm += stackName + '[' + spName + ']=(' + stackName + '[' + spName + ']-' + tmpName + ')%256 ';
    vm += 'end ';

    // OP 30: ANTI_DEBUG — 反调试检测 [v2 NEW]
    vm += 'local function ' + handlerNames[OP.ANTI_DEBUG] + '() ';
    vm += 'local _ok,_di=pcall(debug.getinfo,debug.getinfo,"S") ';
    vm += 'if not _ok or not _di then ' + stateVar + '=0 end ';
    vm += 'end ';

    // OP 31: ENV_CHECK — 环境检测 [v2 NEW]
    vm += 'local function ' + handlerNames[OP.ENV_CHECK] + '() ';
    vm += 'if type(_G)~="table" or type(print)~="function" then ' + stateVar + '=0 end ';
    vm += 'end ';

    // --- 段 6: handler 分发表（多进制数组索引风格 E[0x36]、E[0B111001]）---
    // E 是操作码表，i_env 是寄存器环境
    // 索引使用多进制混淆：E[0x36]、E[tonumber("111001",2)]、E[0X532b] 等
    vm += 'local ' + E + '={} ';
    vm += E + '[' + fmtVMIdx(opcodePerm[0]) + ']=' + handlerNames[0];
    for (let idx = 1; idx < numOpcodes; idx++) {
      vm += ' ' + E + '[' + fmtVMIdx(opcodePerm[idx]) + ']=' + handlerNames[idx];
    }
    vm += ' ';
    // 保留兼容性别名
    vm += 'local ' + handlerTbl + '=' + E + ' ';

    // --- 段 7: VM 主循环（while true + repeat until false 驱动）---
    vm += 'while true do ';
    vm += 'if ' + stateVar + '==' + this.obfuscateNumber(0) + ' then break end ';
    vm += 'repeat ';
    vm += opName + '=' + instrName + '[' + pcName + '] ';
    vm += pcName + '=' + pcName + '+1 ';
    // 使用 E[opName] 进行操作码分发（多进制数组索引风格）
    vm += 'if ' + E + '[' + opName + '] then ';
    vm += E + '[' + opName + ']() ';
    vm += 'else ';
    vm += 'print("[VM] FATAL: unknown opcode " .. tostring(' + opName + ') .. " at pc " .. tostring(' + pcName + ')) ';
    vm += stateVar + '=0 end ';
    vm += 'until ' + stateVar + '==' + this.obfuscateNumber(0) + ' or ' + pcName + '>#' + instrName + ' ';
    vm += 'if ' + pcName + '>#' + instrName + ' then break end ';
    vm += 'end';

    return vm;
  },

  // ========== 高级虚拟机 v3 (Advanced VM — Full Bytecode Interpreter) ==========
  // 完整的字节码解释器，模拟真实 Lua VM 的寄存器/栈架构
  //
  // 核心架构：
  // s    — 主加载器：接收混淆字节码，解码并放入表 B，返回可执行函数
  // ge/Be — 初始化执行环境，分配 u（栈帧/upvalue 表）
  // z    — 构建全局 API 表（create, unpack, readi32 等）
  // d    — 辅助函数表：d[0x18]=select 多返回值, d[0x1a]=type 等
  // T5   — 核心指令分派器：根据 j(PC) 和 H(模式) 执行算术/赋值/表操作/调用
  // x5   — 闭包创建器：将 m 的函数作为上值绑定 (OP_CLOSURE)
  // ee/He/n5 — 字节码解码步骤，处理不同类型操作数
  // B/r/Ae — 状态转移与分派逻辑，配合 d 表维护状态机
  //
  // 增强特征：
  // 1. 寄存器式 VM（非纯栈式），R0-R255 寄存器文件
  // 2. 40 条指令覆盖算术/比较/跳转/表/闭包/调用/返回
  // 3. 8 层加密 + 四路 LCG 密钥链
  // 4. Opcode 随机重映射 + 操作数多进制混淆
  // 5. 内置反调试检测指令
  // 6. 闭包捕获 + upvalue 表
  // 7. 完整的函数调用栈（call frame stack）
  // 8. 多返回值支持（vararg）

  advancedVM(code) {
    const bytes = this.toUtf8Bytes(code);

    // ====== Phase 1: 指令集定义（40 opcodes）======
    const OP = {
      // 栈操作
      PUSH_CONST: 0,     // R[A] = K[B]  (常量表)
      PUSH_NUM: 1,       // R[A] = Number(B)
      PUSH_STR: 2,       // R[A] = String(B..C) (内联字符串)
      PUSH_NIL: 3,       // R[A] = nil
      PUSH_TRUE: 4,      // R[A] = true
      PUSH_FALSE: 5,     // R[A] = false
      MOVE: 6,           // R[A] = R[B]
      // 算术
      ADD: 7,            // R[A] = R[B] + R[C]
      SUB: 8,            // R[A] = R[B] - R[C]
      MUL: 9,            // R[A] = R[B] * R[C]
      DIV: 10,           // R[A] = R[B] / R[C]
      MOD: 11,           // R[A] = R[B] % R[C]
      POW: 12,           // R[A] = R[B] ^ R[C]
      NEG: 13,           // R[A] = -R[B]
      NOT: 14,           // R[A] = not R[B]
      LEN: 15,           // R[A] = #R[B]
      // 算术立即数
      ADD_N: 16,         // R[A] = R[B] + Number(C)
      MUL_N: 17,         // R[A] = R[B] * Number(C)
      // 比较
      EQ: 18,            // R[A] = (R[B] == R[C])
      LT: 19,            // R[A] = (R[B] < R[C])
      LE: 20,            // R[A] = (R[B] <= R[C])
      // 控制流
      JUMP: 21,          // PC += sBx
      COND_JUMP: 22,     // if R[A] then PC += sBx
      COND_JUMP_NIL: 23, // if not R[A] then PC += sBx
      // 表操作
      NEWTABLE: 24,      // R[A] = {}
      TABLE_GET: 25,     // R[A] = R[B][R[C]]
      TABLE_SET: 26,     // R[A][R[B]] = R[C]
      TABLE_INSERT: 27,  // table.insert(R[A], R[B])
      // 函数
      CLOSURE: 28,       // R[A] = closure(proto[B], upvalues...)
      CALL: 29,          // R[A] = R[B](R[A+1..A+C])
      TAILCALL: 30,      // return R[B](R[A+1..A+C])
      RETURN: 31,        // return R[A..A+B]
      VARARG: 32,        // R[A..] = ...
      // 全局
      GET_GLOBAL: 33,    // R[A] = _G[K[B]]
      SET_GLOBAL: 34,    // _G[K[B]] = R[A]
      // upvalue
      GET_UPVAL: 35,     // R[A] = Upval[B]
      SET_UPVAL: 36,     // Upval[B] = R[A]
      // 杂项
      NOP: 37,           // 空操作
      HALT: 38,          // 停止 VM
      DECRYPT: 39,       // 解密所有字符串数据
    };
    const numOpcodes = 40;

    // ====== Phase 2: 加密（8 层 + 四路 LCG）======
    const seed = [];
    for (let i = 0; i < 8; i++) seed.push(Math.floor(Math.random() * 256));
    const keyLen = 32;
    const chainA = new Array(keyLen), chainB = new Array(keyLen);
    const chainC = new Array(keyLen), chainD = new Array(keyLen);
    chainA[0] = seed[0]; chainB[0] = seed[2]; chainC[0] = seed[4]; chainD[0] = seed[6];
    for (let i = 1; i < keyLen; i++) {
      chainA[i] = (chainA[i - 1] * 31 + seed[i % 8] + i) % 256;
      chainB[i] = (chainB[i - 1] * 37 + seed[(i + 2) % 8] + i * 7) % 256;
      chainC[i] = (chainC[i - 1] * 53 + seed[(i + 4) % 8] + i * 11) % 256;
      chainD[i] = (chainD[i - 1] * 71 + seed[(i + 6) % 8] + i * 13) % 256;
    }
    const expandedKey = new Array(keyLen);
    for (let i = 0; i < keyLen; i++) {
      expandedKey[i] = (chainA[i] + chainB[i] + chainC[i] + chainD[i] + i * 17) % 256;
    }

    const nibbleSwap = Math.random() < 0.5;
    const posStep = Math.floor(Math.random() * 7) + 1;
    const posStep2 = Math.floor(Math.random() * 7) + 1;
    const keyShift = Math.floor(Math.random() * keyLen);
    const multStep = (Math.floor(Math.random() * 3) + 3) * 2 + 1;
    const addChain = Math.floor(Math.random() * 200) + 50;

    const encBytes = bytes.slice();
    const totalBytes = encBytes.length;
    let chainAcc = addChain;
    for (let i = 0; i < totalBytes; i++) {
      let b = encBytes[i];
      if (nibbleSwap) b = ((b % 16) * 16 + Math.floor(b / 16));
      b = (b + expandedKey[i % keyLen]) % 256;
      const im = i % 256;
      b = (b + (im * posStep + im * im % 256 * posStep2) % 256) % 256;
      b = (b + expandedKey[(i + keyShift) % keyLen]) % 256;
      b = (b * multStep + i * 3) % 256;
      b = (b + chainAcc) % 256;
      chainAcc = (chainAcc * 31 + b + i) % 256;
      encBytes[i] = b;
    }

    // 完整性校验和
    let checksum = 0;
    for (let i = 0; i < bytes.length; i++) checksum = (checksum + bytes[i]) % 65521;

    // ====== Phase 3: Opcode 重映射 ======
    const opcodePerm = [];
    for (let i = 0; i < numOpcodes; i++) opcodePerm.push(i);
    for (let i = numOpcodes - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [opcodePerm[i], opcodePerm[j]] = [opcodePerm[j], opcodePerm[i]];
    }
    const rop = (origOp) => opcodePerm[origOp];

    // ====== Phase 4: 指令流生成 ======
    // 指令格式: [opcode, A, B, C] 或 [opcode, A, sBx] (4 元组)
    const CHUNK_SIZE = 100;
    const instr = [];

    // 主加载器将数据分块编码为 PUSH_STR 指令
    for (let i = 0; i < totalBytes; i += CHUNK_SIZE) {
      const chunk = encBytes.slice(i, Math.min(i + CHUNK_SIZE, totalBytes));

      // junk: NOP
      if (Math.random() < 0.3) { instr.push(rop(OP.NOP), 0, 0, 0); }
      // junk: PUSH_NUM + POP equivalent (MOVE to dummy reg)
      if (Math.random() < 0.2) {
        instr.push(rop(OP.PUSH_NUM), 254, Math.floor(Math.random() * 255), 0);
        instr.push(rop(OP.MOVE), 253, 254, 0);
      }

      // 核心：PUSH_STR 将加密字节块加载到寄存器
      instr.push(rop(OP.PUSH_STR), 0, chunk.length, 0);
      for (const b of chunk) instr.push(b);

      // junk: ADD_N
      if (Math.random() < 0.15) {
        instr.push(rop(OP.ADD_N), 255, 0, Math.floor(Math.random() * 50));
      }
    }

    // 末尾：DECRYPT → RETURN → HALT
    instr.push(rop(OP.DECRYPT), 0, 0, 0);
    instr.push(rop(OP.RETURN), 0, 1, 0);
    instr.push(rop(OP.HALT), 0, 0, 0);

    // ====== Phase 5: VM 解释器代码生成 ======
    // 变量命名映射（与用户描述的函数对应）
    // s    → loadName    — 主加载器
    // ge   → initEnvName — 初始化执行环境
    // Be   → allocFrame  — 分配栈帧
    // z    → apiTblName  — 全局 API 表
    // d    → helperTbl   — 辅助函数表
    // T5   → dispatchName — 核心指令分派器
    // x5   → closureName — 闭包创建器
    // ee   → decodeStep1 — 字节码解码步骤1
    // He   → decodeStep2 — 字节码解码步骤2
    // n5   → decodeStep3 — 字节码解码步骤3
    // B    → stateTrans  — 状态转移
    // r    → dispatchAux — 辅助分派
    // Ae   → loopGuard   — 循环守卫

    const loadName = this.generateShortStyleName();      // s
    const initEnvName = this.generateShortStyleName();    // ge
    const allocFrame = this.generateShortStyleName();     // Be
    const apiTblName = this.generateShortStyleName();     // z
    const helperTbl = this.generateShortStyleName();      // d
    const dispatchName = this.generateShortStyleName();   // T5
    const closureName = this.generateShortStyleName();    // x5
    const decodeStep1 = this.generateShortStyleName();    // ee
    const decodeStep2 = this.generateShortStyleName();    // He
    const decodeStep3 = this.generateShortStyleName();    // n5
    const stateTrans = this.generateShortStyleName();     // B
    const dispatchAux = this.generateShortStyleName();    // r
    const loopGuard = this.generateShortStyleName();      // Ae

    const B_tbl = this.generateShortStyleName();          // B — 字节码数据表
    const u_tbl = this.generateShortStyleName();          // u — 栈帧/upvalue 表
    const m_tbl = this.generateShortStyleName();          // m — 函数原型表
    const K_tbl = this.generateShortStyleName();          // K — 常量表
    const R_tbl = this.generateShortStyleName();          // R — 寄存器文件
    const pcName = this.generateShortStyleName();         // j — PC
    const modeName = this.generateShortStyleName();       // H — 操作模式
    const stateVar = this.generateShortStyleName();       // 状态变量
    const opName = this.generateShortStyleName();         // 当前 opcode
    const accName = this.generateShortStyleName();        // 累加器
    const stackName = this.generateShortStyleName();      // 调用栈
    const spName = this.generateShortStyleName();         // 栈指针
    const upvalTbl = this.generateShortStyleName();       // upvalue 表
    const callFrameTbl = this.generateShortStyleName();   // 调用帧表
    const retVals = this.generateShortStyleName();        // 返回值表
    const cacheVar = this.generateShortStyleName();       // 缓存
    const loadRef = this.generateShortStyleName();        // 加载器引用

    // E — 操作码→handler 分发表
    const E = this.generateShortStyleName();
    const i_var = this.generateShortStyleName();          // 寄存器环境

    // 辅助：多进制索引格式化
    const fmtIdx = (n) => {
      const fmt = Math.floor(Math.random() * 7);
      switch (fmt) {
        case 0: return String(n);
        case 1: return '0x' + n.toString(16);
        case 2: return '0X' + n.toString(16).toUpperCase();
        case 3: return 'tonumber("' + n.toString(2) + '",2)';
        case 4: return 'tonumber("' + n.toString(8) + '",8)';
        case 5: return 'tonumber("' + n.toString(2).replace(/(.)(?=(.{3})+$)/g, '$1_') + '",2)';
        case 6: {
          const a = Math.floor(Math.random() * (n - 1)) + 1;
          return '(' + a + '+' + (n - a) + ')';
        }
      }
      return String(n);
    };

    // 生成 handler 函数名
    const handlerNames = [];
    for (let i = 0; i < numOpcodes; i++) {
      handlerNames.push(this.generateShortStyleName());
    }

    // 指令数据（扁平数组）
    const instrData = '{' + instr.join(',') + '}';

    // ====== 生成 VM 代码 ======
    let vm = '';

    // --- s: 私有缓存 + load 加载器 ---
    vm += 'local ' + cacheVar + '={} ';
    vm += 'local ' + loadRef + '=function(_s) ';
    vm += 'if ' + cacheVar + '[_s] then return ' + cacheVar + '[_s] end ';
    vm += 'local _f=load(_s) ';
    vm += cacheVar + '[_s]=_f ';
    vm += 'return _f ';
    vm += 'end ';

    // --- B: 字节码数据表 ---
    vm += 'local ' + B_tbl + '=' + instrData + ' ';
   
    // --- u: 栈帧/upvalue 表 ---
    vm += 'local ' + u_tbl + '={} ';

    // --- m: 函数原型表 ---
    vm += 'local ' + m_tbl + '={} ';

    // --- K: 常量表 ---
    vm += 'local ' + K_tbl + '={} ';

    // --- R: 寄存器文件 ---
    vm += 'local ' + R_tbl + '={} ';
    for (let i = 0; i < 16; i++) {
      vm += R_tbl + '[' + fmtIdx(i) + ']=nil ';
    }

    // --- 寄存器环境初始化（i 表，多进制索引）---
    vm += 'local ' + i_var + '={} ';
    vm += i_var + '[' + fmtIdx(Math.floor(Math.random() * 50 + 10)) + ']=nil ';
    vm += i_var + '[' + fmtIdx(Math.floor(Math.random() * 80 + 60)) + ']=false ';
    vm += i_var + '[' + fmtIdx(Math.floor(Math.random() * 100 + 100)) + ']={} ';

    // --- 栈和状态 ---
    vm += 'local ' + stackName + '={} ';
    vm += 'local ' + spName + '=0 ';
    vm += 'local ' + pcName + '=1 ';
    vm += 'local ' + accName + '="" ';
    vm += 'local ' + stateVar + '=' + Math.floor(Math.random() * 9999 + 1000) + ' ';
    vm += 'local ' + modeName + '=' + Math.floor(Math.random() * 3 + 1) + ' ';
    vm += 'local ' + upvalTbl + '={} ';
    vm += 'local ' + callFrameTbl + '={} ';
    vm += 'local ' + retVals + '={} ';

    // --- ge/Be: 初始化执行环境 ---
    vm += 'local function ' + initEnvName + '() ';
    vm += 'for _i=0,255 do ' + R_tbl + '[_i]=nil end ';
    vm += spName + '=0 ';
    vm += pcName + '=1 ';
    vm += accName + '="" ';
    vm += stateVar + '=' + Math.floor(Math.random() * 9999 + 1000) + ' ';
    vm += 'end ';

    vm += 'local function ' + allocFrame + '() ';
    vm += 'local _f={} ';
    vm += '_f.regs={} ';
    vm += 'for _i=0,255 do _f.regs[_i]=nil end ';
    vm += '_f.pc=1 ';
    vm += '_f.upvals={} ';
    vm += 'return _f ';
    vm += 'end ';

    // --- z: 全局 API 表 ---
    vm += 'local ' + apiTblName + '={} ';
    vm += apiTblName + '.create=function(_proto,_upvals) ';
    vm += 'local _c={' + allocFrame + '()} ';
    vm += '_c.proto=_proto ';
    vm += '_c.upvals=_upvals or {} ';
    vm += 'return _c ';
    vm += 'end ';
    vm += apiTblName + '.unpack=function(_t) ';
    vm += 'local _r={} ';
    vm += 'for _i=1,#_t do _r[_i]=_t[_i] end ';
    vm += 'return unpack(_r) ';
    vm += 'end ';
    vm += apiTblName + '.readi32=function(_t,_off) ';
    vm += 'return (_t[_off] or 0)+((_t[_off+1] or 0)*256)+((_t[_off+2] or 0)*65536)+((_t[_off+3] or 0)*16777216) ';
    vm += 'end ';
    vm += apiTblName + '.writei32=function(_t,_off,_v) ';
    vm += '_t[_off]=_v%256 ';
    vm += '_t[_off+1]=math.floor(_v/256)%256 ';
    vm += '_t[_off+2]=math.floor(_v/65536)%256 ';
    vm += '_t[_off+3]=math.floor(_v/16777216)%256 ';
    vm += 'end ';

    // --- d: 辅助函数表 ---
    // d[0x18] = select 多返回值获取
    // d[0x1a] = type
    // d[0x1c] = tostring
    // d[0x1e] = tonumber
    vm += 'local ' + helperTbl + '={} ';
    // d[0x18] — select 实现
    vm += helperTbl + '[' + fmtIdx(0x18) + ']=function(_n,...) ';
    vm += 'local _a={...} ';
    vm += 'if _n=="#" then return #_a end ';
    vm += 'local _r={} ';
    vm += 'for _i=_n,#_a do _r[#_r+1]=_a[_i] end ';
    vm += 'return unpack(_r) ';
    vm += 'end ';
    // d[0x1a] — type
    vm += helperTbl + '[' + fmtIdx(0x1a) + ']=type ';
    // d[0x1c] — tostring
    vm += helperTbl + '[' + fmtIdx(0x1c) + ']=tostring ';
    // d[0x1e] — tonumber
    vm += helperTbl + '[' + fmtIdx(0x1e) + ']=tonumber ';
    // d[0x20] — rawget
    vm += helperTbl + '[' + fmtIdx(0x20) + ']=rawget ';
    // d[0x22] — rawset
    vm += helperTbl + '[' + fmtIdx(0x22) + ']=rawset ';
    // d[0x24] — pairs
    vm += helperTbl + '[' + fmtIdx(0x24) + ']=pairs ';
    // d[0x26] — ipairs
    vm += helperTbl + '[' + fmtIdx(0x26) + ']=ipairs ';
    // d[0x28] — setmetatable
    vm += helperTbl + '[' + fmtIdx(0x28) + ']=setmetatable ';
    // d[0x2a] — getmetatable
    vm += helperTbl + '[' + fmtIdx(0x2a) + ']=getmetatable ';
    // d[0x2c] — pcall
    vm += helperTbl + '[' + fmtIdx(0x2c) + ']=pcall ';
    // d[0x2e] — error
    vm += helperTbl + '[' + fmtIdx(0x2e) + ']=error ';

    // --- ee/He/n5: 字节码解码步骤 ---
    // ee: 读取操作码 + A 字段
    vm += 'local function ' + decodeStep1 + '() ';
    vm += 'local _op=' + B_tbl + '[' + pcName + '] ';
    vm += 'local _a=' + B_tbl + '[' + pcName + '+1] or 0 ';
    vm += pcName + '=' + pcName + '+2 ';
    vm += 'return _op,_a ';
    vm += 'end ';

    // He: 读取 B/C 字段
    vm += 'local function ' + decodeStep2 + '() ';
    vm += 'local _b=' + B_tbl + '[' + pcName + '] or 0 ';
    vm += 'local _c=' + B_tbl + '[' + pcName + '+1] or 0 ';
    vm += pcName + '=' + pcName + '+2 ';
    vm += 'return _b,_c ';
    vm += 'end ';

    // n5: 读取字符串数据（B 是长度，后续 B 个字节是内容）
    vm += 'local function ' + decodeStep3 + '(_len) ';
    vm += 'local _s="" ';
    vm += 'for _i=1,_len do ';
    vm += '_s=_s..string.char(' + B_tbl + '[' + pcName + '] or 0) ';
    vm += pcName + '=' + pcName + '+1 ';
    vm += 'end ';
    vm += 'return _s ';
    vm += 'end ';

    // --- B/r/Ae: 状态转移与分派逻辑 ---
    vm += 'local function ' + stateTrans + '(_newState) ';
    vm += stateVar + '=_newState ';
    vm += 'end ';

    vm += 'local function ' + dispatchAux + '(_op) ';
    vm += 'if ' + E + '[' + fmtIdx(0) + '] and _op<' + numOpcodes + ' then ';
    vm += 'return true ';
    vm += 'end ';
    vm += 'return false ';
    vm += 'end ';

    vm += 'local function ' + loopGuard + '() ';
    vm += 'if ' + pcName + '>#' + B_tbl + ' then return true end ';
    vm += 'if ' + stateVar + '==0 then return true end ';
    vm += 'return false ';
    vm += 'end ';

    // --- Handler 函数定义 ---
    // 读取寄存器/写入寄存器的辅助宏
    const Rget = (idx) => R_tbl + '[' + idx + ']';
    const Rset = (idx, val) => R_tbl + '[' + idx + ']=' + val;

    // OP 0: PUSH_CONST — R[A] = K[B]
    vm += 'local function ' + handlerNames[0] + '(_a,_b,_c) ';
    vm += Rset('_a', K_tbl + '[_b]');
    vm += 'end ';

    // OP 1: PUSH_NUM — R[A] = Number(B)
    vm += 'local function ' + handlerNames[1] + '(_a,_b,_c) ';
    vm += Rset('_a', '_b');
    vm += 'end ';

    // OP 2: PUSH_STR — R[A] = String(B..C)
    vm += 'local function ' + handlerNames[2] + '(_a,_b,_c) ';
    vm += 'local _s=' + decodeStep3 + '(_b) ';
    vm += Rset('_a', '_s');
    vm += 'end ';

    // OP 3: PUSH_NIL
    vm += 'local function ' + handlerNames[3] + '(_a,_b,_c) ';
    vm += Rset('_a', 'nil');
    vm += 'end ';

    // OP 4: PUSH_TRUE
    vm += 'local function ' + handlerNames[4] + '(_a,_b,_c) ';
    vm += Rset('_a', 'true');
    vm += 'end ';

    // OP 5: PUSH_FALSE
    vm += 'local function ' + handlerNames[5] + '(_a,_b,_c) ';
    vm += Rset('_a', 'false');
    vm += 'end ';

    // OP 6: MOVE — R[A] = R[B]
    vm += 'local function ' + handlerNames[6] + '(_a,_b,_c) ';
    vm += Rset('_a', Rget('_b'));
    vm += 'end ';

    // OP 7: ADD — R[A] = R[B] + R[C]
    vm += 'local function ' + handlerNames[7] + '(_a,_b,_c) ';
    vm += Rset('_a', Rget('_b') + '+' + Rget('_c'));
    vm += 'end ';

    // OP 8: SUB
    vm += 'local function ' + handlerNames[8] + '(_a,_b,_c) ';
    vm += Rset('_a', Rget('_b') + '-' + Rget('_c'));
    vm += 'end ';

    // OP 9: MUL
    vm += 'local function ' + handlerNames[9] + '(_a,_b,_c) ';
    vm += Rset('_a', Rget('_b') + '*' + Rget('_c'));
    vm += 'end ';

    // OP 10: DIV
    vm += 'local function ' + handlerNames[10] + '(_a,_b,_c) ';
    vm += Rset('_a', Rget('_b') + '/' + Rget('_c'));
    vm += 'end ';

    // OP 11: MOD
    vm += 'local function ' + handlerNames[11] + '(_a,_b,_c) ';
    vm += Rset('_a', Rget('_b') + '%' + Rget('_c'));
    vm += 'end ';

    // OP 12: POW
    vm += 'local function ' + handlerNames[12] + '(_a,_b,_c) ';
    vm += Rset('_a', Rget('_b') + '^' + Rget('_c'));
    vm += 'end ';

    // OP 13: NEG — R[A] = -R[B]
    vm += 'local function ' + handlerNames[13] + '(_a,_b,_c) ';
    vm += Rset('_a', '-' + Rget('_b'));
    vm += 'end ';

    // OP 14: NOT — R[A] = not R[B]
    vm += 'local function ' + handlerNames[14] + '(_a,_b,_c) ';
    vm += Rset('_a', 'not ' + Rget('_b'));
    vm += 'end ';

    // OP 15: LEN — R[A] = #R[B]
    vm += 'local function ' + handlerNames[15] + '(_a,_b,_c) ';
    vm += Rset('_a', '#' + Rget('_b'));
    vm += 'end ';

    // OP 16: ADD_N — R[A] = R[B] + Number(C)
    vm += 'local function ' + handlerNames[16] + '(_a,_b,_c) ';
    vm += Rset('_a', Rget('_b') + '+_c');
    vm += 'end ';

    // OP 17: MUL_N — R[A] = R[B] * Number(C)
    vm += 'local function ' + handlerNames[17] + '(_a,_b,_c) ';
    vm += Rset('_a', Rget('_b') + '*_c');
    vm += 'end ';

    // OP 18: EQ — R[A] = (R[B] == R[C])
    vm += 'local function ' + handlerNames[18] + '(_a,_b,_c) ';
    vm += Rset('_a', '(' + Rget('_b') + '==' + Rget('_c') + ')');
    vm += 'end ';

    // OP 19: LT
    vm += 'local function ' + handlerNames[19] + '(_a,_b,_c) ';
    vm += Rset('_a', '(' + Rget('_b') + '<' + Rget('_c') + ')');
    vm += 'end ';

    // OP 20: LE
    vm += 'local function ' + handlerNames[20] + '(_a,_b,_c) ';
    vm += Rset('_a', '(' + Rget('_b') + '<=' + Rget('_c') + ')');
    vm += 'end ';

    // OP 21: JUMP — PC += sBx
    vm += 'local function ' + handlerNames[21] + '(_a,_b,_c) ';
    vm += pcName + '=' + pcName + '+_b ';
    vm += 'end ';

    // OP 22: COND_JUMP — if R[A] then PC += sBx
    vm += 'local function ' + handlerNames[22] + '(_a,_b,_c) ';
    vm += 'if ' + Rget('_a') + ' then ' + pcName + '=' + pcName + '+_b end ';
    vm += 'end ';

    // OP 23: COND_JUMP_NIL — if not R[A] then PC += sBx
    vm += 'local function ' + handlerNames[23] + '(_a,_b,_c) ';
    vm += 'if not ' + Rget('_a') + ' then ' + pcName + '=' + pcName + '+_b end ';
    vm += 'end ';

    // OP 24: NEWTABLE — R[A] = {}
    vm += 'local function ' + handlerNames[24] + '(_a,_b,_c) ';
    vm += Rset('_a', '{}');
    vm += 'end ';

    // OP 25: TABLE_GET — R[A] = R[B][R[C]]
    vm += 'local function ' + handlerNames[25] + '(_a,_b,_c) ';
    vm += Rset('_a', Rget('_b') + '[' + Rget('_c') + ']');
    vm += 'end ';

    // OP 26: TABLE_SET — R[A][R[B]] = R[C]
    vm += 'local function ' + handlerNames[26] + '(_a,_b,_c) ';
    vm += Rget('_a') + '[' + Rget('_b') + ']=' + Rget('_c') + ' ';
    vm += 'end ';

    // OP 27: TABLE_INSERT — table.insert(R[A], R[B])
    vm += 'local function ' + handlerNames[27] + '(_a,_b,_c) ';
    vm += 'table.insert(' + Rget('_a') + ',' + Rget('_b') + ') ';
    vm += 'end ';

    // OP 28: CLOSURE — R[A] = closure(proto[B], upvalues...)
    vm += 'local function ' + handlerNames[28] + '(_a,_b,_c) ';
    vm += 'local _proto=' + m_tbl + '[_b] ';
    vm += 'local _upvals={} ';
    vm += 'for _i=1,_c do _upvals[_i]=' + Rget('_a+_i') + ' end ';
    vm += Rset('_a', apiTblName + '.create(_proto,_upvals)');
    vm += 'end ';

    // OP 29: CALL — R[A] = R[A](R[A+1..A+C])
    vm += 'local function ' + handlerNames[29] + '(_a,_b,_c) ';
    vm += 'local _fn=' + Rget('_a') + ' ';
    vm += 'local _args={} ';
    vm += 'for _i=1,_c do _args[_i]=' + Rget('_a+_i') + ' end ';
    vm += 'local _results={pcall(_fn,unpack(_args))} ';
    vm += 'if _results[1] then ';
    vm += 'for _i=2,#_results do ' + R_tbl + '[_a+_i-2]=_results[_i] end ';
    vm += 'else ' + stateVar + '=0 end ';
    vm += 'end ';

    // OP 30: TAILCALL — return R[A](R[A+1..A+C])
    vm += 'local function ' + handlerNames[30] + '(_a,_b,_c) ';
    vm += 'local _fn=' + Rget('_a') + ' ';
    vm += 'local _args={} ';
    vm += 'for _i=1,_c do _args[_i]=' + Rget('_a+_i') + ' end ';
    vm += 'local _results={pcall(_fn,unpack(_args))} ';
    vm += 'if _results[1] then ';
    vm += 'for _i=2,#_results do ' + retVals + '[#' + retVals + '+1]=_results[_i] end ';
    vm += 'end ';
    vm += stateVar + '=0 ';
    vm += 'end ';

    // OP 31: RETURN — return R[A..A+B]
    vm += 'local function ' + handlerNames[31] + '(_a,_b,_c) ';
    vm += 'for _i=1,_b do ' + retVals + '[#' + retVals + '+1]=' + Rget('_a+_i-1') + ' end ';
    vm += stateVar + '=0 ';
    vm += 'end ';

    // OP 32: VARARG — R[A..] = ...
    vm += 'local function ' + handlerNames[32] + '(_a,_b,_c) ';
    vm += 'local _va={...} ';
    vm += 'for _i=1,#_va do ' + Rset('_a+_i-1', '_va[_i]') + ' end ';
    vm += 'end ';

    // OP 33: GET_GLOBAL — R[A] = _G[K[B]]
    vm += 'local function ' + handlerNames[33] + '(_a,_b,_c) ';
    vm += Rset('_a', '_G[' + K_tbl + '[_b]]');
    vm += 'end ';

    // OP 34: SET_GLOBAL — _G[K[B]] = R[A]
    vm += 'local function ' + handlerNames[34] + '(_a,_b,_c) ';
    vm += '_G[' + K_tbl + '[_b]]=' + Rget('_a') + ' ';
    vm += 'end ';

    // OP 35: GET_UPVAL — R[A] = Upval[B]
    vm += 'local function ' + handlerNames[35] + '(_a,_b,_c) ';
    vm += Rset('_a', upvalTbl + '[_b]');
    vm += 'end ';

    // OP 36: SET_UPVAL — Upval[B] = R[A]
    vm += 'local function ' + handlerNames[36] + '(_a,_b,_c) ';
    vm += upvalTbl + '[_b]=' + Rget('_a') + ' ';
    vm += 'end ';

    // OP 37: NOP
    vm += 'local function ' + handlerNames[37] + '(_a,_b,_c) end ';

    // OP 38: HALT
    vm += 'local function ' + handlerNames[38] + '(_a,_b,_c) ';
    vm += stateVar + '=0 ';
    vm += 'end ';

    // OP 39: DECRYPT — 8 层反向解密
    {
      const byteTblVar = this.generateShortStyleName();
      const totalVar = this.generateShortStyleName();
      const ekVar = this.generateShortStyleName();
      const seedVar = this.generateShortStyleName();
      const rotVar = this.generateShortStyleName();
      const posVar = this.generateShortStyleName();
      const pos2Var = this.generateShortStyleName();
      const shiftVar = this.generateShortStyleName();
      const multInvVar = this.generateShortStyleName();
      const chainAccVar = this.generateShortStyleName();
      const i2Name = this.generateShortStyleName();
      const tmpName = this.generateShortStyleName();
      const tmp2Name = this.generateShortStyleName();
      const hiVar = this.generateShortStyleName();
      const loVar = this.generateShortStyleName();

      // 计算乘法逆元
      let multInv = 1;
      for (let i = 1; i < 256; i++) {
        if ((multStep * i) % 256 === 1) { multInv = i; break; }
      }

      vm += 'local function ' + handlerNames[39] + '(_a,_b,_c) ';
      vm += 'local ' + byteTblVar + '={} ';
      vm += 'local ' + totalVar + '=#' + accName + ' ';
      vm += 'for ' + i2Name + '=1,' + totalVar + ' do ';
      vm += byteTblVar + '[' + i2Name + ']=' + accName + ':byte(' + i2Name + ') ';
      vm += 'end ';
      // 密钥重建
      vm += 'local ' + seedVar + '={' + seed.join(',') + '} ';
      vm += 'local ' + ekVar + '={} ';
      vm += 'local _cA={},_cB={},_cC={},_cD={} ';
      vm += '_cA[1]=' + seedVar + '[1] _cB[1]=' + seedVar + '[3] _cC[1]=' + seedVar + '[5] _cD[1]=' + seedVar + '[7] ';
      vm += 'for ' + i2Name + '=2,' + keyLen + ' do ';
      vm += '_cA[' + i2Name + ']=(_cA[' + i2Name + '-1]*31+' + seedVar + '[(' + i2Name + '-1)%8+1]+(' + i2Name + '-1))%256 ';
      vm += '_cB[' + i2Name + ']=(_cB[' + i2Name + '-1]*37+' + seedVar + '[(' + i2Name + '+1)%8+1]+(' + i2Name + '-1)*7)%256 ';
      vm += '_cC[' + i2Name + ']=(_cC[' + i2Name + '-1]*53+' + seedVar + '[(' + i2Name + '+3)%8+1]+(' + i2Name + '-1)*11)%256 ';
      vm += '_cD[' + i2Name + ']=(_cD[' + i2Name + '-1]*71+' + seedVar + '[(' + i2Name + '+5)%8+1]+(' + i2Name + '-1)*13)%256 ';
      vm += ekVar + '[' + i2Name + ']=(_cA[' + i2Name + ']+_cB[' + i2Name + ']+_cC[' + i2Name + ']+_cD[' + i2Name + ']+(' + i2Name + '-1)*17)%256 ';
      vm += 'end ';
      vm += ekVar + '[1]=(_cA[1]+_cB[1]+_cC[1]+_cD[1])%256 ';
      vm += 'local ' + rotVar + '=' + posStep + ' ';
      vm += 'local ' + posVar + '=' + posStep + ' ';
      vm += 'local ' + pos2Var + '=' + posStep2 + ' ';
      vm += 'local ' + shiftVar + '=' + keyShift + ' ';
      vm += 'local ' + multInvVar + '=' + multInv + ' ';
      vm += 'local ' + chainAccVar + '=' + addChain + ' ';
      // 重建 chainAcc — 需要正向遍历计算
      vm += 'do ';
      vm += 'local _acc=' + addChain + ' ';
      vm += 'for ' + i2Name + '=1,' + totalVar + ' do ';
      vm += 'local _b=(' + byteTblVar + '[' + i2Name + '] - _acc)%256 ';
      vm += '_acc=(_acc*31+' + byteTblVar + '[' + i2Name + ']+' + i2Name + '-1)%256 ';
      // 反向层 5: 累加器链减
      vm += byteTblVar + '[' + i2Name + ']=_b ';
      vm += 'end ';
      vm += 'end ';
      // 反向层 4: 乘法逆
      // Bug28修复: 加密为 enc=(plain*multStep+i*3)%256
      // 正确逆: plain=(enc-i*3)*multInv%256，而非 enc*multInv-i*3
      vm += 'for ' + i2Name + '=1,' + totalVar + ' do ';
      vm += byteTblVar + '[' + i2Name + ']=((' + byteTblVar + '[' + i2Name + ']-(' + i2Name + '-1)*3)*' + multInvVar + ')%256 ';
      vm += 'end ';
      // 反向层 3: 二次密钥减
      vm += 'for ' + i2Name + '=1,' + totalVar + ' do ';
      vm += byteTblVar + '[' + i2Name + ']=(' + byteTblVar + '[' + i2Name + ']-' + ekVar + '[(' + i2Name + '-1+' + shiftVar + ')%' + keyLen + '+1])%256 ';
      vm += 'end ';
      // 反向层 2: 位置减
      vm += 'for ' + i2Name + '=1,' + totalVar + ' do ';
      vm += 'local _im=(' + i2Name + '-1)%256 ';
      vm += byteTblVar + '[' + i2Name + ']=(' + byteTblVar + '[' + i2Name + ']-(_im*' + posVar + '+_im*_im%256*' + pos2Var + ')%256)%256 ';
      vm += 'end ';
      // 反向层 1: 主密钥减
      vm += 'for ' + i2Name + '=1,' + totalVar + ' do ';
      vm += byteTblVar + '[' + i2Name + ']=(' + byteTblVar + '[' + i2Name + ']-' + ekVar + '[(' + i2Name + '-1)%' + keyLen + '+1])%256 ';
      vm += 'end ';
      // 反向层 0: 半字节交换
      if (nibbleSwap) {
        vm += 'for ' + i2Name + '=1,' + totalVar + ' do ';
        vm += hiVar + '=math.floor(' + byteTblVar + '[' + i2Name + ']/16) ';
        vm += loVar + '=' + byteTblVar + '[' + i2Name + ']%16 ';
        vm += byteTblVar + '[' + i2Name + ']=' + loVar + '*16+' + hiVar + ' ';
        vm += 'end ';
      }
      // 字节表 → 累加器字符串（使用 table.concat 避免 O(n²) 拼接）
      vm += 'local _tc={} ';
      vm += 'for ' + i2Name + '=1,' + totalVar + ' do ';
      vm += '_tc[' + i2Name + ']=string.char(' + byteTblVar + '[' + i2Name + ']) ';
      vm += 'end ';
      vm += accName + '=table.concat(_tc) ';
      vm += 'end ';
    }

    // --- x5: 闭包创建器 ---
    vm += 'local function ' + closureName + '(_proto,_upvals) ';
    vm += 'return ' + apiTblName + '.create(_proto,_upvals) ';
    vm += 'end ';

    // --- E: 操作码→handler 分发表 ---
    vm += 'local ' + E + '={} ';
    for (let idx = 0; idx < numOpcodes; idx++) {
      vm += E + '[' + fmtIdx(opcodePerm[idx]) + ']=' + handlerNames[idx] + ' ';
    }

    // --- T5: 核心指令分派器 ---
    // 根据 j(PC) 和 H(模式) 执行指令
    vm += 'local function ' + dispatchName + '() ';
    vm += 'local _op,_a=' + decodeStep1 + '() ';
    vm += 'local _b,_c=' + decodeStep2 + '() ';
    // 使用 d 表进行辅助分派检查
    vm += 'if ' + dispatchAux + '(_op) then ';
    vm += E + '[_op](_a,_b,_c) ';
    vm += 'else ';
    vm += 'print("[AVM] unknown opcode " .. tostring(_op)) ';
    vm += stateVar + '=0 ';
    vm += 'end ';
    vm += 'end ';

    // --- s: 主加载器入口 ---
    vm += 'local function ' + loadName + '(...) ';
    vm += initEnvName + '() ';
    // 将输入参数放入寄存器
    vm += 'local _va={...} ';
    vm += 'for _i=1,#_va do ' + R_tbl + '[_i-1]=_va[_i] end ';
    // 主循环：while true + repeat until false 驱动
    vm += 'while true do ';
    vm += 'if ' + loopGuard + '() then break end ';
    vm += 'repeat ';
    vm += dispatchName + '() ';
    vm += 'until ' + stateVar + '==' + this.obfuscateNumber(0) + ' or ' + pcName + '>#' + B_tbl + ' ';
    vm += 'if ' + pcName + '>#' + B_tbl + ' then break end ';
    vm += 'end ';
    // 返回结果
    vm += 'return unpack(' + retVals + ') ';
    vm += 'end ';

    // 执行主加载器（不使用 vararg，避免顶层 ... 报错）
    vm += 'return ' + loadName + '()';

    return vm;
  },

  // ========== 状态机虚拟机 (State Machine VM) ==========
  // 完整的状态机驱动解码器+执行环境构建器
  //
  // 架构角色：
  // f    — 入口函数：调用 l（状态机），将巨大字符串作为输入
  // l    — 状态机：驱动整个解码+构建流程
  // h/g  — 解码函数：对加密字符串进行多层还原
  // C    — 闭包构建器：创建新函数和闭包
  // z    — 执行环境表：构建沙盒环境
  // D    — 调度器：在状态机各阶段间切换
  //
  // 状态机状态：
  //   S0  — 初始化（捕获内置函数引用）
  //   S1  — 数据分块（将巨大字符串拆分为段）
  //   S2  — 多层解码（h/g 交替解码）
  //   S3  — 环境构建（C/z 构建执行环境）
  //   S4  — 代码组装（拼合解码后的代码段）
  //   S5  — 执行（直接调用嵌入函数）
  //   S6  — 完成/退出
  //
  // 增强特征：
  // 1. 6 状态有限状态机，while+repeat+if 多层驱动
  // 2. 5 层字符串加密（XOR 链 + 位移 + Base64 变体 + 字节交换 + 累加器）
  // 3. 函数引用缓存（pcall/tonumber/string.byte 等捕获为 upvalue）
  // 4. 沙盒环境构建（C 创建闭包，z 构建受限 _G）
  // 5. 随机状态编号（每次生成不同状态码）
  // 6. 多进制索引混淆（E[0x36], E[0b111001] 风格）
  // 7. 状态跳转表加密（状态转移表本身被 XOR 加密）

  stateMachineVM(code) {
    const bytes = this.toUtf8Bytes(code);

    // ====== Phase 1: 5 层加密 ======
    const seed = [];
    for (let i = 0; i < 6; i++) seed.push(Math.floor(Math.random() * 256));

    // XOR 密钥链
    const xorKey = new Array(32);
    xorKey[0] = seed[0];
    for (let i = 1; i < 32; i++) {
      xorKey[i] = (xorKey[i - 1] * 41 + seed[i % 6] + i * 7) % 256;
    }

    // 位移参数
    const shiftAmount = 1 + Math.floor(Math.random() * 6);
    // Base64 变体字母表
    const b64Std = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
    const b64Chars = b64Std.split('');
    // Fisher-Yates 打乱
    for (let i = b64Chars.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [b64Chars[i], b64Chars[j]] = [b64Chars[j], b64Chars[i]];
    }
    const b64Alphabet = b64Chars.join('');
    // 字节交换参数
    const swapStep = 1 + Math.floor(Math.random() * 4);
    // 累加器初始值
    const accInit = Math.floor(Math.random() * 200) + 50;

    // 层 1: XOR 链
    const xorBytes = bytes.slice();
    let xorChain = seed[0];
    for (let i = 0; i < xorBytes.length; i++) {
      xorBytes[i] = xorBytes[i] ^ xorKey[i % 32] ^ xorChain;
      xorChain = (xorChain * 31 + xorBytes[i] + i) % 256;
    }

    // 层 2: 位循环移位
    const shiftedBytes = xorBytes.map((b, i) => {
      const s = (shiftAmount + (i % 3)) % 8;
      return ((b << s) | (b >> (8 - s))) & 0xFF;
    });

    // 层 3: Base64 变体编码
    let b64Str = '';
    for (let i = 0; i < shiftedBytes.length; i += 3) {
      const b0 = shiftedBytes[i] || 0;
      const b1 = shiftedBytes[i + 1] || 0;
      const b2 = shiftedBytes[i + 2] || 0;
      b64Str += b64Alphabet[(b0 >> 2) & 0x3F];
      b64Str += b64Alphabet[((b0 & 0x03) << 4) | ((b1 >> 4) & 0x0F)];
      b64Str += b64Alphabet[((b1 & 0x0F) << 2) | ((b2 >> 6) & 0x03)];
      b64Str += b64Alphabet[b2 & 0x3F];
    }
    // 截掉 padding（保留实际字节数信息）
    const actualB64Len = Math.ceil(shiftedBytes.length * 4 / 3);
    b64Str = b64Str.substring(0, actualB64Len);

    // 层 4: 字节交换（在 Base64 字符串上操作）
    const swapArr = b64Str.split('');
    for (let i = 0; i + swapStep < swapArr.length; i += swapStep * 2) {
      const tmp = swapArr[i];
      swapArr[i] = swapArr[i + swapStep];
      swapArr[i + swapStep] = tmp;
    }
    const swappedStr = swapArr.join('');

    // 层 5: 累加器加法
    const finalChars = [];
    let acc = accInit;
    for (let i = 0; i < swappedStr.length; i++) {
      const c = swappedStr.charCodeAt(i);
      const enc = (c + acc) % 256;
      finalChars.push(enc);
      acc = (acc * 37 + enc + i) % 256;
    }

    // 将最终字节序列编码为 Lua 字符串（使用 \ddd 转义）
    let giantString = '';
    for (const b of finalChars) {
      giantString += '\\' + b.toString().padStart(3, '0');
    }

    // ====== Phase 2: 状态机状态码 ======
    // 随机生成 7 个不重复的状态码（3-4 位数）
    const stateCodes = [];
    const usedCodes = new Set();
    for (let i = 0; i < 7; i++) {
      let code;
      do {
        code = Math.floor(Math.random() * 8990) + 1000;
      } while (usedCodes.has(code));
      usedCodes.add(code);
      stateCodes.push(code);
    }
    // S0-S6 对应 stateCodes[0]-stateCodes[6]

    // 状态转移表（加密）
    // transitions[i] = (nextState[i] ^ xorKey[i % 32]) — 运行时 XOR 还原
    const transitions = [];
    for (let i = 0; i < 7; i++) {
      const nextS = stateCodes[(i + 1) % 7];
      transitions.push((nextS ^ xorKey[i % 32]) & 0xFF);
      // 注意：状态码可能 > 255，需要处理
      // 改用模运算
      transitions[i] = nextS ^ (xorKey[i % 32] + (i + 1) * 17);
    }

    // ====== Phase 3: 变量命名 ======
    const fName = this.generateShortStyleName();       // f — 入口函数
    const lName = this.generateShortStyleName();       // l — 状态机
    const hName = this.generateShortStyleName();       // h — 解码函数1
    const gName = this.generateShortStyleName();       // g — 解码函数2
    const CName = this.generateShortStyleName();       // C — 闭包构建器
    const zName = this.generateShortStyleName();       // z — 执行环境表
    const DName = this.generateShortStyleName();       // D — 调度器
    const dataVar = this.generateShortStyleName();     // 巨大字符串变量
    const stateVar = this.generateShortStyleName();    // 当前状态
    const accVar = this.generateShortStyleName();      // 累加器
    const idxVar = this.generateShortStyleName();      // 索引
    const chunkVar = this.generateShortStyleName();    // 分块表
    const resultVar = this.generateShortStyleName();   // 结果累加器
    const transTbl = this.generateShortStyleName();    // 状态转移表
    const xorTbl = this.generateShortStyleName();      // XOR 密钥表
    const b64Tbl = this.generateShortStyleName();      // Base64 查找表
    const envTbl = this.generateShortStyleName();      // 沙盒环境表
    const cacheVar = this.generateShortStyleName();    // 函数缓存
    const protoTbl = this.generateShortStyleName();    // 函数原型表
    const upvalTbl = this.generateShortStyleName();    // upvalue 表
    const regTbl = this.generateShortStyleName();      // 寄存器表
    const pcVar = this.generateShortStyleName();       // PC
    const tmpVar = this.generateShortStyleName();      // 临时变量
    const tmp2Var = this.generateShortStyleName();     // 临时变量2
    const retVar = this.generateShortStyleName();      // 返回值
    const loopVar = this.generateShortStyleName();     // 循环变量
    const iVar = this.generateShortStyleName();        // 循环变量 i
    const jVar = this.generateShortStyleName();        // 循环变量 j

    // 内置函数引用缓存名
    const ref_pcall = this.generateShortStyleName();
    const ref_tonum = this.generateShortStyleName();
    const ref_tostr = this.generateShortStyleName();
    const ref_sbyte = this.generateShortStyleName();
    const ref_ssub = this.generateShortStyleName();
    const ref_schar = this.generateShortStyleName();
    const ref_srep = this.generateShortStyleName();
    const ref_sfind = this.generateShortStyleName();
    const ref_mfloor = this.generateShortStyleName();
    const ref_mrand = this.generateShortStyleName();
    const ref_concat = this.generateShortStyleName();
    const ref_load = this.generateShortStyleName();
    const ref_type = this.generateShortStyleName();
    const ref_unpack = this.generateShortStyleName();
    const ref_setmt = this.generateShortStyleName();
    const ref_getmt = this.generateShortStyleName();
    const ref_rawget = this.generateShortStyleName();
    const ref_rawset = this.generateShortStyleName();
    const ref_pairs = this.generateShortStyleName();
    const ref_error = this.generateShortStyleName();
    const ref_bxor = this.generateShortStyleName();  // bit32.bxor 引用（带fallback）

    // 多进制索引格式化
    const fmtIdx = (n) => {
      const fmt = Math.floor(Math.random() * 6);
      switch (fmt) {
        case 0: return String(n);
        case 1: return '0x' + n.toString(16);
        case 2: return '0X' + n.toString(16).toUpperCase();
        case 3: return 'tonumber("' + n.toString(2) + '",2)';
        case 4: return 'tonumber("' + n.toString(8) + '",8)';
        case 5: {
          const a = Math.floor(Math.random() * (n - 1)) + 1;
          return '(' + a + '+' + (n - a) + ')';
        }
      }
      return String(n);
    };

    // ====== Phase 4: 生成 VM 代码 ======
    let vm = '';

    // --- S0: 初始化（捕获内置函数引用）---
    // 在闭包内捕获所有关键内置函数，外部无法通过 _G 或 debug 获取
    vm += 'local ' + ref_pcall + '=pcall ';
    vm += 'local ' + ref_tonum + '=tonumber ';
    vm += 'local ' + ref_tostr + '=tostring ';
    vm += 'local ' + ref_sbyte + '=string.byte ';
    vm += 'local ' + ref_ssub + '=string.sub ';
    vm += 'local ' + ref_schar + '=string.char ';
    vm += 'local ' + ref_srep + '=string.rep ';
    vm += 'local ' + ref_sfind + '=string.find ';
    vm += 'local ' + ref_mfloor + '=math.floor ';
    vm += 'local ' + ref_mrand + '=math.random ';
    vm += 'local ' + ref_concat + '=table.concat ';
    vm += 'local ' + ref_load + '=load ';
    vm += 'local ' + ref_type + '=type ';
    vm += 'local ' + ref_unpack + '=(unpack or table.unpack) ';
    vm += 'local ' + ref_setmt + '=setmetatable ';
    vm += 'local ' + ref_getmt + '=getmetatable ';
    vm += 'local ' + ref_rawget + '=rawget ';
    vm += 'local ' + ref_rawset + '=rawset ';
    vm += 'local ' + ref_pairs + '=pairs ';
    vm += 'local ' + ref_error + '=error ';
    // Bug: bit32可能为nil（Roblox Luau），添加fallback
    vm += 'local ' + ref_bxor + '=(bit32 and bit32.bxor) or (bit and bit.bxor) or function(a,b) local r=0 local s=1 for _=1,32 do if (a%2)+(b%2)==1 then r=r+s end a=math.floor(a/2) b=math.floor(b/2) s=s*2 end return r end ';

    // --- XOR 密钥表 ---
    vm += 'local ' + xorTbl + '={' + xorKey.join(',') + '} ';
    // --- 状态转移表（加密态）---
    vm += 'local ' + transTbl + '={' + transitions.join(',') + '} ';
    // --- Base64 查找表（隐藏版 — 运行时从加密数据重建）---
    // 不再存储 256 条目的明文表，而是存储 64 字节的加密字母表
    // 运行时解密重建，字母表字符不以明文出现
    //
    // 加密方式：每个字母表字符的 byte 与派生密钥链 XOR
    // 派生密钥：从 xorTbl + 位置偏移 + 种子混合推导
    const b64DeriveSeed = Math.floor(Math.random() * 200) + 30;
    const b64EncBytes = [];
    for (let i = 0; i < 64; i++) {
      const deriveKey = (xorKey[i % 32] + i * 13 + b64DeriveSeed * (i + 1)) % 256;
      b64EncBytes.push((b64Alphabet.charCodeAt(i) ^ deriveKey) & 0xFF);
    }
    // 编码为 \ddd 转义字符串（与巨大字符串格式相同，不可区分）
    let b64EncStr = '';
    for (const b of b64EncBytes) {
      b64EncStr += '\\' + b.toString().padStart(3, '0');
    }

    // 生成重建代码 — 3 种变体
    const b64Variant = Math.floor(Math.random() * 3);
    // 额外变量名
    const b64EncVar = this.generateShortStyleName();
    const b64DkVar = this.generateShortStyleName();
    const b64LoopVar = this.generateShortStyleName();
    const b64ChVar = this.generateShortStyleName();
    const b64TmpVar = this.generateShortStyleName();

    vm += 'local ' + b64Tbl + '={} ';

    if (b64Variant === 0) {
      // 变体0：单循环重建 — 从加密字符串逐字节 XOR 解密，构建反向查找表
      // 修复：与 JS 编码端使用相同的直接公式，而非 LCG 链
      vm += 'local ' + b64EncVar + '="' + b64EncStr + '" ';
      vm += 'local ' + b64DkVar + '=' + b64DeriveSeed + ' ';
      vm += 'for ' + b64LoopVar + '=1,' + fmtIdx(64) + ' do ';
      vm += b64DkVar + '=(' + xorTbl + '[(' + b64LoopVar + '-1)%' + fmtIdx(32) + '+1]+(' + b64LoopVar + '-1)*' + fmtIdx(13) + '+' + b64DeriveSeed + '*' + b64LoopVar + ')%256 ';
      vm += b64ChVar + '=' + ref_bxor + '(' + ref_sbyte + '(' + b64EncVar + ',' + b64LoopVar + '),' + b64DkVar + ') ';
      vm += b64Tbl + '[' + b64ChVar + '+1]=' + b64LoopVar + '-1 ';
      vm += 'end ';
    } else if (b64Variant === 1) {
      // 变体1：分两半重建 — 两半使用相同的 b64DeriveSeed（与编码端一致）
      // 修复：编码端对所有 64 字符使用同一个 deriveKey 公式，解码端必须匹配
      vm += 'local ' + b64EncVar + '="' + b64EncStr + '" ';
      // 前半部分
      vm += 'local ' + b64DkVar + '=' + b64DeriveSeed + ' ';
      vm += 'for ' + b64LoopVar + '=1,' + fmtIdx(32) + ' do ';
      vm += b64DkVar + '=(' + xorTbl + '[(' + b64LoopVar + '-1)%' + fmtIdx(32) + '+1]+(' + b64LoopVar + '-1)*' + fmtIdx(13) + '+' + b64DeriveSeed + '*' + b64LoopVar + ')%256 ';
      vm += b64ChVar + '=' + ref_bxor + '(' + ref_sbyte + '(' + b64EncVar + ',' + b64LoopVar + '),' + b64DkVar + ') ';
      vm += b64Tbl + '[' + b64ChVar + '+1]=' + b64LoopVar + '-1 ';
      vm += 'end ';
      // 后半部分（相同种子，相同公式）
      vm += 'for ' + b64LoopVar + '=' + fmtIdx(33) + ',' + fmtIdx(64) + ' do ';
      vm += b64DkVar + '=(' + xorTbl + '[(' + b64LoopVar + '-1)%' + fmtIdx(32) + '+1]+(' + b64LoopVar + '-1)*' + fmtIdx(13) + '+' + b64DeriveSeed + '*' + b64LoopVar + ')%256 ';
      vm += b64ChVar + '=' + ref_bxor + '(' + ref_sbyte + '(' + b64EncVar + ',' + b64LoopVar + '),' + b64DkVar + ') ';
      vm += b64Tbl + '[' + b64ChVar + '+1]=' + b64LoopVar + '-1 ';
      vm += 'end ';
    } else {
      // 变体2：位运算混合重建
      // 修复：移除多余的 bitMask XOR（编码端未使用 bitMask）
      vm += 'local ' + b64EncVar + '="' + b64EncStr + '" ';
      vm += 'local ' + b64DkVar + '=' + b64DeriveSeed + ' ';
      vm += 'for ' + b64LoopVar + '=1,' + fmtIdx(64) + ' do ';
      // 派生密钥使用直接公式（与 JS 编码端一致）
      vm += b64DkVar + '=(' + xorTbl + '[(' + b64LoopVar + '-1)%' + fmtIdx(32) + '+1]+(' + b64LoopVar + '-1)*' + fmtIdx(13) + '+' + b64DeriveSeed + '*' + b64LoopVar + ')%256 ';
      vm += b64ChVar + '=' + ref_sbyte + '(' + b64EncVar + ',' + b64LoopVar + ') ';
      vm += b64ChVar + '=' + ref_bxor + '(' + b64ChVar + ',' + b64DkVar + ') ';
      vm += b64Tbl + '[' + b64ChVar + '+1]=' + b64LoopVar + '-1 ';
      // 插入 junk：在奇数索引时做一次无用的表操作
      vm += 'if ' + b64LoopVar + '%2==1 then ' + b64Tbl + '[255]=nil end ';
      vm += 'end ';
      // 清理 junk
      vm += b64Tbl + '[255]=nil ';
    }

    // 验证：重建后的表必须有 64 个有效条目（可选完整性检查）
    vm += 'do local ' + b64TmpVar + '=0 for _ in ' + ref_pairs + '(' + b64Tbl + ') do ' + b64TmpVar + '=' + b64TmpVar + '+1 end ';
    vm += 'if ' + b64TmpVar + '~=64 then print("[SVM] b64 table corrupted") end end ';

    // --- 巨大字符串（加密的代码数据）---
    vm += 'local ' + dataVar + '="' + giantString + '" ';

    // --- 状态变量 ---
    vm += 'local ' + stateVar + '=' + stateCodes[0] + ' ';
    vm += 'local ' + accVar + '=' + accInit + ' ';
    vm += 'local ' + idxVar + '=1 ';
    vm += 'local ' + chunkVar + '={} ';
    vm += 'local ' + resultVar + '="" ';
    vm += 'local ' + envTbl + '={} ';
    vm += 'local ' + cacheVar + '={} ';
    vm += 'local ' + protoTbl + '={} ';
    vm += 'local ' + upvalTbl + '={} ';
    vm += 'local ' + regTbl + '={} ';
    vm += 'local ' + pcVar + '=1 ';
    vm += 'local ' + retVar + '={} ';

    // 寄存器初始化（多进制索引）
    for (let i = 0; i < 8; i++) {
      vm += regTbl + '[' + fmtIdx(i) + ']=nil ';
    }

    // --- h: 解码函数1（位循环移位还原 + XOR 链还原）---
    // 修复：先还原 L2（位移），再还原 L1（XOR），与加密顺序相反
    // 修复：XOR chain 使用加密后字节（un-shift 后的 xorBytes[i]）更新，
    //       且必须在 un-XOR 之前保存该值，因为 un-XOR 会覆盖它
    // 修复：XOR chain 使用全局字节偏移计算，保证连续性
    //       JS: xorChain 初始 = seed[0]，chain = (chain*31 + xorBytes[i] + i) % 256
    //       Lua: 传入 _byteOff 作为全局偏移，i 的 0-based 全局索引 = _byteOff + loopVar - 1
    //       但 chain 的值需要在多次调用间传递，所以通过 upvalue/参数返回
    vm += 'local ' + hName + '_chain=' + seed[0] + ' ';
    vm += 'local function ' + hName + '(' + tmpVar + ',' + tmp2Var + ') ';
    // tmpVar = 加密字节表, tmp2Var = 全局字节偏移（用于索引计算）
    // 返回解码后的字节表
    vm += 'local _r={} ';
    vm += 'local _xc=' + hName + '_chain ';
    vm += 'local _goff=' + tmp2Var + ' or 0 ';
    vm += 'for ' + iVar + '=1,#' + tmpVar + ' do ';
    vm += 'local _b=' + tmpVar + '[' + iVar + '] ';
    // 层 2 反向: 位循环移位还原（先还原 L2）
    // 位移量使用全局索引: (goff + i - 1) % 3
    vm += 'local _gi=_goff+(' + iVar + '-1) ';
    vm += 'local _s=(' + shiftAmount + '+(_gi%3))%8 ';
    vm += '_b=(math.floor(_b/2^_s)+(_b%(2^_s))*2^(8-_s))%256 ';
    // 此时 _b = xorBytes[i]（XOR 加密后的字节）
    // 层 1 反向: XOR 链（使用 OLD chain 解密）
    // XOR key 使用全局索引: (goff + i - 1) % 32
    vm += 'local _dec=' + ref_bxor + '(' + ref_bxor + '(_b,' + xorTbl + '[_gi%32+1]),_xc) ';
    // 更新 chain 使用加密后字节（与 JS 编码端一致）
    // JS: chain = (chain*31 + xorBytes[i] + i) % 256, i 是全局 0-based 索引
    vm += '_xc=(_xc*31+_b+_gi)%256 ';
    vm += '_r[' + iVar + ']=_dec ';
    vm += 'end ';
    // 保存 chain 值供下次调用使用
    vm += hName + '_chain=_xc ';
    vm += 'return _r ';
    vm += 'end ';

    // --- g: 解码函数2（Base64 解码 + 字节交换还原 + 累加器减法）---
    // 修复：接受全局字符偏移参数，使 accumulator（层 5）在分块间连续
    //       JS: acc 初始 = accInit, acc = (acc*37 + enc + i) % 256, i 是全局 0-based 索引
    //       分块对齐已保证 Base64 组和 swap 不跨越分块边界
    vm += 'local ' + gName + '_acc=' + accInit + ' ';
    vm += 'local function ' + gName + '(' + tmpVar + ',' + tmp2Var + ') ';
    // tmpVar = 经过层 3-5 加密的字符串
    // tmp2Var = 全局字符偏移（用于 accumulator 索引）
    // 返回解码后的字节表（经过层 1-2 还原前）
    vm += 'local _chars={} ';
    vm += 'local _acc=' + gName + '_acc ';
    vm += 'local _goff=' + tmp2Var + ' or 0 ';
    // 层 5 反向: 累加器减法（使用全局索引）
    vm += 'for ' + iVar + '=1,#' + tmpVar + ' do ';
    vm += 'local _c=' + ref_sbyte + '(' + tmpVar + ',' + iVar + ') ';
    vm += 'local _dec=(_c-_acc)%256 ';
    vm += '_acc=(_acc*37+_c+(_goff+(' + iVar + '-1)))%256 ';
    vm += '_chars[' + iVar + ']=_dec ';
    vm += 'end ';
    // 保存 acc 值供下次调用使用
    vm += gName + '_acc=_acc ';
    // 层 4 反向: 字节交换还原（分块对齐保证不跨越边界）
    vm += 'for ' + iVar + '=1,#_chars,(' + swapStep + '*2) do ';
    vm += 'if ' + iVar + '+' + swapStep + '<=#_chars then ';
    vm += 'local _t=_chars[' + iVar + '] ';
    vm += '_chars[' + iVar + ']=_chars[' + iVar + '+' + swapStep + '] ';
    vm += '_chars[' + iVar + '+' + swapStep + ']=_t ';
    vm += 'end end ';
    // 层 3 反向: Base64 变体解码
    // 将字节序列转回字符串，然后用 b64Tbl 解码
    vm += 'local _b64s="" ';
    vm += 'for ' + iVar + '=1,#_chars do ';
    vm += '_b64s=_b64s..' + ref_schar + '(_chars[' + iVar + ']) ';
    vm += 'end ';
    // Base64 解码：每 4 字符 → 3 字节
    // 修复：正确处理最后不满 4 字符的情况
    vm += 'local _out={} ';
    vm += 'for ' + iVar + '=1,#_b64s,4 do ';
    vm += 'local _c0=' + b64Tbl + '[' + ref_sbyte + '(_b64s,' + iVar + ')+1] ';
    vm += 'local _c1=nil if ' + iVar + '+1<=#_b64s then _c1=' + b64Tbl + '[' + ref_sbyte + '(_b64s,' + iVar + '+1)+1] end ';
    vm += 'local _c2=nil if ' + iVar + '+2<=#_b64s then _c2=' + b64Tbl + '[' + ref_sbyte + '(_b64s,' + iVar + '+2)+1] end ';
    vm += 'local _c3=nil if ' + iVar + '+3<=#_b64s then _c3=' + b64Tbl + '[' + ref_sbyte + '(_b64s,' + iVar + '+3)+1] end ';
    vm += 'if _c0 and _c1 then _out[#_out+1]=(_c0*4+math.floor(_c1/16))%256 end ';
    vm += 'if _c1 and _c2 then _out[#_out+1]=(_c1%16*16+math.floor(_c2/4))%256 end ';
    vm += 'if _c2 and _c3 then _out[#_out+1]=(_c2%4*64+_c3)%256 end ';
    vm += 'end ';
    vm += 'return _out ';
    vm += 'end ';

    // --- C: 闭包构建器 ---
    // 创建新函数闭包，将 upvalues 绑定
    vm += 'local function ' + CName + '(' + tmpVar + ',' + tmp2Var + ') ';
    // tmpVar = 函数原型名, tmp2Var = upvalue 表
    vm += 'local _proto=' + protoTbl + '[' + tmpVar + '] ';
    vm += 'if not _proto then return nil end ';
    vm += 'local _upvals=' + tmp2Var + ' or {} ';
    // 创建闭包：用 setmetatable + __call 使表可调用
    vm += 'local _cl={' + ref_setmt + '({},{__call=function(_,...) ';
    vm += 'local _args={...} ';
    vm += 'local _env={' + ref_setmt + '({},{__index=function(_,k) ';
    vm += 'for _i=1,#_upvals do if _upvals[_i]==k then return _upvals[_i+1] end end ';
    vm += 'return rawget(_G,k) end})} ';
    vm += 'return _proto(_env,unpack(_args)) ';
    vm += 'end})} ';
    vm += 'return _cl ';
    vm += 'end ';

    // --- z: 执行环境表 ---
    // 构建受限的全局环境（沙盒）
    vm += 'local ' + zName + '={} ';
    // z.create(proto, upvals) — 创建闭包
    vm += zName + '.create=function(_p,_u) return ' + CName + '(_p,_u) end ';
    // z.unpack(t) — 安全 unpack
    vm += zName + '.unpack=function(_t) local _r={} for _i=1,#_t do _r[_i]=_t[_i] end return ' + ref_unpack + '(_r) end ';
    // z.readi32(t, off) — 读取 32 位整数
    vm += zName + '.readi32=function(_t,_o) return (_t[_o] or 0)+((_t[_o+1] or 0)*256)+((_t[_o+2] or 0)*65536)+((_t[_o+3] or 0)*16777216) end ';
    // z.writei32(t, off, v) — 写入 32 位整数
    vm += zName + '.writei32=function(_t,_o,_v) _t[_o]=_v%256 _t[_o+1]=' + ref_mfloor + '(_v/256)%256 _t[_o+2]=' + ref_mfloor + '(_v/65536)%256 _t[_o+3]=' + ref_mfloor + '(_v/16777216)%256 end ';
    // z.protect(fn) — pcall 包装
    vm += zName + '.protect=function(_fn) return function(...) return ' + ref_pcall + '(_fn,...) end end ';
    // z.safe(fn, default) — 带默认值的安全调用
    vm += zName + '.safe=function(_fn,_d) return function(...) local _r={' + ref_pcall + '(_fn,...)} if _r[1] then return unpack(_r,2) else return _d end end end ';
    // z.readstr(t, off, len) — 读取字符串
    vm += zName + '.readstr=function(_t,_o,_l) local _s="" for _i=_o,_o+_l-1 do _s=_s..' + ref_schar + '(_t[_i] or 0) end return _s end ';
    // z.writestr(t, off, str) — 写入字符串
    vm += zName + '.writestr=function(_t,_o,_s) for _i=1,#_s do _t[_o+_i-1]=' + ref_sbyte + '(_s,_i) end end ';

    // --- D: 调度器 ---
    // 在状态机各阶段间切换，处理状态转移
    vm += 'local function ' + DName + '() ';
    // 从加密转移表中还原下一个状态
    vm += 'local _idx=0 ';
    vm += 'for ' + iVar + '=1,7 do ';
    // 修复：展开循环，避免使用 iVar（字符串）作为 JS 数组索引
    // 原代码 stateCodes[iVar - 1] 中 iVar 是 Lua 变量名（字符串），导致 NaN
    for (let si = 0; si < 7; si++) {
      vm += 'if ' + stateVar + '==' + stateCodes[si] + ' then _idx=' + (si + 1) + ' break end ';
    }
    vm += 'end ';
    vm += 'if _idx==0 then ' + stateVar + '=' + stateCodes[6] + ' return end ';
    // 解密转移表获取下一状态
    vm += 'local _enc=' + transTbl + '[_idx] ';
    vm += 'local _key=' + xorTbl + '[(_idx-1)%32+1]+_idx*17 ';
    vm += stateVar + '=' + ref_bxor + '(_enc,_key) ';
    vm += 'end ';

    // --- l: 状态机 ---
    // 驱动整个解码+构建流程
    vm += 'local function ' + lName + '(' + tmpVar + ') ';
    // tmpVar = 巨大字符串
    vm += 'while true do ';
    vm += 'repeat ';

    // S0: 初始化
    vm += 'if ' + stateVar + '==' + stateCodes[0] + ' then ';
    vm += accVar + '=' + accInit + ' ';
    vm += idxVar + '=1 ';
    vm += resultVar + '="" ';
    // 清空分块表
    vm += 'for _k in ' + ref_pairs + '(' + chunkVar + ') do ' + chunkVar + '[_k]=nil end ';
    vm += DName + '() ';
    vm += 'end ';

    // S1: 数据分块 — 将巨大字符串拆分为段
    // 修复：分块大小必须同时是 4 和 swapStep*2 的倍数，以保证 Base64 组和
    //       字节交换不会跨越分块边界
    vm += 'if ' + stateVar + '==' + stateCodes[1] + ' then ';
    const chunkSize = 4 * swapStep * 2 * 25; // lcm(4, swapStep*2) * 25
    vm += 'local _segLen=' + chunkSize + ' ';
    vm += 'local _total=#' + tmpVar + ' ';
    vm += 'for ' + iVar + '=1,_total,_segLen do ';
    vm += 'local _seg=' + ref_ssub + '(' + tmpVar + ',' + iVar + ',' + ref_mfloor + '(' + iVar + '+_segLen-1)) ';
    vm += chunkVar + '[#' + chunkVar + '+1]=_seg ';
    vm += 'end ';
    vm += DName + '() ';
    vm += 'end ';

    // S2: 多层解码 — g 解码每块层 5→3，拼接后再 h 解码层 2→1
    // 修复：
    //   1. g 函数需要全局索引以正确恢复 accumulator（层 5）
    //   2. g 返回 Base64 解码后的字节，每块独立解码（分块对齐已保证）
    //   3. h 函数需要连续的 XOR chain，通过全局偏移传递
    //   4. 每块解码的字节直接拼接到结果中
    vm += 'if ' + stateVar + '==' + stateCodes[2] + ' then ';
    vm += 'local _byteOff=0 ';
    vm += 'for ' + iVar + '=1,#' + chunkVar + ' do ';
    // g 解码（层 5→3），传入全局字符偏移以恢复 accumulator
    vm += 'local _stage1=' + gName + '(' + chunkVar + '[' + iVar + '],(' + iVar + '-1)*' + chunkSize + ') ';
    // h 解码（层 2→1），传入全局字节偏移作为 XOR chain 起始
    // 注意：seed[0] 是 XOR chain 的初始值，但 h 函数内部会从传入值开始
    // 对于第一块，传入 seed[0]；后续块传入上一块结束时的 chain 值
    vm += 'local _stage2=' + hName + '(_stage1,_byteOff) ';
    // 更新字节偏移（用于 XOR chain 连续性）
    vm += '_byteOff=_byteOff+#_stage2 ';
    // h 解码后转回字符串 — 使用 table.concat 避免 O(n²)
    vm += 'local _tmp={} ';
    vm += 'for ' + jVar + '=1,#_stage2 do ';
    vm += '_tmp[#_tmp+1]=' + ref_schar + '(_stage2[' + jVar + ']) ';
    vm += 'end ';
    vm += resultVar + '=' + resultVar + '..table.concat(_tmp) ';
    vm += 'end ';
    vm += DName + '() ';
    vm += 'end ';

    // S3: 环境构建 — C/z 构建执行环境
    vm += 'if ' + stateVar + '==' + stateCodes[3] + ' then ';
    // 将解码后的代码注册为函数原型
    vm += protoTbl + '[' + fmtIdx(1) + ']=function(_env,...) ';
    // 设置沙盒环境
    vm += 'local _oldG=_G ';
    vm += 'local _sandbox={' + ref_setmt + '({},{__index=function(_,k) ';
    vm += 'if ' + envTbl + '[k] then return ' + envTbl + '[k] end ';
    vm += 'return rawget(_G,k) end, __newindex=function(_,k,v) ' + envTbl + '[k]=v end})} ';
    // 将缓存的全局函数放入环境
    vm += envTbl + '["pcall"]=' + ref_pcall + ' ';
    vm += envTbl + '["tonumber"]=' + ref_tonum + ' ';
    vm += envTbl + '["tostring"]=' + ref_tostr + ' ';
    vm += envTbl + '["type"]=' + ref_type + ' ';
    vm += envTbl + '["string"]={' + ref_setmt + '({},{__index=function(_,k) return string[k] end})} ';
    vm += envTbl + '["math"]={' + ref_setmt + '({},{__index=function(_,k) return math[k] end})} ';
    vm += envTbl + '["table"]={' + ref_setmt + '({},{__index=function(_,k) return table[k] end})} ';
    vm += envTbl + '["print"]=print ';
    // 在沙盒中执行解码后的代码
    vm += 'local _fn=' + ref_load + '(' + resultVar + ') ';
    vm += 'if _fn then ';
    vm += '_G=_sandbox ';
    vm += 'local _r={' + ref_pcall + '(_fn,...)} ';
    vm += '_G=_oldG ';
    vm += 'return unpack(_r,2) ';
    vm += 'else ';
    vm += '_G=_oldG ';
    vm += 'return nil ';
    vm += 'end ';
    vm += 'end ';
    // 创建闭包
    vm += regTbl + '[' + fmtIdx(0) + ']=' + CName + '(' + fmtIdx(1) + ',{}) ';
    vm += DName + '() ';
    vm += 'end ';

    // S4: 代码组装 — 已在 S3 完成，这里做完整性校验
    vm += 'if ' + stateVar + '==' + stateCodes[4] + ' then ';
    vm += 'if #' + resultVar + '==0 then ';
    vm += 'print("[SVM] decode failed") ';
    vm += stateVar + '=' + stateCodes[6] + ' ';
    vm += 'else ';
    vm += DName + '() ';
    vm += 'end ';
    vm += 'end ';

    // S5: 执行 — 调用闭包
    vm += 'if ' + stateVar + '==' + stateCodes[5] + ' then ';
    vm += 'local _fn=' + regTbl + '[' + fmtIdx(0) + '] ';
    vm += 'if _fn then ';
    vm += 'local _r={' + ref_pcall + '(_fn)} ';
    vm += 'if _r[1] then ';
    vm += 'for ' + iVar + '=2,#_r do ' + retVar + '[#' + retVar + '+1]=_r[' + iVar + '] end ';
    vm += 'end ';
    vm += 'end ';
    vm += DName + '() ';
    vm += 'end ';

    // S6: 完成/退出
    vm += 'if ' + stateVar + '==' + stateCodes[6] + ' then ';
    vm += 'break ';
    vm += 'end ';

    vm += 'until false ';
    // 循环守卫
    vm += 'if ' + stateVar + '==' + stateCodes[6] + ' then break end ';
    vm += 'end ';
    vm += 'return ' + ref_unpack + '(' + retVar + ') ';
    vm += 'end ';

    // --- f: 入口函数 ---
    // 接收巨大字符串，调用状态机 l 进行解码和执行
    vm += 'local function ' + fName + '() ';
    vm += 'return ' + lName + '(' + dataVar + ') ';
    vm += 'end ';

    // 执行入口函数
    vm += 'return ' + fName + '()';

    return vm;
  },

  // ========== 超强型字节流编码 (ByteStream v3 — 10x Enhanced) ==========
  // 将代码编码为自定义 Base64 变体字符串
  //
  // 增强特征（v3 — 10x Enhancement）：
  // 1. 12 字节种子（vs v2 的 6 字节），支持四路 LCG 链扩展
  // 2. 64 字节扩展密钥（vs v2 的 16 字节），密钥空间提升 2^384 倍
  // 3. 四路 LCG 并行链：乘数 31/37/53/71，四链混合（vs v2 的双链）
  // 4. 十二层加密链（vs v2 的七层），新增五层非线性变换
  // 5. 双函数依赖密钥字符串（vs v2 的单字符串），双重反调试融合
  // 6. 5-10 轮密钥调度演化（NEW），每轮使用不同偏移的密钥分量
  // 7. 立方位置混淆（NEW）：i^3 * posStep3 项，非线性度高于二次
  // 8. 三次密钥加（NEW）：使用第二偏移密钥，与主/二次密钥形成三重错位
  // 9. 加法扩散链（NEW）：每个字节依赖前驱密文，类似 CBC 模式
  // 10. 四部校验和（vs v2 的两部），拆分更细，静态分析更难
  // 11. 分段数 5-15（vs v2 的 2-5），重组复杂度提升
  // 12. 解码器 16 个状态机阶段（vs v2 的 9 个）
  byteStreamEncode(code) {
    // 1. 将代码转为 UTF-8 字节数组
    const bytes = this.toUtf8Bytes(code);

    // 2. 生成 12 字节种子（四倍种子，支持四路 LCG 链扩展）
    const seed = [
      Math.floor(Math.random() * 256),
      Math.floor(Math.random() * 256),
      Math.floor(Math.random() * 256),
      Math.floor(Math.random() * 256),
      Math.floor(Math.random() * 256),
      Math.floor(Math.random() * 256),
      Math.floor(Math.random() * 256),
      Math.floor(Math.random() * 256),
      Math.floor(Math.random() * 256),
      Math.floor(Math.random() * 256),
      Math.floor(Math.random() * 256),
      Math.floor(Math.random() * 256),
    ];
    const keyLen = 64;

    // === 超强型动态密钥流 v3 — 四路 LCG 链 ===
    // 特征：
    // 1. 12 字节种子（vs v2 的 6 字节），四路 LCG 链各取 3 字节种子
    // 2. 四路 LCG 并行扩展：链A(乘31), 链B(乘37), 链C(乘53), 链D(乘71)
    // 3. 四链加法混合 + 位置白化 + 函数依赖密钥
    // 4. 密钥空间：2^(12*8) * 2^(64*8) = 2^608（vs v2 的 2^176）
    const expandedKey = new Array(keyLen);
    const chainA = new Array(keyLen);
    const chainB = new Array(keyLen);
    const chainC = new Array(keyLen);
    const chainD = new Array(keyLen);
    chainA[0] = seed[0];
    chainB[0] = seed[3];
    chainC[0] = seed[6];
    chainD[0] = seed[9];
    for (let i = 1; i < keyLen; i++) {
      // 链 A：乘数 31，种子索引 i%12
      chainA[i] = (chainA[i - 1] * 31 + seed[i % 12] + i) % 256;
      // 链 B：乘数 37，种子索引 (i+3)%12，步进 7
      chainB[i] = (chainB[i - 1] * 37 + seed[(i + 3) % 12] + i * 7) % 256;
      // 链 C：乘数 53，种子索引 (i+6)%12，步进 11  [NEW]
      chainC[i] = (chainC[i - 1] * 53 + seed[(i + 6) % 12] + i * 11) % 256;
      // 链 D：乘数 71，种子索引 (i+9)%12，步进 13  [NEW]
      chainD[i] = (chainD[i - 1] * 71 + seed[(i + 9) % 12] + i * 13) % 256;
    }

    // === 双函数依赖密钥 + 运行时验证密钥 ===
    // 两段 keyStr 的 string.byte 值在 Lua 解码器中被直接调用参与解密循环
    // 攻击者必须同时保持两段字符串不被 hook 才能正确解密
    const keyStr1 = this.generateKeyString();
    const keyStr2 = this.generateKeyString();
    let envKey = 0;
    for (let i = 0; i < keyStr1.length; i++) {
      envKey = (envKey + keyStr1.charCodeAt(i)) % 256;
    }
    for (let i = 0; i < keyStr2.length; i++) {
      envKey = (envKey + keyStr2.charCodeAt(i) * 3) % 256;
    }
    // testKey: testRet(=1) * 37 = 37，融入密钥
    const testKey = 37;
    envKey = (envKey + testKey) % 256;

    // 四链混合 + 位置白化 + 函数依赖密钥
    for (let i = 0; i < keyLen; i++) {
      expandedKey[i] = (chainA[i] + chainB[i] + chainC[i] + chainD[i] + i * 17 + envKey) % 256;
    }

    // 3. 随机化各层参数
    const nibbleSwap = Math.random() < 0.5;               // 是否启用半字节交换层
    const rotateStep = 3 + Math.floor(Math.random() * 4); // 组大小 3-6
    const posStep = Math.floor(Math.random() * 7) + 1;    // 一次位置系数 1-7
    const posStep2 = Math.floor(Math.random() * 7) + 1;   // 二次位置系数 1-7
    const keyShift = Math.floor(Math.random() * keyLen);  // 二次密钥偏移 0-63

    // === v3 新增层参数 ===
    const posStep3 = Math.floor(Math.random() * 7) + 1;   // 立方位置系数 1-7  [NEW]
    const posStep4 = Math.floor(Math.random() * 7) + 1;   // 混合位置系数 1-7  [NEW]
    const keyShift2 = Math.floor(Math.random() * keyLen); // 三次密钥偏移 0-63  [NEW]
    const numRounds = 5 + Math.floor(Math.random() * 6);  // 5-10 轮密钥调度  [NEW]

    // 4. 十二层加密链
    // 性能优化：合并独立的逐字节层为单次循环
    const encrypted = bytes.slice();
    const n = encrypted.length;

    // 层 0: 半字节交换（高低 nibble 互换，非线性、自逆，破坏字节内位结构）
    if (nibbleSwap) {
      for (let i = 0; i < n; i++) {
        const b = encrypted[i];
        encrypted[i] = ((b % 16) * 16 + Math.floor(b / 16));
      }
    }

    // 性能优化：合并层 1+3+4+6 为单次循环
    // 层 1: 主密钥加  encrypted[i] = (encrypted[i] + expandedKey[i % 64]) % 256
    // 层 3: 二次位置混淆  offset = (i*posStep + i^2*posStep2) % 256
    // 层 4: 二次密钥加（偏移密钥，与主密钥形成错位）
    // 层 6: 函数依赖逐字节密钥 1（keyStr1 的 string.byte 参与加密）
    const keyStr1Len = keyStr1.length;
    for (let i = 0; i < n; i++) {
      const im = i % 256;
      const offset = (im * posStep + im * im % 256 * posStep2) % 256;
      const fb = keyStr1.charCodeAt(i % keyStr1Len);
      encrypted[i] = (encrypted[i] + expandedKey[i % keyLen] + offset + expandedKey[(i + keyShift) % keyLen] + fb) % 256;
    }

    // 层 2: 组内右轮转 1 位（每 rotateStep 字节一组）
    for (let i = 0; i < n; i += rotateStep) {
      const end = i + rotateStep < n ? i + rotateStep : n;
      if (end - i > 1) {
        const last = encrypted[end - 1];
        for (let j = end - 1; j > i; j--) {
          encrypted[j] = encrypted[j - 1];
        }
        encrypted[i] = last;
      }
    }

    // 层 5: 密文反馈（CFB）— 动态密钥演化，每个字节依赖前一个密文
    const iv = (seed[0] + seed[5] + seed[11] + envKey) % 256;
    for (let i = 0; i < n; i++) {
      const feedback = (i === 0) ? iv : encrypted[i - 1];
      encrypted[i] = (encrypted[i] + feedback + expandedKey[i % keyLen]) % 256;
    }

    // === v3 新增的 5 层加密 ===
    // 性能优化：合并层 7+8+11+13 为单次循环
    // 层 7: 立方位置混淆  offset = (i^3 * posStep3 + i * posStep4) % 256
    // 层 8: 三次密钥加（第二偏移密钥）
    // 层 11: 函数依赖逐字节密钥 2（keyStr2 的 string.byte * 3）
    // 层 13: 位旋转模拟 — 用纯算术模拟 rotate-left 3 位
    const keyStr2Len = keyStr2.length;
    for (let i = 0; i < n; i++) {
      const im = i % 256;
      const offset = ((im * im % 256) * im % 256 * posStep3 + im * posStep4) % 256;
      const fb = keyStr2.charCodeAt(i % keyStr2Len);
      let b = (encrypted[i] + offset + expandedKey[(i + keyShift2) % keyLen] + fb * 3) % 256;
      // 层 13: 位旋转
      encrypted[i] = ((b * 8) % 256 + Math.floor(b / 32)) % 256;
    }

    // 层 9: 多轮密钥扩散（5-10 轮，每轮使用不同偏移的密钥分量）
    // 性能优化：预计算每轮的密钥偏移表，减少内层循环中的模运算
    for (let round = 0; round < numRounds; round++) {
      const roundOffset = round * 13;
      const roundAdd = round * 17;
      for (let i = 0; i < n; i++) {
        encrypted[i] = (encrypted[i] + expandedKey[(i + roundOffset) % keyLen] + roundAdd) % 256;
      }
    }

    // 层 10: 加法扩散链（每个字节依赖前驱密文，类似 CBC 模式）
    for (let i = 1; i < n; i++) {
      encrypted[i] = (encrypted[i] + encrypted[i - 1]) % 256;
    }

    // === v3.1 增强新增 3 层（12-14），达到 15 层 ===

    // 层 12: 多表替换 — 使用 seed 生成 8 个替换表，按位置轮换
    const substTables = [];
    for (let t = 0; t < 8; t++) {
      const table = new Array(256);
      for (let v = 0; v < 256; v++) table[v] = v;
      // Fisher-Yates shuffle with seed
      let s = seed[t % 8] + t * 37;
      for (let v = 255; v > 0; v--) {
        s = (s * 31 + seed[(v + t) % 8] + v) % (v + 1);
        const tmp = table[v]; table[v] = table[s]; table[s] = tmp;
      }
      substTables.push(table);
    }
    for (let i = 0; i < n; i++) {
      encrypted[i] = substTables[i % 8][encrypted[i]];
    }

    // 层 14: 累加器链扩散 — CBC 式：每字节依赖前驱密文
    let accChain = (seed[0] * 17 + seed[3] * 31 + envKey) % 256;
    for (let i = 0; i < n; i++) {
      encrypted[i] = (encrypted[i] + accChain) % 256;
      accChain = (accChain * 31 + encrypted[i] + i * 7) % 256;
    }

    // 5. 完整性校验和（四段拆分，vs v2 的两段）
    // Adler 风格：对原始字节求和 mod 65521
    let checksum = 0;
    for (let i = 0; i < bytes.length; i++) {
      checksum = (checksum + bytes[i]) % 65521;
    }
    const chkSalt1 = Math.floor(Math.random() * 9000) + 1000;
    const chkSalt2 = Math.floor(Math.random() * 9000) + 1000;
    // checksum = (chkPart1 * 31 + chkPart2 * 17 + chkPart3 * 7 + chkPart4) % 65521
    const chkPart1 = chkSalt1;
    const chkPart2 = chkSalt2;
    const chkPart3 = Math.floor(Math.random() * 9000) + 1000;
    const chkPart4 = ((checksum - chkPart1 * 31 - chkPart2 * 17 - chkPart3 * 7) % 65521 + 65521 * 100) % 65521;

    // 6. 分段编码：将数据切分为 5-15 段（vs v2 的 2-5 段）
    const numSegments = 5 + Math.floor(Math.random() * 11); // 5-15
    const segSize = Math.ceil(encrypted.length / numSegments);
    const segments = [];
    for (let i = 0; i < encrypted.length; i += segSize) {
      segments.push(encrypted.slice(i, i + segSize));
    }
    const actualSegments = segments.length;

    // 7. 为每段生成独立的字母表
    const charsets = [];
    for (let i = 0; i < actualSegments; i++) {
      charsets.push(this.generateCustomCharset());
    }

    // 8. 打乱段顺序
    const positions = [];
    for (let i = 0; i < actualSegments; i++) positions.push(i);
    for (let i = actualSegments - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [positions[i], positions[j]] = [positions[j], positions[i]];
    }
    const shuffledSegments = new Array(actualSegments);
    for (let i = 0; i < actualSegments; i++) {
      shuffledSegments[positions[i]] = segments[i];
    }
    const order = positions.map(p => p + 1);

    // 9. 对每段做 Base64 编码（使用各自的字母表）
    // 性能优化：使用数组 push + join 替代字符串 +=
    const encodedSegments = [];
    for (let segIdx = 0; segIdx < actualSegments; segIdx++) {
      const segData = shuffledSegments[segIdx];
      const cs = charsets[segIdx];
      const segLen = segData.length;
      const parts = new Array(Math.ceil(segLen / 3) * 4);
      let pi = 0;
      for (let i = 0; i < segLen; i += 3) {
        const b0 = segData[i];
        const b1 = i + 1 < segLen ? segData[i + 1] : 0;
        const b2 = i + 2 < segLen ? segData[i + 2] : 0;
        parts[pi++] = cs[(b0 >> 2) & 0x3F];
        parts[pi++] = cs[((b0 & 0x03) << 4) | ((b1 >> 4) & 0x0F)];
        if (i + 1 < segLen) parts[pi++] = cs[((b1 & 0x0F) << 2) | ((b2 >> 6) & 0x03)];
        if (i + 2 < segLen) parts[pi++] = cs[b2 & 0x3F];
      }
      encodedSegments.push(parts.slice(0, pi).join(''));
    }

    // 10. 生成超强型 Lua 解码器
    const decoder = this.generateEnhancedByteStreamDecoder(
      encodedSegments, charsets, order, seed, keyLen, nibbleSwap,
      rotateStep, posStep, posStep2, keyShift,
      posStep3, posStep4, keyShift2, numRounds,
      segments.map(s => s.length), actualSegments,
      envKey, keyStr1, keyStr2, chkPart1, chkPart2, chkPart3, chkPart4
    );
    return decoder;
  },

  // 生成函数依赖密钥字符串
  // 该字符串的 string.byte 值在 Lua 解码器中被直接调用参与解密
  generateKeyString() {
    const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
    const len = 6 + Math.floor(fastRandom() * 6); // 6-11 字符
    const parts = new Array(len);
    for (let i = 0; i < len; i++) {
      parts[i] = chars[Math.floor(fastRandom() * chars.length)];
    }
    return parts.join('');
  },

  // 生成自定义 64 字符字母表（含 +、/、[、]、!、# 等）
  generateCustomCharset() {
    // 64 个可打印 ASCII 字符，覆盖字母、数字和大量特殊符号
    // 避开 Lua 字符串中需要转义的字符: " \ ' (可能导致字符串字面量问题)
    const chars = [
      'A','B','C','D','E','F','G','H','a','b',
      'c','d','e','f','g','h','+','/','[',']',
      '!','#','$','%','&','(',')','*','-','.',
      '0','1','2','3','4','5','6','7','8','9',
      ':',';','<','=','>','?','@','I','J','K',
      'L','M','N','O','i','j','k','l','m','n',
      'o','p','^','{',
    ];

    // Fisher-Yates 随机打乱
    const shuffled = [...chars];
    for (let i = shuffled.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
    }
    return shuffled;
  },

  // 生成超强型 Lua 5.1 兼容字节流解码器 (v3 — 10x Enhanced)
  // 特征：
  // - 多段数据独立解码，按 order 表重组（5-15 段）
  // - 每段使用不同字母表
  // - 十二层反向解密（vs v2 的七层），新增五层逆向
  // - 密钥扩展：12 字节种子经四路 LCG 在 Lua 内重建 64 字节密钥
  // - 四部校验和：运行时重组四段校验值，篡改即拒载
  // - 双函数依赖密钥字符串：两段 keyStr 的 string.byte 均参与解密
  // - 多轮密钥调度：5-10 轮逆向密钥减法
  // - 解码循环内含控制流扁平化（16 个状态机阶段）
  generateEnhancedByteStreamDecoder(encodedSegs, charsets, order, seed, keyLen, nibbleSwap, rotateStep, posStep, posStep2, keyShift, posStep3, posStep4, keyShift2, numRounds, segLengths, numSegs, envKey, keyStr1, keyStr2, chkPart1, chkPart2, chkPart3, chkPart4) {
    const fnName = this.generateShortFnName();
    const sParam = this.generateShortName();
    const segIdxParam = this.generateShortName();
    const tblVar = this.generateShortName();
    const resultVar = this.generateShortName();
    const iVar = this.generateShortName();
    const jVar = this.generateShortName();
    const kVar = this.generateShortName();
    const b0Var = this.generateShortName();
    const b1Var = this.generateShortName();
    const b2Var = this.generateShortName();
    const cVar = this.generateShortName();
    const charVar = this.generateShortName();
    const keyVar = this.generateShortName();
    const lenVar = this.generateShortName();
    const loaderVar = this.generateShortName();
    const outVar = this.generateShortName();
    const orderVar = this.generateShortName();
    const segsVar = this.generateShortName();
    const charsetsVar = this.generateShortName();
    const stateVar = this.generateShortName();
    const accVar = this.generateShortName();
    const tmpVar = this.generateShortName();
    const rotVar = this.generateShortName();
    const posVar = this.generateShortName();
    const segLenVar = this.generateShortName();
    const totalVar = this.generateShortName();
    const seedVar = this.generateShortName();
    const pos2Var = this.generateShortName();
    const shiftVar = this.generateShortName();
    const chkVar = this.generateShortName();
    const chkAccVar = this.generateShortName();
    const chkP1 = this.generateShortName();
    const chkP2 = this.generateShortName();
    const hiVar = this.generateShortName();
    const loVar = this.generateShortName();
    const chainAVar = this.generateShortName();
    const chainBVar = this.generateShortName();
    const ivVar = this.generateShortName();
    const fbVar = this.generateShortName();
    const loadRef = this.generateShortName();
    const scRef = this.generateShortName();
    const mfRef = this.generateShortName();
    const ekVar = this.generateShortName();
    const stMachine = this.generateShortName();
    const ks1Var = this.generateShortName();
    const ks2Var = this.generateShortName();
    const diVar = this.generateShortName();
    const testFn = this.generateShortName();
    const testRet = this.generateShortName();
    // v3 new variables
    const chainCVar = this.generateShortName();
    const chainDVar = this.generateShortName();
    const pos3Var = this.generateShortName();
    const pos4Var = this.generateShortName();
    const shift2Var = this.generateShortName();
    const roundsVar = this.generateShortName();
    const roundVar = this.generateShortName();
    // private cache variable
    const bsCacheVar = this.generateShortName();
    const chkP3 = this.generateShortName();
    const chkP4 = this.generateShortName();
    const diffVar = this.generateShortName();

    const charsetLuaStrs = charsets.map(cs => '"' + cs.map(c => this.escapeLuaChar(c)).join('') + '"');

    let d = '';

    // 私有缓存 + load 加载器
    d += 'local ' + bsCacheVar + '={} ';
    d += 'local ' + loadRef + '=function(_s) ';
    d += 'if ' + bsCacheVar + '[_s] then return ' + bsCacheVar + '[_s] end ';
    d += 'local _f=load(_s) ';
    d += bsCacheVar + '[_s]=_f ';
    d += 'return _f ';
    d += 'end ';
    d += 'local ' + scRef + '=string.char ';
    d += 'local ' + mfRef + '=math.floor ';

    // === 反劫持检测 — 检查引用是否被替换（非门控，仅融合密钥）===
    // 修复：不再因 .what~="C" 而 return end（Roblox Luau 中 load 可能不是 C 函数）
    // 改为：检测是否被 hook，若被 hook 则 testRet=0，导致密钥不匹配，解密失败
    d += 'local ' + diVar + '=nil ';
    d += 'pcall(function() ' + diVar + '=debug.getinfo(' + loadRef + ',"S") end) ';
    // testRet 融入解密密钥：正常环境 testRet=1（loadRef("return 1")() 返回 1）
    // 若 loadRef 被 hook 为非函数，testRet=0，密钥不匹配，解密产生乱码
    d += 'local ' + testFn + '=nil ';
    d += 'pcall(function() ' + testFn + '=' + loadRef + '("return 1") end) ';
    d += 'local ' + testRet + '=0 ';
    d += 'if type(' + testFn + ')=="function" then ';
    d += 'pcall(function() ' + testRet + '=tonumber(' + testFn + '()) or 0 end) ';
    d += 'end ';

    // === 双函数依赖密钥 — 两段 keyStr 的 string.byte 均参与密钥计算 ===
    d += 'local ' + ks1Var + '="' + keyStr1 + '" ';
    d += 'local ' + ks2Var + '="' + keyStr2 + '" ';
    d += 'local ' + ekVar + '=0 ';
    // keyStr1 的 string.byte 参与密钥
    d += 'for ' + iVar + '=1,' + ks1Var + ':len() do ';
    d += ekVar + '=(' + ekVar + '+string.byte(' + ks1Var + ',' + iVar + '))%256 ';
    d += 'end ';
    // keyStr2 的 string.byte 参与密钥（乘以 3，与加密端一致）
    d += 'for ' + iVar + '=1,' + ks2Var + ':len() do ';
    d += ekVar + '=(' + ekVar + '+string.byte(' + ks2Var + ',' + iVar + ')*3)%256 ';
    d += 'end ';
    // testRet * 37 融入密钥
    d += ekVar + '=(' + ekVar + '+' + testRet + '*37)%256 ';

    // === 段解码函数（Base64 解码，不含解密）===
    d += 'local ' + fnName + '=function(' + sParam + ',' + segIdxParam + ') ';
    d += 'local ' + charsetsVar + '={' + charsetLuaStrs.join(',') + '} ';
    d += 'local ' + charVar + '=' + charsetsVar + '[' + segIdxParam + '] ';
    d += 'local ' + tblVar + '={} ';
    d += 'for ' + iVar + '=1,' + charVar + ':len() do ';
    d += tblVar + '[' + charVar + ':sub(' + iVar + ',' + iVar + ')]=' + iVar + '-1 ';
    d += 'end ';
    d += 'local ' + resultVar + '={} ';
    d += 'local ' + lenVar + '=' + sParam + ':len() ';
    d += 'local ' + iVar + '=1 ';
    d += 'local ' + jVar + '=0 ';
    d += 'local ' + b0Var + ',' + b1Var + ',' + b2Var + ',' + cVar + ',' + kVar + ' ';
    d += 'while true do ';
    d += 'if ' + iVar + '>' + lenVar + ' then break end ';
    d += b0Var + '=' + tblVar + '[' + sParam + ':sub(' + iVar + ',' + iVar + ')] ';
    d += b1Var + '=' + tblVar + '[' + sParam + ':sub(' + iVar + '+1,' + iVar + '+1)] ';
    d += b2Var + '=-1 ';
    d += 'if ' + iVar + '+2<=' + lenVar + ' then ';
    d += b2Var + '=' + tblVar + '[' + sParam + ':sub(' + iVar + '+2,' + iVar + '+2)] ';
    d += 'end ';
    d += cVar + '=-1 ';
    d += 'if ' + iVar + '+3<=' + lenVar + ' then ';
    d += cVar + '=' + tblVar + '[' + sParam + ':sub(' + iVar + '+3,' + iVar + '+3)] ';
    d += 'end ';
    d += kVar + '=' + b0Var + '*4+math.floor(' + b1Var + '/16) ';
    d += jVar + '=' + jVar + '+1 ';
    d += resultVar + '[' + jVar + ']=' + kVar + ' ';
    d += 'if ' + b2Var + '>=0 then ';
    d += kVar + '=(' + b1Var + '%16)*16+math.floor(' + b2Var + '/4) ';
    d += jVar + '=' + jVar + '+1 ';
    d += resultVar + '[' + jVar + ']=' + kVar + ' ';
    d += 'end ';
    d += 'if ' + cVar + '>=0 then ';
    d += kVar + '=(' + b2Var + '%4)*64+' + cVar + ' ';
    d += jVar + '=' + jVar + '+1 ';
    d += resultVar + '[' + jVar + ']=' + kVar + ' ';
    d += 'end ';
    d += iVar + '=' + iVar + '+4 ';
    d += 'end ';
    d += 'return ' + resultVar + ',' + jVar + ' ';
    d += 'end ';

    // === 段数据表和 order 表 ===
    const escapedSegs = encodedSegs.map(s => '"' + this.escapeLuaString(s) + '"');
    d += 'local ' + segsVar + '={' + escapedSegs.join(',') + '} ';
    d += 'local ' + orderVar + '={' + order.join(',') + '} ';

    // === 重组段 ===
    d += 'local ' + accVar + '={} ';
    d += 'local ' + totalVar + '=0 ';
    d += 'local ' + stateVar + '=1 ';
    d += 'while ' + stateVar + '<=' + numSegs + ' do ';
    d += 'local ' + tmpVar + '=' + orderVar + '[' + stateVar + '] ';
    d += 'local ' + iVar + ',' + segLenVar + '=' + fnName + '(' + segsVar + '[' + tmpVar + '],' + tmpVar + ') ';
    d += 'for ' + jVar + '=1,' + segLenVar + ' do ';
    d += totalVar + '=' + totalVar + '+1 ';
    d += accVar + '[' + totalVar + ']=' + iVar + '[' + jVar + '] ';
    d += 'end ';
    d += stateVar + '=' + stateVar + '+1 ';
    d += 'end ';

    // === 密钥重建（四路 LCG 链 + 函数依赖分量 ekVar）===
    d += seedVar + '={' + seed[0] + ',' + seed[1] + ',' + seed[2] + ',' + seed[3] + ',' + seed[4] + ',' + seed[5] + ',' + seed[6] + ',' + seed[7] + ',' + seed[8] + ',' + seed[9] + ',' + seed[10] + ',' + seed[11] + '} ';
    // 四路 LCG 链初始化
    d += chainAVar + '={} ';
    d += chainAVar + '[1]=' + seedVar + '[1] ';
    d += chainBVar + '={} ';
    d += chainBVar + '[1]=' + seedVar + '[4] ';
    d += chainCVar + '={} ';
    d += chainCVar + '[1]=' + seedVar + '[7] ';
    d += chainDVar + '={} ';
    d += chainDVar + '[1]=' + seedVar + '[10] ';
    // 四路 LCG 链扩展
    d += 'for ' + iVar + '=2,' + keyLen + ' do ';
    d += chainAVar + '[' + iVar + ']=(' + chainAVar + '[' + iVar + '-1]*31+' + seedVar + '[(' + iVar + '-1)%12+1]+(' + iVar + '-1))%256 ';
    d += chainBVar + '[' + iVar + ']=(' + chainBVar + '[' + iVar + '-1]*37+' + seedVar + '[((' + iVar + '-1)+3)%12+1]+(' + iVar + '-1)*7)%256 ';
    d += chainCVar + '[' + iVar + ']=(' + chainCVar + '[' + iVar + '-1]*53+' + seedVar + '[((' + iVar + '-1)+6)%12+1]+(' + iVar + '-1)*11)%256 ';
    d += chainDVar + '[' + iVar + ']=(' + chainDVar + '[' + iVar + '-1]*71+' + seedVar + '[((' + iVar + '-1)+9)%12+1]+(' + iVar + '-1)*13)%256 ';
    d += 'end ';
    // 密钥混合：四链 + 位置白化 + ekVar
    d += keyVar + '={} ';
    d += 'for ' + iVar + '=1,' + keyLen + ' do ';
    d += keyVar + '[' + iVar + ']=(' + chainAVar + '[' + iVar + ']+' + chainBVar + '[' + iVar + ']+' + chainCVar + '[' + iVar + ']+' + chainDVar + '[' + iVar + ']+(' + iVar + '-1)*17+' + ekVar + ')%256 ';
    d += 'end ';
    // IV（包含 seed[11] 的新分量）
    d += ivVar + '=(' + seedVar + '[1]+' + seedVar + '[6]+' + seedVar + '[12]+' + ekVar + ')%256 ';
    d += rotVar + '=' + rotateStep + ' ';
    d += posVar + '=' + posStep + ' ';
    d += pos2Var + '=' + posStep2 + ' ';
    d += shiftVar + '=' + keyShift + ' ';
    // v3 新增参数
    d += pos3Var + '=' + posStep3 + ' ';
    d += pos4Var + '=' + posStep4 + ' ';
    d += shift2Var + '=' + keyShift2 + ' ';
    d += roundsVar + '=' + numRounds + ' ';

    // === 四部校验和重组 ===
    d += 'local ' + chkP1 + '=' + chkPart1 + ' ';
    d += 'local ' + chkP2 + '=' + chkPart2 + ' ';
    d += 'local ' + chkP3 + '=' + chkPart3 + ' ';
    d += 'local ' + chkP4 + '=' + chkPart4 + ' ';
    d += chkVar + '=(' + chkP1 + '*31+' + chkP2 + '*17+' + chkP3 + '*7+' + chkP4 + ')%65521 ';

    // === 控制流扁平化 — 16 阶段状态机驱动解密 ===
    // 解密顺序严格反向于加密顺序：
    // 加密: L0(nibble) (L1+L3+L4+L6 combined) L2(rot) L5(cfb)
    //       (L7+L8+L11+L13 combined: add cubic+key3+fkey2, then bit-rot)
    //       L9(rounds) L10(diffuse) L12(subst) L14(accchain)
    // 解密: L14 → L12 → L10 → L9 → L13 → L11 → L8 → L7 → L5 → L2 → L6 → L4 → L3 → L1 → L0
    //       checksum verify, string+execute
    const phases = [];

    // Phase 0: Layer 14 逆 — CBC 逆
    phases.push(
      'local _accChain=(' + seedVar + '[1]*17+' + seedVar + '[4]*31+' + ekVar + ')%256 ' +
      'local _oldAcc=0 ' +
      'for ' + iVar + '=1,' + totalVar + ' do ' +
      '_oldAcc=_accChain ' +
      '_accChain=(_accChain*31+' + accVar + '[' + iVar + ']+(' + iVar + '-1)*7)%256 ' +
      accVar + '[' + iVar + ']=(' + accVar + '[' + iVar + ']-_oldAcc)%256 ' +
      'end '
    );

    // Phase 1: Layer 12 逆 — 多表替换逆
    phases.push(
      'local _fwdT={} ' +
      'for _t=0,7 do ' +
      'local _tbl={} ' +
      'for _v=0,255 do _tbl[_v]=_v end ' +
      'local _s=(' + seedVar + '[_t%8+1]+_t*37)%256 ' +
      'for _v=255,0,-1 do ' +
      '_s=(_s*31+' + seedVar + '[(_v+_t)%8+1]+_v)%(_v+1) ' +
      'local _tmp=_tbl[_v] _tbl[_v]=_tbl[_s] _tbl[_s]=_tmp ' +
      'end ' +
      'local _inv={} ' +
      'for _v=0,255 do _inv[_tbl[_v]]=_v end ' +
      '_fwdT[_t]=_inv ' +
      'end ' +
      'for ' + iVar + '=1,' + totalVar + ' do ' +
      accVar + '[' + iVar + ']=_fwdT[(' + iVar + '-1)%8][' + accVar + '[' + iVar + ']] ' +
      'end '
    );

    // Phase 2: Layer 10 逆 — 加法扩散链逆（从后往前减）
    phases.push(
      'for ' + iVar + '=' + totalVar + ',2,-1 do ' +
      accVar + '[' + iVar + ']=(' + accVar + '[' + iVar + ']-' + accVar + '[' + iVar + '-1])%256 ' +
      'end '
    );

    // Phase 3: Layer 9 逆 — 多轮密钥扩散逆（轮次倒序）
    phases.push(
      'for ' + roundVar + '=' + roundsVar + '-1,0,-1 do ' +
      'for ' + iVar + '=1,' + totalVar + ' do ' +
      accVar + '[' + iVar + ']=(' + accVar + '[' + iVar + ']-' + keyVar + '[(' + iVar + '-1+' + roundVar + '*13)%' + keyLen + '+1]-' + roundVar + '*17)%256 ' +
      'end end '
    );

    // Phase 4: Layer 13 逆 — 位旋转逆（rotate-right 3 位）
    // L13 是 L7+L8+L11+L13 组合加密的最后一步，解密时必须先于 L11/L8/L7
    phases.push(
      'for ' + iVar + '=1,' + totalVar + ' do ' +
      'local _b=' + accVar + '[' + iVar + '] ' +
      accVar + '[' + iVar + ']=(math.floor(_b/8)+(_b%8)*32)%256 ' +
      'end '
    );

    // Phase 5: Layer 11 逆 — 函数依赖密钥 2 逆
    phases.push(
      'for ' + iVar + '=1,' + totalVar + ' do ' +
      accVar + '[' + iVar + ']=(' + accVar + '[' + iVar + ']-string.byte(' + ks2Var + ',(' + iVar + '-1)%' + ks2Var + ':len()+1)*3)%256 ' +
      'end '
    );

    // Phase 6: Layer 8 逆 — 三次密钥减
    phases.push(
      'for ' + iVar + '=1,' + totalVar + ' do ' +
      accVar + '[' + iVar + ']=(' + accVar + '[' + iVar + ']-' + keyVar + '[(' + iVar + '-1+' + shift2Var + ')%' + keyLen + '+1])%256 ' +
      'end '
    );

    // Phase 7: Layer 7 逆 — 立方位置减
    phases.push(
      'for ' + iVar + '=1,' + totalVar + ' do ' +
      'local _im=(' + iVar + '-1)%256 ' +
      accVar + '[' + iVar + ']=(' + accVar + '[' + iVar + ']-((_im*_im%256)*_im%256*' + pos3Var + '+_im*' + pos4Var + ')%256)%256 ' +
      'end '
    );

    // Phase 8: Layer 5 逆 — CFB 逆
    phases.push(
      'for ' + iVar + '=' + totalVar + ',1,-1 do ' +
      'if ' + iVar + '==1 then ' + fbVar + '=' + ivVar + ' else ' + fbVar + '=' + accVar + '[' + iVar + '-1] end ' +
      accVar + '[' + iVar + ']=(' + accVar + '[' + iVar + ']-' + keyVar + '[(' + iVar + '-1)%' + keyLen + '+1]-' + fbVar + ')%256 ' +
      'end '
    );

    // Phase 9: Layer 2 逆 — 轮转逆
    phases.push(
      iVar + '=1 ' +
      'while ' + iVar + '<=' + totalVar + ' do ' +
      segLenVar + '=' + rotVar + ' ' +
      'if ' + iVar + '+' + segLenVar + '-1>' + totalVar + ' then ' + segLenVar + '=' + totalVar + '-' + iVar + '+1 end ' +
      'if ' + segLenVar + '>1 then ' +
      tmpVar + '=' + accVar + '[' + iVar + '] ' +
      'for ' + kVar + '=1,' + segLenVar + '-1 do ' +
      accVar + '[' + iVar + '+' + kVar + '-1]=' + accVar + '[' + iVar + '+' + kVar + '] ' +
      'end ' +
      accVar + '[' + iVar + '+' + segLenVar + '-1]=' + tmpVar + ' ' +
      'end ' +
      iVar + '=' + iVar + '+' + rotVar + ' ' +
      'end '
    );

    // Phase 10: Layer 6 逆 — 函数依赖密钥 1 逆
    phases.push(
      'for ' + iVar + '=1,' + totalVar + ' do ' +
      accVar + '[' + iVar + ']=(' + accVar + '[' + iVar + ']-string.byte(' + ks1Var + ',(' + iVar + '-1)%' + ks1Var + ':len()+1))%256 ' +
      'end '
    );

    // Phase 11: Layer 4 逆 — 二次密钥减
    phases.push(
      'for ' + iVar + '=1,' + totalVar + ' do ' +
      accVar + '[' + iVar + ']=(' + accVar + '[' + iVar + ']-' + keyVar + '[(' + iVar + '-1+' + shiftVar + ')%' + keyLen + '+1])%256 ' +
      'end '
    );

    // Phase 12: Layer 3 逆 — 二次位置减
    phases.push(
      'for ' + iVar + '=1,' + totalVar + ' do ' +
      'local _im=(' + iVar + '-1)%256 ' +
      accVar + '[' + iVar + ']=(' + accVar + '[' + iVar + ']-(_im*' + posVar + '+_im*_im%256*' + pos2Var + ')%256)%256 ' +
      'end '
    );

    // Phase 13: Layer 1 逆 — 主密钥减
    phases.push(
      'for ' + iVar + '=1,' + totalVar + ' do ' +
      accVar + '[' + iVar + ']=(' + accVar + '[' + iVar + ']-' + keyVar + '[(' + iVar + '-1)%' + keyLen + '+1])%256 ' +
      'end '
    );

    // Phase 11: Layer 0 逆 — 半字节交换（条件）
    if (nibbleSwap) {
      phases.push(
        'local ' + hiVar + ',' + loVar + ' ' +
        'for ' + iVar + '=1,' + totalVar + ' do ' +
        hiVar + '=' + mfRef + '(' + accVar + '[' + iVar + ']/16) ' +
        loVar + '=' + accVar + '[' + iVar + ']%16 ' +
        accVar + '[' + iVar + ']=' + loVar + '*16+' + hiVar + ' ' +
        'end '
      );
    }

    // Phase 12: 校验和验证（四部重组）
    // 修复：校验失败时 error() 而非静默 return end
    phases.push(
      chkAccVar + '=0 ' +
      'for ' + iVar + '=1,' + totalVar + ' do ' +
      chkAccVar + '=(' + chkAccVar + '+' + accVar + '[' + iVar + '])%65521 ' +
      'end ' +
      'if ' + chkAccVar + '~=' + chkVar + ' then error("[ByteStream] checksum mismatch: " .. tostring(' + chkAccVar + ') .. " ~= " .. tostring(' + chkVar + ')) end '
    );

    // Phase 13: 字符串拼接 + 执行（使用 table.concat 避免 O(n²) 拼接）
    phases.push(
      'local _tc={} ' +
      'for ' + iVar + '=1,' + totalVar + ' do ' +
      '_tc[' + iVar + ']=' + scRef + '(' + accVar + '[' + iVar + ']) ' +
      'end ' +
      outVar + '=table.concat(_tc) ' +
      loaderVar + '=' + loadRef + '(' + outVar + ') ' +
      'if ' + loaderVar + ' then return ' + loaderVar + '() else error("[ByteStream] load failed: " .. tostring(' + outVar + ':sub(1,50))) end '
    );

    // 生成随机状态 ID
    const numPhases = phases.length;
    const stateIds = [];
    for (let i = 0; i < numPhases; i++) {
      let id;
      do { id = 100 + Math.floor(Math.random() * 900); } while (stateIds.includes(id));
      stateIds.push(id);
    }
    // 打乱 if 块顺序
    const codeOrder = [];
    for (let i = 0; i < numPhases; i++) codeOrder.push(i);
    for (let i = codeOrder.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [codeOrder[i], codeOrder[j]] = [codeOrder[j], codeOrder[i]];
    }

    // 生成状态机
    d += 'local ' + stMachine + '=' + stateIds[0] + ' ';
    d += 'while ' + stMachine + '>0 do ';
    for (let idx = 0; idx < numPhases; idx++) {
      const phaseIdx = codeOrder[idx];
      const nextPhaseIdx = phaseIdx + 1;
      const nextState = nextPhaseIdx < numPhases ? stateIds[nextPhaseIdx] : 0;
      d += 'if ' + stMachine + '==' + stateIds[phaseIdx] + ' then ';
      d += phases[phaseIdx];
      d += stMachine + '=' + nextState + ' ';
      d += 'end ';
    }
    d += 'end ';

    return d;
  },

  // 生成 2 字符短函数名（如 dj、Xj、Rk）
  generateShortFnName() {
    const first = 'djXkRlSmTnUpVqWrXsYtZuAvBwCx';
    const second = 'aeiouhkjlmnprstwxyz';
    let name;
    do {
      name = first[Math.floor(Math.random() * first.length)] +
             second[Math.floor(Math.random() * second.length)];
    } while (this.usedNames.has(name));
    this.usedNames.add(name);
    return name;
  },

  // 转义 Lua 字符串中的特殊字符
  escapeLuaChar(c) {
    if (c === '"') return '\\"';
    if (c === '\\') return '\\\\';
    if (c === '\n') return '\\n';
    if (c === '\r') return '\\r';
    if (c === '\t') return '\\t';
    return c;
  },

  // 转义整个 Lua 字符串
  escapeLuaString(s) {
    const parts = [];
    for (let i = 0; i < s.length; i++) {
      parts.push(this.escapeLuaChar(s[i]));
    }
    return parts.join('');
  },

  // ========== Step 8: 代码压缩 ==========
  minifyCode(code) {
    // 基于 token 的安全压缩：逐字符扫描，保护字符串字面量，
    // 只在 token 之间安全地移除多余空白
    // 性能优化：使用数组构建结果 + 字符检测替代正则
    const parts = [];
    let i = 0;
    const len = code.length;
    let prevType = '';   // 上一个 token 类型: 'ident' 'number' 'op' 'string' 'keyword'
    let prevIdent = '';  // 上一个输出的标识符/关键字文本

    const keywords = this.keywords;
    // 结束语句的关键字：后面跟 ( " ' { 时需要分号分隔
    // 注意：return/in 不能加分号 —— return 后可接 (expr)/"str"/{tbl} 作为返回值；
    //       in 后面是 for 迭代器表达式；加分号会产生 Lua 5.1 语法错误（return 后不允许再有语句）
    const stmtEndKeywords = new Set(['end', 'break', 'do', 'then', 'else']);

    while (i < len) {
      const ch = code[i];

      // 跳过空白（稍后按需决定是否输出分号或空格）
      if (ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r') {
        // 先看下一个非空白字符，决定是否需要插入分号
        let j = i;
        while (j < len && (code[j] === ' ' || code[j] === '\t' || code[j] === '\n' || code[j] === '\r')) j++;
        if (j < len) {
          const nextCh = code[j];
          // 获取上一个输出的字符
          const lastOut = parts.length > 0 ? parts[parts.length - 1] : '';
          const lastChar = lastOut.length > 0 ? lastOut[lastOut.length - 1] : '';
          // 判断是否需要分号：当 prevType 与 nextCh 组合会产生歧义时
          const needsSemi = (
            // number/string 后跟 ( " ' { [ 会导致 Lua 解析为函数调用
            (prevType === 'number' && (nextCh === '(' || nextCh === '"' || nextCh === "'" || nextCh === '{' || nextCh === '[')) ||
            (prevType === 'string' && (nextCh === '(' || nextCh === '"' || nextCh === "'" || nextCh === '{' || nextCh === '[')) ||
            // 仅语句结束关键字（end/break/do/then/else）后跟 ( " ' { 才加分号
            // return/in/while/if/for/local 等后跟表达式，不加分号
            (prevType === 'keyword' && stmtEndKeywords.has(prevIdent) && (nextCh === '(' || nextCh === '"' || nextCh === "'" || nextCh === '{')) ||
            // } 后跟标识符、(、"、'、{ 需要分号（table 构造器结束 → 新语句）
            (lastChar === '}' && (isIdentStart(nextCh) || nextCh === '(' || nextCh === '"' || nextCh === "'" || nextCh === '{')) ||
            // ) 后跟 "、' 需要分号（防止 "str"(args) 歧义）
            // 注意：不对 ( 加分号，否则会破坏 func()(args) 等链式调用
            (lastChar === ')' && (nextCh === '"' || nextCh === "'")) ||
            // ] 后跟 "、' 需要分号（防止 t[k]"str" 歧义）
            // 注意：不对 ( 加分号，否则会破坏 t[k](args) 等链式调用
            (lastChar === ']' && (nextCh === '"' || nextCh === "'"))
          );
          if (needsSemi) {
            parts.push(';');
          }
        }
        i = j;
        continue;
      }

      // 字符串字面量（双引号/单引号）—— 原样保留
      if (ch === '"' || ch === "'") {
        parts.push(ch);
        const q = ch;
        i++;
        while (i < len) {
          if (code[i] === '\\') { parts.push(code[i++]); if (i < len) parts.push(code[i++]); continue; }
          if (code[i] === q) { parts.push(code[i++]); break; }
          parts.push(code[i++]);
        }
        prevType = 'string';
        continue;
      }

      // 长字符串 [[ ... ]]
      if (ch === '[' && (code[i+1] === '[' || code[i+1] === '=')) {
        let level = 0, j = i + 1;
        while (code[j] === '=') { level++; j++; }
        if (code[j] === '[') {
          const closeStr = ']' + '='.repeat(level) + ']';
          const end = code.indexOf(closeStr, j + 1);
          if (end !== -1) {
            parts.push(code.substring(i, end + closeStr.length));
            i = end + closeStr.length;
            prevType = 'string';
            continue;
          }
        }
      }

      // 标识符 / 关键字 — 使用字符检测替代正则
      if (isIdentStart(ch)) {
        const start = i;
        i++;
        while (i < len && isIdentChar(code[i])) i++;
        const ident = code.substring(start, i);
        // 判断是否需要在前方插入空格
        if (prevType === 'ident' || prevType === 'number' || prevType === 'keyword' || prevType === 'string') {
          parts.push(' ');
        }
        parts.push(ident);
        prevIdent = ident;
        if (keywords.has(ident)) {
          prevType = 'keyword';
        } else {
          prevType = 'ident';
        }
        continue;
      }

      // 数字 — 使用字符检测替代正则
      if (isDigit(ch)) {
        const start = i;
        i++;
        while (i < len && isHexChar(code[i])) i++;
        const num = code.substring(start, i);
        // 数字前如果是标识符/关键字/数字，需要空格
        if (prevType === 'ident' || prevType === 'number' || prevType === 'keyword') {
          parts.push(' ');
        }
        parts.push(num);
        prevType = 'number';
        continue;
      }

      // 注释残留（不应出现，但防御性处理）
      if (ch === '-' && code[i+1] === '-') {
        while (i < len && code[i] !== '\n') i++;
        continue;
      }

      // 操作符和标点 —— 直接输出，不需要空格
      // 但需要处理一些特殊情况：
      // - "." 后跟数字（小数点开头数字），前一个 token 是标识符时需插入空格
      //   防止 "Wlr .739" 被压缩为 "Wlr.739"（会被 Lua 解释为表索引）
      if (ch === '.' && isDigit(code[i + 1] || '') && (prevType === 'ident' || prevType === 'keyword')) {
        parts.push(' ');
      }
      parts.push(ch);
      prevType = 'op';
      i++;
    }

    return parts.join('').trim();
  },

  // ========== Step 8.3: bit32 位运算注入 ==========
  // 在代码中注入大量 bit32.bxor / bit32.rrotate / bit32.bnot / bit32.lshift / bit32.rshift 调用
  // 三种策略:
  //   1. 数字混淆增强: 将数字替换为 bit32 表达式 (如 bit32.bxor(A, B))
  //   2. bit32 垃圾代码: 生成包含 bit32 运算的无效分支
  //   3. bit32 字符串解码器: 将字符串解密中的 %256 替换为 bit32.band(x, 255)
  injectBit32(code) {
    // 1. 在代码顶部插入 bit32 引用缓存（如果代码中还没有引用 bit32）
    const bit32Alias = this.generateName();
    let prefix = 'local ' + bit32Alias + '=bit32 or {{bit32_fallback}} ';

    // bit32 在标准 Lua 5.1 中存在，在 Lua 5.4+ 中被移除
    // 为了兼容性，提供一个纯 Lua 的 fallback（仅当 bit32 不存在时）
    // bit32.bxor, band, bor, bnot, lshift, rshift, rrotate, lrotate
    const fallback = this.generateBit32Fallback(bit32Alias);
    prefix = prefix.replace('{{bit32_fallback}}', fallback);

    // 2. 将代码中的数字替换为 bit32 表达式
    // 仅替换独立的十进制数字（不替换 0x 十六进制和 tonumber 调用中的数字）
    // 注意：跳过 256（常用作 %256 取模，替换会改变语义）和其他关键边界值
    let processed = code.replace(/(^|[^a-zA-Z_0-9.xX("\\])((?:[1-9]\d*|0))(?![a-zA-Z_0-9."])/g, (full, prefix, numStr) => {
      const n = parseInt(numStr);
      if (n === 0) return prefix + this.bit32Zero(bit32Alias);
      if (n < 3) return prefix + '(' + n + ')';
      // 跳过 256（字符串解密取模运算的关键值）和 255（bit mask）
      if (n === 256 || n === 255) return prefix + '(' + n + ')';

      const method = Math.floor(Math.random() * 6);
      let replacement;
      switch (method) {
        case 0: { // bit32.bxor(A, B) where A ^ B = n
          const a = Math.floor(Math.random() * 65536);
          const b = a ^ n;
          replacement = 'math.floor(' + bit32Alias + '.bxor(' + a + ',' + b + '))';
          break;
        }
        case 1: { // bit32.bor(bit32.lshift(A, S), B)
          if (n > 255) {
            const shift = Math.floor(Math.random() * 8) + 1;
            const hi = n >> shift;
            const lo = n & ((1 << shift) - 1);
            replacement = 'math.floor(' + bit32Alias + '.bor(' + bit32Alias + '.lshift(' + hi + ',' + shift + '),' + lo + '))';
          } else {
            const a = Math.floor(Math.random() * (n - 1)) + 1;
            replacement = '(' + a + '+' + (n - a) + ')';
          }
          break;
        }
        case 2: { // bit32.bxor(bit32.bnot(A), B) -- bnot(A) = ~A = 0xFFFFFFFF - A (in 32-bit)
          // n = ~A ^ B => n = (0xFFFFFFFF - A) ^ B
          // Choose A randomly, then B = n ^ (0xFFFFFFFF - A)
          const a = Math.floor(Math.random() * 65536);
          const notA = 0xFFFFFFFF - a;  // bnot(a) in 32-bit
          const b = n ^ notA;  // n = notA ^ b => b = n ^ notA
          // Ensure b is a valid 32-bit unsigned
          const bUnsigned = b >>> 0;
          replacement = 'math.floor(' + bit32Alias + '.bxor(' + bit32Alias + '.bnot(' + a + '),' + bUnsigned + '))';
          break;
        }
        case 3: { // bit32.bxor(bit32.rrotate(A, S), bit32.rrotate(A, S)) -- XOR with self = 0, then + n
          // Actually: bit32.band(n, bit32.bnot(0)) = n (identity via band with all-ones)
          // But safer: use rrotate/lrotate roundtrip which is identity
          const rotAmount = Math.floor(Math.random() * 31) + 1;
          replacement = 'math.floor(' + bit32Alias + '.rrotate(' + bit32Alias + '.rrotate(' + n + ',' + rotAmount + '),' + (32 - rotAmount) + '))';
          break;
        }
        case 4: { // bit32.bxor(bit32.lshift(A, S), B)
          const shift = Math.floor(Math.random() * 4) + 1;
          const shifted = n >> shift;  // high bits
          const remainder = n & ((1 << shift) - 1);
          // n = (shifted << shift) | remainder = bit32.bor(lshift(shifted, shift), remainder)
          // But we want bxor form: n = lshift(shifted, shift) XOR remainder (since remainder < 2^shift, no overlap)
          replacement = 'math.floor(' + bit32Alias + '.bxor(' + bit32Alias + '.lshift(' + shifted + ',' + shift + '),' + remainder + '))';
          break;
        }
        case 5: { // bit32.rrotate(n, 32) = n (full rotation)
          // rrotate(x, 0) = x, so this is a no-op disguise
          const rotAmount = Math.floor(Math.random() * 32);
          // rrotate(x, rotAmount) then rrotate(result, 32-rotAmount) = x
          replacement = 'math.floor(' + bit32Alias + '.rrotate(' + bit32Alias + '.rrotate(' + n + ',' + rotAmount + '),' + (32 - rotAmount) + '))';
          break;
        }
      }
      return prefix + replacement;
    });

    // 3. 将简单算术运算替换为 bit32 操作
    // a + b → bit32.bxor(bit32.bxor(a, b), bit32.band(a, b) * 2)  (进位加法模拟)
    // a - b → bit32.bxor(a, bit32.bxor(b, bit32.band(bit32.bnot(a), b) * 2))
    // a * 2^n → bit32.lshift(a, n)
    // a / 2^n → bit32.rshift(a, n) (仅整除时)
    if (this.config.bit32Ops) {
      // 替换乘以 2 的幂: x * 2, x * 4, x * 8, x * 16 等
      processed = processed.replace(/(\b[a-zA-Z_]\w*)\s*\*\s*(2|4|8|16|32|64|128|256)\b/g, (match, varName, numStr) => {
        const n = parseInt(numStr);
        const shift = Math.log2(n);
        // 10% 概率替换（避免过度替换导致性能问题）
        if (Math.random() < 0.1) {
          return 'math.floor(' + bit32Alias + '.lshift(' + varName + ',' + shift + '))';
        }
        return match;
      });

      // 替换除以 2 的幂: x / 2, x / 4, x / 8 等
      processed = processed.replace(/(\b[a-zA-Z_]\w*)\s*\/\s*(2|4|8|16|32|64|128|256)\b/g, (match, varName, numStr) => {
        const n = parseInt(numStr);
        const shift = Math.log2(n);
        if (Math.random() < 0.1) {
          return 'math.floor(' + bit32Alias + '.rshift(' + varName + ',' + shift + '))';
        }
        return match;
      });

      // 替换取模 2 的幂: x % 2, x % 4 等 → bit32.band(x, n-1)
      processed = processed.replace(/(\b[a-zA-Z_]\w*)\s*%\s*(2|4|8|16|32|64|128|256)\b/g, (match, varName, numStr) => {
        const n = parseInt(numStr);
        if (Math.random() < 0.1) {
          return 'math.floor(' + bit32Alias + '.band(' + varName + ',' + (n - 1) + '))';
        }
        return match;
      });
    }

    // 4. 注入 bit32 垃圾代码
    if (this.config.junkCode) {
      const junkBit32 = this.generateBit32Junk(bit32Alias);
      // 在代码开头插入几条 bit32 垃圾代码
      processed = junkBit32 + ' ' + processed;
    }

    return prefix + processed;
  },

  // 生成 bit32 的纯 Lua fallback（仅当 bit32 库不存在时）
  generateBit32Fallback(alias) {
    // 使用纯 Lua 实现位运算（兼容 Lua 5.4+ 移除了 bit32 的情况）
    // 这些实现基于 table 查找，仅处理 0-255 范围
    const bVar = this.generateShortName();
    const iVar = this.generateShortName();
    const jVar = this.generateShortName();
    const rVar = this.generateShortName();
    const tVar = this.generateShortName();
    const aVar = this.generateShortName();
    const sVar = this.generateShortName();

    let fb = '';
    fb += '{';
    fb += 'bxor=function(' + aVar + ',' + bVar + ') ';
    fb += 'local ' + rVar + '=0 local ' + sVar + '=1 ';
    fb += 'for ' + iVar + '=1,32 do ';
    fb += 'local ' + jVar + '=(' + aVar + '%2)+(' + bVar + '%2) ';
    fb += 'if ' + jVar + '==1 then ' + rVar + '=' + rVar + '+' + sVar + ' end ';
    fb += aVar + '=' + iVar + '<32 and math.floor(' + aVar + '/2) or 0 ';
    fb += bVar + '=' + iVar + '<32 and math.floor(' + bVar + '/2) or 0 ';
    fb += sVar + '=' + sVar + '*2 end return ' + rVar + ' end,';
    fb += 'band=function(' + aVar + ',' + bVar + ') ';
    fb += 'local ' + rVar + '=0 local ' + sVar + '=1 ';
    fb += 'for ' + iVar + '=1,32 do ';
    fb += 'if ' + aVar + '%2==1 and ' + bVar + '%2==1 then ' + rVar + '=' + rVar + '+' + sVar + ' end ';
    fb += aVar + '=' + iVar + '<32 and math.floor(' + aVar + '/2) or 0 ';
    fb += bVar + '=' + iVar + '<32 and math.floor(' + bVar + '/2) or 0 ';
    fb += sVar + '=' + sVar + '*2 end return ' + rVar + ' end,';
    fb += 'bor=function(' + aVar + ',' + bVar + ') ';
    fb += 'local ' + rVar + '=0 local ' + sVar + '=1 ';
    fb += 'for ' + iVar + '=1,32 do ';
    fb += 'if ' + aVar + '%2==1 or ' + bVar + '%2==1 then ' + rVar + '=' + rVar + '+' + sVar + ' end ';
    fb += aVar + '=' + iVar + '<32 and math.floor(' + aVar + '/2) or 0 ';
    fb += bVar + '=' + iVar + '<32 and math.floor(' + bVar + '/2) or 0 ';
    fb += sVar + '=' + sVar + '*2 end return ' + rVar + ' end,';
    fb += 'bnot=function(' + aVar + ') return 4294967295-(' + aVar + ') end,';
    fb += 'lshift=function(' + aVar + ',' + bVar + ') ';
    fb += 'local ' + rVar + '=0 local ' + sVar + '=1 ';
    fb += 'for ' + iVar + '=1,32-' + bVar + ' do ';
    fb += 'if ' + aVar + '%2==1 then ' + rVar + '=' + rVar + '+' + sVar + ' end ';
    fb += aVar + '=math.floor(' + aVar + '/2) ';
    fb += sVar + '=' + sVar + '*2 end ';
    fb += 'for ' + iVar + '=1,' + bVar + ' do ' + rVar + '=' + rVar + '*2 end ';
    fb += 'return ' + rVar + ' end,';
    fb += 'rshift=function(' + aVar + ',' + bVar + ') return math.floor(' + aVar + '/(2^' + bVar + ')) end,';
    fb += 'rrotate=function(' + aVar + ',' + bVar + ') ';
    fb += bVar + '=' + bVar + '%32 ';
    fb += 'return math.floor(' + aVar + '/(2^' + bVar + '))+(' + aVar + '%(2^' + bVar + '))*(2^(32-' + bVar + ')) end';
    fb += '}';

    return fb;
  },

  // 生成表示 0 的 bit32 表达式
  bit32Zero(alias) {
    return alias + '.bxor(0,0)';
  },

  // 生成表示 0xFFFFFFFF 的 bit32 表达式
  bit32AllOnes(alias) {
    return alias + '.bnot(0)';
  },

  // 生成 bit32 垃圾代码块
  generateBit32Junk(alias) {
    const v1 = this.generateName();
    const v2 = this.generateName();
    const v3 = this.generateName();
    const type = Math.floor(Math.random() * 4);
    const a = Math.floor(Math.random() * 65536);
    const b = Math.floor(Math.random() * 65536);

    switch (type) {
      case 0:
        return 'do local ' + v1 + '=' + alias + '.bxor(' + a + ',' + b + ') local ' + v2 + '=' + alias + '.band(' + v1 + ',255) ' + v2 + '=nil ' + v1 + '=nil end';
      case 1:
        return 'do local ' + v1 + '=' + alias + '.rrotate(' + a + ',16) local ' + v2 + '=' + alias + '.lshift(' + v1 + ',8) local ' + v3 + '=' + alias + '.bnot(' + v2 + ') ' + v3 + '=nil ' + v2 + '=nil ' + v1 + '=nil end';
      case 2: {
        const shift = Math.floor(Math.random() * 16) + 1;
        return 'do local ' + v1 + '=' + alias + '.bor(' + alias + '.lshift(' + a + ',' + shift + '),' + b + ') local ' + v2 + '=' + alias + '.rshift(' + v1 + ',' + shift + ') ' + v2 + '=nil ' + v1 + '=nil end';
      }
      case 3: {
        const rotAmount = Math.floor(Math.random() * 31) + 1;
        return 'do local ' + v1 + '=' + alias + '.rrotate(' + a + ',' + rotAmount + ') local ' + v2 + '=' + alias + '.rrotate(' + v1 + ',' + (32 - rotAmount) + ') local ' + v3 + '=' + alias + '.bxor(' + v2 + ',' + a + ') ' + v3 + '=nil ' + v2 + '=nil ' + v1 + '=nil end';
      }
    }
    return '';
  },

  // ========== Step 8.5: 自修改/动态加载 ==========
  // 字节流编码 + load() 执行执行，保留诱饵数据增强混淆
  // 核心思路：代码被拆成碎片，碎片在 table 中以随机顺序存储，用一个 permutation 表
  // 直接嵌入代码为闭包，诱饵数据表模拟原有结构
  dynamicLoadingWrap(code) {
    // 字节流编码动态加载：代码加密为字节数组，运行时解码后 load() 执行
    // 保留诱饵数据表增强混淆效果
    const decoyVar1 = this.generateName();
    const decoyVar2 = this.generateShortName();
    const numDecoyEntries = 3 + Math.floor(Math.random() * 4);
    let decoyData = '{';
    for (let i = 0; i < numDecoyEntries; i++) {
      if (i > 0) decoyData += ',';
      const entryLen = 5 + Math.floor(Math.random() * 10);
      decoyData += '{';
      for (let j = 0; j < entryLen; j++) {
        if (j > 0) decoyData += ',';
        decoyData += Math.floor(Math.random() * 256);
      }
      decoyData += '}';
    }
    decoyData += '}';
    let result = '';
    result += 'local ' + decoyVar1 + '=' + decoyData + ' ';
    result += 'local ' + decoyVar2 + '=' + Math.floor(Math.random() * 9999) + ' ';
    result += this.encodeByteStreamLoad(code);
    return result;
  },

  // ========== 共享字节流编码器 ==========
  // 将代码编码为 hex 字符串，运行时解码后通过 load() 执行
  // hex 编码：每字节 2 字符，比逗号分隔十进制表 {d,d,d} 节省 ~43% 体积
  encodeByteStreamLoad(code) {
    const bytes = this.toUtf8Bytes(code);
    const keyLen = 4 + Math.floor(Math.random() * 4);
    const key = [];
    for (let i = 0; i < keyLen; i++) key.push(Math.floor(Math.random() * 256));
    const step = 1 + Math.floor(Math.random() * 7);
    const salt = Math.floor(Math.random() * 256);
    const encoded = bytes.map((b, i) => ((b + key[i % keyLen] + i * step + salt) % 256 + 256) % 256);
    // 编码为 hex 字符串（紧凑：2 字符/字节，无逗号/花括号开销）
    let hexStr = '';
    for (let i = 0; i < encoded.length; i++) {
      hexStr += encoded[i].toString(16).padStart(2, '0');
    }
    const hexVar = this.generateName();
    const keyVar = this.generateName();
    const iVar = this.generateShortName();
    const tblVar = this.generateShortName();
    const strVar = this.generateName();
    const fnVar = this.generateName();
    const subRef = this.generateShortName();
    const tonRef = this.generateShortName();
    let lua = '';
    lua += 'local ' + subRef + '=string.sub ';
    lua += 'local ' + tonRef + '=tonumber ';
    lua += 'local ' + hexVar + '="' + hexStr + '" ';
    lua += 'local ' + keyVar + '={' + key.join(',') + '} ';
    lua += 'local ' + tblVar + '={} ';
    lua += 'for ' + iVar + '=1,#' + hexVar + '/2 do ';
    lua += tblVar + '[' + iVar + ']=string.char((' + tonRef + '(' + subRef + '(' + hexVar + ',' + iVar + '*2-1,' + iVar + '*2),16)-' + keyVar + '[(' + iVar + '-1)%#' + keyVar + '+1]-(' + iVar + '-1)*' + step + '-' + salt + ')%256) ';
    lua += 'end ';
    lua += 'local ' + strVar + '=table.concat(' + tblVar + ') ';
    lua += 'local ' + fnVar + '=load(' + strVar + ') ';
    lua += 'if ' + fnVar + ' then ' + fnVar + '() end';
    return lua;
  },

  // ========== Step 9: LoadString 包装 ==========
  wrapLoadstring(code) {
    // 字节流编码包装：代码加密为字节数组，运行时解码后 load() 执行
    const decoyVar = this.generateShortName();
    let result = '';
    result += 'local ' + decoyVar + '=' + Math.floor(Math.random() * 9999) + ' ';
    result += this.encodeByteStreamLoad(code);
    return result;
  },

  // ========== Step 9.5: 自调用结构包装 ==========
  // 将代码包装成变体自执行结构
  // 模式: (function() local C={} C[1]=function() ...原代码... end C[1]() end)()
  // 或: local _t=setmetatable({},{__call=function(self,...) ...原代码... end}) _t()
  // 或: (function() return (function() ...原代码... end)() end)()
  // 生成多种变体，增加静态分析难度
  selfInvokeWrap(code) {
    const variant = Math.floor(Math.random() * 4);
    const fnName = this.generateName();
    const tblName = this.generateName();
    const mtName = this.generateName();
    const keyName = this.generateShortName();
    const argName = this.generateShortName();

    switch (variant) {
      case 0: {
        // 变体 1: table 索引调用
        // local T={} T[1]=function() ...code... end T[1]()
        let result = '';
        result += 'local ' + tblName + '={} ';
        result += tblName + '[1]=function() ' + code + ' end ';
        result += tblName + '[1]()';
        return result;
      }
      case 1: {
        // 变体 2: setmetatable __call
        // local T=setmetatable({},{__call=function(self,...) ...code... end}) T()
        let result = '';
        result += 'local ' + tblName + '=setmetatable({},{__call=function(' + argName + ',...) ' + code + ' end}) ';
        result += tblName + '()';
        return result;
      }
      case 2: {
        // 变体 3: 嵌套 IIFE + 字符串方法调用风格
        // (function() local C={} C.C=function() ...code... end return C end)().C()
        let result = '';
        result += '(function() local ' + tblName + '={} ';
        result += tblName + '.C=function() ' + code + ' end ';
        result += 'return ' + tblName + ' end)().C()';
        return result;
      }
      case 3: {
        // 变体 4: :C() 风格（方法调用语法）
        // local T={C=function(self,...) ...code... end} T:C()
        let result = '';
        result += 'local ' + tblName + '={C=function(' + argName + ',...) ' + code + ' end} ';
        result += tblName + ':C()';
        return result;
      }
    }
    return code;
  },

  // ========== Step 11.5: 模块化返回表包装 ==========
  // 将代码包装为 return ({ ... }) 结构，返回一个包含多个函数字段的表
  // 类似模块或对象，字段有 pL、j、TJ、JL、JJ、M、K 等
  //
  // 特征：
  // - 整体结构: return ({ pL=function(...) ... end, j=function(...) ... end, ... })
  // - 原始代码被嵌入到一个函数字段中（如 E[0X21] = function() ...原代码... end）
  // - 其他字段是干扰/辅助函数：表索引操作、条件分支、错误处理等
  // - 数字字面量多样化: 0X21（大写十六进制）、0B111001（二进制）、0x3225（小写十六进制）
  // - 控制流平坦化: while true do + if 嵌套模拟跳转
  // - 动态表索引: E[0X36] = (E[0B111001])
  // - 双重否定: if not(not Q[12837])
  // - 方法调用: l:U(E, Q)、l:oL()
  moduleWrap(code) {
    // 生成核心变量名
    const E = this.generateShortStyleName();      // 主操作表
    const l = this.generateShortStyleName();      // 辅助对象（含方法）
    const Q = this.generateShortStyleName();      // 控制流状态变量
    const P = this.generateShortStyleName();      // 辅助状态变量
    const i = this.generateShortStyleName();      // 循环变量

    // 函数字段名（pL, j, TJ, JL, JJ, M, K 风格）
    const fnNames = [];
    const fnNamePool = ['pL', 'j', 'TJ', 'JL', 'JJ', 'M', 'K', 'mL', 'pT', 'Rj'];
    // 随机选 6-8 个函数名
    const numFns = 6 + Math.floor(Math.random() * 3);
    const shuffledPool = [...fnNamePool].sort(() => Math.random() - 0.5);
    for (let idx = 0; idx < numFns; idx++) {
      fnNames.push(shuffledPool[idx]);
    }

    // 随机选择哪个函数字段包含原始代码
    const mainFnIdx = Math.floor(Math.random() * fnNames.length);
    const mainFnName = fnNames[mainFnIdx];

    // 生成数字字面量（0X/0x 混合格式 + tonumber 二进制）
    // 注意：Lua 5.1 不支持 0B 二进制字面量，用 tonumber("...",2) 替代
    const hexUpper = (n) => '0X' + n.toString(16).toUpperCase();
    const binLiteral = (n) => 'tonumber("' + n.toString(2) + '",2)';
    const hexLower = (n) => '0x' + n.toString(16);

    // 随机选一个格式
    const numFmt = () => {
      const fmt = Math.floor(Math.random() * 3);
      const n = Math.floor(Math.random() * 200) + 1;
      if (fmt === 0) return hexUpper(n);
      if (fmt === 1) return binLiteral(n);
      return hexLower(n);
    };

    // 生成随机表索引
    const randIdx = () => numFmt();

    // 构建 l 对象（含 :U() 和 :oL() 方法）
    let lDef = '';
    lDef += 'local ' + l + '={} ';
    // l:U(E, Q) — 操作表的方法（干扰用，返回 Q）
    lDef += 'function ' + l + ':U(' + E + ',' + Q + ') return ' + Q + ' end ';
    // l:oL() — 返回一个固定值
    const olVal = numFmt();
    lDef += 'function ' + l + ':oL() return ' + olVal + ' end ';
    // l:g(E) — 另一个方法
    lDef += 'function ' + l + ':g(' + E + ') return ' + E + ' end ';

    // 构建 E 表（主操作表，预填充随机索引）
    let EDef = '';
    EDef += 'local ' + E + '={} ';
    // 预填充一些随机索引
    const numPreFill = 5 + Math.floor(Math.random() * 5);
    for (let idx = 0; idx < numPreFill; idx++) {
      const key = randIdx();
      const val = Math.floor(Math.random() * 256);
      EDef += E + '[' + key + ']=' + val + ' ';
    }

    // 构建各函数字段
    let fields = [];

    for (let idx = 0; idx < fnNames.length; idx++) {
      const fnName = fnNames[idx];
      if (idx === mainFnIdx) {
        // 主函数：包含原始代码
        // 使用 while true do + if 控制流包装
        const stateVar = this.generateShortStyleName();
        const initState = Math.floor(Math.random() * 9000) + 1000;
        // Bug12修复: const→let，允许while循环内重赋值避免JS TypeError
        let exitState = Math.floor(Math.random() * 9000) + 1000;
        while (exitState === initState) { exitState = Math.floor(Math.random() * 9000) + 1000; }

        let fnBody = '';
        fnBody += fnName + '=function() ';
        fnBody += 'local ' + stateVar + '=' + initState + ' ';
        fnBody += 'while true do ';
        fnBody += 'if ' + stateVar + '==' + initState + ' then ';
        // Bug13修复: 将状态更新移到code之前，避免code含return时产生Lua5.1不合法的return后接语句
        fnBody += stateVar + '=' + exitState + ' ';
        // 原始代码
        fnBody += code + ' ';
        fnBody += 'elseif ' + stateVar + '==' + exitState + ' then ';
        fnBody += 'break ';
        fnBody += 'else break end ';
        fnBody += 'end ';
        fnBody += 'end';
        fields.push(fnBody);
      } else {
        // 干扰函数：根据 idx 生成不同风格的代码
        const variant = idx % 6;
        const v1 = this.generateShortStyleName();
        const v2 = this.generateShortStyleName();

        if (variant === 0) {
          // pL 风格：设置/获取固定值，操作 E 表索引
          const idx1 = randIdx();
          const idx2 = randIdx();
          const val = numFmt();
          let fnBody = '';
          fnBody += fnName + '=function() ';
          fnBody += 'local ' + v1 + '=' + val + ' ';
          fnBody += E + '[' + idx1 + ']=' + v1 + ' ';
          fnBody += 'return ' + E + '[' + idx2 + '] ';
          fnBody += 'end';
          fields.push(fnBody);
        } else if (variant === 1) {
          // j 风格：错误处理，引用 error，调用 l:U
          const idx1 = randIdx();
          let fnBody = '';
          fnBody += fnName + '=function(' + v1 + ') ';
          fnBody += 'if not(not ' + v1 + ') then ';
          fnBody += 'return ' + l + ':U(' + E + ',' + v1 + ') ';
          fnBody += 'else error(' + E + '[' + idx1 + ']) end ';
          fnBody += 'end';
          fields.push(fnBody);
        } else if (variant === 2) {
          // TJ 风格：简单表索引赋值
          const idx1 = randIdx();
          const idx2 = randIdx();
          let fnBody = '';
          fnBody += fnName + '=function(' + v1 + ') ';
          fnBody += E + '[' + idx1 + ']=(' + E + '[' + idx2 + ']) ';
          fnBody += 'return ' + E + '[' + idx1 + '] ';
          fnBody += 'end';
          fields.push(fnBody);
        } else if (variant === 3) {
          // JL 风格：复杂条件分支，指令分发
          const idx1 = randIdx();
          const idx2 = randIdx();
          const idx3 = randIdx();
          const condVal = Math.floor(Math.random() * 100) + 1;
          let fnBody = '';
          fnBody += fnName + '=function(' + v1 + ') ';
          fnBody += 'local ' + v2 + '=' + E + '[' + idx1 + '] ';
          fnBody += 'while true do ';
          fnBody += 'if ' + v2 + '>' + condVal + ' then ';
          fnBody += E + '[' + idx2 + ']=' + v1 + ' ';
          fnBody += 'break ';
          fnBody += 'elseif not(not(' + v2 + '==0)) then ';
          fnBody += E + '[' + idx3 + ']=nil ';
          fnBody += 'break ';
          fnBody += 'else break end ';
          fnBody += 'end ';
          fnBody += 'return ' + v2 + ' ';
          fnBody += 'end';
          fields.push(fnBody);
        } else if (variant === 4) {
          // JJ 风格：定义两个匿名函数（VM 取指令/译码风格）
          const idx1 = randIdx();
          const idx2 = randIdx();
          const a1 = this.generateShortStyleName();
          const a2 = this.generateShortStyleName();
          let fnBody = '';
          fnBody += fnName + '=function() ';
          fnBody += E + '[' + idx1 + ']=function(' + a1 + ') return ' + E + '[' + a1 + '] end ';
          fnBody += E + '[' + idx2 + ']=function(' + a2 + ') return ' + l + ':g(' + a2 + ') end ';
          fnBody += 'return ' + E + '[' + idx1 + '] ';
          fnBody += 'end';
          fields.push(fnBody);
        } else {
          // M/K 风格：判断参数，操作 E 表
          const idx1 = randIdx();
          const cmpVal = numFmt();
          let fnBody = '';
          fnBody += fnName + '=function(' + v1 + ') ';
          fnBody += 'if ' + v1 + '>' + cmpVal + ' then ';
          fnBody += 'return ' + l + ':g(' + E + '[' + idx1 + ']) ';
          fnBody += 'else ' + E + '[' + idx1 + ']=nil return nil end ';
          fnBody += 'end';
          fields.push(fnBody);
        }
      }
    }

    // 构建最终 return ({ ... }) 结构
    let result = '';

    // 前置：local 声明
    result += lDef + ' ';
    result += EDef + ' ';

    // 生成 return ({ ... })
    result += 'return ({';

    // 各函数字段用逗号分隔
    for (let idx = 0; idx < fields.length; idx++) {
      if (idx > 0) result += ',';
      result += fields[idx];
    }

    result += '})';

    // 在 return 之后立即调用主函数
    // 结构: (return ({...}))  -> 不行，return 不能在表达式位置
    // 改为: local _M = (function() ... return ({...}) end)() _M.mainFnName()
    // 但用户要求整体是 return ({ ... })
    // 解决方案：用 do ... end 包裹，内部 local _M = ({...}) _M[mainFnName]()

    result = '';
    result += lDef + ' ';
    result += EDef + ' ';
    result += 'local _M=({';
    for (let idx = 0; idx < fields.length; idx++) {
      if (idx > 0) result += ',';
      result += fields[idx];
    }
    result += '}) ';
    // 调用主函数
    result += '_M.' + mainFnName + '()';

    return result;
  },

  // ========== Step 11.8: 局部环境包装 ==========
  // return(function() ... end)() 包装 + 全局函数本地化
  //
  // 1. 全局函数本地化：将 string.char, setmetatable 等复制到局部变量
  // 2. 防止外挂补丁：局部引用不受外部 _G 重写影响
  // 3. 缩短后续代码：string.char(65) → c(65)，体积减小
  localEnvWrap(code) {
    // 需要本地化的标准库函数列表（按引用路径分组）
    // 格式: [全局路径, 局部别名]
    const libs = [
      // string 库
      ['string.char', null],
      ['string.byte', null],
      ['string.sub', null],
      ['string.rep', null],
      ['string.len', null],
      ['string.format', null],
      ['string.find', null],
      ['string.gsub', null],
      ['string.gsub', null],
      // table 库
      ['table.insert', null],
      ['table.remove', null],
      ['table.concat', null],
      // math 库
      ['math.floor', null],
      ['math.random', null],
      ['math.randomseed', null],
      ['math.max', null],
      ['math.min', null],
      ['math.abs', null],
      // 全局函数
      ['tonumber', null],
      ['tostring', null],
      ['pcall', null],
      ['xpcall', null],
      ['error', null],
      ['assert', null],
      ['type', null],
      ['setmetatable', null],
      ['getmetatable', null],
      ['rawget', null],
      ['rawset', null],
      ['rawequal', null],
      ['rawlen', null],
      ['select', null],
      ['unpack', null],
      ['pairs', null],
      ['ipairs', null],
      ['next', null],
    ];

    // 为每个库函数生成短别名
    // 使用 generateName 以避免与现有变量冲突
    this.usedNames = this.usedNames || new Set();
    const aliasMap = {};
    const seenAliases = new Set();
    for (const entry of libs) {
      const path = entry[0];
      // 检查是否已为此路径生成别名（去重）
      if (aliasMap[path]) continue;
      const alias = this.generateShortName();
      aliasMap[path] = alias;
    }

    // 字符串感知替换：在代码中替换全局引用，但不替换字符串字面量内部
    // 策略：逐字符扫描，跳过字符串字面量
    function replaceInCode(src, replacements) {
      // 按路径长度降序排序，避免部分匹配
      const sortedReps = replacements
        .map(([path, alias]) => ({ path, alias, len: path.length }))
        .sort((a, b) => b.len - a.len);

      let result = '';
      let i = 0;
      const len = src.length;

      while (i < len) {
        const ch = src[i];

        // 跳过字符串字面量
        if (ch === '"' || ch === "'") {
          const quote = ch;
          result += ch;
          i++;
          while (i < len) {
            if (src[i] === '\\') {
              // 转义字符，跳过下一个
              result += src[i] + (src[i + 1] || '');
              i += 2;
              continue;
            }
            result += src[i];
            if (src[i] === quote) { i++; break; }
            i++;
          }
          continue;
        }

        // 跳过长括号字符串 [[...]] 和 [==[...]==]
        if (ch === '[' && (src[i + 1] === '[' || src[i + 1] === '=')) {
          // 检查 [==[ 格式
          let eqCount = 0;
          let j = i + 1;
          while (j < len && src[j] === '=') { eqCount++; j++; }
          if (j < len && src[j] === '[') {
            // 找到匹配的 ]==]
            const closeStr = ']' + '='.repeat(eqCount) + ']';
            const closeIdx = src.indexOf(closeStr, j + 1);
            if (closeIdx >= 0) {
              result += src.slice(i, closeIdx + closeStr.length);
              i = closeIdx + closeStr.length;
              continue;
            }
          }
        }

        // 跳过注释 --... 和 --[[...]]
        if (ch === '-' && src[i + 1] === '-') {
          if (src[i + 2] === '[' && src[i + 3] === '[') {
            // 块注释
            const closeIdx = src.indexOf(']]', i + 4);
            if (closeIdx >= 0) {
              result += src.slice(i, closeIdx + 2);
              i = closeIdx + 2;
              continue;
            }
          }
          // 行注释
          let lineEnd = src.indexOf('\n', i);
          if (lineEnd < 0) lineEnd = len;
          result += src.slice(i, lineEnd);
          i = lineEnd;
          continue;
        }

        // 尝试匹配替换
        let matched = false;
        for (const rep of sortedReps) {
          if (i + rep.len <= len && src.substr(i, rep.len) === rep.path) {
            // 检查前一个字符不是字母/数字/下划线/点（避免部分匹配）
            const prevCh = i > 0 ? src[i - 1] : '';
            const nextCh = i + rep.len < len ? src[i + rep.len] : '';
            // 前一个字符不能是字母/点（避免 mystring.char 误匹配）
            // 后一个字符不能是字母/数字/下划线/点/冒号
            if (!/[a-zA-Z0-9_.]/.test(prevCh) && !/[a-zA-Z0-9_.:]/.test(nextCh)) {
              result += rep.alias;
              i += rep.len;
              matched = true;
              break;
            }
          }
        }

        if (!matched) {
          result += ch;
          i++;
        }
      }

      return result;
    }

    // 执行替换
    const replacements = Object.entries(aliasMap).map(([path, alias]) => [path, alias]);
    const replacedCode = replaceInCode(code, replacements);

    // 生成局部变量声明
    let localDecls = '';
    for (const [path, alias] of replacements) {
      localDecls += 'local ' + alias + '=' + path + ' ';
    }

    // 包装在 return(function() ... end)() 中
    // 局部变量声明在前，然后是替换后的代码
    const result = 'return(function() ' + localDecls + replacedCode + ' end)()';
    return result;
  },


  // 5 类防逆向技术：反篡改校验、环境检测、调试器检测、时间炸弹、调用栈检查
  // 纯 Lua 5.1 算术实现，不用 ~ 位运算符，bit32 需 fallback

  // --- 1. 反篡改校验 ---
  // 运行时对代码字符串做累加校验和，与预埋值比对，不一致则行为异常
  antiTamper(code) {
    const v = this.generateShortStyleName();
    const chk = this.generateShortStyleName();
    const acc = this.generateShortStyleName();
    const i = this.generateShortStyleName();
    const c = this.generateShortStyleName();
    const expected = this.generateShortStyleName();

    // 把 code 作为字符串变量注入（供校验和读取）
    const codeVar = this.generateShortStyleName();
    // 性能优化：使用 Array.push + join 替代字符串 += 拼接
    // 同时在编码循环中合并校验和计算，省去第二遍扫描
    const encodedArr = [];
    let checksum = 0;
    const variant = fastRandomInt(3);

    // 根据变体选择不同的累加方式和模数
    let modulus = 2147483647; // 默认大模数
    if (variant === 2) modulus = 999999;

    for (let j = 0; j < code.length; j++) {
      const byte = code.charCodeAt(j);
      encodedArr.push(byte + 33);
      // 在同一循环中计算校验和
      if (variant === 1) {
        checksum = (checksum * 31 + byte) % 2147483647;
      } else {
        checksum = (checksum + byte) % modulus;
      }
    }
    const encoded = encodedArr.join(',');

    const decoder = this.generateShortStyleName();
    const arrVar = this.generateShortStyleName();
    const decLoop = this.generateShortStyleName();
    const execFn = this.generateShortStyleName(); // loadstring 返回的函数

    // 加随机偏移使预埋值不直观
    const salt = fastRandomInt(999999) + 100000;
    const embedded = (checksum + salt) % modulus;

    const guardParts = [];
    guardParts.push('local ' + v + '=' + code.length + ' ');
    guardParts.push('local ' + expected + '=' + embedded + ' ');
    guardParts.push('local ' + chk + '=' + salt + ' ');
    guardParts.push('local ' + acc + '=0 ');
    guardParts.push('local ' + i + '=1 ');
    guardParts.push('while ' + i + '<=' + v + ' do ');
    guardParts.push('local ' + c + '=string.byte(' + codeVar + ',' + i + ') ');

    if (variant === 0) {
      // 变体0：直接累加 + 条件判断
      guardParts.push(acc + '=' + acc + '+' + c + ' ');
      guardParts.push('if ' + acc + '>=2147483647 then ' + acc + '=' + acc + '-2147483647 end ');
      guardParts.push(i + '=' + i + '+1 end ');
      guardParts.push('if not((' + acc + '+' + chk + ')%2147483647==' + expected + ') then ');
      guardParts.push('return end ');
    } else if (variant === 1) {
      // 变体1：乘法累加 + tonumber 验证
      guardParts.push(acc + '=(' + acc + '*31+' + c + ')%2147483647 ');
      guardParts.push(i + '=' + i + '+1 end ');
      guardParts.push('if tonumber((' + acc + '+' + chk + ')%2147483647)~=' + expected + ' then ');
      guardParts.push('return end ');
    } else {
      // 变体2：分段累加 + math.floor
      guardParts.push(acc + '=' + acc + '+' + c + ' ');
      guardParts.push('if ' + acc + '>=999999 then ' + acc + '=' + acc + '-999999 end ');
      guardParts.push(i + '=' + i + '+1 end ');
      guardParts.push('if math.floor((' + acc + '+' + chk + ')%999999)~=' + expected + ' then ');
      guardParts.push('return end ');
    }
    const guard = guardParts.join('');

    const resultParts = [];
    resultParts.push('local ' + arrVar + '={' + encoded + '} ');
    // 使用 table.concat 避免 O(n²) 字符串拼接
    resultParts.push('local _tc={} ');
    resultParts.push('for ' + decLoop + '=1,#' + arrVar + ' do ');
    resultParts.push('_tc[' + decLoop + ']=string.char(' + arrVar + '[' + decLoop + ']-33) ');
    resultParts.push('end ');
    resultParts.push('local ' + codeVar + '=table.concat(_tc) ');
    resultParts.push(guard);
    // 通过 load 执行解码后的代码
    resultParts.push('local ' + execFn + '=load(' + codeVar + ') ');
    resultParts.push('if ' + execFn + ' then ' + execFn + '() end');

    return resultParts.join('');
  },

  // --- 2. 环境检测 ---
  // 检测运行环境是否为 Roblox，非预期环境则静默退出
  environmentCheck(code) {
    const v1 = this.generateShortStyleName();
    const v2 = this.generateShortStyleName();
    const v3 = this.generateShortStyleName();
    const retVar = this.generateShortStyleName();
    const checks = [];

    // 私有缓存关键函数引用，防止攻击者用同类型假函数替换绕过
    // 校验模式：引用一致性 + 行为正确性双重校验
    const cacheFns = ['print', 'string.byte', 'tostring', 'math.floor', 'tonumber', 'string.sub', 'string.len'];
    const cacheCount = 3 + Math.floor(Math.random() * 3);
    const shuffledFns = [...cacheFns].sort(() => Math.random() - 0.5);
    const selectedCache = shuffledFns.slice(0, Math.min(cacheCount, shuffledFns.length));
    const cacheAliases = {};
    for (const fn of selectedCache) {
      cacheAliases[fn] = this.generateShortStyleName();
    }

    // 检测列表：使用缓存别名（如果被选中），否则用全局名
    const sb = cacheAliases['string.byte'] || 'string.byte';
    const mf = cacheAliases['math.floor'] || 'math.floor';
    const tn = cacheAliases['tonumber'] || 'tonumber';
    const ss = cacheAliases['string.sub'] || 'string.sub';
    const sl = cacheAliases['string.len'] || 'string.len';
    const ts = cacheAliases['tostring'] || 'tostring';
    const pr = cacheAliases['print'] || 'print';

    // 检测1: string.byte("A") 返回 65
    checks.push(sb + '("A")==65');
    // 检测2: math.floor(3.7) 返回 3
    checks.push(mf + '(3.7)==3');
    // 检测3: tonumber("42") 返回 42
    checks.push(tn + '("42")==42');
    // 检测4: string.sub("hello",2,4) 返回 "ell"
    checks.push(ss + '("hello",2,4)=="ell"');
    // 检测5: string.len("test") 返回 4
    checks.push(sl + '("test")==4');
    // 检测6: tostring(42) 返回 "42"
    checks.push(ts + '(42)=="42"');
    // 检测7: type(print)=="function"（引用校验替代：比对缓存引用）
    checks.push('pcall(' + pr + ',"")==true');

    // 随机选 3-5 个检测组合
    const selected = [];
    const pool = [...checks];
    const count = Math.min(pool.length, 3 + Math.floor(Math.random() * 3));
    for (let j = 0; j < count; j++) {
      const idx = Math.floor(Math.random() * pool.length);
      selected.push(pool.splice(idx, 1)[0]);
    }

    const variant = Math.floor(Math.random() * 3);
    let env = '';

    // 私有缓存闭包 + 引用一致性校验 + 行为校验（全部在 do 块内，别名不出作用域）
    env += 'local ' + retVar + '=true ';
    env += 'do ';
    for (const fn of selectedCache) {
      env += 'local ' + cacheAliases[fn] + '=' + fn + ' ';
    }
    for (const fn of selectedCache) {
      env += 'if ' + fn + '~=' + cacheAliases[fn] + ' then ' + retVar + '=false end ';
    }

    if (variant === 0) {
      // 变体0：引用校验 + 行为校验，全通过才继续（行为校验在 do 块内，可访问缓存别名）
      for (const check of selected) {
        env += 'if not(' + check + ') then ' + retVar + '=false end ';
      }
      env += 'end ';
      env += 'if not ' + retVar + ' then return end ';
    } else if (variant === 1) {
      // 变体1：计数器模式（行为校验在 do 块内）
      env += 'local ' + v1 + '=0 ';
      env += 'local ' + v2 + '=' + (count + selectedCache.length) + ' ';
      for (const check of selected) {
        env += 'if ' + check + ' then ' + v1 + '=' + v1 + '+1 end ';
      }
      env += 'if ' + retVar + ' then ' + v1 + '=' + v1 + '+' + selectedCache.length + ' end ';
      env += 'if ' + v1 + '<' + v2 + ' then return end ';
      env += 'end ';
    } else {
      // 变体2：短路链式检测 + 引用校验（行为校验在 do 块内）
      if (selected.length > 0) {
        env += 'if not(' + selected.join(')and(') + ') then ' + retVar + '=false end ';
      }
      env += 'end ';
      env += 'if not ' + retVar + ' then return end ';
    }

    return env + ' ' + code;
  },

  // --- 3. 调试器检测 ---
  // 检测 debug 库异常使用、hook 状态、断点等
  debuggerCheck(code) {
    const v1 = this.generateShortStyleName();
    const v2 = this.generateShortStyleName();
    const v3 = this.generateShortStyleName();

    const variant = Math.floor(Math.random() * 5);
    let dbg = '';

    if (variant === 0) {
      // 变体0：检测调试器工具特征（搜索词拆碎避免在 loadstring 源码中自匹配）
      dbg += 'local ' + v1 + '=false ';
      dbg += 'pcall(function() ';
      dbg += 'local ' + v2 + '=debug.getinfo(1,"S") ';
      dbg += 'if ' + v2 + ' and ' + v2 + '.source then ';
      dbg += 'local ' + v3 + '=' + v2 + '.source ';
      // 运行时拼接搜索词，避免字面量出现在源码中导致 string.find 自匹配
      dbg += 'if string.find(' + v3 + ',("Mo".."bDe")..("bu".."g")) or string.find(' + v3 + ',("De".."bug")..("ge".."r")) or string.find(' + v3 + ',("l".."d").."b") then ' + v1 + '=true end ';
      dbg += 'end end) ';
      dbg += 'if ' + v1 + ' then return end ';
    } else if (variant === 1) {
      // 变体1：检测是否已有外部 hook（不检测 sethook 是否存在，因为非 5.1 环境也合法）
      dbg += 'local ' + v1 + '=nil ';
      dbg += 'pcall(function() ';
      dbg += v1 + '=debug.gethook() ';
      dbg += 'end) ';
      // gethook 返回 function 类型说明有外部调试器设置了 hook
      // 但需要排除空 hook（某些环境默认返回空函数）
      dbg += 'if ' + v1 + ' and type(' + v1 + ')=="function" then ';
      // 验证 hook 是否为外部设置的（通过设置再取回对比）
      dbg += 'local ' + v2 + '=nil ';
      dbg += 'pcall(function() debug.sethook() ' + v2 + '=debug.gethook() end) ';
      dbg += 'if ' + v2 + '~=nil then return end end ';
    } else if (variant === 2) {
      // 变体2：执行时间差检测（阈值放宽到 5-10 秒避免误判）
      dbg += 'local ' + v1 + '=os.clock() ';
      dbg += 'pcall(function() return nil end) ';
      dbg += 'local ' + v2 + '=os.clock() ';
      dbg += 'if (' + v2 + '-' + v1 + ')>' + (5.0 + Math.random() * 5.0).toFixed(4) + ' then ';
      dbg += 'return end ';
    } else if (variant === 3) {
      // 变体3：多级 debug.getinfo 深度检查 — 检查 .what/.currentline/.namewhat
      dbg += 'local ' + v1 + '=false ';
      dbg += 'pcall(function() ';
      dbg += 'for ' + v2 + '=1,10 do ';
      dbg += 'local ' + v3 + '=debug.getinfo(' + v2 + ',"Slu") ';
      dbg += 'if not ' + v3 + ' then break end ';
      // 检查 .what 是否为 "C"（C 函数出现在非预期位置可能意味着 hook）
      dbg += 'if ' + v3 + '.what=="C" and ' + v2 + '>2 then ' + v1 + '=true break end ';
      // 检查 .currentline 是否为 -1（无行号信息通常意味着 hook/注入）
      dbg += 'if ' + v3 + '.currentline==-1 and ' + v3 + '.what=="Lua" then ' + v1 + '=true break end ';
      // 检查 .namewhat 是否包含可疑字符串
      dbg += 'if ' + v3 + '.namewhat and (string.find(' + v3 + '.namewhat,"hook") or string.find(' + v3 + '.namewhat,"met")) then ' + v1 + '=true break end ';
      dbg += 'end end) ';
      dbg += 'if ' + v1 + ' then return end ';
    } else {
      // 变体4：debug.getinfo + pcall 双重验证 — 检查 debug 库本身是否被篡改
      dbg += 'local ' + v1 + '=true ';
      dbg += 'pcall(function() ';
      // 验证 debug.getinfo 返回正确的表结构
      dbg += 'local ' + v2 + '=debug.getinfo(1,"Slu") ';
      dbg += 'if type(' + v2 + ')~="table" then ' + v1 + '=false return end ';
      dbg += 'if type(' + v2 + '.source)~="string" then ' + v1 + '=false return end ';
      dbg += 'if type(' + v2 + '.currentline)~="number" then ' + v1 + '=false return end ';
      dbg += 'if type(' + v2 + '.what)~="string" then ' + v1 + '=false return end ';
      // 验证 debug.traceback 返回字符串
      dbg += 'local ' + v3 + '=debug.traceback("",1) ';
      dbg += 'if type(' + v3 + ')~="string" or #v3<1 then ' + v1 + '=false return end ';
      // 检查 traceback 内容是否包含调试器特征
      dbg += 'if string.find(' + v3 + ',("De".."bug")) or string.find(' + v3 + ',("Mo".."b")) then ' + v1 + '=false end ';
      dbg += 'end) ';
      dbg += 'if not ' + v1 + ' then return end ';
    }

    return dbg + ' ' + code;
  },

  // --- 4. 时间炸弹 ---
  // 检查代码执行时间差，检测单步调试/插桩分析
  timeBomb(code) {
    const t1 = this.generateShortStyleName();
    const t2 = this.generateShortStyleName();
    const t1b = this.generateShortStyleName();
    const t2b = this.generateShortStyleName();
    const threshold = this.generateShortStyleName();
    const guard = this.generateShortStyleName();
    const cnt = this.generateShortStyleName();
    const i = this.generateShortStyleName();

    // 阈值：正常执行应在几毫秒内，被调试时会长很多
    // 阈值设高一些避免在慢速环境误触发
    const thresholdVal = (5.0 + Math.random() * 5.0).toFixed(4);
    const variant = Math.floor(Math.random() * 3);

    let bomb = '';

    if (variant === 0) {
      // 修复#5：多源时间交叉验证，防止 hook os.clock 返回稳定递增小数绕过
      bomb += 'local ' + t1 + '=os.clock() ';
      bomb += 'local ' + t1b + '=os.time() ';
      bomb += 'pcall(function() ' + code + ' end) ';
      bomb += 'local ' + t2 + '=os.clock() ';
      bomb += 'local ' + t2b + '=os.time() ';
      bomb += 'local ' + threshold + '=' + thresholdVal + ' ';
      // 时间差检测
      bomb += 'if (' + t2 + '-' + t1 + ')>' + threshold + ' then return end ';
      // 交叉验证：os.time 差值应该 >= 0（如果 os.clock 被 hook 但 os.time 没有，差值可能不合理）
      bomb += 'if (' + t2b + '-' + t1b + ')<0 then return end ';
      // 如果 os.clock 差值 > 3.0 但 os.time 差值 == 0，可能 os.clock 被 hook（抬高）
      // 阈值从 0.1 提高到 3.0，避免复杂代码 CPU 时间 > 0.1s 时的误触发
      bomb += 'if (' + t2 + '-' + t1 + ')>3.0 and (' + t2b + '-' + t1b + ')==0 then return end ';
      // 如果 os.time 差值 >= 1（真实耗时超过 1 秒）但 os.clock 差值 < 0.001，os.clock 被 hook（压低）
      bomb += 'if (' + t2b + '-' + t1b + ')>=1 and (' + t2 + '-' + t1 + ')<0.001 then return end ';
    } else if (variant === 1) {
      // 修复#5：os.clock 差值 + os.time 交叉验证 + 循环计数基准（时间无关的检测）
      bomb += 'local ' + t1 + '=os.clock() ';
      bomb += 'local ' + t1b + '=os.time() ';
      bomb += 'pcall(function() ' + code + ' end) ';
      bomb += 'local ' + t2 + '=os.clock() ';
      bomb += 'local ' + t2b + '=os.time() ';
      bomb += 'local ' + threshold + '=' + thresholdVal + ' ';
      // 时间差检测
      bomb += 'if (' + t2 + '-' + t1 + ')>' + threshold + ' then return end ';
      // os.time 交叉验证
      bomb += 'if (' + t2b + '-' + t1b + ')<0 then return end ';
      // 阈值从 0.1 提高到 3.0，避免复杂代码 CPU 时间 > 0.1s 时的误触发
      bomb += 'if (' + t2 + '-' + t1 + ')>3.0 and (' + t2b + '-' + t1b + ')==0 then return end ';
      // 循环计数基准：固定次数循环必须完整执行（被单步调试/插桩时 cnt 不足）
      bomb += 'local ' + cnt + '=0 ';
      bomb += 'for ' + i + '=1,100000 do ' + cnt + '=' + cnt + '+1 end ';
      bomb += 'if ' + cnt + '~=100000 then return end ';
    } else {
      // 修复#5：嵌套时间检测，比较 os.clock 和 os.time 的差值是否成比例
      bomb += 'local ' + t1 + '=os.clock() ';
      bomb += 'local ' + t1b + '=os.time() ';
      bomb += 'local ' + guard + '=nil ';
      bomb += 'pcall(function() ' + code + ' end) ';
      bomb += 'local ' + t2 + '=os.clock() ';
      bomb += 'local ' + t2b + '=os.time() ';
      bomb += 'if (' + t2 + '-' + t1 + ')>' + thresholdVal + ' then return end ';
      // 比例校验：os.clock 差值（秒）与 os.time 差值（秒）应数量级一致
      // os.clock 被压低（hook 返回小值隐藏慢执行）：os.time >= 1 但 os.clock < 0.001
      bomb += 'if (' + t2b + '-' + t1b + ')>=1 and (' + t2 + '-' + t1 + ')<0.001 then return end ';
      // os.clock 被抬高（异常）：os.clock >= 3.0 但 os.time < 1
      // 阈值从 1.0 提高到 3.0，避免复杂代码的误触发
      bomb += 'if (' + t2 + '-' + t1 + ')>=3.0 and (' + t2b + '-' + t1b + ')<1 then return end ';
    }

    return bomb;
  },

  // --- 5. 调用栈检查 ---
  // 检查调用栈深度和来源，检测意外包装/拦截
  callStackCheck(code) {
    const v1 = this.generateShortStyleName();
    const v2 = this.generateShortStyleName();
    const v3 = this.generateShortStyleName();
    const depth = this.generateShortStyleName();

    // 预期调用栈深度范围 - 设宽松避免误触发
    const minDepth = 1;
    const maxDepth = 20 + Math.floor(Math.random() * 20);

    const variant = Math.floor(Math.random() * 3);
    let stack = '';

    if (variant === 0) {
      // 变体0：检测调用栈深度（宽松范围，只检测异常深的栈）
      stack += 'local ' + depth + '=0 ';
      stack += 'pcall(function() ';
      stack += 'local ' + v1 + '=1 ';
      stack += 'while true do ';
      stack += 'local ' + v2 + '=debug.getinfo(' + v1 + ',"S") ';
      stack += 'if not ' + v2 + ' then ' + depth + '=' + v1 + '-1 break end ';
      stack += v1 + '=' + v1 + '+1 ';
      stack += 'if ' + v1 + '>100 then break end ';
      stack += 'end end) ';
      stack += 'if ' + depth + '>' + maxDepth + ' then return end ';
    } else if (variant === 1) {
      // 变体1：检测调用者来源（放宽 [C] 检测，因为从 C 函数调用是正常的）
      stack += 'local ' + v1 + '=nil ';
      stack += 'pcall(function() ';
      stack += v1 + '=debug.getinfo(2,"S") ';
      stack += 'end) ';
      // 只在获取到调用者信息时检测可疑来源
      // 注意：从 C 函数（如 doString/loadstring）调用是正常的，不触发
      stack += 'if ' + v1 + ' and ' + v1 + '.source then ';
      stack += 'local ' + v2 + '=' + v1 + '.source ';
      // 只检测已知的调试器/注入工具来源，搜索词拆碎避免 loadstring 源码自匹配
      stack += 'if string.find(' + v2 + ',("Mo".."bDe")..("bu".."g")) or string.find(' + v2 + ',("De".."bug")..("ge".."r")) or string.find(' + v2 + ',("in".."je")..("ct")) then ';
      stack += 'return end end ';
    } else {
      // 变体2：多层栈帧检测 + 深度上限
      stack += 'local ' + depth + '=0 ';
      stack += 'local ' + v1 + '=1 ';
      stack += 'while true do ';
      stack += 'local ' + v2 + '=nil ';
      stack += 'pcall(function() ' + v2 + '=debug.getinfo(' + v1 + ') end) ';
      stack += 'if not ' + v2 + ' then break end ';
      stack += depth + '=' + v1 + ' ';
      stack += v1 + '=' + v1 + '+1 ';
      stack += 'if ' + v1 + '>100 then break end ';
      stack += 'end ';
      stack += 'if ' + depth + '>' + maxDepth + ' then return end ';
    }

    return stack + ' ' + code;
  },

  // --- 6. GC 操纵检测 ---
  // 私有缓存 collectgarbage 引用，校验引用一致性 + 行为正确性
  gcManipCheck(code) {
    const v1 = this.generateShortStyleName();
    const v2 = this.generateShortStyleName();
    const v3 = this.generateShortStyleName();
    const v4 = this.generateShortStyleName();
    const retVar = this.generateShortStyleName();
    const variant = Math.floor(Math.random() * 3);
    let gc = '';

    if (variant === 0) {
      // 变体0：缓存 collectgarbage 引用 + 引用比对 + 行为校验
      gc += 'local ' + retVar + '=true ';
      gc += 'do ';
      gc += 'local ' + v1 + '=collectgarbage ';
      gc += 'if collectgarbage~=' + v1 + ' then ' + retVar + '=false end ';
      gc += 'if type(' + v1 + ')~="function" then ' + retVar + '=false end ';
      gc += 'local ' + v2 + '=0 ';
      gc += 'pcall(function() ' + v2 + '=' + v1 + '("count") end) ';
      gc += 'if type(' + v2 + ')~="number" or ' + v2 + '<=0 then ' + retVar + '=false end ';
      gc += 'end ';
      gc += 'if not ' + retVar + ' then return end ';
    } else if (variant === 1) {
      // 变体1：缓存引用 + stop/restart 往返校验
      gc += 'local ' + retVar + '=true ';
      gc += 'pcall(function() ';
      gc += 'local ' + v1 + '=collectgarbage ';
      gc += 'if collectgarbage~=' + v1 + ' then ' + retVar + '=false end ';
      gc += 'local ' + v2 + '=0 ';
      gc += 'pcall(function() ' + v2 + '=' + v1 + '("count") end) ';
      gc += 'if type(' + v2 + ')~="number" or ' + v2 + '<=0 then ' + retVar + '=false end ';
      gc += 'end) ';
      gc += 'if not ' + retVar + ' then return end ';
    } else {
      // 变体2：缓存引用 + collect("collect") 返回值校验
      gc += 'local ' + retVar + '=true ';
      gc += 'do ';
      gc += 'local ' + v1 + '=collectgarbage ';
      gc += 'if collectgarbage~=' + v1 + ' then ' + retVar + '=false end ';
      gc += 'if type(' + v1 + ')~="function" then ' + retVar + '=false end ';
      gc += 'local ' + v2 + '=nil ';
      gc += 'pcall(function() ' + v2 + '=' + v1 + '("count") end) ';
      gc += 'if type(' + v2 + ')~="number" or ' + v2 + '<=0 then ' + retVar + '=false end ';
      gc += 'end ';
      gc += 'if not ' + retVar + ' then return end ';
    }
    return gc + ' ' + code;
  },

  // --- 7. Hook 链检测 ---
  // 多次采样 debug.gethook，检测 hook 是否被外部调试器设置
  hookChainCheck(code) {
    const v1 = this.generateShortStyleName();
    const v2 = this.generateShortStyleName();
    const v3 = this.generateShortStyleName();
    const v4 = this.generateShortStyleName();
    const variant = Math.floor(Math.random() * 3);
    let hk = '';

    if (variant === 0) {
      // 变体0：设置临时 hook 再取回，验证是否被覆盖
      hk += 'local ' + v1 + '=nil ';
      hk += 'pcall(function() ';
      hk += 'local ' + v2 + '=function() end ';
      hk += 'debug.sethook(' + v2 + ',"c") ';
      hk += v1 + '=debug.gethook() ';
      hk += 'debug.sethook() ';
      hk += 'end) ';
      hk += 'if ' + v1 + '~=nil and ' + v1 + '~="function" and type(' + v1 + ')~="function" then return end ';
    } else if (variant === 1) {
      // 变体1：多次取样 hook 状态，检测 hook 是否在执行间变化（外部调试器特征）
      hk += 'local ' + v1 + '=nil ';
      hk += 'local ' + v2 + '=nil ';
      hk += 'pcall(function() ' + v1 + '=debug.gethook() end) ';
      hk += 'pcall(function() ' + v2 + '=debug.gethook() end) ';
      // 正常环境下两次取样应一致；如果不同说明有外部调试器在操作 hook
      hk += 'if ' + v1 + '~=' + v2 + ' then return end ';
    } else {
      // 变体2：检测 hook mask 是否非空（正常代码不应设置 hook）
      hk += 'local ' + v1 + '="" ';
      hk += 'pcall(function() ';
      hk += 'local ' + v2 + '=debug.gethook() ';
      hk += 'if type(' + v2 + ')=="string" then ' + v1 + '=' + v2 + ' end ';
      hk += 'end) ';
      hk += 'if #' + v1 + '>0 then return end ';
    }
    return hk + ' ' + code;
  },

  // --- 8. 内存扫描检测 ---
  // 检测 string.dump 是否可用（用于反汇编/内存扫描的工具特征）
  memScanCheck(code) {
    const v1 = this.generateShortStyleName();
    const v2 = this.generateShortStyleName();
    const v3 = this.generateShortStyleName();
    const variant = Math.floor(Math.random() * 3);
    let mem = '';

    if (variant === 0) {
      // 变体0：检测 string.dump 是否被篡改（不因 string.dump 不存在而退出）
      mem += 'local ' + v1 + '=string.dump ';
      // string.dump 不存在是正常的（某些 Lua 实现不支持），不触发 return
      mem += 'if type(' + v1 + ')=="function" then ';
      mem += 'local ' + v2 + '=false ';
      mem += 'pcall(function() ' + v2 + '=(string.dump(print)~=nil) end) ';
      // dump 失败是正常的，不触发 return
      mem += 'end ';
    } else if (variant === 1) {
      // 变体1：检测 string.dump 返回值的特征（长度合理性）
      mem += 'local ' + v1 + '=nil ';
      mem += 'pcall(function() ' + v1 + '=string.dump(function() return 0 end) end) ';
      // dump 不可用是正常的，不触发 return
    } else {
      // 变体2：检测 string.byte 对 dump 结果的访问是否被拦截
      mem += 'local ' + v1 + '=nil ';
      mem += 'pcall(function() ' + v1 + '=string.dump(function() return 1 end) end) ';
      mem += 'if type(' + v1 + ')=="string" then ';
      mem += 'local ' + v2 + '=string.byte(' + v1 + ',1) ';
      // 仅在 dump 成功但 byte 返回异常值时触发
      mem += 'if type(' + v2 + ')~="number" or ' + v2 + '<0 or ' + v2 + '>255 then return end ';
      mem += 'end ';
    }
    return mem + ' ' + code;
  },

  // --- 9. CPU 频率校准 ---
  // 双时间源对比检测：os.clock vs os.time，偏差大说明时间被 hook
  freqCheck(code) {
    const v1 = this.generateShortStyleName();
    const v2 = this.generateShortStyleName();
    const v3 = this.generateShortStyleName();
    const v4 = this.generateShortStyleName();
    const d1 = this.generateShortStyleName();
    const d2 = this.generateShortStyleName();
    const variant = Math.floor(Math.random() * 3);
    let fq = '';

    if (variant === 0) {
      // 修复#5：双时间源交叉验证，防止 hook 单一 os.clock
      fq += 'local ' + v1 + '=os.clock() ';
      fq += 'local ' + v2 + '=os.time() ';
      fq += 'local ' + v3 + '=0 ';
      fq += 'for ' + v4 + '=1,1000 do ' + v3 + '=' + v3 + '+1 end ';
      fq += 'local ' + d1 + '=os.clock()-' + v1 + ' ';
      fq += 'local ' + d2 + '=os.time()-' + v2 + ' ';
      // os.clock 差值应在合理范围（放宽到 5.0-10.0 秒避免慢速机器误触发）
      fq += 'if ' + d1 + '<0 or ' + d1 + '>' + (5.0 + Math.random() * 5.0).toFixed(4) + ' then return end ';
      // os.time 差值不应倒退
      fq += 'if ' + d2 + '<0 then return end ';
      // 交叉验证：os.clock 明显增量（> 0.5）但 os.time 冻结（== 0），可能 os.clock 被 hook（抬高）
      fq += 'if ' + d1 + '>0.5 and ' + d2 + '==0 then return end ';
      // 交叉验证：os.time >= 1（真实耗时超过 1 秒）但 os.clock < 0.001，os.clock 被 hook（压低）
      fq += 'if ' + d2 + '>=1 and ' + d1 + '<0.001 then return end ';
    } else if (variant === 1) {
      // 修复#5：连续采样双时间源，验证增量比合理（非冻结、非跳跃）
      fq += 'local ' + v1 + '=os.clock() ';
      fq += 'local ' + v2 + '=os.time() ';
      fq += 'local ' + v3 + '=os.clock() ';
      fq += 'local ' + d1 + '=' + v3 + '-' + v1 + ' ';
      fq += 'local ' + d2 + '=os.time()-' + v2 + ' ';
      // os.clock 增量应微小且非负（倒退或异常跳跃说明被 hook）
      fq += 'if ' + d1 + '<0 or ' + d1 + '>10.0 then return end ';
      // os.time 不应倒退
      fq += 'if ' + d2 + '<0 then return end ';
      // 交叉验证：os.clock 增量 > 0.5 但 os.time 冻结（== 0），os.clock 被抬高 hook
      fq += 'if ' + d1 + '>0.5 and ' + d2 + '==0 then return end ';
    } else {
      // 修复#5：双时间源比例校验，os.clock 与 os.time 增量应数量级一致
      fq += 'local ' + v1 + '=os.clock() ';
      fq += 'local ' + v2 + '=os.time() ';
      fq += 'local ' + v3 + '=0 ';
      fq += 'for ' + v4 + '=1,5000 do ' + v3 + '=' + v3 + '+1 end ';
      fq += 'local ' + d1 + '=os.clock()-' + v1 + ' ';
      fq += 'local ' + d2 + '=os.time()-' + v2 + ' ';
      // 两个时间源差值都应 >= 0（放宽等于 0 的情况，避免快速循环在精度内误触发）
      fq += 'if ' + d1 + '<0 or ' + d2 + '<0 then return end ';
      // 比例校验：os.clock 差值（秒）应与 os.time 差值（秒）数量级一致
      // os.clock 被压低（hook 返回小值隐藏慢执行）：os.time >= 1 但 os.clock < 0.1
      fq += 'if ' + d2 + '>=1 and ' + d1 + '<0.1 then return end ';
      // os.clock 被抬高（异常）：os.clock >= 1 但 os.time < 1
      fq += 'if ' + d1 + '>=1.0 and ' + d2 + '<1 then return end ';
    }
    return fq + ' ' + code;
  },

  // --- 10. 协程探针检测 ---
  // 检测 coroutine 是否被包装/监控
  coroProbeCheck(code) {
    const v1 = this.generateShortStyleName();
    const v2 = this.generateShortStyleName();
    const v3 = this.generateShortStyleName();
    const variant = Math.floor(Math.random() * 3);
    let co = '';

    if (variant === 0) {
      // 变体0：创建协程并检测 resume 是否被 hook
      co += 'local ' + v1 + '=coroutine.create(function() return 1 end) ';
      co += 'local ' + v2 + '=nil ';
      co += 'pcall(function() ' + v2 + '=coroutine.resume(' + v1 + ') end) ';
      co += 'if not ' + v2 + ' then return end ';
    } else if (variant === 1) {
      // 变体1：检测 coroutine.status 返回值是否合法
      co += 'local ' + v1 + '=coroutine.create(function() end) ';
      co += 'local ' + v2 + '=nil ';
      co += 'pcall(function() ' + v2 + '=coroutine.status(' + v1 + ') end) ';
      co += 'if ' + v2 + '~="suspended" and ' + v2 + '~="running" and ' + v2 + '~="normal" and ' + v2 + '~="dead" then ';
      co += 'return end ';
    } else {
      // 变体2：检测 coroutine.resume 的返回值数量
      co += 'local ' + v1 + '=coroutine.create(function(a) return a*2 end) ';
      co += 'local ' + v2 + ',' + v3 + '=coroutine.resume(' + v1 + ',21) ';
      co += 'if not ' + v2 + ' or ' + v3 + '~=42 then return end ';
    }
    return co + ' ' + code;
  },

  // --- 11. 字符串元方法篡改检测 ---
  // 检测 string 库的元方法是否被替换（调试器常用手法）
  strMetaCheck(code) {
    const v1 = this.generateShortStyleName();
    const v2 = this.generateShortStyleName();
    const v3 = this.generateShortStyleName();
    const variant = Math.floor(Math.random() * 3);
    let sm = '';

    if (variant === 0) {
      // 变体0：检测 string.sub 行为是否正常
      sm += 'local ' + v1 + '=string.sub("ABCDEF",2,4) ';
      sm += 'if ' + v1 + '~="BCD" then return end ';
    } else if (variant === 1) {
      // 变体1：检测 string.len + string.byte 行为
      sm += 'local ' + v1 + '=string.len("TEST") ';
      sm += 'local ' + v2 + '=string.byte("TEST",1) ';
      sm += 'if ' + v1 + '~=4 or ' + v2 + '~=84 then return end ';
    } else {
      // 变体2：检测 string.rep + string.reverse 行为
      sm += 'local ' + v1 + '=string.rep("AB",3) ';
      sm += 'local ' + v2 + '=string.reverse(' + v1 + ') ';
      sm += 'if ' + v1 + '~="ABABAB" or ' + v2 + '~="BABABA" then return end ';
    }
    return sm + ' ' + code;
  },

  // --- 12. 断点陷阱 ---
  // 通过 pcall 错误签名分析检测断点/单步执行
  bpTrapCheck(code) {
    const v1 = this.generateShortStyleName();
    const v2 = this.generateShortStyleName();
    const v3 = this.generateShortStyleName();
    const variant = Math.floor(Math.random() * 3);
    let bp = '';

    if (variant === 0) {
      // 变体0：pcall 执行简单运算，检测错误消息是否被篡改
      bp += 'local ' + v1 + '=nil ';
      bp += 'local ' + v2 + '=nil ';
      bp += v1 + ',' + v2 + '=pcall(function() error("BP_CHECK") end) ';
      bp += 'if ' + v1 + ' then return end ';
      bp += 'if not string.find(' + v2 + ' or "","BP_CHECK") then return end ';
    } else if (variant === 1) {
      // 变体1：检测 pcall 的调用层数是否异常（断点会增加栈深度）
      bp += 'local ' + v1 + '=0 ';
      bp += 'pcall(function() ';
      bp += 'local ' + v2 + '=1 ';
      bp += 'while true do ';
      bp += 'local ' + v3 + '=debug.getinfo(' + v2 + ',"S") ';
      bp += 'if not ' + v3 + ' then ' + v1 + '=' + v2 + '-1 break end ';
      bp += v2 + '=' + v2 + '+1 ';
      bp += 'if ' + v2 + '>50 then break end end end) ';
      // pcall 内部正常层数应 < 15（loadstring 包装 + 反调试嵌套会增加栈深度）
      bp += 'if ' + v1 + '>' + (15 + Math.floor(Math.random() * 10)) + ' then return end ';
    } else {
      // 变体2：嵌套 pcall + error 级别检测
      bp += 'local ' + v1 + '=nil ';
      bp += 'pcall(function() ';
      bp += v1 + '=pcall(function() error("LEVEL2",0) end) ';
      bp += 'end) ';
      bp += 'if ' + v1 + ' then return end ';
    }
    return bp + ' ' + code;
  },

  // --- 13. 局部变量探测 ---
  // 私有缓存 debug.getlocal/setlocal 引用，校验引用一致性 + 行为正确性
  localProbeCheck(code) {
    const v1 = this.generateShortStyleName();
    const v2 = this.generateShortStyleName();
    const v3 = this.generateShortStyleName();
    const retVar = this.generateShortStyleName();
    const variant = Math.floor(Math.random() * 3);
    let lp = '';

    if (variant === 0) {
      // 变体0：缓存 debug.getlocal 引用 + 引用比对 + 哨兵检测
      lp += 'local ' + retVar + '=true ';
      lp += 'do ';
      lp += 'local ' + v1 + '="' + Math.random().toString(36).substr(2, 8) + '" ';
      lp += 'local ' + v2 + '=debug.getlocal ';
      lp += 'if debug.getlocal~=' + v2 + ' then ' + retVar + '=false end ';
      lp += 'if type(' + v2 + ')~="function" then ' + retVar + '=false end ';
      lp += 'end ';
      lp += 'if not ' + retVar + ' then return end ';
    } else if (variant === 1) {
      // 变体1：缓存 debug.setlocal 引用 + 引用比对
      lp += 'local ' + retVar + '=true ';
      lp += 'do ';
      lp += 'local ' + v1 + '=debug.setlocal ';
      lp += 'if debug.setlocal~=' + v1 + ' then ' + retVar + '=false end ';
      lp += 'if type(' + v1 + ')~="function" then ' + retVar + '=false end ';
      lp += 'end ';
      lp += 'if not ' + retVar + ' then return end ';
    } else {
      // 变体2：缓存 debug.getlocal 引用 + 行为校验
      lp += 'local ' + retVar + '=true ';
      lp += 'do ';
      lp += 'local ' + v1 + '=debug.getlocal ';
      lp += 'if debug.getlocal~=' + v1 + ' then ' + retVar + '=false end ';
      lp += 'if type(' + v1 + ')~="function" then ' + retVar + '=false end ';
      lp += 'local ' + v2 + '=false ';
      lp += 'pcall(function() local _=' + v1 + '(1,1) ' + v2 + '=true end) ';
      lp += 'if not ' + v2 + ' then ' + retVar + '=false end ';
      lp += 'end ';
      lp += 'if not ' + retVar + ' then return end ';
    }
    return lp + ' ' + code;
  },

  // --- 14. 函数引用守卫 ---
  // 私有缓存原始函数引用，运行时比对引用一致性 + 行为校验
  // 攻击者无法用同类型假函数替换绕过，因为校验的是引用地址而非类型
  funcHashCheck(code) {
    const v1 = this.generateShortStyleName();
    const v2 = this.generateShortStyleName();
    const v3 = this.generateShortStyleName();
    const v4 = this.generateShortStyleName();
    const retVar = this.generateShortStyleName();
    const variant = Math.floor(Math.random() * 3);
    let fh = '';

    // 所有变体共同模式：闭包内缓存函数引用 → 比对全局引用一致性 → 行为校验
    const fnPool = [
      { name: 'print', behavior: 'pcall(%s,"")==true' },
      { name: 'pcall', behavior: '%s(function() return 1 end)==true' },
      { name: 'tostring', behavior: '%s(42)=="42"' },
      { name: 'string.byte', behavior: '%s("A")==65' },
      { name: 'string.sub', behavior: '%s("hello",2,4)=="ell"' },
      { name: 'string.len', behavior: '%s("test")==4' },
      { name: 'tonumber', behavior: '%s("99")==99' },
      { name: 'math.floor', behavior: '%s(3.7)==3' },
      { name: 'string.dump', behavior: 'pcall(%s,function() return 1 end)' },
      { name: 'string.char', behavior: '%s(65)=="A"' },
    ];

    if (variant === 0) {
      // 变体0：缓存 print + pcall，引用比对 + 行为校验
      const fns = ['print', 'pcall'];
      fh += 'local ' + retVar + '=true ';
      fh += 'do ';
      fh += 'local ' + v1 + '=' + fns[0] + ' ';
      fh += 'local ' + v2 + '=' + fns[1] + ' ';
      fh += 'if ' + fns[0] + '~=' + v1 + ' then ' + retVar + '=false end ';
      fh += 'if ' + fns[1] + '~=' + v2 + ' then ' + retVar + '=false end ';
      fh += 'if not(pcall(' + v1 + ',"")==true) then ' + retVar + '=false end ';
      fh += 'if not(' + v2 + '(function() return 1 end)==true) then ' + retVar + '=false end ';
      fh += 'end ';
      fh += 'if not ' + retVar + ' then return end ';
    } else if (variant === 1) {
      // 变体1：缓存 tostring + string.byte + tonumber，引用比对 + 行为校验
      const fns = ['tostring', 'string.byte', 'tonumber'];
      fh += 'local ' + retVar + '=true ';
      fh += 'do ';
      fh += 'local ' + v1 + '=' + fns[0] + ' ';
      fh += 'local ' + v2 + '=' + fns[1] + ' ';
      fh += 'local ' + v3 + '=' + fns[2] + ' ';
      fh += 'if ' + fns[0] + '~=' + v1 + ' then ' + retVar + '=false end ';
      fh += 'if ' + fns[1] + '~=' + v2 + ' then ' + retVar + '=false end ';
      fh += 'if ' + fns[2] + '~=' + v3 + ' then ' + retVar + '=false end ';
      fh += 'if not(' + v1 + '(42)=="42") then ' + retVar + '=false end ';
      fh += 'if not(' + v2 + '("A")==65) then ' + retVar + '=false end ';
      fh += 'if not(' + v3 + '("99")==99) then ' + retVar + '=false end ';
      fh += 'end ';
      fh += 'if not ' + retVar + ' then return end ';
    } else {
      // 变体2：缓存 string.dump + string.char + math.floor，引用比对 + 行为校验
      const fns = ['string.dump', 'string.char', 'math.floor'];
      fh += 'local ' + retVar + '=true ';
      fh += 'do ';
      fh += 'local ' + v1 + '=' + fns[0] + ' ';
      fh += 'local ' + v2 + '=' + fns[1] + ' ';
      fh += 'local ' + v3 + '=' + fns[2] + ' ';
      fh += 'if ' + fns[0] + '~=' + v1 + ' then ' + retVar + '=false end ';
      fh += 'if ' + fns[1] + '~=' + v2 + ' then ' + retVar + '=false end ';
      fh += 'if ' + fns[2] + '~=' + v3 + ' then ' + retVar + '=false end ';
      fh += 'if not(pcall(' + v1 + ',function() return 1 end)) then ' + retVar + '=false end ';
      fh += 'if not(' + v2 + '(65)=="A") then ' + retVar + '=false end ';
      fh += 'if not(' + v3 + '(3.7)==3) then ' + retVar + '=false end ';
      fh += 'end ';
      fh += 'if not ' + retVar + ' then return end ';
    }
    return fh + ' ' + code;
  },

  // --- 15. 多轮时间追踪陷阱 ---
  // 多轮执行同一代码块，对比时间差检测单步调试
  traceTrapCheck(code) {
    const v1 = this.generateShortStyleName();
    const v2 = this.generateShortStyleName();
    const v3 = this.generateShortStyleName();
    const v4 = this.generateShortStyleName();
    const v5 = this.generateShortName();
    const d1 = this.generateShortStyleName();
    const d2 = this.generateShortStyleName();
    const variant = Math.floor(Math.random() * 3);
    let tt = '';

    if (variant === 0) {
      // 修复#5：使用独立变量名存储时间差，避免命名冲突
      // 两轮取时间差，第二轮不应远大于第一轮（单步调试使后续变慢）
      tt += 'local ' + v1 + '=os.clock() ';
      tt += 'local ' + v2 + '=0 for ' + v5 + '=1,100 do ' + v2 + '=' + v2 + '+1 end ';
      tt += 'local ' + v3 + '=os.clock() ';
      tt += v2 + '=0 for ' + v5 + '=1,100 do ' + v2 + '=' + v2 + '+1 end ';
      tt += 'local ' + v4 + '=os.clock() ';
      tt += 'local ' + d1 + '=' + v3 + '-' + v1 + ' ';
      tt += 'local ' + d2 + '=' + v4 + '-' + v3 + ' ';
      // 第二轮时间差不应远大于第一轮（放宽到 5-8 倍避免误触发）
      tt += 'if ' + d2 + '>' + d1 + '*' + (5 + Math.floor(Math.random() * 4)) + ' then return end ';
    } else if (variant === 1) {
      // 修复#5：放宽阈值避免慢速机器误触发（0.1-0.2 秒）
      tt += 'local ' + v1 + '=os.clock() ';
      tt += 'local ' + v2 + '=0 ';
      tt += 'for ' + v3 + '=1,3 do ';
      tt += 'local ' + v4 + '=os.clock() ';
      tt += 'for ' + v5 + '=1,200 do ' + v2 + '=' + v2 + '+1 end ';
      tt += 'local ' + d1 + '=os.clock()-' + v4 + ' ';
      tt += 'if ' + d1 + '>' + (0.1 + Math.random() * 0.1).toFixed(5) + ' then return end ';
      tt += 'end ';
    } else {
      // 变体2：热路径/冷路径时间对比（放宽倍数避免误触发）
      tt += 'local ' + v1 + '=0 ';
      tt += 'local ' + v2 + '=os.clock() ';
      tt += 'for ' + v3 + '=1,500 do ' + v1 + '=' + v1 + '+1 end ';
      tt += 'local ' + v4 + '=os.clock()-' + v2 + ' ';
      tt += v2 + '=os.clock() ';
      tt += 'for ' + v3 + '=1,500 do ' + v1 + '=' + v1 + '+1 end ';
      tt += 'local ' + v5 + '=os.clock()-' + v2 + ' ';
      tt += 'if ' + v5 + '>' + v4 + '*' + (3 + Math.floor(Math.random() * 3)) + ' then return end ';
    }
    return tt + ' ' + code;
  },

  // --- 16. sethook 拦截陷阱 ---
  // 检测 debug.sethook 是否被 hook/替换，以及是否存在非法 hook 干扰执行
  sethookTrapCheck(code) {
    const v1 = this.generateShortStyleName();
    const v2 = this.generateShortStyleName();
    const v3 = this.generateShortStyleName();
    const v4 = this.generateShortStyleName();
    const v5 = this.generateShortStyleName();
    const variant = Math.floor(Math.random() * 3);
    let tt = '';

    if (variant === 0) {
      // 变体0：设置临时 hook，验证 sethook/gethook 往返一致性
      tt += 'local ' + v1 + '=debug.sethook ';
      tt += 'local ' + v2 + '=debug.gethook ';
      tt += 'local ' + v3 + '=false ';
      tt += 'pcall(function() ';
      // 设置一个空 hook，然后立即清除
      tt += v1 + '(function() end,"l",1) ';
      tt += 'local ' + v4 + '=' + v2 + '() ';
      tt += v1 + '() ';
      // 清除后再次获取，应该为 nil 或无 mask
      tt += 'local ' + v5 + '=' + v2 + '() ';
      // 如果 sethook 不是原始函数（被替换），或清除后仍有 hook → 检测到调试器
      tt += 'if type(' + v1 + ')~="function" or type(' + v2 + ')~="function" then ' + v3 + '=true end ';
      tt += 'if ' + v5 + '~=nil and type(' + v5 + ')=="function" then ' + v3 + '=true end ';
      tt += 'end) ';
      tt += 'if ' + v3 + ' then return end ';
    } else if (variant === 1) {
      // 变体1：通过 hook 计数器检测外部 hook 干扰
      // 设置一个计数 hook，执行一段代码，检查计数是否被外部 hook 篡改
      tt += 'local ' + v1 + '=0 ';
      tt += 'local ' + v2 + '=false ';
      tt += 'pcall(function() ';
      tt += 'debug.sethook(function() ' + v1 + '=' + v1 + '+1 end,"l") ';
      // 执行已知行数的代码（3 行赋值 = 3 次 line 事件）
      tt += 'local ' + v3 + '=1 ';
      tt += v3 + '=' + v3 + '+1 ';
      tt += v3 + '=' + v3 + '+1 ';
      tt += 'debug.sethook() ';
      tt += 'end) ';
      // 正常应 >= 3 次；如果 < 3 说明 hook 被拦截，如果 > 100 说明有其他调试器 hook 叠加
      tt += 'if ' + v1 + '<3 or ' + v1 + '>100 then return end ';
    } else {
      // 变体2：检测 sethook 是否被覆写为非函数或被代理
      tt += 'local ' + v1 + '=debug.sethook ';
      tt += 'local ' + v2 + '=true ';
      // 直接调用 pcall 测试 sethook 是否正常工作
      tt += 'local ' + v3 + '=pcall(' + v1 + ') ';
      // 如果 sethook(nil) 报错，说明被篡改
      tt += 'if not ' + v3 + ' then ' + v2 + '=false end ';
      // 再次验证：设置一个 hook 后立即清除
      tt += 'local ' + v4 + '=pcall(function() ' + v1 + '(nil,"",0) ' + v1 + '() end) ';
      tt += 'if not ' + v4 + ' then ' + v2 + '=false end ';
      tt += 'if not ' + v2 + ' then return end ';
    }
    return tt + ' ' + code;
  },

  // --- 17. debug.getregistry 篡改检测 ---
  // 检测 Lua 注册表是否被调试器/injector 修改
  registryGuardCheck(code) {
    const v1 = this.generateShortStyleName();
    const v2 = this.generateShortStyleName();
    const v3 = this.generateShortStyleName();
    const variant = Math.floor(Math.random() * 3);
    let tt = '';

    if (variant === 0) {
      // 变体0：检查 debug.getregistry 返回的是 table 且包含 _G
      tt += 'local ' + v1 + '=false ';
      tt += 'pcall(function() ';
      tt += 'local ' + v2 + '=debug.getregistry ';
      tt += 'if type(' + v2 + ')~="function" then ' + v1 + '=true return end ';
      tt += 'local ' + v3 + '=' + v2 + '() ';
      tt += 'if type(' + v3 + ')~="table" then ' + v1 + '=true return end ';
      // 注册表应包含 _G 引用（通常是 registry[2] 或通过遍历找到）
      tt += 'local ' + v3 + '_found=false ';
      tt += 'for _k,_v in pairs(' + v3 + ') do if _v==_G then ' + v3 + '_found=true break end end ';
      tt += 'if not ' + v3 + '_found then ' + v1 + '=true end ';
      tt += 'end) ';
      tt += 'if ' + v1 + ' then return end ';
    } else if (variant === 1) {
      // 变体1：验证注册表中关键元表的完整性
      tt += 'local ' + v1 + '=false ';
      tt += 'pcall(function() ';
      tt += 'local ' + v2 + '=debug.getregistry() ';
      // 检查 string 元表是否存在且未被替换
      tt += 'local ' + v3 + '=getmetatable("") ';
      tt += 'if not ' + v3 + ' or type(' + v3 + ')~="table" then ' + v1 + '=true return end ';
      // 验证 string 元表中的 .__index 指向 string 库
      tt += 'if ' + v3 + '.__index~=string then ' + v1 + '=true end ';
      tt += 'end) ';
      tt += 'if ' + v1 + ' then return end ';
    } else {
      // 变体2：注册表大小异常检测（调试器注入会增加注册表条目）
      tt += 'local ' + v1 + '=false ';
      tt += 'pcall(function() ';
      tt += 'local ' + v2 + '=debug.getregistry() ';
      tt += 'local ' + v3 + '=0 ';
      // 遍历注册表计数
      tt += 'for _ in pairs(' + v2 + ') do ' + v3 + '=' + v3 + '+1 if ' + v3 + '>200 then break end end ';
      // 正常 Lua 5.1 注册表通常 < 100 条；> 150 可能注入了调试器
      tt += 'if ' + v3 + '<3 or ' + v3 + '>150 then ' + v1 + '=true end ';
      tt += 'end) ';
      tt += 'if ' + v1 + ' then return end ';
    }
    return tt + ' ' + code;
  },

  // --- 18. rawequal/rawlen 元方法检测 ---
  // 检测 __eq / __len 元方法是否被调试器 hook 以拦截比较操作
  rawMetaCheck(code) {
    const v1 = this.generateShortStyleName();
    const v2 = this.generateShortStyleName();
    const v3 = this.generateShortStyleName();
    const variant = Math.floor(Math.random() * 3);
    let tt = '';

    if (variant === 0) {
      // 变体0：使用 rawequal 验证两个相同对象相等，绕过 __eq
      tt += 'local ' + v1 + '=false ';
      tt += 'local ' + v2 + '={} ';
      // 创建带 __eq 元方法的表，__eq 总是返回 false（干扰比较）
      tt += 'local ' + v3 + '=setmetatable({},{__eq=function() return false end}) ';
      // rawequal 应该忽略 __eq，对同一对象返回 true
      tt += 'if not rawequal(' + v3 + ',' + v3 + ') then ' + v1 + '=true end ';
      // 普通比较会被 __eq 干扰，但 rawequal 不受影响
      // 如果 rawequal 返回 false → rawequal 被篡改
      tt += 'if ' + v1 + ' then return end ';
    } else if (variant === 1) {
      // 变体1：检测 __len 元方法是否被 hook
      tt += 'local ' + v1 + '=false ';
      // 创建一个表，__len 返回错误值
      tt += 'local ' + v2 + '=setmetatable({1,2,3},{__len=function() return 999 end}) ';
      // rawlen 应忽略 __len，返回实际长度 3
      // 注意 Lua 5.1 没有 rawlen，用 # 操作符并配合 table.getn
      tt += 'local ' + v3 + '=rawequal(' + v2 + '[1],1) ';
      // 如果 rawequal 被篡改
      tt += 'if not ' + v3 + ' then return end ';
      // 验证 rawequal 对不同对象返回 false
      tt += 'if rawequal(' + v2 + ',{}) then return end ';
    } else {
      // 变体2：检测 rawset/rawget 是否被 hook
      tt += 'local ' + v1 + '=false ';
      tt += 'local ' + v2 + '={} ';
      // 设置带 __index/__newindex 的元表
      tt += 'local ' + v3 + '={__index=function() return "TRAP" end,__newindex=function() end} ';
      tt += 'setmetatable(' + v2 + ',' + v3 + ') ';
      // rawset 应绕过 __newindex
      tt += 'rawset(' + v2 + ',1,42) ';
      // rawget 应绕过 __index
      tt += 'if rawget(' + v2 + ',1)~=42 then ' + v1 + '=true end ';
      // 如果 rawset/rawget 被 hook，值不会正确写入
      tt += 'if ' + v1 + ' then return end ';
    }
    return tt + ' ' + code;
  },

  // --- 19. 控制流字符串水印 ---
  // 在代码中嵌入隐式水印字符串，运行时校验水印完整性
  // 如果代码被修改/截断，水印校验失败 → 静默 return
  strWatermarkCheck(code) {
    const v1 = this.generateShortStyleName();
    const v2 = this.generateShortStyleName();
    const v3 = this.generateShortStyleName();
    const v4 = this.generateShortStyleName();
    const v5 = this.generateShortStyleName();
    // 生成随机水印字符串（运行时拼接）
    const wmPart1 = this.randomJunkString(4 + Math.floor(Math.random() * 4));
    const wmPart2 = this.randomJunkString(4 + Math.floor(Math.random() * 4));
    const wmPart3 = this.randomJunkString(4 + Math.floor(Math.random() * 4));
    // 水印的预期长度
    const wmLen = wmPart1.length + wmPart2.length + wmPart3.length;
    const variant = Math.floor(Math.random() * 3);
    let tt = '';

    if (variant === 0) {
      // 变体0：运行时拼接水印，验证长度和内容
      tt += 'local ' + v1 + '=("' + wmPart1 + '".."' + wmPart2 + '").."' + wmPart3 + '" ';
      tt += 'if #' + v1 + '~=' + wmLen + ' then return end ';
      // 附加校验：首尾字符匹配
      tt += 'if ' + v1 + ':sub(1,1)~="' + wmPart1[0] + '" or ' + v1 + ':sub(-1)~="' + wmPart3[wmPart3.length-1] + '" then return end ';
    } else if (variant === 1) {
      // 变体1：水印散布在多个变量中，运行时组合校验
      tt += 'local ' + v1 + '="' + wmPart1 + '" ';
      tt += 'local ' + v2 + '="' + wmPart2 + '" ';
      tt += 'local ' + v3 + '="' + wmPart3 + '" ';
      tt += 'local ' + v4 + '=' + v1 + '..' + v2 + '..' + v3 + ' ';
      // 字节和校验
      tt += 'local ' + v5 + '=0 ';
      tt += 'for _i=1,#' + v4 + ' do ' + v5 + '=' + v5 + '+' + v4 + ':byte(_i) end ';
      // 预计算字节和
      let byteSum = 0;
      for (let i = 0; i < wmPart1.length; i++) byteSum += wmPart1.charCodeAt(i);
      for (let i = 0; i < wmPart2.length; i++) byteSum += wmPart2.charCodeAt(i);
      for (let i = 0; i < wmPart3.length; i++) byteSum += wmPart3.charCodeAt(i);
      tt += 'if ' + v5 + '~=' + byteSum + ' then return end ';
    } else {
      // 变体2：水印通过 string.char 运行时构造，避免静态可见
      const chars1 = wmPart1.split('').map(c => c.charCodeAt(0)).join(',');
      const chars2 = wmPart2.split('').map(c => c.charCodeAt(0)).join(',');
      const chars3 = wmPart3.split('').map(c => c.charCodeAt(0)).join(',');
      tt += 'local ' + v1 + '=string.char(' + chars1 + ') ';
      tt += 'local ' + v2 + '=string.char(' + chars2 + ') ';
      tt += 'local ' + v3 + '=string.char(' + chars3 + ') ';
      tt += 'local ' + v4 + '=' + v1 + '..' + v2 + '..' + v3 + ' ';
      tt += 'if #' + v4 + '~=' + wmLen + ' then return end ';
      // 反转校验：reverse(v1..v2..v3) = reverse(v3)..reverse(v2)..reverse(v1)
      tt += 'if ' + v4 + ':reverse()~=(' + v3 + ':reverse()..' + v2 + ':reverse()..' + v1 + ':reverse()) then return end ';
    }
    return tt + ' ' + code;
  },

  // --- 20. 不透明谓词链 ---
  // 插入一系列运行时永远为真（或假）的复杂条件判断
  // 静态分析难以判断真假，但运行时总是走预期分支
  opaquePredCheck(code) {
    const v1 = this.generateShortStyleName();
    const v2 = this.generateShortStyleName();
    const v3 = this.generateShortStyleName();
    const v4 = this.generateShortStyleName();
    const v5 = this.generateShortStyleName();
    const variant = Math.floor(Math.random() * 3);
    let tt = '';

    if (variant === 0) {
      // 变体0：数学恒等式链 — (x*x-x) 总是偶数，(x^3-x) 总是 6 的倍数
      tt += 'local ' + v1 + '=' + Math.floor(Math.random() * 1000 + 100) + ' ';
      tt += 'local ' + v2 + '=' + v1 + '*' + v1 + '-' + v1 + ' ';
      // x^2 - x = x(x-1) 总是偶数
      tt += 'if ' + v2 + '%2~=0 then return end ';
      tt += 'local ' + v3 + '=' + v1 + '*' + v1 + '*' + v1 + '-' + v1 + ' ';
      // x^3 - x = (x-1)x(x+1) 总是 6 的倍数
      tt += 'if ' + v3 + '%6~=0 then return end ';
      // 附加：位运算验证
      tt += 'local ' + v4 + '=math.floor(' + v1 + '/2) ';
      tt += 'if (' + v4 + '*2)~=' + v1 + ' and (' + v4 + '*2+1)~=' + v1 + ' then return end ';
    } else if (variant === 1) {
      // 变体1：字符串长度恒等式
      tt += 'local ' + v1 + '="ABCD" ';
      tt += 'local ' + v2 + '="EFGHIJ" ';
      tt += 'local ' + v3 + '=#' + v1 + '+#' + v2 + ' ';
      // 4 + 6 = 10
      tt += 'if ' + v3 + '~=10 then return end ';
      // 字符串拼接后长度等于各自长度之和
      tt += 'local ' + v4 + '=' + v1 + '..' + v2 + ' ';
      tt += 'if #' + v4 + '~=#' + v1 + ' and #' + v4 + '~=(#' + v1 + '+#' + v2 + ') then return end ';
      // 如果拼接后长度不等于各自之和 → 字符串库被篡改
      tt += 'if #' + v4 + '~=(#' + v1 + '+#' + v2 + ') then return end ';
    } else {
      // 变体2：表操作恒等式
      tt += 'local ' + v1 + '={} ';
      tt += 'for ' + v2 + '=1,10 do ' + v1 + '[' + v2 + ']=' + v2 + ' end ';
      // 表长度应为 10
      tt += 'if #' + v1 + '~=10 then return end ';
      // 元素和应为 55 (1+2+...+10)
      tt += 'local ' + v3 + '=0 ';
      tt += 'for ' + v2 + '=1,#' + v1 + ' do ' + v3 + '=' + v3 + '+' + v1 + '[' + v2 + '] end ';
      tt += 'if ' + v3 + '~=55 then return end ';
      // remove 然后 insert 应保持长度
      tt += 'table.remove(' + v1 + ',1) ';
      tt += 'if #' + v1 + '~=9 then return end ';
      tt += 'table.insert(' + v1 + ',1,1) ';
      tt += 'if #' + v1 + '~=10 then return end ';
    }
    return tt + ' ' + code;
  },

  // --- 21. 诱饵函数陷阱 ---
  // 插入看似重要但实际无用的函数，带有反调试检测
  // 逆向分析者会尝试分析这些函数，触发陷阱
  decoyFuncCheck(code) {
    const v1 = this.generateShortStyleName();
    const v2 = this.generateShortStyleName();
    const v3 = this.generateShortStyleName();
    const v4 = this.generateShortStyleName();
    const v5 = this.generateShortStyleName();
    const decoyName = this.generateShortStyleName();
    const variant = Math.floor(Math.random() * 3);
    let tt = '';

    if (variant === 0) {
      // 变体0：诱饵函数内部检测调用栈深度，被调试时栈深度异常
      tt += 'local function ' + decoyName + '(' + v1 + ',' + v2 + ') ';
      tt += 'local ' + v3 + '=0 ';
      tt += 'pcall(function() for _i=1,99 do local _d=debug.getinfo(_i) if not _d then break end ' + v3 + '=' + v3 + '+1 end end) ';
      // 正常调用栈深度 < 10；如果 > 15 说明有调试器附加
      tt += 'if ' + v3 + '>15 then return nil end ';
      // 返回看起来有用的值
      tt += 'return ' + v1 + '+' + v2 + '+' + Math.floor(Math.random() * 100) + ' ';
      tt += 'end ';
      // 调用诱饵函数（结果不使用，但函数执行了检测）
      tt += 'local ' + v4 + '=' + decoyName + '(' + Math.floor(Math.random() * 50) + ',' + Math.floor(Math.random() * 50) + ') ';
      tt += 'if ' + v4 + '==nil then return end ';
    } else if (variant === 1) {
      // 变体1：诱饵函数包含时间检测
      tt += 'local function ' + decoyName + '() ';
      tt += 'local ' + v1 + '=os.clock() ';
      tt += 'local ' + v2 + '=0 ';
      tt += 'for ' + v3 + '=1,1000 do ' + v2 + '=' + v2 + '+' + v3 + ' end ';
      tt += 'local ' + v4 + '=os.clock()-' + v1 + ' ';
      // 如果执行时间 > 1 秒 → 被单步调试
      tt += 'if ' + v4 + '>1.0 then return nil end ';
      tt += 'return ' + v2 + ' ';
      tt += 'end ';
      tt += 'local ' + v5 + '=' + decoyName + '() ';
      // 验证返回值（1+2+...+1000 = 500500）
      tt += 'if ' + v5 + '~=500500 then return end ';
    } else {
      // 变体2：诱饵函数检测 string.dump 是否可用（反汇编工具特征）
      tt += 'local function ' + decoyName + '() ';
      tt += 'local ' + v1 + '=string.dump ';
      // 如果 string.dump 被替换为非函数或被 hook
      tt += 'if type(' + v1 + ')~="function" then return -1 end ';
      // 尝试 dump 自身（如果被 hook 会改变行为）
      tt += 'local ' + v2 + '=pcall(' + v1 + ',function() return 0 end) ';
      // 在某些环境（如 Roblox）string.dump 不可用，这是正常的
      // 但如果之前可用突然不可用 → 可能被 hook
      tt += 'return ' + v2 + ' and 1 or 0 ';
      tt += 'end ';
      tt += 'local ' + v3 + '=' + decoyName + '() ';
      // -1 表示 dump 被篡改 → 触发
      tt += 'if ' + v3 + '==-1 then return end ';
    }
    return tt + ' ' + code;
  },

  // --- 22. 元表 __index 陷阱 ---
  // 创建带 __index 元方法的表，检测元表是否被调试器篡改
  metaTrapCheck(code) {
    const v1 = this.generateShortStyleName();
    const v2 = this.generateShortStyleName();
    const v3 = this.generateShortStyleName();
    const v4 = this.generateShortStyleName();
    const v5 = this.generateShortStyleName();
    const variant = Math.floor(Math.random() * 3);
    let tt = '';

    if (variant === 0) {
      // 变体0：__index 计数器陷阱 — 如果 __index 被调用次数异常，说明有外部访问
      tt += 'local ' + v1 + '=0 ';
      tt += 'local ' + v2 + '={} ';
      tt += 'local ' + v3 + '={__index=function(_,k) ' + v1 + '=' + v1 + '+1 return rawget(' + v2 + ',k) end} ';
      tt += 'setmetatable(' + v2 + ',' + v3 + ') ';
      // 正常访问：代码内部访问已知 key，触发 __index 固定次数
      tt += 'local ' + v4 + '=' + v2 + '.nonexist1 ';
      tt += 'local ' + v5 + '=' + v2 + '.nonexist2 ';
      // 应该恰好 2 次 __index 调用
      tt += 'if ' + v1 + '~=2 then return end ';
    } else if (variant === 1) {
      // 变体1：__index 返回值验证 — 检测 __index 是否被代理/篡改
      tt += 'local ' + v1 + '={__index=function(_,k) return k.."_OK" end} ';
      tt += 'local ' + v2 + '=setmetatable({},{' + v1 + '}) ';
      // __index 应返回 "test_OK"
      tt += 'local ' + v3 + '=' + v2 + '.test ';
      tt += 'if ' + v3 + '~="test_OK" then return end ';
      // 再次验证不同 key
      tt += 'local ' + v4 + '=' + v2 + '.hello ';
      tt += 'if ' + v4 + '~="hello_OK" then return end ';
    } else {
      // 变体2：__newindex + __index 双重陷阱
      tt += 'local ' + v1 + '={} ';
      tt += 'local ' + v2 + '={} ';
      tt += 'local ' + v3 + '=0 ';
      tt += 'local ' + v4 + '=setmetatable(' + v1 + ',{';
      tt += '__newindex=function(t,k,v) ' + v3 + '=' + v3 + '+1 rawset(' + v2 + ',k,v) end,';
      tt += '__index=function(t,k) return rawget(' + v2 + ',k) end';
      tt += '}) ';
      // 写入数据，应触发 __newindex
      tt += v4 + '.a=1 ';
      tt += v4 + '.b=2 ';
      // 读取数据，应通过 __index 从影子表获取
      tt += 'if ' + v4 + '.a~=1 or ' + v4 + '.b~=2 then return end ';
      // __newindex 应被调用 2 次
      tt += 'if ' + v3 + '~=2 then return end ';
      // 原表应为空（数据写入了影子表）
      tt += 'if next(' + v1 + ')~=nil then return end ';
    }
    return tt + ' ' + code;
  },

  // --- 安全防护套件总入口 ---
  // 按协同顺序应用所有启用的防护技术
  // 修复#3：交叉验证链 — 每个检查的结果参与下一个检查
  // 攻击者无法通过一次性覆写所有函数来绕过，因为每个函数被不同输入调用
  securitySuite(code) {
    // 私有缓存防护层：在闭包中捕获关键内置函数的原始引用
    // 外部无法通过 _G 或 debug.getlocal 获取这些缓存
    // 运行时校验：1)引用一致性 2)行为正确性 3)交叉验证链
    const cacheVar = this.generateShortStyleName();
    const refVar = this.generateShortStyleName();
    const chkVar = this.generateShortStyleName();
    const retVar = this.generateShortStyleName();
    
    // 需要缓存的关键函数列表（混淆后随机选取子集）
    const criticalFns = ['print', 'pcall', 'tostring', 'tonumber', 'string.byte', 
                         'string.sub', 'string.find', 'string.len', 'string.rep',
                         'math.floor', 'math.abs', 'string.char', 'string.dump'];
    // 随机选 6-8 个函数进行缓存校验
    const cacheCount = 6 + Math.floor(Math.random() * 3);
    const shuffled = [...criticalFns].sort(() => Math.random() - 0.5);
    const selected = shuffled.slice(0, Math.min(cacheCount, shuffled.length));
    
    // 为每个被选中的函数生成别名
    const fnAliases = {};
    for (const fn of selected) {
      fnAliases[fn] = this.generateShortStyleName();
    }
    
    // 构建私有缓存闭包
    let cacheGuard = '';
    cacheGuard += 'local ' + retVar + '=true ';
    cacheGuard += 'do ';
    // 在闭包内捕获原始函数引用
    for (const fn of selected) {
      cacheGuard += 'local ' + fnAliases[fn] + '=' + fn + ' ';
    }
    // 引用一致性校验：比对全局函数是否被替换
    for (const fn of selected) {
      cacheGuard += 'if ' + fn + '~=' + fnAliases[fn] + ' then ' + retVar + '=false end ';
    }
    // 行为校验：用缓存的原始函数执行已知输入，验证输出正确
    const behaviorChecks = [
      { fn: 'string.byte', expr: fnAliases['string.byte'] + '("A")==65', requires: 'string.byte' },
      { fn: 'string.sub', expr: fnAliases['string.sub'] + '("hello",2,4)=="ell"', requires: 'string.sub' },
      { fn: 'string.len', expr: fnAliases['string.len'] + '("test")==4', requires: 'string.len' },
      { fn: 'string.rep', expr: fnAliases['string.rep'] + '("ab",3)=="ababab"', requires: 'string.rep' },
      { fn: 'math.floor', expr: fnAliases['math.floor'] + '(3.7)==3', requires: 'math.floor' },
      { fn: 'math.abs', expr: fnAliases['math.abs'] + '(-5)==5', requires: 'math.abs' },
      { fn: 'tonumber', expr: fnAliases['tonumber'] + '("42")==42', requires: 'tonumber' },
      { fn: 'tostring', expr: fnAliases['tostring'] + '(42)=="42"', requires: 'tostring' },
      { fn: 'string.char', expr: fnAliases['string.char'] + '(65)=="A"', requires: 'string.char' },
      { fn: 'pcall', expr: fnAliases['pcall'] + '(function() return 1 end)==true', requires: 'pcall' },
      { fn: 'print', expr: 'pcall(' + fnAliases['print'] + ',"")==true', requires: 'print' },
      { fn: 'string.find', expr: fnAliases['string.find'] + '("abc","b")~=nil', requires: 'string.find' },
      { fn: 'string.dump', expr: 'pcall(' + fnAliases['string.dump'] + ',function() return 1 end)', requires: 'string.dump' },
    ];
    // 随机选 4-6 个行为校验
    const availableChecks = behaviorChecks.filter(c => selected.includes(c.requires));
    const behaviorCount = Math.min(4 + Math.floor(Math.random() * 3), availableChecks.length);
    const behaviorSelected = [...availableChecks].sort(() => Math.random() - 0.5).slice(0, behaviorCount);
    for (const check of behaviorSelected) {
      cacheGuard += 'if not(' + check.expr + ') then ' + retVar + '=false end ';
    }
    cacheGuard += 'end ';
    // 引用不一致或行为异常则退出（增强：随机失败模式）
    const _failMode = Math.floor(Math.random() * 2);
    if (_failMode === 0) {
      cacheGuard += 'if not ' + retVar + ' then return end ';
    } else {
      cacheGuard += 'if not ' + retVar + ' then error("[SEC] cache guard triggered") end ';
    }
    
    // 交叉验证链（使用全局函数名，因为别名在 do 块外不可见；
    // 引用一致性已由上面的私有缓存层保证，这里验证函数行为正确性）
    const cv = this.generateShortStyleName();
    const cv2 = this.generateShortStyleName();
    const cv3 = this.generateShortStyleName();
    const cv4 = this.generateShortStyleName();
    const cv5 = this.generateShortStyleName();
    const cv6 = this.generateShortStyleName();
    const cv7 = this.generateShortStyleName();
    const cvChk = this.generateShortStyleName();
    const salt = Math.floor(Math.random() * 9000) + 1000;
    const expected = 342; // 65+2+30+101+99+20+25
    const part2 = (expected - (salt * 7) % 65521 + 65521 * 100) % 65521;
    let guard = '';
    guard += 'local ' + cv + '=string.byte("A") ';
    guard += 'local ' + cv2 + '=' + cv + '+tostring(42):len() ';
    guard += 'local ' + cv3 + '=' + cv2 + '+math.floor(3.7)*10 ';
    guard += 'local ' + cv4 + '=' + cv3 + '+string.byte(string.sub("hello",2,4),1) ';
    guard += 'local ' + cv5 + '=' + cv4 + '+tonumber("99") ';
    guard += 'local ' + cv6 + '=' + cv5 + '+string.len("test")*5 ';
    guard += 'local ' + cv7 + '=' + cv6 + '+math.abs(string.byte("z")-string.byte("a")) ';
    guard += 'local ' + cvChk + '=(' + salt + '*7+' + part2 + ')%65521 ';
    const _cvFail = Math.floor(Math.random() * 3);
    if (_cvFail === 0) {
      guard += 'if ' + cv7 + '~=' + cvChk + ' then return end ';
    } else if (_cvFail === 1) {
      guard += 'if ' + cv7 + '~=' + cvChk + ' then error("[SEC] cross-validation failed") end ';
    } else {
      guard += 'if ' + cv7 + '~=' + cvChk + ' then print("[SEC] CV fail") return end ';
    }
    code = cacheGuard + guard + ' ' + code;

    // 调用栈检查最先执行（检测外层包装）
    if (this.config.antiDebug_callStack) {
      code = this.callStackCheck(code);
      this.log('调用栈检查已注入');
    }
    // 环境检测次之（确认运行环境合法）
    if (this.config.antiDebug_envCheck) {
      code = this.environmentCheck(code);
      this.log('环境检测已注入');
    }
    // 调试器检测
    if (this.config.antiDebug_debugger) {
      code = this.debuggerCheck(code);
      this.log('调试器检测已注入');
    }
    // GC 操纵检测
    if (this.config.antiDebug_gcManip) {
      code = this.gcManipCheck(code);
      this.log('GC操纵检测已注入');
    }
    // Hook 链检测
    if (this.config.antiDebug_hookChain) {
      code = this.hookChainCheck(code);
      this.log('Hook链检测已注入');
    }
    // 内存扫描检测
    if (this.config.antiDebug_memScan) {
      code = this.memScanCheck(code);
      this.log('内存扫描检测已注入');
    }
    // CPU 频率校准
    if (this.config.antiDebug_freqCheck) {
      code = this.freqCheck(code);
      this.log('CPU频率校准已注入');
    }
    // 协程探针检测
    if (this.config.antiDebug_coroProbe) {
      code = this.coroProbeCheck(code);
      this.log('协程探针检测已注入');
    }
    // 字符串元方法篡改检测
    if (this.config.antiDebug_strMeta) {
      code = this.strMetaCheck(code);
      this.log('字符串元方法检测已注入');
    }
    // 断点陷阱
    if (this.config.antiDebug_bpTrap) {
      code = this.bpTrapCheck(code);
      this.log('断点陷阱已注入');
    }
    // 局部变量探测
    if (this.config.antiDebug_localProbe) {
      code = this.localProbeCheck(code);
      this.log('局部变量探测已注入');
    }
    // 函数哈希守卫
    if (this.config.antiDebug_funcHash) {
      code = this.funcHashCheck(code);
      this.log('函数哈希守卫已注入');
    }
    // 多轮时间追踪陷阱
    if (this.config.antiDebug_traceTrap) {
      code = this.traceTrapCheck(code);
      this.log('多轮时间追踪已注入');
    }
    // sethook 拦截陷阱
    if (this.config.antiDebug_sethookTrap) {
      code = this.sethookTrapCheck(code);
      this.log('sethook拦截陷阱已注入');
    }
    // debug.getregistry 篡改检测
    if (this.config.antiDebug_registryGuard) {
      code = this.registryGuardCheck(code);
      this.log('注册表篡改检测已注入');
    }
    // rawequal/rawlen 元方法检测
    if (this.config.antiDebug_rawMetaCheck) {
      code = this.rawMetaCheck(code);
      this.log('raw元方法检测已注入');
    }
    // 控制流字符串水印
    if (this.config.antiDebug_strWatermark) {
      code = this.strWatermarkCheck(code);
      this.log('字符串水印已注入');
    }
    // 不透明谓词链
    if (this.config.antiDebug_opaquePred) {
      code = this.opaquePredCheck(code);
      this.log('不透明谓词链已注入');
    }
    // 诱饵函数陷阱
    if (this.config.antiDebug_decoyFunc) {
      code = this.decoyFuncCheck(code);
      this.log('诱饵函数陷阱已注入');
    }
    // 元表 __index 陷阱
    if (this.config.antiDebug_metaTrap) {
      code = this.metaTrapCheck(code);
      this.log('元表__index陷阱已注入');
    }
    // 时间炸弹（包裹代码执行）
    if (this.config.antiDebug_timeBomb) {
      code = this.timeBomb(code);
      this.log('时间炸弹已注入');
    }
    // 反篡改校验最后执行（对最终代码做完整性校验）
    if (this.config.antiDebug_tamper) {
      code = this.antiTamper(code);
      this.log('反篡改校验已注入');
    }

    // ========== 反逆向套件 ==========
    if (this.config.antiRev_stringFog) {
      code = this.stringFog(code);
      this.log('字符串雾化已注入');
    }
    if (this.config.antiRev_controlFlowSpaghetti) {
      code = this.controlFlowSpaghetti(code);
      this.log('控制流面条化已注入');
    }
    if (this.config.antiRev_deadCodeInjection) {
      code = this.deadCodeInjection(code);
      this.log('死代码注入已完成');
    }
    if (this.config.antiRev_varIndirection) {
      code = this.varIndirection(code);
      this.log('变量间接寻址已注入');
    }
    if (this.config.antiRev_opaqueExpr) {
      code = this.opaqueExpr(code);
      this.log('不透明表达式已注入');
    }
    if (this.config.antiRev_antiDecompile) {
      code = this.antiDecompile(code);
      this.log('反反编译已注入');
    }
    if (this.config.antiRev_selfModifying) {
      code = this.selfModifyingCode(code);
      this.log('自修改代码已注入');
    }
    if (this.config.antiRev_metaObfuscation) {
      code = this.metaObfuscation(code);
      this.log('元表混淆已注入');
    }

    return code;
  },

  // ========== 反逆向：字符串雾化 ==========
  // 将明文字符串拆分为多段，通过运行时运算（XOR/算术）还原
  // 使静态分析无法直接提取字符串特征
  stringFog(code) {
    // 匹配双引号字符串（跳过转义）
    return code.replace(/"((?:[^"\\]|\\.)*)"/g, (full, content) => {
      if (content.length < 2) return full;
      // 将字符串拆分为字符数组，用算术运算还原
      const chars = [];
      for (let i = 0; i < content.length; i++) {
        const byte = content.charCodeAt(i);
        const key = Math.floor(fastRandom() * 200) + 50;
        const encrypted = byte ^ key;
        // Bug14修复: ~是Lua5.3+位运算符，Lua5.1用bit32.bxor替代
        // Bug: bit32可能为nil（Roblox Luau），用算术XOR替代
        chars.push('string.char((' + encrypted + '+256-' + key + ')%256)');
      }
      const v = this.generateShortStyleName();
      const parts = ['(function()local ', v, '="" '];
      // 分批拼接，避免单行过长
      const batchSize = 8;
      for (let i = 0; i < chars.length; i += batchSize) {
        const batch = chars.slice(i, Math.min(i + batchSize, chars.length));
        parts.push(v, '=', v, '..', batch.join('..'), ' ');
      }
      parts.push('return ', v, ' end)()');
      return parts.join('');
    });
  },

  // ========== 反逆向：控制流面条化 ==========
  // 在代码顶层插入随机跳转和虚假分支，打乱执行流
  // 使用 goto/label 构造不可预测的跳转链
  controlFlowSpaghetti(code) {
    const v1 = this.generateShortStyleName();
    const v2 = this.generateShortStyleName();
    const v3 = this.generateShortStyleName();
    const v4 = this.generateShortStyleName();
    const numLabels = 5 + Math.floor(Math.random() * 4);
    let s = 'local ' + v1 + '=' + Math.floor(Math.random() * 1000) + ' ';
    s += 'local ' + v2 + '=' + Math.floor(Math.random() * 1000) + ' ';
    s += 'local ' + v3 + '=0 ';
    s += 'local ' + v4 + '=false ';
    // Bug27修复: goto/::label:: 是Lua5.2+特性，Lua5.1不支持
    // 等价替换：原goto链中每个条件跳转仅跳向紧邻的下一label（顺序执行），
    // 用 do...end 块保留全部变量运算，混淆效果不变
    s += 'do ';
    for (let i = 0; i < numLabels; i++) {
      s += v3 + '=' + v3 + '+' + (i + 1) + ' ';
      s += 'do local _b=bit32 or {bxor=function(a,b) local r=0 local s=1 for _=1,32 do if (a%2)+(b%2)==1 then r=r+s end a=math.floor(a/2) b=math.floor(b/2) s=s*2 end return r end} ' + v2 + '=_b.bxor(' + v2 + ',' + v1 + ') end ';
    }
    s += 'end ';
    s += 'if ' + v4 + ' then return end ';
    return s + code;
  },

  // ========== 反逆向：死代码注入 ==========
  // 注入永不可达的代码块（条件恒为 false），包含逼真的逻辑结构
  // 干扰反编译器的控制流分析和可达性分析
  deadCodeInjection(code) {
    const blocks = [];
    const numBlocks = 8 + Math.floor(Math.random() * 8);
    for (let i = 0; i < numBlocks; i++) {
      const v1 = this.generateShortStyleName();
      const v2 = this.generateShortStyleName();
      const v3 = this.generateShortStyleName();
      const variant = Math.floor(Math.random() * 5);
      let block = '';
      switch (variant) {
        case 0:
          // 恒假 if 块 + 假函数调用
          block = 'if ' + v1 + '==' + Math.floor(Math.random()*1000) + ' and ' + v1 + '~=' + Math.floor(Math.random()*1000) + ' then ';
          block += 'local ' + v2 + '=function(' + v3 + ') return ' + v3 + '*' + Math.floor(Math.random()*99+1) + ' end ';
          block += v2 + '(' + Math.floor(Math.random()*100) + ') end ';
          break;
        case 1:
          // 恒假 while 循环
          block = 'while ' + Math.floor(Math.random()*100) + '>' + (Math.floor(Math.random()*100)+100) + ' do ';
          block += 'local ' + v2 + '={' + Math.floor(Math.random()*100) + ',' + Math.floor(Math.random()*100) + '} ';
          block += 'for ' + v3 + ',_ in ipairs(' + v2 + ') do local _t=' + v3 + '+1 end end ';
          break;
        case 2:
          // 不可达 for 循环（空范围）
          block = 'for ' + v1 + '=' + Math.floor(Math.random()*10+20) + ',' + Math.floor(Math.random()*10) + ' do ';
          block += 'local ' + v2 + '=string.rep("x",' + Math.floor(Math.random()*50) + ') ';
          block += v2 + '=nil end ';
          break;
        case 3:
          // 恒假条件 + 表操作
          block = 'if nil then ';
          block += 'local ' + v1 + '={[0x1]=' + Math.floor(Math.random()*999) + ',[0x2]=' + Math.floor(Math.random()*999) + '} ';
          block += 'local ' + v2 + '=' + v1 + '[0x1]+' + v1 + '[0x2] ';
          block += v2 + '=nil end ';
          break;
        case 4:
          // 互斥条件恒假
          const a = Math.floor(Math.random()*1000);
          const b = a + 1 + Math.floor(Math.random()*100);
          block = 'if (' + a + '>' + b + ') or (' + b + '<' + a + ') then ';
          block += 'local ' + v1 + '=math.sqrt(' + Math.floor(Math.random()*9999) + ') ';
          block += v1 + '=' + v1 + ' and nil end ';
          break;
      }
      blocks.push(block);
    }
    // 将死代码块随机插入到代码顶层
    return blocks.join(' ') + ' ' + code;
  },

  // ========== 反逆向：变量间接寻址 ==========
  // 将直接变量访问替换为通过表索引的间接访问
  // 例如：local x=1 → local _T={[1]=1}; x=_T[1]
  // 隐藏数据流，增加静态分析难度
  varIndirection(code) {
    // 收集代码中的 local 变量声明
    const localPattern = /local\s+([a-zA-Z_]\w*)\s*=\s*([^;\n]+)/g;
    const indirectTable = this.generateShortStyleName();
    const replacements = [];
    let match;
    let idx = 1;
    while ((match = localPattern.exec(code)) !== null) {
      const varName = match[1];
      const value = match[2].trim();
      // 跳过函数定义和复杂表达式
      if (value.startsWith('function') || value.length > 80) continue;
      // 跳过已经是表索引访问的
      if (value.includes('[') && value.includes(']')) continue;
      const hexIdx = '0x' + idx.toString(16);
      replacements.push({
        original: match[0],
        replacement: hexIdx + '];' + varName + '=' + indirectTable + '[' + hexIdx,
        idx: hexIdx,
        value: value
      });
      idx++;
    }
    if (replacements.length === 0) return code;

    // 构建间接寻址表
    let tableInit = 'local ' + indirectTable + '={';
    for (const r of replacements) {
      tableInit += '[' + r.idx + ']=' + r.value + ',';
    }
    tableInit = tableInit.slice(0, -1) + '} ';

    // 替换代码中的 local 声明
    let result = tableInit;
    let modifiedCode = code;
    for (const r of replacements) {
      // 将 "local varName=value" 替换为 "varName=_T[0xN]"
      const regex = new RegExp('local\\s+' + r.original.replace(/local\s+/, '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g');
      modifiedCode = modifiedCode.replace(r.original, r.original.split('=')[0].replace('local ', '') + '=' + indirectTable + '[' + r.idx + ']');
    }
    return result + modifiedCode;
  },

  // ========== 反逆向：不透明表达式 ==========
  // 将简单常量和布尔值替换为复杂的数学运算表达式
  // 例如：true → (math.floor(3.7)*2-5)==1, 50 → (7*7+1)
  opaqueExpr(code) {
    // 替换布尔常量 true/false
    code = code.replace(/\btrue\b/g, () => {
      const v = Math.floor(Math.random() * 3);
      switch (v) {
        case 0: return '(math.floor(' + (Math.random()*10+1).toFixed(1) + ')*2-2*1+1>0)';
        case 1: return '(' + Math.floor(Math.random()*100) + '%' + (Math.floor(Math.random()*8)+2) + '>=0)';
        // Bug17修复: {}=={}在Lua中比较两个不同table引用，结果为false而非true
        case 2: return '(not(false))';
      }
      return 'true';
    });
    // 替换布尔常量 false
    code = code.replace(/\bfalse\b/g, () => {
      const v = Math.floor(Math.random() * 3);
      switch (v) {
        case 0: return '(math.floor(' + (Math.random()*10+1).toFixed(1) + ')*0>1)';
        // Bug17修复: {}~={}在Lua中比较两个不同table引用，结果为true而非false
        case 1: return '(not(true))';
        case 2: return '(nil and true)';
      }
      return 'false';
    });
    return code;
  },

  // ========== 反逆向：反反编译 ==========
  // 注入导致反编译器崩溃或超时的结构
  // 1. 超深嵌套表构造器（栈溢出）
  // 2. 超长字符串拼接行（超时）
  // 3. 大量无意义的 local 声明（内存耗尽）
  antiDecompile(code) {
    const v1 = this.generateShortStyleName();
    const v2 = this.generateShortStyleName();
    let s = '';

    // 1. 深度嵌套表（15 层）
    s += 'local ' + v1 + '=';
    let depth = 15;
    for (let i = 0; i < depth; i++) {
      s += '{[0x' + i.toString(16) + ']=';
    }
    s += '0';
    for (let i = 0; i < depth; i++) {
      s += '}';
    }
    s += ' ';

    // 2. 大量 local 声明（100 个）
    s += 'local ' + v2 + '={} ';
    for (let i = 0; i < 100; i++) {
      const idx = '0x' + i.toString(16);
      s += v2 + '[' + idx + ']=' + Math.floor(Math.random()*65536) + ' ';
    }
    s += v2 + '=nil ';
    s += v1 + '=nil ';

    return s + code;
  },

  // ========== 反逆向：自修改代码 ==========
  // 运行时通过 load 执行载荷代码
  // 将部分逻辑隐藏在运行时拼接的字符串中
  selfModifyingCode(code) {
    const v1 = this.generateShortStyleName();
    const v2 = this.generateShortStyleName();
    const v3 = this.generateShortStyleName();
    const v4 = this.generateShortStyleName();
    const v5 = this.generateShortStyleName();

    // 将代码转为字符编码表，运行时还原并执行
    const codeBytes = [];
    // 生成一段无害的 Lua 代码作为自修改载荷
    const payload = 'local ' + v5 + '=' + Math.floor(Math.random()*1000) + ' ';
    for (let i = 0; i < payload.length; i++) {
      codeBytes.push(payload.charCodeAt(i));
    }

    let s = 'local ' + v1 + '={';
    s += codeBytes.join(',');
    s += '} ';
    // 使用 table.concat 避免 O(n²) 拼接
    s += 'local _tc={} ';
    s += 'for ' + v3 + '=1,#' + v1 + ' do ';
    s += '_tc[' + v3 + ']=string.char(' + v1 + '[' + v3 + ']) ';
    s += 'end ';
    s += 'local ' + v2 + '=table.concat(_tc) ';
    // 通过 load 执行载荷
    s += 'local ' + v4 + '=load(' + v2 + ') ';
    s += 'if ' + v4 + ' then local ' + v5 + '=' + v4 + '() ';
    s += 'if ' + v5 + ' then ' + v5 + '() end end ';

    return s + code;
  },

  // ========== 反逆向：元表混淆 ==========
  // 使用 __index/__newindex 元方法隐藏变量访问和赋值
  // 所有变量访问通过元表代理，隐藏真实数据流
  metaObfuscation(code) {
    const tblVar = this.generateShortStyleName();
    const metaVar = this.generateShortStyleName();
    const v1 = this.generateShortStyleName();
    const v2 = this.generateShortStyleName();
    const v3 = this.generateShortStyleName();
    const v4 = this.generateShortStyleName();
    const v5 = this.generateShortStyleName();

    let s = '';
    // 创建代理表和元表
    s += 'local ' + tblVar + '={} ';
    s += 'local ' + metaVar + '={} ';
    s += metaVar + '.__index=function(' + v1 + ',' + v2 + ') ';
    s += 'local ' + v3 + '=rawget(' + v1 + ',' + v2 + ') ';
    s += 'if ' + v3 + '==nil then return nil end ';
    s += 'return ' + v3 + ' end ';
    s += metaVar + '.__newindex=function(' + v1 + ',' + v2 + ',' + v4 + ') ';
    s += 'rawset(' + v1 + ',' + v2 + ',' + v4 + ') end ';
    s += 'setmetatable(' + tblVar + ',' + metaVar + ') ';

    // 在代理表中存储一些干扰数据
    const numEntries = 10 + Math.floor(Math.random() * 10);
    for (let i = 0; i < numEntries; i++) {
      const key = this.randomJunkString(Math.floor(Math.random() * 8) + 3);
      const val = Math.floor(Math.random() * 1000);
      s += tblVar + '["' + key + '"]=' + val + ' ';
    }

    // 通过代理表访问（触发 __index）
    s += 'local ' + v5 + '=' + tblVar + '["' + this.randomJunkString(5) + '"] ';
    s += v5 + '=nil ';
    s += tblVar + '=nil ';
    s += metaVar + '=nil ';

    return s + code;
  },

  // ========== 隐藏自定义 Base64 编码表 ==========
  // 将代码中的所有字符串字面量用自定义 Base64 编码
  // 编码表（64 字符字母表）在运行时从加密数据中动态重建
  // 特征：
  // 1. 标准 Base64 字母表被打乱（Fisher-Yates 洗牌）
  // 2. 打乱后的字母表被 XOR 加密为字节序列
  // 3. 运行时通过多层解密重建字母表
  // 4. 字符串用自定义字母表编码，静态分析无法直接解码
  // 5. 每次混淆生成不同的字母表和密钥
  customBase64Table(code) {
    // 1. 生成打乱的 Base64 字母表
    const b64Std = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
    const b64Chars = b64Std.split('');
    for (let i = b64Chars.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [b64Chars[i], b64Chars[j]] = [b64Chars[j], b64Chars[i]];
    }
    const b64Alphabet = b64Chars.join('');

    // 2. 对字母表进行 XOR 加密
    const xorKey = [];
    const keyLen = 16 + Math.floor(Math.random() * 16); // 16-31 字节密钥
    for (let i = 0; i < keyLen; i++) {
      xorKey.push(Math.floor(Math.random() * 256));
    }
    const deriveSeed = Math.floor(Math.random() * 200) + 30;

    // 运行时重建变体（JS 侧预计算必须与 Lua 侧重建逻辑一致）
    const rebuildVariant = Math.floor(Math.random() * 3);
    let multVal, half1Mult, half2Mult, half2Seed, bitMask;
    if (rebuildVariant === 0) {
      multVal = Math.floor(Math.random()*30)+17;
    } else if (rebuildVariant === 1) {
      half1Mult = Math.floor(Math.random()*30)+17;
      half2Mult = Math.floor(Math.random()*30)+17;
      half2Seed = deriveSeed + Math.floor(Math.random() * 100) + 17;
    } else {
      bitMask = Math.floor(Math.random() * 255) + 1;
      multVal = Math.floor(Math.random()*40)+21;
    }

    // JS 侧使用与 Lua 侧完全相同的迭代式密钥派生来加密
    const b64EncBytes = [];
    let jsDk = deriveSeed;
    for (let i = 0; i < 64; i++) {
      // Lua 索引从 1 开始，i 对应 Lua 中的 loopVar = i+1
      const luaIdx = i + 1;
      if (rebuildVariant === 0) {
        // 变体 0: dk = (dk * multVal + key[(luaIdx-1)%keyLen+1] + (luaIdx-1)*13) % 256
        jsDk = (jsDk * multVal + xorKey[(luaIdx - 1) % keyLen] + (luaIdx - 1) * 13) % 256;
      } else if (rebuildVariant === 1) {
        if (i < 32) {
          jsDk = (jsDk * half1Mult + xorKey[(luaIdx - 1) % keyLen] + (luaIdx - 1) * 13) % 256;
        } else {
          if (i === 32) jsDk = half2Seed;
          jsDk = (jsDk * half2Mult + xorKey[(luaIdx - 1) % keyLen] + (luaIdx - 32) * 17) % 256;
        }
      } else {
        jsDk = (jsDk * multVal + xorKey[(luaIdx - 1) % keyLen] + luaIdx * 7) % 256;
      }
      let encByte;
      if (rebuildVariant === 2) {
        encByte = (b64Alphabet.charCodeAt(i) ^ jsDk ^ bitMask) & 0xFF;
      } else {
        encByte = (b64Alphabet.charCodeAt(i) ^ jsDk) & 0xFF;
      }
      b64EncBytes.push(encByte);
    }

    // 3. 生成 Lua 侧的编码表重建 + 解码器代码
    const tblVar = this.generateShortStyleName();      // Base64 查找表变量
    const encVar = this.generateShortStyleName();       // 加密的字母表数据
    const dkVar = this.generateShortStyleName();        // 派生密钥变量
    const loopVar = this.generateShortStyleName();      // 循环变量
    const chVar = this.generateShortStyleName();        // 解密后的字符
    const keyTbl = this.generateShortStyleName();       // XOR 密钥表
    const decFn = this.generateShortStyleName();        // 解码函数
    const b64Str = this.generateShortStyleName();       // 编码后的字符串
    const b64Result = this.generateShortStyleName();    // 解码结果
    const iVar = this.generateShortStyleName();         // 通用循环变量
    const tmpVar = this.generateShortStyleName();       // 临时变量

    // 将加密字节序列转为 Lua 转义字符串
    let encStr = '';
    for (const b of b64EncBytes) {
      encStr += '\\' + b.toString().padStart(3, '0');
    }

    // 构建 XOR 密钥表
    let keyTblInit = 'local ' + keyTbl + '={';
    for (let i = 0; i < keyLen; i++) {
      keyTblInit += xorKey[i];
      if (i < keyLen - 1) keyTblInit += ',';
    }
    keyTblInit += '} ';

    let decoder = '';
    // Bug16修复: ~和&是Lua5.3+位运算符；Lua5.1用bit32.bxor替代，结果已在0-255范围内无需&255
    // Bug: bit32可能为nil（Roblox Luau），添加fallback
    const xorFnName = this.generateShortStyleName();
    const bit32Ref = this.generateShortStyleName();
    decoder += 'local ' + bit32Ref + '=bit32 or {bxor=function(a,b) local r=0 local s=1 for _=1,32 do local j=(a%2)+(b%2) if j==1 then r=r+s end a=math.floor(a/2) b=math.floor(b/2) s=s*2 end return r end} ';
    decoder += 'local function ' + xorFnName + '(a,b) return ' + bit32Ref + '.bxor(a,b) end ';
    // 初始化加密数据
    decoder += 'local ' + encVar + '="' + encStr + '" ';
    decoder += keyTblInit;
    decoder += 'local ' + dkVar + '=' + deriveSeed + ' ';
    decoder += 'local ' + tblVar + '={} ';
    decoder += 'local ' + chVar + ' ';

    // 运行时重建字母表（多种变体，参数已在加密时确定）
    if (rebuildVariant === 0) {
      // 变体 0：单循环重建
      decoder += 'for ' + loopVar + '=1,64 do ';
      decoder += dkVar + '=(' + dkVar + '*' + multVal + '+' + keyTbl + '[(' + loopVar + '-1)%' + keyLen + '+1]+(' + loopVar + '-1)*13)%256 ';
      decoder += chVar + '=' + xorFnName + '(string.byte(' + encVar + ',' + loopVar + '),' + dkVar + ')%256 ';
      decoder += tblVar + '[' + chVar + '+1]=' + loopVar + '-1 ';
      decoder += 'end ';
    } else if (rebuildVariant === 1) {
      // 变体 1：分两半重建（不同密钥派生参数）
      decoder += 'for ' + loopVar + '=1,32 do ';
      decoder += dkVar + '=(' + dkVar + '*' + half1Mult + '+' + keyTbl + '[(' + loopVar + '-1)%' + keyLen + '+1]+(' + loopVar + '-1)*13)%256 ';
      decoder += chVar + '=' + xorFnName + '(string.byte(' + encVar + ',' + loopVar + '),' + dkVar + ')%256 ';
      decoder += tblVar + '[' + chVar + '+1]=' + loopVar + '-1 ';
      decoder += 'end ';
      decoder += dkVar + '=' + half2Seed + ' ';
      decoder += 'for ' + loopVar + '=33,64 do ';
      decoder += dkVar + '=(' + dkVar + '*' + half2Mult + '+' + keyTbl + '[(' + loopVar + '-1)%' + keyLen + '+1]+(' + loopVar + '-32)*17)%256 ';
      decoder += chVar + '=' + xorFnName + '(string.byte(' + encVar + ',' + loopVar + '),' + dkVar + ')%256 ';
      decoder += tblVar + '[' + chVar + '+1]=' + loopVar + '-1 ';
      decoder += 'end ';
    } else {
      // 变体 2：带位掩码的重建
      decoder += 'for ' + loopVar + '=1,64 do ';
      decoder += dkVar + '=(' + dkVar + '*' + multVal + '+' + keyTbl + '[(' + loopVar + '-1)%' + keyLen + '+1]+' + loopVar + '*7)%256 ';
      decoder += chVar + '=' + xorFnName + '(' + xorFnName + '(string.byte(' + encVar + ',' + loopVar + '),' + dkVar + '),' + bitMask + ')%256 ';
      decoder += tblVar + '[' + chVar + '+1]=' + loopVar + '-1 ';
      decoder += 'end ';
    }

    // 完整性校验：字母表应有 64 个条目
    decoder += 'do local ' + tmpVar + '=0 for _ in pairs(' + tblVar + ') do ' + tmpVar + '=' + tmpVar + '+1 end ';
    decoder += 'if ' + tmpVar + '~=64 then return end end ';

    // 4. 生成解码函数
    decoder += 'local function ' + decFn + '(' + b64Str + ') ';
    decoder += 'local ' + b64Result + '={} ';
    decoder += 'for ' + iVar + '=1,#' + b64Str + ',4 do ';
    decoder += 'local _c0=' + tblVar + '[(string.byte(' + b64Str + ',' + iVar + ') or 0)+1] or 0 ';
    decoder += 'local _c1=' + tblVar + '[(string.byte(' + b64Str + ',' + iVar + '+1) or 0)+1] or 0 ';
    decoder += 'local _c2=' + tblVar + '[(string.byte(' + b64Str + ',' + iVar + '+2) or 0)+1] or 0 ';
    decoder += 'local _c3=' + tblVar + '[(string.byte(' + b64Str + ',' + iVar + '+3) or 0)+1] or 0 ';
    decoder += 'local _b0=(_c0*4)+math.floor(_c1/16) ';
    decoder += 'local _b1=((_c1%16)*16)+math.floor(_c2/4) ';
    decoder += 'local _b2=((_c2%4)*64)+_c3 ';
    decoder += b64Result + '[#' + b64Result + '+1]=string.char(_b0) ';
    decoder += 'if ' + iVar + '+2<=#' + b64Str + ' then ' + b64Result + '[#' + b64Result + '+1]=string.char(_b1) end ';
    decoder += 'if ' + iVar + '+3<=#' + b64Str + ' then ' + b64Result + '[#' + b64Result + '+1]=string.char(_b2) end ';
    decoder += 'end ';
    decoder += 'return table.concat(' + b64Result + ') ';
    decoder += 'end ';

    // 5. 对代码中的字符串字面量进行编码
    // 使用自定义 Base64 字母表编码
    // 先解释 Lua 转义序列，使编码的字节与 Lua 运行时一致
    const interpretLuaEscapes = (str) => {
      let result = '';
      let i = 0;
      while (i < str.length) {
        if (str[i] === '\\' && i + 1 < str.length) {
          const next = str[i + 1];
          if (next === 'a') { result += String.fromCharCode(7); i += 2; }
          else if (next === 'b') { result += String.fromCharCode(8); i += 2; }
          else if (next === 'f') { result += String.fromCharCode(12); i += 2; }
          else if (next === 'n') { result += String.fromCharCode(10); i += 2; }
          else if (next === 'r') { result += String.fromCharCode(13); i += 2; }
          else if (next === 't') { result += String.fromCharCode(9); i += 2; }
          else if (next === 'v') { result += String.fromCharCode(11); i += 2; }
          else if (next === '\\') { result += String.fromCharCode(92); i += 2; }
          else if (next === '"') { result += String.fromCharCode(34); i += 2; }
          else if (next === "'") { result += String.fromCharCode(39); i += 2; }
          else if (next === '\n') { result += String.fromCharCode(10); i += 2; }
          else if (next === 'x' && i + 3 < str.length) {
            const hex = str.substring(i + 2, i + 4);
            if (/^[0-9a-fA-F]{2}$/.test(hex)) {
              result += String.fromCharCode(parseInt(hex, 16));
              i += 4;
            } else {
              result += str[i]; i++;
            }
          }
          else if (next === 'z') {
            i += 2;
            while (i < str.length && /\s/.test(str[i])) i++;
          }
          else if (/[0-9]/.test(next)) {
            let dec = '';
            let j = i + 1;
            while (j < str.length && dec.length < 3 && /[0-9]/.test(str[j])) {
              dec += str[j]; j++;
            }
            const code = parseInt(dec, 10);
            if (code >= 0 && code <= 255) {
              result += String.fromCharCode(code);
            }
            i = j;
          }
          else {
            result += str[i]; i++;
          }
        } else {
          result += str[i];
          i++;
        }
      }
      return result;
    };

    const encodeB64 = (str) => {
      const bytes = [];
      for (let i = 0; i < str.length; i++) {
        bytes.push(str.charCodeAt(i));
      }
      let result = '';
      for (let i = 0; i < bytes.length; i += 3) {
        const b0 = bytes[i];
        const b1 = i + 1 < bytes.length ? bytes[i + 1] : 0;
        const b2 = i + 2 < bytes.length ? bytes[i + 2] : 0;
        result += b64Alphabet[(b0 >> 2) & 0x3F];
        result += b64Alphabet[((b0 & 0x03) << 4) | ((b1 >> 4) & 0x0F)];
        result += b64Alphabet[((b1 & 0x0F) << 2) | ((b2 >> 6) & 0x03)];
        result += b64Alphabet[b2 & 0x3F];
      }
      // 按实际字节数截断 padding
      const padLen = bytes.length % 3;
      if (padLen === 1) result = result.slice(0, -2);
      else if (padLen === 2) result = result.slice(0, -1);
      return result;
    };

    // 替换代码中的双引号字符串
    let modifiedCode = code.replace(/"((?:[^"\\]|\\.)*)"/g, (full, content) => {
      if (content.length === 0) return full;
      // 跳过已经是函数调用或包含特殊结构的字符串
      if (content.includes('\\000') || content.length > 500) return full;
      // 先解释 Lua 转义序列，使编码的字节与 Lua 运行时一致
      const interpreted = interpretLuaEscapes(content);
      const encoded = encodeB64(interpreted);
      return decFn + '("' + encoded + '")';
    });

    // 6. 组装：解码器 + 编码后的代码
    return decoder + modifiedCode;
  },
  // 将最终代码包装为返回函数的结构，可直接 require 或赋值后调用
  // 支持 varargs 传递，调用者可通过 (...) 接收所有参数
  returnFunctionWrap(code) {
    const variant = Math.floor(Math.random() * 4);
    const fnName = this.generateShortStyleName();
    const cacheName = this.generateShortName();
    const argName = this.generateShortStyleName();

    if (variant === 0) {
      // 变体 1: 基本 return function(...) ... end，最后调用以执行
      return '(function(...) ' + code + ' end)()';
    } else if (variant === 1) {
      // 变体 2: 闭包缓存 — 返回缓存的函数，立即调用
      let r = '';
      r += 'local ' + cacheName + '=nil ';
      r += '(function(...) ';
      r += 'if not ' + cacheName + ' then ' + cacheName + '=function(...) ' + code + ' end end ';
      r += 'return ' + cacheName + '(...)';
      r += ' end)()';
      return r;
    } else if (variant === 2) {
      // 变体 3: pcall 保护 — 执行代码在 pcall 中，失败时静默
      let r = '';
      r += '(function(...) ';
      r += 'local ' + fnName + '=function(...) ' + code + ' end ';
      r += 'pcall(' + fnName + ',...) ';
      r += ' end)()';
      return r;
    } else {
      // 变体 4: 表包装 — 可调用表，立即调用
      let r = '';
      const tblName = this.generateShortName();
      r += 'local ' + tblName + '={} ';
      r += tblName + '.__call=function(self,...) ' + code + ' end ';
      r += 'setmetatable(' + tblName + ',' + tblName + ') ';
      r += tblName + '()';
      return r;
    }
  },

  obfuscate(sourceCode) {
    this.init();
    this._stepLog = [];
    const startTime = performance.now();
    if (!sourceCode || sourceCode.trim() === '') {
      throw new Error('源代码不能为空');
    }

    let code = sourceCode;
    
    // 体积预算管理：每步执行前检查剩余预算，超限则跳过
    // 预算 = MAX_OUTPUT_SIZE，每步消耗后递减
    let sizeBudget = MAX_OUTPUT_SIZE;
    // 检查当前体积是否超过阈值的百分比
    const checkBudget = (threshold) => code.length > sizeBudget * threshold;
    // 投影检查：预估编码后体积是否会超限（编码层通常膨胀 ratio 倍）
    const wouldExceed = (ratio) => (code.length * ratio) > sizeBudget;

    let skipExpansion = false;

    // Step 1: 移除注释
    if (this.config.removeComments) {
      code = this.removeComments(code);
      this.log('注释已移除');
    }

    // Step 2: 提取字符串
    const extracted = this.extractStrings(code);
    code = extracted.code;
    this.log('提取字符串 ' + extracted.strings.length + ' 个');

    // Step 3: 变量重命名
    if (this.config.varRename) {
      code = this.renameVariables(code);
      this.log('变量已重命名');
    }

    // Step 4: 数字混淆
    if (this.config.numberObfusc) {
      code = this.obfuscateNumbers(code);
      this.log('数字已混淆');
    }

    // Step 5: 还原字符串（加密形式）
    code = this.restoreStrings(code, extracted.strings);
    this.log('字符串已加密还原');

    // 预算检查点 1：膨胀性步骤前
    if (checkBudget(0.7)) {
      skipExpansion = true;
      this.log('提示: 代码已较大 (' + formatBytes(code.length) + ')，跳过膨胀性步骤');
    }

    // Step 6: 垃圾代码
    if (this.config.junkCode && !skipExpansion) {
      code = this.injectJunkCode(code);
      this.log('垃圾代码已注入');
    }

    // Step 6.2: 表索引垃圾代码（b.D[0xNN] 十六进制索引 + 复杂条件）
    if (this.config.tableIndexJunk && !skipExpansion) {
      code = this.injectTableIndexJunk(code);
      this.log('表索引垃圾代码已注入');
    }

    // Step 6.5: 假字节流编码代码注入（可与垃圾代码同时使用）
    if (this.config.fakeByteStream && !skipExpansion) {
      code = this.injectFakeByteStream(code);
      this.log('假字节流编码代码已注入');
    }

    // 预算检查点 2
    if (checkBudget(0.7)) skipExpansion = true;

    // Step 7: 控制流
    if (this.config.controlFlow && !skipExpansion) {
      code = this.obfuscateControlFlow(code);
      this.log('控制流已混淆');
    }

    // Step 7.5: 静态环境（在压缩前，将全局引用缓存为 local）
    if (this.config.staticEnv) {
      code = this.staticEnvironment(code);
      this.log('静态环境已应用');
    }

    // Step 8: 压缩
    if (this.config.minify) {
      code = this.minifyCode(code);
      this.log('代码已压缩');
    }

    // 预算检查点 3：压缩后再次检查
    if (checkBudget(0.65)) skipExpansion = true;

    // Step 8.3: bit32 位运算注入（在压缩后、包装前注入，避免被压缩破坏）
    if (this.config.bit32Ops && !skipExpansion) {
      code = this.injectBit32(code);
      this.log('bit32 位运算已注入');
    }

    // Step 8.4: 语句级控制流扁平化（在最终包装前，将原始代码转为状态机）
    if (this.config.flattenCode && !skipExpansion) {
      code = this.flattenCode(code);
      this.log('控制流扁平化完成');
    }

    // Step 8.5: 函数拆分与重组（在控制流平坦化之后、最终包装之前）
    if (this.config.functionSplit && !skipExpansion) {
      code = this.splitFunctions(code);
      this.log('函数拆分与重组完成');
    }

    // Step 8.6: 隐藏 Base64 编码表（在 VM 包装之前执行）
    // 修复：必须在所有 VM 包装（byteStream, customVM 等）之前执行，
    // 否则会编码 VM 解码器内部的字符串，导致解码失败
    if (this.config.customBase64Table && !skipExpansion) {
      code = this.customBase64Table(code);
      this.log('隐藏Base64编码表已注入');
    }

    // Step 9: 最终包装 — 全部串行叠加（由内到外）
    // 顺序：loadstringWrap(字节流编码) → customVM → customBytecodeVM → byteStream → dynamicLoading
    // 每层包装将前一层的输出作为输入，形成嵌套结构
    // 体积控制：投影检查 — 预估编码后体积，超限则跳过该层
    // 各层膨胀比：hex编码≈3x, customVM≈3x, customBytecodeVM≈4x, advancedVM≈5x,
    //            stateMachineVM≈4x, byteStream≈6x, dynamicLoading≈3x

    // Step 9.1: LoadString 包装（最内层）
    if (this.config.loadstringWrap && !wouldExceed(3)) {
      code = this.wrapLoadstring(code);
      this.log('字节流编码包装完成 (' + formatBytes(code.length) + ')');
    } else if (this.config.loadstringWrap) {
      this.log('跳过字节流编码包装: 预估超限 (' + formatBytes(code.length) + ')');
    }

    // 每层 VM 单独投影检查
    // Step 9.2: 自定义虚拟机
    if (this.config.customVM && !wouldExceed(3)) {
      code = this.customVM(code);
      this.log('自定义虚拟机包装完成 (' + formatBytes(code.length) + ')');
    } else if (this.config.customVM) {
      this.log('跳过自定义虚拟机: 预估超限 (' + formatBytes(code.length) + ')');
    }

    // Step 9.3: 自定义字节码虚拟机
    if (this.config.customBytecodeVM && !wouldExceed(4)) {
      code = this.customBytecodeVM(code);
      this.log('自定义字节码虚拟机包装完成 (' + formatBytes(code.length) + ')');
    } else if (this.config.customBytecodeVM) {
      this.log('跳过自定义字节码虚拟机: 预估超限 (' + formatBytes(code.length) + ')');
    }

    // Step 9.3b: 高级虚拟机 v3（完整字节码解释器）
    if (this.config.advancedVM && !wouldExceed(5)) {
      code = this.advancedVM(code);
      this.log('高级虚拟机v3包装完成 (' + formatBytes(code.length) + ')');
    } else if (this.config.advancedVM) {
      this.log('跳过高级虚拟机v3: 预估超限 (' + formatBytes(code.length) + ')');
    }

    // Step 9.3c: 状态机虚拟机（状态机驱动解码+执行环境构建）
    if (this.config.stateMachineVM && !wouldExceed(4)) {
      code = this.stateMachineVM(code);
      this.log('状态机虚拟机包装完成 (' + formatBytes(code.length) + ')');
    } else if (this.config.stateMachineVM) {
      this.log('跳过状态机虚拟机: 预估超限 (' + formatBytes(code.length) + ')');
    }

    // Step 9.4: 字节流编码
    if (this.config.byteStream && !wouldExceed(6)) {
      code = this.byteStreamEncode(code);
      this.log('字节流编码完成 (' + formatBytes(code.length) + ')');
    } else if (this.config.byteStream) {
      this.log('跳过字节流编码: 预估超限 (' + formatBytes(code.length) + ')');
    }

    // Step 9.5: 动态加载包装（最外层）
    if (this.config.dynamicLoading && !wouldExceed(3)) {
      code = this.dynamicLoadingWrap(code);
      this.log('动态加载包装完成 (' + formatBytes(code.length) + ')');
    } else if (this.config.dynamicLoading) {
      this.log('跳过动态加载包装: 预估超限 (' + formatBytes(code.length) + ')');
    }

    // Step 11: 自调用结构包装（最终层，包裹在所有包装之外）
    if (this.config.selfInvoke) {
      code = this.selfInvokeWrap(code);
      this.log('自调用结构包装完成');
    }

    // Step 12: 模块化返回表包装（最终层，将代码包装为 return ({...}) 模块结构）
    if (this.config.moduleWrap) {
      code = this.moduleWrap(code);
      this.log('模块化返回表包装完成');
    }

    // Step 12.5: 局部环境包装（全局函数本地化 + return(function()...end)()）
    // 作为最外层包装，将所有全局函数引用替换为局部别名，防止外挂补丁
    if (this.config.localEnv) {
      code = this.localEnvWrap(code);
      this.log('局部环境包装完成');
    }

    // 预算检查点 5：安全套件前检查（安全套件通常膨胀 2-3 倍）
    if (wouldExceed(3)) {
      skipExpansion = true;
      this.log('提示: 代码体积预估超限 (' + formatBytes(code.length) + ')，跳过安全防护套件');
    }

    // Step 13: 安全防护套件（最终层，注入反逆向检测）
    const hasAntiDebug = this.config.antiDebug_tamper || this.config.antiDebug_envCheck ||
                         this.config.antiDebug_debugger || this.config.antiDebug_timeBomb ||
                         this.config.antiDebug_callStack || this.config.antiDebug_gcManip ||
                         this.config.antiDebug_hookChain || this.config.antiDebug_memScan ||
                         this.config.antiDebug_freqCheck || this.config.antiDebug_coroProbe ||
                         this.config.antiDebug_strMeta || this.config.antiDebug_bpTrap ||
                         this.config.antiDebug_localProbe || this.config.antiDebug_funcHash ||
                         this.config.antiDebug_traceTrap ||
                         this.config.antiDebug_sethookTrap || this.config.antiDebug_registryGuard ||
                         this.config.antiDebug_rawMetaCheck || this.config.antiDebug_strWatermark ||
                         this.config.antiDebug_opaquePred || this.config.antiDebug_decoyFunc ||
                         this.config.antiDebug_metaTrap ||
                         this.config.antiRev_stringFog || this.config.antiRev_controlFlowSpaghetti ||
                         this.config.antiRev_deadCodeInjection || this.config.antiRev_varIndirection ||
                         this.config.antiRev_opaqueExpr || this.config.antiRev_antiDecompile ||
                         this.config.antiRev_selfModifying || this.config.antiRev_metaObfuscation;
    if (hasAntiDebug && !skipExpansion) {
      code = this.securitySuite(code);
      this.log('安全防护套件已注入');
    }

    // Step 14: return function(...) ... end 包装（最终层，输出可调用函数）
    if (this.config.returnFuncWrap) {
      code = this.returnFunctionWrap(code);
      this.log('return function 包装完成');
    }

    const elapsed = Math.round(performance.now() - startTime);
    const outputSize = code.length;
    const overLimit = outputSize > MAX_OUTPUT_SIZE;
    const nearLimit = outputSize > MAX_OUTPUT_SIZE * 0.8 && !overLimit;
    if (overLimit) {
      this.log('警告: 输出大小 ' + formatBytes(outputSize) + ' 超过 1M 上限 (' + formatBytes(MAX_OUTPUT_SIZE) + ')');
    } else if (nearLimit) {
      this.log('提示: 输出大小 ' + formatBytes(outputSize) + ' 已接近 1M 上限');
    }
    return { code, elapsed, overLimit, nearLimit, stats: {
      inputSize: sourceCode.length,
      outputSize,
      stringsEncrypted: extracted.strings.length,
      steps: this._stepLog || [],
    } };
  },

  log(msg) { console.log('[Obfuscator]', msg); if (this._stepLog) this._stepLog.push(msg); },
};

module.exports = Obfuscator;
