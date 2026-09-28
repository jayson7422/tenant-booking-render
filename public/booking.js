const root = document.querySelector('#portal');
let token = localStorage.tenantBookingToken || '';
let data = null;
let verified = false;
let pickerCleanup = null;

const esc = value => String(value ?? '').replace(/[&<>"']/g, character => ({
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#39;'
}[character]));

function today() {
  const date = new Date();
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}

const loader = document.getElementById('lp-loader');
function showLoader() { if (loader) loader.classList.remove('hidden'); }
function hideLoader() { if (loader) loader.classList.add('hidden'); }
window.addEventListener('DOMContentLoaded', () => setTimeout(hideLoader, 300));
window.addEventListener('pageshow', () => setTimeout(hideLoader, 150));

async function api(url, options = {}) {
  const response = await fetch(url, {
    ...options,
    headers: {
      'Content-Type': 'application/json',
      'X-Tenant-Token': token,
      ...options.headers
    }
  });
  const result = await response.json();
  if (!response.ok) throw Error(result.error || 'Request failed');
  return result;
}

function login() {
  root.innerHTML = `<section class="login"><form class="login-card" id="login"><div class="brand">Launchpad<i> Tenant</i></div><div class="eyebrow">Tenant self-booking</div><h1>Book your room.</h1><div class="sub">Use the email and access code provided by your administrator to view availability and book allotted time.</div><div class="field"><label>Email address</label><input required type="email" name="email" autocomplete="email"></div><div class="field"><label>Access code</label><input required type="password" name="accessCode" autocomplete="current-password"></div><button class="primary" id="login-btn" style="width:100%;margin-top:8px">Open booking portal</button><div class="alert" id="error"></div></form></section>`;
  const loginForm = document.querySelector('#login');
  const loginButton = document.querySelector('#login-btn');
  const errorElement = document.querySelector('#error');
  let submitting = false;

  loginForm.onsubmit = async event => {
    event.preventDefault();
    if (submitting) return;
    submitting = true;
    loginButton.disabled = true;
    loginButton.textContent = 'Opening portal…';
    errorElement.textContent = '';
    showLoader();
    try {
      const result = await api('/api/tenant/login', {
        method: 'POST',
        body: JSON.stringify(Object.fromEntries(new FormData(event.target)))
      });
      token = result.token;
      localStorage.tenantBookingToken = token;
      await load();
    } catch (error) {
      hideLoader();
      errorElement.textContent = error.message;
      loginButton.disabled = false;
      loginButton.textContent = 'Open booking portal';
      submitting = false;
    }
  };
}

async function load() {
  showLoader();
  try {
    data = await api('/api/tenant/me');
    render();
  } catch (error) {
    hideLoader();
    localStorage.removeItem('tenantBookingToken');
    token = '';
    login();
  }
}

function reset() {
  verified = false;
  const status = document.querySelector('#availability');
  if (status) {
    status.className = 'status info';
    status.textContent = 'Select a room, date, and time, then validate availability.';
  }
  document.querySelector('#book')?.setAttribute('disabled', '');
}

function parseDate(value) {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value || '');
  return match ? new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3]), 12) : null;
}

function isoDate(date) {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}

function formatDate(value) {
  const date = parseDate(value);
  return date ? new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric', year: 'numeric' }).format(date) : 'Choose a date';
}

function formatTime(value) {
  const match = /^(\d{2}):(\d{2})$/.exec(value || '');
  if (!match) return 'Choose a time';
  const date = new Date(1970, 0, 1, Number(match[1]), Number(match[2]));
  return new Intl.DateTimeFormat('en-US', { hour: 'numeric', minute: '2-digit' }).format(date);
}

function setDateValue(form, value) {
  form.elements.date.value = value;
  const display = form.querySelector('[data-date-display]');
  if (display) display.textContent = formatDate(value);
}

function setTimeValue(form, fieldName, value) {
  form.elements[fieldName].value = value;
  const display = form.querySelector(`[data-time-display="${fieldName}"]`);
  if (display) display.textContent = formatTime(value);
}

