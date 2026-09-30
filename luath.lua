--[[
Luath
]] --
-- bit compatibility: prefer native bit / bit32, fall back to a pure-Lua shim
local bit = bit or bit32
if not bit then
	-- pure-Lua 32-bit ops for hosts without a bit library (e.g. stock Lua 5.1)
	local floor = math.floor
	local _u32 = 4294967296 -- 2^32

	bit = {
		band = function(a, b)
			a, b = (a % _u32 + _u32) % _u32, (b % _u32 + _u32) % _u32
			local r, p = 0, 1
			while a > 0 and b > 0 do
				if a % 2 == 1 and b % 2 == 1 then r = r + p end
				a, b, p = floor(a / 2), floor(b / 2), p * 2
			end
			return r
		end,
		bor = function(a, b)
			a, b = (a % _u32 + _u32) % _u32, (b % _u32 + _u32) % _u32
			local r, p = 0, 1
			while (a > 0 or b > 0) and p < _u32 do
				if a % 2 == 1 or b % 2 == 1 then r = r + p end
				a, b, p = floor(a / 2), floor(b / 2), p * 2
			end
			return r
		end,
		bxor = function(a, b)
			a, b = (a % _u32 + _u32) % _u32, (b % _u32 + _u32) % _u32
			local r, p = 0, 1
			while (a > 0 or b > 0) and p < _u32 do
				local x, y = a % 2, b % 2
				if x ~= y then r = r + p end
				a, b, p = floor(a / 2), floor(b / 2), p * 2
			end
			return r
		end,
		bnot = function(a)
			a = (a % _u32 + _u32) % _u32
			return _u32 - 1 - a
		end,
		lshift = function(a, n) return ((a % _u32 + _u32) % _u32 * 2 ^ n) % _u32 end,
		rshift = function(a, n) return floor(((a % _u32 + _u32) % _u32) / 2 ^ n) end,
		arshift = function(a, n)
			a = (a % _u32 + _u32) % _u32
			local sign = floor(a / 2147483648) -- 2^31
			local r = floor(a / 2 ^ n)
			if sign == 1 then r = r + _u32 - floor(_u32 / 2 ^ n) end
			return r % _u32
		end,
	}
end

if not table.create then if table.new then table.create = table.new else function table.create(_) return {} end end end

if not table.unpack then table.unpack = unpack end

if not table.pack then function table.pack(...) return {n = select('#', ...), ...} end end

if not table.move then
	function table.move(src, first, last, offset, dst)
		for i = 0, last - first do dst[offset + i] = src[first + i] end
	end
end

local _dec
local _wra
local _slf

-- SETLIST config
local FIELDS_PER_FLUSH = 50

-- remap for better lookup
local _orm = {
	-- level 1
	[22] = 18, -- JMP
	[31] = 8, -- FORLOOP
	[33] = 28, -- TFORLOOP
	-- level 2
	[0] = 3, -- MOVE
	[1] = 13, -- LOADK
	[2] = 23, -- LOADBOOL
	[26] = 33, -- TEST
	-- level 3
	[12] = 1, -- ADD
	[13] = 6, -- SUB
	[14] = 10, -- MUL
	[15] = 16, -- DIV
	[16] = 20, -- MOD
	[17] = 26, -- POW
	[18] = 30, -- UNM
	[19] = 36, -- NOT
	-- level 4
	[3] = 0, -- LOADNIL
	[4] = 2, -- GETUPVAL
	[5] = 4, -- GETGLOBAL
	[6] = 7, -- GETTABLE
	[7] = 9, -- SETGLOBAL
	[8] = 12, -- SETUPVAL
	[9] = 14, -- SETTABLE
	[10] = 17, -- NEWTABLE
	[20] = 19, -- LEN
	[21] = 22, -- CONCAT
	[23] = 24, -- EQ
	[24] = 27, -- LT
	[25] = 29, -- LE
	[27] = 32, -- TESTSET
	[32] = 34, -- FORPREP
	[34] = 37, -- SETLIST
	-- level 5
	[11] = 5, -- SELF
	[28] = 11, -- CALL
	[29] = 15, -- TAILCALL
	[30] = 21, -- RETURN
	[35] = 25, -- CLOSE
	[36] = 31, -- CLOSURE
	[37] = 35, -- VARARG
}

