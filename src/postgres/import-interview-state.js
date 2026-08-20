import { randomUUID } from 'node:crypto';

const ROOT_FIELDS = new Set([
  'schemaVersion',
  'version',
  'updatedAt',
  'settings',
  'slots',
  'candidates',
  'notifications',
  'events',
  'stats',
  'reasonStats',
  'lossReasonStats'
]);

const SLOT_FIELDS = new Set([
  'id',
  'legacyId',
  'title',
  'date',
  'time',
  'timezone',
  'venue',
  'venueId',
  'venueLabel',
  'venueAddress',
  'address',
  'mapUrl',
  'seats',
  'status',
  'directionsMaterial',
  'directionsMaterialId',
  'directionsVideoUrl',
  'confirmationVideoUrl',
  'bookingText',
  'confirmationText',
  'templateCleared',
  'completedAt',
  'createdByTelegramUserId',
  'createdAt',
  'updatedAt',
  'note',
  'recruiter',
  'bookedCount',
  'availableSeats',
  'confirmedCount',
  'confirmationPendingCount',
  'arrivedCount',
  'declinedBeforeCount',
  'noConfirmationCount',
  'noShowCount',
  'passedCount',
  'registeredCount',
  'resourcesSentCount'
]);

const CANDIDATE_FIELDS = new Set([
  'id',
  'telegramId',
  'telegramUserId',
  'telegramChatId',
  'telegram',
  'telegramUsername',
  'name',
  'fullName',
  'phone',
  'source',
  'availability',
  'note',
  'status',
  'candidateLayerStatus',
  'interviewSlotId',
  'waitlistJoinedAt',
  'waitlistTargetSlotId',
  'lastWaitlistNotifiedAt',
  'confirmationStatus',
  'confirmationRequestedAt',
  'confirmedAt',
  'declinedAt',
  'attendanceStatus',
  'attendanceMarkedAt',
  'interviewResult',
  'resultReason',
  'resultMarkedAt',
  'registrationStatus',
  'registrationInstructionsSentAt',
  'registrationConfirmedAt',
  'materialsAvailableAt',
  'materialsSentAt',
  'resourcesSentAt',
  'resourceStepsSent',
  'resourceErrors',
  'leftAfterInterviewAt',
  'interviewHistory',
  'internshipStage',
  'lossReason',
  'lossReasonComment',
  'lossReasonMarkedAt',
  'linkClicks',
  'createdAt',
  'updatedAt'
]);

const RESOURCE_TYPES = Object.freeze([
  'registration_bot',
  'staff_bot',
  'unattested_group',
  'helper_bot',
  'self_employment'
]);

const LEGACY_RESOURCE_TYPE_MAP = Object.freeze({
  work_links: 'staff_bot'
});

const SLOT_STATUSES = new Set(['open', 'closed', 'completed', 'canceled']);
const PARTICIPANT_STATUSES = new Set([
  'waitlist',
  'booked',
  'confirmation_pending',
  'confirmed',
  'declined_before_interview',
  'no_confirmation',
  'attended',
  'left_after_interview',
  'no_show',
  'registration_pending',
  'registered',
  'ready_for_internship',
  'rejected',
  'not_interested'
]);
const CANDIDATE_LAYER_STATUSES = new Set([
  'candidate_created',
  'waiting_for_interview_date',
  'interview_booked',
  'interview_confirmation_pending',
  'interview_confirmed',
  'interview_declined_before',
  'interview_no_confirmation',
  'interview_no_show',
  'interview_attended',
  'interview_passed',
  'interview_rejected',
  'left_after_interview',
  'resources_sent',
  'candidate_ready_for_registration',
  'ready_for_internship',
  'closed_not_interested'
]);
const CONFIRMATION_STATUSES = new Set(['not_requested', 'pending', 'confirmed', 'declined', 'no_response']);
const ATTENDANCE_STATUSES = new Set(['unknown', 'arrived', 'no_show', 'declined_before', 'no_confirmation']);
const REGISTRATION_STATUSES = new Set(['not_started', 'instructions_sent', 'materials_sent', 'pending', 'registered']);
const ACTIVE_PARTICIPANT_STATUSES = new Set([
  'waitlist',
  'booked',
  'confirmation_pending',
  'confirmed',
  'attended',
  'registration_pending',
  'registered',
  'ready_for_internship'
]);

