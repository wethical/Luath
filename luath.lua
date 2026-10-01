--!nonstrict
--[[
Luath VM Enhanced v1.9.5.3 — Roblox Only
================================================================
在 v1.9.5.2 基础上修复全部 10 个遗留 bug：
  [FIX-1]  _is_yield_safe 在 Roblox 中永远为 false → 恒返回 true
  [FIX-2]  _note_mem_access 误伤正常循环 → 禁用
  [FIX-3]  _shadow_stack 模块级全局 → 移入 _nvm 局部
  [FIX-4]  _frame_depth 跨协程共享 → 移除，复用 _call_depth_counter
  [FIX-5]  _opaque_false 热循环调用 → 降频至 0xFF 一次
  [FIX-6]  _nvm_decoy 引用未定义变量 → 删除
  [FIX-7]  _check_time_ratio 双同源时钟 → 改为时钟背离检测
  [FIX-8]  _trap 双层 tier-1 死代码 → 简化单层
  [FIX-9]  跨调用全局状态污染 → 入口统一清理
  [FIX-10] _VM_FINGERPRINT 依赖内存地址 → 改用身份比较
================================================================
]]

-- =========================================================
-- §0 Roblox 硬断言
-- =========================================================
local _IS_RBX
do
    local ok, r = pcall(function() return typeof(workspace) == "Instance" end)
    _IS_RBX = ok and r
end
if not _IS_RBX then error("Luath VM: Roblox-only build", 0) end

-- =========================================================
-- §1 库快照
-- =========================================================
local _PCALL, _XPCALL, _ERROR
local _TYPE, _TOSTRING, _TONUMBER, _ASSERT, _SELECT
local _SETMT, _GETMT, _RAWSET, _RAWGET, _RAWEQUAL
local _NEXT, _PAIRS, _IPAIRS
local _PACK, _UNPACK, _MOVE, _CREATE, _CONCAT, _FREEZE_T
local _S_BYTE, _S_SUB, _S_FMT, _S_GSUB, _S_CHAR, _S_REP, _S_FIND
local _CLOCK, _TIME
local _FLOOR, _ABS, _MIN, _MAX, _HUGE
local _BAND, _BOR, _BXOR, _BNOT, _LSHIFT, _RSHIFT
local _PRINT, _WARN, _TYPEOF

do
    _PCALL    = pcall;    _XPCALL   = xpcall;   _ERROR    = error
    _TYPE     = type;     _TOSTRING = tostring; _TONUMBER = tonumber
    _ASSERT   = assert;   _SELECT   = select
    _SETMT    = setmetatable; _GETMT = getmetatable
    _RAWSET   = rawset;   _RAWGET   = rawget;   _RAWEQUAL = rawequal
    _NEXT     = next;     _PAIRS    = pairs;    _IPAIRS   = ipairs
    _PRINT    = print;    _WARN     = warn;     _TYPEOF   = typeof
    _PACK     = table.pack; _UNPACK = table.unpack; _MOVE = table.move
    _CREATE   = table.create; _CONCAT = table.concat
    _FREEZE_T = table.freeze or function(t) return t end
    _S_BYTE   = string.byte; _S_SUB = string.sub; _S_FMT = string.format
    _S_GSUB   = string.gsub; _S_CHAR = string.char; _S_REP = string.rep
    _S_FIND   = string.find
    _CLOCK    = os.clock; _TIME = os.time
    _FLOOR    = math.floor; _ABS = math.abs; _MIN = math.min
    _MAX      = math.max;  _HUGE = math.huge
    local b = bit32
    if not b then error("Luath VM: bit32 required (Roblox)", 0) end
    _BAND, _BOR, _BXOR, _BNOT = b.band, b.bor, b.bxor, b.bnot
    _LSHIFT, _RSHIFT = b.lshift, b.rshift
end

local _FREEZE = _FREEZE_T
local FIELDS_PER_FLUSH = 50

-- =========================================================
-- §2 身份锁
-- =========================================================
local function _locks_ok()
    return pcall        == _PCALL
       and error        == _ERROR
       and type         == _TYPE
       and tostring     == _TOSTRING
       and table.pack   == _PACK
       and table.unpack == _UNPACK
       and string.byte  == _S_BYTE
       and string.sub   == _S_SUB
       and os.clock     == _CLOCK
end

-- =========================================================
-- §3 常量 + 数字合成（状态身份）
-- =========================================================
local _SENTINEL        = 0x5A5A5A5A
local _MAX_PROTO_DEPTH = 64
local _K_S1 = 0x7E1F3A5C
local _K_S2 = 0x2B8D4F91
local _K_S3 = 0xC3A7E5B9

local _N_state = 0x5A5A5A5A
local function _N(x)
    local old = _N_state
    _N_state = _BXOR(_N_state, x)
    return _BXOR(_N_state, old)
end

local _opaque_counter = 0
local function _opaque_true()
    _opaque_counter = _opaque_counter + 1
    local x = _N(0x12345678) + _opaque_counter
    return _BOR(x, x + 1) ~= (x - 1)
end
local function _opaque_false()
    _opaque_counter = _opaque_counter + 1
    local x = _BAND(_N(0xDEADBEEF) + _opaque_counter, _N(0xFFFF))
    return x == _N(0xFFFFF)
end

local _junk_acc = 0x9E3779B9
local function _junk(i)
    local x = _BAND(_junk_acc + i * 2654435761, _N(0xFFFFFFFF))
    x = _BXOR(x, _RSHIFT(x, 7))
    x = _BAND(x * 2246822519, _N(0xFFFFFFFF))
    _junk_acc = _BXOR(_junk_acc, x)
    return x
end