-- opcode types for getting values
local _otp = {
	[0] = 'ABC',
	'ABx',
	'ABC',
	'ABC',
	'ABC',
	'ABx',
	'ABC',
	'ABx',
	'ABC',
	'ABC',
	'ABC',
	'ABC',
	'ABC',
	'ABC',
	'ABC',
	'ABC',
	'ABC',
	'ABC',
	'ABC',
	'ABC',
	'ABC',
	'ABC',
	'AsBx',
	'ABC',
	'ABC',
	'ABC',
	'ABC',
	'ABC',
	'ABC',
	'ABC',
	'ABC',
	'AsBx',
	'AsBx',
	'ABC',
	'ABC',
	'ABC',
	'ABx',
	'ABC',
}

local _omd = {
	[0] = {b = 'OpArgR', c = 'OpArgN'},
	{b = 'OpArgK', c = 'OpArgN'},
	{b = 'OpArgU', c = 'OpArgU'},
	{b = 'OpArgR', c = 'OpArgN'},
	{b = 'OpArgU', c = 'OpArgN'},
	{b = 'OpArgK', c = 'OpArgN'},
	{b = 'OpArgR', c = 'OpArgK'},
	{b = 'OpArgK', c = 'OpArgN'},
	{b = 'OpArgU', c = 'OpArgN'},
	{b = 'OpArgK', c = 'OpArgK'},
	{b = 'OpArgU', c = 'OpArgU'},
	{b = 'OpArgR', c = 'OpArgK'},
	{b = 'OpArgK', c = 'OpArgK'},
	{b = 'OpArgK', c = 'OpArgK'},
	{b = 'OpArgK', c = 'OpArgK'},
	{b = 'OpArgK', c = 'OpArgK'},
	{b = 'OpArgK', c = 'OpArgK'},
	{b = 'OpArgK', c = 'OpArgK'},
	{b = 'OpArgR', c = 'OpArgN'},
	{b = 'OpArgR', c = 'OpArgN'},
	{b = 'OpArgR', c = 'OpArgN'},
	{b = 'OpArgR', c = 'OpArgR'},
	{b = 'OpArgR', c = 'OpArgN'},
	{b = 'OpArgK', c = 'OpArgK'},
	{b = 'OpArgK', c = 'OpArgK'},
	{b = 'OpArgK', c = 'OpArgK'},
	{b = 'OpArgR', c = 'OpArgU'},
	{b = 'OpArgR', c = 'OpArgU'},
	{b = 'OpArgU', c = 'OpArgU'},
	{b = 'OpArgU', c = 'OpArgU'},
	{b = 'OpArgU', c = 'OpArgN'},
	{b = 'OpArgR', c = 'OpArgN'},
	{b = 'OpArgR', c = 'OpArgN'},
	{b = 'OpArgN', c = 'OpArgU'},
	{b = 'OpArgU', c = 'OpArgU'},
	{b = 'OpArgN', c = 'OpArgN'},
	{b = 'OpArgU', c = 'OpArgN'},
	{b = 'OpArgU', c = 'OpArgN'},
}

-- int _ri_b(string src, int s, int e, int d)
-- @src - Source binary string
-- @s - Start index of a little endian integer
-- @e - End index of the integer
-- @d - Direction of the loop
local function _ri_b(src, s, e, d)
	local num = 0

	-- if bb[l] > 127 then -- signed negative
	-- 	num = num - 256 ^ l
	-- 	bb[l] = bb[l] - 128
	-- end

	for i = s, e, d do
		local mul = 256 ^ math.abs(i - s)

		num = num + mul * string.byte(src, i, i)
	end

	return num
end

-- float _rf_b(byte f1..8)
-- @f1..4 - The 4 bytes composing a little endian float
local function _rf_b(f1, f2, f3, f4)
	local sign = (-1) ^ bit.rshift(f4, 7)
	local exp = bit.rshift(f3, 7) + bit.lshift(bit.band(f4, 0x7F), 1)
	local frac = f1 + bit.lshift(f2, 8) + bit.lshift(bit.band(f3, 0x7F), 16)
	local normal = 1

	if exp == 0 then
		if frac == 0 then
			return sign * 0
		else
			normal = 0
			exp = 1
		end
	elseif exp == 0x7F then
		if frac == 0 then
			return sign * (1 / 0)
		else
			return sign * (0 / 0)
		end
	end

	return sign * 2 ^ (exp - 127) * (1 + normal / 2 ^ 23)
