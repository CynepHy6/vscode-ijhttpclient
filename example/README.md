# Example Files

[Русская версия](README.ru.md)

This directory contains small `.http` examples for the current `ijhttp Client` extension.

When you run requests from the extension, it can also create a local `.response/` directory with saved `*.response` full response dumps and append history comments like `# <> ./.response/...` below executed requests.

- `basic/basic-demo.http`:
  basic GET/POST requests, named requests, response-handler tests, local environment file.
- `environments/environment-picker.http`:
  public and private environment files, variables from environments, useful for testing remembered environment selection in the extension UI.
- `queries/query-variables.http`:
  file variables, request separator, split query string lines, response-handler test.
- `scripts/scripts-demo.http`:
  pre-request script, request variables, response-handler test.
- `file-body/file-body-demo.http`:
  request body loaded from a local JSON file.
- `multipart/multipart-demo.http`:
  multipart form-data request with a local file.
- `redirect/redirect-demo.http`:
  response redirection with `>>!`.
