import assert from 'node:assert/strict';
import test from 'node:test';
import {
  PostgresCommandAuthorizationError,
  PostgresCommandConflictError,
  PostgresCommandValidationError,
  assignShiftInPostgres,
  cancelApplicationInPostgres,
  cancelInternshipInPostgres,
  cancelShiftInPostgres,
  createShiftInPostgres,
  markExperiencedInPostgres,
  returnToQueueInPostgres,
  sendInvitesInPostgres,
  setApplicationStatusInPostgres,
  stepBackApplicationInPostgres,
  toggleShiftInPostgres,
  updateCommentInPostgres,
  updateShiftCapacityInPostgres,
  upsertTraineeApplicationInPostgres
} from '../src/postgres/write-booking-command.js';

const DEFAULT_META_UPDATED_AT = '2026-07-01T00:00:00.000Z';

function fakePool({
  currentVersion = 10,
  metaUpdatedAt = DEFAULT_META_UPDATED_AT,
  existingShifts = [],
  existingApplications = [],
  existingInviteGroups = [],
  existingInviteGroupMembers = [],
  existingMentorReports = [],
  existingNotifications = [],
  eventInsertThrows = false,
  notificationInsertThrows = false,
  rollbackThrows = false
} = {}) {
  const calls = [];
  const shifts = existingShifts.map(row => ({ ...row }));
  const apps = existingApplications.map(row => ({ ...row }));
  const inviteGroups = existingInviteGroups.map(row => ({ ...row }));
  const notifications = existingNotifications.map(row => ({ ...row }));
  const inviteGroupMembers = existingInviteGroupMembers.map(row => ({ ...row }));
  const mentorReports = existingMentorReports.map(row => ({ ...row }));
  let version = currentVersion;
  let updatedAt = metaUpdatedAt;

  function findAppByLegacyId(legacyId) {
    return apps.find(app => Number(app.legacy_id) === Number(legacyId));
  }
  function findShiftByUuid(uuid) {
    return shifts.find(row => String(row.id) === String(uuid));
  }
  function findInviteGroupByUuid(uuid) {
    return inviteGroups.find(row => String(row.id) === String(uuid));
  }

  const client = {
    async query(sql, params = []) {
      calls.push({ sql, params });
      if (/^BEGIN$/i.test(sql)) return { rowCount: 0, rows: [] };
      if (/^COMMIT$/i.test(sql)) return { rowCount: 0, rows: [] };
      if (/^ROLLBACK$/i.test(sql)) {
        if (rollbackThrows) throw new Error('rollback failure');
        return { rowCount: 0, rows: [] };
      }
      if (/SELECT version.*FROM booking_state_meta/is.test(sql)) {
        return { rowCount: 1, rows: [{ version, updated_at: updatedAt }] };
      }
      if (/SELECT 1 FROM shifts WHERE date/.test(sql)) {
        const hit = shifts.find(row => row.date === params[0]);
        return { rowCount: hit ? 1 : 0, rows: hit ? [{ '?column?': 1 }] : [] };
      }
      if (/SELECT COALESCE\(MAX\(legacy_id\), 0\) AS max_legacy_id FROM shifts/.test(sql)) {
        const max = shifts.reduce((acc, row) => Math.max(acc, Number(row.legacy_id) || 0), 0);
        return { rowCount: 1, rows: [{ max_legacy_id: max }] };
      }
      if (/SELECT COALESCE\(MAX\(legacy_id\), 0\) AS max_legacy_id FROM invite_groups/.test(sql)) {
        const max = (inviteGroups || []).reduce((acc, row) => Math.max(acc, Number(row.legacy_id) || 0), 0);
        return { rowCount: 1, rows: [{ max_legacy_id: max }] };
      }
      if (/SELECT id, legacy_id, date::text AS date, open, canceled, canceled_at/i.test(sql)) {
        const row = shifts.find(item => Number(item.legacy_id) === Number(params[0]));
        return { rowCount: row ? 1 : 0, rows: row ? [{
          id: row.id,
          legacy_id: row.legacy_id,
          date: row.date,
          open: row.open,
          canceled: row.canceled,
          canceled_at: row.canceled_at ?? null
        }] : [] };
      }
      if (/SELECT id, legacy_id, seats, date::text AS date/i.test(sql)) {
        const row = shifts.find(item => Number(item.legacy_id) === Number(params[0]));
        return { rowCount: row ? 1 : 0, rows: row ? [{
          id: row.id,
          legacy_id: row.legacy_id,
          seats: row.seats,
          date: row.date
        }] : [] };
      }
      if (/SELECT id, legacy_id, seats, open, canceled, date::text AS date/i.test(sql)) {
        const row = shifts.find(item => Number(item.legacy_id) === Number(params[0]));
        return { rowCount: row ? 1 : 0, rows: row ? [{
          id: row.id,
          legacy_id: row.legacy_id,
          seats: row.seats,
          open: row.open,
          canceled: row.canceled,
          date: row.date
        }] : [] };
      }
      if (/SELECT id, legacy_id, open, canceled, date::text AS date/i.test(sql)) {
        const row = findShiftByUuid(params[0]);
        return { rowCount: row ? 1 : 0, rows: row ? [{
          id: row.id,
          legacy_id: row.legacy_id,
          open: row.open,
          canceled: row.canceled,
          date: row.date
        }] : [] };
      }
      if (/FROM applications\s+LEFT JOIN invite_groups ON invite_groups\.id = applications\.invite_group_id/is.test(sql)) {
        const shiftUuid = String(params[0]);
        const allowedStatuses = new Set((params[1] || []).map(String));
        const rows = apps
          .filter(app => String(app.shift_id) === shiftUuid && allowedStatuses.has(String(app.status)))
          .map(row => {
            const group = findInviteGroupByUuid(row.invite_group_id);
            return {
              id: row.id,
              legacy_id: row.legacy_id,
              status: row.status,
              shift_id: row.shift_id,
              invite_group_id: row.invite_group_id ?? null,
              invite_group_legacy_id: group?.legacy_id ?? null,
              venue_id: row.venue_id ?? null,
              group_link: row.group_link ?? '',
              trainee_telegram_user_id: row.trainee_telegram_user_id ?? row.telegram_user_id ?? null,
              trainee_telegram_chat_id: row.trainee_telegram_chat_id ?? row.telegram_chat_id ?? null,
              telegram_username: row.telegram_username ?? '',
              name: row.name ?? ''
            };
          })
          .sort((left, right) => Number(left.legacy_id) - Number(right.legacy_id));
        return { rowCount: rows.length, rows };
      }
      if (/FROM applications\s+LEFT JOIN shifts ON shifts\.id = applications\.shift_id/is.test(sql)) {
        const row = findAppByLegacyId(params[0]);
        const shift = row ? findShiftByUuid(row.shift_id) : null;
        const group = row ? findInviteGroupByUuid(row.invite_group_id) : null;
        return { rowCount: row ? 1 : 0, rows: row ? [{
          id: row.id,
          legacy_id: row.legacy_id,
          status: row.status,
          shift_id: row.shift_id,
          shift_legacy_id: shift?.legacy_id ?? null,
          shift_date: shift?.date ?? null,
          invite_group_id: row.invite_group_id ?? null,
          invite_group_legacy_id: group?.legacy_id ?? null,
          venue_id: row.venue_id ?? null,
          group_link: row.group_link ?? '',
          trainee_telegram_user_id: row.trainee_telegram_user_id ?? row.telegram_user_id ?? null,
          trainee_telegram_chat_id: row.trainee_telegram_chat_id ?? row.telegram_chat_id ?? null,
          telegram_username: row.telegram_username ?? '',
          telegram_code: row.telegram_code ?? '',
          name: row.name ?? '',
          phone: row.phone ?? '',
          training: row.training ?? 'passed',
          training_date: row.training_date ?? null,
          attempt: row.attempt ?? 'first',
          limits: row.limits ?? '',
          recruiter_comment: row.recruiter_comment ?? '',
          experience: row.experience ?? null,
          mentor_report_received: Boolean(row.mentor_report_received)
        }] : [] };
      }
      if (/FROM invite_groups\s+WHERE id = ANY\(\$1::uuid\[\]\)/i.test(sql)) {
        const requested = new Set((params[0] || []).map(String));
        const rows = inviteGroups
          .filter(row => requested.has(String(row.id)))
          .map(row => ({
            id: row.id,
            legacy_id: row.legacy_id,
            shift_id: row.shift_id,
            venue_id: row.venue_id,
            link: row.link
          }))
          .sort((left, right) => Number(left.legacy_id) - Number(right.legacy_id));
        return { rowCount: rows.length, rows };
      }
      if (/SELECT id, legacy_id, shift_id, venue_id, link\s+FROM invite_groups/i.test(sql)) {
        const row = findInviteGroupByUuid(params[0]);
        return { rowCount: row ? 1 : 0, rows: row ? [{
          id: row.id,
          legacy_id: row.legacy_id,
          shift_id: row.shift_id,
          venue_id: row.venue_id,
          link: row.link
        }] : [] };
      }
      if (/SELECT invite_group_members\.invite_group_id,\s+applications\.id AS application_id,\s+applications\.legacy_id/is.test(sql)) {
        const requested = new Set((params[0] || []).map(String));
        const rows = inviteGroupMembers
          .filter(member => requested.has(String(member.invite_group_id)))
          .map(member => {
            const app = apps.find(item => String(item.id) === String(member.application_id));
            if (!app) return null;
            return {
              invite_group_id: member.invite_group_id,
              application_id: member.application_id,
              legacy_id: app.legacy_id
            };
          })
          .filter(Boolean)
          .sort((left, right) => {
            const groupCompare = String(left.invite_group_id)
              .localeCompare(String(right.invite_group_id));
            return groupCompare || Number(left.legacy_id) - Number(right.legacy_id);
          });
        return { rowCount: rows.length, rows };
      }
      if (/SELECT applications\.legacy_id\s+FROM invite_group_members/i.test(sql)) {
        const groupUuid = String(params[0]);
        const rows = inviteGroupMembers
          .filter(member => String(member.invite_group_id) === groupUuid)
          .map(member => apps.find(app => String(app.id) === String(member.application_id)))
          .filter(Boolean)
          .map(app => ({ legacy_id: app.legacy_id }))
          .sort((left, right) => Number(left.legacy_id) - Number(right.legacy_id));
        return { rowCount: rows.length, rows };
      }
      if (/SELECT id, legacy_id, status, shift_id\s+FROM applications/i.test(sql)) {
        const row = findAppByLegacyId(params[0]);
        return { rowCount: row ? 1 : 0, rows: row ? [{
          id: row.id,
          legacy_id: row.legacy_id,
          status: row.status,
          shift_id: row.shift_id
        }] : [] };
      }
      if (/SELECT id, legacy_id, status, shift_id, venue_id, group_link/i.test(sql)) {
        const requested = params[0] || [];
        const rows = requested
          .map(legacyId => findAppByLegacyId(legacyId))
          .filter(Boolean)
          .map(row => ({
            id: row.id,
            legacy_id: row.legacy_id,
            status: row.status,
            shift_id: row.shift_id,
            venue_id: row.venue_id ?? null,
            group_link: row.group_link ?? '',
            trainee_telegram_user_id: row.trainee_telegram_user_id ?? row.telegram_user_id ?? null,
            trainee_telegram_chat_id: row.trainee_telegram_chat_id ?? row.telegram_chat_id ?? null,
            telegram_username: row.telegram_username ?? '',
            name: row.name ?? ''
          }));
        rows.sort((left, right) => Number(left.legacy_id) - Number(right.legacy_id));
        return { rowCount: rows.length, rows };
      }
      if (/SELECT id, legacy_id, status, shift_id, invite_group_id, group_link, experience/i.test(sql)) {
        const row = findAppByLegacyId(params[0]);
        return { rowCount: row ? 1 : 0, rows: row ? [{
          id: row.id,
          legacy_id: row.legacy_id,
          status: row.status,
          shift_id: row.shift_id,
          invite_group_id: row.invite_group_id,
          group_link: row.group_link,
          experience: row.experience
        }] : [] };
      }
      if (/SELECT status, mentor_report_received\s+FROM applications\s+WHERE shift_id/i.test(sql)) {
        const shiftUuid = String(params[0]);
        const rows = apps
          .filter(app => String(app.shift_id) === shiftUuid)
          .map(app => ({
            status: app.status,
            mentor_report_received: Boolean(app.mentor_report_received)
          }));
        return { rowCount: rows.length, rows };
      }
      if (/SELECT id,\s+legacy_id,\s+status,\s+trainee_telegram_user_id/is.test(sql)
        && /FROM applications/i.test(sql)
        && /WHERE shift_id = \$1/i.test(sql)) {
        const shiftUuid = String(params[0]);
        const allowedStatuses = new Set((params[1] || []).map(String));
        const rows = apps
          .filter(app => String(app.shift_id) === shiftUuid && allowedStatuses.has(String(app.status)))
          .map(app => ({
            id: app.id,
            legacy_id: app.legacy_id,
            status: app.status,
            trainee_telegram_user_id: app.trainee_telegram_user_id ?? app.telegram_user_id ?? null,
            trainee_telegram_chat_id: app.trainee_telegram_chat_id ?? app.telegram_chat_id ?? null,
            telegram_username: app.telegram_username ?? '',
            name: app.name ?? ''
          }))
          .sort((left, right) => Number(left.legacy_id) - Number(right.legacy_id));
        return { rowCount: rows.length, rows };
      }
      if (/SELECT COUNT\(\*\)::int AS used\s+FROM applications/i.test(sql)) {
        const shiftUuid = String(params[0]);
        const allowedStatuses = new Set((params[1] || []).map(String));
        const excludedLegacyId = params.length > 2 ? String(params[2]) : null;
        const used = apps.filter(app => (
          String(app.shift_id) === shiftUuid
          && allowedStatuses.has(String(app.status))
          && (excludedLegacyId === null || String(app.legacy_id) !== excludedLegacyId)
        )).length;
        return { rowCount: 1, rows: [{ used }] };
      }
      if (/INSERT INTO applications/i.test(sql)) {
        apps.push({
          id: params[0],
          legacy_id: params[1],
          shift_id: params[2],
          invite_group_id: null,
          trainee_telegram_user_id: params[3],
          trainee_telegram_chat_id: params[4],
          telegram_username: params[5],
          telegram_code: params[6],
          name: params[7],
          phone: params[8],
          training: params[9],
          training_date: params[10],
          attempt: params[11],
          limits: params[12],
          status: params[13],
          recruiter_comment: params[14],
          venue_id: null,
          group_link: '',
          candidate_report: false,
          experience: null,
          mentor_report_received: false,
          mentor_report_at: null,
          mentor_reporter_telegram_user_id: null,
          mentor_decision: '',
          mentor_report_venue_id: '',
          mentor_report_venue: '',
          mentor_report_loft: '',
          mentor_report_hall: '',
          mentor_comment_for_trainee: '',
          mentor_comment_sent_at: null,
          mentor_comment_delivery_status: null,
          mentor_comment_delivery_error: '',
          created_at: params[15],
          updated_at: params[15],
          row_version: 1
        });
        return { rowCount: 1, rows: [] };
      }
      if (/INSERT INTO shifts/.test(sql)) {
        shifts.push({
          id: params[0],
          legacy_id: params[1],
          date: params[2],
          seats: params[3],
          open: true,
          canceled: false
        });
        return { rowCount: 1, rows: [] };
      }
      if (/INSERT INTO invite_groups/.test(sql)) {
        inviteGroups.push({
          id: params[0],
          legacy_id: params[1],
          shift_id: params[2],
          venue_id: params[3],
          link: params[4],
          sent_at: params[5],
          created_by_telegram_user_id: params[6]
        });
        return { rowCount: 1, rows: [] };
      }
      if (/INSERT INTO invite_group_members/.test(sql)) {
        inviteGroupMembers.push({
          invite_group_id: params[0],
          application_id: params[1],
          created_at: params[2]
        });
        return { rowCount: 1, rows: [] };
      }
      if (/INSERT INTO notifications/i.test(sql)) {
        if (notificationInsertThrows) {
          throw new Error('notification insert failed');
        }
        const idempotencyKey = params[9];
        if (
          idempotencyKey
          && notifications.some(row => String(row.idempotency_key) === String(idempotencyKey))
        ) {
          return { rowCount: 0, rows: [] };
        }
        notifications.push({
          id: params[0],
          application_id: params[1],
          type: params[2],
          chat_id: params[3],
          chat_target: params[4],
          text: params[5],
          parse_mode: params[6],
          status: params[7],
          error: params[8],
          idempotency_key: params[9],
          next_attempt_at: params[10],
          created_at: params[11],
          updated_at: params[12]
        });
        return { rowCount: 1, rows: [] };
      }
      if (/UPDATE applications\s+SET status = 'invited'/i.test(sql)) {
        const groupUuid = params[0];
        const venueId = params[1];
        const linkValue = params[2];
        const nowIso = params[3];
        const appUuids = new Set((params[4] || []).map(String));
        let count = 0;
        for (const app of apps) {
          if (appUuids.has(String(app.id))) {
            app.status = 'invited';
            app.invite_group_id = groupUuid;
            app.venue_id = venueId;
            app.group_link = linkValue;
            app.updated_at = nowIso;
            count += 1;
          }
        }
        return { rowCount: count, rows: [] };
      }
      if (/UPDATE applications\s+SET recruiter_comment/i.test(sql)) {
        const comment = params[0];
        const nowIso = params[1];
        const appUuid = String(params[2]);
        const target = apps.find(app => String(app.id) === appUuid);
        if (target) {
          target.recruiter_comment = comment;
          target.updated_at = nowIso;
        }
        return { rowCount: target ? 1 : 0, rows: [] };
      }
      if (/UPDATE mentor_reports\s+SET voided_at/i.test(sql)) {
        const nowIso = params[0];
        const appUuid = String(params[1]);
        let count = 0;
        for (const report of mentorReports) {
          if (String(report.application_id) === appUuid && !report.voided_at) {
            report.voided_at = nowIso;
            count += 1;
          }
        }
        return { rowCount: count, rows: [] };
      }
      if (/UPDATE applications\s+SET shift_id = \$1,\s+invite_group_id = NULL/is.test(sql)) {
        const target = apps.find(app => String(app.id) === String(params[14]));
        if (target) {
          target.shift_id = params[0];
          target.invite_group_id = null;
          target.trainee_telegram_user_id = params[1];
          target.trainee_telegram_chat_id = params[2];
          target.telegram_username = params[3];
          target.telegram_code = params[4];
          target.name = params[5];
          target.phone = params[6];
          target.training = params[7];
          target.training_date = params[8];
          target.attempt = params[9];
          target.limits = params[10];
          target.status = params[11];
          target.recruiter_comment = params[12];
          target.venue_id = null;
          target.group_link = '';
          target.candidate_report = false;
          target.experience = null;
          target.mentor_report_received = false;
          target.mentor_report_at = null;
          target.mentor_reporter_telegram_user_id = null;
          target.mentor_decision = '';
          target.mentor_report_venue_id = '';
          target.mentor_report_venue = '';
          target.mentor_report_loft = '';
          target.mentor_report_hall = '';
          target.mentor_comment_for_trainee = '';
          target.mentor_comment_sent_at = null;
          target.mentor_comment_delivery_status = null;
          target.mentor_comment_delivery_error = '';
          target.updated_at = params[13];
          target.row_version = Number(target.row_version || 1) + 1;
        }
        return { rowCount: target ? 1 : 0, rows: [] };
      }
      if (/UPDATE applications\s+SET shift_id = NULL/i.test(sql)) {
        const nowIso = params[0];
        const targetUuids = Array.isArray(params[1])
          ? new Set(params[1].map(String))
          : new Set([String(params[1])]);
        let count = 0;
        for (const target of apps) {
          if (!targetUuids.has(String(target.id))) continue;
          target.shift_id = null;
          target.invite_group_id = null;
          target.status = 'queue';
          target.venue_id = null;
          target.group_link = '';
          target.candidate_report = false;
          target.mentor_report_received = false;
          target.mentor_report_at = null;
          target.mentor_reporter_telegram_user_id = null;
          target.mentor_decision = '';
          target.mentor_report_venue_id = '';
          target.mentor_report_venue = '';
          target.mentor_report_loft = '';
          target.mentor_report_hall = '';
          target.mentor_comment_for_trainee = '';
          target.mentor_comment_sent_at = null;
          target.mentor_comment_delivery_status = null;
          target.mentor_comment_delivery_error = '';
          target.updated_at = nowIso;
          count += 1;
        }
        return { rowCount: count, rows: [] };
      }
      if (/DELETE FROM invite_group_members\s+WHERE application_id = ANY/i.test(sql)) {
        const appUuids = new Set((params[0] || []).map(String));
        const before = inviteGroupMembers.length;
        for (let index = inviteGroupMembers.length - 1; index >= 0; index -= 1) {
          if (appUuids.has(String(inviteGroupMembers[index].application_id))) {
            inviteGroupMembers.splice(index, 1);
          }
        }
        return { rowCount: before - inviteGroupMembers.length, rows: [] };
      }
      if (/DELETE FROM invite_group_members/i.test(sql)) {
        const groupUuid = String(params[0]);
        const appUuid = String(params[1]);
        const before = inviteGroupMembers.length;
        for (let index = inviteGroupMembers.length - 1; index >= 0; index -= 1) {
          const member = inviteGroupMembers[index];
          if (
            String(member.invite_group_id) === groupUuid
            && String(member.application_id) === appUuid
          ) {
            inviteGroupMembers.splice(index, 1);
          }
        }
        return { rowCount: before - inviteGroupMembers.length, rows: [] };
      }
      if (/DELETE FROM invite_groups WHERE id/i.test(sql)) {
        const groupUuid = String(params[0]);
        const index = inviteGroups.findIndex(group => String(group.id) === groupUuid);
        if (index >= 0) inviteGroups.splice(index, 1);
        return { rowCount: index >= 0 ? 1 : 0, rows: [] };
      }
      if (/UPDATE invite_groups\s+SET updated_at/i.test(sql)) {
        const nowIso = params[0];
        const groupUuid = String(params[1]);
        const target = findInviteGroupByUuid(groupUuid);
        if (target) target.updated_at = nowIso;
        return { rowCount: target ? 1 : 0, rows: [] };
      }
      if (/UPDATE shifts\s+SET seats/i.test(sql)) {
        const seatsValue = Number(params[0]);
        const shiftUuid = String(params[2]);
        const target = findShiftByUuid(shiftUuid);
        if (target) {
          target.seats = seatsValue;
          target.updated_at = params[1];
        }
        return { rowCount: target ? 1 : 0, rows: [] };
      }
      if (/UPDATE shifts\s+SET open = \$1,\s+canceled = CASE WHEN \$1 THEN false ELSE canceled END/is.test(sql)) {
        const nextOpen = Boolean(params[0]);
        const shiftUuid = String(params[2]);
        const target = findShiftByUuid(shiftUuid);
        if (target) {
          target.open = nextOpen;
          if (nextOpen) {
            target.canceled = false;
            target.canceled_at = null;
          }
          target.updated_at = params[1];
        }
        return { rowCount: target ? 1 : 0, rows: [] };
      }
      if (/UPDATE shifts\s+SET open = false,\s+canceled = true/is.test(sql)) {
        const shiftUuid = String(params[1]);
        const target = findShiftByUuid(shiftUuid);
        if (target) {
          target.open = false;
          target.canceled = true;
          target.canceled_at = params[0];
          target.updated_at = params[0];
        }
        return { rowCount: target ? 1 : 0, rows: [] };
      }
      if (/UPDATE shifts\s+SET open = false/i.test(sql)) {
        const shiftUuid = String(params[1]);
        const target = findShiftByUuid(shiftUuid);
        if (target) {
          target.open = false;
          target.updated_at = params[0];
        }
        return { rowCount: target ? 1 : 0, rows: [] };
      }
      if (/UPDATE applications\s+SET status = \$1,\s+mentor_report_received = false/is.test(sql)) {
        const nextStatus = params[0];
        const nowIso = params[1];
        const appUuid = String(params[2]);
        const target = apps.find(app => String(app.id) === appUuid);
        if (target) {
          target.status = nextStatus;
          target.mentor_report_received = false;
          target.mentor_report_at = null;
          target.mentor_reporter_telegram_user_id = null;
          target.mentor_decision = '';
          target.mentor_report_venue_id = '';
          target.mentor_report_venue = '';
          target.mentor_report_loft = '';
          target.mentor_report_hall = '';
          target.mentor_comment_for_trainee = '';
          target.mentor_comment_sent_at = null;
          target.mentor_comment_delivery_status = null;
          target.mentor_comment_delivery_error = '';
          target.experience = null;
          target.updated_at = nowIso;
        }
        return { rowCount: target ? 1 : 0, rows: [] };
      }
      if (/UPDATE applications\s+SET status = \$1,\s+updated_at = \$2/is.test(sql)) {
        const nextStatus = params[0];
        const nowIso = params[1];
        const appUuid = String(params[2]);
        const target = apps.find(app => String(app.id) === appUuid);
        if (target) {
          target.status = nextStatus;
          target.updated_at = nowIso;
        }
        return { rowCount: target ? 1 : 0, rows: [] };
      }
      if (/UPDATE applications\s+SET experience = 'experienced'/is.test(sql)) {
        const nowIso = params[0];
        const appUuid = String(params[1]);
        const target = apps.find(app => String(app.id) === appUuid);
        if (target) {
          target.experience = 'experienced';
          target.updated_at = nowIso;
        }
        return { rowCount: target ? 1 : 0, rows: [] };
      }
      if (/UPDATE applications\s+SET status/i.test(sql)) {
        const nextStatus = params[0];
        const nextExperience = params[1];
        const nowIso = params[2];
        const appUuid = String(params[3]);
        const target = apps.find(app => String(app.id) === appUuid);
        if (target) {
          target.status = nextStatus;
          target.experience = nextExperience;
          target.updated_at = nowIso;
        }
        return { rowCount: target ? 1 : 0, rows: [] };
      }
      if (/UPDATE applications\s+SET shift_id/i.test(sql)) {
        const shiftUuid = params[0];
        const nextStatus = params[1];
        const nowIso = params[2];
        const appUuid = String(params[3]);
        const target = apps.find(app => String(app.id) === appUuid);
        if (target) {
          target.shift_id = shiftUuid;
          target.status = nextStatus;
          target.updated_at = nowIso;
        }
        return { rowCount: target ? 1 : 0, rows: [] };
      }
      if (/UPDATE booking_state_meta/.test(sql)) {
        version = Number(params[0]);
        updatedAt = params[1];
        return { rowCount: 1, rows: [] };
      }
      if (/DELETE FROM applications WHERE id = \$1/i.test(sql)) {
        const appUuid = String(params[0]);
        const index = apps.findIndex(app => String(app.id) === appUuid);
        if (index >= 0) apps.splice(index, 1);
        return { rowCount: index >= 0 ? 1 : 0, rows: [] };
      }
      if (/FROM applications WHERE legacy_id = ANY/.test(sql)) {
        const requested = new Set((params[0] || []).map(String));
        const rows = apps
          .filter(app => requested.has(String(app.legacy_id)))
          .map(app => ({ legacy_id: app.legacy_id, id: app.id }));
        return { rowCount: rows.length, rows };
      }
      if (/FROM shifts WHERE legacy_id = ANY/.test(sql)) {
        const requested = new Set((params[0] || []).map(String));
        const rows = shifts
          .filter(row => requested.has(String(row.legacy_id)))
          .map(row => ({ legacy_id: row.legacy_id, id: row.id }));
        return { rowCount: rows.length, rows };
      }
      if (/INSERT INTO application_events/.test(sql)) {
        if (eventInsertThrows) throw new Error('event insert failed');
        return { rowCount: 1, rows: [] };
      }
      return { rowCount: 0, rows: [] };
    },
    release() {
      calls.push({ sql: 'RELEASE' });
    }
  };
  return {
    calls,
    getVersion: () => version,
    getUpdatedAt: () => updatedAt,
    getInviteGroups: () => inviteGroups,
    getInviteGroupMembers: () => inviteGroupMembers,
    getMentorReports: () => mentorReports,
    getNotifications: () => notifications,
    getShifts: () => shifts,
    getApplications: () => apps,
    async connect() {
      calls.push({ sql: 'CONNECT' });
      return client;
    }
  };
}

