# Claude Migration Brief

Этот файл нужен, чтобы безопасно подключить Claude к крупной миграции
`loft_hall_internship_unified` на PostgreSQL. Не хранить здесь секреты,
пароли, Telegram-токены, реальные `.env` значения или дампы персональных данных.

## Главное

Проект уже в production. Claude нельзя давать задачу в стиле "сделай миграцию
как считаешь нужным" без ограничений. Работать только маленькими шагами,
только в миграционной копии, только через отдельную ветку и PR.

## Где Работать

Локальная папка:

```text
/Users/a1/Desktop/Loft_Hall/Helper_bot/loft_hall_internship_unified_hall_sync
```

GitHub:

```text
https://github.com/xk369/lh-stazhirovka
```

Базовая migration-ветка:

```text
migration/postgres-foundation
```

Текущий draft PR:

```text
https://github.com/xk369/lh-stazhirovka/pull/3
```

Последний известный migration commit:

```text
ee2d552 Expand booking event coverage
```

Текущий общий прогресс миграции:

```text
45%
```

## Что Нельзя Делать

- Не работать в `loft_hall_internship_unified`, если задача про миграцию.
- Не деплоить в production.
- Не менять production server:
  `/opt/loft-hall-internship-unified`.
- Не переключать production на PostgreSQL.
- Не менять Telegram chat routing.
- Не включать live-уведомления в staging.
- Не коммитить `.env`, `data/db.json`, дампы БД, токены, пароли.
- Не мержить PR #3 в `main`.
- Не переносить mentor manual-entry feature в production.
- Не переписывать UI/UX вместе с backend-миграцией.
- Не делать большие рефакторы `public/booking.html`, если задача про БД.

## Какую Ветку Создать Claude

Claude должен создать отдельную ветку от актуальной migration-ветки:

```bash
git fetch origin
git checkout migration/postgres-foundation
git pull --ff-only origin migration/postgres-foundation
git checkout -b migration/postgres-write-adapter-claude
```

PR потом открывать не в `main`, а в:

```text
migration/postgres-foundation
```

То есть:

```text
migration/postgres-write-adapter-claude -> migration/postgres-foundation
```

## Что Claude Должен Прочитать Перед Работой

Обязательно:

- `AGENTS.md`
- `docs/CODEX_HANDOFF.md`
- `docs/CODEX_PROGRESS.md`
- `docs/MIGRATION_EXECUTION_PLAN.md`
- `docs/POSTGRES_MIGRATION_ROADMAP.md`
- `docs/DATA_MODEL.md`
- `docs/INTERNSHIP_WORKFLOW.md`

И только потом смотреть код:

- `src/server.js`
- `src/booking-state-events.js`
- `src/postgres/read-booking-state.js`
- `src/postgres/write-application-events.js`
- `src/postgres/import-booking-state.js`
- `db/migrations/001_initial.sql`
- `test/booking-state-events.test.js`
- `test/booking-storage-mode.test.js`
- `test/postgres-*.test.js`

## Первое Задание Для Claude

Не "перевести все на Postgres", а только спроектировать и реализовать первый
узкий слой writable Postgres без production-включения.

Цель первого Claude-этапа:

1. Добавить storage adapter для booking-state.
2. Подготовить `BOOKING_STORAGE_MODE=postgres`, но не использовать его в prod.
3. Реализовать минимальный transactional write path на staging для одной-двух
   команд с тестами, либо сделать технический дизайн, если безопаснее начать
   с design doc.
4. Не удалять JSON runtime.
5. Не менять public API без явной необходимости.
6. Вернуть fresh state после успешной команды из Postgres.
7. Писать `application_events` в той же транзакции.

Рекомендуемый первый scope:

- `create_shift`;
- `update_shift_capacity`;
- `set_application_status`;

Не брать сразу:

- mentor reports;
- Telegram outbox;
- full `/api/report`;
- production cutover.

Причина: mentor reports и Telegram outbox - самые рискованные части цепочки.
Их лучше подключать после того, как простой transactional state write доказан.

## Проверки Перед Коммитом Claude

Минимум:

```bash
npm test
git diff --check
git status --short --branch
```

Если менялись Postgres-инструменты:

```bash
npm run test:postgres
```

Если `npm run test:postgres` падает из-за sandbox/local PostgreSQL, Claude
должен явно написать причину и не притворяться, что проверка пройдена.

## Как Отчитываться

Каждый отчет Claude должен начинаться так:

```text
Прогресс миграции: X%.
```

Далее:

1. Какая ветка.
2. Какие файлы изменены.
3. Какие тесты прошли.
4. Что не проверено.
5. Почему production не затронут.
6. Что следующий безопасный шаг.

## Готовый Prompt Для Claude

```text
Ты подключаешься к крупной миграции LOFT HALL internship mini app с JSON
data/db.json на PostgreSQL.

Работай только в:
/Users/a1/Desktop/Loft_Hall/Helper_bot/loft_hall_internship_unified_hall_sync

Production не трогать. В main не коммитить. PR делать только из отдельной
ветки в migration/postgres-foundation. Не деплоить. Не менять .env, data/db.json,
Telegram chat routing, live notifications и mentor manual-entry feature.

Сначала прочитай полностью:
- AGENTS.md
- docs/CODEX_HANDOFF.md
- docs/CODEX_PROGRESS.md
- docs/MIGRATION_EXECUTION_PLAN.md
- docs/POSTGRES_MIGRATION_ROADMAP.md
- docs/DATA_MODEL.md
- docs/INTERNSHIP_WORKFLOW.md
- docs/CLAUDE_MIGRATION_BRIEF.md

После чтения выполни:
- git status --short --branch
- git branch --show-current
- git log --oneline --decorate -8

Если ты не на migration/postgres-foundation, остановись и сообщи.
Затем создай отдельную ветку:
migration/postgres-write-adapter-claude

Задача: не делать всю миграцию сразу. Подготовь первый безопасный слой writable
Postgres: storage adapter / transaction boundary / тестовый write path для
ограниченного набора команд. JSON runtime должен остаться production-safe
default. Telegram/outbox и mentor reports пока не трогай, если без этого можно
завершить первый слой.

Обязательно обновляй docs/CODEX_PROGRESS.md. Каждый отчет начинай с:
"Прогресс миграции: X%."

Перед завершением запусти:
npm test
git diff --check

Если менялись Postgres-инструменты, также попробуй:
npm run test:postgres

Не заявляй, что production готов к миграции. Цель сейчас - безопасный staging
foundation.
```