function clean(value) {
  return String(value || '').trim();
}

function unknownFields(value, allowedFields) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return [];
  return Object.keys(value).filter(field => !allowedFields.has(field));
}

function optionalTimestamp(value) {
  const raw = clean(value);
  if (!raw) return null;
  const parsed = new Date(raw);
  return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString();
}

function requiredTimestamp(value, fallback) {
  return optionalTimestamp(value) || fallback.toISOString();
}

function requiredDate(value, label) {
  const raw = clean(value);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(raw)) {
    throw new Error(`${label} must be YYYY-MM-DD.`);
  }
  return raw;
}

function requiredTime(value, label) {
  const raw = clean(value);
  if (!/^\d{2}:\d{2}$/.test(raw)) {
    throw new Error(`${label} must be HH:MM.`);
  }
  return raw;
}

function enumValue(value, allowed, fallback, label) {
  const normalized = clean(value || fallback);
  if (!allowed.has(normalized)) {
    throw new Error(`${label} has unsupported value: ${normalized}.`);
  }
  return normalized;
}

function normalizeTelegramUsername(candidate) {
  return clean(candidate.telegramUsername || candidate.telegram).replace(/^@+/, '');
}

function telegramUserId(candidate) {
  return clean(candidate.telegramUserId || candidate.telegramId);
}

function telegramChatId(candidate) {
  return clean(candidate.telegramChatId || candidate.telegramId) || null;
}

function participantStatus(candidate) {
  return enumValue(candidate.status, PARTICIPANT_STATUSES, 'waitlist', `candidate ${candidate.id} status`);
}

function candidateLayerStatus(candidate) {
  const explicit = clean(candidate.candidateLayerStatus);
  if (explicit) {
    return enumValue(explicit, CANDIDATE_LAYER_STATUSES, 'candidate_created', `candidate ${candidate.id} candidateLayerStatus`);
  }

  const status = participantStatus(candidate);
  if (status === 'waitlist') return 'waiting_for_interview_date';
  if (status === 'booked') return 'interview_booked';
  if (status === 'confirmation_pending') return 'interview_confirmation_pending';
  if (status === 'confirmed') return 'interview_confirmed';
  if (status === 'declined_before_interview') return 'interview_declined_before';
  if (status === 'no_confirmation') return 'interview_no_confirmation';
  if (status === 'no_show') return 'interview_no_show';
  if (status === 'attended') return 'interview_attended';
  if (status === 'left_after_interview') return 'left_after_interview';
  if (status === 'ready_for_internship') return 'ready_for_internship';
  if (status === 'not_interested') return 'closed_not_interested';
  return 'candidate_created';
}

function profileKey(candidate) {
  const stableTelegramUserId = telegramUserId(candidate);
  if (stableTelegramUserId) return `telegram_user_id:${stableTelegramUserId}`;
  return `interview_candidate:${clean(candidate.id)}`;
}

function buildProfileRows(candidates, fallbackTimestamp) {
  const profilesByKey = new Map();
  const profileIdByCandidateId = new Map();

  for (const candidate of candidates) {
    const key = profileKey(candidate);
    const existing = profilesByKey.get(key);
    const profile = existing || {
      id: randomUUID(),
      telegramUserId: telegramUserId(candidate) || null,
      telegramChatId: telegramChatId(candidate),
      telegramUsername: normalizeTelegramUsername(candidate),
      fullName: clean(candidate.fullName || candidate.name),
      phone: clean(candidate.phone),
      source: clean(candidate.source) || 'interview_json_import',
      currentStage: candidateLayerStatus(candidate),
      createdAt: requiredTimestamp(candidate.createdAt, fallbackTimestamp),
      updatedAt: requiredTimestamp(candidate.updatedAt, fallbackTimestamp)
    };

    profile.telegramChatId = telegramChatId(candidate) || profile.telegramChatId;
    profile.telegramUsername = normalizeTelegramUsername(candidate) || profile.telegramUsername;
    profile.fullName = clean(candidate.fullName || candidate.name) || profile.fullName;
    profile.phone = clean(candidate.phone) || profile.phone;
    profile.currentStage = candidateLayerStatus(candidate);
    profile.updatedAt = requiredTimestamp(candidate.updatedAt, fallbackTimestamp);

    profilesByKey.set(key, profile);
    profileIdByCandidateId.set(clean(candidate.id), profile.id);
  }

  return {
    candidateProfiles: [...profilesByKey.values()],
    profileIdByCandidateId
  };
}

