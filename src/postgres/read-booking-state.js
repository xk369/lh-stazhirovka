import { isDeepStrictEqual } from 'node:util';
import { normalizeBookingState } from '../booking-state.js';

function legacyId(value, field) {
  const id = Number(value);
  if (!Number.isSafeInteger(id) || id <= 0) {
    throw new Error(`${field} is not a safe legacy id.`);
  }
  return id;
}

function dateText(value) {
  if (!value) return '';
  if (typeof value === 'string') return value.slice(0, 10);
  return value.toISOString().slice(0, 10);
}

function timestampText(value) {
  if (!value) return '';
  if (typeof value === 'string') return new Date(value).toISOString();
  return value.toISOString();
}

function statusCounts(applications) {
  return Object.fromEntries(
    [...applications.reduce((counts, application) => {
      counts.set(application.status, (counts.get(application.status) || 0) + 1);
      return counts;
    }, new Map())].sort(([left], [right]) => left.localeCompare(right))
  );
}

function compactOptionalFields(value, defaultFalseFields = new Set()) {
  return Object.fromEntries(
    Object.entries(value).filter(([field, fieldValue]) => (
      fieldValue !== undefined
      && fieldValue !== null
      && fieldValue !== ''
      && !(fieldValue === false && defaultFalseFields.has(field))
    ))
  );
}

export async function readBookingStateFromPostgres(client) {
  const metaResult = await client.query(
    'SELECT version, updated_at FROM booking_state_meta WHERE singleton = true'
  );
  const shiftsResult = await client.query(`
      SELECT legacy_id, date::text AS date, seats, open, canceled, canceled_at
      FROM shifts
      ORDER BY legacy_id
    `);
  const applicationsResult = await client.query(`
      SELECT
        legacy_id,
        (SELECT legacy_id FROM shifts WHERE shifts.id = applications.shift_id) AS shift_legacy_id,
        (SELECT legacy_id FROM invite_groups WHERE invite_groups.id = applications.invite_group_id)
          AS invite_group_legacy_id,
        trainee_telegram_user_id,
        trainee_telegram_chat_id,
        telegram_username,
        telegram_code,
        name,
        phone,
        training,
        training_date::text AS training_date,
        attempt,
        limits,
        status,
        recruiter_comment,
        venue_id,
        group_link,
        candidate_report,
        experience,
        mentor_report_received,
        mentor_report_at,
        mentor_reporter_telegram_user_id,
        mentor_decision,
        mentor_report_venue_id,
        mentor_report_venue,
        mentor_report_loft,
        mentor_report_hall,
        mentor_comment_for_trainee,
        mentor_comment_sent_at,
        mentor_comment_delivery_status,
        mentor_comment_delivery_error,
        created_at
      FROM applications
      ORDER BY legacy_id
    `);
  const inviteGroupsResult = await client.query(`
      SELECT
        invite_groups.legacy_id,
        shifts.legacy_id AS shift_legacy_id,
        invite_groups.venue_id,
        invite_groups.link,
        invite_groups.sent_at
      FROM invite_groups
      JOIN shifts ON shifts.id = invite_groups.shift_id
      ORDER BY invite_groups.legacy_id
    `);
  const membersResult = await client.query(`
      SELECT
        invite_groups.legacy_id AS invite_group_legacy_id,
        applications.legacy_id AS application_legacy_id
      FROM invite_group_members
      JOIN invite_groups ON invite_groups.id = invite_group_members.invite_group_id
      JOIN applications ON applications.id = invite_group_members.application_id
      ORDER BY invite_groups.legacy_id, applications.legacy_id
    `);

  if (metaResult.rowCount !== 1) {
    throw new Error('PostgreSQL booking_state_meta must contain exactly one row.');
  }

  const memberIdsByGroup = new Map();
  for (const row of membersResult.rows) {
    const groupId = legacyId(row.invite_group_legacy_id, 'invite_group_members.invite_group_id');
    const applicationId = legacyId(row.application_legacy_id, 'invite_group_members.application_id');
    const memberIds = memberIdsByGroup.get(groupId) || [];
    memberIds.push(applicationId);
    memberIdsByGroup.set(groupId, memberIds);
  }

  const state = {
    version: Number(metaResult.rows[0].version),
    updatedAt: timestampText(metaResult.rows[0].updated_at),
    shifts: shiftsResult.rows.map(row => ({
      id: legacyId(row.legacy_id, 'shifts.legacy_id'),
      date: dateText(row.date),
      seats: row.seats,
      open: row.open,
      canceled: row.canceled,
      canceledAt: timestampText(row.canceled_at)
    })),
    applications: applicationsResult.rows.map(row => {
      const application = {
        id: legacyId(row.legacy_id, 'applications.legacy_id'),
        shiftId: row.shift_legacy_id === null
          ? null
          : legacyId(row.shift_legacy_id, 'applications.shift_id'),
        name: row.name,
        phone: row.phone,
        training: row.training,
        trainingDate: dateText(row.training_date),
        attempt: row.attempt,
        limits: row.limits,
        status: row.status,
        comment: row.recruiter_comment,
        inviteGroupId: row.invite_group_legacy_id === null
          ? null
          : legacyId(row.invite_group_legacy_id, 'applications.invite_group_id'),
        venueId: row.venue_id,
        groupLink: row.group_link,
        telegramCode: row.telegram_code || '',
        telegramChatId: row.trainee_telegram_chat_id || '',
        telegramUserId: row.trainee_telegram_user_id || '',
        telegramUsername: row.telegram_username || '',
        candidateReport: row.candidate_report,
        mentorReport: row.mentor_report_received,
        mentorReportAt: timestampText(row.mentor_report_at),
        mentorReporterTelegramUserId: row.mentor_reporter_telegram_user_id || '',
        mentorDecision: row.mentor_decision,
        mentorReportVenueId: row.mentor_report_venue_id,
        mentorReportVenue: row.mentor_report_venue,
        mentorReportLoft: row.mentor_report_loft,
        mentorReportHall: row.mentor_report_hall,
        mentorCommentForTrainee: row.mentor_comment_for_trainee,
        mentorCommentSentAt: timestampText(row.mentor_comment_sent_at),
        mentorCommentDeliveryStatus: row.mentor_comment_delivery_status || '',
        mentorCommentDeliveryError: row.mentor_comment_delivery_error,
        createdAt: timestampText(row.created_at)
      };
      if (row.experience) application.experience = row.experience;
      return application;
    }),
    inviteGroups: inviteGroupsResult.rows.map(row => {
      const id = legacyId(row.legacy_id, 'invite_groups.legacy_id');
      return {
        id,
        shiftId: legacyId(row.shift_legacy_id, 'invite_groups.shift_id'),
        venueId: row.venue_id,
        link: row.link,
        memberIds: memberIdsByGroup.get(id) || [],
        sentAt: timestampText(row.sent_at)
      };
    })
  };

  return normalizeBookingState(state);
}

