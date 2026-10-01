# Quickstart: First Obfuscation

You can quickly try Luath in the [Luath Playground](https://luath-lua.github.io/Luath/). For large scripts or advanced use cases, prefer the CLI workflow below.

Create a simple Lua file:

```lua
print("Hello, World")
```

Run Luath from the repository root:

```bash
lua ./cli.lua --preset Medium ./hello.lua
```

Luath will write:

- `hello.obfuscated.lua` (default output path)

Run the result with your Lua runtime to validate behavior.

## Important default behavior

- If you do not pass `--preset` or `--config`, Luath uses `Minify`.
- `Minify` performs minification only (no obfuscation steps).

## Choosing a preset quickly

- `Weak`: low overhead
- `Medium`: practical default
- `Strong`: strongest built-in preset, highest overhead