function legacySlotId(slot) {
  return clean(slot.legacyId || slot.id);
}

function legacyCandidateId(candidate) {
  return clean(candidate.id);
}

function mapByLegacyId(items, legacyIdSelector) {
  return new Map(items.map(item => [legacyIdSelector(item), randomUUID()]));
}

function slotVenueId(slot) {
  return clean(slot.venueId || slot.venue || 'loft23');
}

function slotVenueLabel(slot) {
  return clean(slot.venueLabel || slot.venue || slotVenueId(slot));
}

function slotVenueAddress(slot) {
  return clean(slot.venueAddress || slot.address);
}

function normalizeResourceType(type) {
  const raw = clean(type);
  return LEGACY_RESOURCE_TYPE_MAP[raw] || raw;
}

function resourceStepsSent(candidate) {
  if (Array.isArray(candidate.resourceStepsSent)) {
    return candidate.resourceStepsSent
      .map(step => ({
        type: normalizeResourceType(step?.type),
        sentAt: optionalTimestamp(step?.sentAt || candidate.resourcesSentAt || candidate.materialsSentAt)
      }))
      .filter(step => step.type);
  }

  const fallbackSentAt = optionalTimestamp(candidate.resourcesSentAt || candidate.materialsSentAt);
  return fallbackSentAt ? [{ type: 'registration_bot', sentAt: fallbackSentAt }] : [];
}

function linkClicks(candidate) {
  if (!Array.isArray(candidate.linkClicks)) return [];
  return candidate.linkClicks
    .map(click => ({
      linkType: clean(click?.linkType || click?.type),
      url: clean(click?.url),
      clickedAt: optionalTimestamp(click?.clickedAt || click?.createdAt)
    }))
    .filter(click => click.linkType && click.clickedAt);
}

function eventPayload(details) {
  const payload = { ...details };
  delete payload.name;
  delete payload.fullName;
  delete payload.phone;
  delete payload.telegram;
  delete payload.telegramUsername;
  delete payload.telegramId;
  delete payload.telegramUserId;
  delete payload.telegramChatId;
  return payload;
}

export function auditInterviewStateShape(sourceState) {
  if (!sourceState || typeof sourceState !== 'object' || Array.isArray(sourceState)) {
    throw new Error('Interview JSON root must be an object.');
  }
  for (const field of ['slots', 'candidates']) {
    if (!Array.isArray(sourceState[field])) {
      throw new Error(`Interview JSON ${field} must be an array.`);
    }
  }

  const findings = [];
  for (const field of unknownFields(sourceState, ROOT_FIELDS)) findings.push(`root.${field}`);
  sourceState.slots.forEach((slot, index) => {
    for (const field of unknownFields(slot, SLOT_FIELDS)) findings.push(`slots[${index}].${field}`);
  });
  sourceState.candidates.forEach((candidate, index) => {
    for (const field of unknownFields(candidate, CANDIDATE_FIELDS)) findings.push(`candidates[${index}].${field}`);
  });

  if (findings.length) {
    throw new Error(
      `Interview JSON contains fields not covered by the migration: ${findings.join(', ')}.`
    );
  }
}

