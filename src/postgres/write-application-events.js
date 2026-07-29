import { randomUUID } from 'node:crypto';

function legacyIdsFrom(events, field) {
  return [
    ...new Set(
      events
        .map(event => event[field])
        .filter(value => value !== null && value !== undefined && value !== '')
        .map(Number)
        .filter(value => Number.isSafeInteger(value) && value > 0)
    )
  ];
}

async function uuidByLegacyId(client, tableName, legacyIds) {
  if (!legacyIds.length) return new Map();
  const result = await client.query(
    `SELECT legacy_id, id FROM ${tableName} WHERE legacy_id = ANY($1::bigint[])`,
    [legacyIds]
  );
  return new Map(result.rows.map(row => [String(row.legacy_id), row.id]));
}

function eventPayload(event) {
  return {
    ...(event.payload || {}),
    legacyApplicationId: event.applicationId ?? undefined,
    legacyShiftId: event.shiftId ?? undefined
  };
}

export async function insertApplicationEvents(client, events) {
  if (!Array.isArray(events) || events.length === 0) return { inserted: 0 };

  const applicationIdByLegacy = await uuidByLegacyId(
    client,
    'applications',
    legacyIdsFrom(events, 'applicationId')
  );
  const shiftIdByLegacy = await uuidByLegacyId(
    client,
    'shifts',
    legacyIdsFrom(events, 'shiftId')
  );

  for (const event of events) {
    const applicationId = event.applicationId === null || event.applicationId === undefined
      ? null
      : applicationIdByLegacy.get(String(event.applicationId)) || null;
    const shiftId = event.shiftId === null || event.shiftId === undefined
      ? null
      : shiftIdByLegacy.get(String(event.shiftId)) || null;

    await client.query(
      `
        INSERT INTO application_events (
          id, application_id, shift_id, event_type, actor_type,
          actor_telegram_user_id, payload, created_at
        )
        VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8)
      `,
      [
        randomUUID(),
        applicationId,
        shiftId,
        event.eventType,
        event.actorType,
        event.actorTelegramUserId,
        JSON.stringify(eventPayload(event)),
        event.createdAt
      ]
    );
  }

  return { inserted: events.length };
}
