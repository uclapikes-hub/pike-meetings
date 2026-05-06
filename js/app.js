// ===================================================================
// PIKE Meeting Tracker — Main App  (Stage 2)
// ===================================================================
// Stage 2 ships:
//   - Meetings tab functional: create, list (upcoming + past toggle), QR, delete
//   - Roll Call tab functional: signed-in brother sees active meeting + scan/tap to mark present
//   - Bylaw enforcement: 4 mandatory meetings/quarter cap, 14-day warning
//   - Per-meeting QR window override (default 5 min after start)
//   - URL hash routing: #meeting=ID auto-opens Roll Call
//
// Stage 1 features preserved: auth, roles, quarter selector, settings, My Standing.
// ===================================================================

import {
  authApi, roster, meetings, attendance, absenceRequests,
  noShows, fines, settings,
  EXEC_EMAILS, APPROVER_EMAILS, SGT_AT_ARMS_EMAIL, TREASURER_EMAIL,
} from "./data.js";
import {
  currentQuarter, formatQuarter, quartersFromRecords,
} from "./quarters.js";

// ---------------- App state ----------------
const state = {
  user: null,
  roster: [],
  meetings: [],
  attendance: [],
  absenceRequests: [],
  noShows: [],
  fines: [],
  settings: {},
  selectedQuarter: currentQuarter(),
  showPastMeetings: false,
};

let currentQrMeeting = null;
let currentQrCanvas  = null;
let rollCallTimer    = null;

const $ = id => document.getElementById(id);

function escapeHtml(s) {
  return String(s == null ? "" : s).replace(/[&<>"']/g, ch => ({
    "&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;",
  })[ch]);
}

function toast(msg, isError) {
  const el = $("toast");
  el.textContent = msg;
  el.classList.toggle("error", !!isError);
  el.classList.add("show");
  setTimeout(() => el.classList.remove("show"), 2600);
}

function inQuarter(rec) {
  if (state.selectedQuarter === "all") return true;
  return rec.quarter === state.selectedQuarter;
}

const ROLE_LABELS = {
  exec: "Exec", sgt: "Sgt-at-Arms", treasurer: "Treasurer",
  vice_chair: "J-Board Vice Chair", brother: "Brother", guest: "Guest",
};

// ===================================================================
// TIME UTILITIES (for meeting QR windows)
// ===================================================================

// Build a Date object from "YYYY-MM-DD" + "HH:MM" in local time
function combineLocalDateTime(dateStr, timeStr) {
  if (!dateStr || !timeStr) return null;
  const [y, m, d] = dateStr.split("-").map(Number);
  const [h, mn] = timeStr.split(":").map(Number);
  return new Date(y, m - 1, d, h, mn, 0, 0);
}

// QR window: opens 15 min before start, closes (start + windowMinutes)
function qrWindow(meeting) {
  const start = combineLocalDateTime(meeting.date, meeting.startTime);
  if (!start) return { opens: null, closes: null, isOpen: false, isPast: false };
  const windowMin = Number(meeting.qrWindowMinutes || 5);
  const opens  = new Date(start.getTime() - 15 * 60 * 1000);
  const closes = new Date(start.getTime() + windowMin * 60 * 1000);
  const now    = Date.now();
  return {
    opens,
    closes,
    start,
    isOpen: now >= opens.getTime() && now < closes.getTime(),
    isPast: now >= closes.getTime(),
    isFuture: now < opens.getTime(),
  };
}

function fmtTime(timeStr) {
  if (!timeStr) return "—";
  const [h, m] = timeStr.split(":").map(Number);
  const ampm = h >= 12 ? "PM" : "AM";
  const hh = h === 0 ? 12 : h > 12 ? h - 12 : h;
  return `${hh}:${String(m).padStart(2, "0")} ${ampm}`;
}

function fmtDate(dateStr) {
  if (!dateStr) return "TBD";
  const [y, m, d] = dateStr.split("-");
  return `${m}/${d}/${y}`;
}

function fmtDateLong(dateStr) {
  if (!dateStr) return "TBD";
  const [y, m, d] = dateStr.split("-").map(Number);
  const date = new Date(y, m - 1, d);
  return date.toLocaleDateString(undefined, { weekday: "long", month: "long", day: "numeric", year: "numeric" });
}

// "in 2 hours" / "23 minutes ago" style
function relativeTime(dateOrTimestamp) {
  const target = dateOrTimestamp instanceof Date ? dateOrTimestamp.getTime() : dateOrTimestamp;
  const diff = target - Date.now();
  const absMin = Math.round(Math.abs(diff) / 60000);
  if (absMin < 1) return diff > 0 ? "in less than a minute" : "just now";
  if (absMin < 60) return diff > 0 ? `in ${absMin} min` : `${absMin} min ago`;
  const absHr = Math.round(absMin / 60);
  if (absHr < 24) return diff > 0 ? `in ${absHr} hr` : `${absHr} hr ago`;
  const absDay = Math.round(absHr / 24);
  return diff > 0 ? `in ${absDay} day${absDay === 1 ? "" : "s"}` : `${absDay} day${absDay === 1 ? "" : "s"} ago`;
}

