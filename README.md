# ijhttp Client

[Русская версия](README.ru.md)

VS Code/Cursor extension for JetBrains HTTP Client `.http` files.

Request execution is delegated to the installed `ijhttp` CLI. The extension does not contain its own HTTP runtime.

## Important

Execution works only when `ijhttp` is installed in the system and available in `PATH`, or when the binary path is configured via `ijhttp-client.ijhttpPath`.

Without `ijhttp`, the extension still provides:

- syntax highlighting
- basic syntax diagnostics
- request block detection
- CodeLens for runnable request blocks

## Features

- highlights `.http` files
- detects request blocks separated by `###`
- runs the current request block through system `ijhttp`
- runs all request blocks from the current file through system `ijhttp`
- auto-discovers `http-client.env.json` and `http-client.private.env.json`
- supports common JetBrains HTTP Client constructs such as `# @name`, `{{variables}}`, pre-request scripts, and response-handler scripts
- saves full HTTP response dumps as `*.response` files in a local `.response/` folder and appends history comments like `# <> ./.response/...` below executed requests

## Usage

```http
### ping
GET https://example.com/api/ping
Accept: application/json
```

Run the current request block with:

- CodeLens `Run with ijhttp`
- command `ijhttp Client: Run Current Request`
- shortcut `Ctrl+Alt+R` / `Cmd+Alt+R`

Run all request blocks from the current file with:

- top-of-file CodeLens `Run all with ijhttp`
- command `ijhttp Client: Run All Requests in File`
- editor context menu action `Run All Requests in File`

## Settings

- `ijhttp-client.ijhttpPath`
- `ijhttp-client.environment`
- `ijhttp-client.envFile`
- `ijhttp-client.privateEnvFile`
- `ijhttp-client.logLevel`
- `ijhttp-client.enableRunCodeLens`

## Based On

This project is based on [Huachao/vscode-restclient](https://github.com/Huachao/vscode-restclient) and was adapted for an `ijhttp`-only workflow.
