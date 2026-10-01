---
description: Luath is a Lua obfuscator written in pure Lua.
---

# Luath Documentation

Luath obfuscates Lua source code using AST transforms and a configurable pipeline.

Use the [Luath Playground](https://luath-lua.github.io/Luath/) to quickly try out settings and test small snippets. For larger scripts and advanced workflows, use the CLI (`luath-lua` or `cli.lua`).

This documentation covers:

- CLI usage (`luath-lua` and `cli.lua`)
- configuration and presets
- all built-in obfuscation steps
- embedding Luath as a library

## Who this is for

- Lua developers shipping scripts where source readability is a concern
- users integrating Luath in build pipelines
- developers embedding Luath into another Lua application

## Supported language targets

- Lua 5.1 (`Lua51`)
- LuaU (`LuaU`)

## Read in this order

1. Installation
2. Quickstart
3. CLI Usage
4. Presets
5. Custom Config
6. Step Reference
