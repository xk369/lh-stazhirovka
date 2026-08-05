# Data Model: запись на стажировку и отчеты

Этот документ описывает текущую модель данных проекта `loft_hall_internship_unified`: какие поля есть, за что они отвечают, какие значения допустимы и как сущности связаны между собой.

Актуальный production-источник истины для записи на стажировку - JSON-файл `data/db.json` на сервере. Целевая схема миграции описана в `db/migrations/001_initial.sql`: она раскладывает тот же бизнес-state в PostgreSQL-таблицы, добавляет аудит и outbox, но production пока остается на JSON. Сервер читает и нормализует state в `src/server.js`. Фронт может хранить локальные черновики в `localStorage`, но они не считаются базой.

## 1. Корень booking-state

В `data/db.json` хранится объект:

```json
{
  "version": 1,
  "updatedAt": "2026-07-26T18:00:00.000Z",
  "shifts": [],
  "applications": [],
  "inviteGroups": []
}
```

| Поле | Тип | Где хранится | За что отвечает |
| --- | --- | --- | --- |
| `version` | positive integer | server state | Версия state для защиты от гонок. Каждый успешный `POST /api/state` увеличивает ее на 1. |
| `updatedAt` | ISO datetime | server state | Когда state последний раз был изменен сервером. |
| `shifts` | array | server state | Даты стажировок, созданные рекрутом. |
| `applications` | array | server state | Все заявки стажеров и их путь по этапам. |
| `inviteGroups` | array | server state | Факты отправки рабочих групп: дата, площадка, ссылка, состав стажеров. |

`version` и `updatedAt` относятся ко всему state, а не к отдельной заявке. Поэтому клиент обязан отправлять `baseVersion` при изменениях. Если версия устарела, сервер возвращает `409 BOOKING_VERSION_CONFLICT`.

## 2. `shifts`: дата стажировки

`shift` - одна дата стажировки, которую создает рекрут.

```json
{
  "id": 1784876924988,
  "date": "2026-07-26",
  "seats": 4,
  "open": true,
  "canceled": false,
  "canceledAt": ""
}
```

| Поле | Тип | Обязательное | За что отвечает |
| --- | --- | --- | --- |
| `id` | positive integer | да | Уникальный ID даты. На него ссылается `applications.shiftId` и `inviteGroups.shiftId`. |
| `date` | `YYYY-MM-DD` | да | Дата стажировки. Нельзя создать дату в прошлом. Дубликаты дат запрещены. |
| `seats` | integer 1-30 | да | Количество мест на дату. Нельзя уменьшить ниже уже занятых мест. |
| `open` | boolean | да | Дата открыта для записи/работы рекрута. |
| `canceled` | boolean | да | Дата отменена рекрутом. |
| `canceledAt` | string | нет | ISO-время отмены даты. Пусто, если дата не отменялась. |

### Derived-поля shift

Эти поля сервер добавляет при выдаче `/api/state`, но они не являются ручной базой:

| Поле | Тип | Как считается |
| --- | --- | --- |
| `bookedSeats` | integer | Количество заявок на эту дату со статусами, занимающими место. |
| `remainingSeats` | integer | `seats - bookedSeats`, но не меньше 0. |

Место занимают статусы:

- `pending`;
- `confirmed`;
- `invited`;
- `feedback`;
- `passed`;
- `failed`;
- `noshow`.

`queue` место не занимает, потому что у заявки нет даты. Исключение в новой цепочке - активный `assignmentOffer`: пока рекрут ждет ответ стажера на предложенную дату, место считается временно занятым на 1 час.

## 3. `applications`: заявка стажера

`application` - центральная сущность системы. Через нее связаны запись стажера, рекрут, рабочая группа, отчет наставника, итог и реестр.

```json
{
  "id": 1783949144486,
  "shiftId": 1784876924988,
  "name": "Вишнякова Татьяна Владимировна",
  "phone": "+7 999 123-45-67",
  "training": "passed",
  "trainingDate": "2026-07-20",
  "attempt": "first",
  "limits": "Удобно после 17:00",
  "status": "invited",
  "comment": "",
  "recruiterQueueComment": "",
  "assignmentOffer": null,
  "inviteGroupId": 1784910878008,
  "venueId": "loft5_small",
  "groupLink": "https://t.me/+...",
  "telegramCode": "tg...",
  "telegramChatId": "1037042172",
  "telegramUserId": "1037042172",
  "telegramUsername": "tanyxess",
  "candidateReport": false,
  "mentorReport": false,
  "mentorReportAt": "",
  "mentorReporterTelegramUserId": "",
  "mentorDecision": "",
  "mentorReportVenueId": "",
  "mentorReportVenue": "",
  "mentorReportLoft": "",
  "mentorReportHall": "",
  "mentorCommentForTrainee": "",
  "mentorCommentSentAt": "",
  "mentorCommentDeliveryStatus": "",
  "mentorCommentDeliveryError": "",
  "experience": "",
  "createdAt": "2026-07-26T12:00:00.000Z"
}
```

