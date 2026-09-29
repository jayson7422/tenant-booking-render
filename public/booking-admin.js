const root = document.querySelector('#admin');
const modal = document.querySelector('#modal');
const loader = document.getElementById('lp-loader');
const $ = selector => document.querySelector(selector);

let token = localStorage.bookingAdminToken || '';
let state = null;
let bookingPage = 1;
let bookingFilters = { search: '', status: 'All', roomId: '', date: '' };
const bookingPageSize = 10;

const esc = value => String(value ?? '').replace(/[&<>"']/g, character => ({
  '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
}[character]));
const showLoader = () => loader && loader.classList.remove('hidden');
const hideLoader = () => loader && loader.classList.add('hidden');
window.addEventListener('DOMContentLoaded', () => setTimeout(hideLoader, 300));
window.addEventListener('pageshow', () => setTimeout(hideLoader, 150));

async function api(url, options = {}) {
  const response = await fetch(url, {
    ...options,
    headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + token, ...options.headers }
  });
  let payload = {};
  try { payload = await response.json(); } catch { payload = {}; }
  if (!response.ok) {
    const error = new Error(payload.error || 'Request failed. Please try again.');
    error.status = response.status;
    error.code = payload.code;
    throw error;
  }
  return payload;
}

function friendlyError(error) {
  if (error && error.code === 'BOOKING_START_IN_PAST') return 'The booking start time is already in the past in Philippine time.';
  return error && error.message || 'Something went wrong. Please try again.';
}

function login() {
  root.innerHTML = '<section class="login"><form class="login-card" id="login">' +
    '<div class="brand">Launchpad<i> Tenant</i></div><div class="eyebrow">Booking administration</div>' +
    '<h1>Manage tenant bookings.</h1><div class="sub">Sign in with a system administrator account.</div>' +
    '<div class="field"><label for="login-username">Username</label><input id="login-username" name="username" autocomplete="username" required></div>' +
    '<div class="field"><label for="login-password">Password</label><input id="login-password" name="password" type="password" autocomplete="current-password" required></div>' +
    '<button class="primary" id="login-btn" style="width:100%;margin-top:8px">Sign in</button><div class="error" id="error"></div>' +
    '</form></section>';
  const formElement = $('#login');
  const button = $('#login-btn');
  const errorElement = $('#error');
  let submitting = false;
  formElement.onsubmit = async event => {
    event.preventDefault();
    if (submitting) return;
    submitting = true; button.disabled = true; button.textContent = 'Signing in...'; errorElement.textContent = ''; showLoader();
    try {
      const result = await api('/api/login', { method: 'POST', body: JSON.stringify(Object.fromEntries(new FormData(event.target))) });
      if (result.user.role !== 'admin') throw new Error('Only system administrators can manage tenant bookings.');
      token = result.token; localStorage.bookingAdminToken = token; await load();
    } catch (error) {
      hideLoader(); errorElement.textContent = friendlyError(error); button.disabled = false; button.textContent = 'Sign in'; submitting = false;
    }
  };
}

async function load() {
  showLoader();
  try { state = await api('/api/booking-admin'); render(); }
  catch (error) {
    hideLoader();
    if (error.status === 401 || error.status === 403 || error.message === 'Only admins can manage tenant bookings' || error.message === 'Please sign in') {
      localStorage.removeItem('bookingAdminToken'); token = ''; login();
    } else alert(friendlyError(error));
  }
}

function formatHours(value) { return Number(value || 0).toFixed(1) + ' h'; }
function formatPhtDateTime(value) {
  if (!value) return '—';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return String(value);
  return new Intl.DateTimeFormat('en-PH', { timeZone: 'Asia/Manila', dateStyle: 'medium', timeStyle: 'short' }).format(date);
}
function bookingStatusClass(status) { return 'status-' + String(status || '').toLowerCase().replace(/\s+/g, '-'); }
function bookingTenant(booking) { return booking.tenant?.fullName || booking.tenantName || 'Unknown tenant'; }
function bookingRoom(booking) { return booking.room?.name || booking.roomName || 'Unknown workspace'; }