end

-- double _rd_b(byte f1..8)
-- @f1..8 - The 8 bytes composing a little endian double
local function _rd_b(f1, f2, f3, f4, f5, f6, f7, f8)
	local sign = (-1) ^ bit.rshift(f8, 7)
	local exp = bit.lshift(bit.band(f8, 0x7F), 4) + bit.rshift(f7, 4)
	local frac = bit.band(f7, 0x0F) * 2 ^ 48
	local normal = 1

	frac = frac + (f6 * 2 ^ 40) + (f5 * 2 ^ 32) + (f4 * 2 ^ 24) + (f3 * 2 ^ 16) + (f2 * 2 ^ 8) + f1 -- help

	if exp == 0 then
		if frac == 0 then
			return sign * 0
		else
			normal = 0
			exp = 1
		end
	elseif exp == 0x7FF then
		if frac == 0 then
			return sign * (1 / 0)
		else
			return sign * (0 / 0)
		end
	end

	return sign * 2 ^ (exp - 1023) * (normal + frac / 2 ^ 52)
end

-- int _ri_le(string src, int s, int e)
-- @src - Source binary string
-- @s - Start index of a little endian integer
-- @e - End index of the integer
local function _ri_le(src, s, e) return _ri_b(src, s, e - 1, 1) end

-- int _ri_be(string src, int s, int e)
-- @src - Source binary string
-- @s - Start index of a big endian integer
-- @e - End index of the integer
local function _ri_be(src, s, e) return _ri_b(src, e - 1, s, -1) end

-- float _rf_le(string src, int s)
-- @src - Source binary string
-- @s - Start index of little endian float
local function _rf_le(src, s) return _rf_b(string.byte(src, s, s + 3)) end

-- float _rf_be(string src, int s)
-- @src - Source binary string
-- @s - Start index of big endian float
local function _rf_be(src, s)
	local f1, f2, f3, f4 = string.byte(src, s, s + 3)
	return _rf_b(f4, f3, f2, f1)
end

-- double _rd_le(string src, int s)
-- @src - Source binary string
-- @s - Start index of little endian double
local function _rd_le(src, s) return _rd_b(string.byte(src, s, s + 7)) end

-- double _rd_be(string src, int s)
-- @src - Source binary string
-- @s - Start index of big endian double
local function _rd_be(src, s)
	local f1, f2, f3, f4, f5, f6, f7, f8 = string.byte(src, s, s + 7) -- same
	return _rd_b(f8, f7, f6, f5, f4, f3, f2, f1)
end

-- to avoid nested ifs in deserializing
local _fty = {
	[4] = {little = _rf_le, big = _rf_be},
	[8] = {little = _rd_le, big = _rd_be},
}

-- byte _sby(Stream S)
-- @S - Stream object to read from
local function _sby(S)
	local idx = S.index
	local bt = string.byte(S.source, idx, idx)

	S.index = idx + 1
	return bt
end

-- string _sst(Stream S, int len)
-- @S - Stream object to read from
-- @len - Length of string being read
local function _sst(S, len)
	local pos = S.index + len
	local str = string.sub(S.source, S.index, pos - 1)

	S.index = pos
	return str
end

-- string _sls(Stream S)
-- @S - Stream object to read from
local function _sls(S)
	local len = S:s_szt()
	local str

	if len ~= 0 then str = string.sub(_sst(S, len), 1, -2) end

	return str
end

-- fn _cir(string src, int len, fn func)
-- @len - Length of type for reader
-- @func - Reader callback
local function _cir(len, func)
	return function(S)
		local pos = S.index + len
		local int = func(S.source, S.index, pos)
		S.index = pos

		return int
	end
end

-- fn _cfr(string src, int len, fn func)
-- @len - Length of type for reader
-- @func - Reader callback
local function _cfr(len, func)
	return function(S)
		local flt = func(S.source, S.index)
		S.index = S.index + len

		return flt
	end
end

