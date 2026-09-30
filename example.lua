local env = getfenv(0)
local luath = require('luath')

-- Luath API (FiOne-compatible drop-in)
--   read(bc)  -> proto state
--   wrap(proto, env) -> lua function
--   load(bc, env) -> lua function (read + wrap in one step)

local function run(fn, ...)
	local bc = string.dump(fn)
	local wrapped = luath.load(bc, env)

	return wrapped(...)
end

print(run(function(num)
	local ans = 0

	for i = 1, num do ans = ans + i end

	return ans
end, 100))

print(run(function(a, b) return a * b + 7 end, 6, 9))

-- recursion via a global helper (no upvalues in dumped bytecode)
_G.__luath_fib = _G.__luath_fib or function(n)
	if n < 2 then return n end

	return _G.__luath_fib(n - 1) + _G.__luath_fib(n - 2)
end

print(run(function(n) return _G.__luath_fib(n) end, 15))