### 3.1 Идентификация стажера

| Поле | Тип | За что отвечает |
| --- | --- | --- |
| `id` | positive integer | Уникальный ID заявки. На него ссылаются `inviteGroups.memberIds[]`, отчеты наставников и команды рекрута. |
| `name` | string, max 120 | ФИО стажера. Обязательное поле. |
| `phone` | string, max 40 | Телефон, который стажер указал при регистрации в боте. Обязателен для стажера. |
| `telegramCode` | string, max 100 | Локальный код связывания старой заявки с Telegram, если нужен fallback. |
| `telegramChatId` | numeric string | Chat ID для личных сообщений стажеру. Если пусто, уведомление пропускается. |
| `telegramUserId` | numeric string | Telegram user ID владельца заявки. Используется для доступа стажера только к своим данным. |
| `telegramUsername` | string 3-32 | Username без `@`. В интерфейсе отображается как `@username`. |
| `createdAt` | string | Когда заявка была создана. Может отсутствовать у старых записей. |

`telegramChatId` и `telegramUserId` обычно совпадают для обычного пользователя, но это разные смыслы: `userId` нужен для авторизации заявки, `chatId` - для отправки личных сообщений.

### 3.2 Профиль стажировки

| Поле | Тип | Допустимые значения | За что отвечает |
| --- | --- | --- | --- |
| `training` | string | `passed`, `not_passed` | Прошел ли стажер банкетное обслуживание. |
| `trainingDate` | `YYYY-MM-DD` или `""` | дата | Дата прохождения обучения. Обязательна, если `training = passed`. Если `training = not_passed`, очищается. |
| `attempt` | string | `first`, `repeat` | Первая или повторная стажировка. |
| `limits` | string, max 600 | свободный текст | Когда удобно выйти / ограничения стажера. В реестре скрыто, чтобы не перегружать карточку. |
| `experience` | string | `experienced` или `""` | Рекрут вручную отмечает «Опытный стажер» только после статуса `passed`. Старые значения `yes/no` считаются legacy и не используются как актуальный признак. |

### 3.3 Связь с датой и статусом

| Поле | Тип | За что отвечает |
| --- | --- | --- |
| `shiftId` | positive integer или `null` | Связь с датой стажировки: `applications.shiftId -> shifts.id`. Если `null`, заявка в предварительной записи. |
| `status` | enum | Текущий этап заявки. Основной драйвер интерфейса и действий. |
| `comment` | string, max 1200 | Внутренний комментарий рекрута по заявке после назначения/стажировки. Ранее мог называться `recruiterComment`. |
| `recruiterQueueComment` | string, max 600 | Внутренний комментарий рекрута именно по очереди. Видит только рекрут; стажеру не отдается. Очищается, когда кандидат выходит из очереди или запрос истекает. |
| `assignmentOffer` | object или `null` | Активный запрос подтверждения даты стажером. В JSON живет внутри заявки, в PostgreSQL вынесен в `application_assignment_offers`. |

### 3.4 Статусы заявки

| Статус | Отображение | Кто ставит | Что означает |
| --- | --- | --- | --- |
| `queue` | Предварительная запись | стажер или рекрут | Стажер в очереди без даты. `shiftId = null`, место не занимает. |
| `queue_expired` | Запрос истек | система | Рекрут предложил дату, но стажер не ответил за 1 час. Заявка выходит из активной очереди, место освобождается, стажер может встать в очередь заново без `repeat`. |
| `pending` | Заявка отправлена | legacy/direct assignment path | Есть дата, но выход еще не подтвержден. Новый основной путь старается не создавать `pending` при регистрации: стажер идет в `queue`, а после согласия на дату сразу становится `confirmed`. |
| `confirmed` | Выход подтвержден | стажер через Telegram-кнопку или рекрут | Дата закреплена, но рабочая группа еще не отправлена. |
| `invited` | Приглашение отправлено | рекрут через отправку группы | Стажеру отправлены площадка, ссылка и инструкции. |
| `feedback` | Ждем отчет | рекрут нажал `Вышел` | Стажер вышел, наставник должен отправить отчет. |
| `passed` | Стажировка пройдена | отчет наставника | Финал: наставник решил, что стажировка пройдена. |
| `failed` | Нужна повторная запись | отчет наставника | Финал: наставник решил, что нужна повторная стажировка. |
| `noshow` | Выход не состоялся | рекрут нажал `Не вышел` | Финал: стажер не вышел на смену. |