const recruiter = { role: 'recruiter', telegram: { user: { id: '111' } } };
const trainee = { role: 'trainee', userId: '222', telegram: { user: { id: '222', username: 'trainee_user' } } };

function traineeApplication(overrides = {}) {
  return {
    id: 501,
    shiftId: 88,
    name: 'Иван Иванов',
    phone: '+7 999 123-45-67',
    training: 'passed',
    trainingDate: '2026-07-20',
    attempt: 'first',
    limits: 'Нет',
    telegramCode: '@manual_note',
    status: 'pending',
    comment: '',
    ...overrides
  };
}

test('upsertTraineeApplicationInPostgres creates pending application, event and version bump', async () => {
  const pool = fakePool({
    currentVersion: 10,
    existingShifts: [{
      id: 'shift-uuid-88',
      legacy_id: 88,
      date: '2026-08-01',
      seats: 2,
      open: true,
      canceled: false
    }]
  });
  const now = new Date('2026-07-29T12:00:00.000Z');

  const result = await upsertTraineeApplicationInPostgres({
    pool,
    actor: trainee,
    command: {
      action: 'upsert_trainee_application',
      baseVersion: 10,
      application: traineeApplication()
    },
    now
  });

  assert.equal(result.version, 11);
  assert.equal(result.previousVersion, 10);
  assert.equal(result.applicationLegacyId, 501);
  assert.equal(result.nextStatus, 'pending');
  assert.equal(result.shiftLegacyId, 88);
  assert.equal(result.created, true);
  assert.equal(result.updated, false);
  const [app] = pool.getApplications();
  assert.equal(app.legacy_id, 501);
  assert.equal(app.shift_id, 'shift-uuid-88');
  assert.equal(app.trainee_telegram_user_id, '222');
  assert.equal(app.trainee_telegram_chat_id, '222');
  assert.equal(app.telegram_username, 'trainee_user');
  assert.equal(app.phone, '+7 999 123-45-67');
  assert.equal(app.training_date, '2026-07-20');
  const eventInserts = pool.calls.filter(call => /INSERT INTO application_events/.test(call.sql));
  assert.equal(eventInserts.length, 1);
  assert.equal(eventInserts[0].params[3], 'application_created');
  assert.match(eventInserts[0].params[6], /"action":"upsert_trainee_application"/);
  assert.ok(pool.calls.some(call => /^COMMIT$/i.test(call.sql)));
});

test('upsertTraineeApplicationInPostgres creates queue application without locking a shift', async () => {
  const pool = fakePool({ currentVersion: 10 });
  const result = await upsertTraineeApplicationInPostgres({
    pool,
    actor: trainee,
    command: {
      action: 'upsert_trainee_application',
      baseVersion: 10,
      application: traineeApplication({ id: 502, shiftId: null, status: 'queue' })
    },
    now: new Date('2026-07-29T12:00:00.000Z')
  });

  assert.equal(result.version, 11);
  assert.equal(result.shiftLegacyId, null);
  assert.equal(pool.getApplications()[0].shift_id, null);
  assert.equal(
    pool.calls.some(call => /FROM shifts\s+WHERE legacy_id = \$1\s+FOR UPDATE/is.test(call.sql)),
    false
  );
});

test('upsertTraineeApplicationInPostgres updates own queue app into pending and audits transition', async () => {
  const pool = fakePool({
    currentVersion: 10,
    existingShifts: [{
      id: 'shift-uuid-88',
      legacy_id: 88,
      date: '2026-08-01',
      seats: 2,
      open: true,
      canceled: false
    }],
    existingApplications: [{
      id: 'app-uuid-501',
      legacy_id: 501,
      shift_id: null,
      status: 'queue',
      trainee_telegram_user_id: '222',
      trainee_telegram_chat_id: '222',
      telegram_username: 'old_name',
      telegram_code: '',
      name: 'Иван Иванов',
      phone: '+7 999 123-45-67',
      training: 'not_passed',
      training_date: null,
      attempt: 'repeat',
      limits: 'Было',
      recruiter_comment: ''
    }]
  });

  const result = await upsertTraineeApplicationInPostgres({
    pool,
    actor: trainee,
    command: {
      action: 'upsert_trainee_application',
      baseVersion: 10,
      application: traineeApplication({ limits: 'Можно после 17:00' })
    },
    now: new Date('2026-07-29T12:00:00.000Z')
  });

  assert.equal(result.created, false);
  assert.equal(result.updated, true);
  assert.equal(result.previousStatus, 'queue');
  assert.equal(result.nextStatus, 'pending');
  assert.equal(pool.getApplications()[0].shift_id, 'shift-uuid-88');
  assert.equal(pool.getApplications()[0].status, 'pending');
  assert.equal(pool.getApplications()[0].telegram_username, 'trainee_user');
  const eventTypes = pool.calls
    .filter(call => /INSERT INTO application_events/.test(call.sql))
    .map(call => call.params[3]);
  assert.deepEqual(eventTypes, [
    'application_status_changed',
    'application_updated',
    'application_assigned_to_shift'
  ]);
});

test('upsertTraineeApplicationInPostgres updates own pending app back to queue', async () => {
  const pool = fakePool({
    currentVersion: 10,
    existingShifts: [{
      id: 'shift-uuid-88',
      legacy_id: 88,
      date: '2026-08-01',
      seats: 2,
      open: true,
      canceled: false
    }],
    existingApplications: [{
      id: 'app-uuid-501',
      legacy_id: 501,
      shift_id: 'shift-uuid-88',
      status: 'pending',
      trainee_telegram_user_id: '222',
      trainee_telegram_chat_id: '222',
      telegram_username: 'trainee_user',
      telegram_code: '@manual_note',
      name: 'Иван Иванов',
      phone: '+7 999 123-45-67',
      training: 'passed',
      training_date: '2026-07-20',
      attempt: 'first',
      limits: 'Нет',
      recruiter_comment: ''
    }]
  });

  await upsertTraineeApplicationInPostgres({
    pool,
    actor: trainee,
    command: {
      action: 'upsert_trainee_application',
      baseVersion: 10,
      application: traineeApplication({ shiftId: null, status: 'queue' })
    },
    now: new Date('2026-07-29T12:00:00.000Z')
  });

  assert.equal(pool.getApplications()[0].shift_id, null);
  assert.equal(pool.getApplications()[0].status, 'queue');
  const eventTypes = pool.calls
    .filter(call => /INSERT INTO application_events/.test(call.sql))
    .map(call => call.params[3]);
  assert.deepEqual(eventTypes, ['application_returned_to_queue']);
});

test('upsertTraineeApplicationInPostgres rejects stale version before data writes', async () => {
  const pool = fakePool({ currentVersion: 11 });
  await assert.rejects(
    () => upsertTraineeApplicationInPostgres({
      pool,
      actor: trainee,
      command: {
        action: 'upsert_trainee_application',
        baseVersion: 10,
        application: traineeApplication({ shiftId: null, status: 'queue' })
      }
    }),
    PostgresCommandConflictError
  );
  assert.equal(pool.getApplications().length, 0);
  assert.ok(pool.calls.some(call => /^ROLLBACK$/i.test(call.sql)));
});

test('upsertTraineeApplicationInPostgres rejects unknown, closed, canceled and full shifts', async () => {
  await assert.rejects(
    () => upsertTraineeApplicationInPostgres({
      pool: fakePool({ currentVersion: 10 }),
      actor: trainee,
      command: { action: 'upsert_trainee_application', baseVersion: 10, application: traineeApplication() }
    }),
    /unknown shift/
  );

  await assert.rejects(
    () => upsertTraineeApplicationInPostgres({
      pool: fakePool({
        currentVersion: 10,
        existingShifts: [{ id: 'shift-uuid-88', legacy_id: 88, date: '2026-08-01', seats: 2, open: false, canceled: false }]
      }),
      actor: trainee,
      command: { action: 'upsert_trainee_application', baseVersion: 10, application: traineeApplication() }
    }),
    /closed shift/
  );

  await assert.rejects(
    () => upsertTraineeApplicationInPostgres({
      pool: fakePool({
        currentVersion: 10,
        existingShifts: [{ id: 'shift-uuid-88', legacy_id: 88, date: '2026-08-01', seats: 2, open: true, canceled: true }]
      }),
      actor: trainee,
      command: { action: 'upsert_trainee_application', baseVersion: 10, application: traineeApplication() }
    }),
    /canceled shift/
  );

  await assert.rejects(
    () => upsertTraineeApplicationInPostgres({
      pool: fakePool({
        currentVersion: 10,
        existingShifts: [{ id: 'shift-uuid-88', legacy_id: 88, date: '2026-08-01', seats: 1, open: true, canceled: false }],
        existingApplications: [{ id: 'other-app', legacy_id: 999, shift_id: 'shift-uuid-88', status: 'pending' }]
      }),
      actor: trainee,
      command: { action: 'upsert_trainee_application', baseVersion: 10, application: traineeApplication() }
    }),
    /нет свободных мест/
  );
});

test('upsertTraineeApplicationInPostgres rejects invalid trainee payloads', async () => {
  await assert.rejects(
    () => upsertTraineeApplicationInPostgres({
      pool: fakePool({ currentVersion: 10 }),
      actor: trainee,
      command: {
        action: 'upsert_trainee_application',
        baseVersion: 10,
        application: traineeApplication({ phone: '' })
      }
    }),
    /application.phone is required/
  );
  await assert.rejects(
    () => upsertTraineeApplicationInPostgres({
      pool: fakePool({ currentVersion: 10 }),
      actor: trainee,
      command: {
        action: 'upsert_trainee_application',
        baseVersion: 10,
        application: traineeApplication({ trainingDate: '' })
      }
    }),
    /дату прохождения обучения/
  );
  await assert.rejects(
    () => upsertTraineeApplicationInPostgres({
      pool: fakePool({ currentVersion: 10 }),
      actor: trainee,
      command: {
        action: 'upsert_trainee_application',
        baseVersion: 10,
        application: traineeApplication({ status: 'confirmed' })
      }
    }),
    /trainee cannot set this application status/
  );
  await assert.rejects(
    () => upsertTraineeApplicationInPostgres({
      pool: fakePool({ currentVersion: 10 }),
      actor: trainee,
      command: {
        action: 'upsert_trainee_application',
        baseVersion: 10,
        application: traineeApplication({ shiftId: 88, status: 'queue' })
      }
    }),
    /queue application must not have shiftId/
  );
});

test('upsertTraineeApplicationInPostgres rejects another trainee app and immutable statuses', async () => {
  await assert.rejects(
    () => upsertTraineeApplicationInPostgres({
      pool: fakePool({
        currentVersion: 10,
        existingApplications: [{
          id: 'app-uuid-501',
          legacy_id: 501,
          shift_id: null,
          status: 'queue',
          trainee_telegram_user_id: '333',
          trainee_telegram_chat_id: '333'
        }]
      }),
      actor: trainee,
      command: {
        action: 'upsert_trainee_application',
        baseVersion: 10,
        application: traineeApplication({ shiftId: null, status: 'queue' })
      }
    }),
    PostgresCommandAuthorizationError
  );

  await assert.rejects(
    () => upsertTraineeApplicationInPostgres({
      pool: fakePool({
        currentVersion: 10,
        existingApplications: [{
          id: 'app-uuid-501',
          legacy_id: 501,
          shift_id: null,
          status: 'failed',
          trainee_telegram_user_id: '222',
          trainee_telegram_chat_id: '222'
        }]
      }),
      actor: trainee,
      command: {
        action: 'upsert_trainee_application',
        baseVersion: 10,
        application: traineeApplication({ shiftId: null, status: 'queue' })
      }
    }),
    /current status/
  );
});

test('upsertTraineeApplicationInPostgres rolls back and releases on event insert failure', async () => {
  const pool = fakePool({
    currentVersion: 10,
    eventInsertThrows: true,
    existingShifts: [{
      id: 'shift-uuid-88',
      legacy_id: 88,
      date: '2026-08-01',
      seats: 2,
      open: true,
      canceled: false
    }]
  });

  await assert.rejects(
    () => upsertTraineeApplicationInPostgres({
      pool,
      actor: trainee,
      command: {
        action: 'upsert_trainee_application',
        baseVersion: 10,
        application: traineeApplication()
      }
    }),
    /event insert failed/
  );
  assert.ok(pool.calls.some(call => /^ROLLBACK$/i.test(call.sql)));
  assert.ok(pool.calls.some(call => call.sql === 'RELEASE'));
});

test('cancelApplicationInPostgres deletes trainee-owned pending application and writes an audit event', async () => {
  const pool = fakePool({
    currentVersion: 10,
    existingShifts: [{
      id: 'shift-uuid-88',
      legacy_id: 88,
      date: '2026-08-01',
      seats: 2,
      open: true,
      canceled: false
    }],
    existingApplications: [{
      id: 'app-uuid-501',
      legacy_id: 501,
      shift_id: 'shift-uuid-88',
      status: 'pending',
      trainee_telegram_user_id: '222',
      trainee_telegram_chat_id: '222',
      telegram_username: 'trainee_user',
      name: 'Иван Иванов'
    }]
  });
  const now = new Date('2026-07-29T12:30:00.000Z');

  const result = await cancelApplicationInPostgres({
    pool,
    actor: trainee,
    command: { action: 'cancel_application', baseVersion: 10, applicationId: 501 },
    now
  });

  assert.equal(result.version, 11);
  assert.equal(result.previousVersion, 10);
  assert.equal(result.applicationLegacyId, 501);
  assert.equal(result.previousStatus, 'pending');
  assert.equal(result.previousShiftId, 88);
  assert.equal(result.updatedAt, now.toISOString());
  assert.equal(pool.getApplications().length, 0);
  const eventInsert = pool.calls.find(call => /INSERT INTO application_events/.test(call.sql));
  assert.equal(eventInsert.params[3], 'application_cancelled');
  assert.equal(eventInsert.params[4], 'trainee');
  assert.match(eventInsert.params[6], /"previousStatus":"pending"/);
  const eventIndex = pool.calls.findIndex(call => /INSERT INTO application_events/.test(call.sql));
  const deleteIndex = pool.calls.findIndex(call => /DELETE FROM applications WHERE id/.test(call.sql));
  assert.ok(eventIndex > -1 && deleteIndex > eventIndex);
});

test('cancelApplicationInPostgres lets recruiter delete an early queue application', async () => {
  const pool = fakePool({
    currentVersion: 10,
    existingApplications: [{
      id: 'app-uuid-502',
      legacy_id: 502,
      shift_id: null,
      status: 'queue',
      trainee_telegram_user_id: '333',
      trainee_telegram_chat_id: '333',
      name: 'Queue Trainee'
    }]
  });

  const result = await cancelApplicationInPostgres({
    pool,
    actor: recruiter,
    command: { action: 'cancel_application', baseVersion: 10, applicationId: 502 },
    now: new Date('2026-07-29T12:35:00.000Z')
  });

  assert.equal(result.previousStatus, 'queue');
  assert.equal(result.previousShiftId, null);
  assert.equal(pool.getApplications().length, 0);
  const eventInsert = pool.calls.find(call => /INSERT INTO application_events/.test(call.sql));
  assert.equal(eventInsert.params[4], 'recruiter');
});

test('cancelApplicationInPostgres rejects stale version, unknown app and non-owners', async () => {
  await assert.rejects(
    () => cancelApplicationInPostgres({
      pool: fakePool({ currentVersion: 11 }),
      actor: trainee,
      command: { action: 'cancel_application', baseVersion: 10, applicationId: 501 }
    }),
    PostgresCommandConflictError
  );

  await assert.rejects(
    () => cancelApplicationInPostgres({
      pool: fakePool({ currentVersion: 10 }),
      actor: trainee,
      command: { action: 'cancel_application', baseVersion: 10, applicationId: 501 }
    }),
    /application not found/
  );

  await assert.rejects(
    () => cancelApplicationInPostgres({
      pool: fakePool({
        currentVersion: 10,
        existingApplications: [{
          id: 'app-uuid-501',
          legacy_id: 501,
          shift_id: null,
          status: 'queue',
          trainee_telegram_user_id: '333',
          trainee_telegram_chat_id: '333'
        }]
      }),
      actor: trainee,
      command: { action: 'cancel_application', baseVersion: 10, applicationId: 501 }
    }),
    PostgresCommandAuthorizationError
  );
});

test('cancelApplicationInPostgres rejects progressed applications and invite/mentor state', async () => {
  await assert.rejects(
    () => cancelApplicationInPostgres({
      pool: fakePool({
        currentVersion: 10,
        existingApplications: [{
          id: 'app-uuid-501',
          legacy_id: 501,
          shift_id: null,
          status: 'confirmed',
          trainee_telegram_user_id: '222',
          trainee_telegram_chat_id: '222'
        }]
      }),
      actor: trainee,
      command: { action: 'cancel_application', baseVersion: 10, applicationId: 501 }
    }),
    /current status/
  );

  await assert.rejects(
    () => cancelApplicationInPostgres({
      pool: fakePool({
        currentVersion: 10,
        existingApplications: [{
          id: 'app-uuid-501',
          legacy_id: 501,
          shift_id: null,
          status: 'pending',
          trainee_telegram_user_id: '222',
          trainee_telegram_chat_id: '222',
          invite_group_id: 'group-uuid-1'
        }]
      }),
      actor: trainee,
      command: { action: 'cancel_application', baseVersion: 10, applicationId: 501 }
    }),
    /invite group/
  );

  await assert.rejects(
    () => cancelApplicationInPostgres({
      pool: fakePool({
        currentVersion: 10,
        existingApplications: [{
          id: 'app-uuid-501',
          legacy_id: 501,
          shift_id: null,
          status: 'queue',
          trainee_telegram_user_id: '222',
          trainee_telegram_chat_id: '222',
          mentor_report_received: true
        }]
      }),
      actor: trainee,
      command: { action: 'cancel_application', baseVersion: 10, applicationId: 501 }
    }),
    /mentor report/
  );
});

