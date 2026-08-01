import assert from 'node:assert/strict';
import test from 'node:test';
import {
  BOOKING_STATUSES,
  bookingStatusFromMentorDecision,
  canRecruiterSetApplicationStatus,
  normalizeBookingStatus,
  previousBookingStatus
} from '../src/booking-state-machine.js';

test('booking state machine lists every supported application status', () => {
  assert.deepEqual(
    [...BOOKING_STATUSES],
    ['pending', 'queue', 'confirmed', 'invited', 'feedback', 'passed', 'failed', 'noshow']
  );
});

test('booking state machine preserves legacy status aliases', () => {
  assert.equal(normalizeBookingStatus('new'), 'pending');
  assert.equal(normalizeBookingStatus('waiting'), 'invited');
  assert.equal(normalizeBookingStatus('report'), 'feedback');
});

test('recruiter status transitions match the current UI actions', () => {
  const allowed = [
    ['pending', 'confirmed'],
    ['confirmed', 'pending'],
    ['invited', 'pending'],
    ['invited', 'feedback'],
    ['invited', 'noshow'],
    ['feedback', 'pending']
  ];
  const forbidden = [
    ['pending', 'passed'],
    ['confirmed', 'feedback'],
    ['invited', 'passed'],
    ['feedback', 'passed'],
    ['passed', 'pending'],
    ['failed', 'passed'],
    ['noshow', 'feedback']
  ];

  for (const [current, next] of allowed) {
    assert.equal(canRecruiterSetApplicationStatus(current, next), true, `${current} -> ${next}`);
  }
  for (const [current, next] of forbidden) {
    assert.equal(canRecruiterSetApplicationStatus(current, next), false, `${current} -> ${next}`);
  }
});

test('step-back rules are explicit and separate from ordinary recruiter transitions', () => {
  assert.equal(previousBookingStatus('feedback'), 'invited');
  assert.equal(previousBookingStatus('passed'), 'feedback');
  assert.equal(previousBookingStatus('failed'), 'feedback');
  assert.equal(previousBookingStatus('noshow'), 'invited');
  assert.equal(previousBookingStatus('confirmed'), '');
});

test('mentor decisions map only to final report statuses', () => {
  assert.equal(bookingStatusFromMentorDecision('Стажировка пройдена'), 'passed');
  assert.equal(bookingStatusFromMentorDecision('Требуется повторная стажировка'), 'failed');
  assert.equal(bookingStatusFromMentorDecision('', 'feedback'), 'feedback');
});