Legacy-маппинг при чтении старых данных:

- `new -> pending`;
- `waiting -> invited`;
- `report -> feedback`.

Откат на этап назад:

- `feedback -> invited`;
- `passed -> feedback`, старый отчет наставника очищается;
- `failed -> feedback`, старый отчет наставника очищается;
- `noshow -> invited`.

`assignmentOffer` в JSON:

| Поле | Тип | За что отвечает |
| --- | --- | --- |
| `token` | string | Одноразовый токен ответа на запрос даты. Используется endpoint `/api/assignment-offer/respond`. |
| `shiftId` | positive integer | Дата, которую рекрут предложил кандидату. |
| `requestedAt` | ISO datetime | Когда рекрут создал запрос. |
| `expiresAt` | ISO datetime | Когда запрос перестает быть активным. Сейчас TTL - 1 час. |
| `requestedByTelegramUserId` | numeric string или `""` | Telegram user ID рекрутера, который отправил запрос. |
| `messageChatId` | numeric string или `""` | Chat ID сообщения с кнопками, если Telegram вернул данные доставки. |
| `messageId` | positive integer или `null` | Telegram `message_id`, чтобы после ответа/истечения убрать кнопки через edit message. |

### 3.5 Связь с рабочей группой и площадкой

| Поле | Тип | За что отвечает |
| --- | --- | --- |
| `inviteGroupId` | positive integer или `null` | Связь с отправленной группой: `applications.inviteGroupId -> inviteGroups.id`. |
| `venueId` | string или `null` | ID площадки, выбранной рекрутом при отправке рабочей группы. |
| `groupLink` | Telegram URL или `""` | Ссылка на рабочую группу. Дублируется в заявке для быстрого доступа, даже если есть `inviteGroupId`. |
| `candidateReport` | boolean | Флаг отчета самого стажера. Сейчас отчет стажера уходит в группу, но этот флаг не является закрывающим этапом цепочки. |

`venueId` проверяется при отчете наставника: наставник не должен отправить отчет по стажеру в другой площадке.

### 3.6 Поля отчета наставника

| Поле | Тип | За что отвечает |
| --- | --- | --- |
| `mentorReport` | boolean | Есть ли отправленный отчет наставника по заявке. Если `true`, стажер исчезает из списка наставника. |
| `mentorReportAt` | ISO datetime или `""` | Когда отчет наставника был применен к заявке. |
| `mentorReporterTelegramUserId` | numeric string или `""` | Telegram user ID наставника, который отправил отчет. |
| `mentorDecision` | string | Итог: `Стажировка пройдена` или `Требуется повторная стажировка`. |
| `mentorReportVenueId` | string | Площадка отчета наставника по ID. Обычно совпадает с `venueId`. |
| `mentorReportVenue` | string | Человеческое название площадки в отчете, например `LOFT #5 · SMALL`. |
| `mentorReportLoft` | string | Автоматически подтянутый лофт, например `LOFT #5`. |
| `mentorReportHall` | string | Зал, выбранный наставником внутри лофта, например `SMALL` или `BLACKWOOD`. |
| `mentorCommentForTrainee` | string, max 1200 | Внутренний комментарий наставника, сохраненный в заявке. В личное сообщение стажеру полный комментарий не отправляется. |
| `mentorCommentSentAt` | ISO datetime или `""` | Когда стажеру отправили личное сообщение с итогом. |
| `mentorCommentDeliveryStatus` | enum или `""` | Статус доставки личного сообщения стажеру: `sent`, `skipped`, `failed`. |
| `mentorCommentDeliveryError` | string, max 240 | Причина `skipped/failed`, например нет `telegramChatId` или ошибка Telegram. |

Важно: если добавляется новое поле в заявку, его обязательно нужно добавить в `normalizeApplicationForWrite`. Нормализатор не делает `...app` в итоговый объект, а собирает разрешенные поля вручную. Неизвестные поля будут отброшены при следующей записи state.

## 4. `inviteGroups`: отправленные рабочие группы

`inviteGroup` фиксирует факт отправки рабочей группы одному или нескольким стажерам.

```json
{
  "id": 1784910878008,
  "shiftId": 1784876924988,
  "venueId": "loft5_small",
  "link": "https://t.me/+...",
  "memberIds": [1783949144486],
  "sentAt": "2026-07-26T14:00:00.000Z"
}
```

