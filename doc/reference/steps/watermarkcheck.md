# Step: WatermarkCheck

Constructor key: `WatermarkCheck`

Injects a runtime watermark check and appends a `Watermark` step internally.

## Settings

| Key | Type | Default |
| --- | --- | --- |
| `Content` | string | `"This Script is Part of the Luath Obfuscator by Luath contributors"` |

## Example

```lua
{
  Name = "WatermarkCheck",
  Settings = {
    Content = "my watermark",
  }
}
```

## Notes

- `Watermark` is not exported in the standard step registry, but `WatermarkCheck` uses it internally.
- On mismatch, the injected guard returns early.
