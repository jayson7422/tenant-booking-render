'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { pool, closePool } = require('../src/config/database');

const COMPANY_ID = 'company-main';
const SCHEMA_VERSION = '001';

function parseArgs(argv) {
  const args = {};
  for (const argument of argv) {
    if (argument.startsWith('--source=')) args.source = argument.slice('--source='.length);
    else if (argument.startsWith('--confirm-sha256=')) args.confirmSha256 = argument.slice('--confirm-sha256='.length).toUpperCase();
    else throw new Error(`Unknown argument: ${argument}`);
  }
  if (!args.source) throw new Error('Provide --source="path-to-backup.json"');
  if (!args.confirmSha256) throw new Error('Provide --confirm-sha256 with the approved source hash');
  return args;
}

function loadSource(args) {
  const sourcePath = path.resolve(args.source);
  const raw = fs.readFileSync(sourcePath, 'utf8');
  const sha256 = crypto.createHash('sha256').update(raw).digest('hex').toUpperCase();
  if (sha256 !== args.confirmSha256) throw new Error('Source hash does not match --confirm-sha256');
  return { data: JSON.parse(raw), sourcePath, sha256 };
}

function nullableText(value) {
  const text = String(value || '').trim();
  return text || null;
}

function number(value) {
  return Number(value || 0);
}

function date(value) {
  return value == null ? null : String(value).slice(0, 10);
}

function time(value) {
  if (value == null) return null;
  const match = /^(\d{2}):(\d{2})(?::(\d{2}))?/.exec(String(value));
  if (!match) throw new Error(`Invalid time encountered during verification`);
  return `${match[1]}:${match[2]}:${match[3] || '00'}`;
}

function dateTime(value) {
  if (value == null) return null;
  if (/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}(?:\.\d{1,3})?$/.test(String(value))) {
    return String(value).padEnd(23, '0');
  }
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) throw new Error('Invalid timestamp encountered during verification');
  return parsed.toISOString().slice(0, 23).replace('T', ' ');
}

function durationMinutes(startTime, endTime) {
  const minutes = value => {
    const [hours, mins] = String(value).split(':').map(Number);
    return hours * 60 + mins;
  };
  return minutes(endTime) - minutes(startTime);
}

function sortById(rows) {
  return [...rows].sort((left, right) => String(left.id).localeCompare(String(right.id)));
}

function assertSame(label, expected, actual) {
  if (JSON.stringify(expected) !== JSON.stringify(actual)) {
    throw new Error(`${label} mismatch (sensitive values were not displayed)`);
  }
  console.log(`MATCH: ${label}`);
}

async function rows(sql) {
  const [result] = await pool.query(sql);
  return result;
}

