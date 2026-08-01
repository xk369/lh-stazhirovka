import { normalizeBookingState } from './booking-state.js';
import { normalizeBookingStatus } from './booking-state-machine.js';

const PROFILE_FIELDS = [
  'name',
  'phone',
  'training',
  'trainingDate',
  'attempt',
  'limits',
  'telegramCode',
  'telegramChatId',
  'telegramUserId',
  'telegramUsername'
];

const MENTOR_NOTIFICATION_EVENTS = Object.freeze({
  sent: 'mentor_result_notification_sent',
  skipped: 'mentor_result_notification_skipped',
  failed: 'mentor_result_notification_failed'
});

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

function applicationCompletesShift(application) {
  const status = normalizeBookingStatus(application?.status);
  if (status === 'noshow') return true;
  if (['passed', 'failed'].includes(status)) return Boolean(application?.mentorReport);
  return false;
}

function shouldTreatShiftCloseAsAutomatic(state, shiftId, action) {
  if (!['mentor_report_result', 'set_application_status'].includes(action)) return false;
  const applications = state.applications.filter(application => String(application.shiftId) === String(shiftId));
  return applications.length > 0 && applications.every(applicationCompletesShift);
}

function statusTransitionEventType(previousStatus, nextStatus, nextApplication, action) {
  if (previousStatus === nextStatus) return '';
  if (
    ['cancel_shift', 'cancel_internship'].includes(action)
    && nextStatus === 'queue'
    && !nextApplication?.shiftId
  ) {
    return 'internship_cancelled';
  }
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

function traineeReportWasReceived(previousApplication, nextApplication) {
  return !previousApplication?.candidateReport && Boolean(nextApplication?.candidateReport);
}

function mentorNotificationEventType(previousApplication, nextApplication) {
  const previousStatus = String(previousApplication?.mentorCommentDeliveryStatus || '').trim();
  const nextStatus = String(nextApplication?.mentorCommentDeliveryStatus || '').trim();
  if (!nextStatus || previousStatus === nextStatus) return '';
  return MENTOR_NOTIFICATION_EVENTS[nextStatus] || 'mentor_result_notification_updated';
}

function changedFields(previousApplication, nextApplication, fields) {
  return fields.filter(field => (
    String(previousApplication?.[field] ?? '') !== String(nextApplication?.[field] ?? '')
  ));
}

function memberIdSet(group) {
  return new Set((Array.isArray(group?.memberIds) ? group.memberIds : []).map(id => String(id)));
}

function memberIdsDelta(previousGroup, nextGroup) {
  const before = memberIdSet(previousGroup);
  const after = memberIdSet(nextGroup);
  return {
    addedMemberIds: [...after].filter(id => !before.has(id)).map(Number),
    removedMemberIds: [...before].filter(id => !after.has(id)).map(Number)
  };
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
  const causeAction = causePayload.action || '';
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
      const eventType = !shift.open && shouldTreatShiftCloseAsAutomatic(after, shift.id, causeAction)
        ? 'shift_auto_closed'
        : (shift.open ? 'shift_opened' : 'shift_closed');
      events.push(shiftEvent(eventType, shift, actor, {
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
    const previous = beforeInviteGroups.get(String(group.id));
    if (previous) {
      const membersDelta = memberIdsDelta(previous, group);
      const groupFieldsChanged = previous.venueId !== group.venueId || previous.link !== group.link;
      if (
        groupFieldsChanged
        || membersDelta.addedMemberIds.length
        || membersDelta.removedMemberIds.length
      ) {
        events.push(shiftEvent('invite_group_updated', afterShifts.get(String(group.shiftId)) || null, actor, {
          ...causePayload,
          inviteGroupId: group.id,
          venueId: group.venueId,
          addedMemberIds: membersDelta.addedMemberIds,
          removedMemberIds: membersDelta.removedMemberIds
        }, now));
      }
      continue;
    }
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
        statusTransitionEventType(previousStatus, nextStatus, application, causeAction),
        application,
        actor,
        {
          ...causePayload,
          previousStatus,
          nextStatus,
          previousShiftId: previous.shiftId ?? null,
          nextShiftId: application.shiftId ?? null
        },
        now
      ));
    }

    const profileChanges = changedFields(previous, application, PROFILE_FIELDS);
    if (profileChanges.length) {
      events.push(applicationEvent('application_updated', application, actor, {
        ...causePayload,
        changedFields: profileChanges
      }, now));
    }

    if (previous.shiftId !== application.shiftId && application.shiftId) {
      events.push(applicationEvent('application_assigned_to_shift', application, actor, {
        ...causePayload,
        previousShiftId: previous.shiftId ?? null,
        nextShiftId: application.shiftId
      }, now));
    }

    if (previous.comment !== application.comment) {
      events.push(applicationEvent('application_comment_updated', application, actor, {
        ...causePayload,
        previousLength: String(previous.comment || '').length,
        nextLength: String(application.comment || '').length
      }, now));
    }

    if (traineeReportWasReceived(previous, application)) {
      events.push(applicationEvent('trainee_report_received', application, actor, {
        ...causePayload
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

    const notificationEventType = mentorNotificationEventType(previous, application);
    if (notificationEventType) {
      events.push(applicationEvent(notificationEventType, application, actor, {
        ...causePayload,
        deliveryStatus: application.mentorCommentDeliveryStatus || '',
        hasDeliveryError: Boolean(application.mentorCommentDeliveryError)
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