| Поле | Тип | За что отвечает |
| --- | --- | --- |
| `id` | positive integer | Уникальный ID отправленной рабочей группы. |
| `shiftId` | positive integer | Дата стажировки: `inviteGroups.shiftId -> shifts.id`. |
| `venueId` | string | Площадка, выбранная рекрутом. |
| `link` | Telegram URL | Ссылка на рабочую группу. Сервер принимает только `t.me` / `telegram.me`. |
| `memberIds` | array of positive integers | Список заявок, приглашенных этим действием: `memberIds[] -> applications.id`. |
| `sentAt` | ISO datetime | Когда приглашение было отправлено. |

Одна `inviteGroup` может содержать несколько стажеров, если они идут в одну рабочую группу на одну дату и площадку. При отправке приглашений каждая заявка из `memberIds` получает:

- `status = invited`;
- `inviteGroupId = inviteGroup.id`;
- `venueId = inviteGroup.venueId`;
- `groupLink = inviteGroup.link`.

## 5. Площадки и залы

`venueId` - технический ID площадки. Он нужен, чтобы связать выбор рекрута, шаблон рабочей группы и отчет наставника.

| `venueId` | Отображение | Залы для наставника |
| --- | --- | --- |
| `loft1` | LOFT#1 | `AVANTAGE`, `CHATEAU`, `ROYAL BLANC` |
| `loft2` | LOFT#2 | `ROCKFELLER&ROTHSHILD\`S HALL`, `BACKYARD` |
| `loft3` | LOFT#3 | `MONTBLANC`, `GRACE`, `RATUSHA` |
| `loft4` | LOFT#4 | `ANDY&CYNDY`, `MONDRIAN`, `BANKSY`, `LONG&ITTEN` |
| `loft5_contrabanda` | LOFT#5 CONTRABANDA | фиксированный зал `CONTRABANDA` |
| `loft5_small` | LOFT#5 SMALL | фиксированный зал `SMALL` |
| `loft8` | LOFT#8 | `MAIN HALL`, `WELCOME HALL`, `ROSEWOOD HALL`, `MILINIS HALL` |
| `loft10` | LOFT#10 (TAU) | фиксированный зал `MAIN HALL` |
| `birch` | THE BIRCH | `AMBERWOOD`, `BLACKWOOD`, `MANGO`, `MAHOGANY` |
| `metelitsa` | МЕТЕЛИЦА | зал не выбирается |

Цепочка площадки:

1. Рекрут выбирает `venueId` при отправке рабочей группы.
2. `venueId` сохраняется в `inviteGroups` и в каждой заявке.
3. Наставник выбирает стажера из списка.
4. Форма наставника автоматически понимает лофт по `application.venueId`.
5. Если у лофта несколько залов, наставник выбирает только зал внутри этого лофта.
6. Сервер проверяет, что `mentorTraineeResult.venueId` совпадает с `application.venueId`, а зал входит в разрешенный список.
7. После отчета в заявку сохраняются `mentorReportVenueId`, `mentorReportVenue`, `mentorReportLoft`, `mentorReportHall`.

## 6. Связи между сущностями

### Главные связи

```text
shifts.id
  <- applications.shiftId
  <- inviteGroups.shiftId

applications.id
  <- inviteGroups.memberIds[]
  <- /api/report applicationId

inviteGroups.id
  <- applications.inviteGroupId

applications.telegramUserId / telegramChatId
  <- Telegram initData user.id
  -> личные Telegram-уведомления
```

### Один shift

Одна дата `shift` может иметь много заявок:

- новые заявки `pending`;
- подтвержденные `confirmed`;
- приглашенные `invited`;
- ожидающие отчет `feedback`;
- финальные `passed`, `failed`, `noshow`.

### Одна application

Одна заявка может:

- быть в очереди без даты: `shiftId = null`, `status = queue`;
- быть назначена на одну дату: `shiftId = shifts.id`;
- быть включена максимум в одну актуальную рабочую группу: `inviteGroupId = inviteGroups.id`;
- получить максимум один актуальный отчет наставника: `mentorReport = true`.

Если рекрут откатывает `passed/failed` на этап назад, старый отчет наставника очищается, чтобы наставник мог отправить новый отчет.

### Одна inviteGroup

Одна рабочая группа может включать много заявок через `memberIds`. Это нужно для шаблонов: несколько стажеров в одной рабочей группе должны попадать в одно сообщение, а не в несколько отдельных сообщений.

## 7. Локальные поля фронта

Эти поля не являются серверной базой. Они живут в `localStorage` или текущем JS-state.

### `profile`

Черновик формы стажера:

| Поле | За что отвечает |
| --- | --- |
| `name` | ФИО в форме записи. |
| `phone` | Телефон в форме записи. |
| `training` | Выбор банкетного обслуживания. |
| `trainingDate` | Дата обучения, если обучение пройдено. |
| `attempt` | Первая/повторная стажировка. |
| `limits` | Ограничения/удобное время. |
| `telegramCode` | Локальный код связывания. |
| `activeAppId` | Какая заявка сейчас считается активной для блока «Мой статус». |

### `inviteDraft`

Черновик раздела `Группы` у рекрута:

| Поле | За что отвечает |
| --- | --- |
| `shiftId` | Выбранная дата для отправки приглашений. |
| `venueId` | Выбранная площадка. |
| `link` | Введенная ссылка на рабочую группу. |
| `memberIds` | Кого рекрут выбрал для приглашения. |
| `workgroupManagers` | Менеджеры для шаблонов рабочих групп, ключ строится на группе/ссылке/дате. |

`inviteDraft` помогает не терять ввод в интерфейсе, но серверным источником истины становится только `inviteGroups` после действия `send_invites`.

## 8. Payload отчета наставника

Когда наставник отправляет отчет, фронт передает на сервер:

| Поле | Где | За что отвечает |
| --- | --- | --- |
| `role` | body | `mentor` или `trainee`. Для отчета наставника - `mentor`. |
| `text` | body | Полный текст отчета в группу наставников. |
| `applicationId` | body | Какая заявка закрывается отчетом наставника. |
| `mentorTraineeName` | body | ФИО выбранного стажера. Сервер сверяет с заявкой. |
| `mentorDecision` | body | Решение наставника: пройдена или нужна повторная. |
| `mentorCommentForTrainee` | body | Комментарий наставника, сохраняется в заявке, но не отправляется стажеру полностью. |
| `mentorTraineeResult` | body | Структура для личного сообщения стажеру и фиксации площадки/зала. |

`mentorTraineeResult`:

| Поле | Тип | За что отвечает |
| --- | --- | --- |
| `date` | string | Дата стажировки в отчете. |
| `venue` | string | Отображаемая площадка. |
| `venueId` | string | Техническая площадка. Должна совпасть с заявкой. |
| `venueLoft` | string | Лофт, автоматически полученный из `venueId`. |
| `hall` | string | Зал внутри лофта. |
| `mastered` | integer | Сколько тем освоено. |
| `total` | integer | Сколько тем всего. |
| `decision` | string | Итог для личного сообщения стажеру. |
| `topicsToRepeat` | array | Темы для повторения, которые можно отправить стажеру без внутреннего комментария наставника. |

`topicsToRepeat[]`:

| Поле | Тип | За что отвечает |
| --- | --- | --- |
| `order` | integer | Номер темы. |
| `title` | string, max 220 | Название темы. |

Порядок отправки отчета наставника сейчас защищен от спама:

1. Сервер проверяет Telegram `initData`.
2. Сервер находит `applicationId`.
3. Сервер проверяет, что заявка доступна для отчета.
4. Сервер проверяет ФИО и площадку/зал.
5. Сервер ставит временный lock на `applicationId`.
6. Сервер делает dry-run применения отчета к state.
7. Только после этого отправляет отчет в группу наставников.
8. Затем отправляет личное сообщение стажеру, если есть `telegramChatId`.
9. Затем записывает результат в `applications`.

Если preflight-валидация падает, отчет в группу не отправляется. Если наставник нажмет кнопку несколько раз подряд, второй запрос по тому же `applicationId` получает `409`.

## 9. Отчет стажера

Отчет стажера отправляется через `/api/report` с `role = trainee`.

Booking-state при этом не закрывает заявку и не меняет `status`: итог стажировки определяет отчет наставника, а не отчет самого стажера.

В группу стажеров уходит текст отчета. В `applications` сейчас нет полноценного хранения всех ответов стажера по чек-листу.

## 10. API и команды state

### `GET /api/state`

Возвращает state с учетом роли:

- рекрутер получает полный state с персональными данными;
- стажер получает публичные даты и только свои заявки;
- гость получает публичные даты без заявок.

### `POST /api/state`

Все изменения идут через команду `action` и `baseVersion`.