// ===================================================================
// AUTH UI
// ===================================================================
authApi.onChange(user => {
  state.user = user;

  if (user) {
    const label = ROLE_LABELS[user.role] || "User";
    $("auth-status").innerHTML =
      `<strong>${escapeHtml(user.email)}</strong> <span class="role-pill role-${user.role}">${label}</span>`;
    $("auth-signin").style.display = "none";
    $("auth-signout").style.display = "";
  } else {
    $("auth-status").innerHTML = "Not signed in";
    $("auth-signin").style.display = "";
    $("auth-signout").style.display = "none";
  }

  document.body.classList.toggle("is-signed-in", !!user);
  document.body.classList.toggle("is-exec",      !!(user && user.isExec));
  document.body.classList.toggle("is-approver",  !!(user && user.isApprover));
  document.body.classList.toggle("is-sgt",       !!(user && user.isSgt));
  document.body.classList.toggle("is-treasurer", !!(user && user.isTreasurer));
  document.body.classList.toggle("is-vice-chair",!!(user && user.isViceChair));
  document.body.classList.toggle("is-brother",   !!(user && user.rosterEntry));
  document.body.classList.toggle("is-guest",     !!(user && !user.rosterEntry && !user.isExec));

  renderAll();
});

$("auth-signin").addEventListener("click", async () => {
  try { await authApi.signIn(); toast("Signed in"); }
  catch (e) { console.error(e); toast("Sign-in failed", true); }
});
$("auth-signout").addEventListener("click", async () => {
  await authApi.signOut();
  toast("Signed out");
});

// ===================================================================
// SUBSCRIPTIONS
// ===================================================================
roster.subscribe(list => {
  state.roster = list;
  renderAll();
});
meetings.subscribe(list => {
  state.meetings = list;
  renderQuarterSelectors();
  renderAll();
});
attendance.subscribe(list => {
  state.attendance = list;
  renderAll();
});
absenceRequests.subscribe(list => {
  state.absenceRequests = list;
  renderAll();
});
noShows.subscribe(list => {
  state.noShows = list;
  renderAll();
});
fines.subscribe(list => {
  state.fines = list;
  renderAll();
});
settings.subscribe(s => {
  state.settings = s;
  renderSettings();
});

// ===================================================================
// QUARTER SELECTOR
// ===================================================================
function renderQuarterSelectors() {
  const opts = quartersFromRecords(state.meetings, state.attendance, state.noShows, state.fines);
  const html = ['<option value="all">All quarters</option>'].concat(
    opts.map(q => `<option value="${q}">${formatQuarter(q)}</option>`)
  ).join("");
  document.querySelectorAll(".quarter-select").forEach(sel => {
    const v = sel.value || state.selectedQuarter;
    sel.innerHTML = html;
    sel.value = (opts.includes(v) || v === "all") ? v : state.selectedQuarter;
  });
}

document.querySelectorAll(".quarter-select").forEach(sel => {
  sel.addEventListener("change", e => {
    state.selectedQuarter = e.target.value;
    document.querySelectorAll(".quarter-select").forEach(other => {
      if (other !== e.target) other.value = e.target.value;
    });
    renderAll();
  });
});

// ===================================================================
// TABS
// ===================================================================
function activateTab(name) {
  document.querySelectorAll(".tab").forEach(t =>
    t.classList.toggle("active", t.dataset.tab === name)
  );
  document.querySelectorAll(".panel").forEach(p =>
    p.classList.toggle("active", p.id === "panel-" + name)
  );
}
document.querySelectorAll(".tab").forEach(t => {
  t.addEventListener("click", () => activateTab(t.dataset.tab));
});

// ===================================================================
// MASTER RENDER
// ===================================================================
function renderAll() {
  renderMyStanding();
  renderRollCallTab();
  renderMeetingsTab();
  renderAbsenceTab();
  renderReportsTab();
}

