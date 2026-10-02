const root = document.querySelector('#portal');
let token = localStorage.tenantBookingToken || '';
let data = null;
let verified = false;
let pickerCleanup = null;
let timeRestrictionTimer = null;
const BUSINESS_TIME_ZONE = 'Asia/Manila';

const esc = value => String(value ?? '').replace(/[&<>"']/g, character => ({
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#39;'
}[character]));

function businessNow() {
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-GB', {
    timeZone: BUSINESS_TIME_ZONE,
    calendar: 'gregory',
    numberingSystem: 'latn',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23'
  }).formatToParts(new Date()).filter(part => part.type !== 'literal').map(part => [part.type, part.value]));

  return {
    date: `${parts.year}-${parts.month}-${parts.day}`,
    time: `${parts.hour}:${parts.minute}`
  };
}

function today() {
  return businessNow().date;
}

function timeMinutes(value) {
  const match = /^(\d{2}):(\d{2})$/.exec(value || '');
  return match ? Number(match[1]) * 60 + Number(match[2]) : NaN;
}

function validTimeRange(startTime, endTime) {
  const start = timeMinutes(startTime);
  const end = timeMinutes(endTime);
  return Number.isFinite(start) && Number.isFinite(end) && end > start;
}

function nextAvailableEndTime(startTime) {
  const start = timeMinutes(startTime);
  if (!Number.isFinite(start)) return '';
  const next = start + 30;
  return next <= 23 * 60 + 30
    ? `${String(Math.floor(next / 60)).padStart(2, '0')}:${String(next % 60).padStart(2, '0')}`
    : '';
}

function isPastBookingTime(date, time) {
  const current = businessNow();
  if (date < current.date) return true;
  if (date > current.date) return false;
  return timeMinutes(time) <= timeMinutes(current.time);
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
  if (!response.ok) {
    const error = Error(result.error || result.message || 'Request failed');
    error.code = result.code;
    error.status = response.status;
    throw error;
  }
  return result;
}

