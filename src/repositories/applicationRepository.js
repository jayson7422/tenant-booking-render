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
  const [companies, users, tenants, rooms, bookings, settings, oauth, cancellationRequests] = await Promise.all([
    pool.query(`SELECT id, name FROM companies WHERE id=?`, [COMPANY_ID]),
    pool.query(`SELECT u.id, u.username, u.password_hash AS passwordHash, u.employee_id AS employeeId,
      u.role FROM users u JOIN employees e ON e.id=u.employee_id WHERE e.company_id=? ORDER BY u.created_at,u.id`, [COMPANY_ID]),
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
      connected_at AS connectedAt FROM google_oauth_credentials WHERE company_id=?`, [COMPANY_ID]),
    pool.query(`SELECT id, booking_id AS bookingId, tenant_id AS tenantId,
      reason_category AS reasonCategory, note, status, requested_at AS requestedAt,
      reviewed_at AS reviewedAt, reviewed_by_user_id AS reviewedByUserId,
      reviewed_by_username AS reviewedByUsername, review_remark AS reviewRemark
      FROM booking_cancellation_requests ORDER BY requested_at DESC,id DESC`)
  ]);

  if (!companies[0].length) throw appError('Database is not initialized. Import the verified migration before starting the application.', 503);

  return {
    company: companies[0][0],
    users: users[0],
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
    } : null,
    cancellationRequests: cancellationRequests[0].map(item => ({
      ...item,
      requestedAt: dateTime(item.requestedAt),
      reviewedAt: dateTime(item.reviewedAt)
    }))
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

function bookingAuditValues(booking) {
  return {
    roomId: booking.roomId,
    roomName: booking.roomName,
    date: booking.date,
    startTime: booking.startTime,
    endTime: booking.endTime,
    hours: Number(booking.hours),
    status: booking.status
  };
}

async function insertBookingAudit(connection, entry) {
  await connection.execute(
    `INSERT INTO booking_audit_log
      (booking_id,admin_user_id,admin_username,action,reason,previous_values,new_values)
      VALUES (?,?,?,?,?,?,?)`,
    [
      entry.bookingId,
      entry.adminUserId,
      entry.adminUsername,
      entry.action,
      entry.reason || null,
      entry.previousValues ? JSON.stringify(entry.previousValues) : null,
      entry.newValues ? JSON.stringify(entry.newValues) : null
    ]
  );
}

async function insertBookingLifecycle(connection, entry) {
  await connection.execute(
    `INSERT INTO booking_lifecycle_log
      (booking_id,actor_type,actor_id,actor_name,action,reason,quota_minutes)
      VALUES (?,?,?,?,?,?,?)`,
    [entry.bookingId, entry.actorType, entry.actorId || null, entry.actorName,
      entry.action, entry.reason || null, entry.quotaMinutes == null ? null : entry.quotaMinutes]
  );
}

const bookings = {
  async findConflict(roomId, bookingDate, startTime, endTime, exceptId = null) {
    const values = [roomId, bookingDate, endTime, startTime];
    const exclusion = exceptId ? ' AND id<>?' : '';

    if (exceptId) values.push(exceptId);

    const [rows] = await pool.execute(
      `SELECT id, tenant_id AS tenantId, booking_date AS date,
        start_time AS startTime, end_time AS endTime
       FROM bookings
       WHERE room_id=? AND booking_date=? AND status='Confirmed'
         AND start_time < ? AND end_time > ?${exclusion}
       ORDER BY start_time
       LIMIT 1`,
      values
    );

    return rows[0] || null;
  },

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
      await insertBookingLifecycle(connection, {
        bookingId: booking.id,
        actorType: 'tenant',
        actorId: booking.tenantId,
        actorName: booking.tenantName,
        action: 'BOOKING_CONFIRMED',
        quotaMinutes: -durationMinutes
      });
      return { remainingHours: Math.round(((remainingMinutes - durationMinutes) / 60) * 100) / 100 };
    });
  },
  async updateConfirmedByAdmin(current, updated, audit) {
    return inTransaction(async connection => {
      const [bookingRows] = await connection.execute(
        `SELECT id,tenant_id AS tenantId,status FROM bookings WHERE id=? FOR UPDATE`,
        [current.id]
      );
      if (!bookingRows.length) throw appError('Booking not found.', 404);
      if (bookingRows[0].status !== 'Confirmed') throw appError('Only confirmed bookings can be edited.', 409);

      const [roomRows] = await connection.execute(
        'SELECT id,name FROM rooms WHERE id=? AND company_id=? FOR UPDATE',
        [updated.roomId, COMPANY_ID]
      );
      if (!roomRows.length) throw appError('Workspace no longer exists.', 409);

      const [tenantRows] = await connection.execute(
        `SELECT allotted_hours AS allottedHours FROM tenants
         WHERE id=? AND company_id=? AND status='Active' FOR UPDATE`,
        [current.tenantId, COMPANY_ID]
      );
      if (!tenantRows.length) throw appError('Tenant is no longer active.', 409);

      const durationMinutes = Math.round(numeric(updated.hours) * 60);
      const [usageRows] = await connection.execute(
        `SELECT COALESCE(SUM(duration_minutes),0) AS usedMinutes FROM bookings
         WHERE tenant_id=? AND status='Confirmed' AND id<>?`,
        [current.tenantId, current.id]
      );
      const remainingMinutes = Math.round(numeric(tenantRows[0].allottedHours) * 60) - Number(usageRows[0].usedMinutes);
      if (remainingMinutes < durationMinutes) {
        throw appError(`Only ${Math.max(0, remainingMinutes / 60).toFixed(1)} allotted hours remain for this tenant.`, 409);
      }

      const [conflicts] = await connection.execute(
        `SELECT id FROM bookings
         WHERE room_id=? AND booking_date=? AND status='Confirmed' AND id<>?
           AND start_time < ? AND end_time > ? LIMIT 1`,
        [updated.roomId, updated.date, current.id, updated.endTime, updated.startTime]
      );
      if (conflicts.length) throw appError('This time conflicts with another booking for the selected workspace. Please choose another time.', 409);

      await connection.execute(
        `UPDATE bookings SET room_id=?,room_name_snapshot=?,booking_date=?,start_time=?,end_time=?
         ,duration_minutes=?,calendar_event_id=? WHERE id=?`,
        [updated.roomId, roomRows[0].name, updated.date, updated.startTime, updated.endTime,
          durationMinutes, updated.calendarEventId || null, current.id]
      );
      await insertBookingAudit(connection, audit);
      return { remainingHours: Math.round(((remainingMinutes - durationMinutes) / 60) * 100) / 100 };
    });
  },
  async cancelByAdmin(id, remark, audit, cancelledAt) {
    return inTransaction(async connection => {
      const [rows] = await connection.execute(
        `SELECT id,status FROM bookings WHERE id=? FOR UPDATE`,
        [id]
      );
      if (!rows.length) throw appError('Booking not found.', 404);
      if (rows[0].status !== 'Confirmed') throw appError('Only confirmed bookings can be cancelled.', 409);
      await connection.execute(
        `UPDATE bookings SET status='Cancelled',cancellation_remark=?,cancelled_at=?,calendar_event_id=NULL WHERE id=?`,
        [remark, sqlDateTime(cancelledAt), id]
      );
      await insertBookingAudit(connection, audit);
    });
  },
  async remove(id) {
    await pool.execute('DELETE FROM bookings WHERE id=?', [id]);
  },
  async setCalendarEvent(id, calendarEventId) {
    await pool.execute('UPDATE bookings SET calendar_event_id=? WHERE id=?', [calendarEventId || null, id]);
  },
  async cancel(id, tenantId, remark, cancelledAt) {
    return inTransaction(async connection => {
      const [rows] = await connection.execute(
        `SELECT id,status,duration_minutes AS durationMinutes,tenant_name_snapshot AS tenantName
         FROM bookings WHERE id=? AND tenant_id=? FOR UPDATE`, [id, tenantId]
      );
      if (!rows.length) throw appError('Booking not found.', 404);
      if (rows[0].status !== 'Confirmed') throw appError('Booking is no longer confirmed.', 409);
      await connection.execute(`UPDATE bookings SET status='Cancelled',cancellation_remark=?,
        cancelled_at=?,calendar_event_id=NULL WHERE id=? AND tenant_id=? AND status='Confirmed'`,
      [remark, sqlDateTime(cancelledAt), id, tenantId]);
      await insertBookingLifecycle(connection, {
        bookingId: id,
        actorType: 'tenant',
        actorId: tenantId,
        actorName: rows[0].tenantName,
        action: 'BOOKING_CANCELLED_BY_TENANT',
        reason: remark,
        quotaMinutes: Number(rows[0].durationMinutes)
      });
    });
  }
};

function normalizeCancellationRequest(item) {
  if (!item) return null;
  return {
    ...item,
    requestedAt: dateTime(item.requestedAt),
    reviewedAt: dateTime(item.reviewedAt)
  };
}

const cancellationRequests = {
  async create(request) {
    return inTransaction(async connection => {
      const [bookingRows] = await connection.execute(
        `SELECT id,status,tenant_id AS tenantId FROM bookings
         WHERE id=? AND tenant_id=? FOR UPDATE`, [request.bookingId, request.tenantId]
      );
      if (!bookingRows.length) throw appError('Booking not found.', 404);
      if (bookingRows[0].status !== 'Confirmed') throw appError('Only confirmed bookings can be reviewed for cancellation.', 409);

      const [existingRows] = await connection.execute(
        `SELECT id,booking_id AS bookingId,tenant_id AS tenantId,
          reason_category AS reasonCategory,note,status,requested_at AS requestedAt,
          reviewed_at AS reviewedAt,reviewed_by_user_id AS reviewedByUserId,
          reviewed_by_username AS reviewedByUsername,review_remark AS reviewRemark
         FROM booking_cancellation_requests WHERE booking_id=? FOR UPDATE`, [request.bookingId]
      );
      if (existingRows.length) return { request: normalizeCancellationRequest(existingRows[0]), alreadyExists: true };

      await connection.execute(
        `INSERT INTO booking_cancellation_requests
          (id,booking_id,tenant_id,reason_category,note,status,requested_at)
         VALUES (?,?,?,?,?,?,?)`,
        [request.id, request.bookingId, request.tenantId, request.reasonCategory,
          request.note || null, 'Pending', sqlDateTime(request.requestedAt)]
      );
      await insertBookingLifecycle(connection, {
        bookingId: request.bookingId,
        actorType: 'tenant',
        actorId: request.tenantId,
        actorName: request.tenantName || request.tenantId,
        action: 'CANCELLATION_REQUESTED',
        reason: request.reasonCategory,
        quotaMinutes: null
      });
      return {
        request: normalizeCancellationRequest({
          id: request.id,
          bookingId: request.bookingId,
          tenantId: request.tenantId,
          reasonCategory: request.reasonCategory,
          note: request.note || null,
          status: 'Pending',
          requestedAt: request.requestedAt,
          reviewedAt: null,
          reviewedByUserId: null,
          reviewedByUsername: null,
          reviewRemark: null
        }),
        alreadyExists: false
      };
    });
  },

  async review(id, decision, actor, reviewRemark, cancelledAt) {
    return inTransaction(async connection => {
      const [requestRows] = await connection.execute(
        `SELECT id,booking_id AS bookingId,tenant_id AS tenantId,
          reason_category AS reasonCategory,note,status,requested_at AS requestedAt,
          reviewed_at AS reviewedAt,reviewed_by_user_id AS reviewedByUserId,
          reviewed_by_username AS reviewedByUsername,review_remark AS reviewRemark
         FROM booking_cancellation_requests WHERE id=? FOR UPDATE`, [id]
      );
      if (!requestRows.length) throw appError('Cancellation request not found.', 404);
      const currentRequest = normalizeCancellationRequest(requestRows[0]);
      if (currentRequest.status !== 'Pending') return { request: currentRequest, alreadyProcessed: true };

      const [bookingRows] = await connection.execute(
        `SELECT id,tenant_id AS tenantId,room_id AS roomId,tenant_name_snapshot AS tenantName,
          tenant_company_name_snapshot AS companyName,room_name_snapshot AS roomName,
          booking_date AS date,start_time AS startTime,end_time AS endTime,
          CAST(duration_minutes AS DOUBLE)/60 AS hours,status,calendar_event_id AS calendarEventId,
          cancellation_remark AS cancellationRemark,cancelled_at AS cancelledAt,created_at AS createdAt
         FROM bookings WHERE id=? FOR UPDATE`, [currentRequest.bookingId]
      );
      if (!bookingRows.length) throw appError('Booking not found.', 404);
      const currentBooking = {
        ...bookingRows[0],
        date: date(bookingRows[0].date),
        startTime: time(bookingRows[0].startTime),
        endTime: time(bookingRows[0].endTime),
        hours: Math.round(numeric(bookingRows[0].hours) * 100) / 100,
        calendarEventId: bookingRows[0].calendarEventId || null,
        cancellationRemark: bookingRows[0].cancellationRemark || null,
        cancelledAt: dateTime(bookingRows[0].cancelledAt),
        createdAt: dateTime(bookingRows[0].createdAt)
      };

      const nextStatus = decision === 'approve' ? 'Approved' : 'Rejected';
      if (decision === 'approve') {
        if (currentBooking.status !== 'Confirmed') throw appError('This booking is no longer active.', 409);
        await connection.execute(
          `UPDATE bookings SET status='Cancelled',cancellation_remark=?,cancelled_at=?,calendar_event_id=NULL WHERE id=? AND status='Confirmed'`,
          [`Emergency cancellation approved: ${currentRequest.reasonCategory}`, sqlDateTime(cancelledAt), currentRequest.bookingId]
        );
      }
      await connection.execute(
        `UPDATE booking_cancellation_requests SET status=?,reviewed_at=?,reviewed_by_user_id=?,
          reviewed_by_username=?,review_remark=? WHERE id=? AND status='Pending'`,
        [nextStatus, sqlDateTime(cancelledAt), actor.id, actor.username, reviewRemark || null, id]
      );
      await insertBookingAudit(connection, {
        bookingId: currentRequest.bookingId,
        adminUserId: actor.id,
        adminUsername: actor.username,
        action: decision === 'approve' ? 'CANCELLATION_APPROVED_BY_ADMIN' : 'CANCELLATION_REJECTED_BY_ADMIN',
        reason: reviewRemark || currentRequest.reasonCategory,
        previousValues: bookingAuditValues(currentBooking),
        newValues: bookingAuditValues(decision === 'approve' ? { ...currentBooking, status: 'Cancelled', calendarEventId: null } : currentBooking)
      });
      await insertBookingLifecycle(connection, {
        bookingId: currentRequest.bookingId,
        actorType: 'admin',
        actorId: actor.id,
        actorName: actor.username,
        action: decision === 'approve' ? 'CANCELLATION_APPROVED_BY_ADMIN' : 'CANCELLATION_REJECTED_BY_ADMIN',
        reason: reviewRemark || currentRequest.reasonCategory,
        quotaMinutes: decision === 'approve' ? Number(currentBooking.hours) * 60 : null
      });
      return {
        request: normalizeCancellationRequest({
          ...currentRequest,
          status: nextStatus,
          reviewedAt: cancelledAt,
          reviewedByUserId: actor.id,
          reviewedByUsername: actor.username,
          reviewRemark: reviewRemark || null
        }),
        booking: decision === 'approve' ? { ...currentBooking, status: 'Cancelled', calendarEventId: null } : currentBooking,
        calendarEventIdToDelete: decision === 'approve' ? currentBooking.calendarEventId : null,
        alreadyProcessed: false
      };
    });
  }
};

const audit = {
  async listForBooking(bookingId) {
    const [auditRows, lifecycleRows] = await Promise.all([
      pool.execute(
      `SELECT id,booking_id AS bookingId,admin_user_id AS adminUserId,
        admin_username AS adminUsername,action,reason,previous_values AS previousValues,
        new_values AS newValues,created_at AS createdAt
       FROM booking_audit_log WHERE booking_id=? ORDER BY created_at DESC,id DESC`,
      [bookingId]
      ),
      pool.execute(
        `SELECT id,booking_id AS bookingId,actor_type AS actorType,actor_id AS actorId,
          actor_name AS actorName,action,reason,quota_minutes AS quotaMinutes,created_at AS createdAt
         FROM booking_lifecycle_log WHERE booking_id=? ORDER BY created_at DESC,id DESC`, [bookingId]
      )
    ]);
    const rows = [
      ...auditRows[0],
      ...lifecycleRows[0].map(item => ({
        id: 'lifecycle-' + item.id,
        bookingId: item.bookingId,
        adminUserId: item.actorId,
        adminUsername: item.actorName,
        action: item.action,
        reason: item.reason,
        previousValues: null,
        newValues: item.quotaMinutes == null ? null : { quotaMinutes: Number(item.quotaMinutes) },
        createdAt: item.createdAt
      }))
    ].sort((left, right) => new Date(right.createdAt) - new Date(left.createdAt));
    return rows.map(item => ({
      ...item,
      previousValues: typeof item.previousValues === 'string' ? JSON.parse(item.previousValues) : item.previousValues || null,
      newValues: typeof item.newValues === 'string' ? JSON.parse(item.newValues) : item.newValues || null,
      createdAt: dateTime(item.createdAt)
    }));
  }
};

const integrations = {
  async saveGoogleOAuth(refreshTokenEncrypted, connectedAt) {
    await pool.execute(`INSERT INTO google_oauth_credentials
      (company_id,refresh_token_encrypted,connected_at) VALUES (?,?,?)
      ON DUPLICATE KEY UPDATE refresh_token_encrypted=VALUES(refresh_token_encrypted),
      connected_at=VALUES(connected_at)`, [COMPANY_ID, refreshTokenEncrypted, sqlDateTime(connectedAt)]);
  }
};

const sessions = {
  async createUserSession(tokenHash, userId, expiresAt) {
    await pool.execute(
      `INSERT INTO user_sessions
        (token_hash, user_id, expires_at)
       VALUES (?, ?, ?)`,
      [
        tokenHash,
        userId,
        sqlDateTime(expiresAt)
      ]
    );
  },

  async findUserSession(tokenHash) {
    const [rows] = await pool.execute(
      `SELECT
        user_id AS userId,
        expires_at AS expiresAt
      FROM user_sessions
      WHERE token_hash = ?
        AND expires_at > UTC_TIMESTAMP(3)
      LIMIT 1`,
      [tokenHash]
    );

    return rows[0] || null;
  },

  async removeUserSession(tokenHash) {
    await pool.execute(
      `DELETE FROM user_sessions
       WHERE token_hash = ?`,
      [tokenHash]
    );
  },

  async createTenantSession(tokenHash, tenantId, expiresAt) {
    await pool.execute(
      `INSERT INTO tenant_sessions
        (token_hash, tenant_id, expires_at)
       VALUES (?, ?, ?)`,
      [
        tokenHash,
        tenantId,
        sqlDateTime(expiresAt)
      ]
    );
  },

  async findTenantSession(tokenHash) {
    const [rows] = await pool.execute(
      `SELECT
        tenant_id AS tenantId,
        expires_at AS expiresAt
      FROM tenant_sessions
      WHERE token_hash = ?
        AND expires_at > UTC_TIMESTAMP(3)
      LIMIT 1`,
      [tokenHash]
    );

    return rows[0] || null;
  },

  async removeTenantSession(tokenHash) {
    await pool.execute(
      `DELETE FROM tenant_sessions
       WHERE token_hash = ?`,
      [tokenHash]
    );
  },

  async purgeExpired() {
    await Promise.all([
      pool.execute(
        `DELETE FROM user_sessions
        WHERE expires_at <= UTC_TIMESTAMP(3)`
      ),

      pool.execute(
        `DELETE FROM tenant_sessions
        WHERE expires_at <= UTC_TIMESTAMP(3)`
      )
    ]);
  }
};

module.exports = {
  getSnapshot,
  tenants,
  rooms,
  bookings,
  cancellationRequests,
  audit,
  sessions,
  integrations
};
