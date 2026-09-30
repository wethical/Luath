# Luath

A fast, dependency-free Lua 5.1 **bytecode interpreter** that lets you execute compiled Lua 5.1 code in environments where `load` / `loadstring` are unavailable or restricted — useful for sandboxing, custom VMs, and reimplementing arbitrary execution.

Luath is a reworked, rebranded fork of [FiOne](https://github.com/SovereignSatellite/FiOne) (GPL-3.0). The interpreter core keeps compatibility with FiOne's public API and adds a convenient one-shot `load` entry point, a pure-Lua `bit` shim (so it runs even on stock Lua 5.1 with no bit library), and an internal identifier remap.

## Features

- Parses standard Lua 5.1 bytecode (`\27Lua` + `0x51` header), little / big endian, int/float/double number modes.
- Executes bytecode without `load` / `loadstring` — a self-contained interpreter loop.
- Works on Lua 5.1, LuaJIT (bit or bit32), Luau, and any host exposing `table.pack`/`unpack`/`move`/`create`.
- No external dependencies; pure Lua.
- One-shot API: `luath.load(bc, env)`.

## Usage

```lua
local luath = require('luath')
local env = getfenv(0)

-- one-shot: bytecode -> callable
local fn = luath.load(string.dump(function(a, b) return a + b end), env)

print(fn(2, 3)) -- 5

-- manual two-step (parse once, wrap many)
local state = luath.read(string.dump(function() return 'hi' end))
local wrapped = luath.wrap(state, env)
print(wrapped()) -- hi
```

## API

| Member | Description |
| --- | --- |
| `luath.read(bc)` | Parse a Lua 5.1 bytecode string into a proto state. |
| `luath.wrap(state, env)` | Turn a proto state into a callable Lua function. |
| `luath.load(bc, env)` | `read` + `wrap` in one step. |
| `luath.bc_to_state` | Legacy alias of `read` (FiOne-compatible). |
| `luath.wrap_state` | Legacy alias of `wrap` (FiOne-compatible). |
| `luath.version` | Version string. |

Compiled code must be produced by an external Lua 5.1 compiler (`luac5.1 -s`, `string.dump`, etc.).

## Layout

- `luath.lua` — the interpreter (single file).
- `example.lua` — runnable usage example (`lua example.lua`).
- `gen/luath_gen_template.lua` — per-opcode snippet templates.
- `gen/luath_gen_search.lua` — regenerates the binary-search dispatch tree (`luath_bin_tree.lua`).
- `tests/run_tests.lua` — end-to-end tests comparing native vs interpreted execution.

## License

GPL-3.0. See [LICENSE](LICENSE).
FiOne: Copyright (C) 2021 Rerumu. Luath modifications: Copyright (C) 2026 Luath contributors.