const COMMAND_SOURCES = Object.freeze({
  API_STATE: 'api_state',
  API_REPORT: 'api_report'
});

const WRITE_TABLES = Object.freeze({
  STATE_META: 'booking_state_meta',
  SHIFTS: 'shifts',
  APPLICATIONS: 'applications',
  INVITE_GROUPS: 'invite_groups',
  INVITE_GROUP_MEMBERS: 'invite_group_members',
  MENTOR_REPORTS: 'mentor_reports',
  MENTOR_REPORT_TOPICS: 'mentor_report_topics',
  NOTIFICATIONS: 'notifications',
  APPLICATION_EVENTS: 'application_events'
});

const LOCK_SCOPES = Object.freeze({
  STATE_META: 'booking_state_meta',
  SHIFT: 'shift_row',
  APPLICATION: 'application_row',
  INVITE_GROUP: 'invite_group_row',
  MENTOR_REPORT: 'mentor_report_unique_application'
});

function contract({
  action,
  source = COMMAND_SOURCES.API_STATE,
  actorRoles,
  writes,
  locks,
  eventTypes,
  requiresBaseVersion = source === COMMAND_SOURCES.API_STATE,
  returnsFreshState = true,
  requiresOutbox = false,
  idempotencyKey = '',
  risk = 'normal'
}) {
  return Object.freeze({
    action,
    source,
    actorRoles: Object.freeze([...actorRoles]),
    writes: Object.freeze([...writes]),
    locks: Object.freeze([...locks]),
    eventTypes: Object.freeze([...eventTypes]),
    requiresBaseVersion,
    returnsFreshState,
    requiresOutbox,
    idempotencyKey,
    risk
  });
}

const stateMetaAndEvents = [
  WRITE_TABLES.STATE_META,
  WRITE_TABLES.APPLICATION_EVENTS
];

