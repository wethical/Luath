import { describe, expect, it } from "vitest"

import { luaPathToModuleName } from "./luathLuaPlugin"

describe("luaPathToModuleName", () => {
  it.each([
    ["src/luath.lua", "luath"],
    ["src/presets.lua", "presets"],
    ["src/luath/pipeline.lua", "luath.pipeline"],
    ["src/luath/compiler/expressions/string.lua", "luath.compiler.expressions.string"],
  ])("maps %s to %s", (filePath, moduleName) => {
    expect(luaPathToModuleName(filePath)).toBe(moduleName)
  })
})
