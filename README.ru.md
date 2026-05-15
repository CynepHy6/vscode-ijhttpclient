# ijhttp Client

[English version](README.md)

Расширение для VS Code/Cursor для работы с `.http`-файлами JetBrains HTTP Client.

Выполнение запросов полностью делегируется установленному CLI `ijhttp`. Собственного HTTP-рантайма в расширении нет.

## Важно

Запуск работает только если `ijhttp` установлен в системе и доступен через `PATH`, либо путь к бинарнику задан в `ijhttp-client.ijhttpPath`.

Без `ijhttp` расширение всё равно даёт:

- подсветку синтаксиса
- базовую диагностику синтаксиса
- определение request-блоков
- CodeLens для запускаемых request-блоков

## Возможности

- подсветка `.http`-файлов
- определение request-блоков, разделённых `###`
- запуск текущего request-блока через системный `ijhttp`
- автопоиск `http-client.env.json` и `http-client.private.env.json`
- поддержка типовых конструкций JetBrains HTTP Client: `# @name`, `{{variables}}`, pre-request scripts и response-handler scripts
- сохранение `body` ответа в локальный каталог `.response/` и добавление под выполненным запросом history-комментариев вида `# <> ./.response/...`

## Использование

```http
### ping
GET https://example.com/api/ping
Accept: application/json
```

Текущий request-блок можно запустить через:

- CodeLens `Run with ijhttp`
- команду `ijhttp Client: Run Current Request`
- shortcut `Ctrl+Alt+R` / `Cmd+Alt+R`

## Настройки

- `ijhttp-client.ijhttpPath`
- `ijhttp-client.environment`
- `ijhttp-client.envFile`
- `ijhttp-client.privateEnvFile`
- `ijhttp-client.logLevel`
- `ijhttp-client.enableRunCodeLens`

## Основано На

Проект сделан на основе [Huachao/vscode-restclient](https://github.com/Huachao/vscode-restclient) и адаптирован под workflow только с `ijhttp`.
