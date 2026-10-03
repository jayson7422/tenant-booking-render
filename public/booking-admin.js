const root = document.querySelector('#admin');
const modal = document.querySelector('#modal');
const loader = document.getElementById('lp-loader');
const $ = selector => document.querySelector(selector);

let token = localStorage.bookingAdminToken || '';
let state = null;
let adminIdentity = null;
let bookingPage = 1;
let bookingFilters = { search: '', status: 'All', roomId: '', date: '' };
let bookingReviewOnly = false;
let tenantPage = 1;
let roomPage = 1;
let managementFilters = { tenantSearch: '', roomSearch: '' };
let activeSection = localStorage.bookingAdminSection || 'overview';
let analyticsRange = 30;
let pollTimer = null;
let pollInFlight = false;
let pendingBackgroundRender = false;
const bookingPageSize = 10;
const managementPageSize = 10;
const adminPollInterval = 45000;

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
      token = result.token; adminIdentity = result.user; localStorage.bookingAdminToken = token; await load();
    } catch (error) {
      hideLoader(); errorElement.textContent = friendlyError(error); button.disabled = false; button.textContent = 'Sign in'; submitting = false;
    }
  };
}

async function load(options = {}) {
  showLoader();
  try {
    const nextState = await api('/api/booking-admin');
    if (!adminIdentity) {
      try { adminIdentity = await api('/api/me'); } catch { adminIdentity = { id: 'current-admin', username: 'administrator' }; }
    }
    const isBackground = options.background === true && state;
    state = nextState;
    updateNotificationState(nextState);
    if (isBackground && modal.innerHTML) {
      pendingBackgroundRender = true;
      updateLiveStatus();
      hideLoader();
    } else {
      render();
    }
    scheduleAdminPolling();
  }
  catch (error) {
    hideLoader();
    if (options.background) return;
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
function dateOnly(value) {
  const text = String(value || '');
  if (/^\d{4}-\d{2}-\d{2}$/.test(text)) return text;
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? text.slice(0, 10) : localDateOnly(parsed);
}
function localDateOnly(value = new Date()) {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Manila' }).format(value);
}
function dateOffset(base, offset) {
  const date = new Date(base + 'T00:00:00+08:00');
  date.setUTCDate(date.getUTCDate() + offset);
  return date.toISOString().slice(0, 10);
}
function shortDate(value) {
  if (!value) return '—';
  const date = new Date(value + 'T00:00:00+08:00');
  return new Intl.DateTimeFormat('en-PH', { timeZone: 'Asia/Manila', month: 'short', day: 'numeric' }).format(date);
}
function relativeTime(value) {
  const elapsed = Math.max(0, Date.now() - new Date(value || Date.now()).getTime());
  const minutes = Math.floor(elapsed / 60000);
  if (minutes < 1) return 'Just now';
  if (minutes < 60) return minutes + ' min ago';
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return hours + ' hr ago';
  const days = Math.floor(hours / 24);
  return days + ' day' + (days === 1 ? '' : 's') + ' ago';
}
function notificationStorageKey() {
  return 'launchpadAdminNotifications:' + (adminIdentity?.id || adminIdentity?.username || 'current-admin');
}
function notificationKey(booking, type) {
  return type + ':' + booking.id + ':' + (type === 'cancelled' ? (booking.cancelledAt || booking.status) : '1');
}
function notificationItems(source = state) {
  if (!source) return [];
  return source.bookings
    .flatMap(booking => {
      const items = [{
        key: notificationKey(booking, 'created'), type: 'New booking', bookingId: booking.id,
        title: bookingTenant(booking) + ' booked ' + bookingRoom(booking),
        detail: shortDate(booking.date) + ' · ' + booking.startTime + '–' + booking.endTime,
        timestamp: booking.createdAt
      }];
      if (booking.status === 'Cancelled') items.push({
        key: notificationKey(booking, 'cancelled'), type: 'Booking cancelled', bookingId: booking.id,
        title: bookingTenant(booking) + ' cancelled a booking',
        detail: shortDate(booking.date) + ' · ' + bookingRoom(booking),
        timestamp: booking.cancelledAt || booking.createdAt
      });
      if (booking.needsReview) items.push({
        key: notificationKey(booking, 'review'), type: 'Needs review', bookingId: booking.id,
        title: 'Review booking for ' + bookingTenant(booking), detail: booking.reviewReason || 'Data checks found an exception.',
        timestamp: booking.createdAt
      });
      return items;
    })
    .sort((left, right) => new Date(right.timestamp || 0) - new Date(left.timestamp || 0))
    .slice(0, 20);
}
function readNotificationState() {
  try { return JSON.parse(localStorage.getItem(notificationStorageKey()) || 'null') || null; } catch { return null; }
}
function writeNotificationState(value) { localStorage.setItem(notificationStorageKey(), JSON.stringify(value)); }
function updateNotificationState(source = state) {
  const items = notificationItems(source);
  const stored = readNotificationState();
  if (!stored) {
    writeNotificationState({ seen: items.map(item => item.key), initializedAt: new Date().toISOString() });
  } else {
    writeNotificationState({ ...stored, seen: Array.from(new Set([...(stored.seen || []), ...[]])).slice(-100) });
  }
}
function unreadNotifications() {
  const stored = readNotificationState() || { seen: [] };
  return notificationItems().filter(item => !stored.seen.includes(item.key));
}
function markNotificationsRead() {
  const stored = readNotificationState() || { seen: [] };
  writeNotificationState({ ...stored, seen: Array.from(new Set([...(stored.seen || []), ...notificationItems().map(item => item.key)])).slice(-100) });
}
function scheduleAdminPolling() {
  if (pollTimer) return;
  pollTimer = window.setInterval(() => {
    if (document.hidden || pollInFlight || !token) return;
    pollInFlight = true;
    load({ background: true }).finally(() => { pollInFlight = false; });
  }, adminPollInterval);
}
function updateLiveStatus() {
  const element = $('#live-status');
  if (element) element.textContent = 'Updated ' + relativeTime(new Date().toISOString()).toLowerCase();
}
function sectionFromElementId(id) {
  if (id === 'bookings-section') return 'bookings';
  return id || 'overview';
}

function applyAdminSection() {
  const validSections = ['overview', 'tenants', 'rooms', 'activity', 'bookings'];
  if (!validSections.includes(activeSection)) activeSection = 'overview';
  document.querySelectorAll('[data-admin-section]').forEach(section => {
    const visible = section.dataset.adminSection === activeSection;
    section.hidden = !visible;
    section.setAttribute('aria-hidden', String(!visible));
  });
  document.querySelectorAll('[data-admin-section-link]').forEach(link => {
    const selected = link.dataset.adminSectionLink === activeSection;
    link.classList.toggle('is-active', selected);
    if (selected) link.setAttribute('aria-current', 'page');
    else link.removeAttribute('aria-current');
  });
  localStorage.bookingAdminSection = activeSection;
}

function setAdminSection(section) {
  activeSection = sectionFromElementId(section);
  applyAdminSection();
  const heading = document.querySelector(`[data-admin-section="${activeSection}"]`);
  heading?.scrollIntoView({ behavior: 'smooth', block: 'start' });
}

function scrollToSection(id) { setAdminSection(sectionFromElementId(id)); }

function renderLegacy() {
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

  root.innerHTML = '<div class="admin-layout"><aside class="admin-sidebar" aria-label="Primary navigation"><div class="sidebar-brand">Launchpad<i> Spaces</i><small>Operations console</small></div><div class="sidebar-label">Workspace</div><nav class="sidebar-nav" aria-label="Admin sections"><button type="button" data-admin-section-link="overview"><span class="nav-icon">⌂</span>Overview</button><button type="button" data-admin-section-link="tenants"><span class="nav-icon">◉</span>Tenants</button><button type="button" data-admin-section-link="rooms"><span class="nav-icon">▦</span>Rooms</button><button type="button" data-admin-section-link="activity"><span class="nav-icon">↗</span>Activity</button><button type="button" data-admin-section-link="bookings"><span class="nav-icon">✓</span>Bookings</button></nav><div class="sidebar-footer"><div class="connection-indicator"><span class="connection-dot ' + (state.calendarConnected ? 'is-connected' : '') + '"></span><span>' + (state.calendarConnected ? 'Calendar connected' : 'Local availability') + '</span></div><a href="/" target="_blank" rel="noreferrer">Open tenant portal ↗</a></div></aside><main class="admin-main"><div class="shell">' +
    '<header class="top"><div class="brand">Launchpad<i> Tenant</i></div><div class="top-right"><span class="pill">Booking admin</span><button class="outline" id="out">Sign out</button></div></header>' +
    '<section class="panel-head"><div><h1>Tenant booking control</h1><p>Tenant portal: <a href="/" target="_blank" rel="noreferrer">' + esc(location.origin) + '</a></p></div>' +
    '<div class="actions"><button class="outline" id="add-room">+ Add room</button><button class="primary" id="add-tenant">+ Add tenant</button></div></section>' +
    '<section class="stats"><div class="card metric"><small>Available rooms</small><b>' + state.rooms.length + '</b><span class="ok">Launchpad room catalog</span></div>' +
    '<div class="card metric"><small>Active tenants</small><b>' + state.tenants.filter(tenant => tenant.status === 'Active').length + '</b></div>' +
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
    '<div id="booking-summary" class="booking-summary" aria-live="polite"></div><div id="booking-list"></div></section></div>';

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

function render() {
  const allotted = state.tenants.reduce((total, tenant) => total + Number(tenant.allottedHours || 0), 0);
  const used = state.tenants.reduce((total, tenant) => total + Number(tenant.usedHours || 0), 0);
  const confirmed = state.bookings.filter(booking => booking.status === 'Confirmed').length;
  const reviews = state.bookings.filter(booking => booking.needsReview).length;
  const activeTenants = state.tenants.filter(tenant => tenant.status === 'Active').length;
  const usagePercent = allotted ? Math.min(100, Math.round((used / allotted) * 100)) : 0;
  const notifications = unreadNotifications();
  const statusOptions = ['All', 'Upcoming', 'Ongoing', 'Completed', 'Cancelled'].map(status =>
    '<option value="' + status + '"' + (bookingFilters.status === status ? ' selected' : '') + '>' + status + '</option>').join('');
  const roomOptions = state.rooms.map(room => '<option value="' + esc(room.id) + '"' + (bookingFilters.roomId === room.id ? ' selected' : '') + '>' + esc(room.name) + '</option>').join('');

  root.innerHTML = '<div class="shell">' +
    '<header class="top"><button type="button" class="brand brand-link" data-admin-section-link="overview" aria-label="Go to Launchpad Spaces home">Launchpad<i> Spaces</i></button><div class="top-right"><button class="notification-button" id="notifications" aria-expanded="false" aria-controls="notification-panel" aria-label="Notifications' + (notifications.length ? ', ' + notifications.length + ' unread' : '') + '"><span aria-hidden="true">Notifications</span>' + (notifications.length ? '<b>' + notifications.length + '</b>' : '') + '</button><span class="pill">Booking admin</span><button class="outline" id="out">Sign out</button></div></header>' +
    '<nav class="admin-nav" aria-label="Admin sections"><button type="button" data-admin-section-link="overview">Overview</button><button type="button" data-admin-section-link="tenants">Tenants</button><button type="button" data-admin-section-link="rooms">Rooms</button><button type="button" data-admin-section-link="activity">Activity</button><button type="button" data-admin-section-link="bookings">Bookings</button></nav>' +
    '<section class="panel-head" id="overview" data-admin-section="overview"><div><div class="eyebrow">Operations dashboard</div><h1>Tenant booking control</h1><p>Monitor workspace activity and manage the tenant booking system from one place.</p></div>' +
    '<div class="actions"><button class="outline" id="add-room">+ Add room</button><button class="primary" id="add-tenant">+ Add tenant</button></div></section>' +
    '<section class="admin-welcome" data-admin-section="overview"><div class="welcome-mark" aria-hidden="true">LS</div><div class="welcome-copy"><div class="eyebrow">Welcome to Launchpad Spaces</div><h2>A clear place to manage every reservation.</h2><p>Use this workspace to manage tenants, keep room calendars accurate, and review bookings from one organized control center.</p><div class="welcome-guidance"><span><b>1</b><strong>Manage access</strong><small>Keep tenant accounts and allotted hours updated.</small></span><span><b>2</b><strong>Check spaces</strong><small>Review rooms and their Google Calendar connections.</small></span><span><b>3</b><strong>Review bookings</strong><small>Inspect, edit, or cancel reservations when needed.</small></span></div></div><button type="button" class="outline welcome-action" data-admin-section-link="bookings">Open bookings</button></section>' +
    '<section class="stats" data-admin-section="overview"><div class="card metric"><small>Active tenants</small><b>' + activeTenants + '</b><span>Tenant accounts in service</span></div>' +
    '<div class="card metric"><small>Confirmed bookings</small><b>' + confirmed + '</b><span>Current reservations</span></div><button type="button" class="card metric metric-action" id="needs-review-card"><small>Needs review</small><b class="' + (reviews ? 'metric-warning' : '') + '">' + reviews + '</b><span>' + (reviews ? 'Open flagged bookings' : 'No exceptions detected') + '</span></button>' +
    '<div class="card metric"><small>Hours used / allotted</small><b>' + used.toFixed(1) + ' / ' + allotted.toFixed(1) + ' h</b><span>' + usagePercent + '% utilized · ' + (state.calendarConnected ? 'Calendar connected' : 'Local availability only') + '</span><div class="metric-progress" aria-label="' + usagePercent + '% of allotted hours used"><i style="width:' + usagePercent + '%"></i></div></div></section>' +
    '<section class="section dashboard-section" id="activity" data-admin-section="activity"><div class="section-heading"><div><div class="eyebrow">Insights</div><h2>Operational activity</h2><p class="section-note">Use the latest booking data to see demand and workspace usage.</p></div><div class="analytics-range" role="group" aria-label="Analytics time range"><button type="button" class="outline' + (analyticsRange === 7 ? ' selected' : '') + '" data-range="7">7 days</button><button type="button" class="outline' + (analyticsRange === 30 ? ' selected' : '') + '" data-range="30">30 days</button><button type="button" class="outline' + (analyticsRange === 90 ? ' selected' : '') + '" data-range="90">90 days</button></div></div>' +
    '<div class="analytics-grid"><article class="card analytics-card"><div class="analytics-card-head"><div><h3>Booking activity</h3><p>Bookings created within the selected period.</p></div><span class="analytics-updated" id="analytics-updated"></span></div><div id="booking-activity-chart"></div></article>' +
    '<article class="card analytics-card"><div class="analytics-card-head"><div><h3>Workspace usage</h3><p>Confirmed hours by workspace.</p></div></div><div id="workspace-usage-chart"></div></article></div>' +
    '<article class="card activity-feed"><div class="analytics-card-head"><div><h3>Recent activity</h3><p>Latest booking events from the system.</p></div><span class="live-status" id="live-status">Updated just now</span></div><div id="recent-activity-list"></div></article></section>' +
    '<section class="section" id="tenants" data-admin-section="tenants"><div class="section-heading"><div><div class="eyebrow">Directory</div><h2>Tenant accounts</h2><p class="section-note">Search and manage tenant access, allocation, and usage.</p></div><button class="primary" id="add-tenant-secondary">+ Add tenant</button></div><div class="management-toolbar"><label class="filter-field"><span>Search tenants</span><input id="tenant-search" type="search" placeholder="Name, company, email, or location" value="' + esc(managementFilters.tenantSearch) + '"></label><span class="table-summary" id="tenant-summary"></span></div><div id="tenant-list"></div></section>' +
    '<section class="section" id="rooms" data-admin-section="rooms"><div class="section-heading"><div><div class="eyebrow">Inventory</div><h2>Available rooms</h2><p class="section-note">Manage workspaces and their calendar connections.</p></div><button class="outline" id="add-room-secondary">+ Add room</button></div><div class="management-toolbar"><label class="filter-field"><span>Search rooms</span><input id="room-search" type="search" placeholder="Room name or location" value="' + esc(managementFilters.roomSearch) + '"></label><span class="table-summary" id="room-summary"></span></div><div id="room-list"></div></section>' +
    '<section class="section" id="bookings-section" data-admin-section="bookings"><div class="section-heading"><div><div class="eyebrow">Reservations</div><h2>Booking oversight</h2><p class="section-note">Search, inspect, update, or cancel bookings. Cancellation preserves the record for audit history.</p></div><div class="section-heading-actions"><span class="live-status" id="booking-live-status">Updated just now</span><button class="outline" id="refresh-bookings">Refresh</button></div></div>' +
    '<div class="booking-filters"><label class="filter-field filter-search"><span>Search</span><input id="booking-search" type="search" placeholder="Tenant, email, room, or booking ID" value="' + esc(bookingFilters.search) + '"></label>' +
    '<label class="filter-field"><span>Status</span><select id="booking-status">' + statusOptions + '</select></label><label class="filter-field"><span>Workspace</span><select id="booking-room"><option value="">All workspaces</option>' + roomOptions + '</select></label>' +
    '<label class="filter-field"><span>Exact date</span><input id="booking-date" type="date" value="' + esc(bookingFilters.date) + '"></label><button class="outline clear-filters" id="clear-booking-filters">Clear filters</button></div>' +
    '<div class="review-filter-note" id="review-filter-note" hidden>Showing bookings that need review. <button type="button" class="link-button" id="clear-review-filter">Show all bookings</button></div>' +
    '<div id="booking-summary" class="booking-summary" aria-live="polite"></div><div id="booking-list"></div></section></div></main></div>';

  document.querySelectorAll('[data-admin-section-link]').forEach(link => {
    link.onclick = () => setAdminSection(link.dataset.adminSectionLink);
  });
  applyAdminSection();
  $('#out').onclick = () => { localStorage.removeItem('bookingAdminToken'); token = ''; adminIdentity = null; if (pollTimer) { clearInterval(pollTimer); pollTimer = null; } login(); };
  $('#add-tenant').onclick = () => tenantForm(); $('#add-tenant-secondary').onclick = () => tenantForm();
  $('#add-room').onclick = () => roomForm(); $('#add-room-secondary').onclick = () => roomForm();
  $('#needs-review-card').onclick = () => { bookingReviewOnly = true; bookingPage = 1; scrollToSection('bookings-section'); renderBookingList(); };
  $('#notifications').onclick = toggleNotifications;
  document.querySelectorAll('.analytics-range button').forEach(button => { button.onclick = () => { analyticsRange = Number(button.dataset.range); renderAnalytics(); }; });
  bindManagementFilters(); bindBookingFilters(); renderManagementLists(); renderAnalytics(); renderBookingList(); hideLoader(); updateLiveStatus();
}

function bindManagementFilters() {
  $('#tenant-search').oninput = event => { managementFilters.tenantSearch = event.target.value; tenantPage = 1; renderTenantList(); };
  $('#room-search').oninput = event => { managementFilters.roomSearch = event.target.value; roomPage = 1; renderRoomList(); };
}

function renderManagementLists() { renderTenantList(); renderRoomList(); }

function renderTenantList() {
  const search = managementFilters.tenantSearch.trim().toLowerCase();
  const tenants = state.tenants.filter(tenant => [tenant.fullName, tenant.companyName, tenant.email, tenant.location].join(' ').toLowerCase().includes(search));
  const pageCount = Math.max(1, Math.ceil(tenants.length / managementPageSize));
  tenantPage = Math.min(tenantPage, pageCount);
  const visible = tenants.slice((tenantPage - 1) * managementPageSize, tenantPage * managementPageSize);
  const rows = visible.length ? visible.map(tenant => '<tr><td><span class="name">' + esc(tenant.fullName) + '</span><br><small>' + esc(tenant.companyName || '—') + '</small></td><td>' + esc(tenant.email) + '<br><small>' + esc(tenant.location) + '</small></td><td>' + formatHours(tenant.allottedHours) + '</td><td>' + formatHours(tenant.usedHours) + '</td><td><span class="pill">' + formatHours(tenant.remainingHours) + '</span></td><td class="row-actions"><button class="outline edit-tenant" data-id="' + esc(tenant.id) + '">Edit</button><button class="outline email-tenant" data-id="' + esc(tenant.id) + '">Report</button><button class="danger delete-tenant" data-id="' + esc(tenant.id) + '">Delete</button></td></tr>').join('') : '<tr><td class="sub" colspan="6">No tenants match this search.</td></tr>';
  $('#tenant-summary').textContent = tenants.length + ' tenant' + (tenants.length === 1 ? '' : 's') + ' · Page ' + tenantPage + ' of ' + pageCount;
  $('#tenant-list').innerHTML = '<div class="table-wrap"><table class="table management-table"><thead><tr><th>Tenant / company</th><th>Email &amp; location</th><th>Allotted</th><th>Used</th><th>Remaining</th><th>Actions</th></tr></thead><tbody>' + rows + '</tbody></table></div><div class="pagination"><button class="outline" id="tenant-prev"' + (tenantPage <= 1 ? ' disabled' : '') + '>Previous</button><span>Page ' + tenantPage + ' of ' + pageCount + '</span><button class="outline" id="tenant-next"' + (tenantPage >= pageCount ? ' disabled' : '') + '>Next</button></div>';
  document.querySelectorAll('.edit-tenant').forEach(button => { button.onclick = () => tenantForm(state.tenants.find(tenant => tenant.id === button.dataset.id)); });
  document.querySelectorAll('.delete-tenant').forEach(button => { button.onclick = () => remove('/api/tenants/' + button.dataset.id, 'Delete this tenant? Related booking history will remain.'); });
  document.querySelectorAll('.email-tenant').forEach(button => { button.onclick = () => sendReport(button.dataset.id); });
  $('#tenant-prev').onclick = () => { if (tenantPage > 1) { tenantPage--; renderTenantList(); } };
  $('#tenant-next').onclick = () => { if (tenantPage < pageCount) { tenantPage++; renderTenantList(); } };
}

function renderRoomList() {
  const search = managementFilters.roomSearch.trim().toLowerCase();
  const rooms = state.rooms.filter(room => [room.name, room.location].join(' ').toLowerCase().includes(search));
  const pageCount = Math.max(1, Math.ceil(rooms.length / managementPageSize));
  roomPage = Math.min(roomPage, pageCount);
  const visible = rooms.slice((roomPage - 1) * managementPageSize, roomPage * managementPageSize);
  const rows = visible.length ? visible.map(room => '<tr><td class="name">' + esc(room.name) + '</td><td>' + esc(room.location) + '</td><td>' + esc(room.capacity || '—') + '</td><td><span class="calendar-state">' + (room.calendarId ? 'Room calendar' : 'Company default') + '</span></td><td class="row-actions"><button class="outline edit-room" data-id="' + esc(room.id) + '">Edit</button><button class="danger delete-room" data-id="' + esc(room.id) + '">Delete</button></td></tr>').join('') : '<tr><td class="sub" colspan="5">No rooms match this search.</td></tr>';
  $('#room-summary').textContent = rooms.length + ' room' + (rooms.length === 1 ? '' : 's') + ' · Page ' + roomPage + ' of ' + pageCount;
  $('#room-list').innerHTML = '<div class="table-wrap"><table class="table management-table"><thead><tr><th>Room</th><th>Location</th><th>Capacity</th><th>Calendar</th><th>Actions</th></tr></thead><tbody>' + rows + '</tbody></table></div><div class="pagination"><button class="outline" id="room-prev"' + (roomPage <= 1 ? ' disabled' : '') + '>Previous</button><span>Page ' + roomPage + ' of ' + pageCount + '</span><button class="outline" id="room-next"' + (roomPage >= pageCount ? ' disabled' : '') + '>Next</button></div>';
  document.querySelectorAll('.edit-room').forEach(button => { button.onclick = () => roomForm(state.rooms.find(room => room.id === button.dataset.id)); });
  document.querySelectorAll('.delete-room').forEach(button => { button.onclick = () => remove('/api/rooms/' + button.dataset.id, 'Delete this room?'); });
  $('#room-prev').onclick = () => { if (roomPage > 1) { roomPage--; renderRoomList(); } };
  $('#room-next').onclick = () => { if (roomPage < pageCount) { roomPage++; renderRoomList(); } };
}

function toggleNotifications() {
  const button = $('#notifications');
  const existing = $('#notification-panel');
  if (existing) { existing.remove(); button.setAttribute('aria-expanded', 'false'); return; }
  markNotificationsRead(); button.querySelector('b')?.remove(); button.setAttribute('aria-label', 'Notifications'); button.setAttribute('aria-expanded', 'true');
  const items = notificationItems();
  const panel = document.createElement('aside'); panel.id = 'notification-panel'; panel.className = 'notification-panel'; panel.setAttribute('role', 'region'); panel.setAttribute('aria-label', 'Notifications');
  panel.innerHTML = '<div class="notification-head"><div><strong>Notifications</strong><small>Recent operational activity</small></div><button type="button" class="dialog-close" id="close-notifications" aria-label="Close notifications">×</button></div>' +
    (items.length ? '<div class="notification-list">' + items.slice(0, 8).map(item => '<button type="button" class="notification-item" data-booking-id="' + esc(item.bookingId) + '"><span class="notification-type">' + esc(item.type) + '</span><strong>' + esc(item.title) + '</strong><span>' + esc(item.detail) + '</span><small>' + esc(relativeTime(item.timestamp)) + '</small></button>').join('') + '</div>' : '<div class="notification-empty"><strong>You’re all caught up</strong><span>New booking activity will appear here.</span></div>') +
    '<button type="button" class="notification-footer" id="view-booking-activity">View booking activity</button>';
  document.querySelector('.top')?.appendChild(panel);
  $('#close-notifications').onclick = toggleNotifications;
  $('#view-booking-activity').onclick = () => { toggleNotifications(); scrollToSection('bookings-section'); };
  panel.querySelectorAll('.notification-item').forEach(item => { item.onclick = () => { const id = item.dataset.bookingId; toggleNotifications(); scrollToSection('bookings-section'); bookingDetails(id); }; });
}

function renderAnalytics() {
  if (!state) return;
  const today = localDateOnly();
  const start = dateOffset(today, -(analyticsRange - 1));
  const buckets = Array.from({ length: analyticsRange }, (_, index) => dateOffset(start, index));
  const counts = buckets.map(day => state.bookings.filter(booking => dateOnly(booking.createdAt) === day).length);
  const maxCount = Math.max(1, ...counts);
  const labels = buckets.map((day, index) => '<span class="chart-label' + (index % Math.ceil(analyticsRange / 6) === 0 ? '' : ' is-muted') + '">' + (index % Math.ceil(analyticsRange / 6) === 0 ? esc(shortDate(day)) : '') + '</span>');
  const bars = buckets.map((day, index) => '<div class="chart-column" title="' + esc(shortDate(day)) + ': ' + counts[index] + ' booking' + (counts[index] === 1 ? '' : 's') + '"><i style="height:' + Math.max(4, Math.round((counts[index] / maxCount) * 100)) + '%"></i></div>').join('');
  $('#booking-activity-chart').innerHTML = counts.some(Boolean) ? '<div class="bar-chart" role="img" aria-label="Booking activity for the last ' + analyticsRange + ' days"><div class="chart-bars">' + bars + '</div><div class="chart-labels">' + labels.join('') + '</div></div><p class="chart-caption">' + counts.reduce((sum, count) => sum + count, 0) + ' booking events in this period.</p>' : '<div class="analytics-empty"><strong>Not enough booking activity yet</strong><span>Analytics will appear as booking data accumulates.</span></div>';
  const usage = state.rooms.map(room => ({ room, hours: state.bookings.filter(booking => booking.roomId === room.id && booking.status === 'Confirmed').reduce((sum, booking) => sum + Number(booking.hours || 0), 0) })).sort((left, right) => right.hours - left.hours);
  const maxUsage = Math.max(1, ...usage.map(item => item.hours));
  $('#workspace-usage-chart').innerHTML = usage.length && usage.some(item => item.hours) ? '<div class="usage-bars" role="list">' + usage.map(item => '<div class="usage-row" role="listitem"><div><strong>' + esc(item.room.name) + '</strong><span>' + item.hours.toFixed(1) + ' h</span></div><div class="usage-track"><i style="width:' + Math.max(3, Math.round((item.hours / maxUsage) * 100)) + '%"></i></div></div>').join('') + '</div>' : '<div class="analytics-empty"><strong>No confirmed workspace usage yet</strong><span>Usage will appear after a tenant confirms a booking.</span></div>';
  const recent = state.bookings.slice().sort((left, right) => new Date(right.createdAt || 0) - new Date(left.createdAt || 0)).slice(0, 5);
  $('#recent-activity-list').innerHTML = recent.length ? '<div class="recent-list">' + recent.map(booking => '<button type="button" class="recent-item" data-booking-id="' + esc(booking.id) + '"><span class="recent-dot ' + (booking.status === 'Cancelled' ? 'cancelled' : '') + '"></span><span><strong>' + esc(bookingTenant(booking)) + ' · ' + esc(bookingRoom(booking)) + '</strong><small>' + esc(shortDate(booking.date) + ' · ' + booking.startTime + '–' + booking.endTime) + '</small></span><time>' + esc(relativeTime(booking.createdAt)) + '</time></button>').join('') + '</div>' : '<div class="analytics-empty"><strong>No recent activity</strong><span>New tenant bookings will appear here.</span></div>';
  document.querySelectorAll('.recent-item').forEach(item => { item.onclick = () => bookingDetails(item.dataset.bookingId); });
  $('#analytics-updated').textContent = analyticsRange + ' day view · ' + shortDate(start) + '–' + shortDate(today);
}

function bindBookingFilters() {
  $('#booking-search').oninput = event => { bookingFilters.search = event.target.value; bookingPage = 1; renderBookingList(); };
  $('#booking-status').onchange = event => { bookingFilters.status = event.target.value; bookingPage = 1; renderBookingList(); };
  $('#booking-room').onchange = event => { bookingFilters.roomId = event.target.value; bookingPage = 1; renderBookingList(); };
  $('#booking-date').onchange = event => { bookingFilters.date = event.target.value; bookingPage = 1; renderBookingList(); };
  $('#clear-booking-filters').onclick = () => {
    bookingFilters = { search: '', status: 'All', roomId: '', date: '' }; bookingReviewOnly = false; bookingPage = 1;
    $('#booking-search').value = ''; $('#booking-status').value = 'All'; $('#booking-room').value = ''; $('#booking-date').value = '';
    renderBookingList();
  };
  $('#clear-review-filter').onclick = () => { bookingReviewOnly = false; bookingPage = 1; renderBookingList(); };
  $('#refresh-bookings').onclick = () => load();
}

function filteredBookings() {
  const search = bookingFilters.search.trim().toLowerCase();
  return state.bookings.filter(booking => {
    const tenant = booking.tenant || {};
    const searchable = [booking.id, bookingTenant(booking), tenant.email, tenant.companyName, bookingRoom(booking), booking.roomName].join(' ').toLowerCase();
    return (!search || searchable.includes(search)) && (!bookingReviewOnly || booking.needsReview) && (bookingFilters.status === 'All' || booking.bookingState === bookingFilters.status) &&
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
  const reviewNote = $('#review-filter-note');
  if (reviewNote) reviewNote.hidden = !bookingReviewOnly;
  summary.textContent = bookings.length + ' booking' + (bookings.length === 1 ? '' : 's') + ' found' + (bookings.length ? ' · Page ' + bookingPage + ' of ' + pageCount : '');
  const rows = visible.length ? visible.map(booking =>
    '<tr><td><span class="name">' + esc(bookingTenant(booking)) + '</span><br><small>' + esc(booking.tenant?.email || '') + '</small></td><td>' + esc(bookingRoom(booking)) + '</td>' +
    '<td>' + esc(booking.date) + '</td><td>' + esc(booking.startTime) + '–' + esc(booking.endTime) + '</td><td>' + formatHours(booking.hours) + '</td>' +
    '<td><span class="status-badge ' + bookingStatusClass(booking.bookingState) + '">' + esc(booking.bookingState) + '</span></td><td>' +
    (booking.needsReview ? '<span class="review-badge warning" title="' + esc(booking.reviewReason) + '">Needs review</span>' : '<span class="review-badge">Looks good</span>') + '</td><td class="row-actions">' +
    '<button class="outline booking-details" data-id="' + esc(booking.id) + '">Details</button>' +
    (booking.cancellationRequest?.status === 'Pending' ? '<button class="outline booking-review-cancellation" data-id="' + esc(booking.id) + '">Review request</button>' : '') +
    (booking.status === 'Confirmed' ? '<button class="outline booking-edit" data-id="' + esc(booking.id) + '">Edit</button><button class="danger booking-cancel" data-id="' + esc(booking.id) + '">Cancel</button>' : '') +
    '</td></tr>').join('') : '<tr><td class="sub" colspan="8">No bookings match these filters.</td></tr>';
  list.innerHTML = '<div class="table-wrap"><table class="table booking-table"><thead><tr><th>Tenant</th><th>Workspace</th><th>Date</th><th>Time</th><th>Duration</th><th>Status</th><th>Review</th><th>Actions</th></tr></thead><tbody>' +
    rows + '</tbody></table></div><div class="pagination"><button class="outline" id="booking-prev"' + (bookingPage <= 1 ? ' disabled' : '') + '>Previous</button><span>Page ' + bookingPage + ' of ' + pageCount + '</span><button class="outline" id="booking-next"' +
    (bookingPage >= pageCount ? ' disabled' : '') + '>Next</button></div>';
  document.querySelectorAll('.booking-details').forEach(button => { button.onclick = () => bookingDetails(button.dataset.id); });
  document.querySelectorAll('.booking-review-cancellation').forEach(button => { button.onclick = () => bookingDetails(button.dataset.id); });
  document.querySelectorAll('.booking-edit').forEach(button => { button.onclick = () => editBooking(state.bookings.find(booking => booking.id === button.dataset.id)); });
  document.querySelectorAll('.booking-cancel').forEach(button => { button.onclick = () => cancelBooking(state.bookings.find(booking => booking.id === button.dataset.id)); });
  $('#booking-prev').onclick = () => { if (bookingPage > 1) { bookingPage--; renderBookingList(); } };
  $('#booking-next').onclick = () => { if (bookingPage < pageCount) { bookingPage++; renderBookingList(); } };
  const liveStatus = $('#booking-live-status');
  if (liveStatus) liveStatus.textContent = 'Updated just now';
}

function modalMarkup(content) {
  document.body.classList.add('modal-open');
  modal.innerHTML = '<div class="modal-bg" id="modal-bg"><div class="modal-card" role="dialog" aria-modal="true" aria-label="Booking administration dialog" tabindex="-1">' + content + '</div></div>';
  $('#modal-bg').onclick = event => { if (event.target.id === 'modal-bg') closeModal(); };
  modal.onkeydown = event => { if (event.key === 'Escape') closeModal(); };
  modal.querySelector('.modal-card')?.focus();
}
function closeModal() {
  modal.innerHTML = ''; modal.onkeydown = null; document.body.classList.remove('modal-open');
  if (pendingBackgroundRender && state) { pendingBackgroundRender = false; render(); }
}
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
    { name: 'capacity', label: 'Capacity', type: 'number', value: room.capacity || '', min: 0, step: 1 }, { name: 'calendarId', label: 'Google Calendar ID(s) (optional)', value: room.calendarId || '', help: 'For a combined room, separate calendar IDs with commas.' }
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
    ['Duration', values.hours != null ? formatHours(values.hours) : '—'], ['Status', values.status],
    ['Quota change', values.quotaMinutes != null ? formatHours(Number(values.quotaMinutes) / 60) : null]];
  return '<div class="audit-values">' + labels.filter(item => item[1] != null).map(item => '<span><b>' + esc(item[0]) + '</b> ' + esc(item[1]) + '</span>').join('') + '</div>';
}

function auditEntryMarkup(entry) {
  const lifecycle = String(entry.id || '').startsWith('lifecycle-');
  const quotaMinutes = entry.newValues?.quotaMinutes;
  const timestamp = esc(formatPhtDateTime(entry.createdAt));
  const reason = entry.reason ? ' · ' + esc(entry.reason) : '';
  if (lifecycle && quotaMinutes != null) {
    const amount = formatHours(Math.abs(Number(quotaMinutes)) / 60);
    const direction = Number(quotaMinutes) >= 0 ? 'restored' : 'deducted';
    return '<article class="audit-entry audit-entry-lifecycle"><div class="audit-entry-head"><strong>ALLOCATION UPDATED</strong><span>' + timestamp + '</span></div><div class="audit-meta">System lifecycle' + reason + '</div><div class="audit-impact"><span>Quota ' + direction + '</span><strong>' + esc(amount) + '</strong></div></article>';
  }
  if (lifecycle) {
    return '<article class="audit-entry audit-entry-lifecycle"><div class="audit-entry-head"><strong>REQUEST LOGGED</strong><span>' + timestamp + '</span></div><div class="audit-meta">System lifecycle' + reason + '</div></article>';
  }
  return '<article class="audit-entry"><div class="audit-entry-head"><strong>' + esc(String(entry.action || '').replaceAll('_', ' ')) + '</strong><span>' + timestamp + '</span></div><div class="audit-meta">By ' + esc(entry.adminUsername || entry.adminUserId || 'administrator') + reason + '</div><div class="audit-change"><div><small>Before</small>' + auditValues(entry.previousValues) + '</div><div><small>After</small>' + auditValues(entry.newValues) + '</div></div></article>';
}

async function bookingDetails(id) {
  modalMarkup('<div class="modal-loading">Loading booking details...</div>');
  try {
    const result = await api('/api/bookings/' + id); const booking = result.booking; const audit = result.audit || [];
    const legacyAuditHtml = audit.length ? audit.map(entry => '<article class="audit-entry"><div class="audit-entry-head"><strong>' +
      esc(entry.action.replaceAll('_', ' ')) + '</strong><span>' + esc(formatPhtDateTime(entry.createdAt)) + '</span></div><div class="audit-meta">By ' +
      esc(entry.adminUsername || entry.adminUserId || 'administrator') + (entry.reason ? ' · ' + esc(entry.reason) : '') + '</div><div class="audit-change"><div><small>Before</small>' +
      auditValues(entry.previousValues) + '</div><div><small>After</small>' + auditValues(entry.newValues) + '</div></div></article>').join('') :
      '<p class="sub">No admin changes have been recorded for this booking.</p>';
    const auditHtml = audit.length ? audit.map(auditEntryMarkup).join('') :
      '<p class="sub">No admin changes have been recorded for this booking.</p>';
    const details = detailRows(booking).map(row => '<div><small>' + esc(row[0]) + '</small><strong>' + esc(row[1] ?? '—') + '</strong></div>').join('');
    const cancellationRequest = booking.cancellationRequest;
    const cancellationRequestHtml = cancellationRequest ? '<section class="audit-section cancellation-review"><h3>Cancellation request</h3><div class="review-callout ' + (cancellationRequest.status === 'Pending' ? 'warning' : '') + '"><b>' + esc(cancellationRequest.status) + '</b><br>' + esc(cancellationRequest.reasonCategory) + (cancellationRequest.note ? '<br>' + esc(cancellationRequest.note) : '') + '<br><small>Submitted ' + esc(formatPhtDateTime(cancellationRequest.requestedAt)) + '</small></div>' + (cancellationRequest.status === 'Pending' ? '<div class="modal-actions"><button type="button" class="outline" id="review-reject">Reject request</button><button type="button" class="primary" id="review-approve">Approve cancellation &amp; refund</button></div>' : '') + '</section>' : '';
    modalMarkup('<div class="modal-title-row"><div><div class="eyebrow">Booking details</div><h2>' + esc(bookingTenant(booking)) + '</h2></div><span class="status-badge ' +
      bookingStatusClass(booking.bookingState) + '">' + esc(booking.bookingState) + '</span></div>' +
      (booking.needsReview ? '<div class="review-callout warning"><b>Needs review</b><br>' + esc(booking.reviewReason) + '</div>' :
        '<div class="review-callout"><b>Data checks passed.</b> No current relationship or overlap issue was detected.</div>') +
      '<div class="detail-grid">' + details + '</div>' + cancellationRequestHtml + '<section class="audit-section"><h3>Admin audit history</h3>' + auditHtml + '</section>' +
      '<div class="modal-actions"><button type="button" class="outline" id="modal-cancel">Close</button>' +
      (booking.status === 'Confirmed' ? '<button type="button" class="outline" id="details-edit">Edit booking</button><button type="button" class="primary" id="details-cancel">Cancel booking</button>' : '') + '</div>');
    $('#modal-cancel').onclick = closeModal;
    if (booking.status === 'Confirmed') { $('#details-edit').onclick = () => editBooking(booking); $('#details-cancel').onclick = () => cancelBooking(booking); }
    if (cancellationRequest?.status === 'Pending') {
      $('#review-approve').onclick = () => reviewCancellation(booking, 'approve');
      $('#review-reject').onclick = () => reviewCancellation(booking, 'reject');
    }
  } catch (error) {
    modalMarkup('<h2>Unable to load booking</h2><div class="error">' + esc(friendlyError(error)) + '</div>' + modalActions('Close', 'Try again'));
    $('#modal-cancel').onclick = closeModal; $('#modal-submit').onclick = () => bookingDetails(id);
  }
}

function reviewCancellation(booking, decision) {
  const request = booking?.cancellationRequest;
  if (!request || request.status !== 'Pending') return;
  const approving = decision === 'approve';
  modalMarkup('<form class="modal-form ' + (approving ? '' : 'danger-modal') + '" id="cancellation-review-form"><div class="eyebrow">Cancellation review</div><h2>' + (approving ? 'Approve cancellation and refund?' : 'Reject cancellation request?') + '</h2><p class="modal-intro">' + (approving ? 'This will cancel the booking, release the workspace, remove its calendar event, and restore ' + formatHours(booking.hours) + ' to the tenant allocation.' : 'The booking will remain confirmed and its allocation will not be refunded.') + '</p><div class="cancel-summary"><b>' + esc(bookingTenant(booking)) + '</b><span>' + esc(bookingRoom(booking) + ' · ' + booking.date + ' · ' + booking.startTime + '–' + booking.endTime) + '</span></div>' + fieldMarkup({ name: 'remark', label: approving ? 'Review note (optional)' : 'Reason for rejection', type: 'textarea', value: '', required: !approving, full: true, rows: 3 }) + '<label class="check-field"><input name="confirm" type="checkbox" value="yes" required><span>I understand the effect of this decision and that it will be recorded in the audit history.</span></label><div class="modal-error error" id="modal-error"></div>' + modalActions('Keep request', approving ? 'Approve & refund' : 'Reject request') + '</form>');
  $('#modal-cancel').onclick = closeModal;
  const formElement = $('#cancellation-review-form');
  formElement.onsubmit = async event => {
    event.preventDefault(); if (formElement.dataset.busy === 'true') return;
    formElement.dataset.busy = 'true'; $('#modal-submit').disabled = true; $('#modal-submit').textContent = approving ? 'Approving...' : 'Rejecting...'; $('#modal-error').textContent = '';
    try {
      const values = Object.fromEntries(new FormData(formElement));
      await api('/api/cancellation-requests/' + request.id + '/' + decision, { method: 'POST', body: JSON.stringify({ remark: values.remark || '' }) });
      closeModal(); await load();
    } catch (error) { $('#modal-error').textContent = friendlyError(error); formElement.dataset.busy = 'false'; $('#modal-submit').disabled = false; $('#modal-submit').textContent = approving ? 'Approve & refund' : 'Reject request'; }
  };
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
