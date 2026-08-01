import assert from 'node:assert/strict';
import test from 'node:test';
import {
  suppressedTraineeNotification,
  traineeNotificationsSuppressed
} from '../src/notification-policy.js';

test('trainee notification suppression is opt-in and exact', () => {
  assert.equal(traineeNotificationsSuppressed({}), false);
  assert.equal(traineeNotificationsSuppressed({ SUPPRESS_TRAINEE_NOTIFICATIONS: 'no' }), false);
  assert.equal(traineeNotificationsSuppressed({ SUPPRESS_TRAINEE_NOTIFICATIONS: 'yes' }), true);
  assert.equal(traineeNotificationsSuppressed({ SUPPRESS_TRAINEE_NOTIFICATIONS: ' YES ' }), true);
});

test('suppressed trainee notification is reported as skipped', () => {
  assert.deepEqual(suppressedTraineeNotification(123), {
    ok: false,
    status: 'skipped',
    skipped: 'trainee_notifications_suppressed',
    applicationId: 123
  });
});