function setupPickers(form) {
  if (pickerCleanup) pickerCleanup();

  const dateInput = form.elements.date;
  const dateTrigger = form.querySelector('[data-date-trigger]');
  const datePopover = form.querySelector('[data-date-popover]');
  let calendarMonth = parseDate(dateInput.value) || parseDate(today());

  const closePickers = () => {
    form.querySelectorAll('.picker-popover').forEach(popover => { popover.hidden = true; });
    form.querySelectorAll('[aria-haspopup="dialog"]').forEach(trigger => trigger.setAttribute('aria-expanded', 'false'));
    document.body.classList.remove('picker-open');
  };

  const renderCalendar = () => {
    const monthLabel = new Intl.DateTimeFormat('en-US', { month: 'long', year: 'numeric' }).format(calendarMonth);
    const firstDay = new Date(calendarMonth.getFullYear(), calendarMonth.getMonth(), 1, 12);
    const offset = (firstDay.getDay() + 6) % 7;
    const minimum = today();
    const selected = dateInput.value;
    const days = Array.from({ length: 42 }, (_, index) => {
      const day = new Date(calendarMonth.getFullYear(), calendarMonth.getMonth(), index - offset + 1, 12);
      const value = isoDate(day);
      const classes = [
        'calendar-day',
        day.getMonth() === calendarMonth.getMonth() ? '' : 'is-outside',
        value === selected ? 'is-selected' : '',
        value === minimum ? 'is-today' : ''
      ].filter(Boolean).join(' ');
      return `<button type="button" class="${classes}" data-date-value="${value}" ${value < minimum ? 'disabled' : ''}>${day.getDate()}</button>`;
    }).join('');

    datePopover.innerHTML = `<div class="picker-dialog-card"><div class="dialog-title-row"><div><small class="dialog-kicker">Booking date</small><strong class="dialog-title">Choose a date</strong></div><button type="button" class="dialog-close" data-calendar-close aria-label="Close date picker">×</button></div><div class="calendar-head"><button type="button" class="calendar-nav" data-calendar-step="-1" aria-label="Previous month">‹</button><strong>${monthLabel}</strong><button type="button" class="calendar-nav" data-calendar-step="1" aria-label="Next month">›</button></div><div class="calendar-weekdays"><span>Mon</span><span>Tue</span><span>Wed</span><span>Thu</span><span>Fri</span><span>Sat</span><span>Sun</span></div><div class="calendar-grid">${days}</div><div class="calendar-footer"><button type="button" class="calendar-link" data-calendar-today>Today</button><button type="button" class="primary dialog-done" data-calendar-close>Done</button></div></div>`;

    datePopover.querySelectorAll('[data-calendar-step]').forEach(button => {
      button.onclick = () => {
        calendarMonth.setMonth(calendarMonth.getMonth() + Number(button.dataset.calendarStep));
        renderCalendar();
      };
    });
    datePopover.querySelectorAll('[data-date-value]').forEach(button => {
      button.onclick = () => {
        setDateValue(form, button.dataset.dateValue);
        closePickers();
        reset();
      };
    });
    datePopover.querySelector('[data-calendar-today]').onclick = () => {
      setDateValue(form, minimum);
      calendarMonth = parseDate(minimum);
      renderCalendar();
      closePickers();
      reset();
    };
    datePopover.querySelectorAll('[data-calendar-close]').forEach(button => { button.onclick = closePickers; });
  };

  dateTrigger.onclick = event => {
    event.stopPropagation();
    const wasHidden = datePopover.hidden;
    closePickers();
    datePopover.hidden = !wasHidden;
      dateTrigger.setAttribute('aria-expanded', String(wasHidden));
      if (wasHidden) {
        document.body.classList.add('picker-open');
        renderCalendar();
      }
  };

  const timePopovers = [...form.querySelectorAll('[data-time-popover]')];
  const renderTimeOptions = (popover, fieldName) => {
    const selected = form.elements[fieldName].value;
    const options = Array.from({ length: 48 }, (_, index) => {
      const hours = Math.floor(index / 2);
      const minutes = index % 2 ? '30' : '00';
      const value = `${String(hours).padStart(2, '0')}:${minutes}`;
      return `<button type="button" class="time-option ${value === selected ? 'is-selected' : ''}" data-time-value="${value}">${formatTime(value)}</button>`;
    }).join('');
    popover.innerHTML = `<div class="picker-dialog-card"><div class="dialog-title-row"><div><small class="dialog-kicker">Time selection</small><strong class="dialog-title">Choose a time</strong></div><button type="button" class="dialog-close" data-time-close aria-label="Close time picker">×</button></div><div class="time-head"><small>Choose an available 30-minute interval</small></div><div class="time-options">${options}</div></div>`;
    popover.querySelectorAll('[data-time-value]').forEach(button => {
      button.onclick = () => {
        setTimeValue(form, fieldName, button.dataset.timeValue);
        closePickers();
        reset();
      };
    });
    popover.querySelector('[data-time-close]').onclick = closePickers;
  };

  form.querySelectorAll('[data-time-trigger]').forEach(trigger => {
    trigger.onclick = event => {
      event.stopPropagation();
      const fieldName = trigger.dataset.timeTrigger;
      const popover = form.querySelector(`[data-time-popover="${fieldName}"]`);
      const wasHidden = popover.hidden;
      closePickers();
      popover.hidden = !wasHidden;
      trigger.setAttribute('aria-expanded', String(wasHidden));
      if (wasHidden) {
        document.body.classList.add('picker-open');
        renderTimeOptions(popover, fieldName);
      }
    };
  });

  const outsideClick = event => {
    if (!event.target.closest('.picker-wrap')) closePickers();
  };
  const escape = event => { if (event.key === 'Escape') closePickers(); };
  document.addEventListener('click', outsideClick);
  document.addEventListener('keydown', escape);
  datePopover.onclick = event => { if (event.target === datePopover) closePickers(); };
  timePopovers.forEach(popover => { popover.onclick = event => { if (event.target === popover) closePickers(); }; });
  pickerCleanup = () => {
    document.removeEventListener('click', outsideClick);
    document.removeEventListener('keydown', escape);
    document.body.classList.remove('picker-open');
  };

  datePopover.hidden = true;
  renderCalendar();
  timePopovers.forEach(popover => { popover.hidden = true; });
}

