CREATE TABLE booking_state_meta (
  singleton boolean PRIMARY KEY DEFAULT true CHECK (singleton),
  version bigint NOT NULL CHECK (version > 0),
  updated_at timestamptz NOT NULL
);

CREATE TABLE data_imports (
  id uuid PRIMARY KEY,
  source_type text NOT NULL,
  source_checksum text NOT NULL UNIQUE,
  source_version bigint,
  source_updated_at timestamptz,
  shifts_count integer NOT NULL,
  applications_count integer NOT NULL,
  invite_groups_count integer NOT NULL,
  imported_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE telegram_users (
  id uuid PRIMARY KEY,
  telegram_user_id text NOT NULL UNIQUE,
  telegram_chat_id text,
  username text,
  first_name text,
  last_name text,
  language_code text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE recruiters (
  id uuid PRIMARY KEY,
  telegram_user_id text NOT NULL UNIQUE,
  name text,
  active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE shifts (
  id uuid PRIMARY KEY,
  legacy_id bigint UNIQUE,
  date date NOT NULL UNIQUE,
  seats integer NOT NULL CHECK (seats BETWEEN 1 AND 30),
  open boolean NOT NULL DEFAULT true,
  canceled boolean NOT NULL DEFAULT false,
  canceled_at timestamptz,
  row_version bigint NOT NULL DEFAULT 1 CHECK (row_version > 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE invite_groups (
  id uuid PRIMARY KEY,
  legacy_id bigint UNIQUE,
  shift_id uuid NOT NULL REFERENCES shifts(id) ON DELETE RESTRICT,
  venue_id text NOT NULL,
  link text NOT NULL,
  sent_at timestamptz NOT NULL,
  created_by_telegram_user_id text,
  row_version bigint NOT NULL DEFAULT 1 CHECK (row_version > 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE applications (
  id uuid PRIMARY KEY,
  legacy_id bigint UNIQUE,
  shift_id uuid REFERENCES shifts(id) ON DELETE SET NULL,
  invite_group_id uuid REFERENCES invite_groups(id) ON DELETE SET NULL,
  trainee_telegram_user_id text,
  trainee_telegram_chat_id text,
  telegram_username text,
  telegram_code text,
  name text NOT NULL,
  phone text NOT NULL DEFAULT '',
  training text NOT NULL CHECK (training IN ('passed', 'not_passed')),
  training_date date,
  attempt text NOT NULL CHECK (attempt IN ('first', 'repeat')),
  limits text NOT NULL DEFAULT '',
  status text NOT NULL CHECK (
    status IN ('pending', 'queue', 'confirmed', 'invited', 'feedback', 'passed', 'failed', 'noshow')
  ),
  recruiter_comment text NOT NULL DEFAULT '',
  venue_id text,
  group_link text NOT NULL DEFAULT '',
  candidate_report boolean NOT NULL DEFAULT false,
  experience text CHECK (experience IS NULL OR experience = 'experienced'),
  mentor_report_received boolean NOT NULL DEFAULT false,
  mentor_report_at timestamptz,
  mentor_reporter_telegram_user_id text,
  mentor_decision text NOT NULL DEFAULT '',
  mentor_report_venue_id text NOT NULL DEFAULT '',
  mentor_report_venue text NOT NULL DEFAULT '',
  mentor_report_loft text NOT NULL DEFAULT '',
  mentor_report_hall text NOT NULL DEFAULT '',
  mentor_comment_for_trainee text NOT NULL DEFAULT '',
  mentor_comment_sent_at timestamptz,
  mentor_comment_delivery_status text CHECK (
    mentor_comment_delivery_status IS NULL
    OR mentor_comment_delivery_status IN ('sent', 'skipped', 'failed')
  ),
  mentor_comment_delivery_error text NOT NULL DEFAULT '',
  row_version bigint NOT NULL DEFAULT 1 CHECK (row_version > 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX applications_status_idx ON applications(status);
CREATE INDEX applications_shift_id_idx ON applications(shift_id);
CREATE INDEX applications_trainee_telegram_user_id_idx ON applications(trainee_telegram_user_id);
CREATE INDEX applications_telegram_username_idx ON applications(telegram_username);
CREATE INDEX applications_name_lower_idx ON applications(lower(name));

CREATE TABLE invite_group_members (
  invite_group_id uuid NOT NULL REFERENCES invite_groups(id) ON DELETE CASCADE,
  application_id uuid NOT NULL REFERENCES applications(id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (invite_group_id, application_id)
);

CREATE INDEX invite_group_members_application_id_idx
  ON invite_group_members(application_id);

CREATE TABLE mentor_reports (
  id uuid PRIMARY KEY,
  application_id uuid NOT NULL REFERENCES applications(id) ON DELETE RESTRICT,
  mentor_telegram_user_id text,
  mentor_username text,
  mentor_name text,
  result_status text NOT NULL CHECK (result_status IN ('passed', 'failed')),
  decision text NOT NULL,
  mastered integer CHECK (mastered IS NULL OR mastered >= 0),
  total integer CHECK (total IS NULL OR total >= 0),
  venue_id text,
  venue_label text,
  venue_loft text,
  hall text,
  mentor_comment text,
  trainee_message_text text,
  report_text text,
  source text NOT NULL DEFAULT 'application_state',
  created_at timestamptz NOT NULL DEFAULT now(),
  voided_at timestamptz,
  CHECK (mastered IS NULL OR total IS NULL OR mastered <= total)
);

CREATE UNIQUE INDEX mentor_reports_one_active_per_application_idx
  ON mentor_reports(application_id)
  WHERE voided_at IS NULL;

CREATE TABLE mentor_report_topics (
  id uuid PRIMARY KEY,
  mentor_report_id uuid NOT NULL REFERENCES mentor_reports(id) ON DELETE CASCADE,
  topic_order integer NOT NULL CHECK (topic_order > 0),
  title text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (mentor_report_id, topic_order)
);

CREATE TABLE notifications (
  id uuid PRIMARY KEY,
  application_id uuid REFERENCES applications(id) ON DELETE SET NULL,
  mentor_report_id uuid REFERENCES mentor_reports(id) ON DELETE SET NULL,
  type text NOT NULL,
  chat_id text,
  chat_target text,
  text text,
  parse_mode text,
  status text NOT NULL CHECK (status IN ('pending', 'sending', 'sent', 'skipped', 'failed')),
  telegram_message_id text,
  error text,
  idempotency_key text UNIQUE,
  attempt_count integer NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
  next_attempt_at timestamptz,
  claimed_at timestamptz,
  sent_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX notifications_delivery_idx
  ON notifications(status, next_attempt_at, created_at);

CREATE TABLE application_events (
  id uuid PRIMARY KEY,
  application_id uuid REFERENCES applications(id) ON DELETE SET NULL,
  shift_id uuid REFERENCES shifts(id) ON DELETE SET NULL,
  event_type text NOT NULL,
  actor_type text NOT NULL CHECK (
    actor_type IN ('trainee', 'recruiter', 'mentor', 'system', 'migration')
  ),
  actor_telegram_user_id text,
  payload jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX application_events_application_created_idx
  ON application_events(application_id, created_at);
CREATE INDEX application_events_shift_created_idx
  ON application_events(shift_id, created_at);