function friendlyBookingError(error) {
  if (error?.code === 'BOOKING_TIME_IN_PAST') {
    return 'This booking time has already passed. Please select another available time.';
  }
  if (error?.code === 'BOOKING_END_BEFORE_START') {
    return 'Choose an end time later than the start time.';
  }
  if (error?.message?.includes('just been booked') || error?.message?.includes('busy in Google Calendar')) {
    return 'This time is no longer available. Please select another time.';
  }
  if (error?.name === 'TypeError' || error?.message === 'Failed to fetch') {
    return "We couldn't complete your booking. Please check your connection and try again.";
  }
  return error?.message || 'We could not complete your booking. Please try again.';
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

function updateWorkflow(form) {
  if (!form) return;
  const steps = [...form.querySelectorAll('[data-flow-step]')];
  const current = verified ? 4 : 3;
  steps.forEach((step, index) => {
    step.classList.toggle('is-current', index + 1 === current);
    step.classList.toggle('is-complete', index + 1 < current);
  });
}

function reset() {
  verified = false;
  const status = document.querySelector('#availability');
  if (status) {
    status.className = 'status info';
    status.textContent = 'Select a room, date, and time, then validate availability.';
  }
  document.querySelector('#book')?.setAttribute('disabled', '');
  updateWorkflow(document.querySelector('#booking'));
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

  if (fieldName === 'startTime') {
    const currentEnd = form.elements.endTime.value;
    if (!validTimeRange(value, currentEnd)) {
      const nextEnd = nextAvailableEndTime(value);
      form.elements.endTime.value = nextEnd;
      const endDisplay = form.querySelector('[data-time-display="endTime"]');
      if (endDisplay) endDisplay.textContent = formatTime(nextEnd);
    }
  }

  updateTimeRangeState(form);
}

function updateTimeRangeState(form) {
  const error = form?.querySelector('[data-time-range-error]');
  if (!error) return validTimeRange(form.elements.startTime.value, form.elements.endTime.value);

  const valid = validTimeRange(form.elements.startTime.value, form.elements.endTime.value);
  error.hidden = valid;
  error.textContent = valid ? '' : 'End time must be later than the selected start time.';
  form.elements.endTime.closest('.field')?.classList.toggle('has-error', !valid);
  return valid;
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
    const start = timeMinutes(form.elements.startTime.value);
    const options = Array.from({ length: 48 }, (_, index) => {
      const hours = Math.floor(index / 2);
      const minutes = index % 2 ? '30' : '00';
      const value = `${String(hours).padStart(2, '0')}:${minutes}`;
      const past = isPastBookingTime(dateInput.value, value);
      const beforeStart = fieldName === 'endTime' && (!Number.isFinite(start) || timeMinutes(value) <= start);
      const disabled = past || beforeStart;
      const hint = past ? 'Past' : beforeStart ? 'Before start' : '';
      return `<button type="button" class="time-option ${value === selected ? 'is-selected' : ''}" data-time-value="${value}" ${disabled ? 'disabled aria-disabled="true"' : ''}><span>${formatTime(value)}</span>${hint ? `<small>${hint}</small>` : ''}</button>`;
    }).join('');
    const guidance = fieldName === 'endTime'
      ? `Only intervals after ${formatTime(form.elements.startTime.value)} are selectable.`
      : 'Choose an available 30-minute interval.';
    popover.innerHTML = `<div class="picker-dialog-card"><div class="dialog-title-row"><div><small class="dialog-kicker">Time selection</small><strong class="dialog-title">Choose a time</strong></div><button type="button" class="dialog-close" data-time-close aria-label="Close time picker">×</button></div><div class="time-head"><small>${guidance}</small></div><div class="time-options">${options}</div></div>`;
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
    if (timeRestrictionTimer) window.clearInterval(timeRestrictionTimer);
    timeRestrictionTimer = null;
  };

  datePopover.hidden = true;
  renderCalendar();
  timePopovers.forEach(popover => { popover.hidden = true; });
  updateTimeRangeState(form);
  timeRestrictionTimer = window.setInterval(() => {
    if (dateInput.value === today() && isPastBookingTime(dateInput.value, form.elements.startTime.value)) {
      reset();
    }
    timePopovers.forEach(popover => {
      if (!popover.hidden) renderTimeOptions(popover, popover.dataset.timePopover);
    });
  }, 30000);
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

function durationLabel(startTime, endTime) {
  const minutes = timeMinutes(endTime) - timeMinutes(startTime);
  if (!Number.isFinite(minutes) || minutes <= 0) return '—';
  const hours = Math.floor(minutes / 60);
  const remainder = minutes % 60;
  return `${hours ? `${hours}h` : ''}${remainder ? ` ${remainder}m` : ''}`.trim();
}

function dialogFocusables(dialog) {
  return [...dialog.querySelectorAll('button:not([disabled]), a[href], input:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])')];
}

function installDialogKeyboard(dialog, onClose) {
  const onKeyDown = event => {
    if (event.key === 'Escape') {
      event.preventDefault();
      onClose();
      return;
    }
    if (event.key !== 'Tab') return;
    const focusables = dialogFocusables(dialog);
    if (!focusables.length) return;
    const first = focusables[0];
    const last = focusables[focusables.length - 1];
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  };
  document.addEventListener('keydown', onKeyDown);
  return () => document.removeEventListener('keydown', onKeyDown);
}

let walkthroughElement = null;
let walkthroughCleanup = null;

function walkthroughKey() {
  return `launchpadTenantWalkthrough:${data?.tenant?.id || 'tenant'}`;
}

function closeWalkthrough(markComplete = true) {
  if (walkthroughCleanup) walkthroughCleanup();
  walkthroughCleanup = null;
  walkthroughElement?.remove();
  walkthroughElement = null;
  document.body.classList.remove('walkthrough-open');
  if (markComplete) localStorage.setItem(walkthroughKey(), 'done');
}

function startWalkthrough(force = false) {
  if (!data) return;
  if (!force && localStorage.getItem(walkthroughKey()) === 'done') return;
  closeWalkthrough(false);

  const steps = [
    { target: '.hero', title: 'Welcome to Launchpad Space', text: 'This is your tenant booking portal. Choose a workspace, select a future time, and manage your reservations here.' },
    { target: '[data-walkthrough="room"]', title: 'Choose a workspace', text: 'Start by selecting the room you want to reserve. The room details and capacity are shown in the list.' },
    { target: '[data-walkthrough="date"]', title: 'Choose your date', text: 'Select a date from the calendar. Past dates are disabled automatically.' },
    { target: '[data-walkthrough="time"]', title: 'Choose a valid time', text: 'Pick a future time interval, then check availability. Past and unavailable choices cannot be confirmed.' },
    { target: '#book', title: 'Review and confirm', text: 'After availability is confirmed, review the booking summary before submitting your reservation.' },
    { target: '.history-card', title: 'Manage your bookings', text: 'Your confirmed and cancelled reservations remain available in your booking history.' }
  ];

  const overlay = document.createElement('div');
  overlay.className = 'walkthrough-overlay';
  overlay.setAttribute('role', 'dialog');
  overlay.setAttribute('aria-modal', 'true');
  overlay.setAttribute('aria-labelledby', 'walkthrough-title');
  overlay.innerHTML = '<div class="walkthrough-spotlight" aria-hidden="true"></div><section class="walkthrough-card"><div class="walkthrough-progress" id="walkthrough-progress"></div><h2 id="walkthrough-title"></h2><p id="walkthrough-text"></p><div class="walkthrough-dots" aria-hidden="true"></div><div class="walkthrough-actions"><button type="button" class="outline walkthrough-skip">Skip</button><div><button type="button" class="outline walkthrough-back">Back</button><button type="button" class="primary walkthrough-next">Next</button></div></div></section>';
  document.body.append(overlay);
  walkthroughElement = overlay;
  document.body.classList.add('walkthrough-open');

  const card = overlay.querySelector('.walkthrough-card');
  const spotlight = overlay.querySelector('.walkthrough-spotlight');
  const progress = overlay.querySelector('#walkthrough-progress');
  const title = overlay.querySelector('#walkthrough-title');
  const text = overlay.querySelector('#walkthrough-text');
  const dots = overlay.querySelector('.walkthrough-dots');
  const back = overlay.querySelector('.walkthrough-back');
  const next = overlay.querySelector('.walkthrough-next');
  let index = 0;
  const previousFocus = document.activeElement;

  dots.innerHTML = steps.map((_, stepIndex) => `<span class="walkthrough-dot" data-dot="${stepIndex}"></span>`).join('');

  const position = target => {
    if (!target) {
      spotlight.hidden = true;
      card.style.left = '50%';
      card.style.top = '50%';
      card.style.transform = 'translate(-50%, -50%)';
      return;
    }
    const rect = target.getBoundingClientRect();
    const padding = 8;
    spotlight.hidden = false;
    spotlight.style.left = `${Math.max(8, rect.left - padding)}px`;
    spotlight.style.top = `${Math.max(8, rect.top - padding)}px`;
    spotlight.style.width = `${Math.min(window.innerWidth - 16, rect.width + padding * 2)}px`;
    spotlight.style.height = `${Math.min(window.innerHeight - 16, rect.height + padding * 2)}px`;
    card.style.transform = 'none';
    const cardWidth = card.offsetWidth;
    const cardHeight = card.offsetHeight;
    const left = Math.min(Math.max(16, rect.left), Math.max(16, window.innerWidth - cardWidth - 16));
    let top = rect.bottom + 18;
    if (top + cardHeight > window.innerHeight - 16) top = rect.top - cardHeight - 18;
    if (top < 16) top = 16;
    card.style.left = `${left}px`;
    card.style.top = `${top}px`;
  };

  const renderStep = () => {
    const step = steps[index];
    progress.textContent = `${index + 1} of ${steps.length}`;
    title.textContent = step.title;
    text.textContent = step.text;
    back.disabled = index === 0;
    next.textContent = index === steps.length - 1 ? 'Finish' : 'Next';
    overlay.querySelectorAll('[data-dot]').forEach(dot => dot.classList.toggle('is-current', Number(dot.dataset.dot) === index));
    const target = step.target ? document.querySelector(step.target) : null;
    if (target) target.scrollIntoView({ block: 'center', behavior: 'smooth' });
    window.setTimeout(() => position(target), 120);
  };

  const cleanup = installDialogKeyboard(overlay, () => closeWalkthrough(true));
  walkthroughCleanup = () => {
    cleanup();
    window.removeEventListener('resize', onResize);
    window.removeEventListener('scroll', onResize);
    previousFocus?.focus?.();
  };
  const onResize = () => position(steps[index].target ? document.querySelector(steps[index].target) : null);
  window.addEventListener('resize', onResize);
  window.addEventListener('scroll', onResize);
  overlay.querySelector('.walkthrough-skip').onclick = () => closeWalkthrough(true);
  back.onclick = () => { if (index > 0) { index -= 1; renderStep(); } };
  next.onclick = () => {
    if (index === steps.length - 1) closeWalkthrough(true);
    else { index += 1; renderStep(); }
  };
  overlay.onclick = event => { if (event.target === overlay) closeWalkthrough(true); };
  renderStep();
  window.setTimeout(() => next.focus(), 0);
}

let confirmModalElement = null;
let confirmModalCleanup = null;
let confirmSubmitting = false;

function closeConfirmModal() {
  if (confirmSubmitting) return;
  if (confirmModalCleanup) confirmModalCleanup();
  confirmModalCleanup = null;
  confirmModalElement?.remove();
  confirmModalElement = null;
  document.body.classList.remove('modal-open');
}

function showConfirmError(modal, form, message) {
  confirmSubmitting = false;
  verified = false;
  const errorBox = modal.querySelector('[data-confirm-error]');
  const confirmButton = modal.querySelector('[data-confirm-submit]');
  const cancelButton = modal.querySelector('[data-confirm-cancel]');
  errorBox.hidden = false;
  errorBox.textContent = message;
  confirmButton.disabled = false;
  confirmButton.className = 'outline';
  confirmButton.textContent = 'Choose another time';
  cancelButton.disabled = false;
  document.querySelector('#book')?.setAttribute('disabled', '');
  const status = document.querySelector('#availability');
  if (status) {
    status.className = 'status no';
    status.textContent = message;
  }
  confirmButton.onclick = async () => {
    closeConfirmModal();
    reset();
    await load();
  };
  updateWorkflow(form);
}

function renderBookingSuccess(modal, form, values) {
  confirmSubmitting = false;
  const roomName = data.rooms.find(room => room.id === form.elements.roomId.value)?.name || form.elements.roomId.selectedOptions[0]?.textContent || 'Selected workspace';
  modal.querySelector('.confirm-dialog-content').innerHTML = `<div class="success-mark" aria-hidden="true">✓</div><p class="dialog-kicker">Booking confirmed</p><h2 id="confirm-booking-title">Your reservation is ready</h2><p class="confirm-intro">Your workspace booking was successfully created.</p><div class="summary-grid"><div><small>Workspace</small><strong>${esc(roomName)}</strong></div><div><small>Date</small><strong>${esc(formatDate(values.date))}</strong></div><div><small>Time</small><strong>${esc(formatTime(values.startTime))} – ${esc(formatTime(values.endTime))}</strong></div><div><small>Duration</small><strong>${esc(durationLabel(values.startTime, values.endTime))}</strong></div></div>`;
  modal.querySelector('.confirm-modal-actions').innerHTML = '<button type="button" class="outline" data-success-done>Done</button><button type="button" class="primary" data-success-history>View my bookings</button>';
  const refresh = async scrollToHistory => {
    closeConfirmModal();
    await load();
    if (scrollToHistory) document.querySelector('.history-card')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  };
  modal.querySelector('[data-success-done]').onclick = () => refresh(false);
  modal.querySelector('[data-success-history]').onclick = () => refresh(true);
}

async function submitBookingFromModal(form, values, modal) {
  if (confirmSubmitting) return;
  const latest = Object.fromEntries(new FormData(form));
  if (!validTimeRange(latest.startTime, latest.endTime)) {
    showConfirmError(modal, form, 'Choose an end time later than the start time.');
    return;
  }
  if (isPastBookingTime(latest.date, latest.startTime)) {
    showConfirmError(modal, form, 'This booking time has already passed. Please select another available time.');
    return;
  }
  confirmSubmitting = true;
  const confirmButton = modal.querySelector('[data-confirm-submit]');
  const cancelButton = modal.querySelector('[data-confirm-cancel]');
  confirmButton.disabled = true;
  confirmButton.textContent = 'Confirming…';
  cancelButton.disabled = true;
  try {
    await api('/api/tenant/bookings', { method: 'POST', body: JSON.stringify(latest) });
    renderBookingSuccess(modal, form, latest);
  } catch (error) {
    showConfirmError(modal, form, friendlyBookingError(error));
  }
}

function openConfirmModal(form) {
  if (confirmModalElement) return;
  const values = Object.fromEntries(new FormData(form));
  const roomName = data.rooms.find(room => room.id === form.elements.roomId.value)?.name || form.elements.roomId.selectedOptions[0]?.textContent || 'Selected workspace';
  const modal = document.createElement('div');
  modal.className = 'confirm-modal';
  modal.setAttribute('role', 'dialog');
  modal.setAttribute('aria-modal', 'true');
  modal.setAttribute('aria-labelledby', 'confirm-booking-title');
  modal.innerHTML = `<section class="confirm-dialog"><div class="dialog-title-row"><div><p class="dialog-kicker">Review reservation</p><h2 id="confirm-booking-title">Confirm your booking</h2></div><button type="button" class="dialog-close" data-confirm-close aria-label="Close confirmation dialog">×</button></div><div class="confirm-dialog-content"><p class="confirm-intro">Please review the details before confirming.</p><div class="summary-grid"><div><small>Workspace</small><strong>${esc(roomName)}</strong></div><div><small>Date</small><strong>${esc(formatDate(values.date))}</strong></div><div><small>Time</small><strong>${esc(formatTime(values.startTime))} – ${esc(formatTime(values.endTime))}</strong></div><div><small>Duration</small><strong>${esc(durationLabel(values.startTime, values.endTime))}</strong></div></div><div class="confirm-note">Your allotted hours will be deducted only after the booking is successfully confirmed.</div><div class="modal-error" data-confirm-error role="alert" hidden></div></div><div class="confirm-modal-actions"><button type="button" class="outline" data-confirm-cancel>Keep editing</button><button type="button" class="primary" data-confirm-submit>Confirm Booking</button></div></section>`;
  document.body.append(modal);
  confirmModalElement = modal;
  document.body.classList.add('modal-open');
  const dialog = modal.querySelector('.confirm-dialog');
  const close = () => closeConfirmModal();
  const previousFocus = document.activeElement;
  modal.querySelector('[data-confirm-close]').onclick = close;
  modal.querySelector('[data-confirm-cancel]').onclick = close;
  modal.querySelector('[data-confirm-submit]').onclick = () => submitBookingFromModal(form, values, modal);
  modal.onclick = event => { if (event.target === modal && !confirmSubmitting) close(); };
  const keyboardCleanup = installDialogKeyboard(dialog, close);
  confirmModalCleanup = () => {
    keyboardCleanup();
    previousFocus?.focus?.();
  };
  window.setTimeout(() => modal.querySelector('[data-confirm-submit]').focus(), 0);
}

function render() {
  const tenant = data.tenant;
  const currentDate = today();
  root.innerHTML = `<div class="portal-shell"><header class="top"><div class="brand">Launchpad<i> Tenant</i></div><a href="#" id="out">Sign out</a></header><section class="hero"><div><span class="badge">${data.calendarConnected ? 'Google Calendar connected' : 'LAN availability checking'}</span><h1>Welcome, ${esc(tenant.fullName)}</h1><p>${esc(tenant.companyName || 'Individual tenant')} · ${esc(tenant.location)}</p></div><div class="remaining"><small>Remaining allotted time</small><strong>${Number(tenant.remainingHours).toFixed(1)} h</strong></div></section><div class="grid"><section class="card"><h2>Choose a room and time</h2><div class="sub">Your booking is confirmed only after the selected interval is available.</div><form id="booking" class="room-form"><div class="field wide"><label>Available room</label><select name="roomId" required>${data.rooms.map(room => `<option value="${room.id}">${esc(room.name)} — ${esc(room.location)}${room.capacity ? ` (${room.capacity} seats)` : ''}</option>`).join('')}</select></div><div class="field"><label>Date</label><div class="picker-wrap"><button type="button" class="picker-trigger" data-date-trigger aria-haspopup="dialog" aria-expanded="false"><span class="picker-trigger-copy"><small>Booking date</small><strong data-date-display>${formatDate(currentDate)}</strong></span><span class="picker-icon">▦</span></button><div class="picker-popover date-popover" data-date-popover role="dialog" aria-label="Choose booking date"></div></div><input type="hidden" name="date" value="${currentDate}"></div><div class="field"><label>Start time</label><div class="picker-wrap"><button type="button" class="picker-trigger" data-time-trigger="startTime" aria-haspopup="dialog"><span class="picker-trigger-copy"><small>From</small><strong data-time-display="startTime">${formatTime('09:00')}</strong></span><span class="picker-icon">◷</span></button><div class="picker-popover time-popover" data-time-popover="startTime" role="dialog" aria-label="Choose start time"></div></div><input type="hidden" name="startTime" value="09:00"></div><div class="field"><label>End time</label><div class="picker-wrap"><button type="button" class="picker-trigger" data-time-trigger="endTime" aria-haspopup="dialog"><span class="picker-trigger-copy"><small>Until</small><strong data-time-display="endTime">${formatTime('10:00')}</strong></span><span class="picker-icon">◷</span></button><div class="picker-popover time-popover" data-time-popover="endTime" role="dialog" aria-label="Choose end time"></div></div><input type="hidden" name="endTime" value="10:00"><small class="field-error" data-time-range-error hidden role="alert"></small></div><div class="field"><label>Tenant location</label><input value="${esc(tenant.location)}" disabled></div><div class="form-actions wide"><button type="button" class="outline" id="check">Check availability</button><button class="primary" id="book" disabled>Confirm booking</button></div></form><div class="status info" id="availability">Select a room, date, and time, then validate availability.</div><div class="notice">Hours are deducted automatically when a booking is confirmed.</div></section><aside class="card how"><h2>Booking guide</h2><ol><li>Choose the room, date, and exact hours.</li><li>Check availability against the local schedule${data.calendarConnected ? ' and company Google Calendar' : ''}.</li><li>Confirm to deduct only the hours you use.</li></ol><b>Allotted:</b> ${Number(tenant.allottedHours).toFixed(1)} h<br><b>Used:</b> ${(Number(tenant.allottedHours) - Number(tenant.remainingHours)).toFixed(1)} h</aside></div><section class="card history-card"><h2>Your booking history</h2><div class="table-wrap"><table class="table"><thead><tr><th>Date</th><th>Time</th><th>Room</th><th>Hours</th><th>Status / remark</th><th></th></tr></thead><tbody>${data.bookings.length ? data.bookings.map(booking => `<tr><td>${esc(booking.date)}</td><td>${esc(booking.startTime)}–${esc(booking.endTime)}</td><td>${esc(booking.room?.name || booking.roomName)}</td><td>${Number(booking.hours).toFixed(1)}</td><td><span class="badge ${booking.status === 'Cancelled' ? 'badge-cancelled' : 'badge-confirmed'}">${esc(booking.status)}</span>${booking.cancellationRemark ? `<br><small>${esc(booking.cancellationRemark)}</small>` : ''}</td><td>${booking.status === 'Confirmed' ? `<button type="button" class="outline cancel-booking" data-id="${booking.id}">Cancel</button>` : ''}</td></tr>`).join('') : '<tr><td colspan="6" class="empty">No bookings yet.</td></tr>'}</tbody></table></div></section></div>`;

  const formShell = root.querySelector('#booking');
  const topHeader = root.querySelector('.top');
  topHeader?.querySelector('#out')?.insertAdjacentHTML('beforebegin', '<button type="button" class="help-button" id="help">How to book</button>');
  const helpButton = topHeader?.querySelector('#help');
  const signOut = topHeader?.querySelector('#out');
  if (helpButton && signOut) {
    const topActions = document.createElement('div');
    topActions.className = 'top-actions';
    topActions.append(helpButton, signOut);
    topHeader.append(topActions);
  }
  const bookingCard = formShell?.closest('.card');
  const subtitle = bookingCard?.querySelector('.sub');
  subtitle?.insertAdjacentHTML('afterend', '<div class="booking-flow" aria-label="Booking progress"><span data-flow-step="1"><b>1</b>Workspace</span><span data-flow-step="2"><b>2</b>Date</span><span data-flow-step="3"><b>3</b>Time &amp; availability</span><span data-flow-step="4"><b>4</b>Confirm</span></div>');
  if (formShell) {
    formShell.elements.roomId.closest('.field')?.setAttribute('data-walkthrough', 'room');
    formShell.elements.date.closest('.field')?.setAttribute('data-walkthrough', 'date');
    formShell.elements.startTime.closest('.field')?.setAttribute('data-walkthrough', 'time');
  }
  const bookButtonBeforeSetup = root.querySelector('#book');
  if (bookButtonBeforeSetup) bookButtonBeforeSetup.textContent = 'Review booking';
  const availabilityStatus = root.querySelector('#availability');
  availabilityStatus?.setAttribute('role', 'status');
  availabilityStatus?.setAttribute('aria-live', 'polite');
  const guide = root.querySelector('.how');
  guide?.insertAdjacentHTML('beforeend', '<button type="button" class="help-button guide-help" id="guide-help">Open booking guide</button>');
  const historyCard = root.querySelector('.history-card');
  historyCard?.setAttribute('data-walkthrough', 'history');
  if (!data.bookings.length) {
    const emptyCell = historyCard?.querySelector('.empty');
    if (emptyCell) {
      emptyCell.className = 'empty-state-cell';
      emptyCell.innerHTML = '<div class="empty-state"><strong>No bookings yet</strong><span>You do not have any workspace reservations.</span><button type="button" class="outline" id="empty-book">Book a workspace</button></div>';
    }
  }

  hideLoader();
  const form = document.querySelector('#booking');
  setupPickers(form);
  updateWorkflow(form);
  form.elements.roomId.onchange = reset;
  document.querySelector('#help')?.addEventListener('click', () => startWalkthrough(true));
  document.querySelector('#guide-help')?.addEventListener('click', () => startWalkthrough(true));
  document.querySelector('#empty-book')?.addEventListener('click', () => form.scrollIntoView({ behavior: 'smooth', block: 'start' }));
  document.querySelector('#out').onclick = event => {
    event.preventDefault();
    closeWalkthrough(false);
    closeConfirmModal();
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
      await api(`/api/tenant/bookings/${button.dataset.id}/cancel`, { method: 'POST', body: JSON.stringify({ remark }) });
      await load();
    } catch (error) { alert(friendlyBookingError(error)); }
  });
  let checking = false;
  document.querySelector('#check').onclick = async () => {
    if (checking) return;
    const values = Object.fromEntries(new FormData(form));
    if (!updateTimeRangeState(form)) {
      verified = false;
      const status = document.querySelector('#availability');
      status.className = 'status no';
      status.textContent = 'Choose an end time later than the start time.';
      document.querySelector('#book').disabled = true;
      updateWorkflow(form);
      return;
    }
    if (isPastBookingTime(values.date, values.startTime)) {
      verified = false;
      const status = document.querySelector('#availability');
      status.className = 'status no';
      status.textContent = 'This time has already passed. Please select a future booking time.';
      document.querySelector('#book').disabled = true;
      updateWorkflow(form);
      return;
    }
    checking = true;
    verified = false;
    const checkButton = document.querySelector('#check');
    const bookButton = document.querySelector('#book');
    const status = document.querySelector('#availability');
    checkButton.disabled = true;
    checkButton.textContent = 'Checking…';
    bookButton.disabled = true;
    status.className = 'status loading';
    status.textContent = 'Checking the latest availability…';
    const query = new URLSearchParams(values);
    try {
      const result = await api(`/api/tenant/availability?${query}`);
      verified = result.available;
      status.className = `status ${result.available ? 'ok' : 'no'}`;
      status.textContent = result.available ? `Available for ${Number(result.hours).toFixed(1)} hour(s). Review the details before confirming.` : (result.reason || 'This time is not available.');
      if (!result.available) showSuggestedTimes(result.suggestions || [], form);
      bookButton.disabled = !result.available;
      updateWorkflow(form);
    } catch (error) {
      verified = false;
      status.className = 'status no';
      status.textContent = friendlyBookingError(error);
      updateWorkflow(form);
    } finally {
      checking = false;
      checkButton.disabled = false;
      checkButton.textContent = 'Check availability';
    }
  };
  form.onsubmit = event => {
    event.preventDefault();
    if (!verified) return;
    const values = Object.fromEntries(new FormData(form));
    if (!updateTimeRangeState(form)) {
      verified = false;
      const status = document.querySelector('#availability');
      status.className = 'status no';
      status.textContent = 'Choose an end time later than the start time.';
      document.querySelector('#book').disabled = true;
      updateWorkflow(form);
      return;
    }
    if (isPastBookingTime(values.date, values.startTime)) {
      verified = false;
      const status = document.querySelector('#availability');
      status.className = 'status no';
      status.textContent = 'This time has already passed. Please select another available time.';
      document.querySelector('#book').disabled = true;
      updateWorkflow(form);
      return;
    }
    openConfirmModal(form);
  };
  window.setTimeout(() => startWalkthrough(false), 500);
}

token ? load() : login();