test('cancelApplicationInPostgres rejects invalid input and unsupported actors before opening a transaction', async () => {
  const pool = fakePool({ currentVersion: 10 });
  await assert.rejects(
    () => cancelApplicationInPostgres({
      pool,
      actor: { role: 'mentor', telegram: { user: { id: '444' } } },
      command: { action: 'cancel_application', baseVersion: 10, applicationId: 501 }
    }),
    PostgresCommandAuthorizationError
  );
  await assert.rejects(
    () => cancelApplicationInPostgres({
      pool,
      actor: trainee,
      command: { action: 'cancel_application', baseVersion: 10, applicationId: 0 }
    }),
    PostgresCommandValidationError
  );
  assert.equal(pool.calls.length, 0);
});

test('cancelApplicationInPostgres rolls back and releases when event insert fails', async () => {
  const pool = fakePool({
    currentVersion: 10,
    eventInsertThrows: true,
    existingApplications: [{
      id: 'app-uuid-501',
      legacy_id: 501,
      shift_id: null,
      status: 'queue',
      trainee_telegram_user_id: '222',
      trainee_telegram_chat_id: '222'
    }]
  });

  await assert.rejects(
    () => cancelApplicationInPostgres({
      pool,
      actor: trainee,
      command: { action: 'cancel_application', baseVersion: 10, applicationId: 501 }
    }),
    /event insert failed/
  );
  assert.ok(pool.calls.some(call => /^ROLLBACK$/i.test(call.sql)));
  assert.ok(pool.calls.some(call => call.sql === 'RELEASE'));
});

test('createShiftInPostgres commits shift + event + version bump for a fresh future date', async () => {
  const pool = fakePool({ currentVersion: 10 });
  const now = new Date('2026-07-29T12:00:00.000Z');
  const result = await createShiftInPostgres({
    pool,
    actor: recruiter,
    command: { action: 'create_shift', baseVersion: 10, date: '2026-08-01', seats: 5 },
    now
  });

  assert.equal(result.version, 11);
  assert.equal(result.previousVersion, 10);
  assert.equal(result.date, '2026-08-01');
  assert.equal(result.seats, 5);
  assert.equal(result.updatedAt, now.toISOString());
  assert.equal(typeof result.shiftId, 'string');
  assert.ok(result.legacyId > 0);
  assert.equal(pool.getVersion(), 11);
  assert.equal(pool.getShifts().length, 1);

  const sqlOrder = pool.calls.map(call => call.sql.trim().replace(/\s+/g, ' '));
  const beginIndex = sqlOrder.indexOf('BEGIN');
  const commitIndex = sqlOrder.indexOf('COMMIT');
  const releaseIndex = sqlOrder.indexOf('RELEASE');
  assert.ok(beginIndex >= 0 && commitIndex > beginIndex && releaseIndex > commitIndex);

  const between = sqlOrder.slice(beginIndex + 1, commitIndex);
  assert.ok(between.some(sql => /SELECT version.*FROM booking_state_meta.*FOR UPDATE/i.test(sql)));
  assert.ok(between.some(sql => /INSERT INTO shifts/.test(sql)));
  assert.ok(between.some(sql => /INSERT INTO application_events/.test(sql)));
  assert.ok(between.some(sql => /UPDATE booking_state_meta/.test(sql)));

  const eventInsert = pool.calls.find(call => /INSERT INTO application_events/.test(call.sql));
  assert.equal(eventInsert.params[3], 'shift_created');
  assert.equal(eventInsert.params[4], 'recruiter');
  assert.equal(eventInsert.params[5], '111');
  const payload = JSON.parse(eventInsert.params[6]);
  assert.equal(payload.action, 'create_shift');
  assert.equal(payload.baseVersion, 10);
  assert.equal(payload.previousVersion, 10);
  assert.equal(payload.nextVersion, 11);
  assert.equal(payload.date, '2026-08-01');
  assert.equal(payload.seats, 5);
  assert.equal(payload.legacyShiftId, result.legacyId);
});

test('createShiftInPostgres rolls back on stale baseVersion', async () => {
  const pool = fakePool({ currentVersion: 42 });
  await assert.rejects(
    () => createShiftInPostgres({
      pool,
      actor: recruiter,
      command: { action: 'create_shift', baseVersion: 41, date: '2026-08-01', seats: 3 },
      now: new Date('2026-07-29T12:00:00.000Z')
    }),
    err => err instanceof PostgresCommandConflictError
      && err.code === 'POSTGRES_COMMAND_VERSION_CONFLICT'
  );
  const sqls = pool.calls.map(call => call.sql);
  assert.ok(sqls.includes('BEGIN'));
  assert.ok(sqls.includes('ROLLBACK'));
  assert.ok(sqls.includes('RELEASE'));
  assert.equal(sqls.includes('COMMIT'), false);
  assert.equal(pool.getVersion(), 42);
  assert.equal(pool.getShifts().length, 0);
});

test('createShiftInPostgres rejects duplicate date and rolls back', async () => {
  const pool = fakePool({
    currentVersion: 10,
    existingShifts: [{ id: 'old', legacy_id: 111, date: '2026-08-01' }]
  });
  await assert.rejects(
    () => createShiftInPostgres({
      pool,
      actor: recruiter,
      command: { action: 'create_shift', baseVersion: 10, date: '2026-08-01', seats: 5 },
      now: new Date('2026-07-29T12:00:00.000Z')
    }),
    err => err instanceof PostgresCommandValidationError
      && /уже создана/.test(err.message)
  );
  assert.equal(pool.getVersion(), 10);
  assert.equal(pool.getShifts().length, 1);
  const sqls = pool.calls.map(call => call.sql);
  assert.ok(sqls.includes('ROLLBACK'));
  assert.equal(sqls.includes('COMMIT'), false);
});

test('createShiftInPostgres rejects past dates before opening a transaction', async () => {
  const pool = fakePool({ currentVersion: 10 });
  await assert.rejects(
    () => createShiftInPostgres({
      pool,
      actor: recruiter,
      command: { action: 'create_shift', baseVersion: 10, date: '2020-01-01', seats: 5 },
      now: new Date('2026-07-29T12:00:00.000Z')
    }),
    err => err instanceof PostgresCommandValidationError && /в прошлом/.test(err.message)
  );
  assert.equal(pool.calls.length, 0);
});

test('createShiftInPostgres treats today by Europe/Moscow, not UTC', async () => {
  const pool = fakePool({ currentVersion: 10 });
  await assert.rejects(
    () => createShiftInPostgres({
      pool,
      actor: recruiter,
      command: { action: 'create_shift', baseVersion: 10, date: '2026-07-29', seats: 5 },
      now: new Date('2026-07-29T21:30:00.000Z')
    }),
    err => err instanceof PostgresCommandValidationError && /в прошлом/.test(err.message)
  );
  assert.equal(pool.calls.length, 0);

  const acceptingPool = fakePool({ currentVersion: 10 });
  const result = await createShiftInPostgres({
    pool: acceptingPool,
    actor: recruiter,
    command: { action: 'create_shift', baseVersion: 10, date: '2026-07-30', seats: 5 },
    now: new Date('2026-07-29T21:30:00.000Z')
  });
  assert.equal(result.date, '2026-07-30');
  assert.equal(result.version, 11);
});

test('createShiftInPostgres rejects invalid seats and malformed dates before opening a transaction', async () => {
  const pool = fakePool({ currentVersion: 10 });
  await assert.rejects(
    () => createShiftInPostgres({
      pool,
      actor: recruiter,
      command: { action: 'create_shift', baseVersion: 10, date: '2026-08-01', seats: 0 },
      now: new Date('2026-07-29T12:00:00.000Z')
    }),
    /seats must be an integer between 1 and 30/
  );
  await assert.rejects(
    () => createShiftInPostgres({
      pool,
      actor: recruiter,
      command: { action: 'create_shift', baseVersion: 10, date: '2026-08-01', seats: 31 },
      now: new Date('2026-07-29T12:00:00.000Z')
    }),
    /seats must be an integer between 1 and 30/
  );
  await assert.rejects(
    () => createShiftInPostgres({
      pool,
      actor: recruiter,
      command: { action: 'create_shift', baseVersion: 10, date: '01-08-2026', seats: 5 },
      now: new Date('2026-07-29T12:00:00.000Z')
    }),
    /date must be YYYY-MM-DD/
  );
  await assert.rejects(
    () => createShiftInPostgres({
      pool,
      actor: recruiter,
      command: { action: 'create_shift', baseVersion: 0, date: '2026-08-01', seats: 5 },
      now: new Date('2026-07-29T12:00:00.000Z')
    }),
    /baseVersion is required/
  );
  assert.equal(pool.calls.length, 0);
});

test('createShiftInPostgres rejects non-recruiter actors before opening a transaction', async () => {
  const pool = fakePool({ currentVersion: 10 });
  await assert.rejects(
    () => createShiftInPostgres({
      pool,
      actor: { role: 'trainee', telegram: { user: { id: '222' } } },
      command: { action: 'create_shift', baseVersion: 10, date: '2026-08-01', seats: 5 },
      now: new Date('2026-07-29T12:00:00.000Z')
    }),
    err => err instanceof PostgresCommandAuthorizationError
      && err.code === 'POSTGRES_COMMAND_FORBIDDEN'
  );
  assert.equal(pool.calls.length, 0);
});

test('createShiftInPostgres releases the client even if ROLLBACK also fails', async () => {
  const pool = fakePool({ currentVersion: 42, rollbackThrows: true });
  await assert.rejects(
    () => createShiftInPostgres({
      pool,
      actor: recruiter,
      command: { action: 'create_shift', baseVersion: 41, date: '2026-08-01', seats: 5 },
      now: new Date('2026-07-29T12:00:00.000Z')
    }),
    err => err instanceof PostgresCommandConflictError
  );
  assert.ok(pool.calls.some(call => call.sql === 'RELEASE'));
});

test('toggleShiftInPostgres closes and reopens a shift with audit events', async () => {
  const pool = fakePool({
    currentVersion: 10,
    existingShifts: [{
      id: 'shift-uuid-88',
      legacy_id: 88,
      date: '2026-08-01',
      seats: 4,
      open: true,
      canceled: false,
      canceled_at: null
    }]
  });
  const closeNow = new Date('2026-07-29T12:00:00.000Z');

  const closeResult = await toggleShiftInPostgres({
    pool,
    actor: recruiter,
    command: { action: 'toggle_shift', baseVersion: 10, shiftId: 88, open: false },
    now: closeNow
  });

  assert.equal(closeResult.changed, true);
  assert.equal(closeResult.previousOpen, true);
  assert.equal(closeResult.open, false);
  assert.equal(closeResult.version, 11);
  assert.equal(pool.getShifts()[0].open, false);
  assert.equal(pool.getShifts()[0].canceled, false);

  const openNow = new Date('2026-07-29T12:05:00.000Z');
  const openResult = await toggleShiftInPostgres({
    pool,
    actor: recruiter,
    command: { action: 'toggle_shift', baseVersion: 11, shiftId: 88 },
    now: openNow
  });

  assert.equal(openResult.changed, true);
  assert.equal(openResult.previousOpen, false);
  assert.equal(openResult.open, true);
  assert.equal(openResult.canceled, false);
  assert.equal(openResult.version, 12);
  assert.equal(pool.getShifts()[0].open, true);
  assert.equal(pool.getShifts()[0].canceled, false);
  const eventTypes = pool.calls
    .filter(call => /INSERT INTO application_events/.test(call.sql))
    .map(call => call.params[3]);
  assert.deepEqual(eventTypes, ['shift_closed', 'shift_opened']);
});

test('toggleShiftInPostgres is a no-op when requested open state is unchanged', async () => {
  const pool = fakePool({
    currentVersion: 10,
    existingShifts: [{
      id: 'shift-uuid-88',
      legacy_id: 88,
      date: '2026-08-01',
      seats: 4,
      open: true,
      canceled: false
    }]
  });

  const result = await toggleShiftInPostgres({
    pool,
    actor: recruiter,
    command: { action: 'toggle_shift', baseVersion: 10, shiftId: 88, open: true },
    now: new Date('2026-07-29T12:00:00.000Z')
  });

  assert.equal(result.changed, false);
  assert.equal(result.version, 10);
  assert.equal(pool.getVersion(), 10);
  assert.equal(pool.calls.some(call => /UPDATE shifts\s+SET open/.test(call.sql)), false);
  assert.equal(pool.calls.some(call => /INSERT INTO application_events/.test(call.sql)), false);
});

test('toggleShiftInPostgres rolls back on stale version and unknown shift', async () => {
  const stalePool = fakePool({
    currentVersion: 11,
    existingShifts: [{
      id: 'shift-uuid-88',
      legacy_id: 88,
      date: '2026-08-01',
      seats: 4,
      open: true
    }]
  });
  await assert.rejects(
    () => toggleShiftInPostgres({
      pool: stalePool,
      actor: recruiter,
      command: { action: 'toggle_shift', baseVersion: 10, shiftId: 88, open: false }
    }),
    PostgresCommandConflictError
  );
  assert.equal(stalePool.getShifts()[0].open, true);

  const unknownPool = fakePool({ currentVersion: 10 });
  await assert.rejects(
    () => toggleShiftInPostgres({
      pool: unknownPool,
      actor: recruiter,
      command: { action: 'toggle_shift', baseVersion: 10, shiftId: 999, open: false }
    }),
    /shift not found/
  );
  assert.ok(unknownPool.calls.some(call => /^ROLLBACK$/i.test(call.sql)));
});

test('toggleShiftInPostgres rejects invalid input and non-recruiters before opening a transaction', async () => {
  await assert.rejects(
    () => toggleShiftInPostgres({
      pool: fakePool(),
      actor: trainee,
      command: { action: 'toggle_shift', baseVersion: 10, shiftId: 88, open: false }
    }),
    PostgresCommandAuthorizationError
  );

  const invalidPool = fakePool();
  await assert.rejects(
    () => toggleShiftInPostgres({
      pool: invalidPool,
      actor: recruiter,
      command: { action: 'toggle_shift', baseVersion: 10, shiftId: 'bad', open: false }
    }),
    PostgresCommandValidationError
  );
  assert.equal(invalidPool.calls.length, 0);
});

test('toggleShiftInPostgres rolls back and releases when event insert fails', async () => {
  const pool = fakePool({
    currentVersion: 10,
    eventInsertThrows: true,
    existingShifts: [{
      id: 'shift-uuid-88',
      legacy_id: 88,
      date: '2026-08-01',
      seats: 4,
      open: true,
      canceled: false
    }]
  });

  await assert.rejects(
    () => toggleShiftInPostgres({
      pool,
      actor: recruiter,
      command: { action: 'toggle_shift', baseVersion: 10, shiftId: 88, open: false }
    }),
    /event insert failed/
  );
  assert.ok(pool.calls.some(call => /^ROLLBACK$/i.test(call.sql)));
  assert.ok(pool.calls.some(call => call.sql === 'RELEASE'));
});

const shiftFixture = { id: 'shift-uuid-1', legacy_id: 555, date: '2026-08-01', seats: 4 };

test('updateShiftCapacityInPostgres commits UPDATE shifts + event + version bump when seats change', async () => {
  const pool = fakePool({
    currentVersion: 10,
    existingShifts: [{ ...shiftFixture }],
    existingApplications: [
      {
        id: 'capacity-app-1',
        legacy_id: 811,
        shift_id: 'shift-uuid-1',
        status: 'pending',
        trainee_telegram_user_id: '991111',
        trainee_telegram_chat_id: '991111',
        name: 'Capacity Pending'
      },
      {
        id: 'capacity-app-2',
        legacy_id: 812,
        shift_id: 'shift-uuid-1',
        status: 'feedback',
        trainee_telegram_user_id: '992222',
        trainee_telegram_chat_id: '992222',
        name: 'Capacity Feedback'
      },
      {
        id: 'capacity-app-3',
        legacy_id: 813,
        shift_id: 'shift-uuid-1',
        status: 'confirmed',
        trainee_telegram_user_id: null,
        trainee_telegram_chat_id: '',
        name: 'Capacity Missing Chat'
      }
    ]
  });
  const now = new Date('2026-07-29T12:00:00.000Z');
  const result = await updateShiftCapacityInPostgres({
    pool,
    actor: recruiter,
    command: { action: 'update_shift_capacity', baseVersion: 10, shiftId: 555, seats: 6 },
    now
  });

  assert.equal(result.changed, true);
  assert.equal(result.legacyId, 555);
  assert.equal(result.shiftId, 'shift-uuid-1');
  assert.equal(result.seats, 6);
  assert.equal(result.previousSeats, 4);
  assert.equal(result.version, 11);
  assert.equal(result.previousVersion, 10);
  assert.equal(result.updatedAt, now.toISOString());
  assert.equal(pool.getVersion(), 11);
  assert.equal(pool.getShifts()[0].seats, 6);

  const sqlOrder = pool.calls.map(call => call.sql.trim().replace(/\s+/g, ' '));
  assert.ok(sqlOrder.includes('BEGIN'));
  assert.ok(sqlOrder.includes('COMMIT'));
  const between = sqlOrder.slice(sqlOrder.indexOf('BEGIN') + 1, sqlOrder.indexOf('COMMIT'));
  assert.ok(between.some(sql => /SELECT version.*FROM booking_state_meta.*FOR UPDATE/i.test(sql)));
  assert.ok(between.some(sql => /SELECT id, legacy_id, seats, date::text AS date/i.test(sql)
    && /FOR UPDATE/i.test(sql)));
  assert.ok(between.some(sql => /COUNT\(\*\)::int AS used/i.test(sql) && /FROM applications/i.test(sql)));
  assert.ok(between.some(sql => /UPDATE shifts/i.test(sql) && /row_version = row_version \+ 1/i.test(sql)));
  assert.ok(between.some(sql => /INSERT INTO application_events/.test(sql)));
  assert.ok(between.some(sql => /UPDATE booking_state_meta/.test(sql)));

  const eventInsert = pool.calls.find(call => /INSERT INTO application_events/.test(call.sql));
  assert.equal(eventInsert.params[3], 'shift_capacity_changed');
  assert.equal(eventInsert.params[4], 'recruiter');
  assert.equal(eventInsert.params[5], '111');
  const payload = JSON.parse(eventInsert.params[6]);
  assert.equal(payload.action, 'update_shift_capacity');
  assert.equal(payload.baseVersion, 10);
  assert.equal(payload.previousVersion, 10);
  assert.equal(payload.nextVersion, 11);
  assert.equal(payload.previousSeats, 4);
  assert.equal(payload.nextSeats, 6);
  assert.equal(payload.date, '2026-08-01');
  assert.equal(payload.legacyShiftId, 555);

  const notifications = pool.getNotifications();
  assert.equal(notifications.length, 2);
  assert.deepEqual(notifications.map(row => row.type), [
    'shift_capacity_changed',
    'shift_capacity_changed'
  ]);
  assert.deepEqual(notifications.map(row => row.status), ['pending', 'skipped']);
  assert.deepEqual(notifications.map(row => row.chat_id), ['991111', null]);
  assert.ok(notifications.every(row => row.chat_target === 'trainee'));
  assert.ok(notifications.every(row => row.parse_mode === 'HTML'));
  assert.ok(notifications.every(row => row.text.includes('Изменения по стажировке')));
  assert.ok(notifications.every(row => row.text.includes('01.08.2026')));
  assert.match(notifications[0].idempotency_key, /^update_shift_capacity:811:/);
  assert.match(notifications[1].idempotency_key, /^update_shift_capacity:813:/);
  assert.deepEqual(result.notifications, {
    total: 2,
    pending: 1,
    skipped: 1,
    inserted: 2
  });
});

test('updateShiftCapacityInPostgres is a no-op when requested seats equal current seats', async () => {
  const pool = fakePool({
    currentVersion: 10,
    metaUpdatedAt: '2026-06-01T00:00:00.000Z',
    existingShifts: [{ ...shiftFixture }]
  });
  const result = await updateShiftCapacityInPostgres({
    pool,
    actor: recruiter,
    command: { action: 'update_shift_capacity', baseVersion: 10, shiftId: 555, seats: 4 },
    now: new Date('2026-07-29T12:00:00.000Z')
  });

  assert.equal(result.changed, false);
  assert.equal(result.seats, 4);
  assert.equal(result.previousSeats, 4);
  assert.equal(result.version, 10);
  assert.equal(result.previousVersion, 10);
  assert.equal(result.updatedAt, '2026-06-01T00:00:00.000Z');
  assert.equal(pool.getVersion(), 10);
  assert.equal(pool.getUpdatedAt(), '2026-06-01T00:00:00.000Z');
  assert.equal(pool.getShifts()[0].seats, 4);

  const sqls = pool.calls.map(call => call.sql.trim());
  assert.ok(sqls.some(sql => /^BEGIN$/i.test(sql)));
  assert.ok(sqls.some(sql => /^COMMIT$/i.test(sql)));
  assert.equal(sqls.some(sql => /UPDATE shifts/i.test(sql)), false);
  assert.equal(sqls.some(sql => /INSERT INTO application_events/i.test(sql)), false);
  assert.equal(sqls.some(sql => /UPDATE booking_state_meta/i.test(sql)), false);
  assert.equal(sqls.some(sql => /COUNT\(\*\)/i.test(sql)), false);
});

test('updateShiftCapacityInPostgres rejects seats lower than current usage and rolls back', async () => {
  const pool = fakePool({
    currentVersion: 10,
    existingShifts: [{ ...shiftFixture, seats: 5 }],
    existingApplications: [
      { id: 'a-1', legacy_id: 701, shift_id: 'shift-uuid-1', status: 'pending' },
      { id: 'a-2', legacy_id: 702, shift_id: 'shift-uuid-1', status: 'confirmed' },
      { id: 'a-3', legacy_id: 703, shift_id: 'shift-uuid-1', status: 'invited' },
      { id: 'a-4', legacy_id: 704, shift_id: 'shift-uuid-1', status: 'queue' }
    ]
  });
  await assert.rejects(
    () => updateShiftCapacityInPostgres({
      pool,
      actor: recruiter,
      command: { action: 'update_shift_capacity', baseVersion: 10, shiftId: 555, seats: 2 },
      now: new Date('2026-07-29T12:00:00.000Z')
    }),
    err => err instanceof PostgresCommandValidationError
      && /уже записано 3 стажёров/.test(err.message)
  );
  assert.equal(pool.getVersion(), 10);
  assert.equal(pool.getShifts()[0].seats, 5);
  const sqls = pool.calls.map(call => call.sql.trim());
  assert.ok(sqls.some(sql => /^ROLLBACK$/i.test(sql)));
  assert.equal(sqls.some(sql => /^COMMIT$/i.test(sql)), false);
  assert.equal(sqls.some(sql => /UPDATE shifts/i.test(sql)), false);
});

