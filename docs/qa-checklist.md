# PocketIT QA Checklist — v0.16 Milestones

Manual test plan covering M2.1–M4.1 implementations. Run after each build before deploying to managed devices.

---

## Environment Setup

- [ ] PocketIT client installed on a **standard user** Windows 10/11 test machine (non-admin)
- [ ] PocketIT Service running (Services → PocketIT Agent Service → Running)
- [ ] Server dashboard open in browser (https://your-server/dashboard)
- [ ] Test device enrolled and visible in Fleet tab
- [ ] Privacy mode **OFF** by default; toggle as needed per test

---

## M2.1 — Installer Deployment (Chunked Transfer)

### Test A: Small file deploy (< 256KB)
1. Go to Deploy tab → New Deployment → type = **Installer**
2. Select a small `.exe` or `.msi` file (under 256KB)
3. Choose target device, click Deploy
- **Pass**: No socket disconnect in browser console; device shows installer running; `installer_request` event visible in server logs
- **Fail**: Browser console shows socket reconnect during deploy

### Test B: Large file deploy (> 1MB)
1. Same flow with a file larger than 1MB
2. Watch browser console Network tab or server logs
- **Pass**: Multiple `installer_chunk` events in server logs; no socket disconnect; deployment completes on device
- **Fail**: Socket disconnects; deployment never completes

### Test C: Deploy without file (script-only)
1. New Deployment → type = **Script**, no installer file
- **Pass**: Deploy proceeds, only script executes
- **Fail**: "Select an installer file" alert blocks deploy

---

## M2.2 — Ctrl+Alt+Del (sas.dll Fallback)

### Test A: Ctrl+Alt+Del button during remote session
1. Start a remote desktop session to the test device
2. In the remote desktop toolbar, click the **Ctrl+Alt+Del** button
- **Pass**: Windows Security screen appears on the remote device (lock screen / task manager prompt)
- **Fail**: Nothing happens; error in client logs

### Test B: sas.dll unavailable (Windows 11 Home / standard user)
- Client log should show either:
  - `SendSAS called` (sas.dll available), OR
  - `sas.dll unavailable, falling back to raw VK_CONTROL+VK_MENU+VK_DELETE injection`
- **Pass**: Either message present; lock screen appears on device
- **Fail**: Exception logged with no fallback; nothing happens

---

## M3.1 — Windows 11 OS Detection

### Test A: Windows 11 device reports correctly
1. Open Fleet → click on a device enrolled from a Windows 11 machine
2. Check the OS field in device details
- **Pass**: Shows "Windows 11 Pro" (or Home/Enterprise), NOT "Windows 10 Pro"
- **Fail**: Shows "Windows 10" on a known Windows 11 device

### Test B: Windows 10 device still reports correctly
- **Pass**: Shows "Windows 10 Pro" on an actual Windows 10 device

### Test C: Build number format
- OS Build field shows format `22XXX.XXXX` (e.g., `22631.3880`) for Windows 11
- Build `19041`–`19045` range for Windows 10

---

## M3.2 — Privacy Screen Z-Order (HWND_TOPMOST Re-assertion)

### Test A: Privacy screen stays on top
1. Enable privacy mode on the test device
2. Start a remote session (as admin using Force Remote)
3. On the **device screen** (physically), open a fullscreen app (e.g., fullscreen video, game)
- **Pass**: Black "Remote support in progress" overlay stays on top of all apps; user cannot see desktop through it
- **Fail**: Fullscreen app appears on top of the privacy screen

### Test B: Privacy screen doesn't steal focus
1. During privacy mode with overlay active, click around on the test device
- **Pass**: The overlay doesn't grab keyboard focus; underlying apps remain responsive to keyboard
- **Fail**: Every click focuses the overlay window

---

## M3.4 — Elevated SYSTEM Terminal

### Test A: Elevated terminal button visible
1. Open Fleet → device detail → Terminal tab
- **Pass**: Two buttons visible: **Start Terminal** (grey) and **Elevated (SYSTEM)** (purple)
- **Fail**: Only one button visible

### Test B: Elevated terminal executes as SYSTEM
1. Click **Elevated (SYSTEM)** button
2. In terminal, run: `whoami`
- **Pass**: Returns `nt authority\system`
- **Fail**: Returns normal user account OR connection fails

### Test C: Elevated terminal can run admin commands
1. In elevated terminal, run: `net localgroup administrators`
- **Pass**: Returns list without UAC prompt or error
- **Fail**: "Access denied" or "requires elevation"

### Test D: Elevated terminal I/O works
1. Run `Get-Process | Sort-Object CPU -Descending | Select-Object -First 5`
- **Pass**: Process list returned; multi-line output formatted correctly
- **Fail**: Empty output or disconnect

### Test E: Elevated terminal stops cleanly
1. Click **Stop Terminal** during an active elevated session
- **Pass**: Session terminates; buttons return to both enabled
- **Fail**: Buttons stay disabled; pipe hangs

---

## M3.2 (cont) + M2.2 — Privacy Mode Remote with Consent

### Test A: Request Remote in privacy mode shows consent
1. Enable **privacy mode** on test device (toggle in chat → gear icon or settings)
2. From dashboard, click **Request Remote** (NOT Force Remote)
- **Pass**: Chat window opens on device; "IT Support is requesting remote screen access. Allow?" prompt appears; balloon tip notification shown
- **Fail**: Session silently denied with no prompt to user

### Test B: User approves consent → session starts
1. In the consent prompt (chat window on device), click **Allow**
- **Pass**: Remote session starts normally
- **Fail**: Nothing happens; no session

### Test C: User denies consent → session denied
1. In the consent prompt, click **Deny**
- **Pass**: Dashboard shows "request denied" notification; no session
- **Fail**: Session starts anyway

### Test D: Force Remote bypasses privacy mode (admin only)
1. With privacy mode ON, click **Force Remote** (purple button, admin dashboard only)
- **Pass**: Session starts immediately, NO consent prompt on device; audit log shows `desktop_force_started`
- **Fail**: Consent prompt appears anyway; OR session denied

---

## M4.1 — AI Guidance Markdown Rendering

### Test A: Bold and code render correctly
1. Open Fleet → device → IT Guidance tab
2. Send a message; receive an AI response containing markdown (e.g., `**bold text**` or `` `code` ``)
- **Pass**: Response renders with `<strong>bold text</strong>` styling; inline code has dark background
- **Fail**: Raw markdown symbols shown (e.g., `**bold text**`)

### Test B: Code blocks styled for dark theme
1. Trigger an AI response with a code block (e.g., ask about a PowerShell command)
- **Pass**: `<pre>` block has dark `#0f1923` background; text is readable
- **Fail**: Code block uses default white/unstyled background

### Test C: IT messages are NOT rendered as markdown
1. Send a message as IT tech that contains `**asterisks**`
- **Pass**: Message shows literal `**asterisks**` (IT messages use textContent, not innerHTML)
- **Fail**: Message renders as bold (XSS risk)

---

## Dashboard — Mobile Responsive

### Test A: 640px viewport (mobile)
1. Open dashboard in DevTools with viewport set to 640px wide
- **Pass**: Navigation items wrap or stack; no horizontal scroll bar; all tabs still accessible
- **Fail**: Content overflows viewport; horizontal scroll required

### Test B: 768px viewport (tablet)
- **Pass**: Layout adjusts; device cards stack vertically; stats grid readable
- **Fail**: Layout broken; content clips

### Test C: Key controls still usable on mobile
1. At 640px, open a device detail panel
- **Pass**: Device detail scrollable; action buttons reachable; terminal tab visible
- **Fail**: Buttons cut off; cannot scroll to them

---

## Regression Checks (every release)

- [ ] Device enrollment still works (fresh install, secret generation)
- [ ] Chat messages send/receive correctly
- [ ] Script deployment (no file) runs on device
- [ ] Regular non-elevated terminal works
- [ ] Health score updates on diagnostics run
- [ ] Scheduled backup runs (verify Google Drive upload)
- [ ] Server restarts cleanly without RS session kill (check `pm2 logs` or service logs)

---

## Known Limitations / Not Tested Here

- Elevated terminal: output from GUI apps (WinForms/WPF) not supported (PowerShell console only)
- Privacy screen: tested on single monitor; multi-monitor needs separate validation
- sas.dll fallback: VK_CONTROL+VK_MENU+VK_DELETE injection may not work in all RDP contexts (works on local sessions)
