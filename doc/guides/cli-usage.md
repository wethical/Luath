# CLI Usage

## Entry points

- packaged CLI: `luath-lua`
- source CLI: `lua ./cli.lua`

Both call the same CLI implementation (`src/cli.lua`).

## Basic usage

```bash
luath-lua --preset Medium ./input.lua
```

## Output file behavior

If `--out` is not provided:

- `input.lua` -> `input.obfuscated.lua`
- `input` -> `input.obfuscated.lua`

## Common workflows

Use a preset:

```bash
luath-lua --preset Strong ./src/main.lua
```

Use a custom config file:

```bash
luath-lua --config ./luath.config.lua ./src/main.lua
```

Force Lua target:

```bash
luath-lua --preset Medium --LuaU ./src/main.lua
```

Enable pretty output:

```bash
luath-lua --preset Minify --pretty ./src/main.lua
```

## Notes

- Unknown `--...` options are ignored with a warning.
- If no config/preset is passed, Luath falls back to `Minify`.
- `update` command uses the official installer script from GitHub.