function formatSuggestionTime(value) { return formatTime(value); }

function showSuggestedTimes(suggestions, form) {
  if (!suggestions.length) return;
  const status = document.querySelector('#availability');
  const heading = document.createElement('strong');
  const list = document.createElement('div');
  heading.textContent = 'Suggested available times:';
  heading.className = 'suggestion-heading';
  list.className = 'suggestion-list';
  suggestions.forEach(suggestion => {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'outline suggestion-button';
    button.textContent = `${suggestion.date} · ${formatSuggestionTime(suggestion.startTime)}–${formatSuggestionTime(suggestion.endTime)}`;
    button.onclick = () => {
      setDateValue(form, suggestion.date);
      setTimeValue(form, 'startTime', suggestion.startTime);
      setTimeValue(form, 'endTime', suggestion.endTime);
      reset();
      document.querySelector('#check').click();
    };
    list.append(button);
  });
  status.append(heading, list);
}

function render() {
  const tenant = data.tenant;
  const currentDate = today();
  root.innerHTML = `<div class="portal-shell"><header class="top"><div class="brand">Launchpad<i> Tenant</i></div><a href="#" id="out">Sign out</a></header><section class="hero"><div><span class="badge">${data.calendarConnected ? 'Google Calendar connected' : 'LAN availability checking'}</span><h1>Welcome, ${esc(tenant.fullName)}</h1><p>${esc(tenant.companyName || 'Individual tenant')} · ${esc(tenant.location)}</p></div><div class="remaining"><small>Remaining allotted time</small><strong>${Number(tenant.remainingHours).toFixed(1)} h</strong></div></section><div class="grid"><section class="card"><h2>Choose a room and time</h2><div class="sub">Your booking is confirmed only after the selected interval is available.</div><form id="booking" class="room-form"><div class="field wide"><label>Available room</label><select name="roomId" required>${data.rooms.map(room => `<option value="${room.id}">${esc(room.name)} — ${esc(room.location)}${room.capacity ? ` (${room.capacity} seats)` : ''}</option>`).join('')}</select></div><div class="field"><label>Date</label><div class="picker-wrap"><button type="button" class="picker-trigger" data-date-trigger aria-haspopup="dialog" aria-expanded="false"><span class="picker-trigger-copy"><small>Booking date</small><strong data-date-display>${formatDate(currentDate)}</strong></span><span class="picker-icon">▦</span></button><div class="picker-popover date-popover" data-date-popover role="dialog" aria-label="Choose booking date"></div></div><input type="hidden" name="date" value="${currentDate}"></div><div class="field"><label>Start time</label><div class="picker-wrap"><button type="button" class="picker-trigger" data-time-trigger="startTime" aria-haspopup="dialog"><span class="picker-trigger-copy"><small>From</small><strong data-time-display="startTime">${formatTime('09:00')}</strong></span><span class="picker-icon">◷</span></button><div class="picker-popover time-popover" data-time-popover="startTime" role="dialog" aria-label="Choose start time"></div></div><input type="hidden" name="startTime" value="09:00"></div><div class="field"><label>End time</label><div class="picker-wrap"><button type="button" class="picker-trigger" data-time-trigger="endTime" aria-haspopup="dialog"><span class="picker-trigger-copy"><small>Until</small><strong data-time-display="endTime">${formatTime('10:00')}</strong></span><span class="picker-icon">◷</span></button><div class="picker-popover time-popover" data-time-popover="endTime" role="dialog" aria-label="Choose end time"></div></div><input type="hidden" name="endTime" value="10:00"></div><div class="field"><label>Tenant location</label><input value="${esc(tenant.location)}" disabled></div><div class="form-actions wide"><button type="button" class="outline" id="check">Check availability</button><button class="primary" id="book" disabled>Confirm booking</button></div></form><div class="status info" id="availability">Select a room, date, and time, then validate availability.</div><div class="notice">Hours are deducted automatically when a booking is confirmed.</div></section><aside class="card how"><h2>Booking guide</h2><ol><li>Choose the room, date, and exact hours.</li><li>Check availability against the local schedule${data.calendarConnected ? ' and company Google Calendar' : ''}.</li><li>Confirm to deduct only the hours you use.</li></ol><b>Allotted:</b> ${Number(tenant.allottedHours).toFixed(1)} h<br><b>Used:</b> ${(Number(tenant.allottedHours) - Number(tenant.remainingHours)).toFixed(1)} h</aside></div><section class="card history-card"><h2>Your booking history</h2><div class="table-wrap"><table class="table"><thead><tr><th>Date</th><th>Time</th><th>Room</th><th>Hours</th><th>Status / remark</th><th></th></tr></thead><tbody>${data.bookings.length ? data.bookings.map(booking => `<tr><td>${esc(booking.date)}</td><td>${esc(booking.startTime)}–${esc(booking.endTime)}</td><td>${esc(booking.room?.name || booking.roomName)}</td><td>${Number(booking.hours).toFixed(1)}</td><td><span class="badge">${esc(booking.status)}</span>${booking.cancellationRemark ? `<br><small>${esc(booking.cancellationRemark)}</small>` : ''}</td><td>${booking.status === 'Confirmed' ? `<button type="button" class="outline cancel-booking" data-id="${booking.id}">Cancel</button>` : ''}</td></tr>`).join('') : '<tr><td colspan="6" class="empty">No bookings yet.</td></tr>'}</tbody></table></div></section></div>`;

  hideLoader();
  const form = document.querySelector('#booking');
  setupPickers(form);
  form.elements.roomId.onchange = reset;
  document.querySelector('#out').onclick = event => {
    event.preventDefault();
    localStorage.removeItem('tenantBookingToken');
    token = '';
    login();
  };
  document.querySelectorAll('.cancel-booking').forEach(button => button.onclick = async () => {
    const remark = window.prompt('Why are you cancelling this booking? This remark will be saved with the booking.');
    if (remark === null) return;
    if (!remark.trim()) return alert('A cancellation remark is required.');
    if (!window.confirm('Cancel this booking and restore its hours to your allotment?')) return;
    try {
      const result = await api(`/api/tenant/bookings/${button.dataset.id}/cancel`, { method: 'POST', body: JSON.stringify({ remark }) });
      alert(`Booking cancelled. ${Number(result.remainingHours).toFixed(1)} hours are now available.`);
      await load();
    } catch (error) { alert(error.message); }
  });
  document.querySelector('#check').onclick = async () => {
    const query = new URLSearchParams(Object.fromEntries(new FormData(form)));
    try {
      const result = await api(`/api/tenant/availability?${query}`);
      const status = document.querySelector('#availability');
      verified = result.available;
      status.className = `status ${result.available ? 'ok' : 'no'}`;
      status.textContent = result.available ? `Available for ${Number(result.hours).toFixed(1)} hour(s). ${Number(result.remainingHours).toFixed(1)} allotted hours will remain before this booking.` : result.reason;
      if (!result.available) showSuggestedTimes(result.suggestions || [], form);
      document.querySelector('#book').disabled = !result.available;
    } catch (error) {
      verified = false;
      const status = document.querySelector('#availability');
      status.className = 'status no';
      status.textContent = error.message;
    }
  };
  form.onsubmit = async event => {
    event.preventDefault();
    if (!verified) return;
    try {
      const result = await api('/api/tenant/bookings', { method: 'POST', body: JSON.stringify(Object.fromEntries(new FormData(form))) });
      alert(`Booking confirmed. ${Number(result.remainingHours).toFixed(1)} hours remain.`);
      await load();
    } catch (error) {
      const status = document.querySelector('#availability');
      status.className = 'status no';
      status.textContent = error.message;
      verified = false;
    }
  };
}

token ? load() : login();
