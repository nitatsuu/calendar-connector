# Calendar Connector

Объединяет несколько Google-календарей с разных аккаунтов в один календарь, который
можно расшарить людям (полностью или только «занят/свободен»). Работает бесплатно на
Google Apps Script: свой сервер не нужен, ноутбук может быть выключен.

- Архитектура, модули и порядок подключения аккаунтов: [docs/PLAN.md](docs/PLAN.md)
- Быстрый старт (macOS, всё ставится внутрь папки проекта):

```
make setup                     # локальные Node и clasp
make test
make login  ACCOUNT=personal   # вход в Google (браузер)
make create ACCOUNT=personal   # создать скрипт в аккаунте
make push   ACCOUNT=personal   # выложить код
make app    ACCOUNT=personal   # ссылка на веб-интерфейс
```
