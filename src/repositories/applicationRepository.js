'use strict';

const { pool } = require('../config/database');

const COMPANY_ID = 'company-main';

function numeric(value) {
  return Number(value || 0);
}

function date(value) {
  return value == null ? null : String(value).slice(0, 10);
}

function time(value) {
  return value == null ? null : String(value).slice(0, 5);
}

function dateTime(value) {
  if (!value) return null;
  const text = String(value);
  if (text.includes('T')) return new Date(text).toISOString();
  return new Date(`${text.replace(' ', 'T')}Z`).toISOString();
}

function sqlDateTime(value) {
  if (!value) return null;
  return new Date(value).toISOString().slice(0, 23).replace('T', ' ');
}

function appError(message, statusCode = 400) {
  const error = new Error(message);
  error.statusCode = statusCode;
  return error;
}

function translateDatabaseError(error) {
  if (error.statusCode) return error;
  if (error.code === 'ER_DUP_ENTRY') return appError('A record with the same unique value already exists.', 409);
  if (error.code === 'ER_ROW_IS_REFERENCED_2') return appError('This record has related history and cannot be deleted.', 409);
  if (error.code === 'ER_NO_REFERENCED_ROW_2') return appError('A related record no longer exists.', 409);
  return error;
}

async function inTransaction(callback) {
  const connection = await pool.getConnection();
  try {
    await connection.beginTransaction();
    const result = await callback(connection);
    await connection.commit();
    return result;
  } catch (error) {
    await connection.rollback();
    throw translateDatabaseError(error);
  } finally {
    connection.release();
  }
}

