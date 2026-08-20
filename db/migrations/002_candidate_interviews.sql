CREATE TABLE candidate_profiles (
  id uuid PRIMARY KEY,
  telegram_user_id text UNIQUE,
  telegram_chat_id text,
  telegram_username text NOT NULL DEFAULT '',
  full_name text NOT NULL DEFAULT '',
  phone text NOT NULL DEFAULT '',
  source text NOT NULL DEFAULT '',
  current_stage text NOT NULL DEFAULT 'candidate_created' CHECK (
    current_stage IN (
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
      'closed_not_interested',
      'internship_pending',
      'internship_queue',
      'internship_queue_expired',
      'internship_confirmed',
      'internship_invited',
      'internship_feedback',
      'internship_passed',
      'internship_failed',
      'internship_noshow'
    )
  ),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX candidate_profiles_telegram_username_lower_idx
  ON candidate_profiles(lower(telegram_username))
  WHERE telegram_username <> '';
CREATE INDEX candidate_profiles_phone_idx
  ON candidate_profiles(phone)
  WHERE phone <> '';
CREATE INDEX candidate_profiles_full_name_lower_idx
  ON candidate_profiles(lower(full_name));
CREATE INDEX candidate_profiles_current_stage_idx
  ON candidate_profiles(current_stage);

ALTER TABLE applications
  ADD COLUMN candidate_profile_id uuid REFERENCES candidate_profiles(id) ON DELETE SET NULL;

ALTER TABLE applications
  ADD COLUMN queue_joined_at timestamptz;

CREATE INDEX applications_candidate_profile_id_idx
  ON applications(candidate_profile_id);
CREATE INDEX applications_queue_joined_at_idx
  ON applications(status, queue_joined_at)
  WHERE status = 'queue';

CREATE TABLE candidate_identity_review_items (
  id uuid PRIMARY KEY,
  candidate_profile_id uuid NOT NULL REFERENCES candidate_profiles(id) ON DELETE CASCADE,
  matched_candidate_profile_id uuid REFERENCES candidate_profiles(id) ON DELETE CASCADE,
  signal_type text NOT NULL CHECK (
    signal_type IN (
      'telegram_username',
      'phone',
      'full_name',
      'full_name_phone',
      'external_registration',
      'manual_review'
    )
  ),
  signal_value text NOT NULL DEFAULT '',
  status text NOT NULL DEFAULT 'open' CHECK (
    status IN ('open', 'confirmed_same_person', 'confirmed_different_people', 'ignored')
  ),
  resolution_note text NOT NULL DEFAULT '',
  detected_at timestamptz NOT NULL DEFAULT now(),
  resolved_at timestamptz,
  resolved_by_telegram_user_id text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK (
    matched_candidate_profile_id IS NULL
    OR candidate_profile_id <> matched_candidate_profile_id
  )
);

CREATE INDEX candidate_identity_review_items_candidate_idx
  ON candidate_identity_review_items(candidate_profile_id, status, detected_at);
CREATE INDEX candidate_identity_review_items_match_idx
  ON candidate_identity_review_items(matched_candidate_profile_id, status, detected_at)
  WHERE matched_candidate_profile_id IS NOT NULL;
CREATE UNIQUE INDEX candidate_identity_review_items_open_unique_idx
  ON candidate_identity_review_items(
    candidate_profile_id,
    matched_candidate_profile_id,
    signal_type,
    signal_value
  )
  WHERE status = 'open' AND matched_candidate_profile_id IS NOT NULL;

CREATE TABLE interview_slots (
  id uuid PRIMARY KEY,
  legacy_id text UNIQUE,
  title text NOT NULL DEFAULT 'Собеседование LOFT HALL',
  interview_date date NOT NULL,
  interview_time time without time zone NOT NULL,
  timezone text NOT NULL DEFAULT 'Europe/Moscow',
  venue_id text NOT NULL,
  venue_label text NOT NULL,
  venue_address text NOT NULL DEFAULT '',
  seats integer NOT NULL CHECK (seats BETWEEN 1 AND 100),
  status text NOT NULL DEFAULT 'open' CHECK (
    status IN ('open', 'closed', 'completed', 'canceled')
  ),
  directions_material_id text NOT NULL DEFAULT '',
  booking_text text NOT NULL DEFAULT '',
  template_cleared boolean NOT NULL DEFAULT false,
  completed_at timestamptz,
  created_by_telegram_user_id text,
  row_version bigint NOT NULL DEFAULT 1 CHECK (row_version > 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX interview_slots_active_datetime_idx
  ON interview_slots(interview_date, interview_time)
  WHERE status IN ('open', 'closed');
CREATE INDEX interview_slots_status_date_idx
  ON interview_slots(status, interview_date, interview_time);
CREATE INDEX interview_slots_venue_idx
  ON interview_slots(venue_id);

CREATE TABLE interview_participants (
  id uuid PRIMARY KEY,
  candidate_profile_id uuid NOT NULL REFERENCES candidate_profiles(id) ON DELETE CASCADE,
  interview_slot_id uuid REFERENCES interview_slots(id) ON DELETE SET NULL,
  waitlist_target_slot_id uuid REFERENCES interview_slots(id) ON DELETE SET NULL,
  status text NOT NULL DEFAULT 'waitlist' CHECK (
    status IN (
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
    )
  ),
  candidate_layer_status text NOT NULL DEFAULT 'candidate_created' CHECK (
    candidate_layer_status IN (
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
    )
  ),
  confirmation_status text NOT NULL DEFAULT 'not_requested' CHECK (
    confirmation_status IN ('not_requested', 'pending', 'confirmed', 'declined', 'no_response')
  ),
  confirmation_requested_at timestamptz,
  confirmed_at timestamptz,
  declined_at timestamptz,
  attendance_status text NOT NULL DEFAULT 'unknown' CHECK (
    attendance_status IN ('unknown', 'arrived', 'no_show', 'declined_before', 'no_confirmation')
  ),
  attendance_marked_at timestamptz,
  registration_status text NOT NULL DEFAULT 'not_started' CHECK (
    registration_status IN ('not_started', 'instructions_sent', 'materials_sent', 'pending', 'registered')
  ),
  registration_instructions_sent_at timestamptz,
  registration_confirmed_at timestamptz,
  materials_available_at timestamptz,
  materials_sent_at timestamptz,
  resources_sent_at timestamptz,
  left_after_interview_at timestamptz,
  waitlist_joined_at timestamptz,
  last_waitlist_notified_at timestamptz,
  internship_stage text NOT NULL DEFAULT 'candidate_layer',
  recruiter_note text NOT NULL DEFAULT '',
  row_version bigint NOT NULL DEFAULT 1 CHECK (row_version > 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX interview_participants_one_active_candidate_idx
  ON interview_participants(candidate_profile_id)
  WHERE status IN (
    'waitlist',
    'booked',
    'confirmation_pending',
    'confirmed',
    'attended',
    'registration_pending',
    'registered',
    'ready_for_internship'
  );
CREATE UNIQUE INDEX interview_participants_one_candidate_per_slot_idx
  ON interview_participants(candidate_profile_id, interview_slot_id)
  WHERE interview_slot_id IS NOT NULL;
CREATE INDEX interview_participants_slot_status_idx
  ON interview_participants(interview_slot_id, status);
CREATE INDEX interview_participants_confirmation_idx
  ON interview_participants(confirmation_status, confirmation_requested_at);
CREATE INDEX interview_participants_attendance_idx
  ON interview_participants(attendance_status, attendance_marked_at);

CREATE TABLE candidate_resource_deliveries (
  id uuid PRIMARY KEY,
  candidate_profile_id uuid NOT NULL REFERENCES candidate_profiles(id) ON DELETE CASCADE,
  interview_participant_id uuid NOT NULL REFERENCES interview_participants(id) ON DELETE CASCADE,
  resource_type text NOT NULL CHECK (
    resource_type IN (
      'registration_bot',
      'staff_bot',
      'unattested_group',
      'helper_bot',
      'self_employment'
    )
  ),
  sequence_no integer NOT NULL CHECK (sequence_no BETWEEN 1 AND 20),
  status text NOT NULL DEFAULT 'pending' CHECK (
    status IN ('pending', 'sent', 'skipped', 'failed')
  ),
  telegram_message_id text,
  error text NOT NULL DEFAULT '',
  sent_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (interview_participant_id, resource_type)
);

CREATE INDEX candidate_resource_deliveries_candidate_idx
  ON candidate_resource_deliveries(candidate_profile_id, sequence_no);
CREATE INDEX candidate_resource_deliveries_status_idx
  ON candidate_resource_deliveries(status, created_at);

CREATE TABLE candidate_link_clicks (
  id uuid PRIMARY KEY,
  candidate_profile_id uuid NOT NULL REFERENCES candidate_profiles(id) ON DELETE CASCADE,
  interview_participant_id uuid NOT NULL REFERENCES interview_participants(id) ON DELETE CASCADE,
  link_type text NOT NULL,
  url text NOT NULL DEFAULT '',
  clicked_at timestamptz NOT NULL DEFAULT now(),
  source text NOT NULL DEFAULT 'telegram_webapp',
  UNIQUE (interview_participant_id, link_type)
);

CREATE INDEX candidate_link_clicks_candidate_idx
  ON candidate_link_clicks(candidate_profile_id, clicked_at);

CREATE TABLE candidate_events (
  id uuid PRIMARY KEY,
  candidate_profile_id uuid REFERENCES candidate_profiles(id) ON DELETE SET NULL,
  interview_slot_id uuid REFERENCES interview_slots(id) ON DELETE SET NULL,
  interview_participant_id uuid REFERENCES interview_participants(id) ON DELETE SET NULL,
  application_id uuid REFERENCES applications(id) ON DELETE SET NULL,
  event_type text NOT NULL,
  actor_type text NOT NULL CHECK (
    actor_type IN ('candidate', 'trainee', 'recruiter', 'mentor', 'system', 'worker', 'migration')
  ),
  actor_telegram_user_id text,
  payload jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX candidate_events_candidate_created_idx
  ON candidate_events(candidate_profile_id, created_at);
CREATE INDEX candidate_events_interview_slot_created_idx
  ON candidate_events(interview_slot_id, created_at);
CREATE INDEX candidate_events_application_created_idx
  ON candidate_events(application_id, created_at);

ALTER TABLE notifications
  ADD COLUMN candidate_profile_id uuid REFERENCES candidate_profiles(id) ON DELETE SET NULL,
  ADD COLUMN interview_slot_id uuid REFERENCES interview_slots(id) ON DELETE SET NULL,
  ADD COLUMN interview_participant_id uuid REFERENCES interview_participants(id) ON DELETE SET NULL;

CREATE INDEX notifications_candidate_profile_id_idx
  ON notifications(candidate_profile_id);
CREATE INDEX notifications_interview_slot_id_idx
  ON notifications(interview_slot_id);
CREATE INDEX notifications_interview_participant_id_idx
  ON notifications(interview_participant_id);
