-- This Script is Part of the Luath Obfuscator by Luath contributors
--
-- cli.lua
--
-- This Script contains the Code for the Luath CLI

-- Configure package.path for requiring Luath
local function script_path()
	local str = debug.getinfo(2, "S").source:sub(2)
	return str:match("(.*[/%\\])") or "";
end
package.path = script_path() .. "?.lua;" .. package.path;
require("src.cli");