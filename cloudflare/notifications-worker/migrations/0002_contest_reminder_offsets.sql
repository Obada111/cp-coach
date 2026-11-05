ALTER TABLE notification_profiles
  ADD COLUMN contest_reminder_offsets TEXT NOT NULL DEFAULT '[30]'
  CHECK (json_valid(contest_reminder_offsets) AND json_type(contest_reminder_offsets) = 'array');
