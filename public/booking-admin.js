const root=document.querySelector('#admin'),modal=document.querySelector('#modal');let token=localStorage.bookingAdminToken||'',state=null;const $=s=>document.querySelector(s),esc=v=>String(v??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));

/* ── Loader helpers ── */
const loader=document.getElementById('lp-loader');
function showLoader(){if(loader)loader.classList.remove('hidden');}
function hideLoader(){if(loader)loader.classList.add('hidden');}
window.addEventListener('DOMContentLoaded',()=>{setTimeout(hideLoader,300);});
window.addEventListener('pageshow',()=>{setTimeout(hideLoader,150);});

async function api(url,options={}){const r=await fetch(url,{...options,headers:{'Content-Type':'application/json',Authorization:`Bearer ${token}`,...options.headers}}),d=await r.json();if(!r.ok)throw Error(d.error||'Request failed');return d}

function login(){
  root.innerHTML=`<section class="login"><form class="login-card" id="login"><div class="brand">Launchpad<i> Tenant</i></div><div class="eyebrow">Booking administration</div><h1>Manage tenant bookings.</h1><div class="sub">Sign in with a system administrator account.</div><div class="field"><label>Username</label><input name="username" autocomplete="username" required></div><div class="field"><label>Password</label><input name="password" type="password" autocomplete="current-password" required></div><button class="primary" id="login-btn" style="width:100%;margin-top:8px">Sign in</button><div class="error" id="error"></div></form></section>`;
  const loginForm=$('#login');
  const loginBtn=$('#login-btn');
  const errorEl=$('#error');
  let submitting=false;
  loginForm.onsubmit=async e=>{
    e.preventDefault();
    if(submitting)return;
    submitting=true;
    loginBtn.disabled=true;
    loginBtn.textContent='Signing in…';
    errorEl.textContent='';
    showLoader();
    try{
      const r=await api('/api/login',{method:'POST',body:JSON.stringify(Object.fromEntries(new FormData(e.target)))});
      if(r.user.role!=='admin')throw Error('Only system administrators can manage tenant bookings.');
      token=r.token;localStorage.bookingAdminToken=token;load();
    }catch(x){
      hideLoader();
      errorEl.textContent=x.message;
      loginBtn.disabled=false;
      loginBtn.textContent='Sign in';
      submitting=false;
    }
  };
}

async function load(){
  showLoader();
  try{state=await api('/api/booking-admin');render();}
  catch(e){
    hideLoader();
    if(e.message==='Only admins can manage tenant bookings'||e.message==='Please sign in'){localStorage.removeItem('bookingAdminToken');token='';login();}
    else alert(e.message);
  }
}

