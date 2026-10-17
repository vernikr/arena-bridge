<div align="center">
  <img src="docs/cover.png" alt="arena-bridge" width="100%">
</div>

<h1 align="center">arena-bridge</h1>

<p align="center"><b>Облачный ИИ-агент получает управление вашим компьютером — и только с вашего разрешения.</b></p>

<p align="center">
  <a href="https://www.npmjs.com/package/arena-bridge"><img src="https://img.shields.io/npm/v/arena-bridge.svg?style=flat-square" alt="npm"></a>
  <a href="https://www.npmjs.com/package/arena-bridge"><img src="https://img.shields.io/npm/dm/arena-bridge.svg?style=flat-square" alt="downloads"></a>
  <img src="https://img.shields.io/badge/license-MIT-blue.svg?style=flat-square" alt="license">
  <img src="https://img.shields.io/badge/node-%3E%3D18-green.svg?style=flat-square" alt="node">
  <img src="https://img.shields.io/badge/dependencies-0-brightgreen.svg?style=flat-square" alt="dependencies">
  <img src="https://img.shields.io/badge/tests-92%20passed-brightgreen.svg?style=flat-square" alt="tests">
</p>

<p align="center">
  <code>npm i -g arena-bridge</code> &nbsp;→&nbsp; <code>arena-bridge setup</code> &nbsp;→&nbsp; вставьте готовый промпт в чат с агентом
</p>

---

## Что это

Облачный агент (Arena.ai Agent Mode, Claude, Cursor, любой MCP-клиент) работает в песочнице
с выходом в интернет, но не имеет доступа к вашему компьютеру. `arena-bridge` — это маленький
HTTP-сервис на вашей машине: он слушает только localhost, выставляется наружу туннелем
(cloudflared / ngrok / Tailscale) и отдаёт агенту инструменты, которые вы ему разрешили:

* **файлы и шелл** — прочитать, найти, изменить, запустить;
* **Chrome** — свой браузер агента (headless или с окном) или ваш настоящий Chrome на порту 9222;
* **macOS-десктоп** — скриншоты, мышь, клавиатура, приложения (через Peekaboo);
* **процессы** — фоновые дев-серверы с чтением вывода.

Всё, что меняет состояние, проходит через гейт подтверждений, а каждое действие пишется в журнал.
Без вашего `arena-bridge approve` агент ничего не сделает. Наблюдать за машиной можно без
подтверждений, а работать «без вопросов» — внутри окна доверия, которое вы открываете сами.

---

## Быстрый старт

```bash
# 1. установить
npm i -g arena-bridge

# 2. один раз: создать конфиг, проверить машину, поднять API + туннель
arena-bridge setup --root ~/projects --root ~/Documents

# 3. скопировать блок «Paste this into the agent chat» и вставить его в чат с агентом
```

`setup` печатает готовый промпт и публичный URL. Дальше — просто говорите агенту задачу.

Нужен туннель? Поставьте `cloudflared` (`brew install cloudflared` или бинарник в `/usr/local/bin`).
Подойдёт и любой другой: `ngrok http 8787`, `tailscale funnel --bg 8787`.

### В фоне, чтобы не открывать терминал

```bash
arena-bridge service install   # launchd: стартует вместе с системой, URL всегда живой
arena-bridge url                # текущий публичный URL
```

### Python

```bash
pipx install arena-bridge       # или: pip install arena-bridge
arena-bridge setup --root ~/projects
```

---

## Что агент умеет

| Группа | Инструменты | Что это |
| --- | --- | --- |
| Файлы | `list_dir` `read_file` `write_file` `edit_file` `delete_path` `search_files` `file_get` `file_put` | работа с файлами в разрешённых папках |
| Шелл | `bash` `sysinfo` | команды и сведения о машине |
| Процессы | `start_process` `read_process_output` `write_process` `kill_process` | фоновые дев-серверы |
| Chrome | `chrome_launch` `chrome_attach` `chrome_open` `chrome_navigate` `chrome_snapshot` `chrome_click` `chrome_type` `chrome_press` `chrome_screenshot` `chrome_evaluate` `chrome_tabs` `chrome_stop` | браузер через CDP |
| Десктоп | `mac_see` `mac_click` `mac_type` `mac_key` `mac_scroll` `mac_move` `mac_drag` `mac_apps` `mac_windows` `mac_app_launch` `mac_app_focus` `mac_app_quit` `mac_permissions` | macOS через Peekaboo |

Полный каталог с JSON-схемами: `GET /tools` или `arena-bridge tools`.

### Как выбрать инструмент

