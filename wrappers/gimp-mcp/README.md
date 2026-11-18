# @editmamei/gimp-mcp

An MCP server that lets your AI app edit photos in GIMP 3.2 on your computer, with live filters and layers you can keep editing.

This package starts [Editmamei](https://github.com/editmamei/editmamei) with its GIMP tools. It depends on the exact `editmamei` release it was published with, so `npx` always runs a matching pair.

## Use it

Add this server to any MCP app that runs local servers:

```json
{
  "mcpServers": {
    "editmamei": { "command": "npx", "args": ["-y", "@editmamei/gimp-mcp"] }
  }
}
```

Restart the app and ask: _"Is GIMP connected?"_ Editmamei runs GIMP in the background, so it doesn't need to be open.

## Requirements

- Node.js 22 or later
- GIMP 3.2 or later on Windows, macOS or Linux

## Same server, one editor

It is the same server as `npx -y editmamei`, with the `EDITMAMEI_EDITOR` variable set to `gimp`, so only the GIMP tools register. To use Photoshop as well, run `editmamei` instead, or set `EDITMAMEI_EDITOR` yourself in the server's `env`.

Settings, telemetry and the privacy details are the same as for `editmamei`. See the [GIMP guide](https://github.com/editmamei/editmamei/blob/main/docs/gimp.md), and [privacy.md](https://github.com/editmamei/editmamei/blob/main/docs/privacy.md) for every network request the server makes.

## License

[FSL-1.1-MIT](https://github.com/editmamei/editmamei/blob/main/LICENSE.md).