// ===================================================================
// MY STANDING
// ===================================================================
function renderMyStanding() {
  const card = $("standing-card");
  const guestCard = $("standing-guest");

  if (!state.user) {
    card.style.display = "none";
    guestCard.style.display = "";
    guestCard.innerHTML = `
      <div class="card-title">Sign in to view your standing</div>
      <div class="card-sub">Brothers and exec use the same Google sign-in</div>
      <p style="font-family: Georgia, serif; font-size: 14px; line-height: 1.6;">
        Click <strong>Sign In with Google</strong> at the top of the page.
        Use the Gmail address the chapter has on file for you.
      </p>`;
    return;
  }

  if (!state.user.rosterEntry && !state.user.isExec) {
    card.style.display = "none";
    guestCard.style.display = "";
    guestCard.innerHTML = `
      <div class="card-title">Signed in as guest</div>
      <div class="card-sub">${escapeHtml(state.user.email)}</div>
      <p style="font-family: Georgia, serif; font-size: 14px; line-height: 1.6;">
        You're signed in but your email isn't matched to anyone in the chapter roster.
        Ask any exec officer to update your roster entry's email to
        <code>${escapeHtml(state.user.email)}</code> in the
        <a href="https://uclapikes-hub.github.io/pike-attendance/" target="_blank" rel="noopener" style="color: var(--garnet); font-weight: bold;">event tracker's Roster tab</a>.
      </p>`;
    return;
  }

  guestCard.style.display = "none";
  card.style.display = "";

  const target = state.user.rosterEntry;
  const fullName = target ? `${target.firstName} ${target.lastName}` : state.user.email;
  const myAttendance  = target ? state.attendance.filter(a => a.brotherKey === target.key && inQuarter(a)) : [];
  const myAbsenceReqs = target ? state.absenceRequests.filter(r => r.brotherKey === target.key && inQuarter(r)) : [];
  const myNoShows     = target ? state.noShows.filter(n => n.brotherKey === target.key && inQuarter(n)) : [];
  const myFines       = target ? state.fines.filter(f => f.brotherKey === target.key && inQuarter(f) && f.status === "pending") : [];
  const fineTotal     = myFines.reduce((sum, f) => sum + (Number(f.amount) || 0), 0);

  const approved = myAbsenceReqs.filter(r => r.status === "approved").length;
  const pending  = myAbsenceReqs.filter(r => r.status === "pending").length;
  const remainingAbsences = Math.max(0, 3 - approved);
  const meetingsThisQuarter = state.meetings.filter(inQuarter).length;

  const standingClass = (myNoShows.length >= 3) ? "judicial"
                       : (myNoShows.length === 2) ? "danger"
                       : (myNoShows.length === 1) ? "warn" : "";
  const standingLabel = (myNoShows.length >= 3) ? "Judicial Review" :
                        (myNoShows.length === 2) ? "Fine + Sgt Notice" :
                        (myNoShows.length === 1) ? "Warning" : "Good Standing";

  card.className = `card ${standingClass}`;
  card.innerHTML = `
    <div style="display:flex; justify-content:space-between; align-items:flex-start; flex-wrap:wrap; gap:14px;">
      <div>
        <div class="card-title">Welcome, ${escapeHtml(fullName)}</div>
        <div class="card-sub">${escapeHtml(target?.status || ROLE_LABELS[state.user.role])} &middot; ${formatQuarter(state.selectedQuarter)}</div>
      </div>
    </div>

    <div class="standing-grid">
      <div class="standing-tile absences">
        <div class="num">${approved}/3</div>
        <div class="label">Free Absences Used</div>
        <div class="sub">${remainingAbsences} remaining</div>
      </div>
      <div class="standing-tile no-shows">
        <div class="num">${myNoShows.length}</div>
        <div class="label">No-Shows</div>
        <div class="sub">${myNoShows.length === 0 ? "Clean record" : standingLabel}</div>
      </div>
      <div class="standing-tile fines">
        <div class="num">$${fineTotal}</div>
        <div class="label">Outstanding Fines</div>
        <div class="sub">${myFines.length === 0 ? "None" : "Pay treasurer"}</div>
      </div>
      <div class="standing-tile standing">
        <div class="num" style="font-size: 22px; padding-top: 8px;">${standingLabel}</div>
        <div class="label">This Quarter</div>
        <div class="sub">${myAttendance.length} of ${meetingsThisQuarter} meetings attended</div>
      </div>
    </div>

    ${pending > 0 ? `
      <div class="role-notice" style="margin-top: 18px;">
        <strong>${pending} absence request${pending === 1 ? "" : "s"} pending review.</strong>
        Approvers (President / IVP / Secretary) will review before each meeting.
      </div>` : ""}
  `;
}