test('updateShiftCapacityInPostgres accepts seats equal to current usage', async () => {
  const pool = fakePool({
    currentVersion: 10,
    existingShifts: [{ ...shiftFixture, seats: 5 }],
    existingApplications: [
      { id: 'a-1', legacy_id: 701, shift_id: 'shift-uuid-1', status: 'pending' },
      { id: 'a-2', legacy_id: 702, shift_id: 'shift-uuid-1', status: 'confirmed' },
      { id: 'a-3', legacy_id: 703, shift_id: 'shift-uuid-1', status: 'invited' }
    ]
  });
  const result = await updateShiftCapacityInPostgres({
    pool,
    actor: recruiter,
    command: { action: 'update_shift_capacity', baseVersion: 10, shiftId: 555, seats: 3 },
    now: new Date('2026-07-29T12:00:00.000Z')
  });
  assert.equal(result.changed, true);
  assert.equal(result.seats, 3);
  assert.equal(result.previousSeats, 5);
  assert.equal(result.version, 11);
});

test('updateShiftCapacityInPostgres rejects unknown shift and rolls back', async () => {
  const pool = fakePool({ currentVersion: 10, existingShifts: [] });
  await assert.rejects(
    () => updateShiftCapacityInPostgres({
      pool,
      actor: recruiter,
      command: { action: 'update_shift_capacity', baseVersion: 10, shiftId: 999, seats: 5 },
      now: new Date('2026-07-29T12:00:00.000Z')
    }),
    err => err instanceof PostgresCommandValidationError && /shift not found/.test(err.message)
  );
  const sqls = pool.calls.map(call => call.sql.trim());
  assert.ok(sqls.some(sql => /^ROLLBACK$/i.test(sql)));
  assert.equal(sqls.some(sql => /^COMMIT$/i.test(sql)), false);
});

test('updateShiftCapacityInPostgres rolls back on stale baseVersion without touching the shift', async () => {
  const pool = fakePool({
    currentVersion: 42,
    existingShifts: [{ ...shiftFixture }]
  });
  await assert.rejects(
    () => updateShiftCapacityInPostgres({
      pool,
      actor: recruiter,
      command: { action: 'update_shift_capacity', baseVersion: 41, shiftId: 555, seats: 8 },
      now: new Date('2026-07-29T12:00:00.000Z')
    }),
    err => err instanceof PostgresCommandConflictError
      && err.code === 'POSTGRES_COMMAND_VERSION_CONFLICT'
  );
  assert.equal(pool.getVersion(), 42);
  assert.equal(pool.getShifts()[0].seats, 4);
  const sqls = pool.calls.map(call => call.sql.trim());
  assert.ok(sqls.some(sql => /^ROLLBACK$/i.test(sql)));
  assert.equal(sqls.some(sql => /^COMMIT$/i.test(sql)), false);
});

test('updateShiftCapacityInPostgres rejects invalid inputs before opening a transaction', async () => {
  const pool = fakePool({ currentVersion: 10, existingShifts: [{ ...shiftFixture }] });
  await assert.rejects(
    () => updateShiftCapacityInPostgres({
      pool,
      actor: recruiter,
      command: { action: 'update_shift_capacity', baseVersion: 10, shiftId: 555, seats: 0 },
      now: new Date('2026-07-29T12:00:00.000Z')
    }),
    /seats must be an integer between 1 and 30/
  );
  await assert.rejects(
    () => updateShiftCapacityInPostgres({
      pool,
      actor: recruiter,
      command: { action: 'update_shift_capacity', baseVersion: 10, shiftId: 555, seats: 31 },
      now: new Date('2026-07-29T12:00:00.000Z')
    }),
    /seats must be an integer between 1 and 30/
  );
  await assert.rejects(
    () => updateShiftCapacityInPostgres({
      pool,
      actor: recruiter,
      command: { action: 'update_shift_capacity', baseVersion: 10, shiftId: 0, seats: 4 },
      now: new Date('2026-07-29T12:00:00.000Z')
    }),
    /shiftId must be a positive integer/
  );
  await assert.rejects(
    () => updateShiftCapacityInPostgres({
      pool,
      actor: recruiter,
      command: { action: 'update_shift_capacity', baseVersion: 0, shiftId: 555, seats: 4 },
      now: new Date('2026-07-29T12:00:00.000Z')
    }),
    /baseVersion is required/
  );
  assert.equal(pool.calls.length, 0);
});

test('updateShiftCapacityInPostgres rejects non-recruiter actors before opening a transaction', async () => {
  const pool = fakePool({ currentVersion: 10, existingShifts: [{ ...shiftFixture }] });
  await assert.rejects(
    () => updateShiftCapacityInPostgres({
      pool,
      actor: { role: 'trainee', telegram: { user: { id: '222' } } },
      command: { action: 'update_shift_capacity', baseVersion: 10, shiftId: 555, seats: 6 },
      now: new Date('2026-07-29T12:00:00.000Z')
    }),
    err => err instanceof PostgresCommandAuthorizationError
      && err.code === 'POSTGRES_COMMAND_FORBIDDEN'
  );
  assert.equal(pool.calls.length, 0);
});

test('updateShiftCapacityInPostgres rolls back and releases when notification insert fails', async () => {
  const pool = fakePool({
    currentVersion: 10,
    existingShifts: [{ ...shiftFixture }],
    existingApplications: [{
      id: 'capacity-app-rollback',
      legacy_id: 814,
      shift_id: 'shift-uuid-1',
      status: 'pending',
      trainee_telegram_user_id: '991114',
      trainee_telegram_chat_id: '991114'
    }],
    notificationInsertThrows: true
  });

  await assert.rejects(
    () => updateShiftCapacityInPostgres({
      pool,
      actor: recruiter,
      command: { action: 'update_shift_capacity', baseVersion: 10, shiftId: 555, seats: 6 },
      now: new Date('2026-07-29T12:00:00.000Z')
    }),
    /notification insert failed/
  );

  assert.ok(pool.calls.some(call => call.sql === 'ROLLBACK'));
  assert.ok(pool.calls.some(call => call.sql === 'RELEASE'));
  assert.equal(pool.calls.some(call => call.sql === 'COMMIT'), false);
  assert.equal(pool.getVersion(), 10);
});

// -----------------------------------------------------------------------------
// update_comment
// -----------------------------------------------------------------------------

const commentShift = {
  id: 'shift-uuid-comment',
  legacy_id: 8801,
  date: '2026-08-02',
  seats: 4,
  open: true,
  canceled: false
};

const commentApp = {
  id: 'app-uuid-comment',
  legacy_id: 8802,
  shift_id: 'shift-uuid-comment',
  status: 'confirmed',
  recruiter_comment: 'old note'
};

test('updateCommentInPostgres updates recruiter comment, writes event and bumps version', async () => {
  const pool = fakePool({
    currentVersion: 15,
    existingShifts: [{ ...commentShift }],
    existingApplications: [{ ...commentApp }]
  });
  const now = new Date('2026-07-29T12:30:00.000Z');
  const result = await updateCommentInPostgres({
    pool,
    actor: recruiter,
    command: {
      action: 'update_comment',
      baseVersion: 15,
      applicationId: 8802,
      comment: '  Новый внутренний комментарий  '
    },
    now
  });

  assert.equal(result.changed, true);
  assert.equal(result.applicationLegacyId, 8802);
  assert.equal(result.shiftLegacyId, 8801);
  assert.equal(result.previousComment, 'old note');
  assert.equal(result.nextComment, 'Новый внутренний комментарий');
  assert.equal(result.version, 16);
  assert.equal(result.previousVersion, 15);
  assert.equal(result.updatedAt, now.toISOString());
  assert.equal(pool.getVersion(), 16);
  assert.equal(pool.getApplications()[0].recruiter_comment, 'Новый внутренний комментарий');

  const eventInsert = pool.calls.find(call => /INSERT INTO application_events/.test(call.sql));
  assert.equal(eventInsert.params[3], 'application_comment_updated');
  assert.equal(eventInsert.params[4], 'recruiter');
  assert.equal(eventInsert.params[5], '111');
  const payload = JSON.parse(eventInsert.params[6]);
  assert.equal(payload.action, 'update_comment');
  assert.equal(payload.previousLength, 'old note'.length);
  assert.equal(payload.nextLength, 'Новый внутренний комментарий'.length);
  assert.equal(payload.legacyApplicationId, 8802);
  assert.equal(payload.legacyShiftId, 8801);
});

test('updateCommentInPostgres is a no-op when the comment is unchanged', async () => {
  const pool = fakePool({
    currentVersion: 15,
    metaUpdatedAt: '2026-07-20T00:00:00.000Z',
    existingShifts: [{ ...commentShift }],
    existingApplications: [{ ...commentApp }]
  });
  const result = await updateCommentInPostgres({
    pool,
    actor: recruiter,
    command: { action: 'update_comment', baseVersion: 15, applicationId: 8802, comment: 'old note' },
    now: new Date('2026-07-29T12:30:00.000Z')
  });

  assert.equal(result.changed, false);
  assert.equal(result.version, 15);
  assert.equal(result.updatedAt, '2026-07-20T00:00:00.000Z');
  assert.equal(pool.getVersion(), 15);
  const sqls = pool.calls.map(call => call.sql.trim());
  assert.ok(sqls.some(sql => /^COMMIT$/i.test(sql)));
  assert.equal(sqls.some(sql => /UPDATE applications/i.test(sql)), false);
  assert.equal(sqls.some(sql => /INSERT INTO application_events/i.test(sql)), false);
});

test('updateCommentInPostgres rolls back on stale baseVersion and unknown application', async () => {
  const stalePool = fakePool({
    currentVersion: 16,
    existingApplications: [{ ...commentApp }]
  });
  await assert.rejects(
    () => updateCommentInPostgres({
      pool: stalePool,
      actor: recruiter,
      command: { action: 'update_comment', baseVersion: 15, applicationId: 8802, comment: 'new' },
      now: new Date('2026-07-29T12:30:00.000Z')
    }),
    err => err instanceof PostgresCommandConflictError
  );
  assert.equal(stalePool.getApplications()[0].recruiter_comment, 'old note');
  assert.ok(stalePool.calls.some(call => call.sql === 'ROLLBACK'));

  const missingPool = fakePool({ currentVersion: 15 });
  await assert.rejects(
    () => updateCommentInPostgres({
      pool: missingPool,
      actor: recruiter,
      command: { action: 'update_comment', baseVersion: 15, applicationId: 999999, comment: 'new' },
      now: new Date('2026-07-29T12:30:00.000Z')
    }),
    err => err instanceof PostgresCommandValidationError
      && /application not found/.test(err.message)
  );
});

test('updateCommentInPostgres rejects invalid input and non-recruiters before opening a transaction', async () => {
  const pool = fakePool({ currentVersion: 15 });
  await assert.rejects(
    () => updateCommentInPostgres({
      pool,
      actor: recruiter,
      command: { action: 'update_comment', baseVersion: 15, applicationId: 0, comment: 'new' },
      now: new Date('2026-07-29T12:30:00.000Z')
    }),
    /applicationId must be a positive integer/
  );
  await assert.rejects(
    () => updateCommentInPostgres({
      pool,
      actor: recruiter,
      command: { action: 'update_comment', baseVersion: 0, applicationId: 8802, comment: 'new' },
      now: new Date('2026-07-29T12:30:00.000Z')
    }),
    /baseVersion is required/
  );
  await assert.rejects(
    () => updateCommentInPostgres({
      pool,
      actor: recruiter,
      command: { action: 'update_comment', baseVersion: 15, applicationId: 8802, comment: 'x'.repeat(1201) },
      now: new Date('2026-07-29T12:30:00.000Z')
    }),
    /application.comment must be at most 1200 characters/
  );
  await assert.rejects(
    () => updateCommentInPostgres({
      pool,
      actor: { role: 'trainee', telegram: { user: { id: '222' } } },
      command: { action: 'update_comment', baseVersion: 15, applicationId: 8802, comment: 'new' },
      now: new Date('2026-07-29T12:30:00.000Z')
    }),
    err => err instanceof PostgresCommandAuthorizationError
  );
  assert.equal(pool.calls.length, 0);
});

test('updateCommentInPostgres rolls back and releases when event insert fails', async () => {
  const pool = fakePool({
    currentVersion: 15,
    existingShifts: [{ ...commentShift }],
    existingApplications: [{ ...commentApp }],
    eventInsertThrows: true
  });
  await assert.rejects(
    () => updateCommentInPostgres({
      pool,
      actor: recruiter,
      command: { action: 'update_comment', baseVersion: 15, applicationId: 8802, comment: 'new' },
      now: new Date('2026-07-29T12:30:00.000Z')
    }),
    /event insert failed/
  );
  const sqls = pool.calls.map(call => call.sql.trim());
  assert.ok(sqls.some(sql => /^ROLLBACK$/i.test(sql)));
  assert.ok(sqls.findIndex(sql => /^RELEASE$/i.test(sql)) > sqls.findIndex(sql => /^ROLLBACK$/i.test(sql)));
  assert.equal(sqls.some(sql => /^COMMIT$/i.test(sql)), false);
});

// -----------------------------------------------------------------------------
// set_application_status
// -----------------------------------------------------------------------------

const openShift = {
  id: 'shift-uuid-99',
  legacy_id: 999,
  date: '2026-08-05',
  seats: 4,
  open: true,
  canceled: false
};

const pendingApp = {
  id: 'app-uuid-1',
  legacy_id: 1001,
  shift_id: 'shift-uuid-99',
  status: 'pending',
  invite_group_id: null,
  group_link: '',
  experience: null,
  mentor_report_received: false
};

const invitedApp = {
  id: 'app-uuid-2',
  legacy_id: 1002,
  shift_id: 'shift-uuid-99',
  status: 'invited',
  invite_group_id: 'group-uuid-1',
  group_link: 'https://t.me/+xyz',
  experience: null,
  mentor_report_received: false
};

test('setApplicationStatusInPostgres pending → confirmed emits recruiter_confirmed and bumps version', async () => {
  const pool = fakePool({
    currentVersion: 20,
    existingShifts: [{ ...openShift }],
    existingApplications: [{ ...pendingApp }]
  });
  const now = new Date('2026-07-29T13:00:00.000Z');
  const result = await setApplicationStatusInPostgres({
    pool,
    actor: recruiter,
    command: { action: 'set_application_status', baseVersion: 20, applicationId: 1001, status: 'confirmed' },
    now
  });

  assert.equal(result.changed, true);
  assert.equal(result.previousStatus, 'pending');
  assert.equal(result.nextStatus, 'confirmed');
  assert.equal(result.eventType, 'recruiter_confirmed');
  assert.equal(result.shiftLegacyId, 999);
  assert.equal(result.shiftAutoClosed, false);
  assert.equal(result.version, 21);
  assert.equal(result.updatedAt, now.toISOString());
  assert.equal(pool.getVersion(), 21);
  assert.equal(pool.getApplications()[0].status, 'confirmed');
  assert.equal(pool.getShifts()[0].open, true);

  const eventInsert = pool.calls.find(call => /INSERT INTO application_events/.test(call.sql));
  assert.equal(eventInsert.params[3], 'recruiter_confirmed');
  const payload = JSON.parse(eventInsert.params[6]);
  assert.equal(payload.action, 'set_application_status');
  assert.equal(payload.previousStatus, 'pending');
  assert.equal(payload.nextStatus, 'confirmed');
  assert.equal(payload.shiftId, 999);
  assert.equal(payload.legacyApplicationId, 1001);
});

test('setApplicationStatusInPostgres invited → feedback passes invite-group guard', async () => {
  const pool = fakePool({
    currentVersion: 20,
    existingShifts: [{ ...openShift }],
    existingApplications: [{ ...invitedApp }]
  });
  const now = new Date('2026-07-29T13:00:00.000Z');
  const result = await setApplicationStatusInPostgres({
    pool,
    actor: recruiter,
    command: { action: 'set_application_status', baseVersion: 20, applicationId: 1002, status: 'feedback' },
    now
  });

  assert.equal(result.eventType, 'attendance_marked_feedback');
  assert.equal(pool.getApplications()[0].status, 'feedback');
  assert.equal(result.shiftAutoClosed, false);
});

test('setApplicationStatusInPostgres invited → noshow auto-closes shift when it is the last non-final application', async () => {
  const pool = fakePool({
    currentVersion: 20,
    existingShifts: [{ ...openShift }],
    existingApplications: [
      { ...invitedApp },
      {
        id: 'app-uuid-3',
        legacy_id: 1003,
        shift_id: 'shift-uuid-99',
        status: 'passed',
        invite_group_id: 'group-uuid-1',
        group_link: 'https://t.me/+xyz',
        experience: 'experienced',
        mentor_report_received: true
      }
    ]
  });
  const now = new Date('2026-07-29T13:00:00.000Z');
  const result = await setApplicationStatusInPostgres({
    pool,
    actor: recruiter,
    command: { action: 'set_application_status', baseVersion: 20, applicationId: 1002, status: 'noshow' },
    now
  });

  assert.equal(result.eventType, 'attendance_marked_noshow');
  assert.equal(result.shiftAutoClosed, true);
  assert.equal(pool.getShifts()[0].open, false);

  const eventInserts = pool.calls.filter(call => /INSERT INTO application_events/.test(call.sql));
  assert.equal(eventInserts.length, 2);
  assert.deepEqual(eventInserts.map(call => call.params[3]), ['attendance_marked_noshow', 'shift_auto_closed']);
  const closeEventInsert = eventInserts.find(call => call.params[3] === 'shift_auto_closed');
  assert.ok(closeEventInsert, 'shift_auto_closed event must be inserted');
  const closePayload = JSON.parse(closeEventInsert.params[6]);
  assert.equal(closePayload.action, 'set_application_status');
  assert.equal(closePayload.date, '2026-08-05');
});

test('setApplicationStatusInPostgres does not auto-close when a non-final application remains', async () => {
  const pool = fakePool({
    currentVersion: 20,
    existingShifts: [{ ...openShift }],
    existingApplications: [
      { ...invitedApp },
      {
        id: 'app-uuid-3',
        legacy_id: 1003,
        shift_id: 'shift-uuid-99',
        status: 'feedback',
        invite_group_id: 'group-uuid-1',
        group_link: 'https://t.me/+xyz',
        experience: null,
        mentor_report_received: false
      }
    ]
  });
  const result = await setApplicationStatusInPostgres({
    pool,
    actor: recruiter,
    command: { action: 'set_application_status', baseVersion: 20, applicationId: 1002, status: 'noshow' },
    now: new Date('2026-07-29T13:00:00.000Z')
  });

  assert.equal(result.shiftAutoClosed, false);
  assert.equal(pool.getShifts()[0].open, true);
});

test('setApplicationStatusInPostgres rejects invited → feedback when application has no invite group', async () => {
  const pool = fakePool({
    currentVersion: 20,
    existingShifts: [{ ...openShift }],
    existingApplications: [{ ...invitedApp, invite_group_id: null, group_link: '' }]
  });
  await assert.rejects(
    () => setApplicationStatusInPostgres({
      pool,
      actor: recruiter,
      command: { action: 'set_application_status', baseVersion: 20, applicationId: 1002, status: 'feedback' },
      now: new Date('2026-07-29T13:00:00.000Z')
    }),
    err => err instanceof PostgresCommandValidationError && /отправьте кандидату приглашение/.test(err.message)
  );
  const sqls = pool.calls.map(call => call.sql.trim());
  assert.ok(sqls.some(sql => /^ROLLBACK$/i.test(sql)));
  assert.equal(sqls.some(sql => /^COMMIT$/i.test(sql)), false);
  assert.equal(pool.getApplications()[0].status, 'invited');
});

test('setApplicationStatusInPostgres rejects invited → noshow when application has no invite group', async () => {
  const pool = fakePool({
    currentVersion: 20,
    existingShifts: [{ ...openShift }],
    existingApplications: [{ ...invitedApp, invite_group_id: null, group_link: '' }]
  });
  await assert.rejects(
    () => setApplicationStatusInPostgres({
      pool,
      actor: recruiter,
      command: { action: 'set_application_status', baseVersion: 20, applicationId: 1002, status: 'noshow' },
      now: new Date('2026-07-29T13:00:00.000Z')
    }),
    err => err instanceof PostgresCommandValidationError && /отправьте кандидату приглашение/.test(err.message)
  );
});

test('setApplicationStatusInPostgres rejects transitions disallowed by the recruiter state machine', async () => {
  const pool = fakePool({
    currentVersion: 20,
    existingShifts: [{ ...openShift }],
    existingApplications: [{ ...pendingApp }]
  });
  await assert.rejects(
    () => setApplicationStatusInPostgres({
      pool,
      actor: recruiter,
      command: { action: 'set_application_status', baseVersion: 20, applicationId: 1001, status: 'feedback' },
      now: new Date('2026-07-29T13:00:00.000Z')
    }),
    err => err instanceof PostgresCommandValidationError && /недоступен/.test(err.message)
  );
});

test('setApplicationStatusInPostgres refuses back-to-pending transitions until a dedicated command exists', async () => {
  for (const previousStatus of ['confirmed', 'invited', 'feedback']) {
    const pool = fakePool({
      currentVersion: 20,
      existingShifts: [{ ...openShift }],
      existingApplications: [{ ...pendingApp, status: previousStatus, invite_group_id: 'group-uuid-1', group_link: 'https://t.me/+xyz' }]
    });
    await assert.rejects(
      () => setApplicationStatusInPostgres({
        pool,
        actor: recruiter,
        command: { action: 'set_application_status', baseVersion: 20, applicationId: 1001, status: 'pending' },
        now: new Date('2026-07-29T13:00:00.000Z')
      }),
      err => err instanceof PostgresCommandValidationError && /отдельной команды/.test(err.message),
      `expected reject for ${previousStatus} → pending`
    );
  }
});

test('setApplicationStatusInPostgres rejects confirmed target when the application has no shiftId', async () => {
  const pool = fakePool({
    currentVersion: 20,
    existingApplications: [{ ...pendingApp, shift_id: null }]
  });
  await assert.rejects(
    () => setApplicationStatusInPostgres({
      pool,
      actor: recruiter,
      command: { action: 'set_application_status', baseVersion: 20, applicationId: 1001, status: 'confirmed' },
      now: new Date('2026-07-29T13:00:00.000Z')
    }),
    err => err instanceof PostgresCommandValidationError && /must have shiftId/.test(err.message)
  );
});

test('setApplicationStatusInPostgres rolls back on stale baseVersion', async () => {
  const pool = fakePool({
    currentVersion: 20,
    existingShifts: [{ ...openShift }],
    existingApplications: [{ ...pendingApp }]
  });
  await assert.rejects(
    () => setApplicationStatusInPostgres({
      pool,
      actor: recruiter,
      command: { action: 'set_application_status', baseVersion: 19, applicationId: 1001, status: 'confirmed' },
      now: new Date('2026-07-29T13:00:00.000Z')
    }),
    err => err instanceof PostgresCommandConflictError
  );
  const sqls = pool.calls.map(call => call.sql.trim());
  assert.ok(sqls.some(sql => /^ROLLBACK$/i.test(sql)));
  assert.equal(sqls.some(sql => /^COMMIT$/i.test(sql)), false);
  assert.equal(pool.getApplications()[0].status, 'pending');
});

