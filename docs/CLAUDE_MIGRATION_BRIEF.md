# Claude Migration Brief

Этот файл нужен, чтобы безопасно подключить Claude к крупной миграции
`loft_hall_internship_unified` на PostgreSQL. Не хранить здесь секреты,
пароли, Telegram-токены, реальные `.env` значения или дампы персональных данных.

## Главное

Проект уже в production. Claude нельзя давать задачу в стиле "сделай миграцию
как считаешь нужным" без ограничений. Работать только маленькими шагами,
только в миграционной копии, только через отдельную ветку и PR.

Роль Claude: исполнитель ограниченного work package. Стратегия миграции,
порядок этапов, проценты прогресса и production cutover остаются за Codex.
Если Claude видит, что план стоит изменить, он должен написать предложение в
отчете, но не менять план сам.

## Где Работать

Основная интеграционная worktree Codex:

```text
/Users/a1/Desktop/Loft_Hall/Helper_bot/loft_hall_internship_unified_migration_integrate
```

Рабочая папка, которую можно отдавать Claude для отдельных feature-веток:

```text
/Users/a1/Desktop/Loft_Hall/Helper_bot/loft_hall_internship_unified_hall_sync
```

Важно: `loft_hall_internship_unified_hall_sync` может оставаться на последней
Claude-ветке после PR. Перед каждой новой итерацией Claude обязан сделать
`git fetch origin`, переключиться на `migration/postgres-foundation` и обновить
ее через `git pull --ff-only origin migration/postgres-foundation`.

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

Актуальный migration commit перед каждой новой итерацией брать командой:

```bash
git fetch origin
git rev-parse origin/migration/postgres-foundation
```

Текущий общий прогресс миграции:

```text
61%
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
- Не менять `docs/MIGRATION_EXECUTION_PLAN.md` без отдельного явного разрешения.
- Не менять `docs/POSTGRES_MIGRATION_ROADMAP.md` без отдельного явного
  разрешения.
- Не менять `docs/CODEX_HANDOFF.md` без отдельного явного разрешения.
- Не менять общий процент миграции. Процент обновляет Codex после ревью.
- Не менять порядок этапов миграции и критерии production cutover.

## Какую Ветку Создать Claude

Claude должен создать отдельную ветку от актуальной migration-ветки:

```bash
git fetch origin
git checkout migration/postgres-foundation
git pull --ff-only origin migration/postgres-foundation
git checkout -b migration/postgres-write-<command>-claude
```

PR потом открывать не в `main`, а в:

```text
migration/postgres-foundation
```

То есть:

```text
migration/postgres-write-<command>-claude -> migration/postgres-foundation
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

## Текущий Тип Задания Для Claude

Не "перевести все на Postgres", а реализовывать по одной бизнес-команде
PostgreSQL write layer без production-включения.

Уже интегрировано в `migration/postgres-foundation`:

- `create_shift`;
- `update_shift_capacity`;
- forward-переходы `set_application_status`;
- `assign_shift` только для `queue -> pending` на открытую неотмененную дату;
- `send_invites` state/events slice: создает рабочую группу, участников,
  переводит заявки в `invited`, пишет events, но еще не пишет notification
  outbox.

Следующий обязательный work package:

- закрыть notification/outbox gap для `send_invites`, чтобы приглашения не
  могли сохраниться в state без durable задачи на Telegram-уведомление.

Не брать без отдельного решения Codex:

- mentor reports;
- Telegram live delivery;
- full `/api/report`;
- production cutover;
- перенос уже назначенного/приглашенного стажера на другую дату;
- `Вернуть в новые заявки` через старый `set_application_status -> pending`.

Причина: эти сценарии меняют связи с рабочими группами, площадками, архивом и
уведомлениями. Их нельзя смешивать с простыми командами записи.

## Качество Prompt Для Claude

Prompt для Claude должен быть не коротким списком требований, а техническим
work package. В нем обязательно должны быть:

1. **Точка старта**: worktree, base branch, base commit и имя feature-ветки.
2. **Бизнес-смысл команды**: какой пользовательский сценарий она покрывает и
   какие сценарии сознательно не покрывает.
3. **JSON-reference**: какие функции старого runtime надо прочитать в
   `src/server.js`, и что нужно повторить в Postgres.
4. **Допустимые расхождения**: если Postgres path должен быть строже JSON,
   это должно быть явно написано в prompt, а не решено Claude по ходу.