| `action` | Кто может | Что меняет |
| --- | --- | --- |
| `upsert_trainee_application` | стажер | Создает/обновляет свою кандидатскую заявку только в статусе `queue`. |
| `cancel_application` | стажер/рекрут | Удаляет заявку. Стажер может удалить только свою и только на ранних этапах. |
| `set_application_status` | рекрут | Меняет статус заявки. Проверяет необходимые условия этапа. |
| `step_back_application` | рекрут | Возвращает заявку на один этап назад. |
| `mark_experienced` | рекрут | Ставит `experience = experienced` только для `passed`. |
| `return_to_queue` | рекрут | Возвращает заявку в `queue` и очищает дату. |
| `assign_shift` | рекрут | Назначает заявку из очереди на дату и ставит `pending`. |
| `update_queue_comment` | рекрут | Меняет внутренний комментарий по кандидату в очереди. |
| `request_assignment_confirmation` | рекрут | Ручное подтверждение рекрутера: выбирает кандидата из `queue`, выбирает дату и отправляет стажеру запрос с кнопками. Заявка остается `queue`, активный оффер временно держит место. |
| `record_assignment_offer_message` | system/internal | Сохраняет `messageChatId/messageId` после отправки Telegram-запроса, чтобы потом закрыть кнопки. |
| `expire_assignment_offers` | system/internal | Переводит просроченные активные офферы в `expired`, а заявки - в `queue_expired`. |
| `withdraw_confirmed_assignment` | стажер | До выхода возвращает свою подтвержденную/приглашенную заявку в `queue`; рекрут получает служебное уведомление. |
| `cancel_shift` | рекрут | Отменяет дату и возвращает незавершенные заявки в очередь. |
| `cancel_internship` | рекрут | Отменяет стажировку конкретного стажера до выхода. |
| `toggle_shift` | рекрут | Открывает/закрывает дату. |
| `create_shift` | рекрут | Создает новую дату. |
| `update_shift_capacity` | рекрут | Меняет количество мест. |
| `update_comment` | рекрут | Меняет внутренний комментарий заявки. |
| `send_invites` | рекрут | Создает `inviteGroup` и переводит выбранных кандидатов в `invited`. |
| `clear_state` | рекрут | Полностью очищает state. |
| `reset_demo_state` | рекрут | Возвращает демо-state. |

### Остальные API

| Endpoint | За что отвечает |
| --- | --- |
| `GET /api/report/trainees` | Список стажеров для наставника. |
| `POST /api/report` | Отправка отчета стажера или наставника в нужную Telegram-группу. |
| `POST /api/notify` | Личные уведомления стажерам по действиям рекрута. |
| `POST /api/assignment-offer/respond` | Ответ стажера на предложенную дату: `Да` переводит заявку в `confirmed`, `Нет` оставляет в `queue`, просрочка переводит в `queue_expired`. |
| `POST /api/telegram/link` | Привязка Telegram к заявке. |
| `POST /api/auth/telegram` | Проверка Telegram `initData` и роли. |
| `GET /api/trainees/export.csv` | CSV-экспорт реестра стажеров. |

## 11. Целевая PostgreSQL-схема миграции

PostgreSQL-схема не создает отдельную hiring-базу. Центральный слой - `applications`: сначала это кандидат в очереди, затем та же запись получает дату, группу, отчеты и итог стажировки. Будущее мини-приложение для собеседований должно расширять этот кандидатский слой, а не дублировать людей в новой таблице с отдельной жизнью.

### Основные таблицы

| Таблица | Роль |
| --- | --- |
| `booking_state_meta` | Глобальная версия state и `updated_at` для optimistic locking. |
| `data_imports` | Журнал импортов JSON-снапшотов в пустую PostgreSQL-БД. |
| `telegram_users` | Нормализованные Telegram-пользователи для будущего общего слоя идентичности. |
| `recruiters` | Рекрутеры и их Telegram ID. |
| `shifts` | Даты стажировок. |
| `applications` | Главная сущность кандидата/стажера. |
| `application_assignment_offers` | Ручные предложения даты от рекрутера с TTL и Telegram message refs. |
| `invite_groups` | Отправленные рабочие группы. |
| `invite_group_members` | Связь many-to-many между рабочей группой и заявками. |
| `mentor_reports` | Сохраненный отчет наставника как отдельная сущность. |
| `mentor_report_topics` | Темы к повторению из отчета наставника. |
| `notifications` | Durable outbox для Telegram-сообщений. |
| `application_events` | PII-safe аудит действий по заявке/дате. |

### `applications` в PostgreSQL

