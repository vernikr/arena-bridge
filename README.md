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
  <img src="https://img.shields.io/badge/tests-156%20passed-brightgreen.svg?style=flat-square" alt="tests">
</p>

<p align="center">
  <code>npm i -g arena-bridge</code> &nbsp;→&nbsp; <code>arena-bridge setup</code> &nbsp;→&nbsp; вставьте готовый промпт в чат с агентом
</p>

---

## Что это

Полное дерево функциональности — в [feature-tree.md](feature-tree.md).

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

Одна команда ставит и командную строку, и нативное приложение для macOS:

```bash
curl -fsSL https://raw.githubusercontent.com/vernikr/arena-bridge/main/install.sh | sh
```

Или по отдельности:

```bash
npm i -g arena-bridge          # только командная строка
pip install arena-bridge       # то же самое на Python
```

Приложение macOS можно скачать и без терминала — в каждом выпуске лежат готовые сборки:
[Apple silicon](https://github.com/vernikr/arena-bridge/releases/latest/download/Arena-Bridge-arm64.zip) ·
[Intel](https://github.com/vernikr/arena-bridge/releases/latest/download/Arena-Bridge-x86_64.zip).
Распаковать и перетащить в «Программы».

```bash
# 1. один раз: создать конфиг, проверить машину, поднять API + туннель
arena-bridge setup --root ~/projects --root ~/Documents

# 2. скопировать блок «Paste this into the agent chat» и вставить его в чат с агентом
```

> **macOS и Gatekeeper.** Приложение подписано локально, поэтому при первом запуске система может
> сказать «нельзя открыть, так как разработчик не проверен». Обойти это можно без терминала:
> правый клик по **Arena Bridge** в «Программах» → **Открыть** → **Открыть**. Через терминал:
> `xattr -dr com.apple.quarantine "/Applications/Arena Bridge.app"`.

`setup` печатает готовый промпт и публичный URL. Дальше — просто говорите агенту задачу.

Туннель под присмотром: если `cloudflared`/`ngrok` упадёт, мост поднимет его заново и сам
напечатает новый публичный адрес. Постоянный адрес вместо случайного — `arena-bridge tunnel
--bin ngrok --domain <зарезервированный домен>`.

Нужен туннель? Поставьте `cloudflared` (`brew install cloudflared` или бинарник в `/usr/local/bin`).
Можно и через ngrok — `arena-bridge tunnel --bin ngrok`; с сохранённым токеном и зарезервированным
доменом публичный адрес остаётся постоянным, и промпт агенту не нужно копировать заново:
`arena-bridge tunnel --bin ngrok --authtoken <token> --domain <name>.ngrok-free.dev`.

### В фоне, чтобы не открывать терминал

Мост можно поднять как службу macOS — он стартует вместе с системой, переживает закрытие
терминала и поднимается заново после сбоя:

```bash
arena-bridge service install                                   # облако, случайный адрес
arena-bridge service install --bin ngrok --domain mymac.ngrok-free.app   # постоянный адрес
arena-bridge service status                                    # состояние и текущий URL
arena-bridge url                                              # текущий публичный адрес
arena-bridge service uninstall
```


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
| Журнал | `audit_log` `audit_artifact` | что делалось, какие снимки и деревья Accessibility сохранены |
| Шелл | `bash` `sysinfo` | команды и сведения о машине |
| Процессы | `start_process` `read_process_output` `write_process` `kill_process` | фоновые дев-серверы |
| Chrome | `chrome_launch` `chrome_profiles` `chrome_attach` `chrome_open` `chrome_navigate` `chrome_snapshot` `chrome_click` `chrome_type` `chrome_press` `chrome_screenshot` `chrome_evaluate` `chrome_tabs` `chrome_stop` | браузер через CDP |
| Десктоп | `mac_see` `mac_element` `mac_click` `mac_set` `mac_type` `mac_key` `mac_scroll` `mac_move` `mac_drag` `mac_menu` `mac_menu_click` `mac_wait` `mac_spaces` `mac_space_switch` `mac_apps` `mac_windows` `mac_app_launch` `mac_app_focus` `mac_app_quit` `mac_permissions` | macOS через Peekaboo |
| Telegram | `notify_user` `telegram_inbox` `telegram_status` | сообщения вам и ваши ответы |

Полный каталог с JSON-схемами: `GET /tools` или `arena-bridge tools`.

### Как выбрать инструмент

| Агент хочет | Инструмент |
| --- | --- |
| прочитать страницу | `chrome_snapshot` (`{"mode":"ax"}` — роли и имена, `{"mode":"text"}`, `{"mode":"html"}`) |
| кликнуть на странице | `chrome_click` (CSS-селектор или видимый текст) |
| работать в вашем залогиненном Chrome | `chrome_attach` (порт 9222) и те же `chrome_*` |
| посмотреть на экран или нативное приложение | `mac_see` (скриншот + id элементов) |
| найти контрол по названию, без скриншота | `mac_element` (через Accessibility API: имя, роль, значение) |
| заполнить поле, не печатая и не забирая фокус | `mac_set` (значение пишется напрямую в элемент) |
| открыть пункт меню | `mac_menu` (список) → `mac_menu_click` (по названию) |
| дождаться, пока контрол появится | `mac_wait` |
| кликнуть в нативном приложении | `mac_click` (id элемента, видимый текст или координаты) |
| напечатать | `mac_type`, затем `mac_key` для Enter/Tab/cmd+s |
| посмотреть файлы | `list_dir` (только верхний уровень; глубже — `{"recursive":true}`) |
| написать вам или спросить | `notify_user` (Telegram), ответ читать через `telegram_inbox` |

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
{"tool": "mac_element", "args": {"name": "Save"}}                // найти кнопку по названию
{"tool": "mac_click", "args": {"on": "B3"}}                      // клик по id из mac_see
{"tool": "mac_set", "args": {"on": "B2", "value": "hello"}}      // вписать значение напрямую
{"tool": "mac_type", "args": {"text": "hello", "submit": true}}
{"tool": "mac_key", "args": {"key": "cmd+s"}}
{"tool": "mac_menu_click", "args": {"app": "Safari", "item": "Save"}}  // пункт меню по названию
{"tool": "mac_wait", "args": {"name": "Saved", "timeout": 20}}        // дождаться результата
{"tool": "mac_apps", "args": {}}                                  // что запущено
{"tool": "mac_permissions", "args": {}}                           // чего не хватает в macOS
```

Установить Peekaboo: `brew install peekaboo` (или бинарник в `/usr/local/bin/peekaboo`).
Проверено с Peekaboo 4.9 (4.3 тоже работает, но синтаксис команд обновлён под 4.9).
macOS спросит разрешения **Screen Recording** и **Accessibility** для терминала, из которого
запущен мост — без них скриншоты и клики не работают; `mac_permissions` покажет, что не так.

### Что даёт доступ Accessibility

macOS отдаёт приложениям два разных слоя: картинку экрана и **Accessibility API** — дерево
элементов интерфейса с названиями, ролями и значениями. Второй слой полезен агенту сильнее:

| | по картинке | через Accessibility API |
| --- | --- | --- |
| как найти кнопку «Сохранить» | угадать координаты | `mac_element {"name":"Сохранить"}` → точный элемент |
| как нажать | клик по координате, может промахнуться | `mac_click {"on":"<id>"}` — по самому элементу |
| как вписать текст | свайп, фокус, клавиатура | `mac_set {"on":"<id>","value":"..."}` — без фокуса и без клавиш |
| как открыть «Файл → Экспорт» | перемещать курсор по меню | `mac_menu_click {"item":"Экспорт"}` — по названию |
| как убедиться, что получилось | смотреть скриншот | `mac_wait {"name":"Готово"}` — ждать появления |
| как заполнить поле | свайп + клавиатура + фокус | `mac_set {"on":"<id>","value":"..."}` — значение пишется в элемент |
| чужой ввод и фокус | мешает вам | действия уходят в фоновое окно |

Практический вывод: с выданным Accessibility агент работает заметно точнее и тише. Разрешение
даётся один раз в **Системные настройки → Конфиденциальность и безопасность → Универсальный
доступ** (для терминала, из которого запущен мост). `mac_permissions` показывает текущее
состояние разрешений.

---

## Журнал работы с артефактами

Каждый вызов записывается: аргументы, результат, время выполнения. Рядом с журналом хранятся
**доказательства** — снимки экрана, деревья Accessibility, деревья меню, список рабочих столов.

```bash
arena-bridge audit                 # последние вызовы
arena-bridge audit artifacts       # сохранённые файлы (скриншоты, деревья)
arena-bridge audit <id>            # одна запись целиком
arena-bridge audit prune           # удалить старые артефакты (по умолчанию старше 14 дней)
arena-bridge audit dir             # где всё это лежит
```

Агенту доступно то же самое: `audit_log` (вызовы) и `audit_artifact` (сам артефакт — PNG в base64
или дерево Accessibility в JSON), а также `GET /audit` и `GET /audit/artifact?entry=<id>&file=<name>`.
Полезно, чтобы оглянуться назад: что было на экране и что находилось в интерфейсе.

---

## Связь с Telegram

Агент может писать вам в Telegram и читать ваши ответы — даже если вы сейчас не в чате с ним.

```bash
# один раз: привязать бота (токен от @BotFather и ваш chat id)
arena-bridge telegram setup --token 123456:AA... --chat-id 190771108

# проверить связь
arena-bridge telegram test

# посмотреть, что вам писали
arena-bridge telegram inbox
```

Что это даёт:
- `notify_user` — агент пишет вам: «сделал», «нужно ваше решение», «вот результат».
  С `{"wait_for_reply": true}` вызов ждёт вашего ответа прямо в Telegram.
- `telegram_inbox` — агент читает то, что вы написали боту: ответы, правки, поручения.
- `telegram_status` — бот, список чатов, число непрочитанных сообщений.
- **Подтверждения из Telegram.** Когда агенту нужно ваше «да», мост сам пишет вам:
  `/approve <id>` — разрешить, `/deny <id>` — отказать. Из терминала тоже можно:
  `arena-bridge approve <id>`.

Как это устроено и что защищено:
- токен бота лежит только в `~/.arena-bridge/config.json` (права `0600`); агент этот файл
  прочитать не может — он в списке защищённых путей;
- писать можно только в те чаты, что перечислены в `--chat-id` (по умолчанию — ваш);
- не больше 20 сообщений в минуту, одно сообщение — до 4000 символов;
- входящие сообщения мост слушает сам (служба launchd — автоматически), входящие лежат
  в `~/.arena-bridge/telegram/`.

Одно уточнение: для бота `api_id`/`api_hash` не нужны — они пригодятся только для режима
«личного аккаунта» (MTProto), который пока не включён.

---

## Нативное приложение для macOS

Окно, в котором всё видно и всё управляется: статус, пуск/стоп, подтверждения, журнал.

```bash
git clone https://github.com/vernikr/arena-bridge.git
cd arena-bridge/macos/ArenaBridge
./build.sh                                   # → dist/Arena Bridge.app
cp -R "dist/Arena Bridge.app" /Applications/
```

Нужен только Swift из Xcode Command Line Tools (`xcode-select --install`), Xcode целиком не
требуется. Собирается под текущую архитектуру: `ARCH=x86_64` для Intel, `ARCH=arm64` для
Apple Silicon. Готовые сборки для обеих архитектур появляются в каждом выпуске на GitHub
(см. «Быстрый старт»), собирать самому не нужно.

| Блок в окне | Что делает |
| --- | --- |
| Статус | запущен/остановлен, версия, режим, число инструментов, публичный адрес, уведомления, Telegram |
| Управление | «Запустить» / «Остановить» (служба `ai.arena.bridge`), «Настроить…», «Скопировать промпт агенту» |
| Доверенное окно | «Открыть на 3 ч» / «Закрыть» и статус «действует ещё 2:59» |
| Подтверждения | ожидающие запросы агента с кнопками «Разрешить» / «Разрешить на 3 ч» / «Отклонить» |
| Журнал | команды с аргументами, клик по скриншоту или ax-tree открывает его целиком, «Сохранить…» в файл (с ax-tree) |

Окно следит за машиной само: статус, подтверждения и доверенное окно обновляются каждые
несколько секунд, журнал — чуть реже. Кнопка обновления (⌘R) есть на всякий случай.

Когда агенту нужно решение, приложение показывает системное уведомление macOS
«Approval needed» — в строке меню и в центре уведомлений. Внутри окна запрос тоже виден
сразу, в карточке «Подтверждения».

«Настроить…» собирает конфиг, службу и запуск одной кнопкой: туннель (ngrok/cloudflared),
зарезервированный домен, authtoken, папки для агента, Telegram (токен бота и chat id).

Иконка приложения лежит в `macos/ArenaBridge/Resources/AppIcon.png`; `build.sh` сам собирает
из неё `.icns` и кладёт в бандл.

---

## Подтверждения в Telegram: кнопки

Под сообщением «Approval needed» появляются нативные кнопки:

```
Approve once      Approve for 3h      Deny
```

* **Approve once** — разрешить этот запрос и всё;
* **Approve for 3h** — разрешить и открыть доверенное окно на 3 часа для этого же инструмента
  (команды больше не спрашивают);
* **Deny** — отклонить.

Кнопки работают и в приложении на Mac, и в Telegram; сообщение в Telegram после нажатия
переписывается на итог. Прежние команды `/approve <id>` и `/deny <id>` тоже работают.

---

## Доверенное окно: работать без подтверждений

```bash
arena-bridge trust --for 2h                                   # всё, на 2 часа
arena-bridge trust --for 30m --tools bash                     # только команды
arena-bridge trust --for 1h --paths ~/projects/my-app         # только эта папка
arena-bridge trust --status
arena-bridge trust --status --json                            # для приложений и скриптов
arena-bridge trust --off
```

* окно снимает требование **подтверждения**, но не снимает **политику путей**: за пределами
  `roots` и в защищённых каталогах по-прежнему `PROTECTED`;
* `--paths` ограничивает доверие конкретными папками; `bash` под такое ограничение не попадает —
  чтобы доверять командам, укажите `--tools bash` явно;
* окно живёт локально (`~/.arena-bridge/trust.json`), агент открыть его не может;
* после истечения срока подтверждения возвращаются сами, а все действия остаются в журнале.

---

## Отдельные браузерные «кабинеты» агента

Агенту можно выдать несколько независимых профилей браузера — например «рабочий», «клиентский»,
«тестовый». В каждом свои входы, и они переживают перезапуск моста.

```bash
arena-bridge browser open work       # открыть Chrome с профилем «work»
# вы логинитесь в нужные сайты и закрываете окно — входы сохраняются
arena-bridge browser list             # какие профили есть
arena-bridge browser close work       # закрыть окно этого профиля
```

Агент открывает тот же профиль через `chrome_launch {"profile":"work"}` — уже с вашими входами.
Каталог профилей агент тоже видит: `chrome_profiles`.

Ваш собственный Chrome (на порту 9222, с вашими сессиями) доступен отдельно — через
`chrome_attach`; любые действия в нём требуют подтверждения.

---

## Как это не мешает вам

| Что беспокоит | Как решается |
| --- | --- |
| окно агента занимает экран | по умолчанию агент работает в фоне; видимое окно можно сделать маленьким и в углу: `chrome_launch {"headless":false,"width":900,"height":700,"x":-920,"y":40}` |
| агент перехватывает фокус и курсор | действия в нативных приложениях идут «в фон» — в нужное окно, без переключения на вас; курсор двигается только по вашей явной просьбе |
| окно агента на вашем рабочем столе | macOS умеет несколько рабочих столов: агент переключается на отдельный стол через `mac_space_switch`, вы остаётесь на своём |
| нужен отдельный «второй монитор» | в macOS виртуальный монитор штатно не создаётся; сторонние утилиты (BetterDisplay, DisplayLink) умеют — тогда окно агента всегда там, где вы не работаете |
| нужен полностью независимый курсор и стол | только отдельная виртуальная машина; на 16 ГБ и Intel 2019 года она заметно тормозит и съедает 30–60 ГБ — как правило, не нужно |

Рекомендация для ноутбука с 16 ГБ и Intel 2019: отдельные профили браузера + фоновый режим +
при необходимости второй рабочий стол macOS. Полноценная виртуальная машина того не стоит.

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
| `browser` | профили браузера агента: `list` / `open <name>` / `close <name>` |
| `rotate` | сменить агентский или девайсный токен |
| `telegram` | связь с Telegram: `setup` / `test` / `status` / `inbox` / `poll` |

---

## API и MCP

```
GET  /health          liveness (без авторизации)
GET  /tools           каталог инструментов с JSON-схемами
GET  /prompt          этот промпт для агента
GET  /approvals       ожидающие подтверждения
GET  /audit           журнал работы с артефактами
GET  /audit/artifact  сохранённый артефакт (entry=, file=)
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
npm test             # 52 теста Node: direct, approval, trust, MCP, hub, туннель, Chrome, десктоп
npm run test:python  # 44 теста Python: то же самое
```

Тесты не требуют ни Chrome, ни Peekaboo: используются фейковые CDP- и Peekaboo-серверы
(`test/fake-cdp.mjs`, `test/fake-peekaboo.sh`).

```
src/            Node-реализация (zero dependencies)
  ws.mjs        минимальный WebSocket-клиент
  cdp.mjs       клиент Chrome DevTools Protocol
  browser.mjs   13 инструментов chrome_*
  mac.mjs       20 инструментов mac_* (Peekaboo, Accessibility API)
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