export function buildInterviewImportPlan(sourceState, now = new Date()) {
  auditInterviewStateShape(sourceState);
  const fallbackTimestamp = new Date(requiredTimestamp(sourceState.updatedAt, now));
  const slots = sourceState.slots.map(slot => ({ ...slot }));
  const candidates = sourceState.candidates.map(candidate => ({ ...candidate }));
  const slotIdByLegacy = mapByLegacyId(slots, legacySlotId);

  const {
    candidateProfiles,
    profileIdByCandidateId
  } = buildProfileRows(candidates, fallbackTimestamp);

  const interviewSlots = slots.map(slot => ({
    id: slotIdByLegacy.get(legacySlotId(slot)),
    legacyId: legacySlotId(slot),
    title: clean(slot.title) || 'Sobesedovanie LOFT HALL',
    interviewDate: requiredDate(slot.date, `slot ${legacySlotId(slot)} date`),
    interviewTime: requiredTime(slot.time, `slot ${legacySlotId(slot)} time`),
    timezone: clean(slot.timezone) || 'Europe/Moscow',
    venueId: slotVenueId(slot),
    venueLabel: slotVenueLabel(slot),
    venueAddress: slotVenueAddress(slot),
    seats: Number(slot.seats),
    status: enumValue(slot.status, SLOT_STATUSES, 'open', `slot ${legacySlotId(slot)} status`),
    directionsMaterialId: clean(slot.directionsMaterialId || slot.directionsMaterial?.id),
    bookingText: clean(slot.bookingText || slot.confirmationText),
    templateCleared: Boolean(slot.templateCleared),
    completedAt: optionalTimestamp(slot.completedAt),
    createdByTelegramUserId: clean(slot.createdByTelegramUserId) || null,
    createdAt: requiredTimestamp(slot.createdAt, fallbackTimestamp),
    updatedAt: requiredTimestamp(slot.updatedAt, fallbackTimestamp)
  }));

  for (const slot of interviewSlots) {
    if (!Number.isInteger(slot.seats) || slot.seats < 1 || slot.seats > 100) {
      throw new Error(`slot ${slot.legacyId} seats must be an integer from 1 to 100.`);
    }
  }

  const interviewParticipants = candidates.map(candidate => {
    const candidateId = legacyCandidateId(candidate);
    const slotLegacyId = clean(candidate.interviewSlotId);
    const targetSlotLegacyId = clean(candidate.waitlistTargetSlotId);
    return {
      id: randomUUID(),
      legacyCandidateId: candidateId,
      candidateProfileId: profileIdByCandidateId.get(candidateId),
      interviewSlotId: slotLegacyId ? slotIdByLegacy.get(slotLegacyId) || null : null,
      waitlistTargetSlotId: targetSlotLegacyId ? slotIdByLegacy.get(targetSlotLegacyId) || null : null,
      status: participantStatus(candidate),
      candidateLayerStatus: candidateLayerStatus(candidate),
      confirmationStatus: enumValue(candidate.confirmationStatus, CONFIRMATION_STATUSES, 'not_requested', `candidate ${candidateId} confirmationStatus`),
      confirmationRequestedAt: optionalTimestamp(candidate.confirmationRequestedAt),
      confirmedAt: optionalTimestamp(candidate.confirmedAt),
      declinedAt: optionalTimestamp(candidate.declinedAt),
      attendanceStatus: enumValue(candidate.attendanceStatus, ATTENDANCE_STATUSES, 'unknown', `candidate ${candidateId} attendanceStatus`),
      attendanceMarkedAt: optionalTimestamp(candidate.attendanceMarkedAt),
      registrationStatus: enumValue(candidate.registrationStatus, REGISTRATION_STATUSES, 'not_started', `candidate ${candidateId} registrationStatus`),
      registrationInstructionsSentAt: optionalTimestamp(candidate.registrationInstructionsSentAt),
      registrationConfirmedAt: optionalTimestamp(candidate.registrationConfirmedAt),
      materialsAvailableAt: optionalTimestamp(candidate.materialsAvailableAt),
      materialsSentAt: optionalTimestamp(candidate.materialsSentAt),
      resourcesSentAt: optionalTimestamp(candidate.resourcesSentAt),
      leftAfterInterviewAt: optionalTimestamp(candidate.leftAfterInterviewAt),
      waitlistJoinedAt: optionalTimestamp(candidate.waitlistJoinedAt),
      lastWaitlistNotifiedAt: optionalTimestamp(candidate.lastWaitlistNotifiedAt),
      internshipStage: clean(candidate.internshipStage) || 'candidate_layer',
      recruiterNote: clean(candidate.note),
      createdAt: requiredTimestamp(candidate.createdAt, fallbackTimestamp),
      updatedAt: requiredTimestamp(candidate.updatedAt, fallbackTimestamp)
    };
  });

  const activeByProfile = new Map();
  for (const participant of interviewParticipants) {
    if (!ACTIVE_PARTICIPANT_STATUSES.has(participant.status)) continue;
    const key = participant.candidateProfileId;
    const existing = activeByProfile.get(key);
    if (existing) {
      throw new Error(
        `candidate profile ${key} has multiple active interview participants: `
        + `${existing.legacyCandidateId}, ${participant.legacyCandidateId}.`
      );
    }
    activeByProfile.set(key, participant);
  }

  const participantByCandidateId = new Map(
    interviewParticipants.map(participant => [participant.legacyCandidateId, participant])
  );
  const candidateById = new Map(candidates.map(candidate => [legacyCandidateId(candidate), candidate]));

  const candidateResourceDeliveries = [];
  for (const participant of interviewParticipants) {
    const candidate = candidateById.get(participant.legacyCandidateId);
    for (const step of resourceStepsSent(candidate)) {
      if (!RESOURCE_TYPES.includes(step.type)) {
        throw new Error(`candidate ${participant.legacyCandidateId} has unsupported resource type: ${step.type}.`);
      }
      candidateResourceDeliveries.push({
        id: randomUUID(),
        candidateProfileId: participant.candidateProfileId,
        interviewParticipantId: participant.id,
        resourceType: step.type,
        sequenceNo: RESOURCE_TYPES.indexOf(step.type) + 1,
        status: 'sent',
        telegramMessageId: null,
        error: '',
        sentAt: step.sentAt || participant.resourcesSentAt || participant.materialsSentAt || participant.updatedAt,
        createdAt: step.sentAt || participant.resourcesSentAt || participant.materialsSentAt || participant.updatedAt,
        updatedAt: step.sentAt || participant.resourcesSentAt || participant.materialsSentAt || participant.updatedAt
      });
    }
  }

  const candidateLinkClicks = [];
  for (const participant of interviewParticipants) {
    const candidate = candidateById.get(participant.legacyCandidateId);
    for (const click of linkClicks(candidate)) {
      candidateLinkClicks.push({
        id: randomUUID(),
        candidateProfileId: participant.candidateProfileId,
        interviewParticipantId: participant.id,
        linkType: normalizeResourceType(click.linkType),
        url: click.url,
        clickedAt: click.clickedAt,
        source: 'telegram_webapp'
      });
    }
  }

  const candidateEvents = interviewParticipants.map(participant => ({
    id: randomUUID(),
    candidateProfileId: participant.candidateProfileId,
    interviewSlotId: participant.interviewSlotId,
    interviewParticipantId: participant.id,
    applicationId: null,
    eventType: 'legacy_interview_candidate_imported',
    actorType: 'migration',
    actorTelegramUserId: null,
    payload: eventPayload({
      legacyCandidateId: participant.legacyCandidateId,
      status: participant.status,
      candidateLayerStatus: participant.candidateLayerStatus,
      sourceVersion: sourceState.version || null
    }),
    createdAt: fallbackTimestamp.toISOString()
  }));

  return {
    sourceVersion: Number(sourceState.version || 1),
    sourceUpdatedAt: requiredTimestamp(sourceState.updatedAt, fallbackTimestamp),
    candidateProfiles,
    interviewSlots,
    interviewParticipants,
    candidateResourceDeliveries,
    candidateLinkClicks,
    candidateEvents,
    participantByCandidateId
  };
}

