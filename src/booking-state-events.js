import { normalizeBookingState } from './booking-state.js';
import { normalizeBookingStatus } from './booking-state-machine.js';

function indexedById(items) {
  return new Map(items.map(item => [String(item.id), item]));
}

function actorType(actor) {
  const role = String(actor?.role || '').trim();
  return ['trainee', 'recruiter', 'mentor', 'system', 'migration'].includes(role)
    ? role
    : 'system';
}

function actorTelegramUserId(actor) {
  return String(actor?.telegram?.user?.id || actor?.userId || '').trim() || null;
}

function eventBase({ type, applicationId = null, shiftId = null, actor, payload = {}, now }) {
  return {
    eventType: type,
    applicationId,
    shiftId,
    actorType: actorType(actor),
    actorTelegramUserId: actorTelegramUserId(actor),
    payload,
    createdAt: now.toISOString()
  };
}

function applicationEvent(type, application, actor, payload, now) {
  return eventBase({
    type,
    applicationId: application?.id ?? null,
    shiftId: application?.shiftId ?? null,
    actor,
    payload,
    now
  });
}

function shiftEvent(type, shift, actor, payload, now) {
  return eventBase({
    type,
    shiftId: shift?.id ?? null,
    actor,
    payload,
    now
  });
}

function statusTransitionEventType(previousStatus, nextStatus, nextApplication) {
  if (previousStatus === nextStatus) return '';
  if (
    ['feedback', 'passed', 'failed', 'noshow'].includes(previousStatus)
    && ['invited', 'feedback'].includes(nextStatus)
  ) {
    return 'application_step_back';
  }
  if (previousStatus === 'pending' && nextStatus === 'confirmed') return 'recruiter_confirmed';
  if (previousStatus === 'confirmed' && nextStatus === 'invited') return 'application_invited';
  if (nextStatus === 'feedback') return 'attendance_marked_feedback';
  if (nextStatus === 'noshow') return 'attendance_marked_noshow';
  if (nextStatus === 'passed') return 'application_passed';
  if (nextStatus === 'failed') return 'application_failed';
  if (!nextApplication?.shiftId && nextStatus === 'queue') return 'application_returned_to_queue';
  return 'application_status_changed';
}

function mentorReportWasReceived(previousApplication, nextApplication) {
  return !previousApplication?.mentorReport && Boolean(nextApplication?.mentorReport);
}

function compactApplicationPayload(application) {
  return {
    status: normalizeBookingStatus(application?.status),
    shiftId: application?.shiftId ?? null,
    inviteGroupId: application?.inviteGroupId ?? null,
    venueId: application?.venueId || '',
    telegramUserId: application?.telegramUserId || '',
    telegramUsername: application?.telegramUsername || ''
  };
}

