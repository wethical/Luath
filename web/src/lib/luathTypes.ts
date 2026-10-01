export const PRESETS = ["Minify", "Weak", "Medium", "Strong"] as const
export const LUA_VERSIONS = ["Lua51", "LuaU"] as const

export type PresetName = (typeof PRESETS)[number]
export type LuaVersion = (typeof LUA_VERSIONS)[number]
export type LogLevel = "info" | "warn" | "error" | "debug"

export interface LuathOptions {
  source: string
  filename: string
  preset: PresetName
  luaVersion: LuaVersion
  prettyPrint: boolean
  seed: number
}

export interface LuathLog {
  level: LogLevel
  message: string
}

export interface LuathSuccess {
  ok: true
  output: string
  logs: LuathLog[]
}

export interface LuathFailure {
  ok: false
  error: string
  logs: LuathLog[]
}

export type LuathResult = LuathSuccess | LuathFailure

export type WorkerRequest =
  | {
      id: number
      action: "obfuscate"
      options: LuathOptions
    }
  | {
      id: number
      action: "runScript"
      source: string
      filename: string
    }

export type WorkerResponse =
  | {
      id: number
      type: "result"
      result: LuathResult
    }
  | {
      id: number
      type: "log"
      log: LuathLog
    }