// ===================================================================
// ROLL CALL TAB  (Stage 2)
// ===================================================================
function renderRollCallTab() {
  const placeholder = $("roll-call-placeholder");
  if (!placeholder) return;

  // Find any meeting whose QR window is currently open
  const openNow = state.meetings.find(m => qrWindow(m).isOpen);
  // Find the next upcoming meeting (window not yet open)
  const upcoming = state.meetings
    .filter(m => qrWindow(m).isFuture)
    .sort((a, b) => qrWindow(a).start.getTime() - qrWindow(b).start.getTime())[0];

  // If a brother is signed-in and there's a meeting with an open window, that's the action surface
  if (openNow && state.user && state.user.rosterEntry) {
    const target = state.user.rosterEntry;
    const w = qrWindow(openNow);
    const alreadyMarked = state.attendance.some(a =>
      a.meetingId === openNow.id && a.brotherKey === target.key
    );
    const closesIn = relativeTime(w.closes);

    placeholder.innerHTML = `
      <div class="card warn" style="text-align: center;">
        <div class="card-sub" style="color: var(--crimson);">Roll Call Open</div>
        <div class="card-title" style="color: var(--crimson); font-size: 28px;">${escapeHtml(openNow.title)}</div>
        <div style="font-family: Georgia, serif; font-size: 14px; color: var(--slate); margin-top: 6px;">
          ${escapeHtml(fmtDateLong(openNow.date))} &middot; ${fmtTime(openNow.startTime)}${openNow.location ? " &middot; " + escapeHtml(openNow.location) : ""}
        </div>
        <div style="font-family: Arial, sans-serif; font-size: 11px; letter-spacing: 1.5px; text-transform: uppercase; color: var(--true-gold); margin-top: 14px; font-weight: bold;">
          Window closes ${closesIn}
        </div>

        ${alreadyMarked ? `
          <div style="margin-top: 24px; padding: 18px; background: var(--light-gold); border-left: 3px solid var(--garnet);">
            <div style="font-family: 'Cormorant Garamond', Georgia, serif; font-size: 22px; color: var(--garnet); font-weight: 600;">
              ✓ You're checked in
            </div>
            <div style="font-family: Georgia, serif; font-size: 13px; color: var(--slate); margin-top: 6px;">
              Marked present at ${new Date(state.attendance.find(a => a.meetingId === openNow.id && a.brotherKey === target.key)?.timestamp).toLocaleTimeString([], {hour: 'numeric', minute: '2-digit'})}
            </div>
          </div>
        ` : `
          <button class="btn" id="rc-mark-present" style="margin-top: 24px; font-size: 14px; padding: 16px 36px;">
            Mark Me Present
          </button>
          ${openNow.mandatory ? `<div style="margin-top: 14px; font-family: Georgia, serif; font-size: 12px; font-style: italic; color: var(--burgundy);">⚑ Mandatory meeting — bylaws require attendance</div>` : ""}
        `}
      </div>
    `;

    if (!alreadyMarked) {
      $("rc-mark-present").addEventListener("click", async () => {
        try {
          await attendance.markPresent({
            meetingId:  openNow.id,
            brotherKey: target.key,
            name:       `${target.firstName} ${target.lastName}`,
            email:      target.email,
            quarter:    openNow.quarter,
          });
          toast("Marked present — thanks, brother!");
        } catch (e) {
          console.error(e);
          toast("Could not mark present — check connection", true);
        }
      });
    }
    return;
  }

  // Brother signed in but no open window
  if (state.user && state.user.rosterEntry) {
    if (!state.meetings.length) {
      placeholder.innerHTML = `
        <div class="card">
          <div class="empty-coming-soon">
            <h3>No meetings scheduled yet</h3>
            <p style="margin-top: 12px;">Check back closer to the next chapter meeting.</p>
          </div>
        </div>`;
      return;
    }

    if (upcoming) {
      const w = qrWindow(upcoming);
      const opensIn = relativeTime(w.opens);
      placeholder.innerHTML = `
        <div class="card">
          <div class="card-sub">Next Meeting</div>
          <div class="card-title">${escapeHtml(upcoming.title)}</div>
          <div style="font-family: Georgia, serif; font-size: 14px; color: var(--slate); margin-top: 6px;">
            ${escapeHtml(fmtDateLong(upcoming.date))} &middot; ${fmtTime(upcoming.startTime)}${upcoming.location ? " &middot; " + escapeHtml(upcoming.location) : ""}
          </div>
          <div style="margin-top: 18px; padding: 14px; background: var(--light-gold); border-left: 3px solid var(--true-gold);">
            <div style="font-family: Arial, sans-serif; font-size: 11px; letter-spacing: 1.5px; text-transform: uppercase; color: var(--garnet); font-weight: bold;">
              Roll call opens ${opensIn}
            </div>
            <div style="font-family: Georgia, serif; font-size: 13px; font-style: italic; color: var(--slate); margin-top: 4px;">
              The "Mark Me Present" button will appear here automatically when the window opens (15 min before start).
            </div>
          </div>
          ${upcoming.mandatory ? `<div style="margin-top: 12px; font-family: Georgia, serif; font-size: 12px; font-style: italic; color: var(--burgundy);">⚑ Mandatory meeting</div>` : ""}
        </div>
      `;
      return;
    }

    // Brother but only past meetings
    placeholder.innerHTML = `
      <div class="card">
        <div class="empty-coming-soon">
          <h3>No upcoming meetings</h3>
          <p style="margin-top: 12px;">No chapter meetings scheduled at the moment.</p>
        </div>
      </div>`;
    return;
  }

  // Not signed in or guest
  placeholder.innerHTML = `
    <div class="card">
      <div class="empty-coming-soon">
        <h3>Sign in to take roll</h3>
        <p style="margin-top: 12px;">When a chapter meeting is open for roll call, the "Mark Me Present" button will appear here.</p>
      </div>
    </div>`;
}

// Re-render Roll Call every 30 seconds so the window flips when timing changes
function startRollCallTimer() {
  if (rollCallTimer) clearInterval(rollCallTimer);
  rollCallTimer = setInterval(() => {
    renderRollCallTab();
    renderMyStanding();
    renderMeetingsTab();
  }, 30000);
}