export function planBookingStateEvents({
  currentState,
  nextState,
  actor = null,
  cause = {},
  now = new Date()
}) {
  const before = normalizeBookingState(currentState);
  const after = normalizeBookingState(nextState);
  const causePayload = {
    action: String(cause?.action || '').trim() || undefined,
    baseVersion: cause?.baseVersion ?? undefined,
    previousVersion: before.version,
    nextVersion: after.version
  };
  const events = [];
  const beforeShifts = indexedById(before.shifts);
  const afterShifts = indexedById(after.shifts);
  const beforeApplications = indexedById(before.applications);
  const afterApplications = indexedById(after.applications);
  const beforeInviteGroups = indexedById(before.inviteGroups);
  const afterInviteGroups = indexedById(after.inviteGroups);

  for (const shift of after.shifts) {
    const previous = beforeShifts.get(String(shift.id));
    if (!previous) {
      events.push(shiftEvent('shift_created', shift, actor, {
        ...causePayload,
        date: shift.date,
        seats: shift.seats
      }, now));
      continue;
    }
    if (Number(previous.seats) !== Number(shift.seats)) {
      events.push(shiftEvent('shift_capacity_changed', shift, actor, {
        ...causePayload,
        previousSeats: previous.seats,
        nextSeats: shift.seats,
        date: shift.date
      }, now));
    }
    if (!previous.canceled && shift.canceled) {
      events.push(shiftEvent('shift_cancelled', shift, actor, {
        ...causePayload,
        date: shift.date
      }, now));
    } else if (previous.open !== shift.open) {
      events.push(shiftEvent(shift.open ? 'shift_opened' : 'shift_closed', shift, actor, {
        ...causePayload,
        date: shift.date
      }, now));
    }
  }

  for (const [shiftId, shift] of beforeShifts) {
    if (!afterShifts.has(shiftId)) {
      events.push(shiftEvent('shift_deleted', shift, actor, {
        ...causePayload,
        date: shift.date
      }, now));
    }
  }

  for (const group of after.inviteGroups) {
    if (beforeInviteGroups.has(String(group.id))) continue;
    events.push(shiftEvent('invite_group_sent', afterShifts.get(String(group.shiftId)) || null, actor, {
      ...causePayload,
      inviteGroupId: group.id,
      venueId: group.venueId,
      memberIds: group.memberIds
    }, now));
  }

  for (const [groupId, group] of beforeInviteGroups) {
    if (!afterInviteGroups.has(groupId)) {
      events.push(shiftEvent('invite_group_removed', beforeShifts.get(String(group.shiftId)) || null, actor, {
        ...causePayload,
        inviteGroupId: group.id,
        memberIds: group.memberIds
      }, now));
    }
  }

  for (const application of after.applications) {
    const previous = beforeApplications.get(String(application.id));
    if (!previous) {
      events.push(applicationEvent('application_created', application, actor, {
        ...causePayload,
        application: compactApplicationPayload(application)
      }, now));
      continue;
    }

    const previousStatus = normalizeBookingStatus(previous.status);
    const nextStatus = normalizeBookingStatus(application.status);
    if (previousStatus !== nextStatus) {
      events.push(applicationEvent(
        statusTransitionEventType(previousStatus, nextStatus, application),
        application,
        actor,
        {
          ...causePayload,
          previousStatus,
          nextStatus
        },
        now
      ));
    }

    if (previous.shiftId !== application.shiftId && application.shiftId) {
      events.push(applicationEvent('application_assigned_to_shift', application, actor, {
        ...causePayload,
        previousShiftId: previous.shiftId ?? null,
        nextShiftId: application.shiftId
      }, now));
    }

    if (!previous.experience && application.experience === 'experienced') {
      events.push(applicationEvent('experienced_marked', application, actor, {
        ...causePayload
      }, now));
    }

    if (mentorReportWasReceived(previous, application)) {
      events.push(applicationEvent('mentor_report_received', application, actor, {
        ...causePayload,
        mentorDecision: application.mentorDecision || '',
        mentorReportVenueId: application.mentorReportVenueId || '',
        mentorReportHall: application.mentorReportHall || '',
        mentorMessageStatus: application.mentorCommentDeliveryStatus || ''
      }, now));
    }
  }

  for (const [applicationId, application] of beforeApplications) {
    if (!afterApplications.has(applicationId)) {
      events.push(applicationEvent('application_cancelled', application, actor, {
        ...causePayload,
        application: compactApplicationPayload(application)
      }, now));
    }
  }

  if (causePayload.action === 'clear_state') {
    events.push(eventBase({
      type: 'booking_state_cleared',
      actor,
      payload: {
        ...causePayload,
        removedShifts: before.shifts.length,
        removedApplications: before.applications.length,
        removedInviteGroups: before.inviteGroups.length
      },
      now
    }));
  }

  if (causePayload.action === 'reset_demo_state') {
    events.push(eventBase({
      type: 'booking_state_reset',
      actor,
      payload: {
        ...causePayload,
        shifts: after.shifts.length,
        applications: after.applications.length,
        inviteGroups: after.inviteGroups.length
      },
      now
    }));
  }

  return events;
}
