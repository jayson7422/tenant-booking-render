-- BayanSpaces / BayanWorkforce relational schema
-- Baseline: 001
-- Compatible with current MariaDB and MySQL versions using InnoDB.
--
-- This script intentionally does not create a database, drop objects, or seed
-- application records. Create/select the target database before importing it.

SET NAMES utf8mb4;

CREATE TABLE IF NOT EXISTS schema_migrations (
    version VARCHAR(32) NOT NULL,
    description VARCHAR(255) NOT NULL,
    applied_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    PRIMARY KEY (version)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS companies (
    id VARCHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
    name VARCHAR(160) NOT NULL,
    pay_frequency VARCHAR(32) NOT NULL,
    standard_hours DECIMAL(5,2) NOT NULL,
    payroll_rules_version VARCHAR(120) NOT NULL,
    created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
    PRIMARY KEY (id),
    UNIQUE KEY uq_companies_name (name),
    CONSTRAINT chk_companies_standard_hours CHECK (standard_hours > 0 AND standard_hours <= 24)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS employees (
    id VARCHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
    company_id VARCHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
    code VARCHAR(64) NOT NULL,
    first_name VARCHAR(100) NOT NULL,
    last_name VARCHAR(100) NOT NULL,
    department VARCHAR(160) NOT NULL,
    position VARCHAR(160) NOT NULL,
    role VARCHAR(32) NOT NULL,
    monthly_salary DECIMAL(14,2) NOT NULL DEFAULT 0.00,
    status VARCHAR(32) NOT NULL DEFAULT 'Active',
    start_date DATE NULL,
    sss_number VARCHAR(64) NULL,
    philhealth_number VARCHAR(64) NULL,
    pagibig_number VARCHAR(64) NULL,
    created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
    PRIMARY KEY (id),
    UNIQUE KEY uq_employees_company_code (company_id, code),
    KEY idx_employees_company_status (company_id, status),
    CONSTRAINT fk_employees_company FOREIGN KEY (company_id) REFERENCES companies (id) ON UPDATE RESTRICT ON DELETE RESTRICT,
    CONSTRAINT chk_employees_role CHECK (role IN ('admin', 'manager', 'employee')),
    CONSTRAINT chk_employees_status CHECK (status IN ('Active', 'Inactive')),
    CONSTRAINT chk_employees_salary CHECK (monthly_salary >= 0)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS users (
    id VARCHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
    employee_id VARCHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
    username VARCHAR(100) NOT NULL,
    password_hash VARCHAR(255) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
    role VARCHAR(32) NOT NULL,
    is_active BOOLEAN NOT NULL DEFAULT TRUE,
    created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
    PRIMARY KEY (id),
    UNIQUE KEY uq_users_username (username),
    UNIQUE KEY uq_users_employee (employee_id),
    CONSTRAINT fk_users_employee FOREIGN KEY (employee_id) REFERENCES employees (id) ON UPDATE RESTRICT ON DELETE CASCADE,
    CONSTRAINT chk_users_role CHECK (role IN ('admin', 'manager', 'employee'))
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS attendance (
    id VARCHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
    employee_id VARCHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
    attendance_date DATE NOT NULL,
    time_in TIME NULL,
    time_out TIME NULL,
    status VARCHAR(32) NOT NULL DEFAULT 'Present',
    overtime_hours DECIMAL(7,2) NOT NULL DEFAULT 0.00,
    created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
    PRIMARY KEY (id),
    UNIQUE KEY uq_attendance_employee_date (employee_id, attendance_date),
    KEY idx_attendance_date_status (attendance_date, status),
    CONSTRAINT fk_attendance_employee FOREIGN KEY (employee_id) REFERENCES employees (id) ON UPDATE RESTRICT ON DELETE RESTRICT,
    CONSTRAINT chk_attendance_status CHECK (status IN ('Present', 'Absent', 'Leave', 'Holiday')),
    CONSTRAINT chk_attendance_overtime CHECK (overtime_hours >= 0),
    CONSTRAINT chk_attendance_times CHECK (time_out IS NULL OR time_in IS NULL OR time_out >= time_in)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS payrolls (
    id VARCHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
    employee_id VARCHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
    period VARCHAR(20) NOT NULL,
    overtime_hours DECIMAL(7,2) NOT NULL DEFAULT 0.00,
    base_pay DECIMAL(14,2) NOT NULL DEFAULT 0.00,
    overtime_pay DECIMAL(14,2) NOT NULL DEFAULT 0.00,
    allowances DECIMAL(14,2) NOT NULL DEFAULT 0.00,
    absence_deduction DECIMAL(14,2) NOT NULL DEFAULT 0.00,
    other_deductions DECIMAL(14,2) NOT NULL DEFAULT 0.00,
    gross_pay DECIMAL(14,2) NOT NULL DEFAULT 0.00,
    sss_employee DECIMAL(14,2) NOT NULL DEFAULT 0.00,
    sss_employer DECIMAL(14,2) NOT NULL DEFAULT 0.00,
    philhealth_employee DECIMAL(14,2) NOT NULL DEFAULT 0.00,
    philhealth_employer DECIMAL(14,2) NOT NULL DEFAULT 0.00,
    pagibig_employee DECIMAL(14,2) NOT NULL DEFAULT 0.00,
    pagibig_employer DECIMAL(14,2) NOT NULL DEFAULT 0.00,
    withholding_tax DECIMAL(14,2) NOT NULL DEFAULT 0.00,
    total_deduction DECIMAL(14,2) NOT NULL DEFAULT 0.00,
    net_pay DECIMAL(14,2) NOT NULL DEFAULT 0.00,
    employer_cost DECIMAL(14,2) NOT NULL DEFAULT 0.00,
    created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    PRIMARY KEY (id),
    KEY idx_payrolls_employee_period (employee_id, period),
    KEY idx_payrolls_period (period),
    CONSTRAINT fk_payrolls_employee FOREIGN KEY (employee_id) REFERENCES employees (id) ON UPDATE RESTRICT ON DELETE RESTRICT,
    CONSTRAINT chk_payrolls_overtime CHECK (overtime_hours >= 0)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS shifts (
    id VARCHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
    employee_id VARCHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
    shift_date DATE NOT NULL,
    start_time TIME NOT NULL,
    end_time TIME NOT NULL,
    job_site VARCHAR(160) NOT NULL,
    role_label VARCHAR(160) NOT NULL,
    color VARCHAR(32) NOT NULL DEFAULT 'teal',
    status VARCHAR(32) NOT NULL DEFAULT 'Published',
    created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
    PRIMARY KEY (id),
    KEY idx_shifts_employee_date (employee_id, shift_date),
    KEY idx_shifts_date_status (shift_date, status),
    CONSTRAINT fk_shifts_employee FOREIGN KEY (employee_id) REFERENCES employees (id) ON UPDATE RESTRICT ON DELETE RESTRICT,
    CONSTRAINT chk_shifts_times CHECK (end_time > start_time),
    CONSTRAINT chk_shifts_status CHECK (status IN ('Published', 'Draft')),
    CONSTRAINT chk_shifts_color CHECK (color IN ('teal', 'blue', 'purple', 'orange'))
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS tenants (
    id VARCHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
    company_id VARCHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
    full_name VARCHAR(160) NOT NULL,
    tenant_company_name VARCHAR(200) NOT NULL DEFAULT '',
    email VARCHAR(191) NOT NULL,
    location VARCHAR(255) NOT NULL,
    allotted_hours DECIMAL(10,2) NOT NULL DEFAULT 0.00,
    access_code_hash VARCHAR(255) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
    status VARCHAR(32) NOT NULL DEFAULT 'Active',
    created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
    PRIMARY KEY (id),
    UNIQUE KEY uq_tenants_email (email),
    KEY idx_tenants_company_status (company_id, status),
    CONSTRAINT fk_tenants_company FOREIGN KEY (company_id) REFERENCES companies (id) ON UPDATE RESTRICT ON DELETE RESTRICT,
    CONSTRAINT chk_tenants_hours CHECK (allotted_hours >= 0),
    CONSTRAINT chk_tenants_status CHECK (status IN ('Active', 'Inactive'))
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS rooms (
    id VARCHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
    company_id VARCHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
    name VARCHAR(160) NOT NULL,
    location VARCHAR(255) NOT NULL,
    capacity SMALLINT UNSIGNED NOT NULL DEFAULT 0,
    calendar_id VARCHAR(255) NULL,
    created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
    PRIMARY KEY (id),
    UNIQUE KEY uq_rooms_company_name (company_id, name),
    KEY idx_rooms_company_location (company_id, location),
    CONSTRAINT fk_rooms_company FOREIGN KEY (company_id) REFERENCES companies (id) ON UPDATE RESTRICT ON DELETE RESTRICT
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS bookings (
    id VARCHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
    tenant_id VARCHAR(64) CHARACTER SET ascii COLLATE ascii_bin NULL,
    room_id VARCHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
    tenant_name_snapshot VARCHAR(160) NOT NULL,
    tenant_company_name_snapshot VARCHAR(200) NOT NULL DEFAULT '',
    room_name_snapshot VARCHAR(160) NOT NULL,
    booking_date DATE NOT NULL,
    start_time TIME NOT NULL,
    end_time TIME NOT NULL,
    duration_minutes SMALLINT UNSIGNED NOT NULL,
    status VARCHAR(32) NOT NULL DEFAULT 'Confirmed',
    calendar_event_id VARCHAR(255) NULL,
    cancellation_remark VARCHAR(1000) NULL,
    cancelled_at DATETIME(3) NULL,
    created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
    PRIMARY KEY (id),
    KEY idx_bookings_tenant_status (tenant_id, status),
    KEY idx_bookings_room_conflict (room_id, booking_date, status, start_time, end_time),
    KEY idx_bookings_date (booking_date),
    CONSTRAINT fk_bookings_tenant FOREIGN KEY (tenant_id) REFERENCES tenants (id) ON UPDATE RESTRICT ON DELETE SET NULL,
    CONSTRAINT fk_bookings_room FOREIGN KEY (room_id) REFERENCES rooms (id) ON UPDATE RESTRICT ON DELETE RESTRICT,
    CONSTRAINT chk_bookings_times CHECK (end_time > start_time),
    CONSTRAINT chk_bookings_duration CHECK (duration_minutes > 0 AND duration_minutes <= 1440),
    CONSTRAINT chk_bookings_status CHECK (status IN ('Confirmed', 'Cancelled'))
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS booking_settings (
    company_id VARCHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
    timezone VARCHAR(64) NOT NULL DEFAULT 'Asia/Manila',
    updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
    PRIMARY KEY (company_id),
    CONSTRAINT fk_booking_settings_company FOREIGN KEY (company_id) REFERENCES companies (id) ON UPDATE RESTRICT ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS google_oauth_credentials (
    company_id VARCHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
    refresh_token_encrypted TEXT CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
    encryption_scheme VARCHAR(32) CHARACTER SET ascii COLLATE ascii_bin NOT NULL DEFAULT 'aes-256-gcm-v1',
    connected_at DATETIME(3) NOT NULL,
    updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
    PRIMARY KEY (company_id),
    CONSTRAINT fk_google_oauth_company FOREIGN KEY (company_id) REFERENCES companies (id) ON UPDATE RESTRICT ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS migration_runs (
    id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
    source_environment VARCHAR(32) NOT NULL,
    source_path VARCHAR(1024) NOT NULL,
    source_sha256 CHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
    schema_version VARCHAR(32) NOT NULL,
    status VARCHAR(32) NOT NULL,
    started_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    completed_at DATETIME(3) NULL,
    summary_json LONGTEXT NULL,
    error_message TEXT NULL,
    PRIMARY KEY (id),
    UNIQUE KEY uq_migration_runs_source_schema (source_sha256, schema_version),
    KEY idx_migration_runs_status_started (status, started_at),
    CONSTRAINT chk_migration_runs_environment CHECK (source_environment IN ('server', 'local', 'test')),
    CONSTRAINT chk_migration_runs_status CHECK (status IN ('running', 'completed', 'failed', 'rolled_back')),
    CONSTRAINT chk_migration_runs_summary_json CHECK (summary_json IS NULL OR JSON_VALID(summary_json))
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

INSERT INTO schema_migrations (version, description)
VALUES ('001', 'Initial BayanSpaces and BayanWorkforce relational schema')
ON DUPLICATE KEY UPDATE description = VALUES(description);