test('setApplicationStatusInPostgres rejects unknown application', async () => {
  const pool = fakePool({ currentVersion: 20, existingApplications: [] });
  await assert.rejects(
    () => setApplicationStatusInPostgres({
      pool,
      actor: recruiter,
      command: { action: 'set_application_status', baseVersion: 20, applicationId: 99999, status: 'confirmed' },
      now: new Date('2026-07-29T13:00:00.000Z')
    }),
    err => err instanceof PostgresCommandValidationError && /application not found/.test(err.message)
  );
});

test('setApplicationStatusInPostgres rejects invalid inputs before opening a transaction', async () => {
  const pool = fakePool({ currentVersion: 20, existingApplications: [{ ...pendingApp }] });
  await assert.rejects(
    () => setApplicationStatusInPostgres({
      pool,
      actor: recruiter,
      command: { action: 'set_application_status', baseVersion: 20, applicationId: 1001, status: 'bogus' },
      now: new Date('2026-07-29T13:00:00.000Z')
    }),
    /application.status is invalid/
  );
  await assert.rejects(
    () => setApplicationStatusInPostgres({
      pool,
      actor: recruiter,
      command: { action: 'set_application_status', baseVersion: 20, applicationId: 0, status: 'confirmed' },
      now: new Date('2026-07-29T13:00:00.000Z')
    }),
    /applicationId must be a positive integer/
  );
  await assert.rejects(
    () => setApplicationStatusInPostgres({
      pool,
      actor: recruiter,
      command: { action: 'set_application_status', baseVersion: 0, applicationId: 1001, status: 'confirmed' },
      now: new Date('2026-07-29T13:00:00.000Z')
    }),
    /baseVersion is required/
  );
  assert.equal(pool.calls.length, 0);
});

test('setApplicationStatusInPostgres rejects non-recruiter actors before opening a transaction', async () => {
  const pool = fakePool({ currentVersion: 20, existingApplications: [{ ...pendingApp }] });
  await assert.rejects(
    () => setApplicationStatusInPostgres({
      pool,
      actor: { role: 'trainee', telegram: { user: { id: '999' } } },
      command: { action: 'set_application_status', baseVersion: 20, applicationId: 1001, status: 'confirmed' },
      now: new Date('2026-07-29T13:00:00.000Z')
    }),
    err => err instanceof PostgresCommandAuthorizationError
  );
  assert.equal(pool.calls.length, 0);
});

// -----------------------------------------------------------------------------
// assign_shift
// -----------------------------------------------------------------------------

const openTargetShift = {
  id: 'shift-uuid-target',
  legacy_id: 4242,
  date: '2026-08-15',
  seats: 3,
  open: true,
  canceled: false
};

const queuedApp = {
  id: 'app-uuid-queue',
  legacy_id: 2001,
  shift_id: null,
  status: 'queue',
  invite_group_id: null,
  group_link: '',
  experience: null,
  mentor_report_received: false
};

test('assignShiftInPostgres moves queue application onto target shift with pending status', async () => {
  const pool = fakePool({
    currentVersion: 30,
    existingShifts: [{ ...openTargetShift }],
    existingApplications: [{ ...queuedApp }]
  });
  const now = new Date('2026-07-29T14:00:00.000Z');
  const result = await assignShiftInPostgres({
    pool,
    actor: recruiter,
    command: { action: 'assign_shift', baseVersion: 30, applicationId: 2001, shiftId: 4242 },
    now
  });

  assert.equal(result.changed, true);
  assert.equal(result.previousStatus, 'queue');
  assert.equal(result.nextStatus, 'pending');
  assert.equal(result.previousShiftId, null);
  assert.equal(result.shiftLegacyId, 4242);
  assert.equal(result.shiftId, 'shift-uuid-target');
  assert.equal(result.shiftDate, '2026-08-15');
  assert.equal(result.shiftSeats, 3);
  assert.equal(result.usedSeatsAfter, 1);
  assert.equal(result.version, 31);
  assert.equal(result.previousVersion, 30);
  assert.equal(result.updatedAt, now.toISOString());

  assert.equal(pool.getVersion(), 31);
  const movedApp = pool.getApplications()[0];
  assert.equal(movedApp.shift_id, 'shift-uuid-target');
  assert.equal(movedApp.status, 'pending');

  const sqlOrder = pool.calls.map(call => call.sql.trim().replace(/\s+/g, ' '));
  const beginIndex = sqlOrder.indexOf('BEGIN');
  const commitIndex = sqlOrder.indexOf('COMMIT');
  const releaseIndex = sqlOrder.indexOf('RELEASE');
  assert.ok(beginIndex >= 0 && commitIndex > beginIndex && releaseIndex > commitIndex);
  const between = sqlOrder.slice(beginIndex + 1, commitIndex);
  assert.ok(between.some(sql => /SELECT version.*FROM booking_state_meta.*FOR UPDATE/i.test(sql)));
  assert.ok(between.some(sql => /SELECT id, legacy_id, status, shift_id FROM applications/i.test(sql)
    && /FOR UPDATE/i.test(sql)));
  assert.ok(between.some(sql => /SELECT id, legacy_id, seats, open, canceled, date::text AS date/i.test(sql)
    && /FOR UPDATE/i.test(sql)));
  assert.ok(between.some(sql => /COUNT\(\*\)::int AS used/i.test(sql)));
  assert.ok(between.some(sql => /UPDATE applications\s+SET shift_id/i.test(sql)));
  assert.ok(between.some(sql => /UPDATE booking_state_meta/.test(sql)));

  const eventInserts = pool.calls.filter(call => /INSERT INTO application_events/.test(call.sql));
  assert.equal(eventInserts.length, 2);
  const eventTypes = eventInserts.map(call => call.params[3]);
  assert.deepEqual(eventTypes, ['application_status_changed', 'application_assigned_to_shift']);

  const statusEvent = eventInserts[0];
  const statusPayload = JSON.parse(statusEvent.params[6]);
  assert.equal(statusPayload.action, 'assign_shift');
  assert.equal(statusPayload.previousStatus, 'queue');
  assert.equal(statusPayload.nextStatus, 'pending');
  assert.equal(statusPayload.previousShiftId, null);
  assert.equal(statusPayload.nextShiftId, 4242);
  assert.equal(statusPayload.previousVersion, 30);
  assert.equal(statusPayload.nextVersion, 31);
  assert.equal(statusPayload.legacyApplicationId, 2001);
  assert.equal(statusPayload.legacyShiftId, 4242);

  const assignEvent = eventInserts[1];
  const assignPayload = JSON.parse(assignEvent.params[6]);
  assert.equal(assignPayload.action, 'assign_shift');
  assert.equal(assignPayload.previousShiftId, null);
  assert.equal(assignPayload.nextShiftId, 4242);
  assert.equal(assignPayload.date, '2026-08-15');
});

test('assignShiftInPostgres rejects non-queue applications and rolls back', async () => {
  for (const previousStatus of ['pending', 'confirmed', 'invited', 'feedback', 'passed']) {
    const pool = fakePool({
      currentVersion: 30,
      existingShifts: [{ ...openTargetShift }],
      existingApplications: [{ ...queuedApp, status: previousStatus, shift_id: 'shift-uuid-other' }]
    });
    await assert.rejects(
      () => assignShiftInPostgres({
        pool,
        actor: recruiter,
        command: { action: 'assign_shift', baseVersion: 30, applicationId: 2001, shiftId: 4242 },
        now: new Date('2026-07-29T14:00:00.000Z')
      }),
      err => err instanceof PostgresCommandValidationError
        && /предварительной записи/.test(err.message),
      `expected reject for status=${previousStatus}`
    );
    const sqls = pool.calls.map(call => call.sql.trim());
    assert.ok(sqls.some(sql => /^ROLLBACK$/i.test(sql)));
    assert.equal(sqls.some(sql => /^COMMIT$/i.test(sql)), false);
    assert.equal(pool.getApplications()[0].shift_id, 'shift-uuid-other');
    assert.equal(pool.getApplications()[0].status, previousStatus);
  }
});

test('assignShiftInPostgres rejects queue application that still has shift_id (defensive)', async () => {
  const pool = fakePool({
    currentVersion: 30,
    existingShifts: [{ ...openTargetShift }],
    existingApplications: [{ ...queuedApp, shift_id: 'shift-uuid-stale' }]
  });
  await assert.rejects(
    () => assignShiftInPostgres({
      pool,
      actor: recruiter,
      command: { action: 'assign_shift', baseVersion: 30, applicationId: 2001, shiftId: 4242 },
      now: new Date('2026-07-29T14:00:00.000Z')
    }),
    err => err instanceof PostgresCommandValidationError && /предварительной записи/.test(err.message)
  );
});

test('assignShiftInPostgres rejects unknown application and rolls back', async () => {
  const pool = fakePool({ currentVersion: 30, existingShifts: [{ ...openTargetShift }] });
  await assert.rejects(
    () => assignShiftInPostgres({
      pool,
      actor: recruiter,
      command: { action: 'assign_shift', baseVersion: 30, applicationId: 999999, shiftId: 4242 },
      now: new Date('2026-07-29T14:00:00.000Z')
    }),
    err => err instanceof PostgresCommandValidationError && /application not found/.test(err.message)
  );
  const sqls = pool.calls.map(call => call.sql.trim());
  assert.ok(sqls.some(sql => /^ROLLBACK$/i.test(sql)));
  assert.equal(sqls.some(sql => /^COMMIT$/i.test(sql)), false);
});

test('assignShiftInPostgres rejects unknown shift and rolls back', async () => {
  const pool = fakePool({
    currentVersion: 30,
    existingShifts: [],
    existingApplications: [{ ...queuedApp }]
  });
  await assert.rejects(
    () => assignShiftInPostgres({
      pool,
      actor: recruiter,
      command: { action: 'assign_shift', baseVersion: 30, applicationId: 2001, shiftId: 4242 },
      now: new Date('2026-07-29T14:00:00.000Z')
    }),
    err => err instanceof PostgresCommandValidationError && /shift not found/.test(err.message)
  );
  const sqls = pool.calls.map(call => call.sql.trim());
  assert.ok(sqls.some(sql => /^ROLLBACK$/i.test(sql)));
  assert.equal(pool.getApplications()[0].status, 'queue');
  assert.equal(pool.getApplications()[0].shift_id, null);
});

test('assignShiftInPostgres rejects closed shift and rolls back', async () => {
  const pool = fakePool({
    currentVersion: 30,
    existingShifts: [{ ...openTargetShift, open: false }],
    existingApplications: [{ ...queuedApp }]
  });
  await assert.rejects(
    () => assignShiftInPostgres({
      pool,
      actor: recruiter,
      command: { action: 'assign_shift', baseVersion: 30, applicationId: 2001, shiftId: 4242 },
      now: new Date('2026-07-29T14:00:00.000Z')
    }),
    err => err instanceof PostgresCommandValidationError && /закрытую дату/.test(err.message)
  );
  const sqls = pool.calls.map(call => call.sql.trim());
  assert.ok(sqls.some(sql => /^ROLLBACK$/i.test(sql)));
  assert.equal(pool.getApplications()[0].status, 'queue');
});

test('assignShiftInPostgres rejects canceled shift and rolls back', async () => {
  const pool = fakePool({
    currentVersion: 30,
    existingShifts: [{ ...openTargetShift, open: false, canceled: true }],
    existingApplications: [{ ...queuedApp }]
  });
  await assert.rejects(
    () => assignShiftInPostgres({
      pool,
      actor: recruiter,
      command: { action: 'assign_shift', baseVersion: 30, applicationId: 2001, shiftId: 4242 },
      now: new Date('2026-07-29T14:00:00.000Z')
    }),
    err => err instanceof PostgresCommandValidationError && /отменённую дату/.test(err.message)
  );
});

test('assignShiftInPostgres rejects when target shift has no free seats', async () => {
  const pool = fakePool({
    currentVersion: 30,
    existingShifts: [{ ...openTargetShift, seats: 2 }],
    existingApplications: [
      { ...queuedApp },
      {
        id: 'app-uuid-a',
        legacy_id: 2100,
        shift_id: 'shift-uuid-target',
        status: 'pending',
        invite_group_id: null,
        group_link: '',
        experience: null,
        mentor_report_received: false
      },
      {
        id: 'app-uuid-b',
        legacy_id: 2101,
        shift_id: 'shift-uuid-target',
        status: 'confirmed',
        invite_group_id: null,
        group_link: '',
        experience: null,
        mentor_report_received: false
      }
    ]
  });
  await assert.rejects(
    () => assignShiftInPostgres({
      pool,
      actor: recruiter,
      command: { action: 'assign_shift', baseVersion: 30, applicationId: 2001, shiftId: 4242 },
      now: new Date('2026-07-29T14:00:00.000Z')
    }),
    err => err instanceof PostgresCommandValidationError && /нет свободных мест/.test(err.message)
  );
  const sqls = pool.calls.map(call => call.sql.trim());
  assert.ok(sqls.some(sql => /^ROLLBACK$/i.test(sql)));
  assert.equal(sqls.some(sql => /^COMMIT$/i.test(sql)), false);
  assert.equal(pool.getApplications()[0].status, 'queue');
  assert.equal(pool.getApplications()[0].shift_id, null);
});

test('assignShiftInPostgres allows filling the last free seat exactly', async () => {
  const pool = fakePool({
    currentVersion: 30,
    existingShifts: [{ ...openTargetShift, seats: 2 }],
    existingApplications: [
      { ...queuedApp },
      {
        id: 'app-uuid-a',
        legacy_id: 2100,
        shift_id: 'shift-uuid-target',
        status: 'pending',
        invite_group_id: null,
        group_link: '',
        experience: null,
        mentor_report_received: false
      }
    ]
  });
  const result = await assignShiftInPostgres({
    pool,
    actor: recruiter,
    command: { action: 'assign_shift', baseVersion: 30, applicationId: 2001, shiftId: 4242 },
    now: new Date('2026-07-29T14:00:00.000Z')
  });
  assert.equal(result.changed, true);
  assert.equal(result.usedSeatsAfter, 2);
  assert.equal(pool.getApplications()[0].status, 'pending');
  assert.equal(pool.getApplications()[0].shift_id, 'shift-uuid-target');
});

test('assignShiftInPostgres rolls back on stale baseVersion without touching state', async () => {
  const pool = fakePool({
    currentVersion: 42,
    existingShifts: [{ ...openTargetShift }],
    existingApplications: [{ ...queuedApp }]
  });
  await assert.rejects(
    () => assignShiftInPostgres({
      pool,
      actor: recruiter,
      command: { action: 'assign_shift', baseVersion: 41, applicationId: 2001, shiftId: 4242 },
      now: new Date('2026-07-29T14:00:00.000Z')
    }),
    err => err instanceof PostgresCommandConflictError
  );
  assert.equal(pool.getVersion(), 42);
  assert.equal(pool.getApplications()[0].status, 'queue');
});

test('assignShiftInPostgres rejects invalid inputs before opening a transaction', async () => {
  const pool = fakePool({
    currentVersion: 30,
    existingShifts: [{ ...openTargetShift }],
    existingApplications: [{ ...queuedApp }]
  });
  await assert.rejects(
    () => assignShiftInPostgres({
      pool,
      actor: recruiter,
      command: { action: 'assign_shift', baseVersion: 30, applicationId: 0, shiftId: 4242 },
      now: new Date('2026-07-29T14:00:00.000Z')
    }),
    /applicationId must be a positive integer/
  );
  await assert.rejects(
    () => assignShiftInPostgres({
      pool,
      actor: recruiter,
      command: { action: 'assign_shift', baseVersion: 30, applicationId: 2001, shiftId: 0 },
      now: new Date('2026-07-29T14:00:00.000Z')
    }),
    /shiftId must be a positive integer/
  );
  await assert.rejects(
    () => assignShiftInPostgres({
      pool,
      actor: recruiter,
      command: { action: 'assign_shift', baseVersion: 0, applicationId: 2001, shiftId: 4242 },
      now: new Date('2026-07-29T14:00:00.000Z')
    }),
    /baseVersion is required/
  );
  assert.equal(pool.calls.length, 0);
});

test('assignShiftInPostgres rejects non-recruiter actors before opening a transaction', async () => {
  const pool = fakePool({
    currentVersion: 30,
    existingShifts: [{ ...openTargetShift }],
    existingApplications: [{ ...queuedApp }]
  });
  await assert.rejects(
    () => assignShiftInPostgres({
      pool,
      actor: { role: 'trainee', telegram: { user: { id: '5' } } },
      command: { action: 'assign_shift', baseVersion: 30, applicationId: 2001, shiftId: 4242 },
      now: new Date('2026-07-29T14:00:00.000Z')
    }),
    err => err instanceof PostgresCommandAuthorizationError
  );
  assert.equal(pool.calls.length, 0);
});

// -----------------------------------------------------------------------------
// send_invites
// -----------------------------------------------------------------------------

const inviteShift = {
  id: 'shift-uuid-invite',
  legacy_id: 3300,
  date: '2026-08-25',
  seats: 4,
  open: true,
  canceled: false
};

function makeConfirmedApp(overrides = {}) {
  return {
    id: 'app-uuid-c1',
    legacy_id: 4001,
    shift_id: 'shift-uuid-invite',
    status: 'confirmed',
    invite_group_id: null,
    group_link: '',
    experience: null,
    venue_id: null,
    mentor_report_received: false,
    trainee_telegram_user_id: '100001',
    trainee_telegram_chat_id: '100001',
    telegram_username: 'trainee',
    name: 'Test Trainee',
    ...overrides
  };
}

const validCommand = {
  action: 'send_invites',
  baseVersion: 40,
  shiftId: 3300,
  venueId: 'loft5_small',
  link: 'https://t.me/+abc123',
  memberIds: [4001, 4002]
};

test('sendInvitesInPostgres commits invite group + members + application updates + events', async () => {
  const pool = fakePool({
    currentVersion: 40,
    existingShifts: [{ ...inviteShift }],
    existingApplications: [
      makeConfirmedApp({ id: 'app-uuid-c1', legacy_id: 4001 }),
      makeConfirmedApp({ id: 'app-uuid-c2', legacy_id: 4002 })
    ]
  });
  const now = new Date('2026-07-29T15:00:00.000Z');
  const result = await sendInvitesInPostgres({
    pool,
    actor: recruiter,
    command: validCommand,
    now
  });

  assert.equal(result.changed, true);
  assert.equal(result.shiftLegacyId, 3300);
  assert.equal(result.venueId, 'loft5_small');
  assert.equal(result.link, 'https://t.me/+abc123');
  assert.deepEqual(result.memberLegacyIds, [4001, 4002]);
  assert.equal(result.previousStatus, 'confirmed');
  assert.equal(result.nextStatus, 'invited');
  assert.equal(result.version, 41);
  assert.equal(result.previousVersion, 40);
  assert.equal(result.updatedAt, now.toISOString());
  assert.equal(typeof result.inviteGroupId, 'string');
  assert.ok(result.inviteGroupLegacyId > 0);

  assert.equal(pool.getInviteGroups().length, 1);
  const createdGroup = pool.getInviteGroups()[0];
  assert.equal(createdGroup.shift_id, 'shift-uuid-invite');
  assert.equal(createdGroup.venue_id, 'loft5_small');
  assert.equal(createdGroup.link, 'https://t.me/+abc123');
  assert.equal(createdGroup.sent_at, now.toISOString());
  assert.equal(createdGroup.created_by_telegram_user_id, '111');

  const members = pool.getInviteGroupMembers();
  assert.equal(members.length, 2);
  assert.deepEqual(
    new Set(members.map(m => m.application_id)),
    new Set(['app-uuid-c1', 'app-uuid-c2'])
  );

  const updatedApps = pool.getApplications();
  for (const app of updatedApps) {
    assert.equal(app.status, 'invited');
    assert.equal(app.invite_group_id, createdGroup.id);
    assert.equal(app.venue_id, 'loft5_small');
    assert.equal(app.group_link, 'https://t.me/+abc123');
  }

  const sqlOrder = pool.calls.map(call => call.sql.trim().replace(/\s+/g, ' '));
  const beginIndex = sqlOrder.indexOf('BEGIN');
  const commitIndex = sqlOrder.indexOf('COMMIT');
  const releaseIndex = sqlOrder.indexOf('RELEASE');
  assert.ok(beginIndex >= 0 && commitIndex > beginIndex && releaseIndex > commitIndex);
  const between = sqlOrder.slice(beginIndex + 1, commitIndex);
  assert.ok(between.some(sql => /SELECT version.*FROM booking_state_meta.*FOR UPDATE/i.test(sql)));
  assert.ok(between.some(sql => /SELECT id, legacy_id, seats, open, canceled, date::text AS date/i.test(sql)
    && /FOR UPDATE/i.test(sql)));
  assert.ok(between.some(sql => /SELECT id, legacy_id, status, shift_id, venue_id, group_link/i.test(sql)
    && /FOR UPDATE/i.test(sql)));
  assert.ok(between.some(sql => /MAX\(legacy_id\).*FROM invite_groups/i.test(sql)));
  assert.ok(between.some(sql => /INSERT INTO invite_groups/i.test(sql)));
  assert.ok(between.some(sql => /INSERT INTO invite_group_members/i.test(sql)));
  assert.ok(between.some(sql => /UPDATE applications\s+SET status = 'invited'/i.test(sql)));
  assert.ok(between.some(sql => /INSERT INTO notifications/i.test(sql)
    && /ON CONFLICT \(idempotency_key\) DO NOTHING/i.test(sql)));
  assert.ok(between.some(sql => /UPDATE booking_state_meta/.test(sql)));

  const eventInserts = pool.calls.filter(call => /INSERT INTO application_events/.test(call.sql));
  assert.equal(eventInserts.length, 3);
  const types = eventInserts.map(call => call.params[3]);
  assert.deepEqual(types, ['invite_group_sent', 'application_invited', 'application_invited']);

  const sentEvent = eventInserts[0];
  const sentPayload = JSON.parse(sentEvent.params[6]);
  assert.equal(sentPayload.action, 'send_invites');
  assert.equal(sentPayload.inviteGroupId, result.inviteGroupLegacyId);
  assert.equal(sentPayload.venueId, 'loft5_small');
  assert.deepEqual(sentPayload.memberIds, [4001, 4002]);
  assert.equal(sentPayload.date, '2026-08-25');
  assert.equal(sentPayload.legacyShiftId, 3300);

  const firstInvited = JSON.parse(eventInserts[1].params[6]);
  assert.equal(firstInvited.previousStatus, 'confirmed');
  assert.equal(firstInvited.nextStatus, 'invited');
  assert.equal(firstInvited.inviteGroupId, result.inviteGroupLegacyId);
  assert.equal(firstInvited.legacyApplicationId, 4001);
  assert.equal(firstInvited.shiftId, 3300);
  const secondInvited = JSON.parse(eventInserts[2].params[6]);
  assert.equal(secondInvited.legacyApplicationId, 4002);

  const notifications = pool.getNotifications();
  assert.equal(notifications.length, 2);
  assert.deepEqual(notifications.map(row => row.type), ['send_invites', 'send_invites']);
  assert.deepEqual(notifications.map(row => row.status), ['pending', 'pending']);
  assert.deepEqual(notifications.map(row => row.chat_target), ['trainee', 'trainee']);
  assert.deepEqual(notifications.map(row => row.parse_mode), ['HTML', 'HTML']);
  assert.deepEqual(notifications.map(row => row.chat_id), ['100001', '100001']);
  assert.ok(notifications.every(row => row.text.includes('https://t.me/+abc123')));
  assert.ok(notifications.every(row => row.text.includes('LOFT #5 SMALL')));
  assert.equal(new Set(notifications.map(row => row.idempotency_key)).size, 2);
  assert.equal(result.notifications.total, 2);
  assert.equal(result.notifications.pending, 2);
  assert.equal(result.notifications.skipped, 0);
  assert.equal(result.notifications.inserted, 2);
});