async function assertImportNotApplied(client, sourceChecksum) {
  const result = await client.query(
    'SELECT id FROM data_imports WHERE source_checksum = $1 LIMIT 1',
    [sourceChecksum]
  );
  if (result.rowCount > 0) {
    throw new Error('Interview JSON source checksum was already imported.');
  }
}

async function assertNoLegacySlotConflict(client, slots) {
  const legacyIds = slots.map(slot => slot.legacyId).filter(Boolean);
  if (!legacyIds.length) return;
  const result = await client.query(
    'SELECT legacy_id FROM interview_slots WHERE legacy_id = ANY($1::text[]) LIMIT 1',
    [legacyIds]
  );
  if (result.rowCount > 0) {
    throw new Error(`Interview slot already exists in PostgreSQL: ${result.rows[0].legacy_id}.`);
  }
}

async function upsertCandidateProfiles(client, rows) {
  const profileIdByPlannedId = new Map();
  let inserted = 0;
  let reused = 0;

  for (const row of rows) {
    const result = await client.query(`
      INSERT INTO candidate_profiles (
        id, telegram_user_id, telegram_chat_id, telegram_username,
        full_name, phone, source, current_stage, created_at, updated_at
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
      ON CONFLICT (telegram_user_id) DO UPDATE
        SET telegram_chat_id = COALESCE(NULLIF(EXCLUDED.telegram_chat_id, ''), candidate_profiles.telegram_chat_id),
            telegram_username = CASE
              WHEN candidate_profiles.telegram_username = '' THEN EXCLUDED.telegram_username
              ELSE candidate_profiles.telegram_username
            END,
            full_name = CASE
              WHEN candidate_profiles.full_name = '' THEN EXCLUDED.full_name
              ELSE candidate_profiles.full_name
            END,
            phone = CASE
              WHEN candidate_profiles.phone = '' THEN EXCLUDED.phone
              ELSE candidate_profiles.phone
            END,
            source = CASE
              WHEN candidate_profiles.source = '' THEN EXCLUDED.source
              ELSE candidate_profiles.source
            END,
            current_stage = CASE
              WHEN candidate_profiles.current_stage = 'candidate_created' THEN EXCLUDED.current_stage
              ELSE candidate_profiles.current_stage
            END,
            updated_at = EXCLUDED.updated_at
      RETURNING id, (xmax = 0) AS inserted
    `, [
      row.id,
      row.telegramUserId,
      row.telegramChatId,
      row.telegramUsername,
      row.fullName,
      row.phone,
      row.source,
      row.currentStage,
      row.createdAt,
      row.updatedAt
    ]);
    const returned = result.rows[0];
    profileIdByPlannedId.set(row.id, returned.id);
    if (returned.inserted) inserted += 1;
    else reused += 1;
  }

  return { profileIdByPlannedId, inserted, reused };
}