| Колонка | Тип/ограничение | За что отвечает |
| --- | --- | --- |
| `id` | `uuid primary key` | Внутренний устойчивый ID строки. |
| `legacy_id` | `bigint unique` | Старый JSON `application.id`, сохраняется для parity, UI и миграционного чтения. |
| `shift_id` | `uuid references shifts(id) on delete set null` | Дата стажировки после назначения. У кандидата в `queue` обычно `NULL`. |
| `invite_group_id` | `uuid references invite_groups(id) on delete set null` | Рабочая группа после отправки приглашения. |
| `trainee_telegram_user_id` | `text` | Владелец заявки для авторизации стажера. |
| `trainee_telegram_chat_id` | `text` | Куда отправлять личные Telegram-сообщения. |
| `telegram_username` | `text` | Username без `@`, для рекрутерского интерфейса и поиска. |
| `telegram_code` | `text` | Legacy fallback-код связывания. |
| `name` | `text not null` | ФИО кандидата/стажера. |
| `phone` | `text not null default ''` | Телефон кандидата. |
| `training` | `passed/not_passed` | Прошел ли банкетное обучение. |
| `training_date` | `date` | Дата обучения, если `training='passed'`. |
| `attempt` | `first/repeat` | Первая или повторная стажировка. После `failed/noshow` новая заявка создается как `repeat`; после `queue_expired` - не обязательно `repeat`. |
| `limits` | `text not null default ''` | Ограничения/удобное время кандидата. |
| `status` | enum: `pending`, `queue`, `queue_expired`, `confirmed`, `invited`, `feedback`, `passed`, `failed`, `noshow` | Этап единой цепочки от кандидата до результата стажировки. |
| `recruiter_comment` | `text not null default ''` | Внутренний комментарий по уже назначенной/исторической заявке. |
| `recruiter_queue_comment` | `text not null default ''` | Внутренний комментарий рекрутера по кандидату в очереди; стажеру не отдается. |
| `venue_id` | `text` | Площадка после отправки рабочей группы. |
| `group_link` | `text not null default ''` | Ссылка на рабочую группу, продублированная в заявке. |
| `candidate_report` | `boolean not null default false` | Флаг отчета стажера. |
| `experience` | `NULL` или `experienced` | Рекрутерская отметка опытного стажера после `passed`. |
| `mentor_report_received` | `boolean not null default false` | Был ли применен отчет наставника. |
| `mentor_report_at` | `timestamptz` | Когда отчет наставника применен к заявке. |
| `mentor_reporter_telegram_user_id` | `text` | Telegram ID наставника, отправившего отчет. |
| `mentor_decision` | `text not null default ''` | Итог наставника. |
| `mentor_report_venue_id` | `text not null default ''` | Техническая площадка отчета наставника. |
| `mentor_report_venue` | `text not null default ''` | Человеческое название площадки в отчете. |
| `mentor_report_loft` | `text not null default ''` | Лофт из отчета наставника. |
| `mentor_report_hall` | `text not null default ''` | Зал из отчета наставника. |
| `mentor_comment_for_trainee` | `text not null default ''` | Внутренний комментарий наставника, сохраненный при отчете. |
| `mentor_comment_sent_at` | `timestamptz` | Когда отправили личный итог стажеру. |
| `mentor_comment_delivery_status` | `sent/skipped/failed` или `NULL` | Доставка личного итога стажеру. |
| `mentor_comment_delivery_error` | `text not null default ''` | Причина ошибки/пропуска доставки. |
| `row_version` | `bigint not null default 1` | Версия строки для будущих точечных конфликтов. |
| `created_at`, `updated_at` | `timestamptz` | Служебные timestamps. |

Индексы: `status`, `shift_id`, `trainee_telegram_user_id`, `telegram_username`, `lower(name)`.

### `application_assignment_offers`

Эта таблица и есть место, где рекрут подтверждает руками. Рекрут в карточке очереди выбирает дату и нажимает запрос подтверждения. Система создает активный offer, отправляет стажеру Telegram-сообщение с кнопками и держит место до ответа или истечения TTL.

| Колонка | Тип/ограничение | За что отвечает |
| --- | --- | --- |
| `id` | `uuid primary key` | Внутренний ID оффера. |
| `application_id` | `uuid not null references applications(id) on delete cascade` | Кандидат, которому предложили дату. |
| `shift_id` | `uuid not null references shifts(id) on delete restrict` | Предложенная дата. |
| `token` | `text not null unique` | Одноразовый токен для ответа из Telegram WebApp. |
| `status` | `active/accepted/declined/expired/unavailable/canceled` | Жизнь предложения: активно, принято, отклонено, истекло, стало недоступно из-за даты/мест, отменено при возврате/переносе. |
| `requested_by_telegram_user_id` | `text not null default ''` | Рекрутер, который руками отправил запрос. |
| `requested_at` | `timestamptz not null` | Когда запрос создан. |
| `expires_at` | `timestamptz not null` | Когда запрос должен истечь. Сейчас это `requested_at + 1 hour`. |
| `message_chat_id` | `text` | Chat ID исходного сообщения с кнопками. |
| `message_id` | `bigint` | Telegram message id исходного сообщения с кнопками. |
| `responded_at` | `timestamptz` | Когда стажер ответил или когда система обработала истечение. |
| `created_at`, `updated_at` | `timestamptz` | Служебные timestamps. |