export const BOOKING_WRITE_COMMAND_CONTRACTS = Object.freeze({
  upsert_trainee_application: contract({
    action: 'upsert_trainee_application',
    actorRoles: ['trainee'],
    writes: [...stateMetaAndEvents, WRITE_TABLES.APPLICATIONS],
    locks: [LOCK_SCOPES.STATE_META, LOCK_SCOPES.SHIFT, LOCK_SCOPES.APPLICATION],
    eventTypes: [
      'application_created',
      'application_updated',
      'application_status_changed',
      'application_assigned_to_shift',
      'application_returned_to_queue'
    ]
  }),

  cancel_application: contract({
    action: 'cancel_application',
    actorRoles: ['trainee', 'recruiter'],
    writes: [...stateMetaAndEvents, WRITE_TABLES.APPLICATIONS],
    locks: [LOCK_SCOPES.STATE_META, LOCK_SCOPES.APPLICATION],
    eventTypes: ['application_cancelled']
  }),

  set_application_status: contract({
    action: 'set_application_status',
    actorRoles: ['recruiter'],
    writes: [...stateMetaAndEvents, WRITE_TABLES.APPLICATIONS, WRITE_TABLES.SHIFTS],
    locks: [LOCK_SCOPES.STATE_META, LOCK_SCOPES.APPLICATION, LOCK_SCOPES.SHIFT],
    eventTypes: [
      'recruiter_confirmed',
      'attendance_marked_feedback',
      'attendance_marked_noshow',
      'application_passed',
      'application_failed',
      'shift_auto_closed'
    ]
  }),

  step_back_application: contract({
    action: 'step_back_application',
    actorRoles: ['recruiter'],
    writes: [
      ...stateMetaAndEvents,
      WRITE_TABLES.APPLICATIONS,
      WRITE_TABLES.MENTOR_REPORTS,
      WRITE_TABLES.NOTIFICATIONS
    ],
    locks: [LOCK_SCOPES.STATE_META, LOCK_SCOPES.APPLICATION, LOCK_SCOPES.MENTOR_REPORT],
    eventTypes: ['application_step_back'],
    requiresOutbox: true,
    idempotencyKey: 'application_id + previous_status + next_status'
  }),

  mark_experienced: contract({
    action: 'mark_experienced',
    actorRoles: ['recruiter'],
    writes: [...stateMetaAndEvents, WRITE_TABLES.APPLICATIONS],
    locks: [LOCK_SCOPES.STATE_META, LOCK_SCOPES.APPLICATION],
    eventTypes: ['experienced_marked']
  }),

  return_to_queue: contract({
    action: 'return_to_queue',
    actorRoles: ['recruiter'],
    writes: [
      ...stateMetaAndEvents,
      WRITE_TABLES.APPLICATIONS,
      WRITE_TABLES.INVITE_GROUPS,
      WRITE_TABLES.INVITE_GROUP_MEMBERS
    ],
    locks: [LOCK_SCOPES.STATE_META, LOCK_SCOPES.APPLICATION, LOCK_SCOPES.INVITE_GROUP],
    eventTypes: ['application_returned_to_queue', 'invite_group_updated', 'invite_group_removed']
  }),

  assign_shift: contract({
    action: 'assign_shift',
    actorRoles: ['recruiter'],
    writes: [...stateMetaAndEvents, WRITE_TABLES.APPLICATIONS],
    locks: [LOCK_SCOPES.STATE_META, LOCK_SCOPES.SHIFT, LOCK_SCOPES.APPLICATION],
    eventTypes: ['application_assigned_to_shift', 'application_status_changed']
  }),

  cancel_shift: contract({
    action: 'cancel_shift',
    actorRoles: ['recruiter'],
    writes: [
      ...stateMetaAndEvents,
      WRITE_TABLES.SHIFTS,
      WRITE_TABLES.APPLICATIONS,
      WRITE_TABLES.INVITE_GROUPS,
      WRITE_TABLES.INVITE_GROUP_MEMBERS,
      WRITE_TABLES.NOTIFICATIONS
    ],
    locks: [LOCK_SCOPES.STATE_META, LOCK_SCOPES.SHIFT, LOCK_SCOPES.APPLICATION, LOCK_SCOPES.INVITE_GROUP],
    eventTypes: ['shift_cancelled', 'internship_cancelled', 'invite_group_updated', 'invite_group_removed'],
    requiresOutbox: true,
    idempotencyKey: 'shift_id + cancellation'
  }),

  cancel_internship: contract({
    action: 'cancel_internship',
    actorRoles: ['recruiter'],
    writes: [
      ...stateMetaAndEvents,
      WRITE_TABLES.APPLICATIONS,
      WRITE_TABLES.INVITE_GROUPS,
      WRITE_TABLES.INVITE_GROUP_MEMBERS,
      WRITE_TABLES.NOTIFICATIONS
    ],
    locks: [LOCK_SCOPES.STATE_META, LOCK_SCOPES.APPLICATION, LOCK_SCOPES.INVITE_GROUP],
    eventTypes: ['internship_cancelled', 'invite_group_updated', 'invite_group_removed'],
    requiresOutbox: true,
    idempotencyKey: 'application_id + internship_cancellation'
  }),

  toggle_shift: contract({
    action: 'toggle_shift',
    actorRoles: ['recruiter'],
    writes: [...stateMetaAndEvents, WRITE_TABLES.SHIFTS],
    locks: [LOCK_SCOPES.STATE_META, LOCK_SCOPES.SHIFT],
    eventTypes: ['shift_opened', 'shift_closed']
  }),

  create_shift: contract({
    action: 'create_shift',
    actorRoles: ['recruiter'],
    writes: [...stateMetaAndEvents, WRITE_TABLES.SHIFTS],
    locks: [LOCK_SCOPES.STATE_META],
    eventTypes: ['shift_created'],
    idempotencyKey: 'shift_date'
  }),

  update_shift_capacity: contract({
    action: 'update_shift_capacity',
    actorRoles: ['recruiter'],
    writes: [...stateMetaAndEvents, WRITE_TABLES.SHIFTS, WRITE_TABLES.NOTIFICATIONS],
    locks: [LOCK_SCOPES.STATE_META, LOCK_SCOPES.SHIFT],
    eventTypes: ['shift_capacity_changed'],
    requiresOutbox: true,
    idempotencyKey: 'shift_id + next_seats'
  }),

  update_comment: contract({
    action: 'update_comment',
    actorRoles: ['recruiter'],
    writes: [...stateMetaAndEvents, WRITE_TABLES.APPLICATIONS],
    locks: [LOCK_SCOPES.STATE_META, LOCK_SCOPES.APPLICATION],
    eventTypes: ['application_comment_updated']
  }),

  send_invites: contract({
    action: 'send_invites',
    actorRoles: ['recruiter'],
    writes: [
      ...stateMetaAndEvents,
      WRITE_TABLES.APPLICATIONS,
      WRITE_TABLES.INVITE_GROUPS,
      WRITE_TABLES.INVITE_GROUP_MEMBERS,
      WRITE_TABLES.NOTIFICATIONS
    ],
    locks: [LOCK_SCOPES.STATE_META, LOCK_SCOPES.SHIFT, LOCK_SCOPES.APPLICATION],
    eventTypes: ['invite_group_sent', 'application_invited'],
    requiresOutbox: true,
    idempotencyKey: 'shift_id + venue_id + link + sorted_member_ids'
  }),

  clear_state: contract({
    action: 'clear_state',
    actorRoles: ['recruiter'],
    writes: [
      ...stateMetaAndEvents,
      WRITE_TABLES.SHIFTS,
      WRITE_TABLES.APPLICATIONS,
      WRITE_TABLES.INVITE_GROUPS,
      WRITE_TABLES.INVITE_GROUP_MEMBERS
    ],
    locks: [LOCK_SCOPES.STATE_META],
    eventTypes: ['booking_state_cleared'],
    risk: 'destructive'
  }),

  reset_demo_state: contract({
    action: 'reset_demo_state',
    actorRoles: ['recruiter'],
    writes: [
      ...stateMetaAndEvents,
      WRITE_TABLES.SHIFTS,
      WRITE_TABLES.APPLICATIONS,
      WRITE_TABLES.INVITE_GROUPS,
      WRITE_TABLES.INVITE_GROUP_MEMBERS
    ],
    locks: [LOCK_SCOPES.STATE_META],
    eventTypes: ['booking_state_reset'],
    risk: 'destructive'
  }),

  mentor_report_result: contract({
    action: 'mentor_report_result',
    source: COMMAND_SOURCES.API_REPORT,
    actorRoles: ['mentor'],
    writes: [
      ...stateMetaAndEvents,
      WRITE_TABLES.APPLICATIONS,
      WRITE_TABLES.SHIFTS,
      WRITE_TABLES.MENTOR_REPORTS,
      WRITE_TABLES.MENTOR_REPORT_TOPICS,
      WRITE_TABLES.NOTIFICATIONS
    ],
    locks: [LOCK_SCOPES.STATE_META, LOCK_SCOPES.APPLICATION, LOCK_SCOPES.MENTOR_REPORT, LOCK_SCOPES.SHIFT],
    eventTypes: [
      'mentor_report_received',
      'application_passed',
      'application_failed',
      'mentor_result_notification_sent',
      'mentor_result_notification_skipped',
      'mentor_result_notification_failed',
      'shift_auto_closed'
    ],
    requiresBaseVersion: false,
    requiresOutbox: true,
    idempotencyKey: 'application_id + mentor_report',
    risk: 'high'
  }),

  trainee_report_submission: contract({
    action: 'trainee_report_submission',
    source: COMMAND_SOURCES.API_REPORT,
    actorRoles: ['trainee'],
    writes: [WRITE_TABLES.NOTIFICATIONS],
    locks: [],
    eventTypes: ['trainee_report_received'],
    requiresBaseVersion: false,
    returnsFreshState: false,
    requiresOutbox: true,
    idempotencyKey: 'telegram_user_id + report_date + report_checksum'
  })
});

