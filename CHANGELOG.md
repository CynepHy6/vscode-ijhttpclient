# Change Log

## 1.2.0 | 2026/06/09
- Added `# @prompt` support: extension asks for values before running a request.
- Prompted variables are passed to ijhttp via `-V` (URL/query) or `-P` (headers/cookies).
- Added pre-run validation for unresolved `{{variables}}` to block invalid requests before ijhttp starts.
- Added Ctrl+click links on response history comments like `# <> ./.response/...`; missing files are not linked and clicks are blocked with a warning.

## 1.1.9 | 2026/05/17
- Fixed placement of response history comments after request blocks.

## 1.1.7 | 2026/05/17
- Fixed formatting of response history comments.

## 1.1.6 | 2026/05/16
- Added unit tests.
- Comments are stripped from the request text sent to ijhttp.
- Added project code rules.

## 1.1.5 | 2026/05/16
- Changed saved response dump format to `*.response` files.

## 1.1.0 | 2026/05/16
- Added __Run All Requests in File__ command, CodeLens, and context menu action.

## 1.0.2 | 2026/05/16
- Fixed a leading comment line at the start of a file being treated as a syntax error.

## 1.0.1 | 2026/05/16
- Fixed bracket pair colors in `.http` files.

## 1.0.0 | 2026/05/15
- Initial release as __ijhttp Client__: reworked from vscode-restclient for an `ijhttp`-only workflow.
- Runs current request blocks through the system `ijhttp` CLI.
- Auto-discovers `http-client.env.json` and `http-client.private.env.json`.
- Supports JetBrains HTTP Client syntax: `# @name`, `{{variables}}`, pre-request scripts, response-handler scripts.
- Saves response dumps under `.response/` and appends history comments like `# <> ./.response/...`.
