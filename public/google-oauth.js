(() => {
  const api = async (url, options = {}) => {
    const response = await fetch(url, {
      ...options,
      headers: { Authorization: `Bearer ${localStorage.bookingAdminToken || ''}`, ...options.headers }
    });
    const body = await response.json();
    if (!response.ok) throw Error(body.error || 'Google Calendar request failed');
    return body;
  };

  const addConnectionControl = async () => {
    const actions = document.querySelector('.panel-head .actions');
    if (!actions || document.querySelector('#google-calendar-connect')) return;

    const control = document.createElement('div');
    control.id = 'google-calendar-connect';
    control.style.cssText = 'display:flex;align-items:center;gap:8px;flex-wrap:wrap';
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'outline';
    control.append(button);
    actions.prepend(control);

    try {
      const status = await api('/api/google/status');
      if (status.connected) {
        button.textContent = 'Google Calendar connected';
        button.disabled = true;
        const note = document.createElement('small');
        note.className = 'ok';
        note.textContent = 'Availability checks use your authorized Google account.';
        control.append(note);
      } else if (!status.configured) {
        button.textContent = 'Google OAuth needs setup';
        button.disabled = true;
        button.title = 'Set the Google OAuth environment variables on the server, then restart it.';
      } else {
        button.textContent = 'Connect Google Calendar';
        button.onclick = async () => {
          try {
            const authorization = await api('/api/google/authorize', { method: 'POST' });
            location.assign(authorization.url);
          } catch (error) {
            alert(error.message);
          }
        };
      }
    } catch (error) {
      button.textContent = 'Google Calendar unavailable';
      button.disabled = true;
      button.title = error.message;
    }
  };

  new MutationObserver(addConnectionControl).observe(document.documentElement, { childList: true, subtree: true });
  addConnectionControl();
})();