async function insertIdentityReviewItems(client, rows, profileIdByPlannedId) {
  for (const row of rows) {
    const profileId = profileIdByPlannedId.get(row.id);
    if (!profileId) continue;

    const matches = await client.query(`
      SELECT id, 'full_name_phone' AS signal_type, full_name || '|' || phone AS signal_value
        FROM candidate_profiles
       WHERE $1 <> ''
         AND $2 <> ''
         AND lower(full_name) = lower($1)
         AND phone = $2
         AND id <> $4
      UNION ALL
      SELECT id, 'telegram_username' AS signal_type, telegram_username AS signal_value
        FROM candidate_profiles
       WHERE $3 <> ''
         AND telegram_username <> ''
         AND lower(telegram_username) = lower($3)
         AND id <> $4
      UNION ALL
      SELECT id, 'phone' AS signal_type, phone AS signal_value
        FROM candidate_profiles
       WHERE $2 <> ''
         AND phone = $2
         AND id <> $4
      UNION ALL
      SELECT id, 'full_name' AS signal_type, full_name AS signal_value
        FROM candidate_profiles
       WHERE $1 <> ''
         AND lower(full_name) = lower($1)
         AND id <> $4
      LIMIT 20
    `, [
      row.fullName,
      row.phone,
      row.telegramUsername,
      profileId
    ]);

    for (const match of matches.rows) {
      await client.query(`
        INSERT INTO candidate_identity_review_items (
          id, candidate_profile_id, matched_candidate_profile_id,
          signal_type, signal_value, status, detected_at, created_at, updated_at
        ) VALUES ($1, $2, $3, $4, $5, 'open', now(), now(), now())
        ON CONFLICT DO NOTHING
      `, [
        randomUUID(),
        profileId,
        match.id,
        match.signal_type,
        match.signal_value || ''
      ]);
    }
  }
}