test('sendInvitesInPostgres deduplicates memberIds and sorts them ASC', async () => {
  const pool = fakePool({
    currentVersion: 40,
    existingShifts: [{ ...inviteShift }],
    existingApplications: [
      makeConfirmedApp({ id: 'app-uuid-c1', legacy_id: 4001 }),
      makeConfirmedApp({ id: 'app-uuid-c2', legacy_id: 4002 })
    ]
  });
  const result = await sendInvitesInPostgres({
    pool,
    actor: recruiter,
    command: { ...validCommand, memberIds: [4002, 4001, 4001, 4002] },
    now: new Date('2026-07-29T15:00:00.000Z')
  });
  assert.deepEqual(result.memberLegacyIds, [4001, 4002]);
  assert.equal(pool.getInviteGroupMembers().length, 2);
});

test('sendInvitesInPostgres records skipped notification when trainee chat id is missing', async () => {
  const pool = fakePool({
    currentVersion: 40,
    existingShifts: [{ ...inviteShift }],
    existingApplications: [
      makeConfirmedApp({
        id: 'app-uuid-no-chat',
        legacy_id: 4001,
        trainee_telegram_chat_id: '',
        trainee_telegram_user_id: ''
      })
    ]
  });
  const result = await sendInvitesInPostgres({
    pool,
    actor: recruiter,
    command: { ...validCommand, memberIds: [4001] },
    now: new Date('2026-07-29T15:00:00.000Z')
  });

  assert.equal(result.changed, true);
  assert.deepEqual(result.notifications, {
    total: 1,
    pending: 0,
    skipped: 1,
    inserted: 1
  });
  const notifications = pool.getNotifications();
  assert.equal(notifications.length, 1);
  assert.equal(notifications[0].status, 'skipped');
  assert.equal(notifications[0].chat_id, null);
  assert.equal(notifications[0].chat_target, 'trainee');
  assert.equal(notifications[0].error, 'telegram_chat_missing');
});

test('sendInvitesInPostgres rolls back when notification outbox insert fails', async () => {
  const pool = fakePool({
    currentVersion: 40,
    existingShifts: [{ ...inviteShift }],
    existingApplications: [makeConfirmedApp()],
    notificationInsertThrows: true
  });
  await assert.rejects(
    () => sendInvitesInPostgres({
      pool,
      actor: recruiter,
      command: { ...validCommand, memberIds: [4001] },
      now: new Date('2026-07-29T15:00:00.000Z')
    }),
    /notification insert failed/
  );
  const sqls = pool.calls.map(call => call.sql.trim());
  assert.ok(sqls.some(sql => /^ROLLBACK$/i.test(sql)));
  assert.ok(sqls.findIndex(sql => /^RELEASE$/i.test(sql)) > sqls.findIndex(sql => /^ROLLBACK$/i.test(sql)));
  assert.equal(sqls.some(sql => /^COMMIT$/i.test(sql)), false);
  assert.equal(pool.getNotifications().length, 0);
});

test('sendInvitesInPostgres rolls back on stale baseVersion', async () => {
  const pool = fakePool({
    currentVersion: 41,
    existingShifts: [{ ...inviteShift }],
    existingApplications: [makeConfirmedApp()]
  });
  await assert.rejects(
    () => sendInvitesInPostgres({
      pool,
      actor: recruiter,
      command: { ...validCommand, memberIds: [4001] },
      now: new Date('2026-07-29T15:00:00.000Z')
    }),
    err => err instanceof PostgresCommandConflictError
  );
  const sqls = pool.calls.map(call => call.sql.trim());
  assert.ok(sqls.some(sql => /^ROLLBACK$/i.test(sql)));
  assert.ok(sqls.findIndex(sql => /^RELEASE$/i.test(sql)) > sqls.findIndex(sql => /^ROLLBACK$/i.test(sql)));
  assert.equal(sqls.some(sql => /^COMMIT$/i.test(sql)), false);
  assert.equal(pool.getInviteGroups().length, 0);
  assert.equal(pool.getApplications()[0].status, 'confirmed');
});

test('sendInvitesInPostgres rejects unknown shift and rolls back', async () => {
  const pool = fakePool({
    currentVersion: 40,
    existingShifts: [],
    existingApplications: [makeConfirmedApp()]
  });
  await assert.rejects(
    () => sendInvitesInPostgres({
      pool,
      actor: recruiter,
      command: { ...validCommand, memberIds: [4001] },
      now: new Date('2026-07-29T15:00:00.000Z')
    }),
    err => err instanceof PostgresCommandValidationError && /shift not found/.test(err.message)
  );
  const sqls = pool.calls.map(call => call.sql.trim());
  assert.ok(sqls.some(sql => /^ROLLBACK$/i.test(sql)));
});

test('sendInvitesInPostgres rejects canceled shift', async () => {
  const pool = fakePool({
    currentVersion: 40,
    existingShifts: [{ ...inviteShift, canceled: true }],
    existingApplications: [makeConfirmedApp()]
  });
  await assert.rejects(
    () => sendInvitesInPostgres({
      pool,
      actor: recruiter,
      command: { ...validCommand, memberIds: [4001] },
      now: new Date('2026-07-29T15:00:00.000Z')
    }),
    err => err instanceof PostgresCommandValidationError && /отменённую дату/.test(err.message)
  );
});

test('sendInvitesInPostgres rejects empty memberIds before opening a transaction', async () => {
  const pool = fakePool({
    currentVersion: 40,
    existingShifts: [{ ...inviteShift }]
  });
  await assert.rejects(
    () => sendInvitesInPostgres({
      pool,
      actor: recruiter,
      command: { ...validCommand, memberIds: [] },
      now: new Date('2026-07-29T15:00:00.000Z')
    }),
    /memberIds is required/
  );
  await assert.rejects(
    () => sendInvitesInPostgres({
      pool,
      actor: recruiter,
      command: { ...validCommand, memberIds: undefined },
      now: new Date('2026-07-29T15:00:00.000Z')
    }),
    /memberIds is required/
  );
  await assert.rejects(
    () => sendInvitesInPostgres({
      pool,
      actor: recruiter,
      command: { ...validCommand, memberIds: [0] },
      now: new Date('2026-07-29T15:00:00.000Z')
    }),
    /positive integers/
  );
  assert.equal(pool.calls.length, 0);
});

test('sendInvitesInPostgres rejects empty link with a required-field error', async () => {
  const pool = fakePool({
    currentVersion: 40,
    existingShifts: [{ ...inviteShift }]
  });
  for (const bad of ['', '   ', undefined, null]) {
    await assert.rejects(
      () => sendInvitesInPostgres({
        pool,
        actor: recruiter,
        command: { ...validCommand, link: bad, memberIds: [4001] },
        now: new Date('2026-07-29T15:00:00.000Z')
      }),
      err => err instanceof PostgresCommandValidationError && /link is required/.test(err.message),
      `expected required-field reject for link=${JSON.stringify(bad)}`
    );
  }
  assert.equal(pool.calls.length, 0);
});

test('sendInvitesInPostgres rejects malformed and non-Telegram links before opening a transaction', async () => {
  const pool = fakePool({
    currentVersion: 40,
    existingShifts: [{ ...inviteShift }]
  });
  for (const bad of [
    'not-a-url',
    'ftp://t.me/xyz',
    'https://example.com/xyz',
    'https://vk.com/link',
    'https://faket.me/xyz'
  ]) {
    await assert.rejects(
      () => sendInvitesInPostgres({
        pool,
        actor: recruiter,
        command: { ...validCommand, link: bad, memberIds: [4001] },
        now: new Date('2026-07-29T15:00:00.000Z')
      }),
      err => err instanceof PostgresCommandValidationError && /ссылку на рабочую группу/.test(err.message),
      `expected reject for link=${bad}`
    );
  }
  assert.equal(pool.calls.length, 0);
});

test('sendInvitesInPostgres accepts telegram.me hosts as well', async () => {
  const pool = fakePool({
    currentVersion: 40,
    existingShifts: [{ ...inviteShift }],
    existingApplications: [makeConfirmedApp()]
  });
  const result = await sendInvitesInPostgres({
    pool,
    actor: recruiter,
    command: {
      ...validCommand,
      link: 'https://telegram.me/joinchat/xyz',
      memberIds: [4001]
    },
    now: new Date('2026-07-29T15:00:00.000Z')
  });
  assert.equal(result.link, 'https://telegram.me/joinchat/xyz');
});

test('sendInvitesInPostgres rejects when an application is unknown and rolls back', async () => {
  const pool = fakePool({
    currentVersion: 40,
    existingShifts: [{ ...inviteShift }],
    existingApplications: [makeConfirmedApp({ legacy_id: 4001 })]
  });
  await assert.rejects(
    () => sendInvitesInPostgres({
      pool,
      actor: recruiter,
      command: { ...validCommand, memberIds: [4001, 999999] },
      now: new Date('2026-07-29T15:00:00.000Z')
    }),
    err => err instanceof PostgresCommandValidationError && /application not found: 999999/.test(err.message)
  );
  const sqls = pool.calls.map(call => call.sql.trim());
  assert.ok(sqls.some(sql => /^ROLLBACK$/i.test(sql)));
  assert.equal(pool.getInviteGroups().length, 0);
});

test('sendInvitesInPostgres rejects an application that belongs to another shift', async () => {
  const pool = fakePool({
    currentVersion: 40,
    existingShifts: [{ ...inviteShift }],
    existingApplications: [
      makeConfirmedApp({ shift_id: 'shift-uuid-other' })
    ]
  });
  await assert.rejects(
    () => sendInvitesInPostgres({
      pool,
      actor: recruiter,
      command: { ...validCommand, memberIds: [4001] },
      now: new Date('2026-07-29T15:00:00.000Z')
    }),
    err => err instanceof PostgresCommandValidationError && /not on the selected shift/.test(err.message)
  );
  const sqls = pool.calls.map(call => call.sql.trim());
  assert.ok(sqls.some(sql => /^ROLLBACK$/i.test(sql)));
});

test('sendInvitesInPostgres rejects a non-confirmed application (already invited, pending, etc.)', async () => {
  for (const badStatus of ['pending', 'invited', 'feedback', 'passed', 'failed', 'noshow', 'queue']) {
    const pool = fakePool({
      currentVersion: 40,
      existingShifts: [{ ...inviteShift }],
      existingApplications: [makeConfirmedApp({ status: badStatus })]
    });
    await assert.rejects(
      () => sendInvitesInPostgres({
        pool,
        actor: recruiter,
        command: { ...validCommand, memberIds: [4001] },
        now: new Date('2026-07-29T15:00:00.000Z')
      }),
      err => err instanceof PostgresCommandValidationError
        && /not eligible/.test(err.message)
        && new RegExp(`got '${badStatus}'`).test(err.message),
      `expected reject for status=${badStatus}`
    );
    assert.equal(pool.getInviteGroups().length, 0);
  }
});

test('sendInvitesInPostgres rejects invalid input types before opening a transaction', async () => {
  const pool = fakePool({ currentVersion: 40 });
  await assert.rejects(
    () => sendInvitesInPostgres({
      pool,
      actor: recruiter,
      command: { ...validCommand, shiftId: 0, memberIds: [4001] },
      now: new Date('2026-07-29T15:00:00.000Z')
    }),
    /shiftId must be a positive integer/
  );
  await assert.rejects(
    () => sendInvitesInPostgres({
      pool,
      actor: recruiter,
      command: { ...validCommand, venueId: '', memberIds: [4001] },
      now: new Date('2026-07-29T15:00:00.000Z')
    }),
    /venueId is required/
  );
  await assert.rejects(
    () => sendInvitesInPostgres({
      pool,
      actor: recruiter,
      command: { ...validCommand, baseVersion: 0, memberIds: [4001] },
      now: new Date('2026-07-29T15:00:00.000Z')
    }),
    /baseVersion is required/
  );
  assert.equal(pool.calls.length, 0);
});

test('sendInvitesInPostgres rejects non-recruiter actors before opening a transaction', async () => {
  const pool = fakePool({
    currentVersion: 40,
    existingShifts: [{ ...inviteShift }],
    existingApplications: [makeConfirmedApp()]
  });
  await assert.rejects(
    () => sendInvitesInPostgres({
      pool,
      actor: { role: 'trainee', telegram: { user: { id: '9' } } },
      command: { ...validCommand, memberIds: [4001] },
      now: new Date('2026-07-29T15:00:00.000Z')
    }),
    err => err instanceof PostgresCommandAuthorizationError
  );
  assert.equal(pool.calls.length, 0);
});

// -----------------------------------------------------------------------------
// cancel_internship
// -----------------------------------------------------------------------------

const cancellationShift = {
  id: 'shift-uuid-cancel',
  legacy_id: 7700,
  date: '2026-08-30',
  seats: 4,
  open: true,
  canceled: false
};

const cancellationGroup = {
  id: 'group-uuid-cancel',
  legacy_id: 8800,
  shift_id: 'shift-uuid-cancel',
  venue_id: 'loft5_small',
  link: 'https://t.me/+cancel_group'
};

function makeInvitedCancellationApp(overrides = {}) {
  return {
    id: 'app-uuid-cancel-1',
    legacy_id: 9001,
    shift_id: 'shift-uuid-cancel',
    status: 'invited',
    invite_group_id: 'group-uuid-cancel',
    venue_id: 'loft5_small',
    group_link: 'https://t.me/+cancel_group',
    candidate_report: true,
    mentor_report_received: true,
    mentor_report_at: '2026-08-30T12:00:00.000Z',
    mentor_reporter_telegram_user_id: 'mentor',
    mentor_decision: 'Стажировка пройдена',
    mentor_report_venue_id: 'loft5_small',
    mentor_report_venue: 'LOFT #5 SMALL',
    mentor_report_loft: 'LOFT #5',
    mentor_report_hall: 'SMALL',
    mentor_comment_for_trainee: 'comment',
    mentor_comment_sent_at: '2026-08-30T12:05:00.000Z',
    mentor_comment_delivery_status: 'sent',
    mentor_comment_delivery_error: '',
    trainee_telegram_user_id: '900100',
    trainee_telegram_chat_id: '900100',
    telegram_username: 'cancel_trainee',
    name: 'Cancel Trainee',
    ...overrides
  };
}

test('cancelInternshipInPostgres returns an invited trainee to queue and keeps remaining group members', async () => {
  const pool = fakePool({
    currentVersion: 70,
    existingShifts: [{ ...cancellationShift }],
    existingApplications: [
      makeInvitedCancellationApp(),
      makeInvitedCancellationApp({
        id: 'app-uuid-cancel-2',
        legacy_id: 9002,
        trainee_telegram_user_id: '900200',
        trainee_telegram_chat_id: '900200'
      })
    ],
    existingInviteGroups: [{ ...cancellationGroup }],
    existingInviteGroupMembers: [
      { invite_group_id: 'group-uuid-cancel', application_id: 'app-uuid-cancel-1' },
      { invite_group_id: 'group-uuid-cancel', application_id: 'app-uuid-cancel-2' }
    ]
  });
  const now = new Date('2026-07-29T17:00:00.000Z');
  const result = await cancelInternshipInPostgres({
    pool,
    actor: recruiter,
    command: { action: 'cancel_internship', baseVersion: 70, applicationId: 9001 },
    now
  });

  assert.equal(result.changed, true);
  assert.equal(result.applicationLegacyId, 9001);
  assert.equal(result.previousStatus, 'invited');
  assert.equal(result.nextStatus, 'queue');
  assert.equal(result.previousShiftId, 7700);
  assert.equal(result.previousInviteGroupId, 8800);
  assert.equal(result.inviteGroupChanged, true);
  assert.equal(result.inviteGroupRemoved, false);
  assert.deepEqual(result.remainingMemberLegacyIds, [9002]);
  assert.deepEqual(result.notifications, {
    total: 1,
    pending: 1,
    skipped: 0,
    inserted: 1
  });
  assert.equal(result.version, 71);
  assert.equal(result.previousVersion, 70);
  assert.equal(result.updatedAt, now.toISOString());

  const canceledApp = pool.getApplications().find(app => Number(app.legacy_id) === 9001);
  assert.equal(canceledApp.status, 'queue');
  assert.equal(canceledApp.shift_id, null);
  assert.equal(canceledApp.invite_group_id, null);
  assert.equal(canceledApp.venue_id, null);
  assert.equal(canceledApp.group_link, '');
  assert.equal(canceledApp.candidate_report, false);
  assert.equal(canceledApp.mentor_report_received, false);
  assert.equal(canceledApp.mentor_report_at, null);
  assert.equal(canceledApp.mentor_decision, '');
  assert.equal(canceledApp.mentor_comment_delivery_status, null);

  assert.equal(pool.getInviteGroups().length, 1);
  assert.equal(pool.getInviteGroups()[0].updated_at, now.toISOString());
  assert.deepEqual(
    pool.getInviteGroupMembers().map(member => member.application_id),
    ['app-uuid-cancel-2']
  );

  const eventInserts = pool.calls.filter(call => /INSERT INTO application_events/.test(call.sql));
  assert.deepEqual(
    eventInserts.map(call => call.params[3]),
    ['invite_group_updated', 'internship_cancelled']
  );
  const groupPayload = JSON.parse(eventInserts[0].params[6]);
  assert.equal(groupPayload.action, 'cancel_internship');
  assert.equal(groupPayload.inviteGroupId, 8800);
  assert.deepEqual(groupPayload.removedMemberIds, [9001]);
  assert.deepEqual(groupPayload.memberIds, [9002]);
  assert.equal(groupPayload.legacyShiftId, 7700);

  const cancelPayload = JSON.parse(eventInserts[1].params[6]);
  assert.equal(cancelPayload.previousStatus, 'invited');
  assert.equal(cancelPayload.nextStatus, 'queue');
  assert.equal(cancelPayload.previousShiftId, 7700);
  assert.equal(cancelPayload.nextShiftId, null);
  assert.equal(cancelPayload.previousInviteGroupId, 8800);
  assert.equal(cancelPayload.legacyApplicationId, 9001);

  const notifications = pool.getNotifications();
  assert.equal(notifications.length, 1);
  assert.equal(notifications[0].type, 'cancel_internship');
  assert.equal(notifications[0].status, 'pending');
  assert.equal(notifications[0].chat_id, '900100');
  assert.equal(notifications[0].chat_target, 'trainee');
  assert.equal(notifications[0].parse_mode, 'HTML');
  assert.match(notifications[0].text, /Стажировка отменена/);
  assert.match(notifications[0].text, /30\.08\.2026/);
  assert.match(notifications[0].text, /предварительную запись/);
  assert.match(notifications[0].idempotency_key, /^cancel_internship:9001:/);
});

test('cancelInternshipInPostgres removes an empty invite group when the last member is canceled', async () => {
  const pool = fakePool({
    currentVersion: 70,
    existingShifts: [{ ...cancellationShift }],
    existingApplications: [makeInvitedCancellationApp()],
    existingInviteGroups: [{ ...cancellationGroup }],
    existingInviteGroupMembers: [
      { invite_group_id: 'group-uuid-cancel', application_id: 'app-uuid-cancel-1' }
    ]
  });
  const result = await cancelInternshipInPostgres({
    pool,
    actor: recruiter,
    command: { action: 'cancel_internship', baseVersion: 70, applicationId: 9001 },
    now: new Date('2026-07-29T17:00:00.000Z')
  });

  assert.equal(result.inviteGroupRemoved, true);
  assert.deepEqual(result.remainingMemberLegacyIds, []);
  assert.equal(pool.getInviteGroups().length, 0);
  assert.equal(pool.getInviteGroupMembers().length, 0);
  const eventTypes = pool.calls
    .filter(call => /INSERT INTO application_events/.test(call.sql))
    .map(call => call.params[3]);
  assert.deepEqual(eventTypes, ['invite_group_removed', 'internship_cancelled']);
});

test('cancelInternshipInPostgres records skipped notification when trainee chat id is missing', async () => {
  const pool = fakePool({
    currentVersion: 70,
    existingShifts: [{ ...cancellationShift }],
    existingApplications: [
      makeInvitedCancellationApp({
        trainee_telegram_user_id: '',
        trainee_telegram_chat_id: ''
      })
    ],
    existingInviteGroups: [{ ...cancellationGroup }],
    existingInviteGroupMembers: [
      { invite_group_id: 'group-uuid-cancel', application_id: 'app-uuid-cancel-1' }
    ]
  });
  const result = await cancelInternshipInPostgres({
    pool,
    actor: recruiter,
    command: { action: 'cancel_internship', baseVersion: 70, applicationId: 9001 },
    now: new Date('2026-07-29T17:00:00.000Z')
  });

  assert.deepEqual(result.notifications, {
    total: 1,
    pending: 0,
    skipped: 1,
    inserted: 1
  });
  assert.equal(pool.getNotifications()[0].status, 'skipped');
  assert.equal(pool.getNotifications()[0].chat_id, null);
  assert.equal(pool.getNotifications()[0].error, 'telegram_chat_missing');
});

test('cancelInternshipInPostgres rejects after attendance is marked', async () => {
  for (const status of ['feedback', 'passed', 'failed', 'noshow', 'queue']) {
    const pool = fakePool({
      currentVersion: 70,
      existingShifts: [{ ...cancellationShift }],
      existingApplications: [makeInvitedCancellationApp({ status })],
      existingInviteGroups: [{ ...cancellationGroup }],
      existingInviteGroupMembers: [
        { invite_group_id: 'group-uuid-cancel', application_id: 'app-uuid-cancel-1' }
      ]
    });
    await assert.rejects(
      () => cancelInternshipInPostgres({
        pool,
        actor: recruiter,
        command: { action: 'cancel_internship', baseVersion: 70, applicationId: 9001 },
        now: new Date('2026-07-29T17:00:00.000Z')
      }),
      err => err instanceof PostgresCommandValidationError && /только до выхода/.test(err.message),
      `expected reject for status=${status}`
    );
    assert.equal(pool.getApplications()[0].status, status);
    assert.equal(pool.getVersion(), 70);
    const sqls = pool.calls.map(call => call.sql.trim());
    assert.ok(sqls.some(sql => /^ROLLBACK$/i.test(sql)));
    assert.equal(sqls.some(sql => /^COMMIT$/i.test(sql)), false);
  }
});