// ===================================================================
// MEETINGS TAB  (Stage 2 — exec creates, everyone views)
// ===================================================================
function countMandatoryThisQuarter(quarter) {
  return state.meetings.filter(m => m.mandatory && m.quarter === quarter).length;
}

function renderMeetingsTab() {
  const wrap = $("meetings-content");
  if (!wrap) return;

  const isExec = !!(state.user && state.user.isExec);

  // Split into upcoming vs past (relative to now)
  const upcoming = state.meetings.filter(m => !qrWindow(m).isPast).filter(inQuarter);
  const past     = state.meetings.filter(m => qrWindow(m).isPast).filter(inQuarter);

  const sortAsc  = (a, b) => qrWindow(a).start - qrWindow(b).start;
  const sortDesc = (a, b) => qrWindow(b).start - qrWindow(a).start;

  upcoming.sort(sortAsc);
  past.sort(sortDesc);

  const showPast = state.showPastMeetings;
  const visible = showPast ? past : upcoming;

  wrap.innerHTML = `
    ${isExec ? renderCreateMeetingForm() : ""}

    <div class="card">
      <div style="display: flex; justify-content: space-between; align-items: flex-start; flex-wrap: wrap; gap: 14px;">
        <div>
          <div class="card-title">${showPast ? "Past Meetings" : "Upcoming Meetings"}</div>
          <div class="card-sub">${formatQuarter(state.selectedQuarter)} &middot; ${visible.length} meeting${visible.length === 1 ? "" : "s"}</div>
        </div>
        <div style="display: flex; gap: 8px;">
          <button class="btn btn-ghost btn-small" id="meetings-toggle">
            ${showPast ? "Show Upcoming" : `Show Past (${past.length})`}
          </button>
        </div>
      </div>

      ${visible.length === 0
        ? `<div class="empty">${showPast ? "No past meetings in this quarter." : "No upcoming meetings — secretary creates them above."}</div>`
        : `<div class="event-list" style="display: flex; flex-direction: column; gap: 10px; margin-top: 14px;">
            ${visible.map(m => renderMeetingRow(m, isExec)).join("")}
          </div>`}
    </div>
  `;

  // Wire buttons
  $("meetings-toggle")?.addEventListener("click", () => {
    state.showPastMeetings = !state.showPastMeetings;
    renderMeetingsTab();
  });

  if (isExec) {
    $("mtg-create")?.addEventListener("click", handleCreateMeeting);
  }

  wrap.querySelectorAll("[data-qr]").forEach(b =>
    b.addEventListener("click", () => openQrModal(b.dataset.qr)));
  wrap.querySelectorAll("[data-del]").forEach(b =>
    b.addEventListener("click", () => deleteMeeting(b.dataset.del)));
  wrap.querySelectorAll("[data-roll]").forEach(b =>
    b.addEventListener("click", () => openRollSheet(b.dataset.roll)));
}

function renderCreateMeetingForm() {
  const todayQ = currentQuarter();
  const mandCount = countMandatoryThisQuarter(todayQ);
  const mandFull = mandCount >= 4;

  return `
    <div class="card exec-only">
      <div class="card-title">Create Meeting</div>
      <div class="card-sub">Secretary: schedule a chapter meeting</div>

      <div class="row-2">
        <div>
          <label for="mtg-title">Meeting Title</label>
          <input type="text" id="mtg-title" placeholder="Weekly Chapter Meeting">
        </div>
        <div>
          <label for="mtg-date">Date</label>
          <input type="date" id="mtg-date">
        </div>
      </div>

      <div class="row-3">
        <div>
          <label for="mtg-start">Start Time</label>
          <input type="time" id="mtg-start" value="19:00">
        </div>
        <div>
          <label for="mtg-end">End Time</label>
          <input type="time" id="mtg-end" value="20:00">
        </div>
        <div>
          <label for="mtg-window">QR Window <span style="font-weight: normal; color: var(--true-gold); text-transform: none; letter-spacing: 0;">(min after start)</span></label>
          <input type="number" id="mtg-window" value="5" min="1" max="60">
        </div>
      </div>

      <label for="mtg-location">Location</label>
      <input type="text" id="mtg-location" placeholder="Chapter house living room">

      <div style="display: flex; align-items: center; gap: 12px; margin-top: 18px; padding: 12px 14px; background: var(--light-gold); border-left: 3px solid ${mandFull ? "var(--knight-steel)" : "var(--burgundy)"};">
        <input type="checkbox" id="mtg-mandatory" style="width: auto; margin: 0;" ${mandFull ? "disabled" : ""}>
        <label for="mtg-mandatory" style="margin: 0; cursor: ${mandFull ? "not-allowed" : "pointer"}; ${mandFull ? "color: var(--knight-steel);" : ""}">
          Mandatory Meeting
        </label>
        <span style="font-family: Georgia, serif; font-size: 12px; font-style: italic; color: var(--true-gold);">
          ${mandFull
            ? `Bylaws limit mandatory meetings to 4 per quarter. ${formatQuarter(todayQ)} already has 4.`
            : `${4 - mandCount} mandatory slot${4 - mandCount === 1 ? "" : "s"} remaining this quarter (Article VI §12)`}
        </span>
      </div>

      <button class="btn" id="mtg-create">Create Meeting</button>
    </div>
  `;
}