local function _sil(S)
	local len = S:s_int()
	local list = table.create(len)

	for i = 1, len do
		local ins = S:s_ins()
		local op = bit.band(ins, 0x3F)
		local args = _otp[op]
		local mode = _omd[op]
		local data = {value = ins, op = _orm[op], A = bit.band(bit.rshift(ins, 6), 0xFF)}

		if args == 'ABC' then
			data.B = bit.band(bit.rshift(ins, 23), 0x1FF)
			data.C = bit.band(bit.rshift(ins, 14), 0x1FF)
			data.is_KB = mode.b == 'OpArgK' and data.B > 0xFF -- post process optimization
			data.is_KC = mode.c == 'OpArgK' and data.C > 0xFF

			if op == 10 then -- decode NEWTABLE array size, store it as constant value
				local e = bit.band(bit.rshift(data.B, 3), 31)
				data.const_B = e == 0 and data.B or bit.lshift(bit.band(data.B, 7) + 8, e - 1)

				if _VERSION ~= "Luau" then -- Don't decode hash size for Luau
					local e = bit.band(bit.rshift(data.C, 3), 31)
					data.const_C = e == 0 and data.C or bit.lshift(bit.band(data.C, 7) + 8, e - 1)
				end
			end
		elseif args == 'ABx' then
			data.Bx = bit.band(bit.rshift(ins, 14), 0x3FFFF)
			data.is_K = mode.b == 'OpArgK'
		elseif args == 'AsBx' then
			data.sBx = bit.band(bit.rshift(ins, 14), 0x3FFFF) - 131071
		end

		list[i] = data
	end

	return list
end

local function _scl(S)
	local len = S:s_int()
	local list = table.create(len)

	for i = 1, len do
		local tt = _sby(S)
		local k

		if tt == 1 then
			k = _sby(S) ~= 0
		elseif tt == 3 then
			k = S:s_num()
		elseif tt == 4 then
			k = _sls(S)
		end

		list[i] = k -- offset +1 during instruction decode
	end

	return list
end

local function _ssl(S, src)
	local len = S:s_int()
	local list = table.create(len)

	for i = 1, len do
		list[i] = _slf(S, src) -- offset +1 in CLOSURE
	end

	return list
end

local function _sll(S)
	local len = S:s_int()
	local list = table.create(len)

	for i = 1, len do list[i] = S:s_int() end

	return list
end

local function _slc(S)
	local len = S:s_int()
	local list = table.create(len)

	for i = 1, len do list[i] = {varname = _sls(S), startpc = S:s_int(), endpc = S:s_int()} end

	return list
end

local function _svl(S)
	local len = S:s_int()
	local list = table.create(len)

	for i = 1, len do list[i] = _sls(S) end

	return list
end

function _slf(S, psrc)
	local proto = {}
	local src = _sls(S) or psrc -- source is propagated

	proto.source = src -- source name

	S:s_int() -- line defined
	S:s_int() -- last line defined

	proto.num_upval = _sby(S) -- num upvalues
	proto.num_param = _sby(S) -- num params

	proto.is_vararg = _sby(S) -- vararg flag
	proto.max_stack = _sby(S) -- max stack size

	proto.code = _sil(S)
	proto.const = _scl(S)
	proto.subs = _ssl(S, src)
	proto.lines = _sll(S)

	_slc(S)
	_svl(S)

	-- post process optimization
	proto.needs_arg = bit.band(proto.is_vararg, 0x5) == 0x5
	for _, v in ipairs(proto.code) do
		if v.is_K then
			v.const = proto.const[v.Bx + 1] -- offset for 1 based index
		else
			if v.is_KB then v.const_B = proto.const[v.B - 0xFF] end

			if v.is_KC then v.const_C = proto.const[v.C - 0xFF] end
		end
	end

	return proto
end

function _dec(src)
	-- func reader
	local rdr_func

	-- header flags
	local little
	local size_int
	local size_szt
	local size_ins
	local size_num
	local flag_int

	-- stream object
	local stream = {
		-- data
		index = 1,
		source = src,
	}

	assert(_sst(stream, 4) == '\27Lua', 'invalid Lua signature')
	assert(_sby(stream) == 0x51, 'invalid Lua version')
	assert(_sby(stream) == 0, 'invalid Lua format')

	little = _sby(stream) ~= 0
	size_int = _sby(stream)
	size_szt = _sby(stream)
	size_ins = _sby(stream)
	size_num = _sby(stream)
	flag_int = _sby(stream) ~= 0

	rdr_func = little and _ri_le or _ri_be
	stream.s_int = _cir(size_int, rdr_func)
	stream.s_szt = _cir(size_szt, rdr_func)
	stream.s_ins = _cir(size_ins, rdr_func)

	if flag_int then
		stream.s_num = _cir(size_num, rdr_func)
	elseif _fty[size_num] then
		stream.s_num = _cfr(size_num, _fty[size_num][little and 'little' or 'big'])
	else
		error('unsupported float size')
	end

	return _slf(stream, '@virtual')