function render() {
  const allotted = state.tenants.reduce((total, tenant) => total + Number(tenant.allottedHours || 0), 0);
  const used = state.tenants.reduce((total, tenant) => total + Number(tenant.usedHours || 0), 0);
  const confirmed = state.bookings.filter(booking => booking.status === 'Confirmed').length;
  const reviews = state.bookings.filter(booking => booking.needsReview).length;
  const statusOptions = ['All', 'Upcoming', 'Ongoing', 'Completed', 'Cancelled'].map(status =>
    '<option value="' + status + '"' + (bookingFilters.status === status ? ' selected' : '') + '>' + status + '</option>').join('');
  const roomOptions = state.rooms.map(room =>
    '<option value="' + esc(room.id) + '"' + (bookingFilters.roomId === room.id ? ' selected' : '') + '>' + esc(room.name) + '</option>').join('');
  const tenantRows = state.tenants.length ? state.tenants.map(tenant =>
    '<tr><td><span class="name">' + esc(tenant.fullName) + '</span><br><small>' + esc(tenant.companyName || '—') + '</small></td>' +
    '<td>' + esc(tenant.email) + '<br><small>' + esc(tenant.location) + '</small></td><td>' + formatHours(tenant.allottedHours) + '</td>' +
    '<td>' + formatHours(tenant.usedHours) + '</td><td><span class="pill">' + formatHours(tenant.remainingHours) + '</span></td><td>' +
    '<button class="outline edit-tenant" data-id="' + esc(tenant.id) + '">Edit</button><button class="outline email-tenant" data-id="' + esc(tenant.id) + '">Report</button>' +
    '<button class="danger delete-tenant" data-id="' + esc(tenant.id) + '">Delete</button></td></tr>').join('') :
    '<tr><td class="sub" colspan="6">No tenants yet.</td></tr>';
  const roomRows = state.rooms.length ? state.rooms.map(room =>
    '<tr><td class="name">' + esc(room.name) + '</td><td>' + esc(room.location) + '</td><td>' + esc(room.capacity || '—') + '</td>' +
    '<td>' + (room.calendarId ? 'Room calendar' : 'Company default') + '</td><td><button class="outline edit-room" data-id="' + esc(room.id) + '">Edit</button>' +
    '<button class="danger delete-room" data-id="' + esc(room.id) + '">Delete</button></td></tr>').join('') :
    '<tr><td class="sub" colspan="5">No rooms yet.</td></tr>';

  root.innerHTML = '<div class="shell">' +
    '<header class="top"><div class="brand">Launchpad<i> Tenant</i></div><div class="top-right"><span class="pill">Booking admin</span><button class="outline" id="out">Sign out</button></div></header>' +
    '<section class="panel-head"><div><h1>Tenant booking control</h1><p>Tenant portal: <a href="/" target="_blank" rel="noreferrer">' + esc(location.origin) + '</a></p></div>' +
    '<div class="actions"><button class="outline" id="add-room">+ Add room</button><button class="primary" id="add-tenant">+ Add tenant</button></div></section>' +
    '<section class="stats"><div class="card metric"><small>Active tenants</small><b>' + state.tenants.filter(tenant => tenant.status === 'Active').length + '</b></div>' +
    '<div class="card metric"><small>Confirmed bookings</small><b>' + confirmed + '</b></div><div class="card metric"><small>Needs review</small><b class="' + (reviews ? 'metric-warning' : '') + '">' + reviews + '</b></div>' +
    '<div class="card metric"><small>Hours used / allotted</small><b>' + used.toFixed(1) + ' / ' + allotted.toFixed(1) + '</b><span class="' + (state.calendarConnected ? 'ok' : 'warn') + '">' +
    (state.calendarConnected ? 'Calendar connected' : 'Local availability only') + '</span></div></section>' +
    '<section class="section"><h2>Tenant accounts</h2><div class="table-wrap"><table class="table"><thead><tr><th>Tenant / company</th><th>Email &amp; location</th><th>Allotted</th><th>Used</th><th>Remaining</th><th></th></tr></thead><tbody>' +
    tenantRows + '</tbody></table></div></section>' +
    '<section class="section"><h2>Available rooms</h2><div class="table-wrap"><table class="table"><thead><tr><th>Room</th><th>Location</th><th>Capacity</th><th>Calendar</th><th></th></tr></thead><tbody>' +
    roomRows + '</tbody></table></div></section>' +
    '<section class="section" id="bookings-section"><div class="section-heading"><div><h2>Booking oversight</h2><p class="section-note">Search, inspect, update, or cancel bookings. Cancellation preserves the record for audit history.</p></div><button class="outline" id="refresh-bookings">Refresh</button></div>' +
    '<div class="booking-filters"><label class="filter-field filter-search"><span>Search</span><input id="booking-search" type="search" placeholder="Tenant, email, room, or booking ID" value="' + esc(bookingFilters.search) + '"></label>' +
    '<label class="filter-field"><span>Status</span><select id="booking-status">' + statusOptions + '</select></label><label class="filter-field"><span>Workspace</span><select id="booking-room"><option value="">All workspaces</option>' + roomOptions + '</select></label>' +
    '<label class="filter-field"><span>Exact date</span><input id="booking-date" type="date" value="' + esc(bookingFilters.date) + '"></label><button class="outline clear-filters" id="clear-booking-filters">Clear filters</button></div>' +
    '<div id="booking-summary" class="booking-summary"></div><div id="booking-list"></div></section></div>';

  $('#out').onclick = () => { localStorage.removeItem('bookingAdminToken'); token = ''; login(); };
  $('#add-tenant').onclick = () => tenantForm();
  $('#add-room').onclick = () => roomForm();
  document.querySelectorAll('.edit-tenant').forEach(button => { button.onclick = () => tenantForm(state.tenants.find(tenant => tenant.id === button.dataset.id)); });
  document.querySelectorAll('.edit-room').forEach(button => { button.onclick = () => roomForm(state.rooms.find(room => room.id === button.dataset.id)); });
  document.querySelectorAll('.delete-tenant').forEach(button => { button.onclick = () => remove('/api/tenants/' + button.dataset.id, 'Delete this tenant? Related booking history will remain.'); });
  document.querySelectorAll('.delete-room').forEach(button => { button.onclick = () => remove('/api/rooms/' + button.dataset.id, 'Delete this room?'); });
  document.querySelectorAll('.email-tenant').forEach(button => { button.onclick = () => sendReport(button.dataset.id); });
  bindBookingFilters(); renderBookingList(); hideLoader();
}

