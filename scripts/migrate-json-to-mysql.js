'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { pool, closePool } = require('../src/config/database');

const SCHEMA_VERSION = '001';
const COMPANY_ID = 'company-main';
const ENTITY_NAMES = ['users', 'employees', 'attendance', 'payrolls', 'shifts', 'tenants', 'rooms', 'bookings'];
const BUSINESS_TABLES = ['companies', 'users', 'employees', 'attendance', 'payrolls', 'shifts', 'tenants', 'rooms', 'bookings', 'booking_settings', 'google_oauth_credentials'];

function parseArgs(argv) {
  const args = { apply: false };
  for (const argument of argv) {
    if (argument === '--apply') args.apply = true;
    else if (argument.startsWith('--source=')) args.source = argument.slice('--source='.length);
    else if (argument.startsWith('--environment=')) args.environment = argument.slice('--environment='.length);
    else if (argument.startsWith('--confirm-sha256=')) args.confirmSha256 = argument.slice('--confirm-sha256='.length).toUpperCase();
    else throw new Error(`Unknown argument: ${argument}`);
  }
  if (!args.source) throw new Error('Provide an explicit source with --source="path-to-backup.json"');
  if (!['server', 'local', 'test'].includes(args.environment)) {
    throw new Error('Provide --environment=server, --environment=local, or --environment=test');
  }
  return args;
}

function readAndValidate(sourceArgument) {
  const sourcePath = path.resolve(sourceArgument);
  if (!fs.existsSync(sourcePath)) throw new Error(`Source file does not exist: ${sourcePath}`);
  if (path.extname(sourcePath).toLowerCase() !== '.json') throw new Error('Source must be a JSON file');

  const raw = fs.readFileSync(sourcePath, 'utf8');
  const sourceSha256 = crypto.createHash('sha256').update(raw).digest('hex').toUpperCase();
  let data;
  try {
    data = JSON.parse(raw);
  } catch (error) {
    throw new Error(`Source JSON is invalid: ${error.message}`);
  }

  if (!data.company || typeof data.company !== 'object') throw new Error('Source is missing company settings');
  for (const name of ENTITY_NAMES) {
    if (!Array.isArray(data[name])) throw new Error(`Source property ${name} must be an array`);
  }
  if (!data.bookingSettings || typeof data.bookingSettings !== 'object') {
    throw new Error('Source is missing bookingSettings');
  }
  if (data.users.some(user => Object.hasOwn(user, 'password'))) throw new Error('Source contains a plaintext user password');
  if (data.tenants.some(tenant => Object.hasOwn(tenant, 'accessCode'))) throw new Error('Source contains a plaintext tenant access code');

  requireUnique(data.users, 'username', 'username', true);
  requireUnique(data.employees, 'code', 'employee code', true);
  requireUnique(data.tenants, 'email', 'tenant email', true);
  requireUnique(data.users, 'id', 'user ID');
  requireUnique(data.employees, 'id', 'employee ID');
  requireUnique(data.shifts, 'id', 'shift ID');
  requireUnique(data.tenants, 'id', 'tenant ID');
  requireUnique(data.rooms, 'id', 'room ID');
  requireUnique(data.bookings, 'id', 'booking ID');

  const employeeIds = new Set(data.employees.map(item => item.id));
  const tenantIds = new Set(data.tenants.map(item => item.id));
  const roomIds = new Set(data.rooms.map(item => item.id));
  for (const user of data.users) {
    if (!employeeIds.has(user.employeeId)) throw new Error(`User ${user.id} references a missing employee`);
    requireHash(user.passwordHash, `user ${user.id} password hash`);
  }
  for (const shift of data.shifts) {
    if (!employeeIds.has(shift.employeeId)) throw new Error(`Shift ${shift.id} references a missing employee`);
  }
  for (const attendance of data.attendance) {
    if (!employeeIds.has(attendance.employeeId)) throw new Error(`Attendance ${attendance.id} references a missing employee`);
  }
  for (const payroll of data.payrolls) {
    if (!employeeIds.has(payroll.employeeId)) throw new Error(`Payroll ${payroll.id} references a missing employee`);
  }
  for (const tenant of data.tenants) requireHash(tenant.accessCodeHash, `tenant ${tenant.id} access-code hash`);
  for (const booking of data.bookings) {
    if (!tenantIds.has(booking.tenantId)) throw new Error(`Booking ${booking.id} references a missing tenant`);
    if (!roomIds.has(booking.roomId)) throw new Error(`Booking ${booking.id} references a missing room`);
    const durationMinutes = bookingDurationMinutes(booking.startTime, booking.endTime);
    const derivedHours = Math.round((durationMinutes / 60) * 100) / 100;
    if (Math.abs(derivedHours - Number(booking.hours)) > 0.001) {
      throw new Error(`Booking ${booking.id} duration does not match its stored hours`);
    }
  }

  return { sourcePath, sourceSha256, data, counts: countSource(data) };
}

