# Deployment Walkthrough

Stage 1 of the meeting tracker is ready to deploy. This document walks you through the three things you need to do, in order.

**Estimated time:** 15 minutes total.

---

## Step 1: Update Firestore rules (~3 min)

The new rules file covers BOTH apps (event tracker + meeting tracker). Pasting this in does NOT break the event tracker — all existing rules are preserved.

1. Open https://console.firebase.google.com → pick `pike-attendance` project
2. Left sidebar → **Firestore Database**
3. Top tab → **Rules**
4. Select all the existing text and delete it
5. Open `firestore.rules` from this folder, copy the entire contents
6. Paste into the Firebase rules editor
7. Click the blue **Publish** button at the top right
8. Wait for "Rules updated" confirmation

**What changed:**
- Added new collections: `meetings`, `meeting_attendance`, `absence_requests`, `no_shows`, `fines`, `settings`
- Added new role helper functions: `isApprover()`, `isSgtAtArms()`, `isTreasurer()`
- Existing event tracker rules are untouched

---

## Step 2: Create the GitHub repo (~5 min)

The meeting tracker is a separate repo from the event tracker.

1. Go to https://github.com/new
2. **Owner:** `uclapikes-hub` (or your account that owns the event tracker)
3. **Repository name:** `pike-meetings`
4. **Visibility:** Public (required for free GitHub Pages)
5. Leave all checkboxes UNCHECKED (no README, no .gitignore, no license)
6. Click **Create repository**

7. On the empty repo page, click the **"uploading an existing file"** link
8. In Finder, open this `pike-meetings` folder
9. Select all contents (`Cmd+A`)
10. **Drag everything** into the GitHub upload zone

   Critical: confirm the upload preserves folder structure. Before committing, look at the file list GitHub shows. You should see entries like:
   - `js/app.js`
   - `js/data.js`
   - `js/quarters.js`
   - `js/firebase-config.js`
   - `assets/styles.css`
   - `assets/pike-wordmark.png` (and 3 other images)
   - `index.html`
   - `firestore.rules`
   - `README.md`
   - `DEPLOY.md`

   If you see `app.js` at the root instead of `js/app.js`, the folder structure got flattened — same problem you hit on the event tracker. Delete and re-upload.

11. Scroll down → **Commit changes** (default message is fine)

---

## Step 3: Turn on GitHub Pages (~3 min)

1. Inside the new repo, click **Settings** (top tab)
2. Left sidebar → **Pages**
3. **Source:** Deploy from a branch
4. **Branch:** main, **Folder:** / (root) → **Save**
5. Wait ~60 seconds. The page refreshes and shows:

   > Your site is live at `https://uclapikes-hub.github.io/pike-meetings/`

6. **Add the new domain to Firebase Auth's authorized domains:**
   - Firebase console → **Authentication** → **Settings** tab → **Authorized domains**
   - Click **Add domain**
   - Type exactly: `uclapikes-hub.github.io`
     - **Note:** This is the same domain as the event tracker — you already added it. No action needed if so. But if Firebase complains it's missing, add it again.

---

## Step 4: Test it (~2 min)

1. Open https://uclapikes-hub.github.io/pike-meetings/
2. You should see the PIKE wordmark, "Chapter Meetings" subtitle, "UCLA · Beta Eta Chapter" tag
3. Click **Sign In with Google** — sign in with `uclapikes@gmail.com`
4. Confirm you see your email at the top with a red **EXEC** pill next to it
5. Click each tab — Roll Call, Meetings, Absence Requests, Reports, Settings
6. The first 4 will show "Coming Soon" with stage labels — that's expected for Stage 1
7. **Settings tab** is fully functional. Confirm:
   - You can see input fields for Sgt-at-Arms, Vice Chair, Treasurer emails
   - The Sgt-at-Arms field is pre-filled with `nikkranjith21@gmail.com`
   - The Treasurer field is pre-filled with `david.mescobedo20@gmail.com`
   - The Vice Chair field is empty (waiting for the j-board to be appointed)
   - You can edit these and **Save Settings**
8. Sign out, sign back in as a brother (any Gmail in the roster) — you should see "BROTHER" pill, the standing card showing 0/3 absences, 0 no-shows, $0 fines
9. Sign in with a Gmail NOT in the roster — should see "Signed in as guest" with instructions to ask exec to update their roster entry

If all 9 work, Stage 1 is fully live.

---

## Common issues

### Sign-in popup doesn't appear
- Browser blocking popups → click the popup-blocked icon in the address bar, allow popups for github.io
- Firebase domain not authorized → see Step 3.6

### "Permission denied" when saving settings
- You're not signed in as exec, OR
- The rules from Step 1 didn't publish — go back to Firebase Rules tab and confirm

### Brother sees "Signed in as guest" but they're in the roster
- The Gmail they're signing in with doesn't match what's in the roster's `email` field
- Have them tell you which Gmail they actually use → exec updates the roster entry in the **event tracker** (it manages the shared roster)

### "Loading roster…" never finishes
- Browser console → check for Firebase errors
- Most likely cause: Firebase config in `js/firebase-config.js` doesn't match the project. The values should match the event tracker's `firebase-config.js` exactly.

---

## What to do after Stage 1 is live

1. Sign in as exec, hit the Settings tab, confirm the three email fields look right
2. Send the URL to exec. Have each one sign in once to make sure their email is on the allowlist
3. Tell brothers nothing yet — there's no functional roll call until Stage 2

When you're ready for Stage 2 (Meetings + Roll Call), come back with:
- Any feedback from exec testing Stage 1
- Whether the live event tracker has been used for a real event yet (good UX feedback feeds Stage 2 design)
- Confirmation that Settings tab successfully saved values

Stage 2 will be a fresh conversation. Paste me a quick "Stage 1 deployed and tested. Build Stage 2." and I'll resume from STATUS.md.
