-- Audit trail for meaningful administrative booking mutations.
-- MariaDB 10.4+ / MySQL 8 compatible and safe to run repeatedly.

CREATE TABLE IF NOT EXISTS booking_audit_log (
    id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
    booking_id VARCHAR(64) CHARACTER SET ascii COLLATE ascii_bin NULL,
    admin_user_id VARCHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
    admin_username VARCHAR(160) NOT NULL,
    action VARCHAR(64) NOT NULL,
    reason VARCHAR(1000) NULL,
    previous_values TEXT NULL,
    new_values TEXT NULL,
    created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    PRIMARY KEY (id),
    KEY idx_booking_audit_booking (booking_id, created_at),
    KEY idx_booking_audit_admin (admin_user_id, created_at)
) ENGINE=InnoDB
  DEFAULT CHARSET=utf8mb4
  COLLATE=utf8mb4_unicode_ci;

INSERT INTO schema_migrations (version, description)
VALUES ('004', 'Administrative booking audit trail')
ON DUPLICATE KEY UPDATE description = VALUES(description);
