-- This Script is Part of the Luath Obfuscator by Luath contributors
--
-- nil.lua
--
-- This Script contains the expression handler for the NilExpression.

local Ast = require("luath.ast");

return function(self, expression, funcDepth, numReturns)
    local scope = self.activeBlock.scope;
    local regs = {};
    for i = 1, numReturns do
        regs[i] = self:allocRegister();
        self:addStatement(self:setRegister(scope, regs[i], Ast.NilExpression()), {regs[i]}, {}, false);
    end
    return regs;
end;

