-- This Script is Part of the Luath Obfuscator by Luath contributors
--
-- steps.lua
--
-- This Script provides a collection of obfuscation steps.

return {
	WrapInFunction = require("luath.steps.WrapInFunction"),
	SplitStrings = require("luath.steps.SplitStrings"),
	Vmify = require("luath.steps.Vmify"),
	ConstantArray = require("luath.steps.ConstantArray"),
	ProxifyLocals = require("luath.steps.ProxifyLocals"),
	AntiTamper = require("luath.steps.AntiTamper"),
	EncryptStrings = require("luath.steps.EncryptStrings"),
	NumbersToExpressions = require("luath.steps.NumbersToExpressions"),
	AddVararg = require("luath.steps.AddVararg"),
	WatermarkCheck = require("luath.steps.WatermarkCheck"),
}