async function handleCreateMeeting() {
  if (!state.user || !state.user.isExec) return toast("Sign in as exec", true);

  const title     = $("mtg-title").value.trim();
  const date      = $("mtg-date").value;
  const startTime = $("mtg-start").value;
  const endTime   = $("mtg-end").value;
  const location  = $("mtg-location").value.trim();
  const mandatory = $("mtg-mandatory").checked;
  const qrWin     = Math.max(1, Math.min(60, Number($("mtg-window").value) || 5));

  if (!title)     return toast("Meeting title is required", true);
  if (!date)      return toast("Date is required", true);
  if (!startTime) return toast("Start time is required", true);
  if (!endTime)   return toast("End time is required", true);

  // Validate that end is after start
  const startDt = combineLocalDateTime(date, startTime);
  const endDt   = combineLocalDateTime(date, endTime);
  if (endDt.getTime() <= startDt.getTime()) {
    return toast("End time must be after start time", true);
  }

  // Compute the meeting's quarter from its date
  const [yr, mo, dy] = date.split("-").map(Number);
  const meetingQuarter = (() => {
    const m = mo - 1;
    if (m <= 2)  return `${yr}-winter`;
    if (m <= 5)  return `${yr}-spring`;
    if (m <= 7)  return `${yr}-summer`;
    return `${yr}-fall`;
  })();

  // Bylaw cap re-check for the quarter the meeting falls in (not just current)
  if (mandatory) {
    const inQuarterMandCount = state.meetings.filter(m => m.mandatory && m.quarter === meetingQuarter).length;
    if (inQuarterMandCount >= 4) {
      return toast(`${formatQuarter(meetingQuarter)} already has 4 mandatory meetings (bylaws cap)`, true);
    }

    // 14-day notice warning per Article VI §12
    const daysOut = (startDt.getTime() - Date.now()) / (24 * 60 * 60 * 1000);
    if (daysOut < 14) {
      const ok = confirm(
        `Bylaws require 14 days advance notice for mandatory meetings (Article VI §12). ` +
        `This meeting is only ${Math.round(daysOut)} day${Math.round(daysOut) === 1 ? "" : "s"} out. ` +
        `Create anyway?`
      );
      if (!ok) return;
    }
  }

  try {
    await meetings.create({
      title, date, startTime, endTime, location,
      mandatory, qrWindowMinutes: qrWin,
    });
    $("mtg-title").value = "";
    $("mtg-location").value = "";
    $("mtg-mandatory").checked = false;
    toast("Meeting created");
  } catch (e) {
    console.error(e);
    toast("Permission denied — exec sign-in required", true);
  }
}

function renderMeetingRow(m, isExec) {
  const w = qrWindow(m);
  const attendees = state.attendance.filter(a => a.meetingId === m.id);
  const isOpen   = w.isOpen;
  const isPast   = w.isPast;
  const isFuture = w.isFuture;

  let timingBadge;
  if (isOpen) {
    timingBadge = `<span style="background: var(--crimson); color: white; padding: 2px 8px; font-family: Arial; font-size: 10px; font-weight: bold; letter-spacing: 1px;">QR OPEN — closes ${relativeTime(w.closes)}</span>`;
  } else if (isFuture) {
    timingBadge = `<span style="background: var(--khaki); color: var(--burgundy); padding: 2px 8px; font-family: Arial; font-size: 10px; font-weight: bold; letter-spacing: 1px;">${relativeTime(w.start).toUpperCase()}</span>`;
  } else {
    timingBadge = `<span style="background: var(--knight-steel); color: white; padding: 2px 8px; font-family: Arial; font-size: 10px; font-weight: bold; letter-spacing: 1px;">PAST</span>`;
  }

  return `
    <div class="event-row" style="display: flex; align-items: center; justify-content: space-between; padding: 14px 18px; background: white; border: 1px solid rgba(170,151,103,0.3); ${m.mandatory ? "border-left: 3px solid var(--burgundy);" : ""} gap: 12px; flex-wrap: wrap;">
      <div style="flex: 1; min-width: 220px;">
        <div style="font-family: 'Cormorant Garamond', Georgia, serif; font-size: 18px; font-weight: 600; color: var(--garnet);">
          ${escapeHtml(m.title)} ${m.mandatory ? `<span style="font-family: Arial; font-size: 9px; letter-spacing: 1.5px; color: var(--burgundy); margin-left: 6px;">⚑ MANDATORY</span>` : ""}
        </div>
        <div style="font-family: Arial, sans-serif; font-size: 11px; color: var(--slate); letter-spacing: 1px; margin-top: 4px;">
          ${escapeHtml(fmtDate(m.date))} &middot; ${fmtTime(m.startTime)}–${fmtTime(m.endTime)}${m.location ? " &middot; " + escapeHtml(m.location) : ""}
        </div>
        <div style="margin-top: 6px;">
          ${timingBadge}
        </div>
      </div>
      <div style="display: flex; gap: 8px; align-items: center; flex-wrap: wrap;">
        <span style="background: var(--garnet); color: white; padding: 6px 12px; font-family: Arial; font-size: 11px; font-weight: bold; letter-spacing: 1px;">
          ${attendees.length} present
        </span>
        <button class="btn btn-ghost btn-small" data-qr="${m.id}">QR</button>
        ${isExec ? `<button class="btn btn-ghost btn-small" data-roll="${m.id}">Roll</button>` : ""}
        ${isExec ? `<button class="btn btn-danger btn-small" data-del="${m.id}">Delete</button>` : ""}
      </div>
    </div>
  `;
}