function bindBookingFilters() {
  $('#booking-search').oninput = event => { bookingFilters.search = event.target.value; bookingPage = 1; renderBookingList(); };
  $('#booking-status').onchange = event => { bookingFilters.status = event.target.value; bookingPage = 1; renderBookingList(); };
  $('#booking-room').onchange = event => { bookingFilters.roomId = event.target.value; bookingPage = 1; renderBookingList(); };
  $('#booking-date').onchange = event => { bookingFilters.date = event.target.value; bookingPage = 1; renderBookingList(); };
  $('#clear-booking-filters').onclick = () => {
    bookingFilters = { search: '', status: 'All', roomId: '', date: '' }; bookingPage = 1;
    $('#booking-search').value = ''; $('#booking-status').value = 'All'; $('#booking-room').value = ''; $('#booking-date').value = '';
    renderBookingList();
  };
  $('#refresh-bookings').onclick = () => load();
}

function filteredBookings() {
  const search = bookingFilters.search.trim().toLowerCase();
  return state.bookings.filter(booking => {
    const tenant = booking.tenant || {};
    const searchable = [booking.id, bookingTenant(booking), tenant.email, tenant.companyName, bookingRoom(booking), booking.roomName].join(' ').toLowerCase();
    return (!search || searchable.includes(search)) && (bookingFilters.status === 'All' || booking.bookingState === bookingFilters.status) &&
      (!bookingFilters.roomId || booking.roomId === bookingFilters.roomId) && (!bookingFilters.date || booking.date === bookingFilters.date);
  });
}

