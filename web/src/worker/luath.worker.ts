import type { WorkerRequest, WorkerResponse } from "@/lib/luathTypes"
type RunLuath = typeof import("./luathRunner")["runLuath"]
type RunLuaScript = typeof import("./luathRunner")["runLuaScript"]

let runLuath: RunLuath | null = null
let runLuaScript: RunLuaScript | null = null

async function loadRunner() {
  const module = await import("./luathRunner")
  runLuath ??= module.runLuath
  runLuaScript ??= module.runLuaScript
  return { runLuath, runLuaScript }
}

self.onmessage = async (event: MessageEvent<WorkerRequest>) => {
  const request = event.data

  const result = await loadRunner()
    .then(({ runLuath: doObfuscate, runLuaScript: doRun }) => {
      if (request.action === "obfuscate") {
        return doObfuscate(request.options)
      }

      return doRun(
        { source: request.source, filename: request.filename },
        (log) => {
          const logResponse: WorkerResponse = { id: request.id, type: "log", log }
          self.postMessage(logResponse)
        },
      )
    })
    .catch((error) => ({
      ok: false as const,
      error:
        error instanceof Error
          ? `${error.name}: ${error.message}${error.stack ? `\n${error.stack}` : ""}`
          : String(error),
      logs: [],
    }))

  const response: WorkerResponse = { id: request.id, type: "result", result }
  self.postMessage(response)
}