| Агент хочет | Инструмент |
| --- | --- |
| прочитать страницу | `chrome_snapshot` (`{"mode":"ax"}` — роли и имена, `{"mode":"text"}`, `{"mode":"html"}`) |
| кликнуть на странице | `chrome_click` (CSS-селектор или видимый текст) |
| работать в вашем залогиненном Chrome | `chrome_attach` (порт 9222) и те же `chrome_*` |
| посмотреть на экран или нативное приложение | `mac_see` (скриншот + id кликабельных элементов) |
| кликнуть в нативном приложении | `mac_click` (id элемента, видимый текст или координаты) |
| напечатать | `mac_type`, затем `mac_key` для Enter/Tab/cmd+s |
| посмотреть файлы | `list_dir` (только верхний уровень; глубже — `{"recursive":true}`) |

---

## Управление Chrome

Свой минимальный CDP-клиент внутри пакета: **ни puppeteer, ни playwright не нужны**.

```jsonc
// браузер агента: свой профиль, без ваших cookie
{"tool": "chrome_launch", "args": {"headless": true, "url": "https://example.com"}}
// прочитать структуру страницы
{"tool": "chrome_snapshot", "args": {"mode": "ax"}}
// кликнуть и ввести
{"tool": "chrome_click", "args": {"text": "Sign in"}}
{"tool": "chrome_type", "args": {"selector": "input[name=q]", "text": "hello", "submit": true}}
// скриншот
{"tool": "chrome_screenshot", "args": {"path": "shot.png"}}
```

* `headless: true` — без окна (по умолчанию), `headless: false` — видимое окно;
* профиль отдельный (`~/.arena-bridge/chrome-profile-*`), в ваши сессии агент не попадает;
* действия в браузере агента подтверждения не требуют — это его песочница.

**Ваш настоящий Chrome** (с вашими логинами) — через `chrome_attach`:

```bash
open -na "Google Chrome" --args --remote-debugging-port=9222 --user-data-dir="$HOME/.chrome-debug"
```

```jsonc
{"tool": "chrome_attach", "args": {"port": 9222}}
```

Любое действие в присоединённом браузере требует локального подтверждения. Инструментов чтения
cookies и localStorage нет.

---

## Управление macOS-десктопом

