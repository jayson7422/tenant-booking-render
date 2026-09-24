'use strict';

const fs = require('fs');
const path = require('path');

const baseUrl = process.env.QA_BASE_URL || 'http://127.0.0.1:5177';
const bookingUrl = process.env.QA_BOOKING_URL || 'http://127.0.0.1:6500';
const statePath = path.join(__dirname, '..', 'backups', 'checkpoint5-qa-state.json');

function required(name) {
  if (!process.env[name]) throw new Error(`Set ${name} for the local QA run`);
  return process.env[name];
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

async function request(url, options = {}, expected = [200]) {
  const response = await fetch(url, {
    ...options,
    headers: { 'Content-Type': 'application/json', ...options.headers }
  });
  const text = await response.text();
  let result = {};
  try { result = text ? JSON.parse(text) : {}; } catch { result = { text }; }
  if (!expected.includes(response.status)) {
    throw new Error(`${options.method || 'GET'} ${url} returned ${response.status}: ${result.error || text}`);
  }
  return { status: response.status, body: result };
}

async function login(username, password, expected = [200]) {
  return request(`${baseUrl}/api/login`, {
    method: 'POST',
    body: JSON.stringify({ username, password })
  }, expected);
}

function auth(token) {
  return { Authorization: `Bearer ${token}` };
}

function tenantAuth(token) {
  return { 'X-Tenant-Token': token };
}

function saveState(state) {
  fs.mkdirSync(path.dirname(statePath), { recursive: true });
  fs.writeFileSync(statePath, JSON.stringify(state, null, 2));
}

async function createPhase() {
  const adminUsername = required('QA_ADMIN_USERNAME');
  const adminPassword = required('QA_ADMIN_PASSWORD');
  const managerUsername = required('QA_MANAGER_USERNAME');
  const managerPassword = required('QA_MANAGER_PASSWORD');
  const employeeUsername = required('QA_EMPLOYEE_USERNAME');
  const employeePassword = required('QA_EMPLOYEE_PASSWORD');

  const coreHealth = await request(`${baseUrl}/health`);
  const proxyHealth = await request(`${bookingUrl}/health`);
  assert(coreHealth.body.persistence === 'mariadb', 'Core health does not report MariaDB persistence');
  assert(proxyHealth.body.service === 'tenant-booking', 'Booking proxy health failed');

  const adminLogin = await login(adminUsername, adminPassword);
  const managerLogin = await login(managerUsername, managerPassword);
  const employeeLogin = await login(employeeUsername, employeePassword);
  const invalidLogin = await login(adminUsername, 'TEST_invalid_password', [401]);
  assert(adminLogin.body.user.role === 'admin', 'Admin role mismatch');
  assert(managerLogin.body.user.role === 'manager', 'Manager role mismatch');
  assert(employeeLogin.body.user.role === 'employee', 'Employee role mismatch');
  assert(invalidLogin.status === 401, 'Invalid login was not rejected');

  const adminToken = adminLogin.body.token;
  const managerToken = managerLogin.body.token;
  const employeeToken = employeeLogin.body.token;
  await request(`${baseUrl}/api/employees`, { headers: auth(managerToken) });
  await request(`${baseUrl}/api/employees`, { headers: auth(employeeToken) }, [403]);
  await request(`${baseUrl}/api/employees`, {
    method: 'POST', headers: auth(managerToken), body: JSON.stringify({})
  }, [403]);

  const initial = (await request(`${baseUrl}/api/booking-admin`, { headers: auth(adminToken) })).body;
  assert(initial.tenants.some(item => item.fullName === 'Jayson'), 'Expected tenant Jayson is missing');
  assert(['Astra 1', 'Astra 2', 'Rocket Room'].every(name => initial.rooms.some(item => item.name === name)), 'Expected rooms are missing');
  assert(initial.bookings.some(item => item.roomName === 'Rocket Room' && item.date === '2026-09-17'), 'Expected Rocket Room booking is missing');

  const suffix = Date.now().toString(36);
  const state = {
    suffix,
    baseline: {
      tenants: initial.tenants.length,
      rooms: initial.rooms.length,
      bookings: initial.bookings.length
    },
    tenant: {
      email: `test_${suffix}@example.invalid`,
      accessCode: `TEST_access_${suffix}`
    },
    employee: {
      username: `test_employee_${suffix}`,
      password: `TEST_password_${suffix}`
    }
  };
  saveState(state);

  const tenant = (await request(`${baseUrl}/api/tenants`, {
    method: 'POST', headers: auth(adminToken), body: JSON.stringify({
      fullName: `TEST_Tenant_${suffix}`,
      companyName: `TEST_Company_${suffix}`,
      email: state.tenant.email,
      location: 'TEST_Location',
      allottedHours: 4,
      accessCode: state.tenant.accessCode,
      status: 'Active'
    })
  }, [201])).body;
  state.tenant.id = tenant.id;
  saveState(state);

  const editedTenant = (await request(`${baseUrl}/api/tenants/${tenant.id}`, {
    method: 'PUT', headers: auth(adminToken), body: JSON.stringify({ ...tenant, companyName: `TEST_Company_${suffix}_EDITED`, accessCode: '' })
  })).body;
  assert(editedTenant.companyName.endsWith('_EDITED'), 'Tenant edit did not persist');

  const room = (await request(`${baseUrl}/api/rooms`, {
    method: 'POST', headers: auth(adminToken), body: JSON.stringify({
      name: `TEST_Room_${suffix}`, location: 'TEST_Location', capacity: 6, calendarId: ''
    })
  }, [201])).body;
  state.room = { id: room.id };
  saveState(state);

  const editedRoom = (await request(`${baseUrl}/api/rooms/${room.id}`, {
    method: 'PUT', headers: auth(adminToken), body: JSON.stringify({ ...room, name: `TEST_Room_${suffix}_EDITED`, capacity: 8 })
  })).body;
  assert(editedRoom.capacity === 8, 'Room edit did not persist');

  const employee = (await request(`${baseUrl}/api/employees`, {
    method: 'POST', headers: auth(adminToken), body: JSON.stringify({
      code: `TEST-${suffix}`,
      firstName: 'TEST_First',
      lastName: `TEST_Last_${suffix}`,
      department: 'TEST_Department',
      position: 'TEST_Position',
      role: 'employee',
      monthlySalary: 25000,
      status: 'Active',
      startDate: '2099-01-01',
      username: state.employee.username,
      password: state.employee.password
    })
  }, [201])).body;
  state.employee.id = employee.id;
  saveState(state);
  const testEmployeeLogin = await login(state.employee.username, state.employee.password);
  assert(testEmployeeLogin.body.user.employee.id === employee.id, 'Created employee cannot authenticate');

  const attendance = (await request(`${baseUrl}/api/attendance`, {
    method: 'POST', headers: auth(adminToken), body: JSON.stringify({
      employeeId: employee.id, date: '2099-11-29', timeIn: '09:00', timeOut: '17:00', status: 'Present', overtimeHours: 0
    })
  }, [201])).body;
  state.attendanceId = attendance.id;
  saveState(state);

  const shift = (await request(`${baseUrl}/api/shifts`, {
    method: 'POST', headers: auth(managerToken), body: JSON.stringify({
      employeeId: employee.id, date: '2099-11-30', startTime: '09:00', endTime: '17:00',
      jobSite: 'TEST_Site', roleLabel: 'TEST_Shift', color: 'teal', status: 'Published'
    })
  }, [201])).body;
  state.shiftId = shift.id;
  saveState(state);

  const payroll = (await request(`${baseUrl}/api/payrolls`, {
    method: 'POST', headers: auth(adminToken), body: JSON.stringify({
      employeeId: employee.id, period: '2099-11', overtimeHours: 0,
      allowances: 100, absenceDeduction: 0, otherDeductions: 0
    })
  }, [201])).body;
  state.payrollId = payroll.id;
  saveState(state);

  const tenantLogin = await request(`${bookingUrl}/api/tenant/login`, {
    method: 'POST', body: JSON.stringify({ email: state.tenant.email, accessCode: state.tenant.accessCode })
  });
  const tenantToken = tenantLogin.body.token;
  const availability = await request(`${bookingUrl}/api/tenant/availability?roomId=${encodeURIComponent(room.id)}&date=2099-12-01&startTime=09%3A00&endTime=10%3A00`, {
    headers: tenantAuth(tenantToken)
  });
  assert(availability.body.available === true, 'Test room should be available');

  const cancelledBooking = (await request(`${bookingUrl}/api/tenant/bookings`, {
    method: 'POST', headers: tenantAuth(tenantToken), body: JSON.stringify({
      roomId: room.id, date: '2099-12-01', startTime: '09:00', endTime: '10:00'
    })
  }, [201])).body.booking;
  state.cancelledBookingId = cancelledBooking.id;
  saveState(state);
  const cancellation = await request(`${bookingUrl}/api/tenant/bookings/${cancelledBooking.id}/cancel`, {
    method: 'POST', headers: tenantAuth(tenantToken), body: JSON.stringify({ remark: 'TEST_Cancellation' })
  });
  assert(cancellation.body.booking.status === 'Cancelled', 'Booking cancellation failed');
  assert(cancellation.body.remainingHours === 4, 'Cancelled booking hours were not restored');

  const activeBooking = (await request(`${bookingUrl}/api/tenant/bookings`, {
    method: 'POST', headers: tenantAuth(tenantToken), body: JSON.stringify({
      roomId: room.id, date: '2099-12-01', startTime: '10:00', endTime: '11:00'
    })
  }, [201])).body.booking;
  state.activeBookingId = activeBooking.id;
  saveState(state);
  await request(`${bookingUrl}/api/tenant/bookings`, {
    method: 'POST', headers: tenantAuth(tenantToken), body: JSON.stringify({
      roomId: room.id, date: '2099-12-01', startTime: '10:00', endTime: '11:00'
    })
  }, [409]);

  const portal = (await request(`${bookingUrl}/api/tenant/me`, { headers: tenantAuth(tenantToken) })).body;
  assert(portal.tenant.remainingHours === 3, 'Used or remaining hours are incorrect');
  assert(portal.bookings.some(item => item.id === activeBooking.id && item.status === 'Confirmed'), 'Active test booking is missing');
  const googleStatus = (await request(`${bookingUrl}/api/google/status`, { headers: auth(adminToken) })).body;
  assert(typeof googleStatus.configured === 'boolean' && typeof googleStatus.connected === 'boolean', 'Google OAuth status endpoint failed');

  console.log('CREATE PHASE PASSED');
  console.log(`State file: ${statePath}`);
  console.log('Restart both Node services, then run --phase=verify-cleanup.');
}

async function verifyAndCleanupPhase() {
  const state = JSON.parse(fs.readFileSync(statePath, 'utf8'));
  const adminLogin = await login(required('QA_ADMIN_USERNAME'), required('QA_ADMIN_PASSWORD'));
  const adminToken = adminLogin.body.token;
  const admin = (await request(`${baseUrl}/api/booking-admin`, { headers: auth(adminToken) })).body;
  assert(admin.tenants.some(item => item.id === state.tenant.id), 'Test tenant did not survive restart');
  assert(admin.rooms.some(item => item.id === state.room.id), 'Test room did not survive restart');
  assert(admin.bookings.some(item => item.id === state.activeBookingId), 'Test booking did not survive restart');
  assert(admin.bookings.some(item => item.id === state.cancelledBookingId && item.status === 'Cancelled'), 'Cancelled booking audit did not survive restart');

  const employeeLogin = await login(state.employee.username, state.employee.password);
  assert(employeeLogin.body.user.employee.id === state.employee.id, 'Test employee login did not survive restart');
  const tenantLogin = await request(`${bookingUrl}/api/tenant/login`, {
    method: 'POST', body: JSON.stringify({ email: state.tenant.email, accessCode: state.tenant.accessCode })
  });
  const portal = (await request(`${bookingUrl}/api/tenant/me`, { headers: tenantAuth(tenantLogin.body.token) })).body;
  assert(portal.tenant.remainingHours === 3, 'Tenant usage did not survive restart');

  await request(`${baseUrl}/api/bookings/${state.activeBookingId}`, { method: 'DELETE', headers: auth(adminToken) });
  await request(`${baseUrl}/api/bookings/${state.cancelledBookingId}`, { method: 'DELETE', headers: auth(adminToken) });
  await request(`${baseUrl}/api/payrolls/${state.payrollId}`, { method: 'DELETE', headers: auth(adminToken) });
  await request(`${baseUrl}/api/attendance/${state.attendanceId}`, { method: 'DELETE', headers: auth(adminToken) });
  await request(`${baseUrl}/api/shifts/${state.shiftId}`, { method: 'DELETE', headers: auth(adminToken) });
  await request(`${baseUrl}/api/employees/${state.employee.id}`, { method: 'DELETE', headers: auth(adminToken) });
  await request(`${baseUrl}/api/rooms/${state.room.id}`, { method: 'DELETE', headers: auth(adminToken) });
  await request(`${baseUrl}/api/tenants/${state.tenant.id}`, { method: 'DELETE', headers: auth(adminToken) });

  const final = (await request(`${baseUrl}/api/booking-admin`, { headers: auth(adminToken) })).body;
  assert(final.tenants.length === state.baseline.tenants, 'Tenant count did not return to baseline');
  assert(final.rooms.length === state.baseline.rooms, 'Room count did not return to baseline');
  assert(final.bookings.length === state.baseline.bookings, 'Booking count did not return to baseline');
  assert(final.tenants.some(item => item.fullName === 'Jayson'), 'Legitimate tenant was changed during QA');
  assert(['Astra 1', 'Astra 2', 'Rocket Room'].every(name => final.rooms.some(item => item.name === name)), 'Legitimate rooms were changed during QA');

  fs.unlinkSync(statePath);
  console.log('POST-RESTART VERIFICATION AND CLEANUP PASSED');
  console.log('All TEST_ records were removed; legitimate records remain.');
}

async function main() {
  const phase = process.argv.find(value => value.startsWith('--phase='))?.split('=')[1];
  if (phase === 'create') return createPhase();
  if (phase === 'verify-cleanup') return verifyAndCleanupPhase();
  throw new Error('Use --phase=create or --phase=verify-cleanup');
}

main().catch(error => {
  console.error(`Local QA failed: ${error.message}`);
  process.exitCode = 1;
});