function requireUnique(items, key, label, caseInsensitive = false) {
  const values = new Set();
  for (const item of items) {
    if (!item[key]) throw new Error(`A ${label} is missing`);
    const value = caseInsensitive ? String(item[key]).toLowerCase() : String(item[key]);
    if (values.has(value)) throw new Error(`Duplicate ${label}: ${item[key]}`);
    values.add(value);
  }
}

function requireHash(value, label) {
  if (!/^[0-9a-f]+:[0-9a-f]+$/i.test(String(value || ''))) throw new Error(`Invalid ${label}`);
}

function countSource(data) {
  return Object.fromEntries(ENTITY_NAMES.map(name => [name, data[name].length]));
}

function printPlan(args, migration) {
  console.log(`MODE: ${args.apply ? 'APPLY' : 'VALIDATION ONLY'}`);
  console.log(`SOURCE: ${migration.sourcePath}`);
  console.log(`SOURCE ENVIRONMENT: ${args.environment}`);
  console.log(`SOURCE SHA256: ${migration.sourceSha256}`);
  console.log(`DATABASE: ${process.env.DB_NAME || '(not configured)'}`);
  for (const name of ENTITY_NAMES) console.log(`${name.toUpperCase()}: ${migration.counts[name]}`);
}

function bookingDurationMinutes(startTime, endTime) {
  const parse = value => {
    const match = /^(\d{2}):(\d{2})(?::\d{2})?$/.exec(String(value || ''));
    if (!match) return NaN;
    return Number(match[1]) * 60 + Number(match[2]);
  };
  const duration = parse(endTime) - parse(startTime);
  if (!Number.isInteger(duration) || duration <= 0 || duration > 1440) throw new Error('Invalid booking duration');
  return duration;
}

function timeValue(value) {
  const match = /^(\d{2}):(\d{2})(?::(\d{2}))?$/.exec(String(value || ''));
  if (!match) throw new Error(`Invalid time value: ${value}`);
  return `${match[1]}:${match[2]}:${match[3] || '00'}`;
}

function dateValue(value, label) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(value || ''))) throw new Error(`Invalid ${label}: ${value}`);
  return value;
}

function dateTimeValue(value, fallback = new Date()) {
  const date = value ? new Date(value) : fallback;
  if (Number.isNaN(date.getTime())) throw new Error(`Invalid timestamp: ${value}`);
  return date.toISOString().slice(0, 23).replace('T', ' ');
}

function nullableText(value) {
  const text = String(value || '').trim();
  return text || null;
}

async function ensureEmptyTarget(connection) {
  const nonEmpty = [];
  for (const table of BUSINESS_TABLES) {
    const [rows] = await connection.query(`SELECT COUNT(*) AS count FROM \`${table}\``);
    if (Number(rows[0].count) > 0) nonEmpty.push(`${table}=${rows[0].count}`);
  }
  if (nonEmpty.length) throw new Error(`Target database is not empty: ${nonEmpty.join(', ')}`);
}

async function insertCompany(connection, data) {
  await connection.execute(
    `INSERT INTO companies (id, name, pay_frequency, standard_hours, payroll_rules_version)
     VALUES (?, ?, ?, ?, ?)`,
    [COMPANY_ID, data.company.name, data.company.payFrequency, data.company.standardHours, data.company.payrollRulesVersion]
  );
}

async function insertEmployeesAndUsers(connection, data) {
  for (const employee of data.employees) {
    await connection.execute(
      `INSERT INTO employees
       (id, company_id, code, first_name, last_name, department, position, role, monthly_salary, status,
        start_date, sss_number, philhealth_number, pagibig_number)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [employee.id, COMPANY_ID, employee.code, employee.firstName, employee.lastName, employee.department,
        employee.position, employee.role, employee.monthlySalary, employee.status,
        employee.startDate ? dateValue(employee.startDate, 'employee start date') : null,
        nullableText(employee.sss), nullableText(employee.philhealth), nullableText(employee.pagibig)]
    );
  }
  const employeeById = new Map(data.employees.map(employee => [employee.id, employee]));
  for (const user of data.users) {
    const employee = employeeById.get(user.employeeId);
    await connection.execute(
      `INSERT INTO users (id, employee_id, username, password_hash, role, is_active)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [user.id, user.employeeId, user.username, user.passwordHash, user.role, employee.status === 'Active']
    );
  }
}

