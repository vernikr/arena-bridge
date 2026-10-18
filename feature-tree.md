# arena-bridge — дерево функциональности

Компактная иерархия всего, что продукт умеет. Термины: **инструмент** — вызов агента,
**гейт** — подтверждение человеком, **окно доверия** — временное снятие гейта,
**roots** — разрешённые папки, **protected** — защищённые пути.

## Назначение

- Доступ облачного агента к своему компьютеру
  - Транспорт: локальный HTTP API → туннель (HTTPS) либо свой хаб
  - Граница доверия: гейт подтверждений, окно доверия, ограничение путей
  - Наблюдаемость: журнал действий, артефакты, уведомления, Telegram
  - Целевые сценарии: чтение и правка файлов, шелл, браузер, десктоп macOS, фоновые процессы

## Установка и выпуски

- Командная строка
  - npm: `npm i -g arena-bridge`
  - Python: `pip install arena-bridge` (тот же функционал)
  - Одной командой: `curl -fsSL …/install.sh | sh` — CLI + приложение macOS
    - Флаги: `--cli-only`, `--app-only`, `--version`, `--prefix`
  - Обновление: `arena-bridge update` (`--check` — только проверить)
  - Проверка установки: `arena-bridge doctor`
- Нативное приложение macOS
  - Обычное окно, без иконки в менюбаре
  - Состояние обновляется само: статус, подтверждения и доверенное окно — каждые несколько секунд
  - Сборка: `macos/ArenaBridge/build.sh` → `dist/Arena Bridge.app`; `ARCH=x86_64|arm64`
  - Подпись ad-hoc; иконка `Resources/AppIcon.png` → `.icns` при сборке, вокруг знака прозрачно
  - Имя приложения — константа: `src/app.mjs`, `arena_bridge/app.py`, `Sources/AppInfo.swift`
  - Служба в «Системных настройках → Вход» называется как приложение, а не «node»
  - Служба стартует через помощник внутри подписанного бандла
    (`Contents/Helpers/arena-bridge-agent`): macOS пишет разрешение на того, кто запросил его
    сверху, поэтому «Запись экрана» называется «Arena Bridge», а не «node»
  - Без приложения (установка только из командной строки) остаётся прежний запуск
  - Служба стартует из постоянных папок: временная папка версии node удаляется, а macOS
    привязывает разрешение к точному файлу — и «Запись экрана» слетала сама
  - Gatekeeper при первом запуске: правый клик → «Открыть» либо `xattr -dr com.apple.quarantine`
- Артефакты выпуска (GitHub Release по тегу `vX.Y.Z`)
  - npm-архив, python sdist + wheel, `.app` для arm64 и x86_64

## Подготовка

- `arena-bridge init` — конфиг, свежие токены, roots
- `arena-bridge setup` — конфиг + проверка машины + API + туннель + готовый промпт
- Конфиг `~/.arena-bridge/config.json` (0600), перечитывается на каждый запрос
  - Токены: `token` (агент), `deviceToken` (устройство), `localToken` (только хозяин)
  - `roots` — разрешённые папки; всё вне них — `PROTECTED`
  - `protected` — защищённый список (по умолчанию `~/.ssh`, `~/.aws`, `~/.arena-bridge`, `~/.npmrc`, профили браузеров, ключи)
  - Режим: `direct` | `hub`; `host`/`port`; `publicUrl`; `device`
  - Политика: `requireApproval`, `approvalWaitSec`, `approvalTtlSec`, `allowShell`, `audit`
  - Telegram: бот, chat id, опрос сообщений
  - Peekaboo: путь к бинарнику
- Первый запуск под macOS: разрешить Accessibility и Screen Recording для процесса, который
  запускает мост; при отказе — работа без десктопных инструментов, остальное продолжает работать

## Подключение агента

- Прямой режим
  - `arena-bridge start` — API на `127.0.0.1:8787`
  - `arena-bridge tunnel` — API + облачный туннель, печатает готовый промпт
    - Бинарники: cloudflared (по умолчанию), ngrok
    - Транспорт: http2 (по умолчанию), quic
    - Надзор: упавший туннель поднимается заново, новый URL печатается
    - Постоянный адрес: `--authtoken`, `--domain` (зарезервированный домен)
  - `arena-bridge service install` — фоновый режим под launchd (`ai.arena.bridge`), постоянный URL
  - `arena-bridge url` — текущий публичный адрес