async function deleteMeeting(id) {
  const m = state.meetings.find(x => x.id === id);
  if (!m) return;
  const cnt = state.attendance.filter(a => a.meetingId === id).length;
  const msg = cnt > 0
    ? `Delete "${m.title}" and its ${cnt} attendance record${cnt === 1 ? "" : "s"}? This cannot be undone.`
    : `Delete "${m.title}"?`;
  if (!confirm(msg)) return;
  try {
    await meetings.remove(id);
    toast("Meeting deleted");
  } catch (e) {
    console.error(e);
    toast("Permission denied", true);
  }
}

function openRollSheet(meetingId) {
  const m = state.meetings.find(x => x.id === meetingId);
  if (!m) return;
  const attendees = state.attendance.filter(a => a.meetingId === meetingId);
  const presentKeys = new Set(attendees.map(a => a.brotherKey));
  const eligible = state.roster.filter(b => b.status === "Active" || b.status === "New Member");

  const present = eligible.filter(b => presentKeys.has(b.key));
  const absent  = eligible.filter(b => !presentKeys.has(b.key));

  const sheet = $("roll-sheet-modal");
  $("roll-sheet-title").textContent = m.title;
  $("roll-sheet-meta").textContent =
    `${fmtDateLong(m.date)} • ${fmtTime(m.startTime)}–${fmtTime(m.endTime)} • ${present.length} present, ${absent.length} not yet`;

  $("roll-sheet-present").innerHTML = present.length
    ? present.map(b => `<div style="padding: 8px 14px; border-bottom: 1px solid var(--light-gold); font-family: Georgia, serif; font-size: 13px; display: flex; justify-content: space-between;">
        <span>${escapeHtml(b.firstName + " " + b.lastName)}</span>
        <span style="font-family: Arial; font-size: 9px; letter-spacing: 1px; text-transform: uppercase; color: var(--garnet); font-weight: bold;">PRESENT</span>
      </div>`).join("")
    : `<div style="padding: 12px; font-family: Georgia, serif; font-style: italic; color: var(--true-gold);">No one has marked themselves present yet.</div>`;

  $("roll-sheet-absent").innerHTML = absent.length
    ? absent.map(b => `<div style="padding: 8px 14px; border-bottom: 1px solid var(--light-gold); font-family: Georgia, serif; font-size: 13px; display: flex; justify-content: space-between;">
        <span>${escapeHtml(b.firstName + " " + b.lastName)}</span>
        <span style="font-family: Arial; font-size: 9px; letter-spacing: 1px; text-transform: uppercase; color: var(--memphis-brick);">${b.status === "New Member" ? "NM" : ""} ${qrWindow(m).isPast ? "ABSENT" : "—"}</span>
      </div>`).join("")
    : `<div style="padding: 12px; font-family: Georgia, serif; font-style: italic; color: var(--true-gold);">Everyone eligible has marked present.</div>`;

  sheet.classList.add("visible");
}

// ===================================================================
// QR CODE MODAL
// ===================================================================
function renderQr(meetingId) {
  $("qr-holder").innerHTML = "";
  const url = window.location.origin + window.location.pathname + "#meeting=" + meetingId;
  new QRCode($("qr-holder"), {
    text: url, width: 240, height: 240,
    colorDark: "#79242F", colorLight: "#ffffff",
    correctLevel: QRCode.CorrectLevel.M,
  });
  currentQrCanvas = $("qr-holder").querySelector("canvas") || $("qr-holder").querySelector("img");
}

function openQrModal(meetingId) {
  const m = state.meetings.find(x => x.id === meetingId);
  if (!m) return;
  currentQrMeeting = m;
  $("qr-meeting-title").textContent = m.title;
  $("qr-meeting-meta").textContent =
    `${fmtDateLong(m.date)} • ${fmtTime(m.startTime)} • ${m.location || ""}`;
  renderQr(meetingId);
  $("qr-modal").classList.add("visible");
}

