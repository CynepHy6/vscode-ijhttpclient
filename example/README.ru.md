# Примеры

[English version](README.md)

В этом каталоге лежат небольшие `.http`-примеры для текущего расширения `ijhttp Client`.

При запуске запросов из расширения рядом с `.http`-файлом также может появляться локальный каталог `.response/`, а под выполненным запросом будут добавляться history-комментарии вида `# <> ./.response/...`.

- `basic/basic-demo.http`:
  базовые GET/POST-запросы, именованные запросы, response-handler проверки, локальный env-файл.
- `environments/environment-picker.http`:
  публичный и приватный env-файлы, переменные из окружения, удобно для проверки выбора окружения и запоминания выбора в UI расширения.
- `queries/query-variables.http`:
  file variables, разделитель запросов, query string на нескольких строках, response-handler script.
- `scripts/scripts-demo.http`:
  pre-request script, request variables, response-handler script.
- `file-body/file-body-demo.http`:
  request body, загружаемый из локального JSON-файла.
- `multipart/multipart-demo.http`:
  multipart form-data запрос с локальным файлом.
- `redirect/redirect-demo.http`:
  сохранение ответа через `>>!`.
