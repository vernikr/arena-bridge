# Выпуск 0.7.18

## Состав

- Независимое одноразовое задание для переустановки службы из самого моста.
- Передача SIGTERM/SIGINT и кодов завершения helper.
- Строгая проверка подписи и архитектуры helper при сборке.
- Регрессионные тесты Node/Python и macOS; документация о старых TCC-подписях.

## Перед выпуском проверено

На Mac: постоянный установленный пакет, автоматическое восстановление туннеля после
переустановки, одна пара helper → Node, GUI, снимок с окнами и AX-дерево (50 элементов).
Разрешения подтверждены для текущей подписи.

## Публикация

Тег v0.7.18 запускает npm, PyPI и GitHub Release с пятью артефактами:
CLI npm tgz, Python sdist, Python wheel, приложения Intel и Apple Silicon.
Публичные macOS-сборки не заменяют локальную проверенную сборку автоматически:
ad-hoc-подпись другой сборки может потребовать повторного добавления разрешений.

## Итог публикации

Опубликовано 2026-10-18:

- npm latest: 0.7.18, registry endpoint возвращает 200.
- PyPI 0.7.18: endpoint возвращает 200.
- GitHub Release v0.7.18: пять артефактов, русские release notes.
- Все release jobs (npm, pypi, release, macos) и CI завершились success.
- В обоих скачанных zip проверены наличие helper, executable bit и Mach-O CPU:
  arm64 — 0x0100000c, x86_64 — 0x01000007.
- Проверенная локальная сборка на Mac не заменялась; /health сообщает 0.7.18.

Ссылки:
- https://github.com/vernikr/arena-bridge/releases/tag/v0.7.18
- https://www.npmjs.com/package/arena-bridge/v/0.7.18
- https://pypi.org/project/arena-bridge/0.7.18/