$("qr-modal-close").addEventListener("click", () => $("qr-modal").classList.remove("visible"));
$("qr-modal").addEventListener("click", e => {
  if (e.target === $("qr-modal")) $("qr-modal").classList.remove("visible");
});
$("qr-download").addEventListener("click", () => {
  if (!currentQrCanvas || !currentQrMeeting) return;
  const a = document.createElement("a");
  a.href = currentQrCanvas.tagName === "CANVAS" ? currentQrCanvas.toDataURL("image/png") : currentQrCanvas.src;
  a.download = `pike-meeting-qr-${currentQrMeeting.title.replace(/[^a-z0-9]+/gi, "-").toLowerCase()}.png`;
  a.click();
  toast("QR downloaded");
});
$("qr-copy-url").addEventListener("click", async () => {
  if (!currentQrMeeting) return;
  const url = window.location.origin + window.location.pathname + "#meeting=" + currentQrMeeting.id;
  try { await navigator.clipboard.writeText(url); toast("URL copied"); }
  catch { toast("Copy failed", true); }
});

// Roll Sheet modal close
$("roll-sheet-close").addEventListener("click", () => $("roll-sheet-modal").classList.remove("visible"));
$("roll-sheet-modal").addEventListener("click", e => {
  if (e.target === $("roll-sheet-modal")) $("roll-sheet-modal").classList.remove("visible");
});

// ===================================================================
// URL HASH ROUTING (#meeting=ID auto-opens Roll Call after QR scan)
// ===================================================================
function readHash() {
  const m = window.location.hash.match(/meeting=([\w-]+)/);
  return m ? m[1] : null;
}
window.addEventListener("hashchange", () => {
  const id = readHash();
  if (id) {
    activateTab("rollcall");
    const meeting = state.meetings.find(x => x.id === id);
    if (meeting) {
      state.selectedQuarter = meeting.quarter;
      document.querySelectorAll(".quarter-select").forEach(s => s.value = meeting.quarter);
      renderAll();
    }
  }
});

// ===================================================================
// ABSENCE / REPORTS placeholders (Stages 3-5)
// ===================================================================
function renderAbsenceTab() {
  const wrap = $("absence-content");
  if (!wrap) return;
  wrap.innerHTML = `
    <div class="card">
      <div class="empty-coming-soon">
        <span class="stage-tag">Stage 3 — Coming Soon</span>
        <h3>Absence Requests</h3>
        <p style="margin-top: 12px; max-width: 480px; margin-left: auto; margin-right: auto; line-height: 1.6;">
          Submit absence requests at least 48 hours before a meeting. Reasons: academic, family, medical, work, or other. Proof required if you've already used your 3 free quarterly absences. Approvers (President, IVP, Secretary) review and decide.
        </p>
      </div>
    </div>`;
}

function renderReportsTab() {
  const wrap = $("reports-content");
  if (!wrap) return;
  wrap.innerHTML = `
    <div class="card">
      <div class="empty-coming-soon">
        <span class="stage-tag">Stage 5 — Coming Soon</span>
        <h3>Reports</h3>
        <p style="margin-top: 12px; max-width: 480px; margin-left: auto; margin-right: auto; line-height: 1.6;">
          Quarterly attendance reports, no-show ledger, fine ledger for treasurer, and the &lt;50% participation watchlist (Article VI §12) will be Excel exports here.
        </p>
      </div>
    </div>`;
}

// ===================================================================
// SETTINGS
// ===================================================================
function renderSettings() {
  $("setting-vc-email").value = state.settings.judicialViceChair || "";
  $("setting-sgt-email").value = state.settings.sgtAtArmsEmail || SGT_AT_ARMS_EMAIL;
  $("setting-treasurer-email").value = state.settings.treasurerEmail || TREASURER_EMAIL;
  $("setting-notes").value = state.settings.notes || "";
}

$("settings-save").addEventListener("click", async () => {
  if (!state.user || !state.user.isExec) {
    return toast("Only exec can change settings", true);
  }
  try {
    await settings.save({
      judicialViceChair: $("setting-vc-email").value.trim().toLowerCase(),
      sgtAtArmsEmail:    $("setting-sgt-email").value.trim().toLowerCase(),
      treasurerEmail:    $("setting-treasurer-email").value.trim().toLowerCase(),
      notes:             $("setting-notes").value.trim(),
    });
    toast("Settings saved");
  } catch (e) {
    console.error(e);
    toast("Save failed — exec sign-in required", true);
  }
});

// ===================================================================
// INIT
// ===================================================================
const preselectMeeting = readHash();
if (preselectMeeting) activateTab("rollcall");

renderQuarterSelectors();
renderAll();
startRollCallTimer();

// Default the date input on the create form to today (when user signs in as exec)
function defaultMeetingDate() {
  const dateInput = $("mtg-date");
  if (dateInput && !dateInput.value) dateInput.valueAsDate = new Date();
}
const observer = new MutationObserver(() => defaultMeetingDate());
observer.observe($("meetings-content"), { childList: true, subtree: true });
