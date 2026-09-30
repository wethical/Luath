-- Luath end-to-end tests
-- Runs the interpreter against bytecode dumped by the host Lua 5.1 and
-- compares every result with the natively executed function.

local luath = require('luath')
local env = getfenv(0)

local passed = 0
local failed = 0

local function eq(a, b)
	if type(a) ~= type(b) then return false end

	if type(a) == 'table' then
		for k, v in pairs(a) do
			if not eq(v, b[k]) then return false end
		end

		for k in pairs(b) do
			if a[k] == nil then return false end
		end

		return true
	end

	return a == b
end

-- run fn natively and through Luath, compare results
local function clone(v)
	if type(v) ~= 'table' then return v end

	local t = {}

	for k, x in pairs(v) do t[k] = clone(x) end

	return t
end

local function check(name, fn, ...)
	local args = table.pack(...)

	-- deep-copy table args so both executions start from identical state
	local args2 = table.pack(...)

	for i = 1, args2.n do args2[i] = clone(args2[i]) end

	local native_ok, native_res = pcall(fn, table.unpack(args, 1, args.n))
	local luath_ok, luath_res

	-- only dump when the function is dumpable (no upvalues at top level)
	local ok, dumped = pcall(string.dump, fn)

	if ok then
		local wrapped = luath.load(dumped, env)
		luath_ok, luath_res = pcall(wrapped, table.unpack(args2, 1, args2.n))
	end

	local same_success = (native_ok == luath_ok)

	if dumped and not ok then
		print(('[FAIL] %s (host cannot dump)'):format(name))
		failed = failed + 1

		return
	end

	if same_success and (not native_ok or eq(native_res, luath_res)) then
		passed = passed + 1
		print(('[ OK ] %s -> %s'):format(name, tostring(native_res)))
	else
		failed = failed + 1
		print(('[FAIL] %s (native=%s%s, luath=%s%s)'):format(name, tostring(native_ok), tostring(native_res), tostring(luath_ok), tostring(luath_res)))
	end
end

-- numbers / arithmetic
check('add', function(a, b) return a + b end, 4, 9)
check('sub', function(a, b) return a - b end, 20, 35)
check('mul', function(a, b) return a * b end, 7, 6)
check('div', function(a, b) return a / b end, 42, 8)
check('mod', function(a, b) return a % b end, 17, 5)
check('pow', function(a, b) return a ^ b end, 3, 4)
check('unary', function(a) return -a end, 123)
check('mixed', function(a, b, c) return (a + b) * c - a / b end, 10, 3, 7)

-- comparisons / logic
check('lt', function(a, b) return a < b end, 1, 2)
check('le', function(a, b) return a <= b end, 2, 2)
check('eq', function(a, b) return a == b end, 'x', 'x')
check('and_or', function(a, b) return a and b or 'none' end, nil, 5)
check('not', function(a) return not a end, nil)

-- strings
check('concat', function(a, b, c) return a .. b .. c end, 'foo', '-', 'bar')
check('strlen', function(s) return #s end, 'hello')
check('format', function(n) return string.format('%0.2f', n) end, 3.14159)
check('sub', function(s) return string.sub(s, 2, 4) end, 'abcdef')
check('gsub', function(s) return string.gsub(s, 'o', '0') end, 'foo bar')

-- loops
check('for_num', function(n)
	local s = 0

	for i = 1, n do s = s + i end

	return s
end, 100)
check('for_step', function()
	local s = 0

	for i = 10, 1, -2 do s = s + i end

	return s
end)
check('while_loop', function(n)
	local s, i = 0, 0

	while i < n do i = i + 1 s = s + i end

	return s
end, 10)
check('repeat_loop', function(n)
	local x = 0

	repeat x = x + 1 until x >= n

	return x
end, 7)

-- generic for (TFORLOOP)
check('ipairs_sum', function(t)
	local s = 0

	for _, v in ipairs(t) do s = s + v end

	return s
end, {3, 1, 4, 1, 5, 9})
check('pairs_count', function(t)
	local n = 0

	for _ in pairs(t) do n = n + 1 end

	return n
end, {a = 1, b = 2, c = 3})

-- tables
check('table_ctor', function()
	return {1, 2, 3, x = 10, y = 20}
end)
check('table_index', function(t, k) return t[k] end, {a = 42}, 'a')
check('table_assign', function(t)
	t.new = t.new or 0
	t.new = t.new + 1

	return t.new
end, {})
check('nested_table', function()
	local t = {{1, 2}, {3, 4}}

	return t[1][2] + t[2][1]
end)
check('big_setlist', function()
	local t = {}

	for i = 1, 200 do t[i] = i * 2 end

	return t[200] + #t
end)
check('table_len', function(t) return #t end, {1, 2, 3, 4, 5})
check('table_insert', function(t)
	table.insert(t, 'end')

	return #t
end, {1, 2, 3})

-- closures capturing locals (CLOSURE + MOVE pseudo-instructions)
check('closure', function(n)
	local base = 100
	local function add(x) return base + x end

	return add(n)
end, 5)
check('closure_state', function(n)
	local count = 0

	for i = 1, n do
		local function inc() count = count + 1 end

		inc()
	end

	return count
end, 50)

-- varargs
check('vararg', function(...)
	local args = {...}

	return #args
end, 1, 2, 3, 4)
check('vararg_sum', function(...)
	local s = 0

	for i = 1, select('#', ...) do s = s + select(i, ...) end

	return s
end, 5, 6, 7)
check('multi_return', function()
	return 1, 2, 3
end)

-- method calls (SELF)
check('method', function(t, s) return t:method(s) end, {method = function(self, x) return self.tag .. x end, tag = 'T'}, '!')
check('colon_calls', function(s) return s:upper() .. s:lower() end, 'AbC')

-- error propagation (compare only success flag)
check('error_ok', function(n)
	if n < 0 then error('negative') end

	return n
end, 5)
check('error_raise', function(n)
	if n < 0 then error('negative') end

	return n
end, -1)

-- toString / tonumber
check('tostring', function(n) return tostring(n) end, 12.5)
check('tonumber', function(s) return tonumber(s) end, '3.14')

-- recursion inside a closure (CLOSURE + MOVE upvalue capture)
check('recursion', function(n)
	local function walk(x)
		if x == 0 then return 0 end

		return x + walk(x - 1)
	end

	return walk(n)
end, 8)

print(('----\n%d passed, %d failed'):format(passed, failed))
os.exit(failed == 0 and 0 or 1)