function renderBookingList() {
  const bookings = filteredBookings();
  const pageCount = Math.max(1, Math.ceil(bookings.length / bookingPageSize));
  bookingPage = Math.min(bookingPage, pageCount);
  const visible = bookings.slice((bookingPage - 1) * bookingPageSize, bookingPage * bookingPageSize);
  const summary = $('#booking-summary'); const list = $('#booking-list');
  if (!summary || !list) return;
  summary.textContent = bookings.length + ' booking' + (bookings.length === 1 ? '' : 's') + ' found' + (bookings.length ? ' · Page ' + bookingPage + ' of ' + pageCount : '');
  const rows = visible.length ? visible.map(booking =>
    '<tr><td><span class="name">' + esc(bookingTenant(booking)) + '</span><br><small>' + esc(booking.tenant?.email || '') + '</small></td><td>' + esc(bookingRoom(booking)) + '</td>' +
    '<td>' + esc(booking.date) + '</td><td>' + esc(booking.startTime) + '–' + esc(booking.endTime) + '</td><td>' + formatHours(booking.hours) + '</td>' +
    '<td><span class="status-badge ' + bookingStatusClass(booking.bookingState) + '">' + esc(booking.bookingState) + '</span></td><td>' +
    (booking.needsReview ? '<span class="review-badge warning" title="' + esc(booking.reviewReason) + '">Needs review</span>' : '<span class="review-badge">Looks good</span>') + '</td><td class="row-actions">' +
    '<button class="outline booking-details" data-id="' + esc(booking.id) + '">Details</button>' +
    (booking.status === 'Confirmed' ? '<button class="outline booking-edit" data-id="' + esc(booking.id) + '">Edit</button><button class="danger booking-cancel" data-id="' + esc(booking.id) + '">Cancel</button>' : '') +
    '</td></tr>').join('') : '<tr><td class="sub" colspan="8">No bookings match these filters.</td></tr>';
  list.innerHTML = '<div class="table-wrap"><table class="table booking-table"><thead><tr><th>Tenant</th><th>Workspace</th><th>Date</th><th>Time</th><th>Duration</th><th>Status</th><th>Review</th><th>Actions</th></tr></thead><tbody>' +
    rows + '</tbody></table></div><div class="pagination"><button class="outline" id="booking-prev"' + (bookingPage <= 1 ? ' disabled' : '') + '>Previous</button><span>Page ' + bookingPage + ' of ' + pageCount + '</span><button class="outline" id="booking-next"' +
    (bookingPage >= pageCount ? ' disabled' : '') + '>Next</button></div>';
  document.querySelectorAll('.booking-details').forEach(button => { button.onclick = () => bookingDetails(button.dataset.id); });
  document.querySelectorAll('.booking-edit').forEach(button => { button.onclick = () => editBooking(state.bookings.find(booking => booking.id === button.dataset.id)); });
  document.querySelectorAll('.booking-cancel').forEach(button => { button.onclick = () => cancelBooking(state.bookings.find(booking => booking.id === button.dataset.id)); });
  $('#booking-prev').onclick = () => { if (bookingPage > 1) { bookingPage--; renderBookingList(); } };
  $('#booking-next').onclick = () => { if (bookingPage < pageCount) { bookingPage++; renderBookingList(); } };
}