5. **SQL-инварианты**: какие строки блокировать `FOR UPDATE`, какие таблицы
   менять, какие события писать, когда bump version, когда rollback.
6. **Data/PII/Telegram safety**: не читать прод-дампы без запроса, не трогать
   live delivery, не писать реальные уведомления.
7. **Запрещенные файлы**: `src/server.js` runtime wiring, production deploy,
   `.env`, `data/db.json`, стратегические docs с процентами.
8. **Тестовый контракт**: unit cases, live smoke, `npm test`,
   `npm run test:postgres`, `git diff --check`, safety check.
9. **Stop conditions**: когда Claude обязан остановиться и спросить, а не
   принимать архитектурное решение сам.
10. **Report For Codex Review**: полный блок для сверки фактов с diff.

Codex после каждой Claude-итерации обязан сверить не только тесты, но и
семантику команды относительно JSON runtime и `docs/DATA_MODEL.md`.

## Правило Перед Кодом

Перед любым редактированием Claude должен написать краткий iteration plan:

1. Какая ветка и base commit.
2. Какой этап из `docs/MIGRATION_EXECUTION_PLAN.md` он выполняет.
3. Какие файлы планирует менять.
4. Какие файлы точно не будет менять.
5. Какие тесты планирует запускать.

Если в процессе выяснилось, что нужно менять стратегические документы,
production deploy, Telegram routing или `main`, Claude должен остановиться и
вернуть вопрос пользователю/Codex.

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

## Отчет Для Codex После Каждой Итерации

В конце каждой итерации Claude обязан оставить отдельный блок:

```text
## Report For Codex Review

Branch:
Base commit:
Head commit:
PR:

Claimed scope:

Changed files:

What actually changed:

Tests run:

Tests not run and why:

Production safety:

Data/PII safety:

Telegram safety:

Potential risks:

Open questions:

Suggested next step:
```

Правило: Codex после этого должен сверить отчет с реальным `git diff`,
коммитами и тестами. Claude не должен считать работу принятой, пока Codex не
провел ревью.

Если Claude не успел закончить итерацию, он все равно оставляет этот блок и
явно пишет `Incomplete`, чтобы следующий агент не принял полуготовый код за
готовый.

## Готовый Prompt Для Claude: Следующая Итерация `send_invites_notifications_outbox`

