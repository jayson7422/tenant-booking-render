-- Controlled late-cancellation workflow for tenant bookings.
-- Normal cancellations still restore quota through the existing derived balance.

CREATE TABLE IF NOT EXISTS booking_cancellation_requests (
    id VARCHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
    booking_id VARCHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
    tenant_id VARCHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
    reason_category VARCHAR(64) NOT NULL,
    note VARCHAR(1000) NULL,
    status VARCHAR(32) NOT NULL DEFAULT 'Pending',
    requested_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    reviewed_at DATETIME(3) NULL,
    reviewed_by_user_id VARCHAR(64) CHARACTER SET ascii COLLATE ascii_bin NULL,
    reviewed_by_username VARCHAR(160) NULL,
    review_remark VARCHAR(1000) NULL,
    PRIMARY KEY (id),
    UNIQUE KEY uq_booking_cancellation_request_booking (booking_id),
    KEY idx_cancellation_requests_status (status, requested_at),
    KEY idx_cancellation_requests_tenant (tenant_id, requested_at),
    CONSTRAINT fk_cancellation_request_booking FOREIGN KEY (booking_id) REFERENCES bookings (id) ON UPDATE RESTRICT ON DELETE CASCADE,
    CONSTRAINT fk_cancellation_request_tenant FOREIGN KEY (tenant_id) REFERENCES tenants (id) ON UPDATE RESTRICT ON DELETE CASCADE,
    CONSTRAINT chk_cancellation_request_status CHECK (status IN ('Pending', 'Approved', 'Rejected'))
) ENGINE=InnoDB
  DEFAULT CHARSET=utf8mb4
  COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS booking_lifecycle_log (
    id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
    booking_id VARCHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
    actor_type VARCHAR(32) NOT NULL,
    actor_id VARCHAR(64) CHARACTER SET ascii COLLATE ascii_bin NULL,
    actor_name VARCHAR(160) NOT NULL,
    action VARCHAR(64) NOT NULL,
    reason VARCHAR(1000) NULL,
    quota_minutes INT NULL,
    created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    PRIMARY KEY (id),
    KEY idx_booking_lifecycle_booking (booking_id, created_at),
    KEY idx_booking_lifecycle_actor (actor_type, actor_id, created_at),
    CONSTRAINT fk_booking_lifecycle_booking FOREIGN KEY (booking_id) REFERENCES bookings (id) ON UPDATE RESTRICT ON DELETE CASCADE
) ENGINE=InnoDB
  DEFAULT CHARSET=utf8mb4
  COLLATE=utf8mb4_unicode_ci;

INSERT INTO schema_migrations (version, description)
VALUES ('006', 'Controlled booking cancellation requests')
ON DUPLICATE KEY UPDATE description = VALUES(description);