function modalMarkup(content) {
  modal.innerHTML = '<div class="modal-bg" id="modal-bg"><div class="modal-card">' + content + '</div></div>';
  $('#modal-bg').onclick = event => { if (event.target.id === 'modal-bg') closeModal(); };
}
function closeModal() { modal.innerHTML = ''; }
function modalActions(cancelLabel, saveLabel) { return '<div class="modal-actions"><button type="button" class="outline" id="modal-cancel">' + (cancelLabel || 'Cancel') + '</button><button class="primary" id="modal-submit">' + (saveLabel || 'Save') + '</button></div>'; }
function fieldMarkup(field) {
  const value = field.value ?? '';
  const common = '<div class="field ' + (field.full ? 'field-full' : '') + '"><label for="' + esc(field.name) + '">' + esc(field.label) + '</label>';
  const help = field.help ? '<small class="field-help">' + esc(field.help) + '</small>' : '';
  if (field.type === 'textarea') return common + '<textarea id="' + esc(field.name) + '" name="' + esc(field.name) + '" rows="' + (field.rows || 3) + '" ' + (field.required ? 'required' : '') + '>' + esc(value) + '</textarea>' + help + '</div>';
  if (field.type === 'select') return common + '<select id="' + esc(field.name) + '" name="' + esc(field.name) + '" ' + (field.required ? 'required' : '') + '>' +
    field.options.map(option => '<option value="' + esc(option.value ?? option) + '"' + (String(option.value ?? option) === String(value) ? ' selected' : '') + '>' + esc(option.label ?? option) + '</option>').join('') + '</select>' + help + '</div>';
  return common + '<input id="' + esc(field.name) + '" name="' + esc(field.name) + '" type="' + esc(field.type || 'text') + '" value="' + esc(value) + '" ' +
    (field.required ? 'required' : '') + (field.min != null ? ' min="' + esc(field.min) + '"' : '') + (field.step != null ? ' step="' + esc(field.step) + '"' : '') + '>' + help + '</div>';
}

function form(title, fields, submit, saveLabel) {
  saveLabel = saveLabel || 'Save';
  modalMarkup('<form class="modal-form" id="generic-form"><h2>' + esc(title) + '</h2><div class="form-grid">' + fields.map(fieldMarkup).join('') +
    '</div><div class="modal-error error" id="modal-error"></div>' + modalActions('Cancel', saveLabel) + '</form>');
  $('#modal-cancel').onclick = closeModal;
  const formElement = $('#generic-form');
  formElement.onsubmit = async event => {
    event.preventDefault(); if (formElement.dataset.busy === 'true') return;
    formElement.dataset.busy = 'true'; $('#modal-submit').disabled = true; $('#modal-submit').textContent = 'Saving...'; $('#modal-error').textContent = '';
    try { await submit(Object.fromEntries(new FormData(formElement))); closeModal(); await load(); }
    catch (error) { $('#modal-error').textContent = friendlyError(error); formElement.dataset.busy = 'false'; $('#modal-submit').disabled = false; $('#modal-submit').textContent = saveLabel; }
  };
}
function tenantForm(tenant = {}) {
  form(tenant.id ? 'Edit tenant' : 'Add tenant', [
    { name: 'fullName', label: 'Full name', value: tenant.fullName, required: true }, { name: 'companyName', label: 'Company name', value: tenant.companyName },
    { name: 'email', label: 'Email address', type: 'email', value: tenant.email, required: true }, { name: 'location', label: 'Location', value: tenant.location, required: true },
    { name: 'allottedHours', label: 'Allotted hours', type: 'number', value: tenant.allottedHours ?? 0, required: true, min: 0, step: 0.5 },
    { name: 'status', label: 'Status', type: 'select', options: ['Active', 'Inactive'], value: tenant.status || 'Active' },
    { name: 'accessCode', label: tenant.id ? 'New access code (optional)' : 'Tenant access code', type: 'password', required: !tenant.id }
  ], values => api(tenant.id ? '/api/tenants/' + tenant.id : '/api/tenants', { method: tenant.id ? 'PUT' : 'POST', body: JSON.stringify(values) }));
}
function roomForm(room = {}) {
  form(room.id ? 'Edit room' : 'Add room', [
    { name: 'name', label: 'Room name', value: room.name, required: true }, { name: 'location', label: 'Location', value: room.location, required: true },
    { name: 'capacity', label: 'Capacity', type: 'number', value: room.capacity || '', min: 0, step: 1 }, { name: 'calendarId', label: 'Google Calendar ID (optional)', value: room.calendarId || '' }
  ], values => api(room.id ? '/api/rooms/' + room.id : '/api/rooms', { method: room.id ? 'PUT' : 'POST', body: JSON.stringify(values) }));
}
async function sendReport(tenantId) {
  if (!state.emailConfigured) return alert('SMTP is not configured on the server.');
  if (!confirm('Send this tenant their usage report?')) return;
  try { const result = await api('/api/tenant-reports/' + tenantId + '/send', { method: 'POST' }); alert('Usage report sent to ' + result.to + '.'); }
  catch (error) { alert(friendlyError(error)); }
}
async function remove(url, message) {
  if (!confirm(message)) return;
  try { await api(url, { method: 'DELETE' }); await load(); } catch (error) { alert(friendlyError(error)); }
}

