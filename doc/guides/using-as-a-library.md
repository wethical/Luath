# Using Luath as a Library

Luath can be required directly from Lua.

## In this repository

```lua
local Luath = require("src.luath")

local code = 'print("Hello")'
local pipeline = Luath.Pipeline:fromConfig(Luath.Presets.Medium)
local out = pipeline:apply(code, "inline-source.lua")
print(out)
```

## Integration in another project

Copy the `src/` tree and make sure `require` can resolve `src.luath` (or adapt your `package.path` to where `luath.lua` is located).

## Useful runtime controls

Disable noisy logs:

```lua
Luath.Logger.logLevel = Luath.Logger.LogLevel.Error
```

Enable syntax highlighting in unparser output:

```lua
local pipeline = Luath.Pipeline:new({
  LuaVersion = "Lua51",
  PrettyPrint = false,
  Highlight = true,
})
```

## Notes

- `pipeline:apply` expects source code text.
- If `apply` is called with no filename, logs use `Anonymous Script`.
