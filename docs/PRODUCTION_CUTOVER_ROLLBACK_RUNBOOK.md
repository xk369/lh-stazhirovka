# Production Cutover And Rollback Runbook

Этот документ описывает финальный переход центра стажировок с JSON на
PostgreSQL и обратный ход, если после cutover что-то пошло не так. Он не
разрешает деплой сам по себе: production переключается только после отдельного
явного подтверждения владельца проекта.

## Жесткие правила

1. Production до согласованного окна остается на `BOOKING_STORAGE_MODE=json`.
2. Cutover нельзя начинать, если migration staging не обновлен до финального
   коммита и не прошел role QA на свежей копии production `data/db.json`.
3. Перед импортом production JSON в PostgreSQL база должна быть пустой или
   новой. Импорт поверх существующей production PostgreSQL-БД запрещен.
4. Telegram в staging всегда `TELEGRAM_DELIVERY_MODE=dry_run`.
5. Telegram в production становится `live` только после успешного импорта,
   parity-check, health-check и ручного go/no-go.
6. Автоматическая связка кандидатов разрешена только по `telegram_user_id`.
   ФИО, телефон и `@username` используются для поиска и ручного review, но не
   для автоматической склейки профилей.
7. В первые часы после cutover запрещены продуктовые правки, не связанные с
   миграцией, наблюдением или rollback.

## Что Считается Успешным Cutover

- production приложение запущено с `BOOKING_STORAGE_MODE=postgres`;
- `/api/health` показывает `bookingStorageWritable=true`;
- `/api/state` открывается для рекрутера и возвращает актуальную версию;
- запись стажера, назначение даты, подтверждение, отправка группы, отчет
  стажера и отчет наставника проходят без ошибок;
- Telegram delivery работает в ожидаемом режиме `live`;
- `notifications` outbox не копит `failed`/зависшие `sending`;
- JSON backup сохранен и не перезаписан после переключения;
- есть PostgreSQL dump сразу после импорта и после окончания наблюдения.

## Stop-The-Line Условия

Если любой пункт срабатывает до включения live production, cutover
останавливается:

- staging QA не прошел полностью;
- parity-check не совпал с исходным JSON;
- миграции применились не все или checksum уже примененной миграции отличается;
- production backup не создан или не проверен;
- неясно, какой commit/branch сейчас развернут;
- `/api/health` не показывает ожидаемый storage/delivery mode;
- нет ответственного человека, который может принять go/no-go.

Если любой пункт срабатывает после включения production PostgreSQL, запускается
rollback decision:

- рекрутер не может открыть кабинет или state;
- стажеры не могут отправлять заявки;
- массовые `500`/`409` вне ожидаемых stale-version конфликтов;
- Telegram уведомления массово не доставляются;
- outbox зависает в `sending` или быстро растет `failed`;
- появились признаки потери заявок, дублей активных дат или неправильных
  статусов;
- заметили ошибочную связку кандидатов/стажеров.

## Backup Inventory

Перед cutover создается отдельная папка:

```bash
BACKUP_DIR=/opt/loft-hall-internship-unified/backups/cutover-$(date +%Y%m%d-%H%M%S)
mkdir -p "$BACKUP_DIR"
chmod 700 "$BACKUP_DIR"
```

В папке должны быть:

```bash
cp -a /opt/loft-hall-internship-unified/data/db.json "$BACKUP_DIR/db.json.before-cutover"
cp -a /opt/loft-hall-internship-unified/.env "$BACKUP_DIR/env.before-cutover"
git -C /opt/loft-hall-internship-unified rev-parse HEAD > "$BACKUP_DIR/git-head.before-cutover.txt"
docker inspect loft-internship-unified > "$BACKUP_DIR/app-container.before-cutover.inspect.json"
docker compose -f /opt/loft-hall-internship-unified/docker-compose.yml ps > "$BACKUP_DIR/docker-ps.before-cutover.txt"
```

Если production PostgreSQL уже поднимался для rehearsal, дополнительно:

```bash
docker compose -f /opt/loft-hall-internship-unified/deploy/docker-compose.migration.yml exec -T postgres-migration \
  pg_dump -U loft_internship -d loft_internship_migration \
  > "$BACKUP_DIR/postgres.before-cutover.dump"
```

Проверка backup обязательна:

```bash
test -s "$BACKUP_DIR/db.json.before-cutover"
test -s "$BACKUP_DIR/env.before-cutover"
test -s "$BACKUP_DIR/git-head.before-cutover.txt"
```

## Финальный Staging Rehearsal

1. Обновить migration staging до финального commit.
2. Скопировать свежий production `data/db.json` только в staging.
3. Пересоздать только staging PostgreSQL volume или использовать новый
   versioned volume.
4. Применить миграции:

```bash
npm run db:migrate
```

5. Импортировать JSON:

```bash
npm run db:import-json -- --source /migration-source/db.json
```