- Хаб (свой сервер)
  - `arena-bridge hub` — релей для многих устройств: `/devices`, `/call`, `/exec`, `/files`, `/policy`
  - `arena-bridge connect` — устройство дозванивается в хаб сам (только `deviceToken`)
- Готовый промпт: `GET /prompt`, `arena-bridge prompt` — текст с URL, токеном, списком инструментов
- HTTP API (Bearer `token`)
  - `GET /health` (без авторизации), `/tools`, `/prompt`, `/config`, `/approvals`, `/audit`, `/audit/artifact`
  - `POST /call` {tool, args}, `POST /exec` {command, cwd, timeout_sec, env}
  - `GET|PUT|DELETE /files?path=`
  - `POST /approvals/:id` {decision} — только по `localToken`
  - `POST /mcp` — MCP Streamable HTTP (protocol 2025-06-18)
- Ограничения транспорта: тело до 16 МБ, ответ до 8 МБ, никаких GET с побочным эффектом

## Инструменты агента (52)

- Файлы: `list_dir` (рекурсия по флагу), `read_file`, `write_file`, `edit_file`, `delete_path`,
  `search_files`, `file_get`, `file_put`
- Шелл: `bash`, `sysinfo`
- Процессы: `start_process`, `read_process_output`, `write_process`, `kill_process`
- Журнал: `audit_log`, `audit_artifact`
- Chrome (13): `chrome_launch`, `chrome_profiles`, `chrome_attach`, `chrome_tabs`, `chrome_open`,
  `chrome_navigate`, `chrome_snapshot`, `chrome_click`, `chrome_type`, `chrome_press`,
  `chrome_screenshot`, `chrome_evaluate`, `chrome_stop`
- macOS-десктоп (20): `mac_see`, `mac_element`, `mac_click`, `mac_set`, `mac_type`, `mac_key`,
  `mac_scroll`, `mac_move`, `mac_drag`, `mac_menu`, `mac_menu_click`, `mac_wait`, `mac_spaces`,
  `mac_space_switch`, `mac_apps`, `mac_windows`, `mac_app_launch`, `mac_app_focus`, `mac_app_quit`,
  `mac_permissions`
- Telegram: `notify_user`, `telegram_inbox`, `telegram_status`
- Браузер
  - Свой браузер агента: `chrome_launch` (окно или headless), профиль по имени, размер и угол окна
  - Ваш Chrome на порту 9222: `chrome_attach`; чтение бесплатно, ввод — через гейт
  - Снимок страницы: `chrome_snapshot` в режимах `ax` (роли и имена), `text`, `html`
- Десктоп
  - `mac_see` — скриншот окна или экрана + дерево Accessibility с id элементов
  - `mac_element` — поиск контрола по имени/роли/значению без скриншота
  - `mac_click` — по id элемента, видимому тексту или координатам; `mac_set` — запись значения напрямую
  - Ввод: `mac_type`, `mac_key`, `mac_scroll`, `mac_move`, `mac_drag`, `mac_wait`
  - Меню и пространства: `mac_menu`, `mac_menu_click`, `mac_spaces`, `mac_space_switch`
  - Приложения: `mac_apps`, `mac_windows`, `mac_app_launch`, `mac_app_focus`, `mac_app_quit`
  - Разрешения: `mac_permissions` (статус, запрос, выдача)
  - Фоновая доставка: действия идут в нужное окно без перехвата фокуса и курсора
  - Вне macOS инструменты десктопа сообщают «не установлено» и не ломают остальное

## Политика доступа и подтверждения

- Кто требует подтверждения: запись, удаление, шелл, управление вашим браузером и десктопом
- Гейт
  - Запрос: файл в `~/.arena-bridge/approvals/` (0600), ожидание `approvalWaitSec`
  - Ответ агенту: `APPROVAL_PENDING` с `approval_id` — показать человеку и повторить вызов один раз
  - Решения: `arena-bridge approve|deny <id>`, `/approve` `/deny` в Telegram, кнопки в приложении
  - Запрос в Telegram с кнопками: Approve once, Approve for 3h, Deny; после нажатия сообщение
    переписывается на итог
- Окно доверия
  - `arena-bridge trust --for 2h [--tools a,b] [--paths p1,p2]`, `--status`, `--status --json`, `--off`
  - Снимает только требование подтверждения; политика путей остаётся
  - `--paths` не покрывает `bash` — для команд нужно указать `--tools bash`
  - «Approve for 3h» открывает окно на 3 часа для того же инструмента
