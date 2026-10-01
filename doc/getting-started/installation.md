# Installation

## Linux and macOS (recommended)

Install latest release:

```bash
curl -fsSL https://raw.githubusercontent.com/luath-lua/Luath/master/install.sh | sh
```

Verify installation:

```bash
luath-lua --version
```

Update later:

```bash
luath-lua update
```

The release bundle includes a Lua runtime (`runtime/lua`), so you do not need a separate Lua install for packaged CLI usage.

## From source

```bash
git clone https://github.com/luath-lua/Luath.git
cd Luath
lua ./cli.lua --version
```

Then run obfuscation:

```bash
lua ./cli.lua --preset Medium ./your_file.lua
```

For source usage, Luath expects a Lua runtime (LuaJIT, `lua5.1`, or `lua`).