function rebindPlanProfileIds(plan, profileIdByPlannedId) {
  const rebind = value => profileIdByPlannedId.get(value) || value;
  for (const participant of plan.interviewParticipants) {
    participant.candidateProfileId = rebind(participant.candidateProfileId);
  }
  for (const row of plan.candidateResourceDeliveries) {
    row.candidateProfileId = rebind(row.candidateProfileId);
  }
  for (const row of plan.candidateLinkClicks) {
    row.candidateProfileId = rebind(row.candidateProfileId);
  }
  for (const event of plan.candidateEvents) {
    event.candidateProfileId = rebind(event.candidateProfileId);
  }
}

async function insertInterviewSlots(client, rows) {
  for (const row of rows) {
    await client.query(`
      INSERT INTO interview_slots (
        id, legacy_id, title, interview_date, interview_time, timezone,
        venue_id, venue_label, venue_address, seats, status,
        directions_material_id, booking_text, template_cleared,
        completed_at, created_by_telegram_user_id, created_at, updated_at
      ) VALUES (
        $1, $2, $3, $4, $5, $6,
        $7, $8, $9, $10, $11,
        $12, $13, $14,
        $15, $16, $17, $18
      )
    `, [
      row.id,
      row.legacyId,
      row.title,
      row.interviewDate,
      row.interviewTime,
      row.timezone,
      row.venueId,
      row.venueLabel,
      row.venueAddress,
      row.seats,
      row.status,
      row.directionsMaterialId,
      row.bookingText,
      row.templateCleared,
      row.completedAt,
      row.createdByTelegramUserId,
      row.createdAt,
      row.updatedAt
    ]);
  }
}

async function insertInterviewParticipants(client, rows) {
  for (const row of rows) {
    await client.query(`
      INSERT INTO interview_participants (
        id, candidate_profile_id, interview_slot_id, waitlist_target_slot_id,
        status, candidate_layer_status, confirmation_status,
        confirmation_requested_at, confirmed_at, declined_at,
        attendance_status, attendance_marked_at,
        registration_status, registration_instructions_sent_at,
        registration_confirmed_at, materials_available_at, materials_sent_at,
        resources_sent_at, left_after_interview_at, waitlist_joined_at,
        last_waitlist_notified_at, internship_stage, recruiter_note,
        created_at, updated_at
      ) VALUES (
        $1, $2, $3, $4,
        $5, $6, $7,
        $8, $9, $10,
        $11, $12,
        $13, $14,
        $15, $16, $17,
        $18, $19, $20,
        $21, $22, $23,
        $24, $25
      )
    `, [
      row.id,
      row.candidateProfileId,
      row.interviewSlotId,
      row.waitlistTargetSlotId,
      row.status,
      row.candidateLayerStatus,
      row.confirmationStatus,
      row.confirmationRequestedAt,
      row.confirmedAt,
      row.declinedAt,
      row.attendanceStatus,
      row.attendanceMarkedAt,
      row.registrationStatus,
      row.registrationInstructionsSentAt,
      row.registrationConfirmedAt,
      row.materialsAvailableAt,
      row.materialsSentAt,
      row.resourcesSentAt,
      row.leftAfterInterviewAt,
      row.waitlistJoinedAt,
      row.lastWaitlistNotifiedAt,
      row.internshipStage,
      row.recruiterNote,
      row.createdAt,
      row.updatedAt
    ]);
  }
}

async function insertCandidateResourceDeliveries(client, rows) {
  for (const row of rows) {
    await client.query(`
      INSERT INTO candidate_resource_deliveries (
        id, candidate_profile_id, interview_participant_id, resource_type,
        sequence_no, status, telegram_message_id, error, sent_at,
        created_at, updated_at
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
    `, [
      row.id,
      row.candidateProfileId,
      row.interviewParticipantId,
      row.resourceType,
      row.sequenceNo,
      row.status,
      row.telegramMessageId,
      row.error,
      row.sentAt,
      row.createdAt,
      row.updatedAt
    ]);
  }
}

