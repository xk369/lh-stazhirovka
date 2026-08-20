ALTER TABLE interview_participants
  ADD COLUMN interview_result text NOT NULL DEFAULT 'pending' CHECK (
    interview_result IN ('pending', 'fit', 'not_fit', 'self_declined', 'russian_low', 'other')
  ),
  ADD COLUMN result_reason text NOT NULL DEFAULT '',
  ADD COLUMN result_marked_at timestamptz,
  ADD COLUMN loss_reason text NOT NULL DEFAULT '',
  ADD COLUMN loss_reason_comment text NOT NULL DEFAULT '',
  ADD COLUMN loss_reason_marked_at timestamptz,
  ADD COLUMN interview_history jsonb NOT NULL DEFAULT '[]'::jsonb,
  ADD COLUMN resource_errors jsonb NOT NULL DEFAULT '[]'::jsonb;

ALTER TABLE notifications
  ADD COLUMN title text NOT NULL DEFAULT '',
  ADD COLUMN channel text NOT NULL DEFAULT 'telegram',
  ADD COLUMN media jsonb NOT NULL DEFAULT '[]'::jsonb,
  ADD COLUMN actions jsonb NOT NULL DEFAULT '[]'::jsonb,
  ADD COLUMN keyboard_cleared_at timestamptz,
  ADD COLUMN delivery_note text NOT NULL DEFAULT '';