end

local function _clz(list, index)
	for i, uv in pairs(list) do
		if uv.index >= index then
			uv.value = uv.store[uv.index] -- store value
			uv.store = uv
			uv.index = 'value' -- self reference
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

local function _oer(failed, err)
	local src = failed.source
	local line = failed.lines[failed.pc - 1]

	error(string.format('%s:%i: %s', src, line, err), 0)
end

local function _nvm(state, env, upvals)
	local code = state.code
	local subs = state.subs
	local vararg = state.vararg

	local top_index = -1
	local open_list = {}
	local memory = state.memory
	local pc = state.pc

	while true do
		local inst = code[pc]
		local op = inst.op
		pc = pc + 1

		if op < 18 then
			if op < 8 then
				if op < 3 then
					if op < 1 then
						--[[LOADNIL]]
						for i = inst.A, inst.B do memory[i] = nil end
					elseif op > 1 then
						--[[GETUPVAL]]
						local uv = upvals[inst.B]

						memory[inst.A] = uv.store[uv.index]
					else
						--[[ADD]]
						local lhs, rhs

						if inst.is_KB then
							lhs = inst.const_B
						else
							lhs = memory[inst.B]
						end

						if inst.is_KC then
							rhs = inst.const_C
						else
							rhs = memory[inst.C]
						end

						memory[inst.A] = lhs + rhs
					end
				elseif op > 3 then
					if op < 6 then
						if op > 4 then
							--[[SELF]]
							local A = inst.A
							local B = inst.B
							local index

							if inst.is_KC then
								index = inst.const_C
							else
								index = memory[inst.C]
							end

							memory[A + 1] = memory[B]
							memory[A] = memory[B][index]
						else
							--[[GETGLOBAL]]
							memory[inst.A] = env[inst.const]
						end
					elseif op > 6 then
						--[[GETTABLE]]
						local index

						if inst.is_KC then
							index = inst.const_C
						else
							index = memory[inst.C]
						end

						memory[inst.A] = memory[inst.B][index]
					else
						--[[SUB]]
						local lhs, rhs

						if inst.is_KB then
							lhs = inst.const_B
						else
							lhs = memory[inst.B]
						end

						if inst.is_KC then
							rhs = inst.const_C
						else
							rhs = memory[inst.C]
						end

						memory[inst.A] = lhs - rhs
					end
				else --[[MOVE]]
					memory[inst.A] = memory[inst.B]
				end
			elseif op > 8 then
				if op < 13 then
					if op < 10 then
						--[[SETGLOBAL]]
						env[inst.const] = memory[inst.A]
					elseif op > 10 then
						if op < 12 then
							--[[CALL]]
							local A = inst.A
							local B = inst.B
							local C = inst.C
							local params

							if B == 0 then
								params = top_index - A
							else
								params = B - 1
							end

							local ret_list = table.pack(memory[A](table.unpack(memory, A + 1, A + params)))
							local ret_num = ret_list.n

							if C == 0 then
								top_index = A + ret_num - 1
							else
								ret_num = C - 1
							end

							table.move(ret_list, 1, ret_num, A, memory)
						else
							--[[SETUPVAL]]
							local uv = upvals[inst.B]

							uv.store[uv.index] = memory[inst.A]
						end
					else
						--[[MUL]]
						local lhs, rhs

						if inst.is_KB then
							lhs = inst.const_B
						else
							lhs = memory[inst.B]
						end

						if inst.is_KC then
							rhs = inst.const_C
						else
							rhs = memory[inst.C]
						end

						memory[inst.A] = lhs * rhs
					end
				elseif op > 13 then
					if op < 16 then
						if op > 14 then
							--[[TAILCALL]]
							local A = inst.A
							local B = inst.B
							local params

							if B == 0 then
								params = top_index - A
							else
								params = B - 1
							end

							_clz(open_list, 0)

							return memory[A](table.unpack(memory, A + 1, A + params))
						else
							--[[SETTABLE]]
							local index, value

							if inst.is_KB then
								index = inst.const_B
							else
								index = memory[inst.B]
							end

							if inst.is_KC then
								value = inst.const_C
							else
								value = memory[inst.C]
							end

							memory[inst.A][index] = value
						end
					elseif op > 16 then
						--[[NEWTABLE]]
						memory[inst.A] = table.create(inst.const_B, inst.const_C) -- b and c registers contain array and hash size
					else
						--[[DIV]]
						local lhs, rhs

						if inst.is_KB then
							lhs = inst.const_B
						else
							lhs = memory[inst.B]
						end

						if inst.is_KC then
							rhs = inst.const_C
						else
							rhs = memory[inst.C]
						end

						memory[inst.A] = lhs / rhs
					end
				else
					--[[LOADK]]
					memory[inst.A] = inst.const
				end
			else
				--[[FORLOOP]]
				local A = inst.A
				local step = memory[A + 2]
				local index = memory[A] + step
				local limit = memory[A + 1]
				local loops

				if step >= 0 then
					loops = index <= limit
				else
					loops = index >= limit
				end

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
						--[[LEN]]
						memory[inst.A] = #memory[inst.B]
					elseif op > 20 then
						if op < 22 then
							--[[RETURN]]
							local A = inst.A
							local B = inst.B
							local len

							if B == 0 then
								len = top_index - A + 1
							else
								len = B - 1
							end

							_clz(open_list, 0)

							return table.unpack(memory, A, A + len - 1)
						else
							--[[CONCAT]]
							local B, C = inst.B, inst.C
							local success, str = pcall(table.concat, memory, "", B, C)

							if not success then
								str = memory[B]

								for i = B + 1, C do str = str .. memory[i] end
							end

							memory[inst.A] = str
						end
					else
						--[[MOD]]
						local lhs, rhs

						if inst.is_KB then
							lhs = inst.const_B
						else
							lhs = memory[inst.B]
						end

						if inst.is_KC then
							rhs = inst.const_C
						else
							rhs = memory[inst.C]
						end

						memory[inst.A] = lhs % rhs
					end
				elseif op > 23 then
					if op < 26 then
						if op > 24 then
							--[[CLOSE]]
							_clz(open_list, inst.A)
						else
							--[[EQ]]
							local lhs, rhs

							if inst.is_KB then
								lhs = inst.const_B
							else
								lhs = memory[inst.B]
							end

							if inst.is_KC then
								rhs = inst.const_C
							else
								rhs = memory[inst.C]
							end

							if (lhs == rhs) == (inst.A ~= 0) then pc = pc + code[pc].sBx end

							pc = pc + 1
						end
					elseif op > 26 then
						--[[LT]]
						local lhs, rhs

						if inst.is_KB then
							lhs = inst.const_B
						else
							lhs = memory[inst.B]
						end

						if inst.is_KC then
							rhs = inst.const_C
						else
							rhs = memory[inst.C]
						end

						if (lhs < rhs) == (inst.A ~= 0) then pc = pc + code[pc].sBx end

						pc = pc + 1
					else
						--[[POW]]
						local lhs, rhs

						if inst.is_KB then
							lhs = inst.const_B
						else
							lhs = memory[inst.B]
						end

						if inst.is_KC then
							rhs = inst.const_C
						else
							rhs = memory[inst.C]
						end

						memory[inst.A] = lhs ^ rhs
					end
				else
					--[[LOADBOOL]]
					memory[inst.A] = inst.B ~= 0

					if inst.C ~= 0 then pc = pc + 1 end
				end
			elseif op > 28 then
				if op < 33 then
					if op < 30 then
						--[[LE]]
						local lhs, rhs

						if inst.is_KB then
							lhs = inst.const_B
						else
							lhs = memory[inst.B]
						end

						if inst.is_KC then
							rhs = inst.const_C
						else
							rhs = memory[inst.C]
						end

						if (lhs <= rhs) == (inst.A ~= 0) then pc = pc + code[pc].sBx end

						pc = pc + 1
					elseif op > 30 then
						if op < 32 then
							--[[CLOSURE]]
							local sub = subs[inst.Bx + 1] -- offset for 1 based index
							local nups = sub.num_upval
							local uvlist

							if nups ~= 0 then
								uvlist = table.create(nups - 1)

								for i = 1, nups do
									local pseudo = code[pc + i - 1]

									if pseudo.op == _orm[0] then -- @MOVE
										uvlist[i - 1] = _opn(open_list, pseudo.B, memory)
									elseif pseudo.op == _orm[4] then -- @GETUPVAL
										uvlist[i - 1] = upvals[pseudo.B]
									end
								end

								pc = pc + nups
							end

							memory[inst.A] = _wra(sub, env, uvlist)
						else
							--[[TESTSET]]
							local A = inst.A
							local B = inst.B

							if (not memory[B]) ~= (inst.C ~= 0) then
								memory[A] = memory[B]
								pc = pc + code[pc].sBx
							end
							pc = pc + 1
						end
					else
						--[[UNM]]
						memory[inst.A] = -memory[inst.B]
					end
				elseif op > 33 then
					if op < 36 then
						if op > 34 then
							--[[VARARG]]
							local A = inst.A
							local len = inst.B

							if len == 0 then
								len = vararg.len
								top_index = A + len - 1
							end

							table.move(vararg.list, 1, len, A, memory)
						else
							--[[FORPREP]]
							local A = inst.A
							local init, limit, step

							init = assert(tonumber(memory[A]), '`for` initial value must be a number')
							limit = assert(tonumber(memory[A + 1]), '`for` limit must be a number')
							step = assert(tonumber(memory[A + 2]), '`for` step must be a number')

							memory[A] = init - step
							memory[A + 1] = limit
							memory[A + 2] = step

							pc = pc + inst.sBx
						end
					elseif op > 36 then
						--[[SETLIST]]
						local A = inst.A
						local C = inst.C
						local len = inst.B
						local tab = memory[A]
						local offset

						if len == 0 then len = top_index - A end

						if C == 0 then
							C = inst[pc].value
							pc = pc + 1
						end

						offset = (C - 1) * FIELDS_PER_FLUSH

						table.move(memory, A + 1, A + len, offset + 1, tab)
					else
						--[[NOT]]
						memory[inst.A] = not memory[inst.B]
					end
				else
					--[[TEST]]
					if (not memory[inst.A]) ~= (inst.C ~= 0) then pc = pc + code[pc].sBx end
					pc = pc + 1
				end
			else
				--[[TFORLOOP]]
				local A = inst.A
				local base = A + 3

				local vals = {memory[A](memory[A + 1], memory[A + 2])}

				table.move(vals, 1, inst.C, base, memory)

				if memory[base] ~= nil then
					memory[A + 2] = memory[base]
					pc = pc + code[pc].sBx
				end

				pc = pc + 1
			end
		else
			--[[JMP]]
			pc = pc + inst.sBx
		end

		state.pc = pc
	end