async function getSnapshot() {
  const [companies, employees, users, attendance, payrolls, shifts, tenants, rooms, bookings, settings, oauth] = await Promise.all([
    pool.query(`SELECT id, name, pay_frequency AS payFrequency,
      CAST(standard_hours AS DOUBLE) AS standardHours, payroll_rules_version AS payrollRulesVersion
      FROM companies WHERE id=?`, [COMPANY_ID]),
    pool.query(`SELECT id, code, first_name AS firstName, last_name AS lastName, department,
      position, role, CAST(monthly_salary AS DOUBLE) AS monthlySalary, status,
      start_date AS startDate, sss_number AS sss, philhealth_number AS philhealth,
      pagibig_number AS pagibig FROM employees WHERE company_id=? ORDER BY created_at,id`, [COMPANY_ID]),
    pool.query(`SELECT u.id, u.username, u.password_hash AS passwordHash, u.employee_id AS employeeId,
      u.role FROM users u JOIN employees e ON e.id=u.employee_id WHERE e.company_id=? ORDER BY u.created_at,u.id`, [COMPANY_ID]),
    pool.query(`SELECT a.id, a.employee_id AS employeeId, a.attendance_date AS date,
      a.time_in AS timeIn, a.time_out AS timeOut, a.status,
      CAST(a.overtime_hours AS DOUBLE) AS overtimeHours
      FROM attendance a JOIN employees e ON e.id=a.employee_id WHERE e.company_id=?
      ORDER BY a.attendance_date,a.created_at,a.id`, [COMPANY_ID]),
    pool.query(`SELECT p.id, p.employee_id AS employeeId, p.period,
      CAST(p.overtime_hours AS DOUBLE) AS overtimeHours, CAST(p.base_pay AS DOUBLE) AS basePay,
      CAST(p.overtime_pay AS DOUBLE) AS overtimePay, CAST(p.allowances AS DOUBLE) AS allowances,
      CAST(p.absence_deduction AS DOUBLE) AS absenceDeduction,
      CAST(p.other_deductions AS DOUBLE) AS otherDeductions, CAST(p.gross_pay AS DOUBLE) AS grossPay,
      CAST(p.sss_employee AS DOUBLE) AS sssEmployee, CAST(p.sss_employer AS DOUBLE) AS sssEmployer,
      CAST(p.philhealth_employee AS DOUBLE) AS philEmployee,
      CAST(p.philhealth_employer AS DOUBLE) AS philEmployer,
      CAST(p.pagibig_employee AS DOUBLE) AS pagibigEmployee,
      CAST(p.pagibig_employer AS DOUBLE) AS pagibigEmployer,
      CAST(p.withholding_tax AS DOUBLE) AS withholding,
      CAST(p.total_deduction AS DOUBLE) AS totalDeduction, CAST(p.net_pay AS DOUBLE) AS netPay,
      CAST(p.employer_cost AS DOUBLE) AS employerCost, p.created_at AS createdAt
      FROM payrolls p JOIN employees e ON e.id=p.employee_id WHERE e.company_id=?
      ORDER BY p.created_at,p.id`, [COMPANY_ID]),
    pool.query(`SELECT s.id, s.employee_id AS employeeId, s.shift_date AS date,
      s.start_time AS startTime, s.end_time AS endTime, s.job_site AS jobSite,
      s.role_label AS roleLabel, s.color, s.status
      FROM shifts s JOIN employees e ON e.id=s.employee_id WHERE e.company_id=?
      ORDER BY s.shift_date,s.start_time,s.id`, [COMPANY_ID]),
    pool.query(`SELECT id, full_name AS fullName, tenant_company_name AS companyName,
      email, location, CAST(allotted_hours AS DOUBLE) AS allottedHours,
      access_code_hash AS accessCodeHash, status, created_at AS createdAt
      FROM tenants WHERE company_id=? ORDER BY created_at,id`, [COMPANY_ID]),
    pool.query(`SELECT id, name, location, capacity, calendar_id AS calendarId
      FROM rooms WHERE company_id=? ORDER BY created_at,id`, [COMPANY_ID]),
    pool.query(`SELECT b.id, b.tenant_id AS tenantId, b.tenant_name_snapshot AS tenantName,
      b.tenant_company_name_snapshot AS companyName, b.room_id AS roomId,
      b.room_name_snapshot AS roomName, b.booking_date AS date,
      b.start_time AS startTime, b.end_time AS endTime,
      CAST(b.duration_minutes AS DOUBLE)/60 AS hours, b.status,
      b.calendar_event_id AS calendarEventId, b.cancellation_remark AS cancellationRemark,
      b.cancelled_at AS cancelledAt, b.created_at AS createdAt
      FROM bookings b JOIN rooms r ON r.id=b.room_id WHERE r.company_id=?
      ORDER BY b.created_at,b.id`, [COMPANY_ID]),
    pool.query('SELECT timezone FROM booking_settings WHERE company_id=?', [COMPANY_ID]),
    pool.query(`SELECT refresh_token_encrypted AS refreshTokenEncrypted,
      connected_at AS connectedAt FROM google_oauth_credentials WHERE company_id=?`, [COMPANY_ID])
  ]);

  if (!companies[0].length) throw appError('Database is not initialized. Import the verified migration before starting the application.', 503);

  return {
    company: companies[0][0],
    employees: employees[0].map(item => ({ ...item, startDate: date(item.startDate) })),
    users: users[0],
    attendance: attendance[0].map(item => ({ ...item, date: date(item.date), timeIn: time(item.timeIn), timeOut: time(item.timeOut) })),
    payrolls: payrolls[0].map(item => ({ ...item, createdAt: dateTime(item.createdAt) })),
    shifts: shifts[0].map(item => ({ ...item, date: date(item.date), startTime: time(item.startTime), endTime: time(item.endTime) })),
    tenants: tenants[0].map(item => ({ ...item, createdAt: dateTime(item.createdAt) })),
    rooms: rooms[0].map(item => ({ ...item, calendarId: item.calendarId || '' })),
    bookings: bookings[0].map(item => ({
      ...item,
      date: date(item.date),
      startTime: time(item.startTime),
      endTime: time(item.endTime),
      hours: Math.round(numeric(item.hours) * 100) / 100,
      calendarEventId: item.calendarEventId || null,
      cancellationRemark: item.cancellationRemark || null,
      cancelledAt: dateTime(item.cancelledAt),
      createdAt: dateTime(item.createdAt)
    })),
    bookingSettings: settings[0][0] || { timezone: 'Asia/Manila' },
    googleOAuth: oauth[0][0] ? {
      refreshTokenEncrypted: oauth[0][0].refreshTokenEncrypted,
      connectedAt: dateTime(oauth[0][0].connectedAt)
    } : null
  };
}