async function verify(source) {
  const { data, sourcePath, sha256 } = source;

  const employeeStatus = new Map(data.employees.map(item => [item.id, item.status]));
  const expected = {
    employees: sortById(data.employees.map(item => ({
      id: item.id, companyId: COMPANY_ID, code: item.code, firstName: item.firstName,
      lastName: item.lastName, department: item.department, position: item.position,
      role: item.role, monthlySalary: number(item.monthlySalary), status: item.status,
      startDate: date(item.startDate), sss: nullableText(item.sss),
      philhealth: nullableText(item.philhealth), pagibig: nullableText(item.pagibig)
    }))),
    users: sortById(data.users.map(item => ({
      id: item.id, employeeId: item.employeeId, username: item.username,
      passwordHash: item.passwordHash, role: item.role,
      isActive: employeeStatus.get(item.employeeId) === 'Active' ? 1 : 0
    }))),
    attendance: sortById(data.attendance.map(item => ({
      id: item.id, employeeId: item.employeeId, attendanceDate: date(item.date),
      timeIn: time(item.timeIn), timeOut: time(item.timeOut), status: item.status || 'Present',
      overtimeHours: number(item.overtimeHours)
    }))),
    payrolls: sortById(data.payrolls.map(item => ({
      id: item.id, employeeId: item.employeeId, period: item.period,
      overtimeHours: number(item.overtimeHours), basePay: number(item.basePay),
      overtimePay: number(item.overtimePay), allowances: number(item.allowances),
      absenceDeduction: number(item.absenceDeduction), otherDeductions: number(item.otherDeductions),
      grossPay: number(item.grossPay), sssEmployee: number(item.sssEmployee),
      sssEmployer: number(item.sssEmployer), philEmployee: number(item.philEmployee),
      philEmployer: number(item.philEmployer), pagibigEmployee: number(item.pagibigEmployee),
      pagibigEmployer: number(item.pagibigEmployer), withholding: number(item.withholding),
      totalDeduction: number(item.totalDeduction), netPay: number(item.netPay),
      employerCost: number(item.employerCost), createdAt: dateTime(item.createdAt)
    }))),
    shifts: sortById(data.shifts.map(item => ({
      id: item.id, employeeId: item.employeeId, shiftDate: date(item.date),
      startTime: time(item.startTime), endTime: time(item.endTime), jobSite: item.jobSite,
      roleLabel: item.roleLabel, color: item.color, status: item.status
    }))),
    tenants: sortById(data.tenants.map(item => ({
      id: item.id, companyId: COMPANY_ID, fullName: item.fullName,
      companyName: item.companyName || '', email: item.email, location: item.location,
      allottedHours: number(item.allottedHours), accessCodeHash: item.accessCodeHash,
      status: item.status, createdAt: dateTime(item.createdAt)
    }))),
    rooms: sortById(data.rooms.map(item => ({
      id: item.id, companyId: COMPANY_ID, name: item.name, location: item.location,
      capacity: number(item.capacity), calendarId: nullableText(item.calendarId)
    }))),
    bookings: sortById(data.bookings.map(item => ({
      id: item.id, tenantId: item.tenantId, roomId: item.roomId,
      tenantName: item.tenantName, companyName: item.companyName || '', roomName: item.roomName,
      bookingDate: date(item.date), startTime: time(item.startTime), endTime: time(item.endTime),
      durationMinutes: durationMinutes(item.startTime, item.endTime), status: item.status,
      calendarEventId: nullableText(item.calendarEventId), createdAt: dateTime(item.createdAt)
    })))
  };

  const actual = {
    employees: (await rows(`SELECT id, company_id AS companyId, code, first_name AS firstName,
      last_name AS lastName, department, position, role, CAST(monthly_salary AS DOUBLE) AS monthlySalary,
      status, start_date AS startDate, sss_number AS sss, philhealth_number AS philhealth,
      pagibig_number AS pagibig FROM employees ORDER BY id`)).map(item => ({ ...item, startDate: date(item.startDate) })),
    users: await rows(`SELECT id, employee_id AS employeeId, username, password_hash AS passwordHash,
      role, is_active AS isActive FROM users ORDER BY id`),
    attendance: (await rows(`SELECT id, employee_id AS employeeId, attendance_date AS attendanceDate,
      time_in AS timeIn, time_out AS timeOut, status, CAST(overtime_hours AS DOUBLE) AS overtimeHours
      FROM attendance ORDER BY id`)).map(item => ({ ...item, attendanceDate: date(item.attendanceDate), timeIn: time(item.timeIn), timeOut: time(item.timeOut) })),
    payrolls: (await rows(`SELECT id, employee_id AS employeeId, period,
      CAST(overtime_hours AS DOUBLE) AS overtimeHours, CAST(base_pay AS DOUBLE) AS basePay,
      CAST(overtime_pay AS DOUBLE) AS overtimePay, CAST(allowances AS DOUBLE) AS allowances,
      CAST(absence_deduction AS DOUBLE) AS absenceDeduction, CAST(other_deductions AS DOUBLE) AS otherDeductions,
      CAST(gross_pay AS DOUBLE) AS grossPay, CAST(sss_employee AS DOUBLE) AS sssEmployee,
      CAST(sss_employer AS DOUBLE) AS sssEmployer, CAST(philhealth_employee AS DOUBLE) AS philEmployee,
      CAST(philhealth_employer AS DOUBLE) AS philEmployer, CAST(pagibig_employee AS DOUBLE) AS pagibigEmployee,
      CAST(pagibig_employer AS DOUBLE) AS pagibigEmployer, CAST(withholding_tax AS DOUBLE) AS withholding,
      CAST(total_deduction AS DOUBLE) AS totalDeduction, CAST(net_pay AS DOUBLE) AS netPay,
      CAST(employer_cost AS DOUBLE) AS employerCost, created_at AS createdAt FROM payrolls ORDER BY id`))
      .map(item => ({ ...item, createdAt: dateTime(item.createdAt) })),
    shifts: (await rows(`SELECT id, employee_id AS employeeId, shift_date AS shiftDate,
      start_time AS startTime, end_time AS endTime, job_site AS jobSite, role_label AS roleLabel,
      color, status FROM shifts ORDER BY id`)).map(item => ({
        ...item, shiftDate: date(item.shiftDate), startTime: time(item.startTime), endTime: time(item.endTime)
      })),
    tenants: (await rows(`SELECT id, company_id AS companyId, full_name AS fullName,
      tenant_company_name AS companyName, email, location, CAST(allotted_hours AS DOUBLE) AS allottedHours,
      access_code_hash AS accessCodeHash, status, created_at AS createdAt FROM tenants ORDER BY id`))
      .map(item => ({ ...item, createdAt: dateTime(item.createdAt) })),
    rooms: await rows(`SELECT id, company_id AS companyId, name, location, capacity,
      calendar_id AS calendarId FROM rooms ORDER BY id`),
    bookings: (await rows(`SELECT id, tenant_id AS tenantId, room_id AS roomId,
      tenant_name_snapshot AS tenantName, tenant_company_name_snapshot AS companyName,
      room_name_snapshot AS roomName, booking_date AS bookingDate, start_time AS startTime,
      end_time AS endTime, duration_minutes AS durationMinutes, status,
      calendar_event_id AS calendarEventId, created_at AS createdAt FROM bookings ORDER BY id`))
      .map(item => ({ ...item, bookingDate: date(item.bookingDate), startTime: time(item.startTime),
        endTime: time(item.endTime), createdAt: dateTime(item.createdAt) }))
  };

  for (const entity of Object.keys(expected)) assertSame(`${entity} (${expected[entity].length})`, expected[entity], actual[entity]);

  const company = await rows(`SELECT id, name, pay_frequency AS payFrequency,
    CAST(standard_hours AS DOUBLE) AS standardHours, payroll_rules_version AS payrollRulesVersion FROM companies`);
  assertSame('company settings', [{ id: COMPANY_ID, name: data.company.name, payFrequency: data.company.payFrequency,
    standardHours: number(data.company.standardHours), payrollRulesVersion: data.company.payrollRulesVersion }], company);

  const settings = await rows('SELECT company_id AS companyId, timezone FROM booking_settings');
  assertSame('booking settings', [{ companyId: COMPANY_ID, timezone: data.bookingSettings.timezone || 'Asia/Manila' }], settings);

  const oauth = (await rows(`SELECT company_id AS companyId, refresh_token_encrypted AS refreshTokenEncrypted,
    encryption_scheme AS encryptionScheme, connected_at AS connectedAt FROM google_oauth_credentials`))
    .map(item => ({ ...item, connectedAt: dateTime(item.connectedAt) }));
  const expectedOauth = data.googleOAuth?.refreshTokenEncrypted ? [{ companyId: COMPANY_ID,
    refreshTokenEncrypted: data.googleOAuth.refreshTokenEncrypted, encryptionScheme: 'aes-256-gcm-v1',
    connectedAt: dateTime(data.googleOAuth.connectedAt) }] : [];
  assertSame('Google OAuth encrypted credential', expectedOauth, oauth);

  const orphanChecks = await rows(`SELECT
    (SELECT COUNT(*) FROM users u LEFT JOIN employees e ON e.id=u.employee_id WHERE e.id IS NULL) AS userOrphans,
    (SELECT COUNT(*) FROM shifts s LEFT JOIN employees e ON e.id=s.employee_id WHERE e.id IS NULL) AS shiftOrphans,
    (SELECT COUNT(*) FROM bookings b LEFT JOIN tenants t ON t.id=b.tenant_id WHERE b.tenant_id IS NOT NULL AND t.id IS NULL) AS tenantOrphans,
    (SELECT COUNT(*) FROM bookings b LEFT JOIN rooms r ON r.id=b.room_id WHERE r.id IS NULL) AS roomOrphans`);
  assertSame('foreign-key relationship audit', [{ userOrphans: 0, shiftOrphans: 0, tenantOrphans: 0, roomOrphans: 0 }], orphanChecks);

  const migrationRuns = await pool.execute(
    `SELECT source_environment AS sourceEnvironment, source_path AS sourcePath, source_sha256 AS sourceSha256,
      schema_version AS schemaVersion, status FROM migration_runs WHERE source_sha256=? AND schema_version=?`,
    [sha256, SCHEMA_VERSION]
  );
  assertSame('completed migration audit', [{ sourceEnvironment: 'server', sourcePath,
    sourceSha256: sha256, schemaVersion: SCHEMA_VERSION, status: 'completed' }], migrationRuns[0]);

  console.log(`SOURCE SHA256: ${sha256}`);
  console.log('VERIFICATION PASSED: all source records and relationships match the database.');
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  await verify(loadSource(args));
}

main()
  .catch(error => {
    console.error(`Verification failed: ${error.message}`);
    process.exitCode = 1;
  })
  .finally(closePool);