end

function _wra(proto, env, upval)
	local function wrapped(...)
		local passed = table.pack(...)
		local memory = table.create(proto.max_stack)
		local vararg = {len = 0, list = {}}

		table.move(passed, 1, proto.num_param, 0, memory)

		if proto.num_param < passed.n then
			local start = proto.num_param + 1
			local len = passed.n - proto.num_param

			vararg.len = len
			table.move(passed, start, start + len - 1, 1, vararg.list)
		end

		if proto.needs_arg then
			memory[proto.num_param] = {n = vararg.len, table.unpack(vararg.list, 1, vararg.len)}
		end

		local state = {vararg = vararg, memory = memory, code = proto.code, subs = proto.subs, pc = 1}

		local result = table.pack(pcall(_nvm, state, env, upval))

		if result[1] then
			return table.unpack(result, 2, result.n)
		else
			local failed = {pc = state.pc, source = proto.source, lines = proto.lines}

			_oer(failed, result[2])

			return
		end
	end

	return wrapped
end

-- one-shot: bytecode -> callable
local function _ld(bc, env)
	return _wra(_dec(bc), env)
end

return {
	-- Luath API
	version = '1.0.0',
	read = _dec, -- bytecode string -> proto state
	wrap = _wra, -- proto state -> lua function
	load = _ld, -- bytecode string -> lua function (read + wrap in one step)

	-- legacy aliases kept for drop-in compatibility with FiOne
	bc_to_state = _dec,
	wrap_state = _wra,
	OPCODE_RM = _orm,
	OPCODE_T = _otp,
	OPCODE_M = _omd,
}
