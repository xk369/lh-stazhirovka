ALTER TABLE interview_participants
  ADD COLUMN legacy_id text;

CREATE UNIQUE INDEX interview_participants_legacy_id_idx
  ON interview_participants(legacy_id)
  WHERE legacy_id IS NOT NULL AND legacy_id <> '';