```text
Ты подключаешься к крупной миграции LOFT HALL internship mini app с JSON
data/db.json на PostgreSQL.

Работай только в:
/Users/a1/Desktop/Loft_Hall/Helper_bot/loft_hall_internship_unified_hall_sync

Сначала синхронизируйся с foundation:

git fetch origin
git checkout migration/postgres-foundation
git pull --ff-only origin migration/postgres-foundation

Base commit должен быть актуальным head `migration/postgres-foundation`.
Если `git pull --ff-only` невозможен или ты не можешь перейти на foundation,
остановись и сообщи.

Создай ветку:
main не использовать; для этой итерации:
`migration/postgres-send-invites-outbox-claude`

PR должен быть:
migration/postgres-send-invites-outbox-claude -> migration/postgres-foundation

Не в main.

Ты не меняешь стратегию миграции. Запрещено менять без отдельного разрешения:
- docs/MIGRATION_EXECUTION_PLAN.md
- docs/POSTGRES_MIGRATION_ROADMAP.md
- docs/CODEX_HANDOFF.md
- docs/MIGRATION_DELIVERY_SCOREBOARD.md
- общий процент прогресса
- порядок этапов
- production cutover / rollback plan
- production deploy
- src/server.js runtime wiring
- Telegram chat routing / live delivery
- .env, data/db.json, db dumps, secrets
- public UI files

Если считаешь, что план надо изменить, не меняй его сам: напиши предложение в
отчете для Codex.

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

Задача этой итерации: закрыть только notification/outbox gap для уже
интегрированной PostgreSQL command `send_invites`.

Бизнес-смысл:
Рекрут выбирает дату, рабочую группу, площадку и список стажеров, нажимает
отправку приглашений. Postgres path уже создает invite group, привязывает
участников и переводит заявки в `invited`. Теперь нужно в той же транзакции
создавать durable `notifications(status='pending')` записи для личных
Telegram-уведомлений выбранным стажерам, чтобы после runtime cutover state не
мог сохраниться без задачи на доставку сообщения.

Что команда НЕ должна делать в этой итерации:
- не отправлять реальные Telegram-сообщения;
- не создавать live worker и не включать delivery loop;
- не менять `/api/state` runtime wiring в `src/server.js`;
- не трогать mentor report result;
- не менять UI;
- не решать перенос уже приглашенного стажера на другую дату.

JSON-reference, который нужно прочитать и сопоставить:
- `src/server.js`: текущий обработчик/action `send_invites` и то, как сейчас
  формируется личное уведомление стажеру после отправки рабочей группы;
- `src/booking-state-events.js`: события для invite group / invited status;
- `src/booking-state-machine.js`: статусы, которые держат места и стадийные
  правила;
- `docs/DATA_MODEL.md`: поля `applications`, `inviteGroups`,
  `inviteGroup.members`, venue/group link поля;
- `src/postgres/booking-command-contracts.js`: контракт `send_invites`.

Если Postgres-реализация должна быть строже JSON runtime, не решай это молча.
Сначала явно опиши расхождение в iteration plan и в `Open questions`. Без
отдельного подтверждения Codex не расширяй и не сужай бизнес-семантику.

Ожидаемая PostgreSQL-логика:
- actor role: recruiter-only;
- сохранить текущую `sendInvitesInPostgres` state/event семантику;
- в той же transaction, после валидации selected applications и до commit,
  вставить `notifications` rows для каждого выбранного trainee, у которого есть
  Telegram chat/user target в schema/read model;
- notification payload должен быть idempotent и достаточно самодостаточным:
  action/command `send_invites`, application legacy id, shift legacy id,
  invite group legacy id, venue id, group link, version/cause, message template
  data без секретов;
- использовать stable idempotency key на основе action + shift_id + venue_id +
  link + sorted_member_ids + конкретный application_id или эквивалентный
  уникальный ключ, чтобы повторный безопасный retry не создавал дубль;
- если нужного уникального ограничения/колонки в schema нет, не выдумывай
  рискованный runtime workaround: опиши минимальную migration/schema правку и
  покрой тестом;
- dry-run/live отправку не делать, только durable outbox rows.

Обязательные тесты:
- unit success: existing invite group/app/event assertions still pass and one
  pending notification row is created per selected trainee;
- idempotency: same logical notification key cannot create duplicates;
- stale `baseVersion` / validation failures rollback and do not create
  notifications;
- selected app without Telegram target is handled by an explicit policy
  (`skipped` notification row or validation), documented and tested;
- adapter still routes `send_invites`;
- live PostgreSQL smoke inside `npm run test:postgres` verifies notification
  rows appear and no real Telegram call is made.

Проверки:
- npm test
- npm run test:postgres
- git diff --check
- node scripts/check-migration-pr-safety.js migration/postgres-foundation HEAD

Stop conditions:
- если нужно менять `src/server.js`, production deploy, Telegram live delivery,
  стратегические docs или проценты — остановись;
- если схема PostgreSQL не содержит нужного поля/уникального ключа для durable
  notifications/idempotency — остановись и опиши точную минимальную schema
  правку;
- если JSON runtime допускает сценарий, который кажется опасным в Postgres,
  остановись и вынеси вопрос в `Open questions`, не меняя семантику сам.

Перед кодом напиши iteration plan:
1. ветка и base commit;
2. какой JSON-reference ты нашел для `send_invites`;
3. какие Postgres tables/locks/events будешь менять;
4. какие файлы планируешь менять;
5. какие файлы точно не будешь менять;
6. какие тесты планируешь запускать;
7. какие потенциальные semantic gaps видишь заранее.

Не обновляй процент миграции. `docs/CODEX_PROGRESS.md` можно обновлять только
фактическим worklog по своей итерации, без изменения стратегии и процентов.

Каждый отчет начинай с:
"Прогресс миграции: X%."

Перед завершением запусти:
npm test
git diff --check

Если менялись Postgres-инструменты, также попробуй:
npm run test:postgres

В конце обязательно оставь блок:
## Report For Codex Review

Заполни в нем:
- Branch;
- Base commit;
- Head commit;
- PR;
- Claimed scope;
- Changed files;
- Exact behavior implemented;
- JSON behavior matched / intentionally stricter behavior;
- Tests run;
- Tests not run and why;
- Production safety;
- Data/PII safety;
- Telegram safety;
- Potential risks;
- Open questions;
- Suggested next step.

Не заявляй, что production готов к миграции. Цель сейчас - безопасное
расширение migration foundation.
```
