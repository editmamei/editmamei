# @editmamei/photoshop-mcp

An MCP server that lets your AI app edit photos in Adobe Photoshop on your computer, in layers and masks you can keep editing.

This package starts [Editmamei](https://github.com/editmamei/editmamei) with its Photoshop tools. It depends on the exact `editmamei` release it was published with, so `npx` always runs a matching pair.

## Use it

Add this server to any MCP app that runs local servers:

```json
{
  "mcpServers": {
    "editmamei": { "command": "npx", "args": ["-y", "@editmamei/photoshop-mcp"] }
  }
}
```

Restart the app, open Photoshop, and ask: _"Is Photoshop connected?"_

## Requirements

- Node.js 22 or later
- Adobe Photoshop 2026 (v27.x) on Windows 10/11 or macOS 13+

## Same server, one editor

It is the same server as `npx -y editmamei`, with the `EDITMAMEI_EDITOR` variable set to `photoshop`, so only the Photoshop tools register. That keeps the tool list short for apps that cap it. To use GIMP as well, run `editmamei` instead, or set `EDITMAMEI_EDITOR` yourself in the server's `env`.

Settings, telemetry and the privacy details are the same as for `editmamei`. See the [documentation](https://github.com/editmamei/editmamei/tree/main/docs), and [privacy.md](https://github.com/editmamei/editmamei/blob/main/docs/privacy.md) for every network request the server makes.

## License

[FSL-1.1-MIT](https://github.com/editmamei/editmamei/blob/main/LICENSE.md). Independent project, not affiliated with or endorsed by Adobe Inc.