- Токены
  - Агент не одобряет сам себя: `POST /approvals/:id` требует `localToken`
  - `arena-bridge rotate` (агентский), `arena-bridge rotate --device` (девайсный) — действуют мгновенно
- Ничего лишнего: сервер слушает только localhost, наружу — HTTPS-туннель

## Журнал и артефакты

- `~/.arena-bridge/audit.log` — JSONL: кто, что, когда, с аргументами и статусом
- Маскирование: токены Telegram, GitHub, npm, PyPI, API-ключи — `***`
- Артефакты: `~/.arena-bridge/audit/<entry>/` — `screen.png`, `ax-tree.json`
  - Запись: `ctx.artifact` на вызовах `mac_see`
  - Чтение: `GET /audit/artifact?entry=&file=`, инструменты `audit_log`, `audit_artifact`
  - Хранение 14 дней; `arena-bridge audit prune|dir|artifacts`
- Команды: `arena-bridge audit [-n N]`, `arena-bridge audit <id>`

## Связь с Telegram

- Настройка: `arena-bridge telegram setup --token <bot token> --chat-id <id>`
  - Токен бота — только в конфиге 0600, агент его не видит
  - Сообщения — только разрешённым chat id; ограничение 20 сообщений в минуту, 4000 символов
- Агент: `notify_user` (с ожиданием ответа), `telegram_inbox`, `telegram_status`
- Команды чата: `/approve <id>`, `/deny <id>`, `/status`, `/help`
- CLI: `arena-bridge telegram test|status|inbox|poll`
- Подтверждения в чате: объявление запроса + кнопки; решение фиксируется в журнале

## Интерфейсы управления

- Командная строка
  - Жизненный цикл: `init`, `setup`, `start`, `tunnel`, `hub`, `connect`, `service install|uninstall|status`
  - Наблюдение: `approvals`, `approve <id>`, `audit`, `doctor`, `url`, `version`, `tools`, `prompt`
  - Доверие: `trust`; связь: `telegram`; браузер: `browser list|open <name>|close <name>`
  - Общие флаги: `--mode`, `--device`, `--root` (повторяемый), `--port`, `--host`, `--hub`,
    `--public-url`, `--protocol`, `--bin`, `--authtoken`, `--domain`, `--no-approval`, `--no-shell`
- Нативное приложение macOS
  - Статус: состояние, версия, режим, число инструментов, публичный адрес, уведомления, Telegram
  - Управление: запуск, остановка, первичная настройка, копирование промпта агенту
  - Доверенное окно: открыть на 3 ч, закрыть, «действует ещё h:mm»
  - Подтверждения: Approve, Approve for 3 h, Deny; обновление каждые 6 секунд
  - Журнал: команды с аргументами, клик по скриншоту или ax-tree открывает его целиком
    (дерево или исходный JSON), «Сохранить…» — файл с ax-tree и папкой скриншотов
  - Уведомление macOS «Approval needed» при появлении запроса
  - Первичная настройка: туннель и домен, authtoken, папки агента, токен бота и chat id

## Эксплуатация

- Фоновая служба: launchd `ai.arena.bridge`, логи в `~/.arena-bridge/logs/`, постоянный URL
- Отдельные «кабинеты» браузера: именованные профили, один вход пользователя, `browser open <name>`
- Не мешает работе: агент по умолчанию в фоне, окно можно уменьшить и прижать в угол,
  рабочий стол агента — отдельный Space macOS; виртуальная машина не используется
- Диагностика: `arena-bridge doctor`, `mac_permissions`, логи туннеля и службы

## Ограничения

- macOS-десктоп — только macOS (Peekaboo 4.9.5+); на других системах инструменты не активны
- Виртуальный монитор в macOS штатно не создаётся — сторонние утилиты
- Полностью изолированный курсор и стол — только виртуальная машина
- Пространства Spaces недоступны через удалённый демон Peekaboo
- Гейт не должен висеть молча: `approvalWaitSec` ограничивает ожидание
- Свою виртуальную машину ради изоляции на 16 ГБ / Intel 2019 не тянет

## Порядок приоритетов при конфликте

1. Политика путей (roots/protected)
2. Гейт подтверждений
3. Окно доверия (снимает только гейт)
4. Удобство агента (свой браузер, фоновые действия)