const tenants = {
  async create(tenant) {
    try {
      await pool.execute(`INSERT INTO tenants
        (id,company_id,full_name,tenant_company_name,email,location,allotted_hours,access_code_hash,status,created_at)
        VALUES (?,?,?,?,?,?,?,?,?,?)`, [tenant.id, COMPANY_ID, tenant.fullName, tenant.companyName || '',
        tenant.email, tenant.location, numeric(tenant.allottedHours), tenant.accessCodeHash,
        tenant.status, sqlDateTime(tenant.createdAt)]);
    } catch (error) { throw translateDatabaseError(error); }
  },
  async update(tenant) {
    try {
      await pool.execute(`UPDATE tenants SET full_name=?,tenant_company_name=?,email=?,location=?,
        allotted_hours=?,access_code_hash=?,status=? WHERE id=? AND company_id=?`,
      [tenant.fullName, tenant.companyName || '', tenant.email, tenant.location, numeric(tenant.allottedHours),
        tenant.accessCodeHash, tenant.status, tenant.id, COMPANY_ID]);
    } catch (error) { throw translateDatabaseError(error); }
  },
  async remove(id) {
    try { await pool.execute('DELETE FROM tenants WHERE id=? AND company_id=?', [id, COMPANY_ID]); }
    catch (error) { throw translateDatabaseError(error); }
  }
};

const rooms = {
  async create(room) {
    try {
      await pool.execute(`INSERT INTO rooms (id,company_id,name,location,capacity,calendar_id)
        VALUES (?,?,?,?,?,?)`, [room.id, COMPANY_ID, room.name, room.location, numeric(room.capacity), room.calendarId || null]);
    } catch (error) { throw translateDatabaseError(error); }
  },
  async update(room) {
    try {
      await pool.execute(`UPDATE rooms SET name=?,location=?,capacity=?,calendar_id=?
        WHERE id=? AND company_id=?`, [room.name, room.location, numeric(room.capacity), room.calendarId || null,
        room.id, COMPANY_ID]);
    } catch (error) { throw translateDatabaseError(error); }
  },
  async remove(id) {
    try { await pool.execute('DELETE FROM rooms WHERE id=? AND company_id=?', [id, COMPANY_ID]); }
    catch (error) { throw translateDatabaseError(error); }
  }
};

function bookingValues(booking) {
  return [booking.id, booking.tenantId, booking.roomId, booking.tenantName, booking.companyName || '',
    booking.roomName, booking.date, booking.startTime, booking.endTime,
    Math.round(numeric(booking.hours) * 60), booking.status, booking.calendarEventId || null,
    booking.cancellationRemark || null, sqlDateTime(booking.cancelledAt), sqlDateTime(booking.createdAt)];
}