Ограничения и индексы:

- `application_assignment_offers_one_active_per_application_idx` разрешает только один активный offer на заявку;
- `application_assignment_offers_shift_active_idx` помогает считать занятые/зарезервированные места по дате;
- `application_assignment_offers_expiry_idx` нужен воркеру истечения offer-ов.

### Прочие PostgreSQL-таблицы

| Таблица | Ключевые поля |
| --- | --- |
| `shifts` | `legacy_id`, `date`, `seats`, `open`, `canceled`, `canceled_at`, `row_version`, timestamps. |
| `invite_groups` | `legacy_id`, `shift_id`, `venue_id`, `link`, `sent_at`, `created_by_telegram_user_id`, `row_version`, timestamps. |
| `invite_group_members` | `invite_group_id`, `application_id`, `created_at`; composite primary key. |
| `mentor_reports` | `application_id`, mentor identity, `result_status`, `decision`, score fields, venue/hall fields, comments/texts, `source`, `created_at`, `voided_at`. |
| `mentor_report_topics` | `mentor_report_id`, `topic_order`, `title`, `created_at`. |
| `notifications` | `application_id`, `mentor_report_id`, `type`, `chat_id`, `chat_target`, `text`, `parse_mode`, `status`, `telegram_message_id`, `error`, `idempotency_key`, retry timestamps/counters. |
| `application_events` | `application_id`, `shift_id`, `event_type`, `actor_type`, `actor_telegram_user_id`, `payload jsonb`, `created_at`. |

## 12. Реестр и CSV-экспорт

Реестр строится из `applications`, `shifts` и `inviteGroups`.

CSV-поля:

| Колонка | Источник |
| --- | --- |
| `ID` | `application.id` |
| `ФИО` | `application.name` |
| `Телефон` | `application.phone` |
| `Статус` | `application.status` через label |
| `Дата стажировки` | `shift.date` по `application.shiftId` |
| `Банкетное обслуживание` | `application.training` через label |
| `Дата обучения` | `application.trainingDate` |
| `Стажировка` | `application.attempt` через label |
| `Ограничения` | `application.limits` |
| `Площадка` | `application.venueId` или `inviteGroup.venueId` через label |
| `Ссылка группы` | `application.groupLink` или `inviteGroup.link` |
| `Telegram username` | `application.telegramUsername` |
| `Telegram user ID` | `application.telegramUserId` |
| `Telegram chat ID` | `application.telegramChatId` |
| `Отчет наставника` | `application.mentorReport` |
| `Дата отчета наставника` | `application.mentorReportAt` |
| `Итог наставника` | `application.mentorDecision` |
| `Статус ЛС стажеру` | `application.mentorCommentDeliveryStatus` |
| `Статус опыта` | `application.experience` |
| `Создано` | `application.createdAt` |
| `State обновлен` | root `updatedAt` |

## 13. Что не хранится в state

Сейчас в JSON booking-state не хранится:

- полный чек-лист стажера;
- полный чек-лист наставника по каждому пункту;
- полный текст отчета наставника как отдельная сущность;
- отдельная таблица пользователей;
- отдельная таблица наставников;
- SQL-связи/foreign keys на уровне базы.

PostgreSQL migration target уже закрывает часть этих дыр: есть foreign keys, `application_events`, `mentor_reports`, `notifications` outbox и `application_assignment_offers.message_id` для запросов подтверждения даты. Но полноценный профиль пользователя, отдельная CRM по собеседованиям и полный чек-лист стажера/наставника пока не спроектированы как отдельные таблицы.

## 14. Практические правила для будущих правок

1. Если добавляется новое поле в `applications`, его нужно добавить в `normalizeApplicationForWrite`, фронтовый `normalizeApplication`, экспорт/реестр при необходимости и тесты.
2. Если поле связано с площадкой или залом, его нужно проверять на сервере, а не только рисовать на фронте.
3. Если поле влияет на список наставника, проверять `applicationCanReceiveMentorReport`.
4. Если поле влияет на места, проверять `SEAT_HOLDING_STATUSES`.
5. Если поле влияет на закрытие даты, проверять `applicationCompletesShift` и `shouldAutoCloseShift`.
6. Если действие отправляет Telegram-сообщение, сначала делать серверную валидацию state, потом отправку, чтобы не повторить баг со спамом отчетов.
7. Если поле должно быть доступно рекруту, но не стажеру, проверять выдачу в `bookingStateForActor`.
8. Если меняется структура state, обновлять этот документ и `docs/INTERNSHIP_WORKFLOW.md` в том же коммите.