test('cancelInternshipInPostgres rolls back on stale baseVersion', async () => {
  const pool = fakePool({
    currentVersion: 71,
    existingShifts: [{ ...cancellationShift }],
    existingApplications: [makeInvitedCancellationApp()],
    existingInviteGroups: [{ ...cancellationGroup }],
    existingInviteGroupMembers: [
      { invite_group_id: 'group-uuid-cancel', application_id: 'app-uuid-cancel-1' }
    ]
  });
  await assert.rejects(
    () => cancelInternshipInPostgres({
      pool,
      actor: recruiter,
      command: { action: 'cancel_internship', baseVersion: 70, applicationId: 9001 },
      now: new Date('2026-07-29T17:00:00.000Z')
    }),
    err => err instanceof PostgresCommandConflictError
  );
  assert.equal(pool.getApplications()[0].status, 'invited');
  assert.equal(pool.getInviteGroups().length, 1);
  assert.equal(pool.getNotifications().length, 0);
  const sqls = pool.calls.map(call => call.sql.trim());
  assert.ok(sqls.some(sql => /^ROLLBACK$/i.test(sql)));
  assert.equal(sqls.some(sql => /^COMMIT$/i.test(sql)), false);
});

test('cancelInternshipInPostgres rejects unknown application and invalid inputs', async () => {
  const pool = fakePool({ currentVersion: 70 });
  await assert.rejects(
    () => cancelInternshipInPostgres({
      pool,
      actor: recruiter,
      command: { action: 'cancel_internship', baseVersion: 70, applicationId: 999999 },
      now: new Date('2026-07-29T17:00:00.000Z')
    }),
    err => err instanceof PostgresCommandValidationError && /application not found/.test(err.message)
  );
  await assert.rejects(
    () => cancelInternshipInPostgres({
      pool,
      actor: recruiter,
      command: { action: 'cancel_internship', baseVersion: 70, applicationId: 0 },
      now: new Date('2026-07-29T17:00:00.000Z')
    }),
    /applicationId must be a positive integer/
  );
  await assert.rejects(
    () => cancelInternshipInPostgres({
      pool,
      actor: recruiter,
      command: { action: 'cancel_internship', baseVersion: 0, applicationId: 9001 },
      now: new Date('2026-07-29T17:00:00.000Z')
    }),
    /baseVersion is required/
  );
});

test('cancelInternshipInPostgres rejects non-recruiter actors before opening a transaction', async () => {
  const pool = fakePool({ currentVersion: 70 });
  await assert.rejects(
    () => cancelInternshipInPostgres({
      pool,
      actor: { role: 'trainee', telegram: { user: { id: '5' } } },
      command: { action: 'cancel_internship', baseVersion: 70, applicationId: 9001 },
      now: new Date('2026-07-29T17:00:00.000Z')
    }),
    err => err instanceof PostgresCommandAuthorizationError
  );
  assert.equal(pool.calls.length, 0);
});

test('cancelInternshipInPostgres rolls back when notification outbox insert fails', async () => {
  const pool = fakePool({
    currentVersion: 70,
    existingShifts: [{ ...cancellationShift }],
    existingApplications: [makeInvitedCancellationApp()],
    existingInviteGroups: [{ ...cancellationGroup }],
    existingInviteGroupMembers: [
      { invite_group_id: 'group-uuid-cancel', application_id: 'app-uuid-cancel-1' }
    ],
    notificationInsertThrows: true
  });
  await assert.rejects(
    () => cancelInternshipInPostgres({
      pool,
      actor: recruiter,
      command: { action: 'cancel_internship', baseVersion: 70, applicationId: 9001 },
      now: new Date('2026-07-29T17:00:00.000Z')
    }),
    /notification insert failed/
  );
  const sqls = pool.calls.map(call => call.sql.trim());
  assert.ok(sqls.some(sql => /^ROLLBACK$/i.test(sql)));
  assert.ok(sqls.findIndex(sql => /^RELEASE$/i.test(sql)) > sqls.findIndex(sql => /^ROLLBACK$/i.test(sql)));
  assert.equal(sqls.some(sql => /^COMMIT$/i.test(sql)), false);
  assert.equal(pool.getNotifications().length, 0);
});

// -----------------------------------------------------------------------------
// return_to_queue
// -----------------------------------------------------------------------------

test('returnToQueueInPostgres clears date/group links and keeps remaining group members', async () => {
  const pool = fakePool({
    currentVersion: 80,
    existingShifts: [{ ...cancellationShift }],
    existingApplications: [
      makeInvitedCancellationApp(),
      makeInvitedCancellationApp({
        id: 'app-uuid-cancel-2',
        legacy_id: 9002,
        trainee_telegram_user_id: '900200',
        trainee_telegram_chat_id: '900200'
      })
    ],
    existingInviteGroups: [{ ...cancellationGroup }],
    existingInviteGroupMembers: [
      { invite_group_id: 'group-uuid-cancel', application_id: 'app-uuid-cancel-1' },
      { invite_group_id: 'group-uuid-cancel', application_id: 'app-uuid-cancel-2' }
    ]
  });
  const now = new Date('2026-07-29T17:20:00.000Z');
  const result = await returnToQueueInPostgres({
    pool,
    actor: recruiter,
    command: { action: 'return_to_queue', baseVersion: 80, applicationId: 9001 },
    now
  });

  assert.equal(result.changed, true);
  assert.equal(result.applicationLegacyId, 9001);
  assert.equal(result.previousStatus, 'invited');
  assert.equal(result.nextStatus, 'queue');
  assert.equal(result.previousShiftId, 7700);
  assert.equal(result.previousInviteGroupId, 8800);
  assert.equal(result.inviteGroupChanged, true);
  assert.equal(result.inviteGroupRemoved, false);
  assert.deepEqual(result.remainingMemberLegacyIds, [9002]);
  assert.equal(result.version, 81);
  assert.equal(result.previousVersion, 80);
  assert.equal(result.updatedAt, now.toISOString());

  const returnedApp = pool.getApplications().find(app => Number(app.legacy_id) === 9001);
  assert.equal(returnedApp.status, 'queue');
  assert.equal(returnedApp.shift_id, null);
  assert.equal(returnedApp.invite_group_id, null);
  assert.equal(returnedApp.venue_id, null);
  assert.equal(returnedApp.group_link, '');
  assert.equal(returnedApp.candidate_report, false);
  assert.equal(returnedApp.mentor_report_received, false);
  assert.equal(returnedApp.mentor_comment_delivery_status, null);

  assert.equal(pool.getInviteGroups().length, 1);
  assert.equal(pool.getInviteGroups()[0].updated_at, now.toISOString());
  assert.deepEqual(
    pool.getInviteGroupMembers().map(member => member.application_id),
    ['app-uuid-cancel-2']
  );
  assert.equal(pool.getNotifications().length, 0, 'return_to_queue must not notify trainees');

  const eventInserts = pool.calls.filter(call => /INSERT INTO application_events/.test(call.sql));
  assert.deepEqual(
    eventInserts.map(call => call.params[3]),
    ['invite_group_updated', 'application_returned_to_queue']
  );
  const groupPayload = JSON.parse(eventInserts[0].params[6]);
  assert.equal(groupPayload.action, 'return_to_queue');
  assert.equal(groupPayload.inviteGroupId, 8800);
  assert.deepEqual(groupPayload.removedMemberIds, [9001]);
  assert.deepEqual(groupPayload.memberIds, [9002]);
  assert.equal(groupPayload.legacyShiftId, 7700);

  const returnPayload = JSON.parse(eventInserts[1].params[6]);
  assert.equal(returnPayload.action, 'return_to_queue');
  assert.equal(returnPayload.previousStatus, 'invited');
  assert.equal(returnPayload.nextStatus, 'queue');
  assert.equal(returnPayload.previousShiftId, 7700);
  assert.equal(returnPayload.nextShiftId, null);
  assert.equal(returnPayload.previousInviteGroupId, 8800);
  assert.equal(returnPayload.legacyApplicationId, 9001);
});

test('returnToQueueInPostgres removes an empty invite group when the last member returns', async () => {
  const pool = fakePool({
    currentVersion: 80,
    existingShifts: [{ ...cancellationShift }],
    existingApplications: [makeInvitedCancellationApp()],
    existingInviteGroups: [{ ...cancellationGroup }],
    existingInviteGroupMembers: [
      { invite_group_id: 'group-uuid-cancel', application_id: 'app-uuid-cancel-1' }
    ]
  });
  const result = await returnToQueueInPostgres({
    pool,
    actor: recruiter,
    command: { action: 'return_to_queue', baseVersion: 80, applicationId: 9001 },
    now: new Date('2026-07-29T17:20:00.000Z')
  });

  assert.equal(result.inviteGroupRemoved, true);
  assert.deepEqual(result.remainingMemberLegacyIds, []);
  assert.equal(pool.getInviteGroups().length, 0);
  assert.equal(pool.getInviteGroupMembers().length, 0);
  const eventTypes = pool.calls
    .filter(call => /INSERT INTO application_events/.test(call.sql))
    .map(call => call.params[3]);
  assert.deepEqual(eventTypes, ['invite_group_removed', 'application_returned_to_queue']);
});

test('returnToQueueInPostgres is a no-op for an already clean queue application', async () => {
  const pool = fakePool({
    currentVersion: 80,
    metaUpdatedAt: '2026-07-20T00:00:00.000Z',
    existingApplications: [
      makeInvitedCancellationApp({
        status: 'queue',
        shift_id: null,
        invite_group_id: null,
        venue_id: null,
        group_link: ''
      })
    ]
  });
  const result = await returnToQueueInPostgres({
    pool,
    actor: recruiter,
    command: { action: 'return_to_queue', baseVersion: 80, applicationId: 9001 },
    now: new Date('2026-07-29T17:20:00.000Z')
  });

  assert.equal(result.changed, false);
  assert.equal(result.version, 80);
  assert.equal(result.updatedAt, '2026-07-20T00:00:00.000Z');
  assert.equal(pool.getVersion(), 80);
  const sqls = pool.calls.map(call => call.sql.trim());
  assert.ok(sqls.some(sql => /^COMMIT$/i.test(sql)));
  assert.equal(sqls.some(sql => /UPDATE applications/i.test(sql)), false);
  assert.equal(sqls.some(sql => /INSERT INTO application_events/i.test(sql)), false);
});

test('returnToQueueInPostgres rejects stale version, attended statuses and unknown applications', async () => {
  const stalePool = fakePool({
    currentVersion: 81,
    existingApplications: [makeInvitedCancellationApp()]
  });
  await assert.rejects(
    () => returnToQueueInPostgres({
      pool: stalePool,
      actor: recruiter,
      command: { action: 'return_to_queue', baseVersion: 80, applicationId: 9001 },
      now: new Date('2026-07-29T17:20:00.000Z')
    }),
    err => err instanceof PostgresCommandConflictError
  );
  assert.equal(stalePool.getApplications()[0].status, 'invited');
  assert.ok(stalePool.calls.some(call => call.sql === 'ROLLBACK'));

  for (const status of ['feedback', 'passed', 'failed', 'noshow']) {
    const pool = fakePool({
      currentVersion: 80,
      existingApplications: [makeInvitedCancellationApp({ status })]
    });
    await assert.rejects(
      () => returnToQueueInPostgres({
        pool,
        actor: recruiter,
        command: { action: 'return_to_queue', baseVersion: 80, applicationId: 9001 },
        now: new Date('2026-07-29T17:20:00.000Z')
      }),
      err => err instanceof PostgresCommandValidationError
        && /до выхода на стажировку/.test(err.message)
    );
    assert.equal(pool.getApplications()[0].status, status);
    assert.ok(pool.calls.some(call => call.sql === 'ROLLBACK'));
  }

  const missingPool = fakePool({ currentVersion: 80 });
  await assert.rejects(
    () => returnToQueueInPostgres({
      pool: missingPool,
      actor: recruiter,
      command: { action: 'return_to_queue', baseVersion: 80, applicationId: 999999 },
      now: new Date('2026-07-29T17:20:00.000Z')
    }),
    err => err instanceof PostgresCommandValidationError
      && /application not found/.test(err.message)
  );
});

test('returnToQueueInPostgres rejects invalid input and non-recruiters before opening a transaction', async () => {
  const pool = fakePool({ currentVersion: 80 });
  await assert.rejects(
    () => returnToQueueInPostgres({
      pool,
      actor: recruiter,
      command: { action: 'return_to_queue', baseVersion: 80, applicationId: 0 },
      now: new Date('2026-07-29T17:20:00.000Z')
    }),
    /applicationId must be a positive integer/
  );
  await assert.rejects(
    () => returnToQueueInPostgres({
      pool,
      actor: recruiter,
      command: { action: 'return_to_queue', baseVersion: 0, applicationId: 9001 },
      now: new Date('2026-07-29T17:20:00.000Z')
    }),
    /baseVersion is required/
  );
  await assert.rejects(
    () => returnToQueueInPostgres({
      pool,
      actor: { role: 'trainee', telegram: { user: { id: '5' } } },
      command: { action: 'return_to_queue', baseVersion: 80, applicationId: 9001 },
      now: new Date('2026-07-29T17:20:00.000Z')
    }),
    err => err instanceof PostgresCommandAuthorizationError
  );
  assert.equal(pool.calls.length, 0);
});

test('returnToQueueInPostgres rolls back and releases when event insert fails', async () => {
  const pool = fakePool({
    currentVersion: 80,
    existingShifts: [{ ...cancellationShift }],
    existingApplications: [makeInvitedCancellationApp()],
    existingInviteGroups: [{ ...cancellationGroup }],
    existingInviteGroupMembers: [
      { invite_group_id: 'group-uuid-cancel', application_id: 'app-uuid-cancel-1' }
    ],
    eventInsertThrows: true
  });
  await assert.rejects(
    () => returnToQueueInPostgres({
      pool,
      actor: recruiter,
      command: { action: 'return_to_queue', baseVersion: 80, applicationId: 9001 },
      now: new Date('2026-07-29T17:20:00.000Z')
    }),
    /event insert failed/
  );
  const sqls = pool.calls.map(call => call.sql.trim());
  assert.ok(sqls.some(sql => /^ROLLBACK$/i.test(sql)));
  assert.ok(sqls.findIndex(sql => /^RELEASE$/i.test(sql)) > sqls.findIndex(sql => /^ROLLBACK$/i.test(sql)));
  assert.equal(sqls.some(sql => /^COMMIT$/i.test(sql)), false);
});

// -----------------------------------------------------------------------------
// cancel_shift
// -----------------------------------------------------------------------------

const shiftCancellationShift = {
  id: 'shift-uuid-cancel-shift',
  legacy_id: 9900,
  date: '2026-09-01',
  seats: 4,
  open: true,
  canceled: false
};

const shiftCancellationGroup = {
  id: 'group-uuid-cancel-shift',
  legacy_id: 9910,
  shift_id: 'shift-uuid-cancel-shift',
  venue_id: 'loft4',
  link: 'https://t.me/+cancel_shift_group'
};

function makeShiftCancellationApp(overrides = {}) {
  return {
    id: 'app-uuid-cancel-shift-1',
    legacy_id: 9921,
    shift_id: 'shift-uuid-cancel-shift',
    status: 'pending',
    invite_group_id: null,
    venue_id: null,
    group_link: '',
    candidate_report: true,
    mentor_report_received: true,
    mentor_report_at: '2026-09-01T12:00:00.000Z',
    mentor_reporter_telegram_user_id: 'mentor',
    mentor_decision: 'Стажировка пройдена',
    mentor_report_venue_id: 'loft4',
    mentor_report_venue: 'LOFT #4',
    mentor_report_loft: 'LOFT #4',
    mentor_report_hall: '',
    mentor_comment_for_trainee: 'comment',
    mentor_comment_sent_at: '2026-09-01T12:05:00.000Z',
    mentor_comment_delivery_status: 'sent',
    mentor_comment_delivery_error: '',
    trainee_telegram_user_id: '992100',
    trainee_telegram_chat_id: '992100',
    telegram_username: 'shift_cancel_trainee',
    name: 'Shift Cancel Trainee',
    ...overrides
  };
}

test('cancelShiftInPostgres cancels the shift, returns pre-attendance trainees to queue and keeps attended group members', async () => {
  const pool = fakePool({
    currentVersion: 90,
    existingShifts: [{ ...shiftCancellationShift }],
    existingApplications: [
      makeShiftCancellationApp(),
      makeShiftCancellationApp({
        id: 'app-uuid-cancel-shift-2',
        legacy_id: 9922,
        status: 'invited',
        invite_group_id: 'group-uuid-cancel-shift',
        venue_id: 'loft4',
        group_link: 'https://t.me/+cancel_shift_group',
        trainee_telegram_user_id: '992200',
        trainee_telegram_chat_id: '992200'
      }),
      makeShiftCancellationApp({
        id: 'app-uuid-cancel-shift-3',
        legacy_id: 9923,
        status: 'feedback',
        invite_group_id: 'group-uuid-cancel-shift',
        venue_id: 'loft4',
        group_link: 'https://t.me/+cancel_shift_group',
        trainee_telegram_user_id: '992300',
        trainee_telegram_chat_id: '992300'
      })
    ],
    existingInviteGroups: [{ ...shiftCancellationGroup }],
    existingInviteGroupMembers: [
      { invite_group_id: 'group-uuid-cancel-shift', application_id: 'app-uuid-cancel-shift-2' },
      { invite_group_id: 'group-uuid-cancel-shift', application_id: 'app-uuid-cancel-shift-3' }
    ]
  });
  const now = new Date('2026-07-29T18:00:00.000Z');
  const result = await cancelShiftInPostgres({
    pool,
    actor: recruiter,
    command: { action: 'cancel_shift', baseVersion: 90, shiftId: 9900 },
    now
  });

  assert.equal(result.changed, true);
  assert.equal(result.shiftLegacyId, 9900);
  assert.equal(result.shiftDate, '2026-09-01');
  assert.deepEqual(result.affectedApplicationLegacyIds, [9921, 9922]);
  assert.deepEqual(result.notifications, {
    total: 2,
    pending: 2,
    skipped: 0,
    inserted: 2
  });
  assert.equal(result.version, 91);
  assert.equal(result.previousVersion, 90);

  const shift = pool.getShifts()[0];
  assert.equal(shift.open, false);
  assert.equal(shift.canceled, true);
  assert.equal(shift.canceled_at, now.toISOString());

  const canceledApps = pool.getApplications()
    .filter(app => [9921, 9922].includes(Number(app.legacy_id)))
    .sort((left, right) => Number(left.legacy_id) - Number(right.legacy_id));
  assert.deepEqual(
    canceledApps.map(app => ({
      legacyId: Number(app.legacy_id),
      status: app.status,
      shiftId: app.shift_id,
      inviteGroupId: app.invite_group_id,
      venueId: app.venue_id,
      groupLink: app.group_link,
      candidateReport: app.candidate_report,
      mentorReportReceived: app.mentor_report_received,
      mentorCommentDeliveryStatus: app.mentor_comment_delivery_status
    })),
    [
      {
        legacyId: 9921,
        status: 'queue',
        shiftId: null,
        inviteGroupId: null,
        venueId: null,
        groupLink: '',
        candidateReport: false,
        mentorReportReceived: false,
        mentorCommentDeliveryStatus: null
      },
      {
        legacyId: 9922,
        status: 'queue',
        shiftId: null,
        inviteGroupId: null,
        venueId: null,
        groupLink: '',
        candidateReport: false,
        mentorReportReceived: false,
        mentorCommentDeliveryStatus: null
      }
    ]
  );
  const attendedApp = pool.getApplications().find(app => Number(app.legacy_id) === 9923);
  assert.equal(attendedApp.status, 'feedback');
  assert.equal(attendedApp.shift_id, 'shift-uuid-cancel-shift');
  assert.equal(attendedApp.invite_group_id, 'group-uuid-cancel-shift');
  assert.deepEqual(
    pool.getInviteGroupMembers().map(member => member.application_id),
    ['app-uuid-cancel-shift-3']
  );
  assert.equal(pool.getInviteGroups().length, 1);

  assert.equal(result.inviteGroupChanges.length, 1);
  assert.equal(result.inviteGroupChanges[0].inviteGroupId, 9910);
  assert.deepEqual(result.inviteGroupChanges[0].removedMemberLegacyIds, [9922]);
  assert.deepEqual(result.inviteGroupChanges[0].remainingMemberLegacyIds, [9923]);
  assert.equal(result.inviteGroupChanges[0].removed, false);

  const eventInserts = pool.calls.filter(call => /INSERT INTO application_events/.test(call.sql));
  assert.deepEqual(
    eventInserts.map(call => call.params[3]),
    ['shift_cancelled', 'invite_group_updated', 'internship_cancelled', 'internship_cancelled']
  );
  const shiftPayload = JSON.parse(eventInserts[0].params[6]);
  assert.equal(shiftPayload.action, 'cancel_shift');
  assert.equal(shiftPayload.date, '2026-09-01');
  assert.deepEqual(shiftPayload.affectedApplicationIds, [9921, 9922]);
  const groupPayload = JSON.parse(eventInserts[1].params[6]);
  assert.equal(groupPayload.inviteGroupId, 9910);
  assert.deepEqual(groupPayload.removedMemberIds, [9922]);
  assert.deepEqual(groupPayload.memberIds, [9923]);
  const firstCancelPayload = JSON.parse(eventInserts[2].params[6]);
  assert.equal(firstCancelPayload.previousStatus, 'pending');
  assert.equal(firstCancelPayload.nextStatus, 'queue');
  assert.equal(firstCancelPayload.previousShiftId, 9900);
  assert.equal(firstCancelPayload.previousInviteGroupId, null);
  const secondCancelPayload = JSON.parse(eventInserts[3].params[6]);
  assert.equal(secondCancelPayload.previousStatus, 'invited');
  assert.equal(secondCancelPayload.previousInviteGroupId, 9910);

  const notifications = pool.getNotifications();
  assert.deepEqual(notifications.map(row => row.type), ['cancel_shift', 'cancel_shift']);
  assert.deepEqual(notifications.map(row => row.chat_id), ['992100', '992200']);
  assert.ok(notifications.every(row => row.status === 'pending'));
  assert.ok(notifications.every(row => row.chat_target === 'trainee'));
  assert.ok(notifications.every(row => row.parse_mode === 'HTML'));
  assert.match(notifications[0].text, /Стажировка отменена/);
  assert.match(notifications[0].text, /01\.09\.2026/);
  assert.match(notifications[0].idempotency_key, /^cancel_shift:9921:/);
  assert.match(notifications[1].idempotency_key, /^cancel_shift:9922:/);
});