6. Проверить parity:

```bash
npm run db:verify-parity -- --source /migration-source/db.json
```

7. Импортировать текущий sobes JSON, если rehearsal проверяет общую цепочку
   `собес -> кандидат -> стажировка`:

```bash
npm run db:import-interviews-json -- --source /migration-source/interviews.json
```

Sobes-импорт запускается только после импорта стажировок. Он переиспользует
`candidate_profiles` по `telegram_user_id`, но не склеивает людей по ФИО,
телефону или username. Слабые совпадения должны появиться в
`candidate_identity_review_items`.

8. Запустить staging app с:

```env
BOOKING_STORAGE_MODE=postgres
TELEGRAM_DELIVERY_MODE=dry_run
SUPPRESS_TRAINEE_NOTIFICATIONS=yes
```

9. Прогнать `scripts/postgres-staging-role-qa.js`.
10. Прогнать notification worker dry-run и убедиться, что нет live-отправки.
11. Проверить новые candidate/interview таблицы:

```sql
select count(*) from candidate_profiles;
select count(*) from interview_slots;
select count(*) from interview_participants;
select count(*) from candidate_resource_deliveries;
select count(*) from candidate_link_clicks;
select status, count(*) from candidate_identity_review_items group by status;
```

На свежем импорте стажировок `candidate_profiles` должен соответствовать
количеству уникальных стабильных Telegram-профилей плюс отдельным legacy
заявкам без Telegram ID. Совпадения по слабым полям не должны уменьшать это
количество.

## Production Cutover План

### Фаза 0: Freeze

1. Назначить короткое окно, когда рекрутеры не создают новые даты и не меняют
   статусы.
2. Зафиксировать время начала freeze.
3. Проверить, что production сейчас на JSON:

```bash
curl -fsS http://127.0.0.1:3500/api/health
```

Ожидаемо до cutover:

```json
{
  "bookingStorageMode": "json"
}
```

### Фаза 1: Backup

1. Создать `BACKUP_DIR`.
2. Скопировать `data/db.json`, `.env`, commit hash, docker inspect.
3. Проверить размер и читаемость `db.json`.
4. Ничего не удалять из `data/`.

### Фаза 2: PostgreSQL Prepare

1. Поднять production PostgreSQL отдельно.
2. Проверить `pg_isready`.
3. Применить миграции.
4. Импортировать ровно тот `db.json`, который лежит в backup.
5. Запустить parity-check против backup-файла.
6. Сделать dump после импорта:

```bash
pg_dump "$DATABASE_URL" > "$BACKUP_DIR/postgres.after-import.dump"
```

### Фаза 3: App Switch

1. Изменить только production env-переменные, необходимые для storage:

```env
BOOKING_STORAGE_MODE=postgres
DATABASE_URL=...
POSTGRES_SSL_MODE=disable
TELEGRAM_DELIVERY_MODE=live
```

2. Пересобрать/перезапустить production app.
3. Проверить `/api/health`.
4. Проверить `/api/state` под рекрутером.
5. Выполнить короткий live smoke:
   - открыть кабинет рекрута;
   - открыть реестр;
   - создать тестовую будущую дату, если владелец разрешил;
   - отменить/закрыть тестовую дату, если она создавалась;
   - проверить, что JSON-файл больше не является write target.

### Фаза 4: Observation

Первые 15 минут:

- каждые 2-3 минуты проверять `/api/health`;
- проверять логи контейнера;
- проверять `notifications` на `failed` и зависшие `sending`;
- не делать массовые рассылки без необходимости.

Первый час:

- проверить реальные действия рекрутера;
- проверить одну запись/очередь;
- проверить одну корректировку статуса;
- проверить outbox после каждой Telegram-операции.

Конец окна:

```bash
pg_dump "$DATABASE_URL" > "$BACKUP_DIR/postgres.after-observation.dump"
```

## Rollback Decision Tree

### Rollback A: До Первой Production PostgreSQL Записи

Используется, если приложение не стартовало, health не прошел или ошибка
обнаружена сразу после переключения, до действий пользователей.

1. Вернуть в `.env`:

```env
BOOKING_STORAGE_MODE=json
```

2. Убедиться, что `DATA_DIR` указывает на прежний каталог.
3. Перезапустить app.
4. Проверить `/api/health`.
5. Открыть кабинет рекрута и сверить state.
6. Сохранить PostgreSQL dump для диагностики, базу не удалять.

Ожидаемая потеря данных: нулевая, потому что после cutover еще не было
PostgreSQL-only записей.

### Rollback B: После Небольшого Количества Записей

Используется в первые минуты, если уже были 1-2 действия и владелец проекта
подтверждает, что эти действия можно повторить руками.

1. Зафиксировать точное время rollback decision.
2. Сделать emergency dump:

```bash
pg_dump "$DATABASE_URL" > "$BACKUP_DIR/postgres.emergency-before-json-rollback.dump"
```

3. Выгрузить список новых событий после cutover:

```sql
select created_at, event_type, actor_type, application_id, payload
from application_events
where created_at >= :cutover_started_at
order by created_at;

select created_at, event_type, actor_type, candidate_profile_id, payload
from candidate_events
where created_at >= :cutover_started_at
order by created_at;
```

4. Вернуть `BOOKING_STORAGE_MODE=json`.
5. Перезапустить app.
6. Рекрутер руками повторяет потерянные действия по списку событий, если это
   согласовано.

Ожидаемая потеря данных: возможна для PostgreSQL-only действий после cutover.
Rollback B допустим только если эти действия малочисленны и вручную
восстановимы.

### Rollback C: После Активной Работы В PostgreSQL

Если после cutover прошло много времени или было много действий, простой
возврат к JSON уже опасен: JSON backup устарел.

В этом случае:

1. Не переключаться на JSON автоматически.
2. Остановить новые массовые операции в UI.
3. Оставить app в текущем режиме, если чтение работает.
4. Снять dump PostgreSQL.
5. Разобрать конкретный дефект и выпускать hotfix поверх PostgreSQL.
6. JSON rollback использовать только после отдельного решения владельца проекта
   и ручного плана переноса новых действий.

Ожидаемая потеря данных при тупом JSON rollback: высокая. По умолчанию этот
вариант запрещен.

## Проверки Данных После Cutover

Минимальные SQL-запросы:

```sql
select status, count(*) from applications group by status order by status;
select count(*) from shifts;
select count(*) from invite_groups;
select count(*) from invite_group_members;
select count(*) from mentor_reports where voided_at is null;
select status, count(*) from notifications group by status order by status;
select current_stage, count(*) from candidate_profiles group by current_stage order by current_stage;
select status, count(*) from candidate_identity_review_items group by status order by status;
```

Проверки инвариантов:

```sql
select count(*) as applications_without_profile
from applications
where candidate_profile_id is null
  and trainee_telegram_user_id is not null;

select trainee_telegram_user_id, count(*)
from applications
where trainee_telegram_user_id is not null
  and status in ('pending', 'queue', 'confirmed', 'invited', 'feedback')
group by trainee_telegram_user_id
having count(*) > 1;

select count(*) as queue_without_join_time
from applications
where status = 'queue'
  and queue_joined_at is null;

select count(*) as non_queue_with_join_time
from applications
where status <> 'queue'
  and queue_joined_at is not null;

select interview_date, interview_time, count(*)
from interview_slots
where status in ('open', 'closed')
group by interview_date, interview_time
having count(*) > 1;
```

Ожидаемые значения для двух счетчиков queue-time: `0` и `0`. Импорт обязан
backfill-ить старые `queue`-заявки без `queueJoinedAt` из `createdAt`, а если
его нет - из root `updatedAt`, поэтому `queue_without_join_time > 0`
блокирует cutover. Любая строка в остальных инвариантах требует ручной
проверки до закрытия окна.

## Telegram/Outbox Проверки

До включения live:

```sql
select status, count(*) from notifications group by status;
```

После live smoke:

```sql
select id, type, status, error, attempts, created_at, updated_at
from notifications
where status in ('failed', 'sending')
order by updated_at desc
limit 20;
```

Если есть `failed`, сначала понять причину. Не запускать worker циклом вслепую,
чтобы не создать повторную рассылку.

## Что Не Делаем Во Время Cutover

- не меняем дизайн и фронтовые фичи;
- не добавляем новые статусы;
- не меняем Telegram-тексты;
- не включаем собес-приложение на ту же production БД без отдельного rehearsal;
- не чистим archive/data/backups;
- не включаем автодедупликацию по телефону, ФИО или username;
- не делаем `git reset --hard` и не удаляем volumes как способ rollback.

## Go/No-Go Перед Production

Go только если все пункты зеленые:

- ветка закоммичена и запушена;
- PR прошел safety-check;
- локально прошли `npm test` и `npm run test:postgres`;
- migration staging обновлен до финального commit;
- staging импортировал свежий production JSON;
- staging parity-check прошел;
- staging role QA прошел;
- notification worker dry-run прошел;
- backup production JSON и `.env` создан и проверен;
- владелец проекта подтвердил окно и допустимый rollback level.

No-go, если хотя бы один пункт не выполнен.

## Что Остается После Успешного Cutover

1. Держать JSON backup минимум до подтвержденного полного рабочего цикла.
2. Сохранять PostgreSQL dumps после ключевых окон наблюдения.
3. Обновить handoff-документы уже после фактического production switch.
4. Только после стабилизации подключать runtime собесов к этим же таблицам.
5. Любые подозрительные совпадения кандидатов вести через
   `candidate_identity_review_items`, а не через автоматическую склейку.
