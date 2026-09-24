-- Adds fields used by the deployed tenant cancellation workflow.
-- MariaDB 10.4+ / MySQL 8 compatible and safe to run repeatedly.

ALTER TABLE bookings
    ADD COLUMN IF NOT EXISTS cancellation_remark VARCHAR(1000) NULL AFTER calendar_event_id,
    ADD COLUMN IF NOT EXISTS cancelled_at DATETIME(3) NULL AFTER cancellation_remark;

INSERT INTO schema_migrations (version, description)
VALUES ('002', 'Booking cancellation audit fields')
ON DUPLICATE KEY UPDATE description = VALUES(description);
