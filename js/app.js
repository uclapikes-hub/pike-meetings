// ===================================================================
// PIKE Meeting Tracker — Main App  (Stage 1)
// ===================================================================
// Stage 1 ships the skeleton:
//   - Auth + role detection (exec / sgt / treasurer / vice_chair / brother / guest)
//   - Quarter selector
//   - Settings screen (Sgt-at-Arms + Vice Chair config)
//   - "My Standing" dashboard for brothers (zeros until Stage 4)
//   - Coming-soon states for Roll Call / Meetings / Absence Requests / Reports
//
// Stages 2-5 will fill in the feature tabs.
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
};

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
  exec: "Exec",
  sgt: "Sgt-at-Arms",
  treasurer: "Treasurer",
  vice_chair: "J-Board Vice Chair",
  brother: "Brother",
  guest: "Guest",
};

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

  // Body classes for role-gated UI
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
// MY STANDING (Roll Call tab)
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

  // Signed in but not in roster → guest
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
        <a href="https://uclapikes-hub.github.io/pike-attendance/" style="color: var(--garnet); font-weight: bold;">event tracker's Roster tab</a>.
      </p>`;
    return;
  }

  guestCard.style.display = "none";
  card.style.display = "";

  const target  = state.user.rosterEntry;
  const fullName = target ? `${target.firstName} ${target.lastName}` : state.user.email;
  const myAttendance     = target ? state.attendance.filter(a => a.brotherKey === target.key && inQuarter(a)) : [];
  const myAbsenceReqs    = target ? state.absenceRequests.filter(r => r.brotherKey === target.key && inQuarter(r)) : [];
  const myNoShows        = target ? state.noShows.filter(n => n.brotherKey === target.key && inQuarter(n)) : [];
  const myFines          = target ? state.fines.filter(f => f.brotherKey === target.key && inQuarter(f) && f.status === "pending") : [];
  const fineTotal        = myFines.reduce((sum, f) => sum + (Number(f.amount) || 0), 0);

  const approved = myAbsenceReqs.filter(r => r.status === "approved").length;
  const denied   = myAbsenceReqs.filter(r => r.status === "denied").length;
  const pending  = myAbsenceReqs.filter(r => r.status === "pending").length;
  const meetingsThisQuarter = state.meetings.filter(inQuarter).length;
  const usedAbsences = approved + denied; // Approved-with-proof don't count toward 3, but Stage 1 doesn't track that distinction yet
  const remainingAbsences = Math.max(0, 3 - approved); // Quick estimate; Stage 3 refines

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
        <div class="sub">${meetingsThisQuarter} meeting${meetingsThisQuarter === 1 ? "" : "s"} so far</div>
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
// COMING-SOON SCAFFOLDING (Stages 2–5)
// ===================================================================
function comingSoonHtml(stage, title, description) {
  return `
    <div class="card">
      <div class="empty-coming-soon">
        <span class="stage-tag">Stage ${stage} — Coming Soon</span>
        <h3>${title}</h3>
        <p style="margin-top: 12px; max-width: 480px; margin-left: auto; margin-right: auto; line-height: 1.6;">
          ${description}
        </p>
      </div>
    </div>`;
}

function renderRollCallTab() {
  // Roll call goes here in Stage 2. For now Stage 1 just shows "My Standing"
  // (the standing card is rendered separately above).
  const placeholder = $("roll-call-placeholder");
  if (placeholder) {
    placeholder.innerHTML = comingSoonHtml(
      2, "Roll Call",
      "When a chapter meeting is open for roll call, this is where you'll scan the QR code or tap to mark yourself present. The window opens 15 minutes before start time and closes 5 minutes after."
    );
  }
}

function renderMeetingsTab() {
  const wrap = $("meetings-content");
  if (!wrap) return;
  wrap.innerHTML = comingSoonHtml(
    2, "Meetings",
    "Secretary: create chapter meetings here. Mark up to 4 mandatory per quarter (per Article VI Section 12 of the bylaws — 14 days notice required). Each meeting gets its own QR code for roll call."
  );
}

function renderAbsenceTab() {
  const wrap = $("absence-content");
  if (!wrap) return;
  wrap.innerHTML = comingSoonHtml(
    3, "Absence Requests",
    "Submit absence requests at least 48 hours before a meeting. Reasons: academic, family, medical, work, or other. Proof required if you've already used your 3 free quarterly absences. Approvers (President, IVP, Secretary) review and decide."
  );
}

function renderReportsTab() {
  const wrap = $("reports-content");
  if (!wrap) return;
  wrap.innerHTML = comingSoonHtml(
    5, "Reports",
    "Quarterly attendance reports, no-show ledger, fine ledger for treasurer, and the <50% participation watchlist (Article VI Section 12) will all be available here as Excel exports."
  );
}

// ===================================================================
// SETTINGS (Sgt-at-Arms email + Judicial Vice Chair email)
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
renderQuarterSelectors();
renderAll();