const bookings = {
  async createConfirmed(booking) {
    return inTransaction(async connection => {
      const [tenantRows] = await connection.execute(
        `SELECT allotted_hours AS allottedHours FROM tenants
         WHERE id=? AND company_id=? AND status='Active' FOR UPDATE`, [booking.tenantId, COMPANY_ID]
      );
      if (!tenantRows.length) throw appError('Tenant is no longer active.', 409);
      const [roomRows] = await connection.execute(
        'SELECT id FROM rooms WHERE id=? AND company_id=? FOR UPDATE', [booking.roomId, COMPANY_ID]
      );
      if (!roomRows.length) throw appError('Room no longer exists.', 409);
      const durationMinutes = Math.round(numeric(booking.hours) * 60);
      const [usageRows] = await connection.execute(
        `SELECT COALESCE(SUM(duration_minutes),0) AS usedMinutes FROM bookings
         WHERE tenant_id=? AND status='Confirmed'`, [booking.tenantId]
      );
      const remainingMinutes = Math.round(numeric(tenantRows[0].allottedHours) * 60) - Number(usageRows[0].usedMinutes);
      if (remainingMinutes < durationMinutes) throw appError(`Only ${Math.max(0, remainingMinutes / 60).toFixed(1)} allotted hours remain.`, 409);
      const [conflicts] = await connection.execute(
        `SELECT id FROM bookings WHERE room_id=? AND booking_date=? AND status='Confirmed'
         AND start_time < ? AND end_time > ? LIMIT 1`,
        [booking.roomId, booking.date, booking.endTime, booking.startTime]
      );
      if (conflicts.length) throw appError('This room has just been booked for that time. Please choose another time.', 409);
      await connection.execute(`INSERT INTO bookings
        (id,tenant_id,room_id,tenant_name_snapshot,tenant_company_name_snapshot,room_name_snapshot,
         booking_date,start_time,end_time,duration_minutes,status,calendar_event_id,
         cancellation_remark,cancelled_at,created_at)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`, bookingValues(booking));
      return { remainingHours: Math.round(((remainingMinutes - durationMinutes) / 60) * 100) / 100 };
    });
  },
  async setCalendarEvent(id, calendarEventId) {
    await pool.execute('UPDATE bookings SET calendar_event_id=? WHERE id=?', [calendarEventId || null, id]);
  },
  async cancel(id, tenantId, remark, cancelledAt) {
    const [result] = await pool.execute(`UPDATE bookings SET status='Cancelled',cancellation_remark=?,
      cancelled_at=?,calendar_event_id=NULL WHERE id=? AND tenant_id=? AND status='Confirmed'`,
    [remark, sqlDateTime(cancelledAt), id, tenantId]);
    if (!result.affectedRows) throw appError('Booking is no longer confirmed.', 409);
  },
  async remove(id) {
    await pool.execute('DELETE FROM bookings WHERE id=?', [id]);
  }
};

const shifts = {
  async create(shift, connection = pool) {
    try {
      await connection.execute(`INSERT INTO shifts
        (id,employee_id,shift_date,start_time,end_time,job_site,role_label,color,status)
        VALUES (?,?,?,?,?,?,?,?,?)`, [shift.id, shift.employeeId, shift.date, shift.startTime,
        shift.endTime, shift.jobSite, shift.roleLabel, shift.color, shift.status]);
    } catch (error) { throw translateDatabaseError(error); }
  },
  async createMany(items) {
    return inTransaction(async connection => {
      for (const item of items) await shifts.create(item, connection);
    });
  },
  async update(shift) {
    try {
      await pool.execute(`UPDATE shifts SET employee_id=?,shift_date=?,start_time=?,end_time=?,
        job_site=?,role_label=?,color=?,status=? WHERE id=?`, [shift.employeeId, shift.date,
        shift.startTime, shift.endTime, shift.jobSite, shift.roleLabel, shift.color, shift.status, shift.id]);
    } catch (error) { throw translateDatabaseError(error); }
  },
  async remove(id) { await pool.execute('DELETE FROM shifts WHERE id=?', [id]); }
};