export function bookingStateParitySnapshot(state) {
  const normalized = normalizeBookingState(state);
  return {
    version: normalized.version,
    updatedAt: normalized.updatedAt,
    shifts: [...normalized.shifts]
      .map(shift => compactOptionalFields(shift, new Set(['canceled'])))
      .sort((left, right) => left.id - right.id),
    applications: normalized.applications
      .map(({ createdAt: _createdAt, ...application }) => (
        compactOptionalFields(application, new Set(['candidateReport', 'mentorReport']))
      ))
      .sort((left, right) => left.id - right.id),
    inviteGroups: normalized.inviteGroups
      .map(group => ({
        ...compactOptionalFields(group),
        memberIds: [...group.memberIds].sort((left, right) => left - right)
      }))
      .sort((left, right) => left.id - right.id)
  };
}

function firstDifference(left, right, path = 'state') {
  if (isDeepStrictEqual(left, right)) return '';
  if (
    left === null
    || right === null
    || typeof left !== 'object'
    || typeof right !== 'object'
  ) {
    return path;
  }
  const keys = new Set([...Object.keys(left), ...Object.keys(right)]);
  for (const key of keys) {
    const difference = firstDifference(left[key], right[key], `${path}.${key}`);
    if (difference) return difference;
  }
  return path;
}

export function verifyBookingStateParity(sourceState, postgresState) {
  const source = bookingStateParitySnapshot(sourceState);
  const target = bookingStateParitySnapshot(postgresState);
  const difference = firstDifference(source, target);
  if (difference) {
    throw new Error(`PostgreSQL booking-state parity mismatch at ${difference}.`);
  }
  return {
    shifts: source.shifts.length,
    applications: source.applications.length,
    inviteGroups: source.inviteGroups.length,
    statuses: statusCounts(source.applications)
  };
}
