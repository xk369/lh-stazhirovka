export function traineeNotificationsSuppressed(env = process.env) {
  return String(env.SUPPRESS_TRAINEE_NOTIFICATIONS || '').trim().toLowerCase() === 'yes';
}

export function suppressedTraineeNotification(
  applicationId,
  reason = 'trainee_notifications_suppressed'
) {
  return {
    ok: false,
    status: 'skipped',
    skipped: reason,
    applicationId
  };
}