function render(){
  const allotted=state.tenants.reduce((n,t)=>n+Number(t.allottedHours),0),used=state.tenants.reduce((n,t)=>n+Number(t.usedHours),0);
  root.innerHTML=`<div class="shell"><header class="top"><div class="brand">Launchpad<i> Tenant</i></div><div class="top-right"><span class="pill">Booking admin</span><button class="outline" id="out">Sign out</button></div></header><section class="panel-head"><div><h1>Tenant booking control</h1><p>Tenant portal: <a href="/" target="_blank">${location.origin}</a></p></div><div class="actions"><button class="outline" id="add-room">+ Add room</button><button class="primary" id="add-tenant">+ Add tenant</button></div></section><section class="stats"><div class="card metric"><small>Active tenants</small><b>${state.tenants.filter(t=>t.status==='Active').length}</b></div><div class="card metric"><small>Allotted hours</small><b>${allotted.toFixed(1)}</b></div><div class="card metric"><small>Hours used</small><b>${used.toFixed(1)}</b></div><div class="card metric"><small>Integrations</small><b>${state.calendarConnected?'Calendar':'Local'}</b><span class="${state.emailConfigured?'ok':'warn'}">${state.emailConfigured?'Email ready':'SMTP not configured'}</span></div></section><section class="section"><h2>Tenant accounts</h2><div class="table-wrap"><table class="table"><thead><tr><th>Tenant / company</th><th>Email &amp; location</th><th>Allotted</th><th>Used</th><th>Remaining</th><th></th></tr></thead><tbody>${state.tenants.length?state.tenants.map(t=>`<tr><td><span class="name">${esc(t.fullName)}</span><br><small>${esc(t.companyName||'—')}</small></td><td>${esc(t.email)}<br><small>${esc(t.location)}</small></td><td>${Number(t.allottedHours).toFixed(1)} h</td><td>${Number(t.usedHours).toFixed(1)} h</td><td><span class="pill">${Number(t.remainingHours).toFixed(1)} h</span></td><td><button class="outline edit-tenant" data-id="${t.id}">Edit</button><button class="outline email-tenant" data-id="${t.id}">Report</button><button class="danger delete-tenant" data-id="${t.id}">Delete</button></td></tr>`).join(''):'<tr><td class="sub" colspan="6">No tenants yet.</td></tr>'}</tbody></table></div></section><section class="section"><h2>Available rooms</h2><div class="table-wrap"><table class="table"><thead><tr><th>Room</th><th>Location</th><th>Capacity</th><th>Calendar</th><th></th></tr></thead><tbody>${state.rooms.map(r=>`<tr><td class="name">${esc(r.name)}</td><td>${esc(r.location)}</td><td>${esc(r.capacity||'—')}</td><td>${r.calendarId?'Room calendar':'Company default'}</td><td><button class="outline edit-room" data-id="${r.id}">Edit</button><button class="danger delete-room" data-id="${r.id}">Delete</button></td></tr>`).join('')}</tbody></table></div></section><section class="section"><h2>Booking history</h2><div class="table-wrap"><table class="table"><thead><tr><th>Date</th><th>Tenant</th><th>Room</th><th>Time</th><th>Hours</th><th></th></tr></thead><tbody>${state.bookings.length?state.bookings.map(b=>`<tr><td>${esc(b.date)}</td><td>${esc(b.tenant?.fullName||b.tenantName)}<br><small>${esc(b.tenant?.companyName||b.companyName||'')}</small></td><td>${esc(b.room?.name||b.roomName)}</td><td>${esc(b.startTime)}–${esc(b.endTime)}</td><td>${Number(b.hours).toFixed(1)}</td><td><button class="danger delete-booking" data-id="${b.id}">Delete</button></td></tr>`).join(''):'<tr><td class="sub" colspan="6">No bookings yet.</td></tr>'}</tbody></table></div></section></div>`;
  hideLoader();
  $('#out').onclick=()=>{localStorage.removeItem('bookingAdminToken');token='';login()};
  $('#add-tenant').onclick=()=>tenantForm();
  $('#add-room').onclick=()=>roomForm();
  document.querySelectorAll('.edit-tenant').forEach(b=>b.onclick=()=>tenantForm(state.tenants.find(t=>t.id===b.dataset.id)));
  document.querySelectorAll('.edit-room').forEach(b=>b.onclick=()=>roomForm(state.rooms.find(r=>r.id===b.dataset.id)));
  document.querySelectorAll('.delete-tenant').forEach(b=>b.onclick=()=>remove(`/api/tenants/${b.dataset.id}`,'Delete this tenant?'));
  document.querySelectorAll('.delete-room').forEach(b=>b.onclick=()=>remove(`/api/rooms/${b.dataset.id}`,'Delete this room?'));
  document.querySelectorAll('.delete-booking').forEach(b=>b.onclick=()=>remove(`/api/bookings/${b.dataset.id}`,'Delete this booking and its Google Calendar event, if synced?'));
  document.querySelectorAll('.email-tenant').forEach(b=>b.onclick=async()=>{if(!state.emailConfigured)return alert('SMTP is not configured on the server.');if(!confirm('Send this tenant their usage report?'))return;try{const r=await api(`/api/tenant-reports/${b.dataset.id}/send`,{method:'POST'});alert(`Usage report sent to ${r.to}.`)}catch(e){alert(e.message)}});
}

function form(title,fields,submit){
  const controls=fields.map(f=>`<div class="field"><label>${f.label}</label>${f.type==='select'?`<select name="${f.name}">${f.options.map(x=>`<option value="${esc(x)}" ${String(x)===String(f.value)?'selected':''}>${esc(x)}</option>`).join('')}</select>`:`<input name="${f.name}" type="${f.type||'text'}" value="${esc(f.value||'')}" ${f.required?'required':''}>`}</div>`).join('');
  modal.innerHTML=`<div class="modal-bg"><form class="modal-card" id="form"><h2>${title}</h2><div class="form-grid">${controls}</div><div class="modal-actions"><button type="button" class="outline" id="cancel">Cancel</button><button class="primary">Save</button></div></form></div>`;
  $('#cancel').onclick=()=>modal.innerHTML='';
  $('#form').onsubmit=async e=>{e.preventDefault();try{await submit(Object.fromEntries(new FormData(e.target)));modal.innerHTML='';load()}catch(x){alert(x.message)}};
}

function tenantForm(t={}){form(t.id?'Edit tenant':'Add tenant',[{name:'fullName',label:'Full name',value:t.fullName,required:true},{name:'companyName',label:'Company name',value:t.companyName},{name:'email',label:'Email address',type:'email',value:t.email,required:true},{name:'location',label:'Location',value:t.location,required:true},{name:'allottedHours',label:'Allotted hours',type:'number',value:t.allottedHours??0,required:true},{name:'status',label:'Status',type:'select',options:['Active','Inactive'],value:t.status||'Active'},{name:'accessCode',label:t.id?'New access code (optional)':'Tenant access code',type:'password',required:!t.id}],b=>api(t.id?`/api/tenants/${t.id}`:'/api/tenants',{method:t.id?'PUT':'POST',body:JSON.stringify(b)}))}
function roomForm(r={}){form(r.id?'Edit room':'Add room',[{name:'name',label:'Room name',value:r.name,required:true},{name:'location',label:'Location',value:r.location,required:true},{name:'capacity',label:'Capacity',type:'number',value:r.capacity||''},{name:'calendarId',label:'Google Calendar ID (optional)',value:r.calendarId||''}],b=>api(r.id?`/api/rooms/${r.id}`:'/api/rooms',{method:r.id?'PUT':'POST',body:JSON.stringify(b)}))}
async function remove(url,message){if(confirm(message)){try{await api(url,{method:'DELETE'});load()}catch(e){alert(e.message)}}}
token?load():login();