function detailRows(booking) {
  return [['Booking ID', booking.id], ['Tenant', booking.tenant?.fullName || booking.tenantName], ['Tenant email', booking.tenant?.email || '—'],
    ['Workspace', booking.room?.name || booking.roomName], ['Location', booking.room?.location || '—'], ['Date', booking.date],
    ['Time', booking.startTime + '–' + booking.endTime], ['Duration', formatHours(booking.hours)], ['Booking status', booking.status],
    ['Lifecycle state', booking.bookingState], ['Created', formatPhtDateTime(booking.createdAt)], ['Cancellation remark', booking.cancellationRemark || '—']];
}
function auditValues(values) {
  if (!values) return '<span class="sub">No recorded values</span>';
  const labels = [['Workspace', values.roomName || values.roomId], ['Date', values.date],
    ['Time', values.startTime && values.endTime ? values.startTime + '–' + values.endTime : '—'],
    ['Duration', values.hours != null ? formatHours(values.hours) : '—'], ['Status', values.status]];
  return '<div class="audit-values">' + labels.filter(item => item[1] != null).map(item => '<span><b>' + esc(item[0]) + '</b> ' + esc(item[1]) + '</span>').join('') + '</div>';
}

async function bookingDetails(id) {
  modalMarkup('<div class="modal-loading">Loading booking details...</div>');
  try {
    const result = await api('/api/bookings/' + id); const booking = result.booking; const audit = result.audit || [];
    const auditHtml = audit.length ? audit.map(entry => '<article class="audit-entry"><div class="audit-entry-head"><strong>' +
      esc(entry.action.replaceAll('_', ' ')) + '</strong><span>' + esc(formatPhtDateTime(entry.createdAt)) + '</span></div><div class="audit-meta">By ' +
      esc(entry.adminUsername || entry.adminUserId || 'administrator') + (entry.reason ? ' · ' + esc(entry.reason) : '') + '</div><div class="audit-change"><div><small>Before</small>' +
      auditValues(entry.previousValues) + '</div><div><small>After</small>' + auditValues(entry.newValues) + '</div></div></article>').join('') :
      '<p class="sub">No admin changes have been recorded for this booking.</p>';
    const details = detailRows(booking).map(row => '<div><small>' + esc(row[0]) + '</small><strong>' + esc(row[1] ?? '—') + '</strong></div>').join('');
    modalMarkup('<div class="modal-title-row"><div><div class="eyebrow">Booking details</div><h2>' + esc(bookingTenant(booking)) + '</h2></div><span class="status-badge ' +
      bookingStatusClass(booking.bookingState) + '">' + esc(booking.bookingState) + '</span></div>' +
      (booking.needsReview ? '<div class="review-callout warning"><b>Needs review</b><br>' + esc(booking.reviewReason) + '</div>' :
        '<div class="review-callout"><b>Data checks passed.</b> No current relationship or overlap issue was detected.</div>') +
      '<div class="detail-grid">' + details + '</div><section class="audit-section"><h3>Admin audit history</h3>' + auditHtml + '</section>' +
      '<div class="modal-actions"><button type="button" class="outline" id="modal-cancel">Close</button>' +
      (booking.status === 'Confirmed' ? '<button type="button" class="outline" id="details-edit">Edit booking</button><button type="button" class="primary" id="details-cancel">Cancel booking</button>' : '') + '</div>');
    $('#modal-cancel').onclick = closeModal;
    if (booking.status === 'Confirmed') { $('#details-edit').onclick = () => editBooking(booking); $('#details-cancel').onclick = () => cancelBooking(booking); }
  } catch (error) {
    modalMarkup('<h2>Unable to load booking</h2><div class="error">' + esc(friendlyError(error)) + '</div>' + modalActions('Close', 'Try again'));
    $('#modal-cancel').onclick = closeModal; $('#modal-submit').onclick = () => bookingDetails(id);
  }
}

