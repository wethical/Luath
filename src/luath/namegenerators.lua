-- This Script is Part of the Luath Obfuscator by Luath contributors
--
-- namegenerators.lua
--
-- This Script provides a collection of name generators for Luath.

return {
	Mangled = require("luath.namegenerators.mangled");
	MangledShuffled = require("luath.namegenerators.mangled_shuffled");
	Il = require("luath.namegenerators.Il");
	Number = require("luath.namegenerators.number");
	Confuse = require("luath.namegenerators.confuse");
}