export function bookingWriteCommandContract(action) {
  return BOOKING_WRITE_COMMAND_CONTRACTS[String(action || '').trim()] || null;
}

export function bookingWriteCommandActions({ source } = {}) {
  return Object.values(BOOKING_WRITE_COMMAND_CONTRACTS)
    .filter(item => !source || item.source === source)
    .map(item => item.action)
    .sort((left, right) => left.localeCompare(right));
}

export function assertBookingWriteCommandContracts() {
  for (const contractItem of Object.values(BOOKING_WRITE_COMMAND_CONTRACTS)) {
    if (!contractItem.action) throw new Error('Booking write command contract action is required.');
    if (!contractItem.actorRoles.length) {
      throw new Error(`${contractItem.action} must declare actor roles.`);
    }
    if (contractItem.source === COMMAND_SOURCES.API_STATE && !contractItem.requiresBaseVersion) {
      throw new Error(`${contractItem.action} must require baseVersion.`);
    }
    if (contractItem.returnsFreshState && !contractItem.writes.includes(WRITE_TABLES.STATE_META)) {
      throw new Error(`${contractItem.action} must write booking_state_meta.`);
    }
    if (!contractItem.eventTypes.length) {
      throw new Error(`${contractItem.action} must declare audit event types.`);
    }
    if (contractItem.requiresOutbox && !contractItem.writes.includes(WRITE_TABLES.NOTIFICATIONS)) {
      throw new Error(`${contractItem.action} requires outbox but does not write notifications.`);
    }
    if (contractItem.requiresOutbox && !contractItem.idempotencyKey) {
      throw new Error(`${contractItem.action} requires outbox idempotency.`);
    }
    if (contractItem.risk === 'destructive' && !contractItem.eventTypes.some(type => type.includes('state'))) {
      throw new Error(`${contractItem.action} destructive command must declare state audit event.`);
    }
  }
  return true;
}

export { COMMAND_SOURCES, LOCK_SCOPES, WRITE_TABLES };