function editBooking(booking) {
  if (!booking || booking.status !== 'Confirmed') return;
  const roomOptions = state.rooms.map(room => ({ value: room.id, label: room.name }));
  modalMarkup('<form class="modal-form" id="booking-edit-form"><div class="eyebrow">Exception management</div><h2>Edit booking</h2>' +
    '<p class="modal-intro">Use this only to correct an anomaly or an approved schedule change. The tenant allowance and workspace conflict checks still apply.</p><div class="form-grid">' +
    fieldMarkup({ name: 'roomId', label: 'Workspace', type: 'select', value: booking.roomId, options: roomOptions, required: true }) +
    fieldMarkup({ name: 'date', label: 'Booking date', type: 'date', value: booking.date, required: true }) +
    fieldMarkup({ name: 'startTime', label: 'Start time', type: 'time', value: booking.startTime, required: true }) +
    fieldMarkup({ name: 'endTime', label: 'End time', type: 'time', value: booking.endTime, required: true }) +
    fieldMarkup({ name: 'reason', label: 'Reason for change', type: 'textarea', value: '', required: true, full: true, help: 'This is saved in the audit history.' }) +
    '</div><div class="modal-error error" id="modal-error"></div>' + modalActions('Cancel', 'Save changes') + '</form>');
  $('#modal-cancel').onclick = closeModal;
  const formElement = $('#booking-edit-form');
  formElement.onsubmit = async event => {
    event.preventDefault(); if (formElement.dataset.busy === 'true') return;
    formElement.dataset.busy = 'true'; $('#modal-submit').disabled = true; $('#modal-submit').textContent = 'Saving...'; $('#modal-error').textContent = '';
    try { await api('/api/bookings/' + booking.id, { method: 'PATCH', body: JSON.stringify(Object.fromEntries(new FormData(formElement))) }); closeModal(); await load(); }
    catch (error) { $('#modal-error').textContent = friendlyError(error); formElement.dataset.busy = 'false'; $('#modal-submit').disabled = false; $('#modal-submit').textContent = 'Save changes'; }
  };
}

function cancelBooking(booking) {
  if (!booking || booking.status !== 'Confirmed') return;
  modalMarkup('<form class="modal-form danger-modal" id="booking-cancel-form"><div class="eyebrow">Exception management</div><h2>Cancel booking?</h2>' +
    '<p class="modal-intro">This keeps the booking in history and releases its reserved interval. It cannot be restored automatically.</p><div class="cancel-summary"><b>' +
    esc(bookingTenant(booking)) + '</b><span>' + esc(bookingRoom(booking)) + ' · ' + esc(booking.date) + ' · ' + esc(booking.startTime) + '–' + esc(booking.endTime) + '</span></div>' +
    fieldMarkup({ name: 'remark', label: 'Cancellation reason', type: 'textarea', required: true, full: true, rows: 4 }) +
    '<label class="check-field"><input name="confirm" type="checkbox" value="yes" required><span>I understand this will cancel the booking while preserving its audit record.</span></label>' +
    '<div class="modal-error error" id="modal-error"></div>' + modalActions('Keep booking', 'Cancel booking') + '</form>');
  $('#modal-cancel').onclick = closeModal;
  const formElement = $('#booking-cancel-form');
  formElement.onsubmit = async event => {
    event.preventDefault(); if (formElement.dataset.busy === 'true') return;
    formElement.dataset.busy = 'true'; $('#modal-submit').disabled = true; $('#modal-submit').textContent = 'Cancelling...'; $('#modal-error').textContent = '';
    try {
      const values = Object.fromEntries(new FormData(formElement));
      await api('/api/bookings/' + booking.id + '/cancel', { method: 'POST', body: JSON.stringify({ remark: values.remark }) });
      closeModal(); await load();
    } catch (error) { $('#modal-error').textContent = friendlyError(error); formElement.dataset.busy = 'false'; $('#modal-submit').disabled = false; $('#modal-submit').textContent = 'Cancel booking'; }
  };
}

token ? load() : login();