test('cancelShiftInPostgres removes invite groups that become empty', async () => {
  const pool = fakePool({
    currentVersion: 90,
    existingShifts: [{ ...shiftCancellationShift }],
    existingApplications: [
      makeShiftCancellationApp({
        id: 'app-uuid-cancel-shift-2',
        legacy_id: 9922,
        status: 'invited',
        invite_group_id: 'group-uuid-cancel-shift',
        venue_id: 'loft4',
        group_link: 'https://t.me/+cancel_shift_group'
      })
    ],
    existingInviteGroups: [{ ...shiftCancellationGroup }],
    existingInviteGroupMembers: [
      { invite_group_id: 'group-uuid-cancel-shift', application_id: 'app-uuid-cancel-shift-2' }
    ]
  });
  const result = await cancelShiftInPostgres({
    pool,
    actor: recruiter,
    command: { action: 'cancel_shift', baseVersion: 90, shiftId: 9900 },
    now: new Date('2026-07-29T18:00:00.000Z')
  });

  assert.equal(pool.getInviteGroups().length, 0);
  assert.equal(pool.getInviteGroupMembers().length, 0);
  assert.equal(result.inviteGroupChanges[0].removed, true);
  assert.deepEqual(result.inviteGroupChanges[0].remainingMemberLegacyIds, []);
  const eventTypes = pool.calls
    .filter(call => /INSERT INTO application_events/.test(call.sql))
    .map(call => call.params[3]);
  assert.deepEqual(eventTypes, ['shift_cancelled', 'invite_group_removed', 'internship_cancelled']);
});

test('cancelShiftInPostgres cancels an empty shift and writes no notifications', async () => {
  const pool = fakePool({
    currentVersion: 90,
    existingShifts: [{ ...shiftCancellationShift }]
  });
  const result = await cancelShiftInPostgres({
    pool,
    actor: recruiter,
    command: { action: 'cancel_shift', baseVersion: 90, shiftId: 9900 },
    now: new Date('2026-07-29T18:00:00.000Z')
  });

  assert.equal(pool.getShifts()[0].canceled, true);
  assert.deepEqual(result.affectedApplicationLegacyIds, []);
  assert.deepEqual(result.inviteGroupChanges, []);
  assert.deepEqual(result.notifications, {
    total: 0,
    pending: 0,
    skipped: 0,
    inserted: 0
  });
  const eventTypes = pool.calls
    .filter(call => /INSERT INTO application_events/.test(call.sql))
    .map(call => call.params[3]);
  assert.deepEqual(eventTypes, ['shift_cancelled']);
});

test('cancelShiftInPostgres records skipped notifications when trainee chat ids are missing', async () => {
  const pool = fakePool({
    currentVersion: 90,
    existingShifts: [{ ...shiftCancellationShift }],
    existingApplications: [
      makeShiftCancellationApp({
        trainee_telegram_user_id: '',
        trainee_telegram_chat_id: ''
      })
    ]
  });
  const result = await cancelShiftInPostgres({
    pool,
    actor: recruiter,
    command: { action: 'cancel_shift', baseVersion: 90, shiftId: 9900 },
    now: new Date('2026-07-29T18:00:00.000Z')
  });

  assert.deepEqual(result.notifications, {
    total: 1,
    pending: 0,
    skipped: 1,
    inserted: 1
  });
  assert.equal(pool.getNotifications()[0].status, 'skipped');
  assert.equal(pool.getNotifications()[0].chat_id, null);
  assert.equal(pool.getNotifications()[0].error, 'telegram_chat_missing');
});

test('cancelShiftInPostgres rolls back on stale baseVersion and unknown shift', async () => {
  const stalePool = fakePool({
    currentVersion: 91,
    existingShifts: [{ ...shiftCancellationShift }]
  });
  await assert.rejects(
    () => cancelShiftInPostgres({
      pool: stalePool,
      actor: recruiter,
      command: { action: 'cancel_shift', baseVersion: 90, shiftId: 9900 },
      now: new Date('2026-07-29T18:00:00.000Z')
    }),
    err => err instanceof PostgresCommandConflictError
  );
  assert.equal(stalePool.getShifts()[0].canceled, false);
  assert.equal(stalePool.getNotifications().length, 0);
  assert.ok(stalePool.calls.some(call => /^ROLLBACK$/i.test(call.sql)));

  const missingPool = fakePool({ currentVersion: 90 });
  await assert.rejects(
    () => cancelShiftInPostgres({
      pool: missingPool,
      actor: recruiter,
      command: { action: 'cancel_shift', baseVersion: 90, shiftId: 9999 },
      now: new Date('2026-07-29T18:00:00.000Z')
    }),
    err => err instanceof PostgresCommandValidationError && /shift not found/.test(err.message)
  );
  assert.ok(missingPool.calls.some(call => /^ROLLBACK$/i.test(call.sql)));
});

test('cancelShiftInPostgres rejects invalid inputs and non-recruiters before opening a transaction', async () => {
  const pool = fakePool({ currentVersion: 90 });
  await assert.rejects(
    () => cancelShiftInPostgres({
      pool,
      actor: recruiter,
      command: { action: 'cancel_shift', baseVersion: 90, shiftId: 0 },
      now: new Date('2026-07-29T18:00:00.000Z')
    }),
    /shiftId must be a positive integer/
  );
  await assert.rejects(
    () => cancelShiftInPostgres({
      pool,
      actor: recruiter,
      command: { action: 'cancel_shift', baseVersion: 0, shiftId: 9900 },
      now: new Date('2026-07-29T18:00:00.000Z')
    }),
    /baseVersion is required/
  );
  await assert.rejects(
    () => cancelShiftInPostgres({
      pool,
      actor: { role: 'trainee', telegram: { user: { id: '5' } } },
      command: { action: 'cancel_shift', baseVersion: 90, shiftId: 9900 },
      now: new Date('2026-07-29T18:00:00.000Z')
    }),
    err => err instanceof PostgresCommandAuthorizationError
  );
  assert.equal(pool.calls.length, 0);
});

test('cancelShiftInPostgres rolls back when notification outbox insert fails', async () => {
  const pool = fakePool({
    currentVersion: 90,
    existingShifts: [{ ...shiftCancellationShift }],
    existingApplications: [makeShiftCancellationApp()],
    notificationInsertThrows: true
  });
  await assert.rejects(
    () => cancelShiftInPostgres({
      pool,
      actor: recruiter,
      command: { action: 'cancel_shift', baseVersion: 90, shiftId: 9900 },
      now: new Date('2026-07-29T18:00:00.000Z')
    }),
    /notification insert failed/
  );
  const sqls = pool.calls.map(call => call.sql.trim());
  assert.ok(sqls.some(sql => /^ROLLBACK$/i.test(sql)));
  assert.equal(sqls.some(sql => /^COMMIT$/i.test(sql)), false);
  assert.equal(pool.getNotifications().length, 0);
});

// -----------------------------------------------------------------------------
// step_back_application
// -----------------------------------------------------------------------------

const stepBackShift = {
  id: 'shift-uuid-step-back',
  legacy_id: 9950,
  date: '2026-09-05',
  seats: 3,
  open: true,
  canceled: false
};

function makeStepBackApp(overrides = {}) {
  return {
    id: 'app-uuid-step-back',
    legacy_id: 9961,
    shift_id: 'shift-uuid-step-back',
    status: 'passed',
    invite_group_id: 'group-uuid-step-back',
    venue_id: 'loft1',
    group_link: 'https://t.me/+step_back',
    candidate_report: false,
    mentor_report_received: true,
    mentor_report_at: '2026-09-05T12:00:00.000Z',
    mentor_reporter_telegram_user_id: 'mentor',
    mentor_decision: 'Стажировка пройдена',
    mentor_report_venue_id: 'loft1',
    mentor_report_venue: 'LOFT #1',
    mentor_report_loft: 'LOFT #1',
    mentor_report_hall: '',
    mentor_comment_for_trainee: 'old comment',
    mentor_comment_sent_at: '2026-09-05T12:05:00.000Z',
    mentor_comment_delivery_status: 'sent',
    mentor_comment_delivery_error: '',
    experience: 'experienced',
    trainee_telegram_user_id: '996100',
    trainee_telegram_chat_id: '996100',
    telegram_username: 'step_back_trainee',
    name: 'Step Back Trainee',
    ...overrides
  };
}

test('stepBackApplicationInPostgres rolls passed trainee back to feedback and voids mentor report', async () => {
  const pool = fakePool({
    currentVersion: 100,
    existingShifts: [{ ...stepBackShift }],
    existingApplications: [makeStepBackApp()],
    existingMentorReports: [{
      id: 'mentor-report-step-back',
      application_id: 'app-uuid-step-back',
      voided_at: null
    }]
  });
  const now = new Date('2026-07-29T19:00:00.000Z');
  const result = await stepBackApplicationInPostgres({
    pool,
    actor: recruiter,
    command: { action: 'step_back_application', baseVersion: 100, applicationId: 9961 },
    now
  });

  assert.equal(result.changed, true);
  assert.equal(result.applicationLegacyId, 9961);
  assert.equal(result.previousStatus, 'passed');
  assert.equal(result.nextStatus, 'feedback');
  assert.equal(result.shiftLegacyId, 9950);
  assert.equal(result.mentorReportVoided, true);
  assert.deepEqual(result.notifications, {
    total: 1,
    pending: 1,
    skipped: 0,
    inserted: 1
  });
  assert.equal(result.version, 101);

  const app = pool.getApplications()[0];
  assert.equal(app.status, 'feedback');
  assert.equal(app.mentor_report_received, false);
  assert.equal(app.mentor_report_at, null);
  assert.equal(app.mentor_decision, '');
  assert.equal(app.mentor_comment_delivery_status, null);
  assert.equal(app.experience, null);
  assert.equal(pool.getMentorReports()[0].voided_at, now.toISOString());

  const eventInsert = pool.calls.find(call => /INSERT INTO application_events/.test(call.sql));
  assert.equal(eventInsert.params[3], 'application_step_back');
  const payload = JSON.parse(eventInsert.params[6]);
  assert.equal(payload.action, 'step_back_application');
  assert.equal(payload.previousStatus, 'passed');
  assert.equal(payload.nextStatus, 'feedback');
  assert.equal(payload.previousShiftId, 9950);
  assert.equal(payload.nextShiftId, 9950);
  assert.equal(payload.mentorReportVoided, true);
  assert.equal(payload.legacyApplicationId, 9961);
  assert.equal(payload.legacyShiftId, 9950);

  const notification = pool.getNotifications()[0];
  assert.equal(notification.type, 'booking_stage_changed');
  assert.equal(notification.status, 'pending');
  assert.equal(notification.chat_id, '996100');
  assert.equal(notification.chat_target, 'trainee');
  assert.equal(notification.parse_mode, 'HTML');
  assert.match(notification.text, /Этап стажировки изменён/);
  assert.match(notification.text, /Стажировка пройдена/);
  assert.match(notification.text, /Ждем отчет/);
  assert.match(notification.idempotency_key, /^step_back_application:9961:/);
});

test('stepBackApplicationInPostgres rolls noshow back to invited without clearing mentor fields', async () => {
  const pool = fakePool({
    currentVersion: 100,
    existingShifts: [{ ...stepBackShift }],
    existingApplications: [
      makeStepBackApp({
        status: 'noshow',
        mentor_report_received: false,
        mentor_decision: '',
        mentor_comment_delivery_status: null,
        experience: null
      })
    ]
  });
  const result = await stepBackApplicationInPostgres({
    pool,
    actor: recruiter,
    command: { action: 'step_back_application', baseVersion: 100, applicationId: 9961 },
    now: new Date('2026-07-29T19:00:00.000Z')
  });

  assert.equal(result.previousStatus, 'noshow');
  assert.equal(result.nextStatus, 'invited');
  assert.equal(result.mentorReportVoided, false);
  assert.equal(pool.getApplications()[0].status, 'invited');
  assert.equal(pool.getApplications()[0].mentor_report_received, false);
  assert.equal(pool.getMentorReports().length, 0);
  assert.match(pool.getNotifications()[0].text, /Приглашение отправлено/);
});

test('stepBackApplicationInPostgres records skipped notification when trainee chat id is missing', async () => {
  const pool = fakePool({
    currentVersion: 100,
    existingShifts: [{ ...stepBackShift }],
    existingApplications: [
      makeStepBackApp({
        trainee_telegram_user_id: '',
        trainee_telegram_chat_id: ''
      })
    ]
  });
  const result = await stepBackApplicationInPostgres({
    pool,
    actor: recruiter,
    command: { action: 'step_back_application', baseVersion: 100, applicationId: 9961 },
    now: new Date('2026-07-29T19:00:00.000Z')
  });

  assert.deepEqual(result.notifications, {
    total: 1,
    pending: 0,
    skipped: 1,
    inserted: 1
  });
  assert.equal(pool.getNotifications()[0].status, 'skipped');
  assert.equal(pool.getNotifications()[0].chat_id, null);
  assert.equal(pool.getNotifications()[0].error, 'telegram_chat_missing');
});

test('stepBackApplicationInPostgres rolls back on stale baseVersion and rejects unsupported statuses', async () => {
  const stalePool = fakePool({
    currentVersion: 101,
    existingShifts: [{ ...stepBackShift }],
    existingApplications: [makeStepBackApp()]
  });
  await assert.rejects(
    () => stepBackApplicationInPostgres({
      pool: stalePool,
      actor: recruiter,
      command: { action: 'step_back_application', baseVersion: 100, applicationId: 9961 },
      now: new Date('2026-07-29T19:00:00.000Z')
    }),
    err => err instanceof PostgresCommandConflictError
  );
  assert.equal(stalePool.getApplications()[0].status, 'passed');
  assert.equal(stalePool.getNotifications().length, 0);

  for (const status of ['pending', 'queue', 'confirmed', 'invited']) {
    const pool = fakePool({
      currentVersion: 100,
      existingShifts: [{ ...stepBackShift }],
      existingApplications: [makeStepBackApp({ status })]
    });
    await assert.rejects(
      () => stepBackApplicationInPostgres({
        pool,
        actor: recruiter,
        command: { action: 'step_back_application', baseVersion: 100, applicationId: 9961 },
        now: new Date('2026-07-29T19:00:00.000Z')
      }),
      err => err instanceof PostgresCommandValidationError && /нельзя вернуть/.test(err.message),
      `expected reject for status=${status}`
    );
    assert.equal(pool.getApplications()[0].status, status);
    assert.equal(pool.getNotifications().length, 0);
  }
});

test('stepBackApplicationInPostgres rejects unknown application, invalid input and non-recruiter', async () => {
  const unknownPool = fakePool({ currentVersion: 100 });
  await assert.rejects(
    () => stepBackApplicationInPostgres({
      pool: unknownPool,
      actor: recruiter,
      command: { action: 'step_back_application', baseVersion: 100, applicationId: 999999 },
      now: new Date('2026-07-29T19:00:00.000Z')
    }),
    err => err instanceof PostgresCommandValidationError && /application not found/.test(err.message)
  );
  await assert.rejects(
    () => stepBackApplicationInPostgres({
      pool: unknownPool,
      actor: recruiter,
      command: { action: 'step_back_application', baseVersion: 100, applicationId: 0 },
      now: new Date('2026-07-29T19:00:00.000Z')
    }),
    /applicationId must be a positive integer/
  );
  await assert.rejects(
    () => stepBackApplicationInPostgres({
      pool: unknownPool,
      actor: recruiter,
      command: { action: 'step_back_application', baseVersion: 0, applicationId: 9961 },
      now: new Date('2026-07-29T19:00:00.000Z')
    }),
    /baseVersion is required/
  );
  await assert.rejects(
    () => stepBackApplicationInPostgres({
      pool: unknownPool,
      actor: { role: 'trainee', telegram: { user: { id: '5' } } },
      command: { action: 'step_back_application', baseVersion: 100, applicationId: 9961 },
      now: new Date('2026-07-29T19:00:00.000Z')
    }),
    err => err instanceof PostgresCommandAuthorizationError
  );
});

test('stepBackApplicationInPostgres rolls back when notification outbox insert fails', async () => {
  const pool = fakePool({
    currentVersion: 100,
    existingShifts: [{ ...stepBackShift }],
    existingApplications: [makeStepBackApp()],
    existingMentorReports: [{
      id: 'mentor-report-step-back',
      application_id: 'app-uuid-step-back',
      voided_at: null
    }],
    notificationInsertThrows: true
  });
  await assert.rejects(
    () => stepBackApplicationInPostgres({
      pool,
      actor: recruiter,
      command: { action: 'step_back_application', baseVersion: 100, applicationId: 9961 },
      now: new Date('2026-07-29T19:00:00.000Z')
    }),
    /notification insert failed/
  );
  const sqls = pool.calls.map(call => call.sql.trim());
  assert.ok(sqls.some(sql => /^ROLLBACK$/i.test(sql)));
  assert.equal(sqls.some(sql => /^COMMIT$/i.test(sql)), false);
  assert.equal(pool.getNotifications().length, 0);
});

// -----------------------------------------------------------------------------
// mark_experienced
// -----------------------------------------------------------------------------

const experiencedShift = {
  id: 'shift-uuid-experienced',
  legacy_id: 9970,
  date: '2026-09-06',
  seats: 2,
  open: false,
  canceled: false
};

function makeExperiencedApp(overrides = {}) {
  return {
    id: 'app-uuid-experienced',
    legacy_id: 9971,
    shift_id: 'shift-uuid-experienced',
    status: 'passed',
    experience: null,
    ...overrides
  };
}

test('markExperiencedInPostgres marks a passed trainee as experienced and writes an event', async () => {
  const pool = fakePool({
    currentVersion: 120,
    existingShifts: [{ ...experiencedShift }],
    existingApplications: [makeExperiencedApp()]
  });
  const now = new Date('2026-07-29T20:00:00.000Z');

  const result = await markExperiencedInPostgres({
    pool,
    actor: recruiter,
    command: { action: 'mark_experienced', baseVersion: 120, applicationId: 9971 },
    now
  });

  assert.equal(result.changed, true);
  assert.equal(result.applicationLegacyId, 9971);
  assert.equal(result.previousExperience, null);
  assert.equal(result.nextExperience, 'experienced');
  assert.equal(result.shiftLegacyId, 9970);
  assert.equal(result.previousVersion, 120);
  assert.equal(result.version, 121);
  assert.equal(result.updatedAt, now.toISOString());
  assert.equal(pool.getApplications()[0].experience, 'experienced');
  assert.equal(pool.getApplications()[0].updated_at, now.toISOString());
  assert.equal(pool.getVersion(), 121);

  const eventInsert = pool.calls.find(call => /INSERT INTO application_events/.test(call.sql));
  assert.equal(eventInsert.params[3], 'experienced_marked');
  assert.equal(eventInsert.params[4], 'recruiter');
  assert.equal(eventInsert.params[5], '111');
  const payload = JSON.parse(eventInsert.params[6]);
  assert.equal(payload.action, 'mark_experienced');
  assert.equal(payload.previousExperience, null);
  assert.equal(payload.nextExperience, 'experienced');
  assert.equal(payload.previousVersion, 120);
  assert.equal(payload.nextVersion, 121);
  assert.equal(payload.legacyApplicationId, 9971);
  assert.equal(payload.legacyShiftId, 9970);

  const sqls = pool.calls.map(call => call.sql);
  assert.ok(sqls.some(sql => /^COMMIT$/i.test(sql)));
  assert.ok(sqls.some(sql => /RELEASE/.test(sql)));
});

test('markExperiencedInPostgres is a no-op when trainee is already experienced', async () => {
  const pool = fakePool({
    currentVersion: 120,
    existingShifts: [{ ...experiencedShift }],
    existingApplications: [makeExperiencedApp({ experience: 'experienced' })]
  });

  const result = await markExperiencedInPostgres({
    pool,
    actor: recruiter,
    command: { action: 'mark_experienced', baseVersion: 120, applicationId: 9971 },
    now: new Date('2026-07-29T20:05:00.000Z')
  });

  assert.equal(result.changed, false);
  assert.equal(result.version, 120);
  assert.equal(result.previousVersion, 120);
  assert.equal(pool.getVersion(), 120);
  const sqls = pool.calls.map(call => call.sql);
  assert.equal(sqls.some(sql => /UPDATE applications\s+SET experience/i.test(sql)), false);
  assert.equal(sqls.some(sql => /INSERT INTO application_events/i.test(sql)), false);
  assert.ok(sqls.some(sql => /^COMMIT$/i.test(sql)));
});

test('markExperiencedInPostgres rejects stale version, unknown app, invalid input and non-passed status', async () => {
  const pool = fakePool({
    currentVersion: 120,
    existingShifts: [{ ...experiencedShift }],
    existingApplications: [makeExperiencedApp({ status: 'feedback' })]
  });

  await assert.rejects(
    () => markExperiencedInPostgres({
      pool,
      actor: recruiter,
      command: { action: 'mark_experienced', baseVersion: 119, applicationId: 9971 },
      now: new Date('2026-07-29T20:10:00.000Z')
    }),
    err => err instanceof PostgresCommandConflictError
  );

  await assert.rejects(
    () => markExperiencedInPostgres({
      pool,
      actor: recruiter,
      command: { action: 'mark_experienced', baseVersion: 120, applicationId: 999999 },
      now: new Date('2026-07-29T20:15:00.000Z')
    }),
    err => err instanceof PostgresCommandValidationError && /not found/.test(err.message)
  );

  await assert.rejects(
    () => markExperiencedInPostgres({
      pool,
      actor: recruiter,
      command: { action: 'mark_experienced', baseVersion: 120, applicationId: 0 },
      now: new Date('2026-07-29T20:20:00.000Z')
    }),
    err => err instanceof PostgresCommandValidationError && /applicationId/.test(err.message)
  );

  await assert.rejects(
    () => markExperiencedInPostgres({
      pool,
      actor: recruiter,
      command: { action: 'mark_experienced', baseVersion: 120, applicationId: 9971 },
      now: new Date('2026-07-29T20:25:00.000Z')
    }),
    err => err instanceof PostgresCommandValidationError && /прошёл стажировку/.test(err.message)
  );

  await assert.rejects(
    () => markExperiencedInPostgres({
      pool,
      actor: { role: 'trainee', telegram: { user: { id: '5' } } },
      command: { action: 'mark_experienced', baseVersion: 120, applicationId: 9971 },
      now: new Date('2026-07-29T20:30:00.000Z')
    }),
    err => err instanceof PostgresCommandAuthorizationError
  );
});

test('markExperiencedInPostgres rolls back when event insert fails', async () => {
  const pool = fakePool({
    currentVersion: 120,
    eventInsertThrows: true,
    existingShifts: [{ ...experiencedShift }],
    existingApplications: [makeExperiencedApp()]
  });

  await assert.rejects(
    () => markExperiencedInPostgres({
      pool,
      actor: recruiter,
      command: { action: 'mark_experienced', baseVersion: 120, applicationId: 9971 },
      now: new Date('2026-07-29T20:35:00.000Z')
    }),
    /event insert failed/
  );

  const sqls = pool.calls.map(call => call.sql);
  assert.ok(sqls.some(sql => /^ROLLBACK$/i.test(sql)));
  assert.ok(sqls.some(sql => /RELEASE/.test(sql)));
  assert.equal(sqls.some(sql => /^COMMIT$/i.test(sql)), false);
  assert.equal(pool.getVersion(), 120);
});
