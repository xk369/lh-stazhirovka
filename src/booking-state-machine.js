const STATUS_VALUES = [
  'pending',
  'queue',
  'queue_expired',
  'confirmed',
  'invited',
  'feedback',
  'passed',
  'failed',
  'noshow'
];

export const BOOKING_STATUSES = new Set(STATUS_VALUES);
export const TRAINEE_WRITE_STATUSES = new Set(['queue']);
export const MENTOR_REPORT_TRAINEE_STATUSES = new Set(['invited', 'feedback']);
export const ACTIVE_TRAINEE_APPLICATION_STATUSES = new Set([
  'pending',
  'queue',
  'confirmed',
  'invited',
  'feedback'
]);
export const TRAINEE_REAPPLY_SOURCE_STATUSES = new Set(['failed', 'noshow']);
export const TRAINEE_QUEUE_REJOIN_SOURCE_STATUSES = new Set(['queue_expired']);
export const SEAT_HOLDING_STATUSES = new Set([
  'pending',
  'confirmed',
  'invited',
  'feedback',
  'passed',
  'failed',
  'noshow'
]);
export const FINAL_BOOKING_STATUSES = new Set(['passed', 'failed', 'noshow']);
export const SHIFT_CANCELLATION_APPLICATION_STATUSES = new Set([
  'pending',
  'confirmed',
  'invited'
]);

export const BOOKING_STATUS_LABELS = Object.freeze({
  pending: 'Заявка отправлена',
  queue: 'Очередь',
  queue_expired: 'Запрос истёк',
  confirmed: 'Выход подтвержден',
  invited: 'Приглашение отправлено',
  feedback: 'Ждем отчет',
  passed: 'Стажировка пройдена',
  failed: 'Нужна повторная запись',
  noshow: 'Выход не состоялся'
});

export const BOOKING_STEP_BACK_STATUSES = Object.freeze({
  feedback: 'invited',
  passed: 'feedback',
  failed: 'feedback',
  noshow: 'invited'
});

const RECRUITER_STATUS_TRANSITIONS = Object.freeze({
  pending: new Set(['confirmed']),
  confirmed: new Set(['pending']),
  invited: new Set(['pending', 'feedback', 'noshow']),
  feedback: new Set(['pending'])
});

const LEGACY_STATUS_MAP = Object.freeze({
  new: 'pending',
  waiting: 'invited',
  report: 'feedback'
});

export function normalizeBookingStatus(status) {
  const cleanStatus = String(status || '').trim();
  return LEGACY_STATUS_MAP[cleanStatus] || cleanStatus || 'pending';
}

export function canRecruiterSetApplicationStatus(currentStatus, nextStatus) {
  const current = normalizeBookingStatus(currentStatus);
  const next = normalizeBookingStatus(nextStatus);
  return Boolean(RECRUITER_STATUS_TRANSITIONS[current]?.has(next));
}

export function previousBookingStatus(currentStatus) {
  return BOOKING_STEP_BACK_STATUSES[normalizeBookingStatus(currentStatus)] || '';
}

export function bookingStatusFromMentorDecision(decision, fallbackStatus = 'feedback') {
  const cleanDecision = String(decision || '').trim();
  if (cleanDecision === 'Стажировка пройдена') return 'passed';
  if (cleanDecision === 'Требуется повторная стажировка') return 'failed';
  return normalizeBookingStatus(fallbackStatus);
}