async function insertCandidateLinkClicks(client, rows) {
  for (const row of rows) {
    await client.query(`
      INSERT INTO candidate_link_clicks (
        id, candidate_profile_id, interview_participant_id,
        link_type, url, clicked_at, source
      ) VALUES ($1, $2, $3, $4, $5, $6, $7)
      ON CONFLICT DO NOTHING
    `, [
      row.id,
      row.candidateProfileId,
      row.interviewParticipantId,
      row.linkType,
      row.url,
      row.clickedAt,
      row.source
    ]);
  }
}

async function insertCandidateEvents(client, rows) {
  for (const row of rows) {
    await client.query(`
      INSERT INTO candidate_events (
        id, candidate_profile_id, interview_slot_id, interview_participant_id,
        application_id, event_type, actor_type, actor_telegram_user_id,
        payload, created_at
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb, $10)
    `, [
      row.id,
      row.candidateProfileId,
      row.interviewSlotId,
      row.interviewParticipantId,
      row.applicationId,
      row.eventType,
      row.actorType,
      row.actorTelegramUserId,
      JSON.stringify(row.payload),
      row.createdAt
    ]);
  }
}

async function verifyImportedInterviewCounts(client, plan) {
  const expected = {
    interview_slots: plan.interviewSlots.length,
    interview_participants: plan.interviewParticipants.length,
    candidate_resource_deliveries: plan.candidateResourceDeliveries.length,
    candidate_link_clicks: plan.candidateLinkClicks.length,
    candidate_events: plan.candidateEvents.length
  };
  const actual = {};

  for (const table of Object.keys(expected)) {
    const result = await client.query(`SELECT count(*)::integer AS count FROM ${table}`);
    actual[table] = result.rows[0].count;
    if (actual[table] < expected[table]) {
      throw new Error(
        `Interview import verification failed for ${table}: `
        + `expected at least ${expected[table]}, got ${actual[table]}.`
      );
    }
  }

  return { expected, actual };
}

export async function importInterviewState(client, sourceState, {
  sourceChecksum,
  now = new Date()
} = {}) {
  if (!/^[0-9a-f]{64}$/i.test(clean(sourceChecksum))) {
    throw new Error('A SHA-256 sourceChecksum is required for interview PostgreSQL import.');
  }

  const plan = buildInterviewImportPlan(sourceState, now);
  await client.query('BEGIN');

  try {
    await client.query('SELECT pg_advisory_xact_lock($1::bigint)', ['7711012237']);
    await assertImportNotApplied(client, sourceChecksum);
    await assertNoLegacySlotConflict(client, plan.interviewSlots);
    const profileResult = await upsertCandidateProfiles(client, plan.candidateProfiles);
    rebindPlanProfileIds(plan, profileResult.profileIdByPlannedId);
    await insertIdentityReviewItems(client, plan.candidateProfiles, profileResult.profileIdByPlannedId);
    await insertInterviewSlots(client, plan.interviewSlots);
    await insertInterviewParticipants(client, plan.interviewParticipants);
    await insertCandidateResourceDeliveries(client, plan.candidateResourceDeliveries);
    await insertCandidateLinkClicks(client, plan.candidateLinkClicks);
    await insertCandidateEvents(client, plan.candidateEvents);
    await client.query(`
      INSERT INTO data_imports (
        id, source_type, source_checksum, source_version, source_updated_at,
        shifts_count, applications_count, invite_groups_count, imported_at
      ) VALUES ($1, 'interview_json', $2, $3, $4, $5, $6, 0, $7)
    `, [
      randomUUID(),
      sourceChecksum,
      plan.sourceVersion,
      plan.sourceUpdatedAt,
      plan.interviewSlots.length,
      plan.interviewParticipants.length,
      now.toISOString()
    ]);

    const verification = await verifyImportedInterviewCounts(client, plan);
    await client.query('COMMIT');
    return { plan, verification, profiles: profileResult };
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  }
}
