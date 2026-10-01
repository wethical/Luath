import { describe, expect, it } from "vitest"

import { PRESETS, type PresetName } from "@/lib/luathTypes"
import { runLuath } from "./luathRunner"

function options(preset: PresetName) {
  return {
    source: 'print("Hello, World!")',
    filename: "hello.lua",
    preset,
    luaVersion: "Lua51" as const,
    prettyPrint: false,
    seed: 12345,
  }
}

describe("runLuath", () => {
  it("obfuscates a simple script with Minify", async () => {
    const result = await runLuath(options("Minify"))

    if (!result.ok) {
      throw new Error(result.error)
    }
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.output.length).toBeGreaterThan(0)
      expect(result.logs.length).toBeGreaterThan(0)
    }
  }, 30000)

  it("obfuscates a simple script with Medium", async () => {
    const result = await runLuath(options("Medium"))

    if (!result.ok) {
      throw new Error(result.error)
    }
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.output.length).toBeGreaterThan(0)
      expect(result.logs.length).toBeGreaterThan(0)
    }
  }, 30000)

  it.each(PRESETS)("smoke tests the %s preset", async (preset) => {
    const result = await runLuath(options(preset))

    if (!result.ok) {
      throw new Error(result.error)
    }
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.output).not.toHaveLength(0)
    }
  }, 30000)
})