const employees = {
  async createWithUser(employee, user) {
    return inTransaction(async connection => {
      await connection.execute(`INSERT INTO employees
        (id,company_id,code,first_name,last_name,department,position,role,monthly_salary,status,
         start_date,sss_number,philhealth_number,pagibig_number)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`, [employee.id, COMPANY_ID, employee.code, employee.firstName,
        employee.lastName, employee.department, employee.position, employee.role, numeric(employee.monthlySalary),
        employee.status, employee.startDate || null, employee.sss || null, employee.philhealth || null, employee.pagibig || null]);
      await connection.execute(`INSERT INTO users (id,employee_id,username,password_hash,role,is_active)
        VALUES (?,?,?,?,?,?)`, [user.id, employee.id, user.username, user.passwordHash, user.role, employee.status === 'Active']);
    });
  },
  async updateWithUser(employee, user) {
    return inTransaction(async connection => {
      await connection.execute(`UPDATE employees SET code=?,first_name=?,last_name=?,department=?,position=?,
        role=?,monthly_salary=?,status=?,start_date=?,sss_number=?,philhealth_number=?,pagibig_number=?
        WHERE id=? AND company_id=?`, [employee.code, employee.firstName, employee.lastName, employee.department,
        employee.position, employee.role, numeric(employee.monthlySalary), employee.status, employee.startDate || null,
        employee.sss || null, employee.philhealth || null, employee.pagibig || null, employee.id, COMPANY_ID]);
      if (user) await connection.execute(`UPDATE users SET password_hash=?,role=?,is_active=? WHERE id=?`,
        [user.passwordHash, user.role, employee.status === 'Active', user.id]);
    });
  },
  async removeWithUser(id) {
    return inTransaction(async connection => {
      await connection.execute('DELETE FROM users WHERE employee_id=?', [id]);
      await connection.execute('DELETE FROM employees WHERE id=? AND company_id=?', [id, COMPANY_ID]);
    });
  }
};

const attendance = {
  async create(record) {
    try {
      await pool.execute(`INSERT INTO attendance
        (id,employee_id,attendance_date,time_in,time_out,status,overtime_hours)
        VALUES (?,?,?,?,?,?,?)`, [record.id, record.employeeId, record.date, record.timeIn || null,
        record.timeOut || null, record.status, numeric(record.overtimeHours)]);
    } catch (error) { throw translateDatabaseError(error); }
  },
  async update(record) {
    try {
      await pool.execute(`UPDATE attendance SET employee_id=?,attendance_date=?,time_in=?,time_out=?,
        status=?,overtime_hours=? WHERE id=?`, [record.employeeId, record.date, record.timeIn || null,
        record.timeOut || null, record.status, numeric(record.overtimeHours), record.id]);
    } catch (error) { throw translateDatabaseError(error); }
  },
  async remove(id) { await pool.execute('DELETE FROM attendance WHERE id=?', [id]); }
};

const payrolls = {
  async create(payroll) {
    try {
      await pool.execute(`INSERT INTO payrolls
        (id,employee_id,period,overtime_hours,base_pay,overtime_pay,allowances,absence_deduction,
         other_deductions,gross_pay,sss_employee,sss_employer,philhealth_employee,philhealth_employer,
         pagibig_employee,pagibig_employer,withholding_tax,total_deduction,net_pay,employer_cost,created_at)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`, [payroll.id, payroll.employeeId, payroll.period,
        numeric(payroll.overtimeHours), numeric(payroll.basePay), numeric(payroll.overtimePay), numeric(payroll.allowances),
        numeric(payroll.absenceDeduction), numeric(payroll.otherDeductions), numeric(payroll.grossPay),
        numeric(payroll.sssEmployee), numeric(payroll.sssEmployer), numeric(payroll.philEmployee),
        numeric(payroll.philEmployer), numeric(payroll.pagibigEmployee), numeric(payroll.pagibigEmployer),
        numeric(payroll.withholding), numeric(payroll.totalDeduction), numeric(payroll.netPay),
        numeric(payroll.employerCost), sqlDateTime(payroll.createdAt)]);
    } catch (error) { throw translateDatabaseError(error); }
  },
  async remove(id) { await pool.execute('DELETE FROM payrolls WHERE id=?', [id]); }
};

const integrations = {
  async saveGoogleOAuth(refreshTokenEncrypted, connectedAt) {
    await pool.execute(`INSERT INTO google_oauth_credentials
      (company_id,refresh_token_encrypted,connected_at) VALUES (?,?,?)
      ON DUPLICATE KEY UPDATE refresh_token_encrypted=VALUES(refresh_token_encrypted),
      connected_at=VALUES(connected_at)`, [COMPANY_ID, refreshTokenEncrypted, sqlDateTime(connectedAt)]);
  }
};

module.exports = {
  getSnapshot,
  tenants,
  rooms,
  bookings,
  shifts,
  employees,
  attendance,
  payrolls,
  integrations
};