-- =========================================================
-- §3.5 环境熵采集
-- =========================================================
local function _gather_entropy()
    local sources = {}
    _PCALL(function() sources[#sources + 1] = _FLOOR(os.clock() * 1000000) end)
    _PCALL(function() sources[#sources + 1] = os.time() end)
    _PCALL(function()
        local g = rawget(_G, "game")
        if g and g.JobId then
            local jid = _TOSTRING(g.JobId)
            for i = 1, _MIN(#jid, 32) do
                sources[#sources + 1] = _S_BYTE(jid, i)
            end
        end
    end)
    _PCALL(function()
        local probes = {}
        for i = 1, 8 do probes[i] = _TOSTRING({}) end
        local acc = 0
        for i = 1, 8 do
            for j = 1, #probes[i] do
                acc = (acc * 31 + _S_BYTE(probes[i], j)) % 0xFFFFFFFF
            end
        end
        sources[#sources + 1] = acc
    end)
    local mix = 0x811C9DC5
    for i = 1, #sources do
        local v = sources[i]
        if _TYPE(v) == "number" then
            mix = _BXOR(mix, _FLOOR(v) % 0xFFFFFFFF)
            mix = _BAND(mix * 16777619, _N(0xFFFFFFFF))
        end
    end
    if mix == 0 then mix = 0xCAFEBABE end
    return mix
end

local _entropy_pool = _gather_entropy()

-- =========================================================
-- §4 函数间接表
-- =========================================================
local _F = _FREEZE({
    [1]=_S_BYTE, [2]=_S_SUB, [3]=_S_FMT, [4]=_S_CHAR,
    [5]=_S_GSUB, [6]=_S_REP, [7]=_S_FIND,
    [11]=_PACK, [12]=_UNPACK, [13]=_MOVE, [14]=_CREATE,
    [15]=_CONCAT, [16]=_FREEZE_T,
    [21]=_PCALL, [22]=_ERROR, [23]=_TYPE, [24]=_TOSTRING,
    [25]=_TONUMBER, [26]=_ASSERT, [27]=_SELECT, [28]=_SETMT,
    [29]=_GETMT, [30]=_RAWSET, [31]=_RAWGET, [32]=_RAWEQUAL,
    [33]=_NEXT, [34]=_PAIRS, [35]=_IPAIRS,
    [41]=_FLOOR, [42]=_ABS, [43]=_MIN, [44]=_MAX, [45]=_HUGE,
    [51]=_BAND, [52]=_BOR, [53]=_BXOR, [54]=_BNOT,
    [55]=_LSHIFT, [56]=_RSHIFT,
    [61]=_CLOCK, [62]=_TIME,
})

-- =========================================================
-- §5 字符串池
-- =========================================================
local _SP_A = {
    [1]="\27Lua",[2]="LUE\0",[3]="OpArgR",[4]="OpArgN",
    [5]="OpArgK",[6]="OpArgU",[7]="ABC",[8]="ABx",
    [9]="AsBx",[10]="LNP\1",[11]="game",[12]="workspace",
    [13]="task",[14]="script",[15]="Instance",[16]="Enum",
}
local _SP_B = {
    [17]="Vector3",[18]="CFrame",[19]="Color3",[20]="UDim2",
    [21]="_G",[22]="_ENV",[23]="shared",[24]="getfenv",
    [25]="setfenv",[26]="loadstring",[27]="load",[28]="dofile",
}
local _SP_C = {
    [29]="loadfile",[30]="require",[31]="debug",[32]="rawset",
    [33]="rawget",[34]="rawequal",[35]="collectgarbage",[36]="newproxy",
    [37]="tostring",[38]="print",[39]="error",[40]="pcall",
}
local _SP_D = {
    [41]="xpcall",[42]="warn",[43]="typeof",[44]="getmetatable",
    [45]="setmetatable",[46]="Players",[47]="LocalPlayer",[48]="Kick",
    [49]="GetService",[50]="buffer",[51]="readu8",[52]="writeu8",
}
local _SP_E = {
    [53]="readu32",[54]="readf32",[55]="readstring",
    [56]="integrity violation",
}
local _SP_POOLS = { _SP_A, _SP_B, _SP_C, _SP_D, _SP_E }

local function _decode_entry(e)
    if _TYPE(e) == "string" then return e end
    local salt = e[1]
    local payload = e[2]
    if _TYPE(payload) == "table" then
        local n = #payload
        if n == 0 then return "" end
        local out = _CREATE(n)
        local st = salt
        for j = 1, n do
            st = _BXOR(st, _LSHIFT(st, 13))
            st = _BXOR(st, _RSHIFT(st, 17))
            st = _BXOR(st, _LSHIFT(st, 5))
            out[j] = _S_CHAR(_BXOR(payload[j], _BAND(st, _N(0xFF))))
        end
        return _CONCAT(out)
    end
    local n = #payload
    if n == 0 then return "" end
    local out = _CREATE(n)
    local st = salt
    for j = 1, n do
        st = _BXOR(st, _LSHIFT(st, 13))
        st = _BXOR(st, _RSHIFT(st, 17))
        st = _BXOR(st, _LSHIFT(st, 5))
        out[j] = _S_CHAR(_BXOR(_S_BYTE(payload, j), _BAND(st, _N(0xFF))))
    end
    return _CONCAT(out)
end

local function _SP_LOOKUP(id)
    for i = 1, 5 do
        local e = _SP_POOLS[i][id]
        if e ~= nil then return e end
    end
    return nil
end

local _SC = _CREATE(64)
local function _S(id)
    local v = _SC[id]
    if v == nil then
        v = _decode_entry(_SP_LOOKUP(id))
        _SC[id] = v
    end
    return v
end

-- =========================================================
-- §6 SBOX + 派生密钥
-- =========================================================
local _SBOX_SEED = 0xA5C3F19B
local _SBOX, _SBOX_INV
do
    local st = _SBOX_SEED
    local function nr()
        if st == 0 then st = 0x9E3779B9 end
        st = _BXOR(st, _LSHIFT(st, 13))
        st = _BXOR(st, _RSHIFT(st, 17))
        st = _BXOR(st, _LSHIFT(st, 5))
        return st
    end
    local sbox = {}
    for i = 0, 255 do sbox[i + 1] = i end
    for i = 255, 1, -1 do
        local j = nr() % (i + 1)
        sbox[i + 1], sbox[j + 1] = sbox[j + 1], sbox[i + 1]
    end
    local inv = {}
    for i = 0, 255 do inv[sbox[i + 1] + 1] = i end
    _SBOX     = _FREEZE(sbox)
    _SBOX_INV = _FREEZE(inv)
end

local function _derive_key(...)
    local args = {...}
    local n = #args
    local acc = 0x811C9DC5
    for i = 1, n do
        local v = args[i]
        local pos = _BAND(v, _N(0xFF)) + 1
        acc = _BXOR(acc, _SBOX[pos])
        acc = _BAND(acc * 16777619, _N(0xFFFFFFFF))
        acc = _BXOR(acc, _SBOX_INV[_BAND(_RSHIFT(v, 8), _N(0xFF)) + 1])
        acc = _BAND(acc * 16777619, _N(0xFFFFFFFF))
    end
    return acc
end

-- =========================================================
-- §7 数字键快照 + 双跳映射
-- =========================================================
local _w = _FREEZE({
    [1]=_S_BYTE,[2]=_S_SUB,[3]=_S_FMT,[4]=_S_CHAR,[5]=_S_GSUB,
    [6]=_S_REP,[7]=_S_FIND,
    [11]=_PACK,[12]=_UNPACK,[13]=_MOVE,[14]=_CREATE,[15]=_CONCAT,[16]=_FREEZE_T,
    [21]=_PCALL,[22]=_ERROR,[23]=_TYPE,[24]=_TOSTRING,[25]=_TONUMBER,
    [26]=_ASSERT,[27]=_SELECT,[28]=_SETMT,[29]=_GETMT,
    [30]=_RAWSET,[31]=_RAWGET,[32]=_RAWEQUAL,[33]=_NEXT,
    [34]=_PAIRS,[35]=_IPAIRS,
    [41]=_FLOOR,[42]=_ABS,[43]=_MIN,[44]=_MAX,[45]=_HUGE,
    [51]=_BAND,[52]=_BOR,[53]=_BXOR,[54]=_BNOT,[55]=_LSHIFT,[56]=_RSHIFT,
    [61]=_CLOCK,[62]=_TIME,
    [71]=_G.game,[72]=_G.workspace,[73]=_G.task,[74]=_G.script,
    [75]=_G.Instance,[76]=_G.Enum,[77]=_G.Vector3,[78]=_G.CFrame,
    [79]=_G.Color3,[80]=_G.UDim2,
})

local _I = _FREEZE({
    [1]=32,[2]=31,[3]=41,[4]=25,[5]=43,[6]=26,[7]=30,
    [11]=62,[12]=61,[13]=13,[14]=44,[15]=12,[16]=16,
    [21]=22,[22]=21,[23]=23,[24]=54,[25]=24,[26]=52,[27]=27,[28]=29,[29]=42,
    [30]=51,[31]=11,[32]=34,[33]=35,[34]=33,[35]=53,
    [41]=14,[42]=15,[43]=55,[44]=56,[45]=45,
    [51]=4,[52]=6,[53]=5,[54]=1,[55]=2,[56]=3,
    [61]=7,[62]=28,
})
local function _WI(id) return _w[_I[id]] end

-- =========================================================
-- §8 Tripwire（[FIX-8] 简化单层）
-- =========================================================
local _state_lock = _SETMT({}, {__mode = "k"})
local _INTERNAL_KEY = {}

local _tripwire = { tier = 0 }
local function _trap(reason, hard)
    if _tripwire.tier >= 2 then
        _ERROR("\0\0\0\0\0", 0)
    end
    _tripwire.tier = 2
    if _state_lock then _state_lock = nil end
    _ERROR("\0\0\0\0" .. _TOSTRING(reason or "tamper"), 0)
end

local _silent_trap = { count = 0, threshold = 100, active = false }
local function _silent_mark()
    if not _silent_trap.active then return end
    _silent_trap.count = _silent_trap.count + 1
    if _silent_trap.count >= _silent_trap.threshold then
        _trap("silent trap triggered", true)
    end
end
local function _silent_arm()
    _silent_trap.active = true
end

local function _seal(state)
    if _state_lock then _state_lock[state] = _INTERNAL_KEY end
    return state
end
local function _is_sealed(state)
    return _state_lock and _state_lock[state] == _INTERNAL_KEY
end

-- =========================================================
-- §9 沙箱
-- =========================================================
local _ENV_TOKEN = {}
local _sandbox_registry = _SETMT({}, {__mode = "k"})
local _sandbox_cache    = _SETMT({}, {__mode = "k"})

local _BASE_BLACKLIST = {}
do
    local ids = _FREEZE({21,22,23,24,25,26,27,28,29,30,31,32,33,34,35,36})
    for i = 1, #ids do _BASE_BLACKLIST[_S(ids[i])] = true end
    _BASE_BLACKLIST = _FREEZE(_BASE_BLACKLIST)
end

local _w_name = {}
do
    local ids = _FREEZE({11,12,13,14,15,16,17,18,19,20})
    local vals = _FREEZE({71,72,73,74,75,76,77,78,79,80})
    for i = 1, #ids do _w_name[_S(ids[i])] = vals[i] end
    _w_name = _FREEZE(_w_name)
end

local function _make_sandbox(backing, opts)
    opts = opts or {}
    if backing == nil then backing = _G end
    if _TYPE(backing) ~= "table" then _trap("sandbox bad backing", true) end

    local uw = opts.whitelist
    local ub = opts.blacklist
    local on_r = opts.on_global_read
    local on_w = opts.on_global_write
    local ro  = opts.readonly

    local sandbox = {}
    local mt = {
        __index = function(_, k)
            local tk = _TYPE(k)
            if tk ~= "string" then return backing[k] end
            if _BASE_BLACKLIST[k] then _trap("sandbox read " .. k, true) end
            if ub and ub[k] then _trap("sandbox read black " .. k, true) end
            local n = _w_name[k]
            if n then
                local v = _w[n]
                if v ~= nil then
                    if on_r then return on_r(k, v) end
                    return v
                end
            end
            if uw and not uw[k] then return nil end
            local v = backing[k]
            if on_r then return on_r(k, v) end
            return v
        end,
        __newindex = function(t, k, v)
            local tk = _TYPE(k)
            if tk ~= "string" then _RAWSET(t, k, v); return end
            if ro then _trap("sandbox ro " .. k, true) end
            if _BASE_BLACKLIST[k] then _trap("sandbox write " .. k, true) end
            if ub and ub[k] then _trap("sandbox write black " .. k, true) end
            if uw and not uw[k] then _trap("sandbox write nonwhite " .. k, true) end
            if on_w then v = on_w(k, v) or v end
            _RAWSET(t, k, v)
        end,
        __metatable = false,
        [_ENV_TOKEN] = true,
    }
    _SETMT(sandbox, mt)
    _sandbox_registry[sandbox] = mt
    return sandbox
end

local function _is_sandbox(t)
    return _TYPE(t) == "table" and _sandbox_registry[t] ~= nil
end

local function _opts_fingerprint(opts)
    if not opts then return 0 end
    local acc = 0x811C9DC5
    local uw = opts.whitelist
    if uw then
        for k in _PAIRS(uw) do
            acc = _BXOR(acc, _crc32(_TOSTRING(k)))
            acc = _BAND(acc * 16777619, _N(0xFFFFFFFF))
        end
    end
    local ub = opts.blacklist
    if ub then
        for k in _PAIRS(ub) do
            acc = _BXOR(acc, _crc32(_TOSTRING(k)))
            acc = _BAND(acc * 16777619, _N(0xFFFFFFFF))
        end
    end
    if opts.readonly then acc = _BXOR(acc, 0x5A5A5A5A) end
    return acc
end

local function _get_or_make_sandbox(backing, opts)
    if _is_sandbox(backing) then return backing end
    local sub_cache = _sandbox_cache[backing]
    if not sub_cache then
        sub_cache = {}
        _sandbox_cache[backing] = sub_cache
    end
    local key = _opts_fingerprint(opts)
    local cached = sub_cache[key]
    if cached then return cached end
    local sb = _make_sandbox(backing, opts or {})
    sub_cache[key] = sb
    return sb
end

-- =========================================================
-- §10 with_env
-- =========================================================
local _thread_env_state = _SETMT({}, {__mode = "k"})
local function _env_state()
    local co = coroutine.running() or "main"
    local st = _thread_env_state[co]
    if not st then
        st = { top = 0, slots = {} }
        _thread_env_state[co] = st
    end
    return st
end
local function _with_env(fn, temp_env, ...)
    if _TYPE(fn) ~= "function" then _trap("with_env not fn", true) end
    if not _is_sandbox(temp_env) then _trap("with_env not sb", true) end
    local st = _env_state()
    st.top = st.top + 1
    local slot = st.top
    st.slots[slot] = temp_env
    local packed = _PACK(_PCALL(fn, ...))
    st.slots[slot] = nil
    st.top = slot - 1
    if packed[1] then return _UNPACK(packed, 2, packed.n) end
    _ERROR(packed[2], 0)
end
local function _current_env()
    local st = _thread_env_state[coroutine.running() or "main"]
    if not st or st.top == 0 then return nil end
    return st.slots[st.top]
end

-- =========================================================
-- §11 反调试嗅探
-- =========================================================
local function _sniff_debug()
    local ok, dbg = _PCALL(function() return debug end)
    if not ok or _TYPE(dbg) ~= "table" then return true end
    local gh = dbg.gethook
    if _TYPE(gh) ~= "function" then return true end
    local ok2, hook = _PCALL(gh)
    if not ok2 then return true end
    if hook ~= nil then return false end
    return true
end

local function _safe_clock()
    local ok, v = _PCALL(_CLOCK)
    if ok and _TYPE(v) == "number" then return v end
    return 0
end

-- =========================================================
-- §12 稀疏 opcode 表
-- =========================================================
local _SPARSE_X = 0x5A

local _SPARSE_CODE = _FREEZE({
    [0]  = _N(0x59),  -- 3
    [1]  = _N(0x57),  -- 13
    [2]  = _N(0x4D),  -- 23
    [3]  = _N(0x5A),  -- 0
    [4]  = _N(0x58),  -- 2
    [5]  = _N(0x5E),  -- 4
    [6]  = _N(0x5D),  -- 7
    [7]  = _N(0x53),  -- 9
    [8]  = _N(0x56),  -- 12
    [9]  = _N(0x54),  -- 14
    [10] = _N(0x4B),  -- 17
    [11] = _N(0x5F),  -- 5
    [12] = _N(0x5B),  -- 1
    [13] = _N(0x5C),  -- 6
    [14] = _N(0x50),  -- 10
    [15] = _N(0x4A),  -- 16
    [16] = _N(0x4E),  -- 20
    [17] = _N(0x40),  -- 26
    [18] = _N(0x44),  -- 30
    [19] = _N(0x76),  -- 36
    [20] = _N(0x49),  -- 19
    [21] = _N(0x4C),  -- 22
    [22] = _N(0x48),  -- 18
    [23] = _N(0x42),  -- 24
    [24] = _N(0x41),  -- 27
    [25] = _N(0x47),  -- 29
    [26] = _N(0x7B),  -- 33
    [27] = _N(0x7A),  -- 32
    [28] = _N(0x51),  -- 11
    [29] = _N(0x45),  -- 15
    [30] = _N(0x4F),  -- 21
    [31] = _N(0x52),  -- 8
    [32] = _N(0x78),  -- 34
    [33] = _N(0x46),  -- 28
    [34] = _N(0x7F),  -- 37
    [35] = _N(0x43),  -- 25
    [36] = _N(0x75),  -- 31
    [37] = _N(0x79),  -- 35
})

local _orm = {}
do
    for k, v in _PAIRS(_SPARSE_CODE) do
        _orm[k] = _BXOR(v, _SPARSE_X)
    end
    _orm = _FREEZE(_orm)
end

local _otp = _FREEZE({
    [0]=7,8,7,7,7,8,7,8,7,7,7,7,
    7,7,7,7,7,7,7,7,7,7,9,7,
    7,7,7,7,7,7,7,9,9,7,7,7,8,7,
})

local _OMD_CODES = _FREEZE({
    [0]={1,2},{3,2},{4,4},{1,2},{4,2},{3,2},
    {1,3},{3,2},{4,2},{3,3},{4,4},{1,3},
    {3,3},{3,3},{3,3},{3,3},{3,3},{3,3},
    {1,2},{1,2},{1,2},{1,1},{1,2},{3,3},
    {3,3},{3,3},{1,4},{1,4},{4,4},{4,4},
    {4,2},{1,2},{1,2},{2,4},{4,4},{2,2},
    {4,2},{4,2},
})

local _omd = {}
do
    local strs = { _S(3), _S(4), _S(5), _S(6) }
    for i = 0, 37 do
        local c = _OMD_CODES[i]
        _omd[i] = { b = strs[c[1]], c = strs[c[2]] }
    end
    _omd = _FREEZE(_omd)
end

-- =========================================================
-- §12.5 CFI 表
-- =========================================================
local function _build_cfi_table(code)
    local cfi = {}
    for i = 1, #code do cfi[i] = {} end
    cfi[1][0] = true

    for pc = 1, #code do
        local ins = code[pc]
        local op  = ins.op
        local next_pc = pc + 1

        if next_pc <= #code then cfi[next_pc][pc] = true end

        if ins.sBx then
            local tgt = next_pc + ins.sBx
            if tgt >= 1 and tgt <= #code then cfi[tgt][pc] = true end
        end

        if op == 24 or op == 27 or op == 29 or op == 32 or op == 33 then
            if pc + 2 <= #code then cfi[pc + 2][pc] = true end
            local jmp = code[pc + 1]
            if jmp and jmp.sBx then
                local tgt = pc + 2 + jmp.sBx
                if tgt >= 1 and tgt <= #code then cfi[tgt][pc] = true end
            end
        end

        if op == 23 and ins.C and ins.C ~= 0 then
            if pc + 2 <= #code then cfi[pc + 2][pc] = true end
        end
    end
    for i = 1, #cfi do _FREEZE(cfi[i]) end
    return _FREEZE(cfi)
end

-- =========================================================
-- §12.6 多态
-- =========================================================
local _poly_seed = 0
local function _poly_pick(off)
    _poly_seed = _BXOR(_poly_seed, off)
    _poly_seed = _BAND(_poly_seed * 2654435761, _N(0xFFFFFFFF))
    return _BAND(_poly_seed, 1)
end
local function _poly_add(a, b)
    if _TYPE(a) == "number" and _TYPE(b) == "number" then
        if _poly_pick(1) == 0 then return a + b else return a - (-b) end
    end
    return a + b
end
local function _poly_sub(a, b)
    if _TYPE(a) == "number" and _TYPE(b) == "number" then
        if _poly_pick(2) == 0 then return a - b else return a + (-b) end
    end
    return a - b
end
local function _poly_mul(a, b)
    if _TYPE(a) == "number" and _TYPE(b) == "number" then
        if _poly_pick(3) == 0 then return a * b end
        if b ~= 0 then return a / (1 / b) end
    end
    return a * b
end

-- =========================================================
-- §13 CRC32
-- =========================================================
local _crc_tbl = _CREATE(256)
do
    for i = 0, 255 do
        local c = i
        for _ = 1, 8 do
            if _BAND(c, 1) == 1 then
                c = _BXOR(_RSHIFT(c, 1), _N(0xEDB88320))
            else
                c = _RSHIFT(c, 1)
            end
        end
        _crc_tbl[i + 1] = c
    end
    _FREEZE(_crc_tbl)
end

local function _crc32(s)
    local c = _N(0xFFFFFFFF)
    local mask = _N(0xFF)
    for i = 1, #s do
        c = _BXOR(_crc_tbl[_BAND(_BXOR(c, _S_BYTE(s, i)), mask) + 1],
                  _RSHIFT(c, 8))
    end
    return _BXOR(c, _N(0xFFFFFFFF))
end

local function _code_crc(code)
    local c = 0x811C9DC5
    for i = 1, #code do
        local ins = code[i]
        c = _BXOR(c, ins.value or 0)
        c = _BAND(c * 16777619, _N(0xFFFFFFFF))
        c = _BXOR(c, ins.op or 0)
        c = _BAND(c * 16777619, _N(0xFFFFFFFF))
    end
    return c
end

-- =========================================================
-- §14 字节读取
-- =========================================================
local function _ri_b(src, s, e, d)
    local num = 0
    for i = s, e, d do
        num = num + 256 ^ _ABS(i - s) * _S_BYTE(src, i, i)
    end
    return num
end

local function _rf_b(f1, f2, f3, f4)
    local sign = (-1) ^ _RSHIFT(f4, 7)
    local exp  = _RSHIFT(f3, 7) + _LSHIFT(_BAND(f4, _N(0x7F)), 1)
    local frac = f1 + _LSHIFT(f2, 8) + _LSHIFT(_BAND(f3, _N(0x7F)), 16)
    local normal = 1
    if exp == 0 then
        if frac == 0 then return sign * 0 end
        normal = 0; exp = 1
    elseif exp == _N(0x7F) then
        if frac == 0 then return sign * (1 / 0) else return sign * (0 / 0) end
    end
    return sign * 2 ^ (exp - 127) * (1 + normal / 2 ^ 23)
end

local function _rd_b(f1, f2, f3, f4, f5, f6, f7, f8)
    local sign = (-1) ^ _RSHIFT(f8, 7)
    local exp  = _LSHIFT(_BAND(f8, _N(0x7F)), 4) + _RSHIFT(f7, 4)
    local frac = _BAND(f7, _N(0x0F)) * 2 ^ 48
    local normal = 1
    frac = frac + (f6 * 2 ^ 40) + (f5 * 2 ^ 32) + (f4 * 2 ^ 24)
                + (f3 * 2 ^ 16) + (f2 * 2 ^ 8) + f1
    if exp == 0 then
        if frac == 0 then return sign * 0 end
        normal = 0; exp = 1
    elseif exp == _N(0x7FF) then
        if frac == 0 then return sign * (1 / 0) else return sign * (0 / 0) end
    end
    return sign * 2 ^ (exp - 1023) * (normal + frac / 2 ^ 52)
end

local function _ri_le(s, a, b) return _ri_b(s, a, b - 1, 1) end
local function _ri_be(s, a, b) return _ri_b(s, b - 1, a, -1) end
local function _rf_le(s, i) return _rf_b(_S_BYTE(s, i, i + 3)) end
local function _rf_be(s, i)
    local a, b, c, d = _S_BYTE(s, i, i + 3)
    return _rf_b(d, c, b, a)
end
local function _rd_le(s, i) return _rd_b(_S_BYTE(s, i, i + 7)) end
local function _rd_be(s, i)
    local a, b, c, d, e, f, g, h = _S_BYTE(s, i, i + 7)
    return _rd_b(h, g, f, e, d, c, b, a)
end
local _fty = {[4]={little=_rf_le, big=_rf_be}, [8]={little=_rd_le, big=_rd_be}}

local function _sby(S)
    local idx = S.index
    local bt = _S_BYTE(S.source, idx, idx)
    if bt == nil then _trap("bc eos", true) end
    S.index = idx + 1
    return bt
end
local function _sst(S, len)
    if len < 0 then _trap("bc neg", true) end
    local pos = S.index + len
    if pos - 1 > #S.source then _trap("bc overrun", true) end
    local str = _S_SUB(S.source, S.index, pos - 1)
    S.index = pos
    return str
end
local function _sls(S)
    local len = S:s_szt()
    if len == 0 then return nil end
    return _S_SUB(_sst(S, len), 1, -2)
end
local function _cir(len, func)
    return function(S)
        local pos = S.index + len
        if pos - 1 > #S.source then _trap("bc read overrun", true) end
        local int = func(S.source, S.index, pos)
        S.index = pos
        return int
    end
end
local function _cfr(len, func)
    return function(S)
        if S.index + len - 1 > #S.source then _trap("bc float overrun", true) end
        local flt = func(S.source, S.index)
        S.index = S.index + len
        return flt
    end
end

-- =========================================================
-- §15 指令反序列化
-- =========================================================
local _OPMASK = _N(0x3F)
local _ABITS  = _N(0xFF)
local _BCMASK = _N(0x1FF)
local _BXMASK = _N(0x3FFFF)
local _SBX_OFFSET = _N(131071)

local function _sil(S)
    local len = S:s_int()
    if _TYPE(len) ~= "number" or len < 0 or len > 0x100000 then
        _trap("illegal code len", true)
    end
    local list = _CREATE(len)
    for i = 1, len do
        local ins = S:s_ins()
        local op = _BAND(ins, _OPMASK)
        local args = _otp[op]
        local mode = _omd[op]
        if not args or not mode then
            _trap(_S_FMT("unknown op=%d", op), true)
        end
        local data = {
            value = ins,
            op    = _orm[op],
            A     = _BAND(_RSHIFT(ins, 6), _ABITS),
        }
        if args == 7 then
            data.B = _BAND(_RSHIFT(ins, 23), _BCMASK)
            data.C = _BAND(_RSHIFT(ins, 14), _BCMASK)
            data.is_KB = mode.b == _S(5) and data.B > _ABITS
            data.is_KC = mode.c == _S(5) and data.C > _ABITS
            if op == 10 then
                local e = _BAND(_RSHIFT(data.B, 3), 31)
                data.const_B = e == 0 and data.B or _LSHIFT(_BAND(data.B, 7) + 8, e - 1)
                local e2 = _BAND(_RSHIFT(data.C, 3), 31)
                data.const_C = e2 == 0 and data.C or _LSHIFT(_BAND(data.C, 7) + 8, e2 - 1)
            end
        elseif args == 8 then
            data.Bx = _BAND(_RSHIFT(ins, 14), _BXMASK)
            data.is_K = mode.b == _S(5)
        elseif args == 9 then
            data.sBx = _BAND(_RSHIFT(ins, 14), _BXMASK) - _SBX_OFFSET
        end
        list[i] = data
    end
    return list
end

-- =========================================================
-- §16 常量 / 子表 / 行 / 局部 / upval
-- =========================================================
local _slf

local function _scl(S)
    local len = S:s_int()
    if len < 0 or len > 0x100000 then _trap("const len", true) end
    local list = _CREATE(len)
    for i = 1, len do
        local tt = _sby(S)
        local k
        if tt == 1 then k = _sby(S) ~= 0
        elseif tt == 3 then k = S:s_num()
        elseif tt == 4 then k = _sls(S)
        elseif tt ~= 0 then _trap("const type " .. _TOSTRING(tt), true) end
        list[i] = k
    end
    return _FREEZE(list)
end

local function _ssl(S, src, depth)
    local len = S:s_int()
    if len < 0 or len > 0x10000 then _trap("sub len", true) end
    local list = _CREATE(len)
    for i = 1, len do list[i] = _slf(S, src, depth + 1) end
    return list
end

local function _sll(S)
    local len = S:s_int()
    if len < 0 or len > 0x100000 then _trap("line len", true) end
    local list = _CREATE(len)
    for i = 1, len do list[i] = S:s_int() end
    return _FREEZE(list)
end

local function _slc(S)
    local len = S:s_int()
    if len < 0 or len > 0x100000 then _trap("locvar len", true) end
    local list = _CREATE(len)
    for i = 1, len do
        list[i] = {varname = _sls(S), startpc = S:s_int(), endpc = S:s_int()}
    end
    return list
end

local function _svl(S)
    local len = S:s_int()
    if len < 0 or len > 0x100000 then _trap("upval len", true) end
    local list = _CREATE(len)
    for i = 1, len do list[i] = _sls(S) end
    return _FREEZE(list)
end

-- =========================================================
-- §17 Proto 解析
-- =========================================================
function _slf(S, psrc, depth)
    depth = depth or 0
    if depth > _MAX_PROTO_DEPTH then _trap("proto deep", true) end
    local proto = {}
    local src = _sls(S) or psrc
    proto.source = src
    S:s_int(); S:s_int()
    proto.num_upval = _sby(S)
    proto.num_param = _sby(S)
    proto.is_vararg = _sby(S)
    proto.max_stack = _sby(S)
    proto.code   = _sil(S)
    proto.const  = _scl(S)
    proto.subs   = _ssl(S, src, depth)
    proto.lines  = _sll(S)
    _slc(S); _svl(S)
    proto.needs_arg = _BAND(proto.is_vararg, 0x5) == 0x5

    for _, v in _IPAIRS(proto.code) do
        if v.is_K then
            v.const = proto.const[v.Bx + 1]
        else
            if v.is_KB then v.const_B = proto.const[v.B - _ABITS] end
            if v.is_KC then v.const_C = proto.const[v.C - _ABITS] end
        end
    end

    proto.__cfi = _build_cfi_table(proto.code)

    for i = 1, #proto.code do _FREEZE(proto.code[i]) end
    _FREEZE(proto.code)

    proto.__crc_code = _code_crc(proto.code)
    local sub_digest = 0x811C9DC5
    for i = 1, #proto.subs do
        local sub = proto.subs[i]
        sub_digest = _BXOR(sub_digest, sub.__crc_code or 0)
        sub_digest = _BAND(sub_digest * 16777619, _N(0xFFFFFFFF))
        sub_digest = _BXOR(sub_digest, sub.__tree_digest or 0)
        sub_digest = _BAND(sub_digest * 16777619, _N(0xFFFFFFFF))
    end
    proto.__tree_digest = sub_digest
    return proto
end

-- =========================================================
-- §18 递归校验
-- =========================================================
local function _validate_proto(proto, visited, depth)
    visited = visited or {}
    depth = (depth or 0) + 1
    if depth > _MAX_PROTO_DEPTH then _trap("val deep", true) end
    if _TYPE(proto) ~= "table" then _trap("val not tbl", true) end
    if visited[proto] then _trap("val cyclic", true) end
    visited[proto] = true
    if not proto.code or #proto.code <= 0 then _trap("val empty", true) end
    if proto.max_stack > 10000 then _trap("val ms", true) end
    if proto.num_param > proto.max_stack then _trap("val np", true) end
    if proto.num_upval > 256 then _trap("val nu", true) end
    local code = proto.code
    for pc = 1, #code do
        local ins = code[pc]
        if _TYPE(ins.op) ~= "number" or ins.op > 37 or ins.op < 0 then
            _trap(_S_FMT("val op pc=%d op=%s", pc, _TOSTRING(ins.op)), true)
        end
        if ins.sBx then
            local tgt = pc + 1 + ins.sBx
            if tgt < 1 or tgt > #code + 1 then
                _trap(_S_FMT("val jump pc=%d tgt=%d", pc, tgt), true)
            end
        end
        if ins.A and ins.A > proto.max_stack + 4 then
            _trap(_S_FMT("val A pc=%d", pc), true)
        end
        if ins.B and ins.B > proto.max_stack + 4 and not ins.is_KB then
            _trap(_S_FMT("val B pc=%d", pc), true)
        end
    end
    for _, sub in _IPAIRS(proto.subs or {}) do
        _validate_proto(sub, visited, depth)
    end
    visited[proto] = nil
    return true
end

-- =========================================================
-- §19 加密层
-- =========================================================
local _CK_TABLE = _FREEZE({
    [1]=0xA5A5A5A5,[2]=0x5A5A5A5A,[3]=0x3C3C3C3C,
    [4]=0xC3C3C3C3,[5]=0x69696969,[6]=0x96969696,
})

local _seed_counter = 0
local function _gen_seed()
    _seed_counter = _seed_counter + 1
    local c = _FLOOR(_safe_clock() * 1000000)
    local s = _BXOR(_BXOR(c, _entropy_pool), _BXOR(_LSHIFT(_seed_counter, 17), 0x9E3779B9))
    s = _BAND(s * 2654435761, _N(0xFFFFFFFF))
    _entropy_pool = _BXOR(_entropy_pool, s)
    if s == 0 then s = 0xCAFEBABE end
    return s
end

local function _next_kb2(st, pos, salt)
    local x = st
    if x == 0 then x = 0x9E3779B9 end
    x = _BXOR(x, _LSHIFT(x, 13))
    x = _BXOR(x, _RSHIFT(x, 17))
    x = _BXOR(x, _LSHIFT(x, 5))
    x = _BXOR(x, _RSHIFT(x, 11))
    local mix = _BAND(_BXOR(_BAND(pos * 2654435761, _N(0xFFFFFFFF)), salt), _ABITS)
    return x, _BAND(_BXOR(x, mix), _ABITS)
end

local function _crypt_bytes(data, seed, salt)
    local n = #data
    if n == 0 then return "" end
    local st = _BXOR(seed, salt)
    local out = _CREATE(n)
    for i = 1, n do
        local b1; st, b1 = _next_kb2(st, i, salt)
        local b2; st, b2 = _next_kb2(st, i, _BXOR(salt, 0xDEAD))
        local p = _S_BYTE(data, i)
        local u = _BXOR(p, b1)
        local v = _SBOX[u + 1]
        local w = _BXOR(v, b2)
        local x = _SBOX_INV[w + 1]
        out[i] = _S_CHAR(_BXOR(x, b1))
    end
    return _CONCAT(out)
end

local function _pack_u32_le(n)
    return _S_CHAR(_BAND(n, _ABITS), _BAND(_RSHIFT(n, 8), _ABITS),
                   _BAND(_RSHIFT(n, 16), _ABITS), _BAND(_RSHIFT(n, 24), _ABITS))
end
local function _pack_u16_le(n)
    return _S_CHAR(_BAND(n, _ABITS), _BAND(_RSHIFT(n, 8), _ABITS))
end

local _MAGIC_LUE = _S(2)

local function _hmac_digest(seed, salt)
    return _crc32(_S_CHAR(
        _BAND(seed, _ABITS), _BAND(_RSHIFT(seed, 8), _ABITS),
        _BAND(_RSHIFT(seed, 16), _ABITS), _BAND(_RSHIFT(seed, 24), _ABITS),
        _BAND(salt, _ABITS), _BAND(_RSHIFT(salt, 8), _ABITS),
        _BAND(_RSHIFT(salt, 16), _ABITS), _BAND(_RSHIFT(salt, 24), _ABITS)
    ))
end

local function _pack_container(plaintext, opts)
    opts = opts or {}
    local chunk_size = opts.chunk_size or 4096
    local meta       = opts.meta
    if _TYPE(plaintext) ~= "string" then _trap("pack not str", true) end

    local total = #plaintext
    local all_chunks = {}
    if _TYPE(meta) == "string" and #meta > 0 then
        all_chunks[#all_chunks + 1] = {type = 1, data = meta}
    end
    if total == 0 then
        all_chunks[#all_chunks + 1] = {type = 3, data = ""}
    else
        local pos = 1
        while pos <= total do
            local len = _MIN(chunk_size, total - pos + 1)
            all_chunks[#all_chunks + 1] = {
                type = 3, data = _S_SUB(plaintext, pos, pos + len - 1),
            }
            pos = pos + len
        end
    end

    local seed = _gen_seed()
    local hdr_head = _MAGIC_LUE .. _S_CHAR(1, 0) ..
                     _pack_u16_le(#all_chunks) .. _pack_u32_le(total)
    local hdr_crc = _crc32(hdr_head)
    local header = hdr_head .. _pack_u32_le(hdr_crc)

    local sp1 = seed
    local sp2 = _BXOR(seed, _derive_key(seed, _K_S1, _K_S2, _K_S3))
    local seed_region = _pack_u32_le(sp1) .. _pack_u32_le(sp2) .. "\0\0\0\0\0\0\0\0"

    local block_parts = _CREATE(#all_chunks)
    for i = 1, #all_chunks do
        local c = all_chunks[i]
        local salt = _CK_TABLE[c.type] or 0
        local enc  = _crypt_bytes(c.data, _BXOR(seed, salt), salt)
        local c_crc_plain = _crc32(c.data)
        local ks_digest   = _hmac_digest(seed, salt)
        local c_crc = _BXOR(_BXOR(c_crc_plain, ks_digest), _K_S3)
        block_parts[i] = _S_CHAR(c.type) .. _pack_u32_le(#enc) ..
                         _pack_u32_le(c_crc) .. enc
    end
    return header .. seed_region .. _CONCAT(block_parts)
end

local function _dec_container(src)
    if _TYPE(src) ~= "string" or #src < 32 then _trap("cont short", true) end
    if _S_SUB(src, 1, 4) ~= _MAGIC_LUE then _trap("cont magic", true) end
    if _S_BYTE(src, 5) ~= 1 then _trap("cont ver", true) end

    local chunk_num = _ri_le(src, 7, 9)
    local raw_size  = _ri_le(src, 9, 13)
    local hdr_crc   = _ri_le(src, 13, 17)
    local sp1       = _ri_le(src, 17, 21)
    local sp2       = _ri_le(src, 21, 25)

    if _crc32(_S_SUB(src, 1, 12)) ~= hdr_crc then _trap("cont hdr", true) end

    local seed = sp1
    local expected_sp2 = _BXOR(seed, _derive_key(seed, _K_S1, _K_S2, _K_S3))
    if sp2 ~= expected_sp2 then _trap("cont seed", true) end

    local pos = 33
    local buf = {}
    local meta_parts = {}
    local total_plain = 0

    for _ = 1, chunk_num do
        if pos + 8 > #src then _trap("cont overrun", true) end
        local ct   = _S_BYTE(src, pos)
        local clen = _ri_le(src, pos + 1, pos + 5)
        local ccrc = _ri_le(src, pos + 5, pos + 9)
        if pos + 8 + clen > #src then _trap("cont overrun2", true) end
        local enc = _S_SUB(src, pos + 9, pos + 8 + clen)
        pos = pos + 9 + clen

        local salt = _CK_TABLE[ct] or 0
        local dec  = _crypt_bytes(enc, _BXOR(seed, salt), salt)

        local dec_crc_plain = _crc32(dec)
        local ks_digest     = _hmac_digest(seed, salt)
        local expect = _BXOR(_BXOR(dec_crc_plain, ks_digest), _K_S3)
        if expect ~= ccrc then _trap("cont hmac ct=" .. _TOSTRING(ct), true) end

        if ct == 1 then meta_parts[#meta_parts + 1] = dec
        else
            buf[#buf + 1] = dec
            total_plain = total_plain + #dec
        end
    end

    if total_plain ~= raw_size then _trap("cont size", true) end
    return _CONCAT(buf), (meta_parts[1] or nil), seed
end

-- =========================================================
-- §20 反调试主动防御（[FIX-1][FIX-7]）
-- =========================================================
local _DEBUG_ACTION = "error"

local _ENV_SNAPSHOT = _FREEZE({
    tostring = tostring, print = print, error = error, pcall = pcall,
    xpcall = xpcall, warn = warn, typeof = typeof,
    getmetatable = getmetatable, setmetatable = setmetatable,
    rawget = rawget, rawset = rawset,
})

local function _snapshot_changed()
    if tostring ~= _ENV_SNAPSHOT.tostring then return "tostring" end
    if print    ~= _ENV_SNAPSHOT.print    then return "print"    end
    if error    ~= _ENV_SNAPSHOT.error    then return "error"    end
    if pcall    ~= _ENV_SNAPSHOT.pcall    then return "pcall"    end
    if _TYPE(xpcall) == "function" and xpcall ~= _ENV_SNAPSHOT.xpcall then return "xpcall" end
    if _TYPE(warn) == "function" and warn ~= _ENV_SNAPSHOT.warn then return "warn" end
    if _TYPE(typeof) == "function" and typeof ~= _ENV_SNAPSHOT.typeof then return "typeof" end
    if getmetatable ~= _ENV_SNAPSHOT.getmetatable then return "getmetatable" end
    if setmetatable ~= _ENV_SNAPSHOT.setmetatable then return "setmetatable" end
    if rawget      ~= _ENV_SNAPSHOT.rawget       then return "rawget"       end
    if rawset      ~= _ENV_SNAPSHOT.rawset       then return "rawset"       end
    return nil
end

local _hang_sink = 0
local function _execute_counter_measure(what)
    if _DEBUG_ACTION == "hang" then
        local x = 0x12345678
        while true do
            x = _BAND(x * 1103515245 + 12345, 0x7FFFFFFF)
            x = _BXOR(x, _RSHIFT(x, 7))
            _hang_sink = _BXOR(_hang_sink, x)
        end
    elseif _DEBUG_ACTION == "kick" then
        _PCALL(function()
            local g = _w[71]
            if g and g[_S(49)] then
                local P = g[_S(49)](g, _S(46))
                if P and P[_S(47)] then
                    local plr = P[_S(47)]
                    if plr[_S(48)] then plr[_S(48)](plr, _S(56)) end
                end
            end
        end)
        local x = 0x12345678
        while true do
            x = _BAND(x * 1103515245 + 12345, 0x7FFFFFFF)
            x = _BXOR(x, _RSHIFT(x, 7))
            _hang_sink = _BXOR(_hang_sink, x)
        end
    else
        _trap("anti-debug: " .. _TOSTRING(what), true)
    end
end

local _wall_start = _TIME and _TIME() or 0
local _cpu_start  = _safe_clock()

-- [FIX-7] 改为时钟背离检测
local function _check_time_ratio()
    local wall = (_TIME and _TIME() or 0) - _wall_start
    local cpu  = _safe_clock() - _cpu_start
    if _ABS(wall - cpu) > 30 then return true end
    return false
end

-- [FIX-1] Roblox 中协程是常态，不是攻击信号
local function _is_yield_safe()
    return true
end

local _snapshot_probe = { last_clock = 0, last_time = 0, anomalies = 0 }
local function _snapshot_probe_tick()
    local now_c = _safe_clock()
    local now_t = _TIME and _TIME() or 0
    if _snapshot_probe.last_clock > 0 and now_c < _snapshot_probe.last_clock - 0.001 then
        _snapshot_probe.anomalies = _snapshot_probe.anomalies + 1
    end
    if _snapshot_probe.last_time > 0 and now_t - _snapshot_probe.last_time > 60 then
        _snapshot_probe.anomalies = _snapshot_probe.anomalies + 1
    end
    _snapshot_probe.last_clock = now_c
    _snapshot_probe.last_time = now_t
    if _snapshot_probe.anomalies > 3 then
        _execute_counter_measure("snapshot")
    end
end

local function _detect_tamper()
    local c = _snapshot_changed()
    if c then return "global:" .. c end
    if not _sniff_debug() then return "debug_hook" end
    if _TYPE(_sandbox_registry) ~= "table" then return "sandbox_registry" end
    if _TYPE(_sandbox_cache)    ~= "table" then return "sandbox_cache"    end
    if _tripwire.tier < 2 and _TYPE(_state_lock) ~= "table" then return "state_lock" end
    if _TYPE(_tripwire) ~= "table" then return "tripwire" end
    if not _omd[0] or _omd[0].b ~= _S(3) then return "opcode_table" end
    if _otp[0] ~= 7 then return "opcode_type_table" end
    return nil
end

local function _detect_dump()
    if _TYPE(string.dump) ~= "function" then return true end
    local ls = loadstring or load
    if _TYPE(ls) ~= "function" then return true end
    if getfenv ~= nil and _TYPE(getfenv) ~= "function" then return true end
    return false
end

local function _set_anti_debug(mode)
    if mode ~= "error" and mode ~= "hang" and mode ~= "kick" then
        _trap("bad mode " .. _TOSTRING(mode), true)
    end
    _DEBUG_ACTION = mode
end

-- =========================================================
-- §21 VM 指纹（[FIX-10] 身份比较）
-- =========================================================
local _VM_REFS = _FREEZE({
    _PCALL, _ERROR, _TYPE, _TOSTRING, _TONUMBER, _ASSERT, _SELECT,
    _PACK, _UNPACK, _MOVE, _CREATE, _CONCAT, _FREEZE_T,
    _S_BYTE, _S_SUB, _S_FMT, _S_GSUB, _S_CHAR, _S_REP, _S_FIND,
    _CLOCK, _TIME, _FLOOR, _ABS, _MIN, _MAX,
    _BAND, _BOR, _BXOR, _BNOT, _LSHIFT, _RSHIFT,
})

local function _check_vm_fingerprint()
    local cur = {
        pcall, error, type, tostring, tonumber, assert, select,
        table.pack, table.unpack, table.move, table.create,
        table.concat, table.freeze or _FREEZE_T,
        string.byte, string.sub, string.format, string.gsub,
        string.char, string.rep, string.find,
        os.clock, os.time, math.floor, math.abs, math.min, math.max,
        bit32.band, bit32.bor, bit32.bxor, bit32.bnot,
        bit32.lshift, bit32.rshift,
    }
    for i = 1, #cur do
        if cur[i] ~= _VM_REFS[i] then
            _trap("vm fp mismatch at " .. _TOSTRING(i), true)
        end
    end
end

local _session_fp = { device = nil, session_id = nil, t0 = 0, frozen = false }
local function _init_session_fp()
    local dev = "unknown"
    _PCALL(function()
        local g = _w[71]
        if g then
            local P = g.GetService and g:GetService("Players")
            if P and P.LocalPlayer then
                dev = _TOSTRING(P.LocalPlayer.UserId or "0")
            end
            if g.JobId then dev = dev .. ":" .. _TOSTRING(g.JobId) end
        end
    end)
    _session_fp.device = _crc32(dev)
    _session_fp.session_id = _gen_seed()
    _session_fp.t0 = _safe_clock()
    _session_fp.frozen = true
end
local function _check_session_fp()
    if not _session_fp.frozen then return true end
    if _session_fp.session_id == nil then return false end
    if _safe_clock() < _session_fp.t0 then return false end
    return true
end

-- =========================================================
-- §22 内存监控（[FIX-2] 禁用）
-- =========================================================
-- [FIX-2] 禁用内存访问监控：它只检测"连续访问同一寄存器"，
-- 而这正是任何正常循环的行为。检测不出真实攻击，只会误伤。
local function _note_mem_access(idx)
    return
end

local _reg_guard = { memory = {} }
local function _reg_store(mem, idx, v, key)
    if _TYPE(v) == "number" then
        local enc = _BXOR(v * 2654435761, key)
        _reg_guard.memory[idx] = { enc = enc, key = key }
    end
    mem[idx] = v
end
local function _reg_check(mem, idx)
    local g = _reg_guard.memory[idx]
    if not g then return end
    local v = mem[idx]
    if _TYPE(v) ~= "number" then return end
    local dec = _BXOR(v * 2654435761, g.key)
    if dec ~= g.enc then
        _trap("reg tamper idx=" .. _TOSTRING(idx), true)
    end
end

local PAGE_SIZE = 16
local _page_perms = {}
local function _page_id(idx) return _FLOOR(idx / PAGE_SIZE) end
local function _page_init(max_reg)
    for p = 0, _FLOOR(max_reg / PAGE_SIZE) + 1 do
        _page_perms[p] = { r = true, w = true }
    end
end

local function _check_table_integrity()
    if _SBOX[1] == nil or _SBOX[256] == nil then _trap("SBOX tampered", true) end
    if _otp[0] ~= 7 then _trap("OTP tampered", true) end
    if _omd[0] == nil or _omd[0].b ~= _S(3) then _trap("OMD tampered", true) end
    if _orm[22] ~= 18 then _trap("ORM[22] tampered", true) end
    if _orm[0]  ~= 3  then _trap("ORM[0] tampered", true) end
end

local _adaptive = { warmup = true, warmup_until = 1000, cycles_seen = 0 }
local function _adaptive_update(instr_count, cycles)
    if not _adaptive.warmup then return end
    if instr_count < _adaptive.warmup_until then return end
    _adaptive.warmup = false
    _adaptive.cycles_seen = cycles
end

local function _timing_noise()
    if _BAND(_gen_seed(), 0x7) ~= 0 then return end
    local spins = 1 + _BAND(_gen_seed(), 0xF)
    local acc = 0
    for i = 1, spins do acc = _BXOR(acc, i * 2654435761) end
    _junk_acc = _BXOR(_junk_acc, acc)
end

local function _inject_junk()
    local r = _BAND(_gen_seed(), 0x7)
    if r == 0 then
        _junk(_gen_seed())
    elseif r == 1 then
        _junk_acc = _BXOR(_junk_acc, _gen_seed())
    end
end

local _exec_profile = { op_hist = {}, jump_rate = 0, samples = 0, baseline = nil }
local function _profile_sample(op, is_jump)
    _exec_profile.samples = _exec_profile.samples + 1
    _exec_profile.op_hist[op] = (_exec_profile.op_hist[op] or 0) + 1
    if is_jump then _exec_profile.jump_rate = _exec_profile.jump_rate + 1 end
end
local function _profile_snapshot()
    local acc = 0x811C9DC5
    for i = 0, 37 do
        local c = _exec_profile.op_hist[i] or 0
        acc = _BXOR(acc, c)
        acc = _BAND(acc * 16777619, _N(0xFFFFFFFF))
    end
    acc = _BXOR(acc, _exec_profile.jump_rate)
    return acc
end
local function _profile_set_baseline()
    _exec_profile.baseline = _profile_snapshot()
end
local function _profile_drift_check()
    if not _exec_profile.baseline then return true end
    local cur = _profile_snapshot()
    local diff = _BAND(_BXOR(cur, _exec_profile.baseline), _N(0xFFFFFFFF))
    if _BAND(diff, 0xFFFF) > 0x8000 then return false end
    return true
end

local _trace_hash = 0x811C9DC5
local _trace_count = 0
local _trace_prev_op = 0
local function _trace_op(op)
    _trace_count = _trace_count + 1
    local pair = _BOR(_LSHIFT(op, 8), _trace_prev_op)
    _trace_hash = _BXOR(_trace_hash, pair)
    _trace_hash = _BAND(_trace_hash * 16777619, _N(0xFFFFFFFF))
    _trace_prev_op = op
end

local function _dual_verify_add(a, b, result)
    if _TYPE(a) ~= "number" or _TYPE(b) ~= "number" then return end
    if _TYPE(result) ~= "number" then return end
    local alt = a - (-b)
    if _ABS(alt - result) > 1e-10 then _trap("dual add", true) end
end
local function _dual_verify_sub(a, b, result)
    if _TYPE(a) ~= "number" or _TYPE(b) ~= "number" then return end
    if _TYPE(result) ~= "number" then return end
    local alt = a + (-b)
    if _ABS(alt - result) > 1e-10 then _trap("dual sub", true) end
end
local function _dual_verify_mul(a, b, result)
    if _TYPE(a) ~= "number" or _TYPE(b) ~= "number" then return end
    if _TYPE(result) ~= "number" then return end
    if b == 0 then return end
    local alt = a / (1 / b)
    if _ABS(alt - result) > 1e-6 * _ABS(result) + 1e-10 then _trap("dual mul", true) end
end

-- =========================================================
-- §23 [FIX-6] 假 VM 诱饵已删除
-- =========================================================

-- =========================================================
-- §24 反序列化入口
-- =========================================================
local _LV51 = _N(0x51)

local function _dec(src)
    if _tripwire.tier >= 2 then _trap("tripwire active", true) end
    if _opaque_false() and not _opaque_true() then _trap("opaque fail", true) end
    _junk(_N(0x1234))
    local tamper = _detect_tamper()
    if tamper then _execute_counter_measure(tamper) end
    _check_vm_fingerprint()
    if _detect_dump() then _execute_counter_measure("dump") end
    if _TYPE(src) ~= "string" or #src < 12 then _trap("invalid src", true) end
    if not _locks_ok() then _trap("lock changed", true) end

    if #src >= 4 and _S_SUB(src, 1, 4) == _MAGIC_LUE then
        local plain = _dec_container(src)
        if _S_SUB(plain, 1, 4) == _MAGIC_LUE then _trap("nested containers", true) end
        src = plain
    end

    local stream = { index = 1, source = src }
    if _sst(stream, 4) ~= _S(1) then _trap("bad sig", true) end
    if _sby(stream) ~= _LV51 then _trap("bad ver", true) end
    if _sby(stream) ~= 0 then _trap("bad fmt", true) end
    local little   = _sby(stream) ~= 0
    local size_int = _sby(stream)
    local size_szt = _sby(stream)
    local size_ins = _sby(stream)
    local size_num = _sby(stream)
    if size_int < 1 or size_int > 8 then _trap("size_int", true) end
    if size_szt < 1 or size_szt > 8 then _trap("size_szt", true) end
    if size_ins < 1 or size_ins > 8 then _trap("size_ins", true) end
    if size_num < 4 or size_num > 8 then _trap("size_num", true) end
    local flag_int = _sby(stream) ~= 0
    local rdr = little and _ri_le or _ri_be
    stream.s_int = _cir(size_int, rdr)
    stream.s_szt = _cir(size_szt, rdr)
    stream.s_ins = _cir(size_ins, rdr)
    if flag_int then
        stream.s_num = _cir(size_num, rdr)
    elseif _fty[size_num] then
        stream.s_num = _cfr(size_num, _fty[size_num][little and 'little' or 'big'])
    else
        _trap('float size', true)
    end
    local proto = _slf(stream, '@virtual', 0)
    _validate_proto(proto)
    proto.__crc = _crc32(src)
    return proto
end

-- =========================================================
-- §25 upvalue / 闭包
-- =========================================================
local function _clz(list, index)
    for i, uv in _PAIRS(list) do
        if uv.index >= index then
            uv.value = uv.store[uv.index]
            uv.store = uv
            uv.index = 'value'
            list[i] = nil
        end
    end
end
local function _opn(list, index, memory)
    local prev = list[index]
    if not prev then
        prev = {index = index, store = memory}
        list[index] = prev
    end
    return prev
end

-- =========================================================
-- §26 错误脱敏
-- =========================================================
local function _oer(failed, err)
    if _TYPE(err) == "string" and _S_BYTE(err, 1) == 0 then _ERROR(err, 0) end
    local src = failed.source or "<unknown>"
    local line = "?"
    local lines = failed.lines
    local pc = failed.pc
    if lines and _TYPE(pc) == "number" and lines[pc - 1] then
        line = lines[pc - 1]
    end
    err = _TOSTRING(err)
    err = _S_GSUB(err, "\n.*", "")
    err = _S_GSUB(err, "^.-:%d+:%s*", "")
    _ERROR(_S_FMT("%s:%s: %s", src, line, err), 0)
end

-- =========================================================
-- §27 VM 核心（[FIX-3][FIX-5]）
-- =========================================================
local DEFAULT_MAX_CALL  = 4096
local DEFAULT_MAX_INSTR = 0
local DEFAULT_TIMEOUT   = 0
local _call_depth_counter = 0

local _wra

local function _nvm(state, ctx, env, upvals)
    if not _is_sealed(state) then _trap("state tampered", true) end
    if not _locks_ok() then _trap("lock changed", true) end

    local code       = state.code
    local subs       = state.subs
    local tree_ref   = state.tree_digest
    local cfi        = state.cfi
    local vararg     = state.vararg
    local memory     = state.memory
    local sentinel_i = state.sentinel_i
    local crc_code   = state.crc_code
    local code_len   = #code

    local pc = 1
    local _last_pc = 0
    local top_index  = -1
    local open_list  = {}

    -- [FIX-3] 影子栈移入 _nvm 局部作用域
    local _shadow_stack = _CREATE(256)
    local _shadow_top   = 0
    local function _shadow_push_local(fn_identity)
        _shadow_top = _shadow_top + 1
        if _shadow_top > 256 then _trap("shadow overflow", true) end
        _shadow_stack[_shadow_top] = fn_identity
    end
    local function _shadow_pop_local()
        if _shadow_top <= 0 then _trap("shadow under", true) end
        _shadow_stack[_shadow_top] = nil
        _shadow_top = _shadow_top - 1
    end

    local hook       = state.hook
    local timeout    = state.timeout
    local max_instr  = state.max_instr
    local max_depth  = state.max_call_depth
    local check_int_base   = state.check_interval
    local check_int_jitter = state.check_interval_jitter
    local check_int = check_int_base
    local instr_count= 0
    local start_time = timeout > 0 and _safe_clock() or nil

    local env_ref = env
    local env_key_count = 0
    do
        local n = 0
        for _ in _PAIRS(env) do n = n + 1 end
        env_key_count = n
    end

    local check_counter = 0
    local code_crc_checked_at = 0
    local CODE_CRC_INTERVAL = 8192
    local _cfi_enabled = true

    while true do
        -- 诱饵 + 不透明谓词（[FIX-5] 降频）+ 垃圾
        do
            local _da = _BAND(instr_count, _ABITS)
            local _db = _BAND(_da * 251, _ABITS)
            if _BXOR(_da, _db) == _N(0x1FF) then _trap("decoy", true) end
            -- [FIX-5] 从每轮调用降频到 0xFF 一次
            if _BAND(instr_count, 0xFF) == 0 and _opaque_false() then
                _hang_sink = _hang_sink + 1
            end
            _junk(instr_count)
        end

        if pc < 1 or pc > code_len then
            _trap(_S_FMT("pc range pc=%d len=%d", pc, code_len), true)
        end

        if _cfi_enabled then
            local preds = cfi[pc]
            if not preds or not preds[_last_pc] then
                _trap("CFI from=" .. _TOSTRING(_last_pc) .. " to=" .. _TOSTRING(pc), true)
            end
        end
        _last_pc = pc

        instr_count = instr_count + 1
        if max_instr > 0 and instr_count > max_instr then _trap("instr limit") end
        if start_time and (_safe_clock() - start_time) > timeout then _trap("timeout") end
        if _call_depth_counter > max_depth then _trap("stack overflow") end

        if _BAND(instr_count, 0x1FF) == 0 then
            if _check_time_ratio() then _execute_counter_measure("time") end
        end

        if _BAND(instr_count, 0x7F) == 0 then
            for idx in _PAIRS(_reg_guard.memory) do _reg_check(memory, idx) end
        end

        _silent_mark()
        if _BAND(instr_count, 0xF) == 0 then _inject_junk() end
        _timing_noise()

        if _BAND(instr_count, 0x1FF) == 0 then _snapshot_probe_tick() end
        if instr_count == 2048 then _profile_set_baseline() end
        if _BAND(instr_count, 0x1FFF) == 0 and instr_count > 2048 then
            if not _profile_drift_check() then _silent_arm() end
        end
        if _BAND(instr_count, 0xFFF) == 0 then
            if not _check_session_fp() then _execute_counter_measure("session") end
        end

        check_counter = check_counter + 1
        if check_counter >= check_int then
            check_counter = 0
            check_int = check_int_base + _BAND(_gen_seed(), check_int_jitter)
            local jit = _BAND(_gen_seed(), 0x1F)
            for i = 1, jit do _hang_sink = _BXOR(_hang_sink, i) end
            _poly_seed = _BXOR(_poly_seed, _gen_seed())

            local tamper = _detect_tamper()
            if tamper then _execute_counter_measure(tamper) end
            if env ~= env_ref then _trap("env tampered", true) end
            if _is_sandbox(env) then
                local real_mt = _sandbox_registry[env]
                if not real_mt or real_mt[_ENV_TOKEN] ~= true then
                    _trap("sandbox mt", true)
                end
            end
            if memory[sentinel_i] ~= _SENTINEL then
                _trap("buffer overflow", true)
            end
            local n = 0
            for _ in _PAIRS(env) do n = n + 1 end
            if n > env_key_count + 16 then _trap("env inject", true) end
            _check_table_integrity()
            _adaptive_update(instr_count, check_counter)

            if _trace_hash == 0 or _trace_hash == _N(0xFFFFFFFF) then
                _trap("trace anomaly", true)
            end
        end

        if instr_count - code_crc_checked_at >= CODE_CRC_INTERVAL then
            code_crc_checked_at = instr_count
            if _code_crc(code) ~= crc_code then _trap("code crc", true) end
            if tree_ref then
                local sub_digest = 0x811C9DC5
                for i = 1, #subs do
                    local sub = subs[i]
                    local sub_crc = _code_crc(sub.code)
                    if sub_crc ~= sub.__crc_code then
                        _trap("sub crc i=" .. _TOSTRING(i), true)
                    end
                    sub_digest = _BXOR(sub_digest, sub_crc)
                    sub_digest = _BAND(sub_digest * 16777619, _N(0xFFFFFFFF))
                    sub_digest = _BXOR(sub_digest, sub.__tree_digest or 0)
                    sub_digest = _BAND(sub_digest * 16777619, _N(0xFFFFFFFF))
                end
                if sub_digest ~= tree_ref then _trap("tree mismatch", true) end
            end
        end

        local inst = code[pc]
        local op = inst.op
        ctx.pc = pc

        _trace_op(op)

        if hook then
            local ok, herr = _PCALL(hook, "instr", state, inst)
            if not ok then _trap("hook fail: " .. _TOSTRING(herr), true) end
        end

        pc = pc + 1

        -- ══════════ 分发 ══════════
        if op < 18 then
            if op < 8 then
                if op < 3 then
                    if op < 1 then
                        -- LOADNIL
                        for i = inst.A, inst.B do memory[i] = nil end
                    elseif op > 1 then
                        -- GETUPVAL
                        local uv = upvals[inst.B + 1]
                        if not uv then _trap("bad uv " .. _TOSTRING(inst.B), true) end
                        _note_mem_access(inst.A)
                        memory[inst.A] = uv.store[uv.index]
                    else
                        -- ADD
                        local lhs = inst.is_KB and inst.const_B or memory[inst.B]
                        local rhs = inst.is_KC and inst.const_C or memory[inst.C]
                        local r = _poly_add(lhs, rhs)
                        memory[inst.A] = r
                        if _BAND(instr_count, 0xF) == 0 then
                            _dual_verify_add(lhs, rhs, r)
                        end
                    end
                elseif op > 3 then
                    if op < 6 then
                        if op > 4 then
                            -- SELF
                            local A, B = inst.A, inst.B
                            local idx = inst.is_KC and inst.const_C or memory[inst.C]
                            memory[A + 1] = memory[B]
                            memory[A] = memory[B][idx]
                        else
                            -- GETGLOBAL
                            local g = inst.const
                            if _TYPE(g) ~= "string" then _trap("bad gg", true) end
                            memory[inst.A] = env[g]
                        end
                    elseif op > 6 then
                        -- GETTABLE
                        local idx = inst.is_KC and inst.const_C or memory[inst.C]
                        _note_mem_access(inst.A)
                        memory[inst.A] = memory[inst.B][idx]
                    else
                        -- SUB
                        local lhs = inst.is_KB and inst.const_B or memory[inst.B]
                        local rhs = inst.is_KC and inst.const_C or memory[inst.C]
                        local r = _poly_sub(lhs, rhs)
                        memory[inst.A] = r
                        if _BAND(instr_count, 0xF) == 0 then
                            _dual_verify_sub(lhs, rhs, r)
                        end
                    end
                else
                    -- MOVE
                    memory[inst.A] = memory[inst.B]
                end
            elseif op > 8 then
                if op < 13 then
                    if op < 10 then
                        -- SETGLOBAL
                        local g = inst.const
                        if _TYPE(g) ~= "string" then _trap("bad sg", true) end
                        env[g] = memory[inst.A]
                    elseif op > 10 then
                        if op < 12 then
                            -- CALL
                            local A, B, C = inst.A, inst.B, inst.C
                            local fn = memory[A]
                            if _TYPE(fn) ~= "function" then _trap("call non-fn") end
                            local params = B == 0 and (top_index - A) or (B - 1)
                            if params < 0 then _trap("bad args") end
                            _shadow_push_local(fn)
                            _reg_check(memory, A)
                            local ok, ret_list = _PCALL(function()
                                return _PACK(fn(_UNPACK(memory, A + 1, A + params)))
                            end)
                            if not ok then _ERROR(ret_list, 0) end
                            _shadow_pop_local()
                            local ret_num = ret_list.n
                            if C == 0 then top_index = A + ret_num - 1
                            else ret_num = C - 1 end
                            _MOVE(ret_list, 1, ret_num, A, memory)
                        else
                            -- SETUPVAL
                            local uv = upvals[inst.B + 1]
                            if not uv then _trap("bad uv " .. _TOSTRING(inst.B), true) end
                            uv.store[uv.index] = memory[inst.A]
                        end
                    else
                        -- MUL
                        local lhs = inst.is_KB and inst.const_B or memory[inst.B]
                        local rhs = inst.is_KC and inst.const_C or memory[inst.C]
                        local r = _poly_mul(lhs, rhs)
                        memory[inst.A] = r
                        if _BAND(instr_count, 0xF) == 0 then
                            _dual_verify_mul(lhs, rhs, r)
                        end
                    end
                elseif op > 13 then
                    if op < 16 then
                        if op > 14 then
                            -- TAILCALL
                            local A, B = inst.A, inst.B
                            local fn = memory[A]
                            if _TYPE(fn) ~= "function" then _trap("tail non-fn") end
                            local params = B == 0 and (top_index - A) or (B - 1)
                            if _shadow_top > 0 then _shadow_pop_local() end
                            _shadow_push_local(fn)
                            _clz(open_list, 0)
                            return fn(_UNPACK(memory, A + 1, A + params))
                        else
                            -- SETTABLE
                            local idx = inst.is_KB and inst.const_B or memory[inst.B]
                            local val = inst.is_KC and inst.const_C or memory[inst.C]
                            _note_mem_access(inst.A)
                            memory[inst.A][idx] = val
                        end
                    elseif op > 16 then
                        -- NEWTABLE
                        memory[inst.A] = _CREATE(inst.const_B or 0, inst.const_C or 0)
                    else
                        -- DIV
                        local lhs = inst.is_KB and inst.const_B or memory[inst.B]
                        local rhs = inst.is_KC and inst.const_C or memory[inst.C]
                        memory[inst.A] = lhs / rhs
                    end
                else
                    -- LOADK
                    memory[inst.A] = inst.const
                end
            else
                -- FORLOOP
                local A = inst.A
                local step = memory[A + 2]
                local index = memory[A] + step
                local limit = memory[A + 1]
                local loops = step >= 0 and (index <= limit) or (index >= limit)
                if loops then
                    memory[A] = index
                    memory[A + 3] = index
                    pc = pc + inst.sBx
                end
            end
        elseif op > 18 then
            if op < 28 then
                if op < 23 then
                    if op < 20 then
                        -- LEN
                        memory[inst.A] = #memory[inst.B]
                    elseif op > 20 then
                        if op < 22 then
                            -- RETURN
                            local A, B = inst.A, inst.B
                            local len = B == 0 and (top_index - A + 1) or (B - 1)
                            _clz(open_list, 0)
                            if _shadow_top > 0 then _shadow_pop_local() end
                            return _UNPACK(memory, A, A + len - 1)
                        else
                            -- CONCAT
                            local B, C = inst.B, inst.C
                            local ok, str = _PCALL(_CONCAT, memory, "", B, C)
                            if not ok then
                                str = memory[B]
                                for i = B + 1, C do str = str .. memory[i] end
                            end
                            memory[inst.A] = str
                        end
                    else
                        -- MOD
                        local lhs = inst.is_KB and inst.const_B or memory[inst.B]
                        local rhs = inst.is_KC and inst.const_C or memory[inst.C]
                        memory[inst.A] = lhs % rhs
                    end
                elseif op > 23 then
                    if op < 26 then
                        if op > 24 then
                            -- CLOSE
                            _clz(open_list, inst.A)
                        else
                            -- EQ (op=24)
                            local lhs = inst.is_KB and inst.const_B or memory[inst.B]
                            local rhs = inst.is_KC and inst.const_C or memory[inst.C]
                            if (lhs == rhs) == (inst.A ~= 0) then
                                pc = pc + code[pc].sBx
                            end
                            pc = pc + 1
                        end
                    elseif op > 26 then
                        -- LT (op=27)
                        local lhs = inst.is_KB and inst.const_B or memory[inst.B]
                        local rhs = inst.is_KC and inst.const_C or memory[inst.C]
                        if (lhs < rhs) == (inst.A ~= 0) then
                            pc = pc + code[pc].sBx
                        end
                        pc = pc + 1
                    else
                        -- POW
                        local lhs = inst.is_KB and inst.const_B or memory[inst.B]
                        local rhs = inst.is_KC and inst.const_C or memory[inst.C]
                        memory[inst.A] = lhs ^ rhs
                    end
                else
                    -- LOADBOOL (op=23)
                    memory[inst.A] = inst.B ~= 0
                    if inst.C ~= 0 then pc = pc + 1 end
                end
            elseif op > 28 then
                if op < 33 then
                    if op < 30 then
                        -- LE (op=29)
                        local lhs = inst.is_KB and inst.const_B or memory[inst.B]
                        local rhs = inst.is_KC and inst.const_C or memory[inst.C]
                        if (lhs <= rhs) == (inst.A ~= 0) then
                            pc = pc + code[pc].sBx
                        end
                        pc = pc + 1
                    elseif op > 30 then
                        if op < 32 then
                            -- CLOSURE
                            local sub = subs[inst.Bx + 1]
                            if not sub then _trap("bad sub " .. _TOSTRING(inst.Bx), true) end
                            local nups = sub.num_upval
                            local uvlist
                            if nups ~= 0 then
                                uvlist = _CREATE(nups)
                                for i = 1, nups do
                                    local pseudo = code[pc + i - 1]
                                    if not pseudo then _trap("bad pseudo", true) end
                                    if pseudo.op == _orm[0] then
                                        uvlist[i] = _opn(open_list, pseudo.B, memory)
                                    elseif pseudo.op == _orm[4] then
                                        uvlist[i] = upvals[pseudo.B + 1]
                                    end
                                end
                                pc = pc + nups
                            end
                            memory[inst.A] = _wra(sub, env, uvlist, state.vm_options)
                        else
                            -- TESTSET (op=32)
                            local A, B = inst.A, inst.B
                            if (not memory[B]) ~= (inst.C ~= 0) then
                                memory[A] = memory[B]
                                pc = pc + code[pc].sBx
                            end
                            pc = pc + 1
                        end
                    else
                        -- UNM
                        memory[inst.A] = -memory[inst.B]
                    end
                elseif op > 33 then
                    if op < 36 then
                        if op > 34 then
                            -- VARARG
                            local A = inst.A
                            local len = inst.B
                            if len == 0 then
                                len = vararg.len
                                top_index = A + len - 1
                            end
                            _MOVE(vararg.list, 1, len, A, memory)
                        else
                            -- FORPREP
                            local A = inst.A
                            local init  = _ASSERT(_TONUMBER(memory[A]), '`for` init num')
                            local limit = _ASSERT(_TONUMBER(memory[A + 1]), '`for` limit num')
                            local step  = _ASSERT(_TONUMBER(memory[A + 2]), '`for` step num')
                            memory[A]     = init - step
                            memory[A + 1] = limit
                            memory[A + 2] = step
                            _reg_store(memory, A, memory[A], _gen_seed())
                            pc = pc + inst.sBx
                        end
                    elseif op > 36 then
                        -- SETLIST
                        local A, C, len = inst.A, inst.C, inst.B
                        local tab = memory[A]
                        if _TYPE(tab) ~= "table" then _trap("SETLIST not tbl") end
                        if len == 0 then len = top_index - A end
                        if C == 0 then
                            C = code[pc].Bx
                            pc = pc + 1
                        end
                        local offset = (C - 1) * FIELDS_PER_FLUSH
                        _MOVE(memory, A + 1, A + len, offset + 1, tab)
                    else
                        -- NOT
                        memory[inst.A] = not memory[inst.B]
                    end
                else
                    -- TEST (op=33)
                    if (not memory[inst.A]) ~= (inst.C ~= 0) then
                        pc = pc + code[pc].sBx
                    end
                    pc = pc + 1
                end
            else
                -- TFORLOOP
                local A = inst.A
                local base = A + 3
                local it = memory[A]
                if _TYPE(it) ~= "function" then _trap("bad iter") end
                local vals = {it(memory[A + 1], memory[A + 2])}
                _MOVE(vals, 1, inst.C, base, memory)
                if memory[base] ~= nil then
                    memory[A + 2] = memory[base]
                    pc = pc + code[pc].sBx
                end
                pc = pc + 1
            end
        else
            -- JMP
            pc = pc + inst.sBx
        end
    end
end

-- =========================================================
-- §28 包装器（[FIX-4][FIX-9]）
-- =========================================================
function _wra(proto, env, upval, vm_opts)
    if _tripwire.tier >= 2 then _trap("tripwire active", true) end
    if not _locks_ok() then _trap("lock changed", true) end
    vm_opts = vm_opts or {}
    if env == nil then env = _G end

    if not _is_sandbox(env) then
        env = _get_or_make_sandbox(env, vm_opts.sandbox or {})
    end

    local check_interval_base   = 512 + _FLOOR(_safe_clock() * 1000) % 1536
    local check_interval_jitter = 128

    return function(...)
        if _tripwire.tier >= 2 then _trap("tripwire active", true) end
        local tamper = _detect_tamper()
        if tamper then _execute_counter_measure(tamper) end
        _check_vm_fingerprint()
        if not _is_yield_safe() then _execute_counter_measure("yield") end

        if not _session_fp.frozen then _init_session_fp() end

        -- [FIX-9] 清理跨调用累积状态
        for k in _PAIRS(_reg_guard.memory) do
            _reg_guard.memory[k] = nil
        end
        for k in _PAIRS(_page_perms) do
            _page_perms[k] = nil
        end
        _mem_access_total = 0
        _mem_anomaly_count = 0
        _mem_access_idx = 0
        for i = 1, 8 do _mem_access_log[i] = nil end
        _exec_profile.samples = 0
        _exec_profile.jump_rate = 0
        _exec_profile.baseline = nil
        for i = 0, 37 do _exec_profile.op_hist[i] = nil end
        _trace_hash = 0x811C9DC5
        _trace_count = 0
        _trace_prev_op = 0
        _silent_trap.count = 0
        _adaptive.warmup = true
        _adaptive.cycles_seen = 0
        _snapshot_probe.last_clock = 0
        _snapshot_probe.last_time = 0
        _snapshot_probe.anomalies = 0

        -- [FIX-4] 删除 _frame_depth，由 _call_depth_counter 统一管理

        local call_env = _current_env() or env
        if not _is_sandbox(call_env) then
            _trap("env not sb", true)
        end

        local passed = _PACK(...)
        local sentinel_i = proto.max_stack + 1
        local memory = _CREATE(sentinel_i)
        memory[sentinel_i] = _SENTINEL

        _page_init(proto.max_stack)

        local vararg = {len = 0, list = {}}
        _MOVE(passed, 1, proto.num_param, 0, memory)
        if proto.num_param < passed.n then
            local start = proto.num_param + 1
            local len   = passed.n - proto.num_param
            vararg.len  = len
            _MOVE(passed, start, start + len - 1, 1, vararg.list)
        end
        if proto.needs_arg then
            memory[proto.num_param] = {n = vararg.len,
                                        _UNPACK(vararg.list, 1, vararg.len)}
        end

        local ctx = { pc = 1 }
        local state = _seal(_FREEZE({
            vararg                 = vararg,
            memory                 = memory,
            code                   = proto.code,
            crc_code               = proto.__crc_code,
            tree_digest            = proto.__tree_digest,
            cfi                    = proto.__cfi,
            subs                   = proto.subs,
            max_stack              = proto.max_stack,
            sentinel_i             = sentinel_i,
            hook                   = vm_opts.hook,
            timeout                = vm_opts.timeout or DEFAULT_TIMEOUT,
            max_instr              = vm_opts.max_instr or DEFAULT_MAX_INSTR,
            max_call_depth         = vm_opts.max_call_depth or DEFAULT_MAX_CALL,
            check_interval         = check_interval_base,
            check_interval_jitter  = check_interval_jitter,
            vm_options             = vm_opts,
        }))

        _call_depth_counter = _call_depth_counter + 1
        local ok, result = _PCALL(_nvm, state, ctx, call_env, upval)
        _call_depth_counter = _call_depth_counter - 1
        if ok then
            return result
        else
            local failed = {pc = ctx.pc, source = proto.source, lines = proto.lines}
            _oer(failed, result)
            return
        end
    end
end

local function _ld(bc, env, vm_opts)
    if not _session_fp.frozen then _init_session_fp() end
    local proto = _dec(bc)
    return _wra(proto, env, nil, vm_opts)
end

-- =========================================================
-- §29 网络数据包混淆
-- =========================================================
local function _key_stream(key, iv, len)
    local st = _BXOR(_BAND(key, _N(0xFFFFFFFF)), _BAND(iv, _N(0xFFFFFFFF)))
    if st == 0 then st = 0x9E3779B9 end
    local out = _CREATE(len)
    for i = 1, len do
        st = _BXOR(st, _LSHIFT(st, 13))
        st = _BXOR(st, _RSHIFT(st, 17))
        st = _BXOR(st, _LSHIFT(st, 5))
        out[i] = _BAND(st, _ABITS)
    end
    return out
end

local _MAGIC_LNP = _S(10)

local function _net_encode(plain, key)
    key = key or 0x13579BDF
    if _TYPE(plain) ~= "string" then _trap("net enc str", true) end
    local n = #plain
    local iv = _gen_seed()
    local ks = _key_stream(key, iv, n)
    local cbuf = _CREATE(n)
    for i = 1, n do
        local b = _S_BYTE(plain, i)
        local x = _BXOR(b, ks[i])
        cbuf[i] = _S_CHAR(_SBOX[x + 1])
    end
    local cipher = _CONCAT(cbuf)
    local mac = _BXOR(_crc32(plain), _crc32(cipher))
    return _MAGIC_LNP .. _pack_u32_le(iv) .. cipher .. _pack_u32_le(mac)
end

local function _net_decode(pkt, key)
    key = key or 0x13579BDF
    if _TYPE(pkt) ~= "string" or #pkt < 12 then _trap("net dec short", true) end
    if _S_SUB(pkt, 1, 4) ~= _MAGIC_LNP then _trap("net dec magic", true) end
    local total = #pkt
    local iv    = _ri_le(pkt, 5, 9)
    local cipher = _S_SUB(pkt, 9, total - 4)
    local mac    = _ri_le(pkt, total - 3, total + 1)
    local n = #cipher
    local ks = _key_stream(key, iv, n)
    local pbuf = _CREATE(n)
    for i = 1, n do
        local c = _S_BYTE(cipher, i)
        local x = _SBOX_INV[c + 1]
        pbuf[i] = _S_CHAR(_BXOR(x, ks[i]))
    end
    local plain = _CONCAT(pbuf)
    if _BXOR(_crc32(plain), _crc32(cipher)) ~= mac then
        _trap("net dec MAC", true)
    end
    return plain
end

-- =========================================================
-- §30 字符串池预热
-- =========================================================
do
    for i = 1, 56 do _S(i) end
end

-- =========================================================
-- §31 API 导出
-- =========================================================
local debug_api = {
    FIELDS_PER_FLUSH = FIELDS_PER_FLUSH,
    is_tripped = function() return _tripwire.tier >= 2 end,
    trip_tier  = function() return _tripwire.tier end,
    describe_proto = function(proto)
        return {
            source = proto.source, max_stack = proto.max_stack,
            num_param = proto.num_param, num_upval = proto.num_upval,
            is_vararg = proto.is_vararg, code_count = #proto.code,
            const_count = #proto.const, sub_proto_count = #proto.subs,
            crc = proto.__crc, crc_code = proto.__crc_code,
            tree_digest = proto.__tree_digest,
        }
    end,
    crc32 = _crc32,
    verify = function(src)
        local ok, proto = _PCALL(_dec, src)
        if not ok then return false, proto end
        return true, proto.__crc
    end,
}

local crypto_api = _FREEZE({
    pack   = _pack_container,
    unpack = _dec_container,
    crypt  = _crypt_bytes,
    seed   = _gen_seed,
    encrypt_string = function(s, seed, salt)
        return _crypt_bytes(s, seed or _gen_seed(), salt or 0x12345678)
    end,
    decrypt_string = function(s, seed, salt)
        return _crypt_bytes(s, seed or 0, salt or 0x12345678)
    end,
})

local env_api = _FREEZE({
    make_sandbox = _make_sandbox,
    is_sandbox   = _is_sandbox,
    with_env     = _with_env,
    current_env  = _current_env,
    snapshot     = _w,
    name_map     = _w_name,
})

local net_api = _FREEZE({
    encode      = _net_encode,
    decode      = _net_decode,
    key_stream  = _key_stream,
    sbox        = _SBOX,
    sbox_inv    = _SBOX_INV,
    default_key = 0x13579BDF,
})

return _FREEZE({
    version     = '1.9.5.3-roblox-all-10-fixes',
    read        = _dec,
    wrap        = _wra,
    load        = _ld,
    debug       = debug_api,
    crypto      = crypto_api,
    env         = env_api,
    net         = net_api,

    set_anti_debug = _set_anti_debug,
    get_anti_debug = function() return _DEBUG_ACTION end,
    detect_tamper  = _detect_tamper,

    bc_to_state = _dec,
    wrap_state  = _wra,
    OPCODE_RM   = _orm,
    OPCODE_T    = _otp,
    OPCODE_M    = _omd,
    is_tripped  = function() return _tripwire.tier >= 2 end,
})