Через [Peekaboo](https://github.com/openclaw/Peekaboo) (это же использует и MCP-режим Peekaboo):

```jsonc
{"tool": "mac_see", "args": {"app": "Safari", "mode": "window"}}  // скриншот + id элементов
{"tool": "mac_click", "args": {"on": "B3"}}                        // клик по id из mac_see
{"tool": "mac_type", "args": {"text": "hello", "submit": true}}
{"tool": "mac_key", "args": {"key": "cmd+s"}}
{"tool": "mac_apps", "args": {}}                                  // что запущено
{"tool": "mac_permissions", "args": {}}                           // чего не хватает в macOS
```

Установить Peekaboo: `brew install peekaboo` (или бинарник в `/usr/local/bin/peekaboo`).
macOS спросит разрешения **Screen Recording** и **Accessibility** для терминала, из которого
запущен мост — без них скриншоты и клики не работают; `mac_permissions` покажет, что не так.

---

## Доверенное окно: работать без подтверждений

```bash
arena-bridge trust --for 2h                                   # всё, на 2 часа
arena-bridge trust --for 30m --tools bash                     # только команды
arena-bridge trust --for 1h --paths ~/projects/my-app         # только эта папка
arena-bridge trust --status
arena-bridge trust --off
```

* окно снимает требование **подтверждения**, но не снимает **политику путей**: за пределами
  `roots` и в защищённых каталогах по-прежнему `PROTECTED`;
* `--paths` ограничивает доверие конкретными папками; `bash` под такое ограничение не попадает —
  чтобы доверять командам, укажите `--tools bash` явно;
* окно живёт локально (`~/.arena-bridge/trust.json`), агент открыть его не может;
* после истечения срока подтверждения возвращаются сами, а все действия остаются в журнале.

---

## Безопасность

| Токен | Кто знает | Что позволяет |
| --- | --- | --- |
| `token` | агент | вызывать инструменты по HTTP/MCP |
| `deviceToken` | только устройство | подключаться к хабу |
| `localToken` | только вы | подтверждать запросы и открывать окно доверия |

* **Агент не может одобрить сам себя**: `POST /approvals/:id` требует локальный токен.
* **Пути ограничены**: всё вне `roots` — `PROTECTED`. Защищённый список по умолчанию включает
  `~/.ssh`, `~/.aws`, `~/.arena-bridge`, `~/.npmrc`, профили браузеров, ключи.
* **Подтверждения**: `bash`, запись, удаление, управление вашим Chrome и десктопом ждут
  `arena-bridge approve <id>`. Ответ `APPROVAL_PENDING` содержит `approval_id` — покажите его
  пользователю и повторите вызов один раз.
* **Журнал**: `~/.arena-bridge/audit.log` (JSONL) — кто, что и когда вызвал.
* **Транспорт**: сервер слушает `127.0.0.1`, наружу — только туннель с HTTPS.

```bash
arena-bridge rotate            # новый агентский токен (действует мгновенно)
arena-bridge rotate --device   # новый девайсный токен
arena-bridge audit -n 50       # что происходило
```

---

## Команды

| Команда | Что делает |
| --- | --- |
| `setup` | конфиг + проверка машины + API + туннель + готовый промпт |
| `init` | создать `~/.arena-bridge/config.json` с токенами (`--root` повторяемый) |
| `start` | локальный API-сервер |
| `tunnel` | API + облачный туннель, печатает промпт |
| `hub` / `connect` | режим «хаб»: VPS принимает подключения многих машин |
| `prompt` | готовый промпт для чата с агентом |
| `tools` | каталог инструментов в JSON |
| `trust` | окно доверия (`--for`, `--tools`, `--paths`, `--off`, `--status`) |
| `approvals` / `approve <id>` | ожидающие подтверждения и ответ на них (`--deny`) |
| `audit [-n N]` | журнал действий |
| `doctor` | проверка установки, токенов, путей, Peekaboo, Chrome |
| `url` | текущий публичный URL |
| `version` | установленная и последняя версии |
| `update` | обновить пакет с npm (`--check` — только проверить) |
| `service` | macOS-фоновый сервис: `install` / `uninstall` / `status` |
| `rotate` | сменить агентский или девайсный токен |

---

## API и MCP

```
GET  /health          liveness (без авторизации)
GET  /tools           каталог инструментов с JSON-схемами
GET  /prompt          этот промпт для агента
GET  /approvals       ожидающие подтверждения
POST /call            {"tool":"bash","args":{...}}
POST /exec            {"command":"...","cwd":"...","timeout_sec":120}
GET|PUT|DELETE /files?path=/abs/path
POST /approvals/:id   {"decision":"approve"|"deny"}   — только по локальному токену
POST /mcp             MCP Streamable HTTP (protocolVersion 2025-06-18)
```

```bash
curl -sS -X POST "https://<ваш-url>/call" \
  -H "Authorization: Bearer $ARENA_BRIDGE_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"tool":"sysinfo","args":{}}'
```

---

## Разработка

```bash
npm install          # зависимостей нет — только dev-тесты
npm test             # 50 тестов Node: direct, approval, trust, MCP, hub, туннель, Chrome, десктоп
npm run test:python  # 42 теста Python: то же самое
```

Тесты не требуют ни Chrome, ни Peekaboo: используются фейковые CDP- и Peekaboo-серверы
(`test/fake-cdp.mjs`, `test/fake-peekaboo.sh`).

```
src/            Node-реализация (zero dependencies)
  ws.mjs        минимальный WebSocket-клиент
  cdp.mjs       клиент Chrome DevTools Protocol
  browser.mjs   12 инструментов chrome_*
  mac.mjs       13 инструментов mac_* (Peekaboo)
  trust.mjs     окно доверия
  policy.mjs    проверка путей (roots / protected)
  engine.mjs    каталог, гейт подтверждений, аудит
  direct.mjs    HTTP-сервер
  hub.mjs       хаб для нескольких машин
  cli.mjs       команды
arena_bridge/  тот же функционал на Python (stdlib only)
```

## Частые проблемы

| Симптом | Что делать |
| --- | --- |
| `port 8787 is already in use` | остановите старый экземпляр (`Ctrl+C`) или `arena-bridge start --port 8788` |
| туннель не поднимается | `cloudflared` по умолчанию использует QUIC и может быть заблокирован — `arena-bridge tunnel --protocol http2` (это поведение по умолчанию) |
| агент не видит файлы | проверьте `arena-bridge doctor` и `roots` в `~/.arena-bridge/config.json`; вне `roots` всё равно `PROTECTED` |
| `APPROVAL_PENDING` | покажите пользователю `arena-bridge approve <id>` или откройте `arena-bridge trust --for 1h` |
| скриншоты не работают | `mac_permissions` — выдайте терминалу Screen Recording и Accessibility |
| `peekaboo_not_found` | поставьте Peekaboo или укажите путь: `arena-bridge init` + `peekabooPath` в конфиге |

## Лицензия

MIT