async function insertWorkforceRecords(connection, data) {
  for (const record of data.attendance) {
    await connection.execute(
      `INSERT INTO attendance
       (id, employee_id, attendance_date, time_in, time_out, status, overtime_hours)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [record.id, record.employeeId, dateValue(record.date, 'attendance date'),
        record.timeIn ? timeValue(record.timeIn) : null, record.timeOut ? timeValue(record.timeOut) : null,
        record.status || 'Present', Number(record.overtimeHours || 0)]
    );
  }
  for (const payroll of data.payrolls) {
    await connection.execute(
      `INSERT INTO payrolls
       (id, employee_id, period, overtime_hours, base_pay, overtime_pay, allowances, absence_deduction,
        other_deductions, gross_pay, sss_employee, sss_employer, philhealth_employee, philhealth_employer,
        pagibig_employee, pagibig_employer, withholding_tax, total_deduction, net_pay, employer_cost, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [payroll.id, payroll.employeeId, payroll.period, Number(payroll.overtimeHours || 0),
        Number(payroll.basePay || 0), Number(payroll.overtimePay || 0), Number(payroll.allowances || 0),
        Number(payroll.absenceDeduction || 0), Number(payroll.otherDeductions || 0), Number(payroll.grossPay || 0),
        Number(payroll.sssEmployee || 0), Number(payroll.sssEmployer || 0), Number(payroll.philEmployee || 0),
        Number(payroll.philEmployer || 0), Number(payroll.pagibigEmployee || 0), Number(payroll.pagibigEmployer || 0),
        Number(payroll.withholding || 0), Number(payroll.totalDeduction || 0), Number(payroll.netPay || 0),
        Number(payroll.employerCost || 0), dateTimeValue(payroll.createdAt)]
    );
  }
  for (const shift of data.shifts) {
    await connection.execute(
      `INSERT INTO shifts
       (id, employee_id, shift_date, start_time, end_time, job_site, role_label, color, status)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [shift.id, shift.employeeId, dateValue(shift.date, 'shift date'), timeValue(shift.startTime),
        timeValue(shift.endTime), shift.jobSite, shift.roleLabel, shift.color, shift.status]
    );
  }
}

async function insertBookingRecords(connection, data) {
  for (const tenant of data.tenants) {
    await connection.execute(
      `INSERT INTO tenants
       (id, company_id, full_name, tenant_company_name, email, location, allotted_hours, access_code_hash,
        status, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [tenant.id, COMPANY_ID, tenant.fullName, tenant.companyName || '', tenant.email, tenant.location,
        Number(tenant.allottedHours || 0), tenant.accessCodeHash, tenant.status, dateTimeValue(tenant.createdAt)]
    );
  }
  for (const room of data.rooms) {
    await connection.execute(
      `INSERT INTO rooms (id, company_id, name, location, capacity, calendar_id)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [room.id, COMPANY_ID, room.name, room.location, Number(room.capacity || 0), nullableText(room.calendarId)]
    );
  }
  await connection.execute(
    'INSERT INTO booking_settings (company_id, timezone) VALUES (?, ?)',
    [COMPANY_ID, data.bookingSettings.timezone || 'Asia/Manila']
  );
  if (data.googleOAuth?.refreshTokenEncrypted) {
    await connection.execute(
      `INSERT INTO google_oauth_credentials
       (company_id, refresh_token_encrypted, connected_at)
       VALUES (?, ?, ?)`,
      [COMPANY_ID, data.googleOAuth.refreshTokenEncrypted, dateTimeValue(data.googleOAuth.connectedAt)]
    );
  }
  for (const booking of data.bookings) {
    await connection.execute(
      `INSERT INTO bookings
       (id, tenant_id, room_id, tenant_name_snapshot, tenant_company_name_snapshot, room_name_snapshot,
        booking_date, start_time, end_time, duration_minutes, status, calendar_event_id, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [booking.id, booking.tenantId, booking.roomId, booking.tenantName, booking.companyName || '', booking.roomName,
        dateValue(booking.date, 'booking date'), timeValue(booking.startTime), timeValue(booking.endTime),
        bookingDurationMinutes(booking.startTime, booking.endTime), booking.status,
        nullableText(booking.calendarEventId), dateTimeValue(booking.createdAt)]
    );
  }
}

async function databaseCounts(connection) {
  const mapping = {
    users: 'users', employees: 'employees', attendance: 'attendance', payrolls: 'payrolls',
    shifts: 'shifts', tenants: 'tenants', rooms: 'rooms', bookings: 'bookings'
  };
  const counts = {};
  for (const [name, table] of Object.entries(mapping)) {
    const [rows] = await connection.query(`SELECT COUNT(*) AS count FROM \`${table}\``);
    counts[name] = Number(rows[0].count);
  }
  return counts;
}

async function recordFailedMigration(args, migration, error) {
  try {
    await pool.execute(
      `INSERT INTO migration_runs
       (source_environment, source_path, source_sha256, schema_version, status, completed_at, error_message)
       VALUES (?, ?, ?, ?, 'failed', CURRENT_TIMESTAMP(3), ?)
       ON DUPLICATE KEY UPDATE status='failed', completed_at=CURRENT_TIMESTAMP(3), error_message=VALUES(error_message)`,
      [args.environment, migration.sourcePath, migration.sourceSha256, SCHEMA_VERSION, String(error.message).slice(0, 2000)]
    );
  } catch {
    // Preserve the original migration error when failure logging is unavailable.
  }
}

async function applyMigration(args, migration) {
  if (args.confirmSha256 !== migration.sourceSha256) {
    throw new Error('For --apply, provide --confirm-sha256 with the exact displayed source hash');
  }

  const connection = await pool.getConnection();
  let migrationStarted = false;
  try {
    const [schemaRows] = await connection.execute(
      'SELECT version FROM schema_migrations WHERE version = ?', [SCHEMA_VERSION]
    );
    if (!schemaRows.length) throw new Error(`Database schema version ${SCHEMA_VERSION} is not installed`);

    const [previous] = await connection.execute(
      `SELECT status FROM migration_runs WHERE source_sha256 = ? AND schema_version = ?`,
      [migration.sourceSha256, SCHEMA_VERSION]
    );
    if (previous[0]?.status === 'completed') throw new Error('This source hash has already been migrated successfully');

    await ensureEmptyTarget(connection);
    await connection.beginTransaction();
    migrationStarted = true;
    await connection.execute(
      `INSERT INTO migration_runs
       (source_environment, source_path, source_sha256, schema_version, status)
       VALUES (?, ?, ?, ?, 'running')
       ON DUPLICATE KEY UPDATE source_environment=VALUES(source_environment), source_path=VALUES(source_path),
         status='running', started_at=CURRENT_TIMESTAMP(3), completed_at=NULL, summary_json=NULL, error_message=NULL`,
      [args.environment, migration.sourcePath, migration.sourceSha256, SCHEMA_VERSION]
    );

    await insertCompany(connection, migration.data);
    await insertEmployeesAndUsers(connection, migration.data);
    await insertWorkforceRecords(connection, migration.data);
    await insertBookingRecords(connection, migration.data);

    const postCounts = await databaseCounts(connection);
    for (const name of ENTITY_NAMES) {
      if (postCounts[name] !== migration.counts[name]) {
        throw new Error(`Count mismatch for ${name}: source=${migration.counts[name]}, database=${postCounts[name]}`);
      }
    }
    const summary = { source: migration.counts, database: postCounts, skipped: 0, failed: 0 };
    await connection.execute(
      `UPDATE migration_runs
          SET status='completed', completed_at=CURRENT_TIMESTAMP(3), summary_json=?
        WHERE source_sha256=? AND schema_version=?`,
      [JSON.stringify(summary), migration.sourceSha256, SCHEMA_VERSION]
    );
    await connection.commit();

    console.log('MIGRATION COMPLETED');
    for (const name of ENTITY_NAMES) console.log(`${name.toUpperCase()} INSERTED: ${postCounts[name]}`);
    console.log('SKIPPED: 0');
    console.log('FAILED: 0');
  } catch (error) {
    if (migrationStarted) {
      await connection.rollback();
      await recordFailedMigration(args, migration, error);
    }
    throw error;
  } finally {
    connection.release();
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const migration = readAndValidate(args.source);
  printPlan(args, migration);
  if (!args.apply) {
    console.log('VALIDATION PASSED; no database changes were made.');
    return;
  }
  await applyMigration(args, migration);
}

main()
  .catch(error => {
    console.error(`Migration failed: ${error.message}`);
    process.exitCode = 1;
  })
  .finally(closePool);
