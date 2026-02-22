        // Dashboard JS
        // Apply cached theme immediately to prevent flash
        try {
            const cachedPrefs = JSON.parse(sessionStorage.getItem('pocket_it_prefs') || '{}');
            if (cachedPrefs.theme) document.documentElement.dataset.theme = cachedPrefs.theme;
        } catch(e) {}

        // Clipboard fallback for non-secure contexts (HTTP on non-localhost)
        function copyToClipboard(text) {
            if (navigator.clipboard && navigator.clipboard.writeText) {
                return navigator.clipboard.writeText(text);
            }
            const ta = document.createElement('textarea');
            ta.value = text;
            ta.style.position = 'fixed';
            ta.style.opacity = '0';
            document.body.appendChild(ta);
            ta.select();
            document.execCommand('copy');
            document.body.removeChild(ta);
            return Promise.resolve();
        }

        const API = '';
        let socket = null;
        let currentDeviceId = null;
        let currentTicketId = null;
        let authToken = sessionStorage.getItem('pocket_it_token') || '';
        let tempToken = null;
        let term = null;
        let fitAddon = null;
        let terminalDeviceId = null;
        let terminalLineBuffer = '';
        let desktopDeviceId = null;
        let desktopActive = false;
        let desktopCanvas = null;
        let desktopCtx = null;
        let desktopImg = new Image();
        let currentClients = [];
        let selectedClientId = null; // null = "All Clients"
        let currentUserRole = null;
        let currentUser = null;
        let userPreferences = {};

        function escapeHtml(str) {
            const div = document.createElement('div');
            div.textContent = str;
            return div.innerHTML;
        }

        // ---- Auth ----
        async function fetchWithAuth(url, options = {}) {
            if (authToken) {
                options.headers = { ...options.headers, 'Authorization': 'Bearer ' + authToken };
            }
            const res = await fetch(url, options);
            if (res.status === 401 && authToken) {
                sessionStorage.removeItem('pocket_it_token');
                authToken = '';
                showLogin();
            }
            return res;
        }

        function showLogin() {
            resetLoginOverlay();
            document.getElementById('login-overlay').style.display = 'flex';
        }

        function hideLogin() {
            document.getElementById('login-overlay').style.display = 'none';
        }

        async function doLogin() {
            const username = document.getElementById('login-username').value;
            const password = document.getElementById('login-password').value;
            const errorEl = document.getElementById('login-error');
            errorEl.style.display = 'none';

            try {
                const res = await fetch(`${API}/api/admin/login`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ username, password })
                });
                const data = await res.json();

                if (!res.ok) {
                    errorEl.textContent = data.error || 'Login failed';
                    errorEl.style.display = 'block';
                    return;
                }

                if (data.requires2FA) {
                    // User has 2FA — show TOTP input
                    tempToken = data.tempToken;
                    document.getElementById('login-step-password').style.display = 'none';
                    document.getElementById('login-step-totp').style.display = '';
                    document.getElementById('login-subtitle').textContent = 'Two-Factor Authentication';
                    document.getElementById('login-totp-code').value = '';
                    document.getElementById('login-totp-code').focus();
                    return;
                }

                if (data.requiresSetup) {
                    // User needs to set up 2FA
                    tempToken = data.tempToken;
                    document.getElementById('login-step-password').style.display = 'none';
                    document.getElementById('login-subtitle').textContent = 'Set Up Two-Factor Authentication';
                    await start2FASetup();
                    return;
                }

                // Direct token (shouldn't happen with mandatory 2FA, but handle gracefully)
                if (data.token) {
                    completeLogin(data);
                }
            } catch (err) {
                errorEl.textContent = 'Connection error';
                errorEl.style.display = 'block';
            }
        }

        async function completeLogin(data) {
            authToken = data.token;
            sessionStorage.setItem('pocket_it_token', authToken);
            tempToken = null;
            setupClientData(data);
            hideLogin();
            initSocket();
            await loadUserPreferences();
            const hash = location.hash.slice(1);
            if (!hash || (!hash.startsWith('device/') && !['fleet','tickets','alerts','reports','updates','deploy','wishlist','settings','account','clients','users','scripts'].includes(hash))) {
                showPage(userPreferences.defaultPage || 'fleet');
                history.replaceState({ page: userPreferences.defaultPage || 'fleet' }, '', '#' + (userPreferences.defaultPage || 'fleet'));
            } else if (!restoreFromHash()) {
                showPage(userPreferences.defaultPage || 'fleet');
                history.replaceState({ page: userPreferences.defaultPage || 'fleet' }, '', '#' + (userPreferences.defaultPage || 'fleet'));
            }
        }

        async function verify2FA() {
            const code = document.getElementById('login-totp-code').value.trim();
            const errorEl = document.getElementById('login-error');
            errorEl.style.display = 'none';

            if (!code) {
                errorEl.textContent = 'Enter your verification code';
                errorEl.style.display = 'block';
                return;
            }

            try {
                const res = await fetch(`${API}/api/admin/verify-2fa`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ tempToken, code })
                });
                const data = await res.json();

                if (res.ok && data.token) {
                    completeLogin(data);
                } else {
                    errorEl.textContent = data.error || 'Verification failed';
                    errorEl.style.display = 'block';
                    document.getElementById('login-totp-code').value = '';
                    document.getElementById('login-totp-code').focus();
                }
            } catch (err) {
                errorEl.textContent = 'Connection error';
                errorEl.style.display = 'block';
            }
        }

        async function start2FASetup() {
            const errorEl = document.getElementById('login-error');
            errorEl.style.display = 'none';

            try {
                const res = await fetch(`${API}/api/admin/2fa/setup`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ tempToken })
                });
                const data = await res.json();

                if (!res.ok) {
                    errorEl.textContent = data.error || 'Setup failed';
                    errorEl.style.display = 'block';
                    return;
                }

                document.getElementById('setup-qr-image').src = data.qrDataUri;
                document.getElementById('setup-manual-key').textContent = data.manualKey;
                document.getElementById('login-step-setup').style.display = '';
                document.getElementById('setup-totp-code').value = '';
                document.getElementById('setup-totp-code').focus();
            } catch (err) {
                errorEl.textContent = 'Connection error';
                errorEl.style.display = 'block';
            }
        }

        async function confirm2FASetup() {
            const code = document.getElementById('setup-totp-code').value.trim();
            const errorEl = document.getElementById('login-error');
            errorEl.style.display = 'none';

            if (!code) {
                errorEl.textContent = 'Enter the code from your authenticator';
                errorEl.style.display = 'block';
                return;
            }

            try {
                const res = await fetch(`${API}/api/admin/2fa/confirm`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ tempToken, code })
                });
                const data = await res.json();

                if (!res.ok) {
                    errorEl.textContent = data.error || 'Verification failed';
                    errorEl.style.display = 'block';
                    document.getElementById('setup-totp-code').value = '';
                    document.getElementById('setup-totp-code').focus();
                    return;
                }

                // Show backup codes before completing login
                showBackupCodes(data.backupCodes, data);
            } catch (err) {
                errorEl.textContent = 'Connection error';
                errorEl.style.display = 'block';
            }
        }

        function showBackupCodes(codes, loginData) {
            document.getElementById('login-step-setup').style.display = 'none';
            document.getElementById('login-step-totp').style.display = 'none';
            document.getElementById('login-subtitle').textContent = 'Backup Recovery Codes';
            document.getElementById('login-error').style.display = 'none';

            const grid = document.getElementById('backup-codes-grid');
            grid.innerHTML = codes.map(c =>
                `<code style="background:#0f1923; color:#66c0f4; padding:6px 10px; border-radius:4px; font-size:14px; font-family:monospace;">${c}</code>`
            ).join('');

            document.getElementById('login-step-backup').style.display = '';

            // Store login data for after user acknowledges
            document.getElementById('btn-copy-backup').onclick = () => {
                copyToClipboard(codes.join('\n')).then(() => {
                    document.getElementById('btn-copy-backup').textContent = 'Copied!';
                    setTimeout(() => { document.getElementById('btn-copy-backup').textContent = 'Copy All Codes'; }, 2000);
                });
            };

            document.getElementById('btn-backup-done').onclick = () => {
                completeLogin(loginData);
            };
        }

        function resetLoginOverlay() {
            document.getElementById('login-step-password').style.display = '';
            document.getElementById('login-step-totp').style.display = 'none';
            document.getElementById('login-step-setup').style.display = 'none';
            document.getElementById('login-step-backup').style.display = 'none';
            document.getElementById('login-subtitle').textContent = 'IT Dashboard Login';
            document.getElementById('login-error').style.display = 'none';
            document.getElementById('login-username').value = '';
            document.getElementById('login-password').value = '';
            tempToken = null;
        }

        document.getElementById('login-password').addEventListener('keydown', (e) => {
            if (e.key === 'Enter') doLogin();
        });
        document.getElementById('btn-verify-totp').addEventListener('click', verify2FA);
        document.getElementById('login-totp-code').addEventListener('keydown', (e) => {
            if (e.key === 'Enter') verify2FA();
        });
        document.getElementById('btn-confirm-setup').addEventListener('click', confirm2FASetup);
        document.getElementById('setup-totp-code').addEventListener('keydown', (e) => {
            if (e.key === 'Enter') confirm2FASetup();
        });
        document.getElementById('btn-back-to-login').addEventListener('click', resetLoginOverlay);

        // ---- Navigation ----
        // Show a page without pushing history (used by popstate)
        function showPage(page) {
            document.querySelectorAll('.nav-link').forEach(l => l.classList.remove('active'));
            document.querySelectorAll('.nav-dropdown-item').forEach(l => l.classList.remove('active'));
            document.querySelectorAll('.page').forEach(p => p.classList.remove('active'));
            const adminPages = ['updates', 'settings', 'wishlist', 'clients', 'users', 'scripts'];
            if (adminPages.includes(page)) {
                // Highlight the Admin toggle and the specific dropdown item
                const adminToggle = document.getElementById('nav-admin-toggle');
                if (adminToggle) adminToggle.classList.add('active');
                const dropItem = document.querySelector(`.nav-dropdown-item[data-page="${page}"]`);
                if (dropItem) dropItem.classList.add('active');
            } else if (page !== 'account') {
                const navLink = document.querySelector(`.nav-link[data-page="${page}"]`);
                if (navLink) navLink.classList.add('active');
            }
            // Avatar highlight for account page
            if (page === 'account') {
                const avatar = document.getElementById('nav-user-avatar');
                if (avatar) avatar.style.background = '#66c0f4';
            } else {
                const avatar = document.getElementById('nav-user-avatar');
                if (avatar) avatar.style.background = '';
            }
            document.getElementById('page-' + page).classList.add('active');
            // Superadmin-only pages
            if (adminPages.includes(page) && currentUserRole !== 'superadmin' && currentUserRole !== 'admin') {
                document.getElementById('page-' + page).innerHTML = '<div style="padding:40px; text-align:center; color:#8f98a0;"><h2>Access Denied</h2><p>This page is restricted to administrators.</p></div>';
            }
            if (page === 'fleet') loadFleet();
            if (page === 'tickets') loadTickets();
            if (page === 'alerts') loadAlerts();
            if (page === 'reports') loadReports();
            if (page === 'updates') loadUpdates();
            if (page === 'clients') loadClients();
            if (page === 'settings') loadSettings();
            if (page === 'wishlist') loadWishes();
            if (page === 'scripts') loadScripts();
            if (page === 'users') loadUsers();
            if (page === 'deploy') loadDeployPage();
            if (page === 'account') loadAccountPage();
        }

        function navigateTo(page) {
            const adminPages = ['updates', 'settings', 'wishlist', 'clients', 'users', 'scripts'];
            if (adminPages.includes(page) && currentUserRole !== 'superadmin' && currentUserRole !== 'admin') {
                return; // Block non-admin navigation
            }
            // 'account' is always accessible to any logged-in user
            showPage(page);
            history.pushState({ page }, '', '#' + page);
        }

        document.querySelectorAll('.nav-link').forEach(link => {
            if (link.id === 'nav-admin-toggle') return; // handled separately
            link.addEventListener('click', (e) => {
                e.preventDefault();
                navigateTo(link.dataset.page);
            });
        });

        const userAvatar = document.getElementById('nav-user-avatar');
        if (userAvatar) {
            userAvatar.addEventListener('click', (e) => {
                e.preventDefault();
                navigateTo('account');
            });
        }

        // Admin dropdown toggle
        const adminToggle = document.getElementById('nav-admin-toggle');
        const adminDropdown = document.getElementById('nav-admin-dropdown');
        const adminMenu = adminDropdown ? adminDropdown.querySelector('.nav-dropdown-menu') : null;

        if (adminToggle && adminMenu) {
            adminToggle.addEventListener('click', (e) => {
                e.preventDefault();
                e.stopPropagation();
                adminMenu.style.display = adminMenu.style.display === 'none' ? 'block' : 'none';
            });

            // Close dropdown when clicking outside
            document.addEventListener('click', () => {
                if (adminMenu) adminMenu.style.display = 'none';
            });

            // Dropdown item clicks
            adminMenu.querySelectorAll('.nav-dropdown-item').forEach(item => {
                item.addEventListener('click', (e) => {
                    e.preventDefault();
                    adminMenu.style.display = 'none';
                    navigateTo(item.dataset.page);
                });
            });
        }

        // ---- History navigation (back/forward) ----
        window.addEventListener('popstate', (e) => {
            const state = e.state;
            if (!state || !state.page) {
                showPage('fleet');
                return;
            }
            if (state.page === 'device' && state.deviceId) {
                openDevice(state.deviceId, true);
            } else {
                // Clean up device view if navigating away
                if (currentDeviceId) {
                    cleanupTerminal();
                    cleanupDesktop();
                    if (socket) socket.emit('unwatch_device', { deviceId: currentDeviceId });
                    currentDeviceId = null;
                }
                showPage(state.page);
            }
        });

        function restoreFromHash() {
            const hash = location.hash.slice(1); // remove '#'
            if (!hash) return false;
            if (hash.startsWith('device/')) {
                const deviceId = hash.slice(7);
                if (deviceId) {
                    openDevice(deviceId, true);
                    history.replaceState({ page: 'device', deviceId }, '', '#device/' + deviceId);
                    return true;
                }
            }
            const validPages = ['fleet', 'tickets', 'alerts', 'reports', 'updates', 'deploy', 'wishlist', 'settings', 'account', 'clients', 'users', 'scripts'];
            if (validPages.includes(hash)) {
                showPage(hash);
                history.replaceState({ page: hash }, '', '#' + hash);
                return true;
            }
            return false;
        }

        // ---- Socket.IO ----
        function initSocket() {
            if (socket) socket.disconnect();
            const opts = {};
            if (authToken) opts.auth = { token: authToken };
            socket = io('/it', opts);

            socket.on('connect', () => {
                document.getElementById('server-status').textContent = 'Connected';
                document.getElementById('server-status').style.background = '#1b5e20';
                loadFleet();
            });

            socket.on('disconnect', () => {
                document.getElementById('server-status').textContent = 'Disconnected';
                document.getElementById('server-status').style.background = '#4a1919';
            });

            socket.on('device_status_changed', () => loadFleet());

            socket.on('device_chat_update', (data) => {
                if (data.deviceId === currentDeviceId) {
                    appendChatMessage(data.message.sender, data.message.content);
                    if (data.response) {
                        appendChatMessage(data.response.sender, data.response.text);
                    }
                } else if (data.message && data.message.sender === 'user') {
                    // Increment unread count for non-active device
                    if (!window._unreadCounts) window._unreadCounts = {};
                    window._unreadCounts[data.deviceId] = (window._unreadCounts[data.deviceId] || 0) + 1;
                    // Update badge on device card
                    const card = document.querySelector(`.device-card[data-device-id="${data.deviceId}"]`);
                    if (card) {
                        let badge = card.querySelector('.unread-badge');
                        if (badge) {
                            badge.textContent = window._unreadCounts[data.deviceId];
                        } else {
                            const hostname = card.querySelector('.hostname');
                            if (hostname) {
                                badge = document.createElement('span');
                                badge.className = 'unread-badge';
                                badge.textContent = window._unreadCounts[data.deviceId];
                                hostname.insertAdjacentElement('afterend', badge);
                            }
                        }
                    }
                }
            });

            socket.on('device_watchers', (data) => {
                if (data.deviceId === currentDeviceId) {
                    renderDeviceWatchers(data.watchers);
                }
            });

            socket.on('device_watchers_changed', (data) => {
                if (data.deviceId === currentDeviceId) {
                    renderDeviceWatchers(data.watchers);
                }
            });

            socket.on('device_ai_changed', (data) => {
                if (data.deviceId === currentDeviceId) {
                    updateAIControlButtons(data.ai_disabled);
                }
            });

            socket.on('device_ai_reenabled', (data) => {
                showToast(`AI on "${data.hostname}" is re-enabled`);
                if (data.deviceId === currentDeviceId) {
                    updateAIControlButtons(null);
                }
            });

            socket.on('device_chat_history', (data) => {
                if (data.deviceId === currentDeviceId) {
                    const chatEl = document.getElementById('detail-chat');
                    chatEl.innerHTML = '';
                    data.messages.forEach(m => appendChatMessage(m.sender, m.content));
                }
            });

            socket.on('device_diagnostic_update', (data) => {
                if (data.deviceId === currentDeviceId) {
                    showDiagnosticResults(data);
                }
                if (data.healthScore !== undefined) {
                    loadFleet(); // Refresh stats to show updated health score
                }
            });

            // v0.19.0: Device notes socket events
            socket.on('device_notes', (data) => {
                if (data.deviceId === currentDeviceId) renderDeviceNotes(data.notes);
            });
            socket.on('device_note_added', (data) => {
                if (data.deviceId === currentDeviceId) prependDeviceNote(data.note);
            });
            socket.on('device_note_deleted', (data) => {
                if (data.deviceId === currentDeviceId) {
                    const el = document.getElementById('note-' + data.noteId);
                    if (el) el.remove();
                    updateNoteCount();
                }
            });

            // v0.19.0: Custom fields socket events
            socket.on('device_custom_fields', (data) => {
                if (data.deviceId === currentDeviceId) renderCustomFields(data.fields);
            });
            socket.on('custom_fields_updated', (data) => {
                if (data.deviceId === currentDeviceId) renderCustomFields(data.fields);
            });
            socket.on('custom_field_deleted', (data) => {
                if (data.deviceId === currentDeviceId) {
                    loadCustomFields(data.deviceId);
                }
            });

            socket.on('ticket_created', () => loadFleet());

            socket.on('new_alert', (data) => {
                loadAlerts();
            });

            socket.on('alert_stats_updated', (data) => {
                // Update badge
                const badge = document.getElementById('nav-alert-badge');
                if (data.activeCount > 0) {
                    badge.textContent = data.activeCount;
                    badge.style.display = 'inline';
                } else {
                    badge.style.display = 'none';
                }
                // Update stats if on alerts page
                document.getElementById('alert-stat-active').textContent = data.activeCount || 0;
                document.getElementById('alert-stat-critical').textContent = data.criticalCount || 0;
                document.getElementById('alert-stat-warning').textContent = data.warningCount || 0;
            });

            socket.on('file_browse_result', (data) => {
                if (data.deviceId === currentDeviceId) renderFileBrowser(data);
            });

            socket.on('file_read_result', (data) => {
                if (data.deviceId === currentDeviceId) renderFileContent(data);
            });

            socket.on('file_delete_result', (data) => {
                if (data.deviceId === currentDeviceId) handleFileDeleteResult(data);
            });

            socket.on('file_properties_result', (data) => {
                if (data.deviceId === currentDeviceId) handleFilePropertiesResult(data);
            });

            socket.on('file_paste_result', (data) => {
                if (data.deviceId === currentDeviceId) handleFilePasteResult(data);
            });

            socket.on('file_download_result', (data) => {
                if (data.deviceId === currentDeviceId) handleFileDownloadResult(data);
            });

            socket.on('file_upload_result', (data) => {
                if (data.deviceId === currentDeviceId) handleFileUploadResult(data);
            });

            // v0.14.0: Deployment events
            socket.on('deployment_created', (data) => {
                console.log('[Deploy] Created:', data.deploymentId);
                if (document.getElementById('page-deploy').classList.contains('active')) loadDeployHistory();
            });

            socket.on('deployment_progress', (data) => {
                console.log('[Deploy] Progress:', data);
                if (document.getElementById('page-deploy').classList.contains('active')) loadDeployHistory();
            });

            socket.on('deployment_completed', (data) => {
                console.log('[Deploy] Completed:', data.deploymentId);
                if (document.getElementById('page-deploy').classList.contains('active')) loadDeployHistory();
            });

            // v0.14.0: IT Guidance events
            socket.on('it_guidance_response', (data) => {
                if (data.deviceId === currentDeviceId) {
                    appendGuidanceMessage('ai', data.text);
                    document.getElementById('guidance-status').textContent = '';
                }
            });

            socket.on('it_guidance_history', (data) => {
                if (data.deviceId === currentDeviceId) {
                    const chatEl = document.getElementById('guidance-chat');
                    chatEl.innerHTML = '';
                    data.messages.forEach(m => appendGuidanceMessage(m.sender, m.content));
                }
            });

            socket.on('it_guidance_update', (data) => {
                if (data.deviceId === currentDeviceId) {
                    if (data.message) appendGuidanceMessage(data.message.sender, data.message.content);
                    if (data.response) appendGuidanceMessage(data.response.sender, data.response.text);
                }
            });

            socket.on('it_guidance_context_cleared', (data) => {
                if (data.deviceId === currentDeviceId) {
                    document.getElementById('guidance-chat').innerHTML = '<div style="color:#8f98a0; font-size:12px; text-align:center; padding:8px;">Context cleared.</div>';
                }
            });

            socket.on('installer_result', (data) => {
                if (data.deviceId === currentDeviceId) {
                    console.log('[Installer] Result:', data);
                }
            });

            socket.on('deploy_template_saved', () => { loadDeployTemplates(); });
            socket.on('deploy_template_deleted', () => { loadDeployTemplates(); });

            socket.on('script_result', (data) => {
                if (data.deviceId === currentDeviceId) renderScriptResult(data);
            });

            socket.on('auto_remediation_triggered', () => {
                loadAlerts();
            });

            socket.on('integrity_warning', (data) => {
                const msg = `INTEGRITY WARNING: Device ${data.hostname || data.deviceId} (v${data.clientVersion}) has mismatched EXE hash!`;
                console.warn(msg);
                // Show as a notification banner at top of page
                const banner = document.createElement('div');
                banner.style.cssText = 'position:fixed;top:0;left:0;right:0;padding:12px 20px;background:#5c2020;color:#ff6b6b;font-size:13px;z-index:10000;text-align:center;cursor:pointer;';
                banner.textContent = msg;
                banner.onclick = () => banner.remove();
                document.body.appendChild(banner);
                setTimeout(() => banner.remove(), 15000);
            });

            socket.on('terminal_started', (data) => {
                if (data.deviceId !== terminalDeviceId) return;
                document.getElementById('terminal-container').style.display = 'block';
                term = new Terminal({
                    cursorBlink: true,
                    theme: {
                        background: '#1e1e1e',
                        foreground: '#d4d4d4'
                    },
                    fontSize: 14,
                    fontFamily: 'Consolas, "Courier New", monospace'
                });
                fitAddon = new FitAddon.FitAddon();
                term.loadAddon(fitAddon);
                term.open(document.getElementById('terminal-container'));
                fitAddon.fit();
                // Line-buffered input with local echo (no PTY — PowerShell won't echo)
                terminalLineBuffer = '';
                term.onData(d => {
                    if (d === '\r') {
                        // Enter: send accumulated line, echo newline
                        term.write('\r\n');
                        socket.emit('terminal_input', { deviceId: terminalDeviceId, input: terminalLineBuffer });
                        terminalLineBuffer = '';
                    } else if (d === '\x7f' || d === '\b') {
                        // Backspace: remove last char, erase on screen
                        if (terminalLineBuffer.length > 0) {
                            terminalLineBuffer = terminalLineBuffer.slice(0, -1);
                            term.write('\b \b');
                        }
                    } else if (d === '\x03') {
                        // Ctrl+C: send break signal, clear buffer
                        term.write('^C\r\n');
                        terminalLineBuffer = '';
                        socket.emit('terminal_input', { deviceId: terminalDeviceId, input: '\x03' });
                    } else if (d >= ' ') {
                        // Printable char: echo locally and buffer
                        terminalLineBuffer += d;
                        term.write(d);
                    }
                    // Ignore other control sequences (arrows, etc.)
                });
                const statusEl = document.getElementById('terminal-status');
                statusEl.textContent = 'Connected';
                statusEl.className = 'connected';
                document.getElementById('btn-start-terminal').disabled = true;
                document.getElementById('btn-stop-terminal').disabled = false;
            });

            socket.on('terminal_output', (data) => {
                if (data.deviceId !== terminalDeviceId) return;
                if (term) term.write(data.output);
            });

            socket.on('terminal_stopped', (data) => {
                if (data.deviceId !== terminalDeviceId) return;
                if (term) {
                    term.write('\r\n\r\n[Session ended: ' + (data.reason || 'unknown') + ']\r\n');
                }
                setTimeout(() => cleanupTerminal(), 1000);
            });

            socket.on('terminal_denied', (data) => {
                if (data.deviceId !== terminalDeviceId) return;
                const statusEl = document.getElementById('terminal-status');
                statusEl.textContent = 'User denied terminal access';
                statusEl.className = 'error';
                setTimeout(() => {
                    statusEl.textContent = 'Not connected';
                    statusEl.className = '';
                }, 3000);
                document.getElementById('btn-start-terminal').disabled = false;
                document.getElementById('btn-stop-terminal').disabled = true;
                terminalDeviceId = null;
            });

            socket.on('desktop_started', (data) => {
                if (data.deviceId !== desktopDeviceId) return;
                desktopActive = true;
                desktopCanvas = document.getElementById('desktop-canvas');
                desktopCtx = desktopCanvas.getContext('2d');
                document.getElementById('desktop-viewer').style.display = 'block';
                document.getElementById('desktop-status').textContent = 'Connected';
                document.getElementById('desktop-status').style.color = '#66bb6a';
                document.getElementById('btn-start-desktop').disabled = true;
                document.getElementById('btn-stop-desktop').disabled = false;
            });

            socket.on('desktop_frame', (data) => {
                if (data.deviceId !== desktopDeviceId || !desktopActive) return;
                desktopImg.onload = function() {
                    if (!desktopCanvas) return;
                    // Set canvas internal resolution to match frame
                    if (desktopCanvas.width !== data.width || desktopCanvas.height !== data.height) {
                        desktopCanvas.width = data.width;
                        desktopCanvas.height = data.height;
                    }
                    desktopCtx.drawImage(desktopImg, 0, 0);
                };
                desktopImg.src = 'data:image/jpeg;base64,' + data.frame;
            });

            socket.on('desktop_stopped', (data) => {
                if (data.deviceId !== desktopDeviceId) return;
                cleanupDesktop();
                document.getElementById('desktop-status').textContent = 'Disconnected: ' + (data.reason || 'session ended');
            });

            socket.on('desktop_denied', (data) => {
                if (data.deviceId !== desktopDeviceId) return;
                cleanupDesktop();
                document.getElementById('desktop-status').textContent = 'Denied by device';
                document.getElementById('desktop-status').style.color = '#ef5350';
            });

            // v0.9.0: System tool results
            socket.on('system_tool_result', (data) => {
                if (data.deviceId !== currentDeviceId) return;
                switch (data.tool) {
                    case 'process_list': renderProcessList(data); break;
                    case 'process_kill':
                        if (data.success) loadProcesses();
                        else alert('Kill failed: ' + (data.error || 'Unknown error'));
                        break;
                    case 'service_list': renderServiceList(data); break;
                    case 'service_action':
                        if (data.success) loadServices();
                        else alert('Service action failed: ' + (data.error || 'Unknown error'));
                        break;
                    case 'event_log_query': renderEventLog(data); break;
                }
            });

            // Activity audit events: prepend new rows in real-time
            socket.on('audit_event', (data) => {
                if (!currentDeviceId || data.deviceId !== currentDeviceId) return;
                const tbody = document.getElementById('activity-tbody');
                if (!tbody) return;
                // Remove the "no activity" placeholder if present
                if (tbody.querySelector('td[colspan]')) tbody.innerHTML = '';
                const row = renderActivityRow(data);
                tbody.insertAdjacentHTML('afterbegin', row);
            });

            // Wishlist: real-time wish logged notification
            socket.on('feature_wish_logged', (data) => {
                // If wishlist page is visible, reload it
                if (document.getElementById('page-wishlist').classList.contains('active')) {
                    loadWishes();
                }
            });

            // Wishlist: response to get_feature_wishes
            socket.on('feature_wishes_list', (data) => {
                renderWishes(data.wishes || []);
            });

            // Wishlist: response to update_feature_wish
            socket.on('feature_wish_updated', (data) => {
                // Reload to reflect status change
                loadWishes();
            });
        }

        // ---- Wishlist ----
        const WISH_CAT_COLORS = {
            software: '#4fc3f7',
            network: '#81c784',
            security: '#ef5350',
            hardware: '#ffb74d',
            account: '#ce93d8',
            automation: '#90a4ae',
            other: '#8f98a0'
        };
        const WISH_STATUS_COLORS = {
            pending: '#ffb74d',
            approved: '#81c784',
            rejected: '#ef5350',
            implemented: '#4fc3f7'
        };

        function loadWishes() {
            if (!socket) return;
            const status = document.getElementById('wish-filter-status')?.value || null;
            const category = document.getElementById('wish-filter-category')?.value || null;
            const tbody = document.getElementById('wish-tbody');
            if (tbody) tbody.innerHTML = '<tr><td colspan="7" style="text-align:center; padding:24px; color:#8f98a0;">Loading...</td></tr>';
            socket.emit('get_feature_wishes', {
                status: status || null,
                category: category || null
            });
        }

        function renderWishes(wishes) {
            const tbody = document.getElementById('wish-tbody');
            if (!tbody) return;

            if (wishes.length === 0) {
                tbody.innerHTML = '<tr><td colspan="7" style="text-align:center; padding:32px; color:#8f98a0;">No wishes found.</td></tr>';
                updateWishStats([]);
                return;
            }

            tbody.innerHTML = wishes.map(w => {
                const catColor = WISH_CAT_COLORS[w.category] || '#8f98a0';
                const statusColor = WISH_STATUS_COLORS[w.status] || '#8f98a0';
                const votes = w.vote_count || 1;
                const voteClass = votes >= 5 ? 'high' : votes <= 1 ? 'low' : '';
                const needEscaped = escapeHtml(w.ai_need || '');
                const requestEscaped = escapeHtml(w.user_request || '');
                const deviceLabel = escapeHtml(w.hostname || (w.device_id ? w.device_id.substring(0, 8) + '...' : '—'));

                // Build action buttons based on current status
                let actions = '';
                if (w.status !== 'approved') actions += `<button class="wish-btn approve" data-action="wish-update" data-id="${w.id}" data-status="approved">Approve</button>`;
                if (w.status !== 'rejected') actions += `<button class="wish-btn reject" data-action="wish-update" data-id="${w.id}" data-status="rejected">Reject</button>`;
                if (w.status !== 'implemented') actions += `<button class="wish-btn implement" data-action="wish-update" data-id="${w.id}" data-status="implemented">Implemented</button>`;

                return `<tr>
                    <td><div class="wish-vote ${voteClass}">${votes}</div></td>
                    <td><span class="wish-cat-badge" style="background:${catColor}">${escapeHtml(w.category)}</span></td>
                    <td class="wish-need">${needEscaped}</td>
                    <td><div class="wish-request" title="${requestEscaped}">${requestEscaped || '<span style="color:#4a5560">—</span>'}</div></td>
                    <td style="font-size:12px; color:#8f98a0;">${deviceLabel}</td>
                    <td><span class="wish-status-badge" style="background:${statusColor}22; color:${statusColor}; border:1px solid ${statusColor}44;">${escapeHtml(w.status)}</span></td>
                    <td><div class="wish-actions">${actions}</div></td>
                </tr>`;
            }).join('');

            updateWishStats(wishes);
        }

        function updateWishStats(wishes) {
            document.getElementById('wish-stat-total').textContent = wishes.length;

            // Top category by count
            const catCounts = {};
            wishes.forEach(w => { catCounts[w.category] = (catCounts[w.category] || 0) + 1; });
            const topCat = Object.entries(catCounts).sort((a, b) => b[1] - a[1])[0];
            document.getElementById('wish-stat-top-cat').textContent = topCat ? topCat[0] : '—';

            // Most voted wish need
            const top = wishes.reduce((best, w) => (!best || w.vote_count > best.vote_count) ? w : best, null);
            const topEl = document.getElementById('wish-stat-top-votes');
            if (top) {
                topEl.textContent = top.vote_count + 'x';
                topEl.title = top.ai_need;
            } else {
                topEl.textContent = '—';
            }
        }

        function updateWish(id, status) {
            if (!socket) return;
            socket.emit('update_feature_wish', { id, status });
        }

        // ========== USERS MANAGEMENT ==========

        async function loadUsers() {
            try {
                const res = await fetchWithAuth(`${API}/api/admin/users`);
                const users = await res.json();
                const tbody = document.getElementById('users-table-body');
                if (!users.length) {
                    tbody.innerHTML = '<tr><td colspan="7" style="padding:20px; text-align:center; color:#8f98a0;">No users found</td></tr>';
                    return;
                }
                tbody.innerHTML = users.map(u => `
                    <tr style="border-bottom:1px solid #1b2838;">
                        <td style="padding:8px 12px; font-weight:600;">${escapeHtml(u.username)}</td>
                        <td style="padding:8px 12px;">
                            <input type="text" value="${escapeHtml(u.display_name || '')}"
                                data-action="user-update-name" data-id="${u.id}"
                                style="width:150px; background:#1b2838;">
                        </td>
                        <td style="padding:8px 12px;">
                            <select data-action="user-update-role" data-id="${u.id}" style="background:#1b2838;">
                                <option value="viewer" ${u.role === 'viewer' ? 'selected' : ''}>Viewer</option>
                                <option value="technician" ${u.role === 'technician' ? 'selected' : ''}>Technician</option>
                                <option value="admin" ${u.role === 'admin' ? 'selected' : ''}>Admin</option>
                                <option value="superadmin" ${u.role === 'superadmin' ? 'selected' : ''}>Superadmin</option>
                            </select>
                        </td>
                        <td style="padding:8px 12px; font-size:12px;">
                            ${u.totp_enabled
                                ? `<span style="color:#66bb6a;">Enabled</span> <span style="color:${u.backup_code_count === 0 ? '#ef5350' : '#8f98a0'}; font-size:11px;">(${u.backup_code_count} codes)</span>`
                                : '<span style="color:#8f98a0;">Not set up</span>'}
                        </td>
                        <td style="padding:8px 12px; color:#8f98a0; font-size:12px;">${u.last_login ? new Date(u.last_login).toLocaleString() : 'Never'}</td>
                        <td style="padding:8px 12px; color:#8f98a0; font-size:12px;">${u.created_at ? new Date(u.created_at).toLocaleString() : '-'}</td>
                        <td style="padding:8px 12px;">
                            ${u.totp_enabled ? `<button class="diag-btn" data-action="user-regen-codes" data-id="${u.id}" data-username="${escapeHtml(u.username)}" style="font-size:11px; padding:3px 8px; margin-right:4px;">Regen Codes</button><button class="diag-btn" data-action="user-reset-2fa" data-id="${u.id}" data-username="${escapeHtml(u.username)}" style="font-size:11px; padding:3px 8px; margin-right:4px;">Reset 2FA</button>` : ''}
                            <button class="diag-btn" data-action="user-reset-pw" data-id="${u.id}" data-username="${escapeHtml(u.username)}" style="font-size:11px; padding:3px 8px; margin-right:4px;">Reset PW</button>
                            <button class="diag-btn" data-action="user-delete" data-id="${u.id}" data-username="${escapeHtml(u.username)}" style="font-size:11px; padding:3px 8px; background:#ef5350; border-color:#ef5350;">Delete</button>
                        </td>
                    </tr>
                `).join('');
            } catch (err) {
                console.error('Failed to load users:', err);
            }
        }

        async function createUser() {
            const username = document.getElementById('user-new-username').value.trim();
            const display_name = document.getElementById('user-new-displayname').value.trim();
            const password = document.getElementById('user-new-password').value;
            const role = document.getElementById('user-new-role').value;
            const msgEl = document.getElementById('user-message');

            if (!username || !password) {
                msgEl.style.display = 'block';
                msgEl.style.background = '#ef535033';
                msgEl.style.color = '#ef5350';
                msgEl.textContent = 'Username and password are required';
                return;
            }

            try {
                const res = await fetchWithAuth(`${API}/api/admin/users`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ username, password, display_name: display_name || null, role })
                });
                const data = await res.json();
                if (!res.ok) {
                    msgEl.style.display = 'block';
                    msgEl.style.background = '#ef535033';
                    msgEl.style.color = '#ef5350';
                    msgEl.textContent = data.error || 'Failed to create user';
                    return;
                }
                msgEl.style.display = 'block';
                msgEl.style.background = '#66bb6a33';
                msgEl.style.color = '#66bb6a';
                msgEl.textContent = `User "${username}" created successfully`;
                document.getElementById('user-new-username').value = '';
                document.getElementById('user-new-displayname').value = '';
                document.getElementById('user-new-password').value = '';
                document.getElementById('user-new-role').value = 'technician';
                setTimeout(() => { msgEl.style.display = 'none'; }, 3000);
                loadUsers();
            } catch (err) {
                msgEl.style.display = 'block';
                msgEl.style.background = '#ef535033';
                msgEl.style.color = '#ef5350';
                msgEl.textContent = 'Network error: ' + err.message;
            }
        }

        async function updateUser(userId, field, value) {
            try {
                const res = await fetchWithAuth(`${API}/api/admin/users/${userId}`, {
                    method: 'PUT',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ [field]: value })
                });
                if (!res.ok) {
                    const data = await res.json();
                    alert(data.error || 'Failed to update user');
                    loadUsers();
                }
            } catch (err) {
                alert('Network error: ' + err.message);
            }
        }

        async function resetUserPassword(userId, username) {
            const newPassword = prompt(`Enter new password for "${username}":`);
            if (!newPassword) return;
            try {
                const res = await fetchWithAuth(`${API}/api/admin/users/${userId}`, {
                    method: 'PUT',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ password: newPassword })
                });
                if (res.ok) {
                    alert(`Password for "${username}" has been reset.`);
                } else {
                    const data = await res.json();
                    alert(data.error || 'Failed to reset password');
                }
            } catch (err) {
                alert('Network error: ' + err.message);
            }
        }

        async function deleteUser(userId, username) {
            if (!confirm(`Delete user "${username}"? This cannot be undone.`)) return;
            try {
                const res = await fetchWithAuth(`${API}/api/admin/users/${userId}`, {
                    method: 'DELETE'
                });
                if (res.ok) {
                    loadUsers();
                } else {
                    const data = await res.json();
                    alert(data.error || 'Failed to delete user');
                }
            } catch (err) {
                alert('Network error: ' + err.message);
            }
        }

        async function reset2FA(userId, username) {
            if (!confirm(`Reset 2FA for "${username}"? They will need to set up 2FA again on next login.`)) return;
            try {
                const res = await fetchWithAuth(`${API}/api/admin/2fa/disable`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ userId: parseInt(userId) })
                });
                if (res.ok) {
                    alert(`2FA has been reset for "${username}".`);
                    loadUsers();
                } else {
                    const data = await res.json();
                    alert(data.error || 'Failed to reset 2FA');
                }
            } catch (err) {
                alert('Network error: ' + err.message);
            }
        }

        // ========== MY ACCOUNT ==========

        async function loadAccountPage() {
            try {
                const res = await fetchWithAuth(`${API}/api/admin/user/profile`);
                const profile = await res.json();

                document.getElementById('account-username').textContent = profile.username;
                document.getElementById('account-display-name').value = profile.display_name || '';
                document.getElementById('account-role').textContent = profile.role;
                document.getElementById('account-last-login').textContent = profile.last_login
                    ? new Date(profile.last_login).toLocaleString() : 'Never';

                // 2FA status
                const statusEl = document.getElementById('account-2fa-status');
                if (profile.totp_enabled) {
                    statusEl.innerHTML = '<span style="color:var(--success);">Enabled</span>';
                } else {
                    statusEl.innerHTML = '<span style="color:var(--warning);">Not set up</span>';
                }

                // Backup codes
                const countEl = document.getElementById('account-backup-count');
                if (profile.totp_enabled) {
                    const count = profile.backup_code_count || 0;
                    countEl.innerHTML = `<span style="color:${count === 0 ? 'var(--error)' : 'var(--text-main)'};">${count} of 10 remaining</span>`;
                } else {
                    countEl.textContent = 'N/A — 2FA not enabled';
                }

                // Load preferences into form
                const prefsRes = await fetchWithAuth(`${API}/api/admin/user/preferences`);
                if (prefsRes.ok) {
                    const prefs = await prefsRes.json();
                    if (prefs.theme) document.getElementById('pref-theme').value = prefs.theme;
                    if (prefs.defaultPage) document.getElementById('pref-default-page').value = prefs.defaultPage;
                    if (prefs.itemsPerPage) document.getElementById('pref-items-per-page').value = prefs.itemsPerPage;
                    if (prefs.dateFormat) document.getElementById('pref-date-format').value = prefs.dateFormat;
                }
            } catch (err) {
                console.error('Failed to load account page:', err);
            }
        }

        async function saveProfile() {
            const displayName = document.getElementById('account-display-name').value.trim();
            const msgEl = document.getElementById('account-profile-msg');
            try {
                const res = await fetchWithAuth(`${API}/api/admin/user/profile`, {
                    method: 'PUT',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ display_name: displayName })
                });
                if (res.ok) {
                    msgEl.style.display = 'block';
                    msgEl.style.background = 'color-mix(in srgb, var(--success) 20%, transparent)';
                    msgEl.style.color = 'var(--success)';
                    msgEl.textContent = 'Profile updated';
                    setTimeout(() => { msgEl.style.display = 'none'; }, 3000);
                    // Update avatar
                    if (currentUser) {
                        currentUser.display_name = displayName;
                        const avatarEl = document.getElementById('nav-user-avatar');
                        if (avatarEl) {
                            const name = displayName || currentUser.username || '';
                            const parts = name.trim().split(/\s+/);
                            const initials = parts.length >= 2
                                ? (parts[0][0] + parts[parts.length - 1][0]).toUpperCase()
                                : name.substring(0, 2).toUpperCase();
                            avatarEl.textContent = initials;
                            avatarEl.title = name;
                        }
                    }
                } else {
                    const data = await res.json();
                    msgEl.style.display = 'block';
                    msgEl.style.background = 'color-mix(in srgb, var(--error) 20%, transparent)';
                    msgEl.style.color = 'var(--error)';
                    msgEl.textContent = data.error || 'Failed to update profile';
                }
            } catch (err) {
                msgEl.style.display = 'block';
                msgEl.style.background = 'color-mix(in srgb, var(--error) 20%, transparent)';
                msgEl.style.color = 'var(--error)';
                msgEl.textContent = 'Network error: ' + err.message;
            }
        }

        async function changePassword() {
            const currentPw = document.getElementById('account-current-pw').value;
            const newPw = document.getElementById('account-new-pw').value;
            const confirmPw = document.getElementById('account-confirm-pw').value;
            const msgEl = document.getElementById('account-pw-msg');

            if (!currentPw || !newPw) {
                msgEl.style.display = 'block';
                msgEl.style.background = 'color-mix(in srgb, var(--error) 20%, transparent)';
                msgEl.style.color = 'var(--error)';
                msgEl.textContent = 'All fields are required';
                return;
            }
            if (newPw !== confirmPw) {
                msgEl.style.display = 'block';
                msgEl.style.background = 'color-mix(in srgb, var(--error) 20%, transparent)';
                msgEl.style.color = 'var(--error)';
                msgEl.textContent = 'New passwords do not match';
                return;
            }
            if (newPw.length < 6) {
                msgEl.style.display = 'block';
                msgEl.style.background = 'color-mix(in srgb, var(--error) 20%, transparent)';
                msgEl.style.color = 'var(--error)';
                msgEl.textContent = 'Password must be at least 6 characters';
                return;
            }

            try {
                const res = await fetchWithAuth(`${API}/api/admin/user/password`, {
                    method: 'PUT',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ currentPassword: currentPw, newPassword: newPw })
                });
                if (res.ok) {
                    msgEl.style.display = 'block';
                    msgEl.style.background = 'color-mix(in srgb, var(--success) 20%, transparent)';
                    msgEl.style.color = 'var(--success)';
                    msgEl.textContent = 'Password changed successfully';
                    document.getElementById('account-current-pw').value = '';
                    document.getElementById('account-new-pw').value = '';
                    document.getElementById('account-confirm-pw').value = '';
                    setTimeout(() => { msgEl.style.display = 'none'; }, 3000);
                } else {
                    const data = await res.json();
                    msgEl.style.display = 'block';
                    msgEl.style.background = 'color-mix(in srgb, var(--error) 20%, transparent)';
                    msgEl.style.color = 'var(--error)';
                    msgEl.textContent = data.error || 'Failed to change password';
                }
            } catch (err) {
                msgEl.style.display = 'block';
                msgEl.style.background = 'color-mix(in srgb, var(--error) 20%, transparent)';
                msgEl.style.color = 'var(--error)';
                msgEl.textContent = 'Network error: ' + err.message;
            }
        }

        async function regenOwnBackupCodes() {
            const password = prompt('Enter your password to regenerate backup codes:');
            if (!password) return;
            const msgEl = document.getElementById('account-2fa-msg');
            try {
                const res = await fetchWithAuth(`${API}/api/admin/user/2fa/backup-codes`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ password })
                });
                const data = await res.json();
                if (res.ok) {
                    // Show backup codes
                    const display = document.getElementById('account-backup-display');
                    const grid = document.getElementById('account-backup-codes');
                    grid.innerHTML = data.codes.map(c => `<div style="background:var(--bg-panel); padding:4px 8px; border-radius:4px;">${c}</div>`).join('');
                    display.style.display = 'block';
                    // Update count
                    document.getElementById('account-backup-count').innerHTML = '<span style="color:var(--text-main);">10 of 10 remaining</span>';
                    msgEl.style.display = 'block';
                    msgEl.style.background = 'color-mix(in srgb, var(--success) 20%, transparent)';
                    msgEl.style.color = 'var(--success)';
                    msgEl.textContent = 'Backup codes regenerated';
                    setTimeout(() => { msgEl.style.display = 'none'; }, 3000);
                } else {
                    msgEl.style.display = 'block';
                    msgEl.style.background = 'color-mix(in srgb, var(--error) 20%, transparent)';
                    msgEl.style.color = 'var(--error)';
                    msgEl.textContent = data.error || 'Failed to regenerate codes';
                    setTimeout(() => { msgEl.style.display = 'none'; }, 3000);
                }
            } catch (err) {
                msgEl.style.display = 'block';
                msgEl.style.background = 'color-mix(in srgb, var(--error) 20%, transparent)';
                msgEl.style.color = 'var(--error)';
                msgEl.textContent = 'Network error: ' + err.message;
            }
        }

        async function resetOwnMFA() {
            if (!confirm('Reset your 2FA? You will be logged out and must set up 2FA again on next login.')) return;
            const password = prompt('Enter your password to confirm:');
            if (!password) return;
            const msgEl = document.getElementById('account-2fa-msg');
            try {
                const res = await fetchWithAuth(`${API}/api/admin/user/2fa/reset`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ password })
                });
                if (res.ok) {
                    alert('2FA has been reset. You will now be logged out.');
                    sessionStorage.removeItem('pocket_it_token');
                    authToken = '';
                    location.reload();
                } else {
                    const data = await res.json();
                    msgEl.style.display = 'block';
                    msgEl.style.background = 'color-mix(in srgb, var(--error) 20%, transparent)';
                    msgEl.style.color = 'var(--error)';
                    msgEl.textContent = data.error || 'Failed to reset 2FA';
                    setTimeout(() => { msgEl.style.display = 'none'; }, 3000);
                }
            } catch (err) {
                msgEl.style.display = 'block';
                msgEl.style.background = 'color-mix(in srgb, var(--error) 20%, transparent)';
                msgEl.style.color = 'var(--error)';
                msgEl.textContent = 'Network error: ' + err.message;
            }
        }

        async function savePreferences() {
            const prefs = {
                theme: document.getElementById('pref-theme').value,
                defaultPage: document.getElementById('pref-default-page').value,
                itemsPerPage: document.getElementById('pref-items-per-page').value,
                dateFormat: document.getElementById('pref-date-format').value
            };
            const msgEl = document.getElementById('account-pref-msg');
            try {
                const res = await fetchWithAuth(`${API}/api/admin/user/preferences`, {
                    method: 'PUT',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify(prefs)
                });
                if (res.ok) {
                    userPreferences = prefs;
                    sessionStorage.setItem('pocket_it_prefs', JSON.stringify(prefs));
                    applyPreferences();
                    msgEl.style.display = 'block';
                    msgEl.style.background = 'color-mix(in srgb, var(--success) 20%, transparent)';
                    msgEl.style.color = 'var(--success)';
                    msgEl.textContent = 'Preferences saved';
                    setTimeout(() => { msgEl.style.display = 'none'; }, 3000);
                } else {
                    const data = await res.json();
                    msgEl.style.display = 'block';
                    msgEl.style.background = 'color-mix(in srgb, var(--error) 20%, transparent)';
                    msgEl.style.color = 'var(--error)';
                    msgEl.textContent = data.error || 'Failed to save preferences';
                }
            } catch (err) {
                msgEl.style.display = 'block';
                msgEl.style.background = 'color-mix(in srgb, var(--error) 20%, transparent)';
                msgEl.style.color = 'var(--error)';
                msgEl.textContent = 'Network error: ' + err.message;
            }
        }

        async function regenBackupCodes(userId, username) {
            if (!confirm(`Regenerate backup codes for "${username}"? Their old codes will be invalidated.`)) return;
            try {
                const res = await fetchWithAuth(`${API}/api/admin/users/${userId}/backup-codes`, {
                    method: 'POST'
                });
                const data = await res.json();
                if (res.ok) {
                    alert(`New backup codes for "${username}":\n\n${data.codes.join('\n')}\n\nMake sure to share these securely.`);
                    loadUsers();
                } else {
                    alert(data.error || 'Failed to regenerate backup codes');
                }
            } catch (err) {
                alert('Network error: ' + err.message);
            }
        }

        // ---- Fleet ----
        function renderDeviceCard(d) {
            const hs = d.health_score;
            const healthClass = hs === null || hs === undefined ? 'unknown' : hs >= 75 ? 'good' : hs >= 40 ? 'warning' : 'critical';
            const healthLabel = hs !== null && hs !== undefined ? hs + '%' : 'No data';
            return `
            <div class="device-card" data-device-id="${d.device_id}">
                <div class="device-header">
                    <span class="hostname">${escapeHtml(d.hostname || 'Unknown')}</span>${window._unreadCounts && window._unreadCounts[d.device_id] ? '<span class="unread-badge">' + window._unreadCounts[d.device_id] + '</span>' : ''}
                    <span class="status-dot ${d.status || 'offline'}"></span>
                </div>
                <div class="device-id">${escapeHtml(d.device_id.substring(0, 8))}...</div>
                <div class="last-seen">Last seen: ${d.last_seen ? new Date(d.last_seen).toLocaleString() : 'Never'}</div>
                <div class="health-bar"><div class="fill ${healthClass}" style="width: ${hs !== null && hs !== undefined ? hs : 0}%"></div></div>
                <div style="font-size: 11px; color: #8f98a0; margin-top: 4px;">Health: ${healthLabel}</div>
                <div style="font-size: 11px; margin-top: 4px; ${d.client_version ? 'color: #8f98a0;' : 'color: #ef5350;'}">${d.client_version ? 'v' + escapeHtml(d.client_version) : 'No version'}</div>
                <div style="font-size: 11px; margin-top: 4px; color: #b0bec5;"><span style="color: #546e7a;">&#128100;</span> ${(() => { try { const users = typeof d.logged_in_users === 'string' ? JSON.parse(d.logged_in_users || '[]') : (d.logged_in_users || []); return users.length > 0 ? escapeHtml(users[0]) + (users.length > 1 ? ' +' + (users.length - 1) : '') : '<span style="color:#616161;">No user</span>'; } catch(e) { return '<span style="color:#616161;">No user</span>'; } })()}</div>
            </div>`;
        }

        async function loadFleet() {
            try {
                const [statsRes, devicesRes, unreadRes] = await Promise.all([
                    fetchWithAuth(`${API}/api/admin/stats`),
                    fetchWithAuth(`${API}/api/devices${selectedClientId ? '?client_id=' + selectedClientId : ''}`),
                    fetchWithAuth(`${API}/api/devices/unread-counts`).catch(() => ({ json: () => ({}) }))
                ]);
                const stats = await statsRes.json();
                const devices = await devicesRes.json();
                try { window._unreadCounts = await unreadRes.json(); } catch(e) { window._unreadCounts = {}; }

                document.getElementById('stat-online').textContent = stats.onlineDevices || 0;
                document.getElementById('stat-total').textContent = stats.totalDevices || 0;
                document.getElementById('stat-tickets-open').textContent = stats.openTickets || 0;
                document.getElementById('stat-tickets-total').textContent = stats.totalTickets || 0;
                document.getElementById('stat-health').textContent = stats.averageHealth !== null && stats.averageHealth !== undefined ? stats.averageHealth + '%' : '—';
                document.getElementById('stat-critical').textContent = stats.criticalDevices || 0;

                // Load alert stats for fleet page
                try {
                    const alertStatsRes = await fetchWithAuth(`${API}/api/alerts/stats`);
                    const alertStats = await alertStatsRes.json();
                    document.getElementById('stat-alerts').textContent = alertStats.activeCount || 0;

                    // Update nav badge too
                    const badge = document.getElementById('nav-alert-badge');
                    if (alertStats.activeCount > 0) {
                        badge.textContent = alertStats.activeCount;
                        badge.style.display = 'inline';
                    } else {
                        badge.style.display = 'none';
                    }
                } catch (err) {
                    console.error('Failed to load alert stats:', err);
                }

                const grid = document.getElementById('device-grid');
                if (devices.length === 0) {
                    grid.innerHTML = '<div class="empty-state">No devices enrolled yet.</div>';
                    return;
                }
                // Group by client if showing all
                if (!selectedClientId && currentClients.length > 1) {
                    const groups = {};
                    devices.forEach(d => {
                        const cid = d.client_id || 'unassigned';
                        if (!groups[cid]) groups[cid] = [];
                        groups[cid].push(d);
                    });
                    let html = '';
                    for (const c of currentClients) {
                        const grp = groups[c.id];
                        if (!grp || grp.length === 0) continue;
                        html += `<div class="client-group-header" style="grid-column: 1 / -1;">${escapeHtml(c.name)} (${grp.length})</div>`;
                        html += grp.map(d => renderDeviceCard(d)).join('');
                    }
                    // Any unassigned
                    if (groups['unassigned']) {
                        html += `<div class="client-group-header" style="grid-column: 1 / -1;">Unassigned (${groups['unassigned'].length})</div>`;
                        html += groups['unassigned'].map(d => renderDeviceCard(d)).join('');
                    }
                    grid.innerHTML = html;
                } else {
                    grid.innerHTML = devices.map(d => renderDeviceCard(d)).join('');
                }
            } catch (err) {
                console.error('Failed to load fleet:', err);
            }
        }

        function renderDeviceWatchers(watcherNames) {
            const container = document.getElementById('device-watchers');
            if (!container) return;
            if (!watcherNames || watcherNames.length === 0) {
                container.innerHTML = '';
                return;
            }
            container.innerHTML = '<span style="font-size:11px; color:#8f98a0;">Viewing:</span> ' +
                watcherNames.map(name => `<span class="watcher-pill">${escapeHtml(name)}</span>`).join('');
        }

        function updateAIControlButtons(aiDisabled) {
            document.querySelectorAll('#device-ai-controls .diag-btn').forEach(btn => {
                btn.classList.remove('ai-mode-active');
            });
            const activeMode = aiDisabled || 'enabled';
            if (activeMode === 'it_active') {
                // IT is actively chatting — highlight "Disable Temporarily" as active
                const tempBtn = document.querySelector('#device-ai-controls .diag-btn[data-ai-mode="temporary"]');
                if (tempBtn) tempBtn.classList.add('ai-mode-active');
            } else {
                const activeBtn = document.querySelector(`#device-ai-controls .diag-btn[data-ai-mode="${activeMode}"]`);
                if (activeBtn) activeBtn.classList.add('ai-mode-active');
            }
        }

        function showToast(message, duration = 4000) {
            const container = document.getElementById('toast-container');
            if (!container) return;
            const toast = document.createElement('div');
            toast.className = 'toast-message';
            toast.textContent = message;
            container.appendChild(toast);
            requestAnimationFrame(() => toast.classList.add('show'));
            setTimeout(() => {
                toast.classList.remove('show');
                setTimeout(() => toast.remove(), 300);
            }, duration);
        }

        async function showMoveDeviceDialog(deviceId) {
            try {
                const res = await fetchWithAuth(`${API}/api/clients`);
                const clients = await res.json();

                const dialog = document.createElement('div');
                dialog.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,0.6);z-index:9999;display:flex;align-items:center;justify-content:center;';
                const box = document.createElement('div');
                box.style.cssText = 'background:#1b2838;border:1px solid #2a475e;border-radius:8px;padding:24px;min-width:300px;max-width:400px;';
                box.innerHTML = `
                    <h3 style="margin:0 0 16px;color:#c7d5e0;">Move Device to Client</h3>
                    <select id="move-client-select" style="width:100%;padding:8px;background:#0f1923;color:#c7d5e0;border:1px solid #2a475e;border-radius:4px;margin-bottom:16px;">
                        <option value="">Unassigned</option>
                        ${clients.map(c => `<option value="${c.id}">${escapeHtml(c.name)}</option>`).join('')}
                    </select>
                    <div style="display:flex;gap:8px;justify-content:flex-end;">
                        <button class="diag-btn" id="move-cancel">Cancel</button>
                        <button class="diag-btn" id="move-confirm" style="background:#1a3a5c;color:#66c0f4;border-color:#66c0f4;">Move</button>
                    </div>
                `;
                dialog.appendChild(box);
                document.body.appendChild(dialog);

                dialog.addEventListener('click', (e) => { if (e.target === dialog) dialog.remove(); });
                box.querySelector('#move-cancel').addEventListener('click', () => dialog.remove());
                box.querySelector('#move-confirm').addEventListener('click', async () => {
                    const select = box.querySelector('#move-client-select');
                    const clientId = select.value === '' ? null : parseInt(select.value);
                    try {
                        const res = await fetchWithAuth(`${API}/api/devices/${deviceId}/client`, {
                            method: 'PATCH',
                            headers: { 'Content-Type': 'application/json' },
                            body: JSON.stringify({ client_id: clientId })
                        });
                        if (!res.ok) {
                            const data = await res.json();
                            showToast(data.error || 'Failed to move device');
                            return;
                        }
                        showToast('Device moved successfully');
                        dialog.remove();
                        // Refresh device page
                        openDevice(deviceId);
                    } catch (err) {
                        showToast('Failed to move device');
                    }
                });
            } catch (err) {
                showToast('Failed to load clients');
            }
        }

        let ticketDevicesCache = [];

        function showCreateTicketForm() {
            const form = document.getElementById('create-ticket-form');
            form.style.display = '';
            document.getElementById('new-ticket-device').value = '';
            document.getElementById('new-ticket-device-search').value = '';
            fetchWithAuth(`${API}/api/devices`).then(r => r.json()).then(devices => {
                ticketDevicesCache = devices;
            }).catch(() => { ticketDevicesCache = []; });
        }

        function filterTicketDevices() {
            const query = document.getElementById('new-ticket-device-search').value.toLowerCase();
            const dropdown = document.getElementById('new-ticket-device-dropdown');
            const matches = ticketDevicesCache.filter(d =>
                (d.hostname || '').toLowerCase().includes(query) ||
                d.device_id.toLowerCase().includes(query)
            ).slice(0, 20);

            if (matches.length === 0) {
                dropdown.innerHTML = '<div style="padding:8px 10px; color:#8f98a0; font-size:12px;">No devices match</div>';
            } else {
                dropdown.innerHTML = matches.map(d => {
                    const online = d.status === 'online';
                    return `<div class="ticket-device-option" style="padding:7px 10px; cursor:pointer; font-size:13px; color:#c7d5e0; display:flex; align-items:center; gap:8px; transition:background 0.1s;"
                        data-device-id="${d.device_id}" data-label="${escapeHtml(d.hostname || d.device_id)}">
                        <span style="width:7px; height:7px; border-radius:50%; background:${online ? '#4caf50' : '#616161'}; flex-shrink:0;"></span>
                        <span>${escapeHtml(d.hostname || d.device_id)}</span>
                        <span style="font-size:11px; color:#8f98a0; margin-left:auto;">${online ? 'online' : 'offline'}</span>
                    </div>`;
                }).join('');
            }
            dropdown.style.display = '';
        }

        function selectTicketDevice(deviceId, label) {
            document.getElementById('new-ticket-device').value = deviceId;
            document.getElementById('new-ticket-device-search').value = label;
            document.getElementById('new-ticket-device-dropdown').style.display = 'none';
        }

        document.addEventListener('click', (e) => {
            const dd = document.getElementById('new-ticket-device-dropdown');
            const search = document.getElementById('new-ticket-device-search');
            if (dd && search && !search.contains(e.target) && !dd.contains(e.target)) {
                dd.style.display = 'none';
            }
        });

        function hideCreateTicketForm() {
            document.getElementById('create-ticket-form').style.display = 'none';
            document.getElementById('new-ticket-title').value = '';
            document.getElementById('new-ticket-description').value = '';
            document.getElementById('new-ticket-category').value = '';
            document.getElementById('new-ticket-priority').value = 'medium';
            document.getElementById('new-ticket-device').value = '';
            document.getElementById('new-ticket-device-search').value = '';
            document.getElementById('new-ticket-device-dropdown').style.display = 'none';
        }

        async function submitNewTicket() {
            const title = document.getElementById('new-ticket-title').value.trim();
            const device_id = document.getElementById('new-ticket-device').value;
            const description = document.getElementById('new-ticket-description').value.trim();
            const priority = document.getElementById('new-ticket-priority').value;
            const category = document.getElementById('new-ticket-category').value.trim();

            if (!title) { alert('Title is required'); return; }
            if (!device_id) { alert('Please select a device'); return; }

            try {
                const res = await fetchWithAuth(`${API}/api/tickets/manual`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ title, device_id, description, priority, category: category || null })
                });
                if (!res.ok) {
                    const err = await res.json();
                    alert('Error: ' + (err.error || 'Failed to create ticket'));
                    return;
                }
                hideCreateTicketForm();
                loadTickets();
            } catch (err) {
                console.error('Failed to create ticket:', err);
                alert('Failed to create ticket');
            }
        }

        // ---- Tickets ----
        async function loadTickets(filters = {}) {
            try {
                const qs = filters.device_id ? `?device_id=${encodeURIComponent(filters.device_id)}` : '';
                const res = await fetchWithAuth(`${API}/api/tickets${qs}`);
                const tickets = await res.json();
                const list = document.getElementById('ticket-list');
                if (tickets.length === 0) {
                    list.innerHTML = '<div class="empty-state">No tickets yet.</div>';
                    return;
                }
                list.innerHTML = tickets.map(t => `
                    <li class="ticket-item" data-ticket-id="${t.id}" style="cursor:pointer;">
                        <div class="priority ${t.priority}"></div>
                        <div class="ticket-info">
                            <div class="ticket-title">${escapeHtml(t.title)}</div>
                            <div class="ticket-meta">
                                Device: <a href="#" class="ticket-device-link" data-device-id="${escapeHtml(t.device_id || '')}" onclick="event.stopPropagation();navigateToDevice('${escapeHtml(t.device_id || '')}');return false;">${escapeHtml(t.hostname || (t.device_id || '').substring(0, 8) + '...')}</a>
                                ${(t.requested_by || t.hostname) ? ` | By: <strong>${escapeHtml(t.requested_by || t.hostname)}</strong>` : ''}
                                | Created: ${new Date(t.created_at).toLocaleString()}
                            </div>
                        </div>
                        <span class="ticket-status ${t.status}">${t.status}</span>
                    </li>
                `).join('');
            } catch (err) {
                console.error('Failed to load tickets:', err);
            }
        }

        async function openTicket(ticketId) {
            currentTicketId = ticketId;
            const panel = document.getElementById('ticket-detail');
            panel.classList.add('active');

            try {
                const res = await fetchWithAuth(`${API}/api/tickets/${ticketId}`);
                const ticket = await res.json();

                document.getElementById('ticket-detail-title').textContent = ticket.title;
                document.getElementById('ticket-detail-info').innerHTML = `
                    #${ticket.id} |
                    Device: <a href="#" onclick="navigateToDevice('${escapeHtml(ticket.device_id || '')}');return false;" style="color:#66c0f4;">${escapeHtml(ticket.hostname || (ticket.device_id || '').substring(0, 12) + '...')}</a>
                    ${(ticket.requested_by || ticket.hostname) ? ` | By: <strong>${escapeHtml(ticket.requested_by || ticket.hostname)}</strong>` : ''}
                    | Created: ${new Date(ticket.created_at).toLocaleString()}
                    ${ticket.ai_summary ? ' | <em>AI-generated</em>' : ''}
                `;
                document.getElementById('ticket-detail-description').textContent =
                    ticket.description || ticket.ai_summary || 'No description provided.';

                document.getElementById('ticket-status-select').value = ticket.status || 'open';
                document.getElementById('ticket-priority-select').value = ticket.priority || 'medium';

                // Render comments
                const commentsEl = document.getElementById('ticket-comments');
                if (ticket.comments && ticket.comments.length > 0) {
                    commentsEl.innerHTML = ticket.comments.map(c => `
                        <div style="background:#0f1923; border:1px solid #2a475e; border-radius:6px; padding:10px; margin-bottom:8px;">
                            <div style="font-size:12px; color:#8f98a0;">${escapeHtml(c.author)} &mdash; ${new Date(c.created_at).toLocaleString()}</div>
                            <div style="font-size:13px; margin-top:4px;">${escapeHtml(c.content)}</div>
                        </div>
                    `).join('');
                } else {
                    commentsEl.innerHTML = '<div style="font-size:13px; color:#8f98a0;">No comments yet.</div>';
                }
            } catch (err) {
                console.error('Failed to load ticket:', err);
            }
        }

        function closeTicketDetail() {
            document.getElementById('ticket-detail').classList.remove('active');
            currentTicketId = null;
        }

        async function updateTicket(field, value) {
            if (!currentTicketId) return;
            try {
                await fetchWithAuth(`${API}/api/tickets/${currentTicketId}`, {
                    method: 'PATCH',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ [field]: value })
                });
                loadTickets(); // refresh list
            } catch (err) {
                console.error('Failed to update ticket:', err);
            }
        }

        async function addTicketComment() {
            const input = document.getElementById('ticket-comment-input');
            const content = input.value.trim();
            if (!content || !currentTicketId) return;

            try {
                await fetchWithAuth(`${API}/api/tickets/${currentTicketId}/comments`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ content, author: 'IT Staff' })
                });
                input.value = '';
                openTicket(currentTicketId); // refresh detail
            } catch (err) {
                console.error('Failed to add comment:', err);
            }
        }

        // v0.19.0: Device Notes functions
        function renderDeviceNotes(notes) {
            const list = document.getElementById('device-notes-list');
            if (!list) return;
            list.innerHTML = '';
            if (!notes || notes.length === 0) {
                list.innerHTML = '<div style="color:#8f98a0; font-size:13px; padding:8px 0;">No notes yet.</div>';
            } else {
                notes.forEach(note => prependDeviceNote(note, true));
            }
            updateNoteCount();
        }

        function prependDeviceNote(note, append) {
            const list = document.getElementById('device-notes-list');
            if (!list) return;
            // Remove "no notes" placeholder
            const placeholder = list.querySelector('div[style*="No notes"]');
            if (placeholder) placeholder.remove();

            const div = document.createElement('div');
            div.id = 'note-' + note.id;
            div.style.cssText = 'background:#0e1621; border:1px solid #2a475e; border-left:3px solid #3d5a2e; border-radius:4px; padding:10px 12px; margin-bottom:8px;';
            const ts = note.created_at ? new Date(note.created_at + 'Z').toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit', hour12: true }) : '';
            div.innerHTML = `<div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:4px;">
                <span style="font-size:12px; color:#8f98a0;">${escapeHtml(note.author)} &mdash; ${escapeHtml(ts)}</span>
                <button onclick="deleteDeviceNote(${note.id})" style="background:none; border:none; color:#ef5350; cursor:pointer; font-size:14px; padding:0 4px;" title="Delete note">&times;</button>
            </div>
            <div style="font-size:13px; color:#c7d5e0; white-space:pre-wrap; word-break:break-word;">${escapeHtml(note.content)}</div>`;
            if (append) {
                list.appendChild(div);
            } else {
                list.prepend(div);
            }
            updateNoteCount();
        }

        function addDeviceNote() {
            const input = document.getElementById('device-note-input');
            const content = input.value.trim();
            if (!content || !currentDeviceId || !socket) return;
            socket.emit('add_device_note', { deviceId: currentDeviceId, content });
            input.value = '';
        }

        function deleteDeviceNote(noteId) {
            if (!currentDeviceId || !socket) return;
            socket.emit('delete_device_note', { deviceId: currentDeviceId, noteId });
        }

        function updateNoteCount() {
            const list = document.getElementById('device-notes-list');
            const countEl = document.getElementById('device-notes-count');
            if (!list || !countEl) return;
            const count = list.querySelectorAll('[id^="note-"]').length;
            countEl.textContent = count > 0 ? `(${count})` : '';
        }

        // v0.19.0: Custom Fields functions
        function renderCustomFields(fields) {
            const grid = document.getElementById('custom-fields-grid');
            if (!grid) return;
            if (!fields || fields.length === 0) {
                grid.innerHTML = '<div style="color:#8f98a0; font-size:13px;">No custom fields.</div>';
                return;
            }
            grid.innerHTML = fields.map(f => {
                const ts = f.updated_at ? new Date(f.updated_at + 'Z').toLocaleString('en-US', { month: 'short', day: 'numeric' }) : '';
                const source = f.updated_by || 'unknown';
                return `<div class="stat-card" style="border-left:3px solid #3d5a2e; position:relative;">
                    <button onclick="deleteCustomField('${escapeHtml(f.field_name).replace(/'/g, "\\'")}')" style="position:absolute; top:4px; right:6px; background:none; border:none; color:#ef5350; cursor:pointer; font-size:14px; padding:0;" title="Delete field">&times;</button>
                    <div class="value" style="font-size:16px;">${escapeHtml(f.field_value || '—')}</div>
                    <div class="label">${escapeHtml(f.field_name)}</div>
                    <div style="font-size:10px; color:#616161; margin-top:2px;">by ${escapeHtml(source)} &middot; ${escapeHtml(ts)}</div>
                </div>`;
            }).join('');
        }

        function loadCustomFields(deviceId) {
            fetchWithAuth(`${API}/api/devices/${deviceId}/custom-fields`).then(r => r.json()).then(fields => {
                renderCustomFields(fields);
            }).catch(() => {});
        }

        function saveCustomField() {
            const nameEl = document.getElementById('cf-new-name');
            const valueEl = document.getElementById('cf-new-value');
            const name = nameEl.value.trim();
            const value = valueEl.value.trim();
            if (!name || !currentDeviceId || !socket) return;
            socket.emit('set_custom_fields', { deviceId: currentDeviceId, fields: { [name]: value } });
            nameEl.value = '';
            valueEl.value = '';
            document.getElementById('custom-fields-add-form').style.display = 'none';
        }

        function deleteCustomField(fieldName) {
            if (!currentDeviceId || !socket) return;
            socket.emit('delete_custom_field', { deviceId: currentDeviceId, fieldName });
        }

        window.navigateToDevice = function(deviceId) {
            openDevice(deviceId);
        };

        window.navigateAndOpenTicket = function(ticketId) {
            openTicket(ticketId);
        }

        async function loadDeviceTickets(deviceId, container) {
            try {
                container.innerHTML = '<div style="color:#8f98a0;font-size:13px;padding:8px 0;">Loading tickets...</div>';
                const res = await fetchWithAuth(`${API}/api/tickets?device_id=${encodeURIComponent(deviceId)}`);
                const tickets = await res.json();
                if (!tickets.length) {
                    container.innerHTML = '<div style="color:#8f98a0;font-size:13px;padding:8px 0;">No tickets for this device.</div>';
                    return;
                }
                container.innerHTML = tickets.map(t => `
                    <div class="ticket-item" style="cursor:pointer;padding:8px 4px;" onclick="navigateAndOpenTicket(${t.id})">
                        <div style="display:flex;align-items:center;gap:8px;">
                            <span class="priority ${t.priority}" style="width:8px;height:8px;border-radius:50%;flex-shrink:0;"></span>
                            <span style="font-size:13px;flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">${escapeHtml(t.title)}</span>
                            <span class="ticket-status ${t.status}" style="font-size:11px;flex-shrink:0;">${t.status}</span>
                        </div>
                        <div style="font-size:11px;color:#8f98a0;margin-top:2px;padding-left:16px;">
                            ${(t.requested_by || t.hostname) ? `<strong style="color:#c7d5e0;">${escapeHtml(t.requested_by || t.hostname)}</strong> · ` : ''}${new Date(t.created_at).toLocaleString()}
                        </div>
                    </div>
                `).join('');
            } catch (err) {
                container.innerHTML = '<div style="color:#8f98a0;font-size:13px;">Failed to load tickets.</div>';
            }
        }

        // ---- Device Detail ----
        function openDevice(deviceId, skipPush) {
            cleanupTerminal();
            currentDeviceId = deviceId;

            // Switch to device page (same as nav page switching)
            document.querySelectorAll('.nav-link').forEach(l => l.classList.remove('active'));
            document.querySelectorAll('.page').forEach(p => p.classList.remove('active'));
            document.getElementById('page-device').classList.add('active');

            if (!skipPush) history.pushState({ page: 'device', deviceId }, '', '#device/' + deviceId);

            document.getElementById('detail-hostname').textContent = 'Loading...';
            document.getElementById('detail-device-id').textContent = '';
            document.getElementById('detail-chat').innerHTML = '';
            document.getElementById('detail-diagnostics').innerHTML = '';

            fetchWithAuth(`${API}/api/devices/${deviceId}`).then(r => r.json()).then(d => {
                document.getElementById('detail-hostname').textContent = d.hostname || deviceId;
                document.getElementById('detail-device-id').textContent = d.device_id;
                const statusDot = document.getElementById('detail-status-dot');
                statusDot.className = 'status-dot ' + (d.status || 'offline');

                // Render info as stat cards
                const infoHtml = [];
                if (d.os_name || d.os_version) infoHtml.push(`<div class="stat-card" data-page="reports"><div class="value" style="font-size:16px;">${escapeHtml(d.os_name || d.os_version)}</div><div class="label">OS</div></div>`);
                if (d.cpu_model) infoHtml.push(`<div class="stat-card" data-page="reports"><div class="value" style="font-size:16px;">${escapeHtml(d.cpu_model)}${d.processor_count ? ' (' + d.processor_count + ' cores)' : ''}</div><div class="label">CPU</div></div>`);
                if (d.total_ram_gb) infoHtml.push(`<div class="stat-card" data-page="reports"><div class="value">${d.total_ram_gb} GB</div><div class="label">RAM</div></div>`);
                if (d.total_disk_gb) infoHtml.push(`<div class="stat-card" data-page="reports"><div class="value">${d.total_disk_gb} GB</div><div class="label">Disk</div></div>`);
                if (d.health_score !== null && d.health_score !== undefined) {
                    const color = d.health_score >= 75 ? '#66bb6a' : d.health_score >= 40 ? '#ffa726' : '#ef5350';
                    infoHtml.push(`<div class="stat-card" data-page="reports"><div class="value" style="color:${color};">${d.health_score}%</div><div class="label">Health Score</div></div>`);
                }
                if (d.os_edition) infoHtml.push(`<div class="stat-card"><div class="value" style="font-size:14px;">${escapeHtml(d.os_edition)}</div><div class="label">OS Edition</div></div>`);
                if (d.gpu_model) infoHtml.push(`<div class="stat-card"><div class="value" style="font-size:14px;">${escapeHtml(d.gpu_model)}</div><div class="label">GPU</div></div>`);
                if (d.serial_number && d.serial_number !== 'Unknown') infoHtml.push(`<div class="stat-card"><div class="value" style="font-size:16px;">${escapeHtml(d.serial_number)}</div><div class="label">Serial Number</div></div>`);
                if (d.bios_manufacturer) infoHtml.push(`<div class="stat-card"><div class="value" style="font-size:14px;">${escapeHtml(d.bios_manufacturer)}${d.bios_version ? ' / ' + escapeHtml(d.bios_version) : ''}</div><div class="label">BIOS</div></div>`);
                if (d.domain) infoHtml.push(`<div class="stat-card"><div class="value" style="font-size:16px;">${escapeHtml(d.domain)}</div><div class="label">Domain</div></div>`);
                if (d.uptime_hours !== null && d.uptime_hours !== undefined) {
                    const days = Math.floor(d.uptime_hours / 24);
                    const hrs = Math.round(d.uptime_hours % 24);
                    const uptimeStr = days > 0 ? `${days}d ${hrs}h` : `${hrs}h`;
                    infoHtml.push(`<div class="stat-card"><div class="value">${uptimeStr}</div><div class="label">Uptime</div></div>`);
                }
                // Current logged-in users
                {
                    let userLabel = '<span style="color:#616161;">No user</span>';
                    try {
                        let users = typeof d.logged_in_users === 'string' ? JSON.parse(d.logged_in_users || '[]') : (d.logged_in_users || []);
                        if (Array.isArray(users) && users.length > 0) {
                            userLabel = users.map(u => escapeHtml(u)).join(', ');
                        }
                    } catch(e) {}
                    infoHtml.push(`<div class="stat-card"><div class="value" style="font-size:16px;">${userLabel}</div><div class="label">Current User</div></div>`);
                }
                // Previous logged-in users
                {
                    let prevLabel = '';
                    try {
                        let prevUsers = typeof d.previous_logged_in_users === 'string' ? JSON.parse(d.previous_logged_in_users || '[]') : (d.previous_logged_in_users || []);
                        if (Array.isArray(prevUsers) && prevUsers.length > 0) {
                            prevLabel = prevUsers.map(u => escapeHtml(u)).join(', ');
                        }
                    } catch(e) {}
                    if (prevLabel) {
                        infoHtml.push(`<div class="stat-card"><div class="value" style="font-size:14px; color:#8f98a0;">${prevLabel}</div><div class="label">Previous User</div></div>`);
                    }
                }
                document.getElementById('detail-info').innerHTML = infoHtml.join('');

                // Set initial AI control state
                updateAIControlButtons(d.ai_disabled);

                // Show current socket user in chat header
                const chatUserLabel = document.getElementById('chat-user-label');
                if (chatUserLabel) chatUserLabel.textContent = d.current_user || '';

                // Clear watchers container
                const watchersEl = document.getElementById('device-watchers');
                if (watchersEl) watchersEl.innerHTML = '';

                // Network adapters
                document.querySelectorAll('.net-adapters').forEach(el => el.remove());
                if (d.network_adapters) {
                    try {
                        let adapters = typeof d.network_adapters === 'string' ? JSON.parse(d.network_adapters) : d.network_adapters;
                        if (!Array.isArray(adapters)) adapters = [adapters];
                        if (adapters.length > 0) {
                            let netHtml = '<div class="net-adapters"><details><summary style="cursor:pointer; font-size:13px; color:#8f98a0; margin-bottom:8px;">Network Adapters (' + adapters.length + ')</summary>';
                            adapters.forEach(a => {
                                netHtml += `<div class="net-adapter-card"><span class="adapter-name">${escapeHtml(a.Name || a.name || 'Unknown')}</span>`;
                                if (a.IPv4 || a.ipv4) netHtml += ` <span style="color:#66bb6a; margin-left:8px;">${escapeHtml(a.IPv4 || a.ipv4)}</span>`;
                                if (a.MacAddress || a.macAddress) netHtml += ` <span style="color:#8f98a0; margin-left:8px;">${escapeHtml(a.MacAddress || a.macAddress)}</span>`;
                                if (a.Speed || a.speed) netHtml += ` <span style="color:#8f98a0; margin-left:8px;">${escapeHtml(a.Speed || a.speed)}</span>`;
                                netHtml += '</div>';
                            });
                            netHtml += '</details></div>';
                            document.getElementById('detail-info').insertAdjacentHTML('afterend', netHtml);
                        }
                    } catch (e) { console.error('Network adapter parse error:', e); }
                }
            });

            if (socket) {
                socket.emit('watch_device', { deviceId });
            }

            // Reset custom fields and notes
            document.getElementById('custom-fields-grid').innerHTML = '';
            document.getElementById('custom-fields-add-form').style.display = 'none';
            document.getElementById('device-notes-list').innerHTML = '';
            document.getElementById('device-note-input').value = '';
            document.getElementById('device-notes-count').textContent = '';
            // Device notes come via watch_device socket; custom fields loaded via REST as fallback
            loadCustomFields(deviceId);
            // Load device tickets
            const deviceTicketsContainer = document.getElementById('device-tickets-list');
            if (deviceTicketsContainer) loadDeviceTickets(deviceId, deviceTicketsContainer);

            loadScriptLibrary();
            // Reset file browser (lazy — user clicks header to load)
            currentBrowsePath = '';
            selectedFiles = new Set();
            fileClipboard = { operation: null, paths: [], sourcePath: '' };
            document.getElementById('file-browser-area').innerHTML = '<div style="color:#8f98a0; padding:20px; text-align:center;">Click the File Browser header to open.</div>';
            document.getElementById('file-section-content').style.display = 'none';
            document.getElementById('file-section-loaded').value = '';
            document.getElementById('script-output-area').innerHTML = '';
            // Reset and lazy-load system tools
            cachedProcessList = null;
            cachedServiceList = null;
            cachedEventList = null;
            document.getElementById('proc-table-container').innerHTML = '<div style="color:#8f98a0; font-size:13px;">Click Refresh to load processes</div>';
            document.getElementById('svc-table-container').innerHTML = '<div style="color:#8f98a0; font-size:13px;">Click Refresh to load services</div>';
            document.getElementById('evt-table-container').innerHTML = '<div style="color:#8f98a0; font-size:13px;">Select filters and click Query</div>';
            if (document.getElementById('evt-search')) document.getElementById('evt-search').value = '';
            document.getElementById('sys-tools-content').style.display = 'none';
            document.getElementById('sys-tools-section-loaded').value = '';
            // Reset and load activity history
            document.getElementById('activity-category-filter').value = '';
            document.getElementById('activity-date-from').value = '';
            document.getElementById('activity-date-to').value = '';
            activityCurrentPage = 1;
            loadDeviceActivity(deviceId);
        }

        function backToFleet() {
            cleanupTerminal();
            cleanupDesktop();
            if (socket && currentDeviceId) {
                socket.emit('unwatch_device', { deviceId: currentDeviceId });
            }
            currentDeviceId = null;
            navigateTo('fleet');
        }

        function closeDetail() { backToFleet(); }

        function startTerminal() {
            if (!currentDeviceId || !socket) return;
            terminalDeviceId = currentDeviceId;
            const statusEl = document.getElementById('terminal-status');
            statusEl.textContent = 'Waiting for user approval...';
            statusEl.className = 'waiting';
            document.getElementById('btn-start-terminal').disabled = true;
            document.getElementById('btn-stop-terminal').disabled = false;
            socket.emit('start_terminal', { deviceId: terminalDeviceId });
        }

        function stopTerminal() {
            if (!terminalDeviceId || !socket) return;
            socket.emit('stop_terminal', { deviceId: terminalDeviceId });
            cleanupTerminal();
        }

        function cleanupTerminal() {
            if (term) {
                term.dispose();
                term = null;
            }
            fitAddon = null;
            terminalLineBuffer = '';
            document.getElementById('terminal-container').style.display = 'none';
            const statusEl = document.getElementById('terminal-status');
            statusEl.textContent = 'Not connected';
            statusEl.className = '';
            document.getElementById('btn-stop-terminal').disabled = true;
            document.getElementById('btn-start-terminal').disabled = false;
            terminalDeviceId = null;
        }

        window.addEventListener('resize', () => {
            if (fitAddon) fitAddon.fit();
        });

        function startDesktop() {
            if (!currentDeviceId || !socket) return;
            desktopDeviceId = currentDeviceId;
            const statusEl = document.getElementById('desktop-status');
            statusEl.textContent = 'Connecting...';
            statusEl.style.color = '#ffa726';
            socket.emit('start_desktop', { deviceId: desktopDeviceId });
        }

        function stopDesktop() {
            if (!desktopDeviceId || !socket) return;
            socket.emit('stop_desktop', { deviceId: desktopDeviceId });
            cleanupDesktop();
        }

        function cleanupDesktop() {
            desktopActive = false;
            desktopDeviceId = null;
            desktopCanvas = null;
            desktopCtx = null;
            document.getElementById('desktop-viewer').style.display = 'none';
            document.getElementById('btn-start-desktop').disabled = false;
            document.getElementById('btn-stop-desktop').disabled = true;
            document.getElementById('desktop-status').textContent = 'Not connected';
            document.getElementById('desktop-status').style.color = '#8f98a0';
        }

        function popOutDesktop() {
            if (!currentDeviceId) return;
            const nameEl = document.getElementById('detail-hostname');
            const name = nameEl ? encodeURIComponent(nameEl.textContent) : '';
            window.open('/dashboard/desktop.html?deviceId=' + encodeURIComponent(currentDeviceId) + '&name=' + name, '_blank');
        }

        function updateDesktopQuality() {
            if (!desktopDeviceId || !socket || !desktopActive) return;
            const quality = parseInt(document.getElementById('desktop-quality').value);
            const fps = parseInt(document.getElementById('desktop-fps').value);
            const scale = parseFloat(document.getElementById('desktop-scale').value);
            socket.emit('desktop_quality', { deviceId: desktopDeviceId, quality, fps, scale });
        }

        // Desktop mouse/keyboard event handlers
        function setupDesktopInput() {
            const canvas = document.getElementById('desktop-canvas');
            const viewer = document.getElementById('desktop-viewer');

            function getCanvasCoords(e) {
                const rect = canvas.getBoundingClientRect();
                return {
                    x: (e.clientX - rect.left) / rect.width,
                    y: (e.clientY - rect.top) / rect.height
                };
            }

            canvas.addEventListener('mousedown', (e) => {
                if (!desktopActive || !socket) return;
                e.preventDefault();
                const pos = getCanvasCoords(e);
                const btn = e.button === 2 ? 'right' : e.button === 1 ? 'middle' : 'left';
                socket.emit('desktop_mouse', { deviceId: desktopDeviceId, x: pos.x, y: pos.y, button: btn, action: 'down' });
            });

            canvas.addEventListener('mouseup', (e) => {
                if (!desktopActive || !socket) return;
                e.preventDefault();
                const pos = getCanvasCoords(e);
                const btn = e.button === 2 ? 'right' : e.button === 1 ? 'middle' : 'left';
                socket.emit('desktop_mouse', { deviceId: desktopDeviceId, x: pos.x, y: pos.y, button: btn, action: 'up' });
            });

            canvas.addEventListener('mousemove', (e) => {
                if (!desktopActive || !socket) return;
                // Throttle mouse moves to ~30 per second
                if (!canvas._lastMove || Date.now() - canvas._lastMove > 33) {
                    canvas._lastMove = Date.now();
                    const pos = getCanvasCoords(e);
                    socket.emit('desktop_mouse', { deviceId: desktopDeviceId, x: pos.x, y: pos.y, button: 'left', action: 'move' });
                }
            });

            canvas.addEventListener('wheel', (e) => {
                if (!desktopActive || !socket) return;
                e.preventDefault();
                const pos = getCanvasCoords(e);
                socket.emit('desktop_mouse', { deviceId: desktopDeviceId, x: pos.x, y: pos.y, button: e.deltaY < 0 ? 'up' : 'down', action: 'scroll' });
            }, { passive: false });

            canvas.addEventListener('contextmenu', (e) => e.preventDefault());

            // Keyboard (only when desktop viewer is focused)
            viewer.setAttribute('tabindex', '0');
            viewer.addEventListener('keydown', (e) => {
                if (!desktopActive || !socket) return;
                e.preventDefault();
                socket.emit('desktop_keyboard', { deviceId: desktopDeviceId, vkCode: e.keyCode, action: 'down' });
            });

            viewer.addEventListener('keyup', (e) => {
                if (!desktopActive || !socket) return;
                e.preventDefault();
                socket.emit('desktop_keyboard', { deviceId: desktopDeviceId, vkCode: e.keyCode, action: 'up' });
            });
        }

        function appendChatMessage(sender, content) {
            const chatEl = document.getElementById('detail-chat');
            const msg = document.createElement('div');
            msg.className = 'msg';
            msg.innerHTML = `<span class="sender-tag ${escapeHtml(sender)}">${escapeHtml(sender)}:</span> ${escapeHtml(content)}`;
            chatEl.appendChild(msg);
            chatEl.scrollTop = chatEl.scrollHeight;
        }

        function sendChatToDevice() {
            const input = document.getElementById('detail-chat-input');
            const content = input.value.trim();
            if (!content || !currentDeviceId || !socket) return;
            socket.emit('chat_to_device', { deviceId: currentDeviceId, content });
            input.value = '';
        }

        document.getElementById('detail-chat-input').addEventListener('keydown', (e) => {
            if (e.key === 'Enter') sendChatToDevice();
        });

        function requestDiag(checkType) {
            if (!currentDeviceId || !socket) return;
            socket.emit('request_diagnostic', { deviceId: currentDeviceId, checkType });
        }

        function showDiagnosticResults(data) {
            const el = document.getElementById('detail-diagnostics');
            el.innerHTML = `<div style="font-size: 13px; color: #8f98a0;">
                Results for ${data.checkType} (${new Date().toLocaleTimeString()}):</div>
                <pre style="background: #0f1923; padding: 12px; border-radius: 6px; margin-top: 8px; font-size: 12px; overflow: auto;">${JSON.stringify(data.results, null, 2)}</pre>`;
        }


        async function removeDevice() {
            if (!currentDeviceId) return;
            if (!confirm('Remove this device and all its chat/diagnostic data? The device will need to re-enroll.')) return;
            try {
                const res = await fetchWithAuth(`${API}/api/devices/${currentDeviceId}`, { method: 'DELETE' });
                if (res.ok) {
                    closeDetail();
                    loadFleet();
                } else {
                    const data = await res.json();
                    alert('Failed: ' + (data.error || 'Unknown error'));
                }
            } catch (err) {
                alert('Failed to remove device: ' + err.message);
            }
        }

        // ---- Alerts ----
        let alertFilter = 'active';

        async function loadAlerts() {
            try {
                // Load stats
                const statsRes = await fetchWithAuth(`${API}/api/alerts/stats`);
                const stats = await statsRes.json();
                document.getElementById('alert-stat-active').textContent = stats.activeCount || 0;
                document.getElementById('alert-stat-critical').textContent = stats.criticalCount || 0;
                document.getElementById('alert-stat-warning').textContent = stats.warningCount || 0;

                // Update nav badge
                const badge = document.getElementById('nav-alert-badge');
                if (stats.activeCount > 0) {
                    badge.textContent = stats.activeCount;
                    badge.style.display = 'inline';
                } else {
                    badge.style.display = 'none';
                }

                // Load alerts
                const url = alertFilter === 'active'
                    ? `${API}/api/alerts?status=active`
                    : `${API}/api/alerts?limit=100`;
                const alertsRes = await fetchWithAuth(url);
                const alerts = await alertsRes.json();

                const list = document.getElementById('alert-list');
                if (alerts.length === 0) {
                    list.innerHTML = '<div class="empty-state">No alerts.</div>';
                } else {

                list.innerHTML = alerts.map(a => `
                    <li class="alert-item">
                        <div class="severity-indicator ${a.severity}"></div>
                        <div class="alert-info">
                            <div class="alert-title">${escapeHtml(a.message)}</div>
                            <div class="alert-meta">
                                Device: ${escapeHtml(a.hostname || (a.device_id || '').substring(0, 8))} |
                                Check: ${escapeHtml(a.check_type)} |
                                ${a.triggered_at ? new Date(a.triggered_at).toLocaleString() : ''}
                                ${a.status === 'acknowledged' ? ' | Acknowledged by ' + escapeHtml(a.acknowledged_by || 'staff') : ''}
                                ${a.status === 'resolved' ? ' | Resolved ' + (a.resolved_at ? new Date(a.resolved_at).toLocaleString() : '') : ''}
                            </div>
                        </div>
                        <div class="alert-actions">
                            ${a.status === 'active' ? `<button data-action="alert-acknowledge" data-id="${a.id}">Acknowledge</button>` : ''}
                            ${a.status !== 'resolved' ? `<button class="resolve-btn" data-action="alert-resolve" data-id="${a.id}">Resolve</button>` : ''}
                        </div>
                    </li>
                `).join('');
                }

                // Load thresholds
                await loadThresholds();
                // Load channels
                await loadChannels();
                await loadPolicies();
            } catch (err) {
                console.error('Failed to load alerts:', err);
            }
        }

        function filterAlerts(filter, targetEl) {
            alertFilter = filter;
            document.querySelectorAll('.alert-filter-btn').forEach(b => b.classList.remove('active'));
            if (targetEl) targetEl.classList.add('active');
            loadAlerts();
        }

        async function acknowledgeAlert(alertId) {
            try {
                await fetchWithAuth(`${API}/api/alerts/${alertId}/acknowledge`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ acknowledgedBy: 'IT Staff' })
                });
                loadAlerts();
            } catch (err) {
                console.error('Failed to acknowledge alert:', err);
            }
        }

        async function resolveAlert(alertId) {
            try {
                await fetchWithAuth(`${API}/api/alerts/${alertId}/resolve`, { method: 'POST' });
                loadAlerts();
            } catch (err) {
                console.error('Failed to resolve alert:', err);
            }
        }

        async function loadThresholds() {
            try {
                const res = await fetchWithAuth(`${API}/api/alerts/thresholds`);
                const thresholds = await res.json();
                const tbody = document.getElementById('threshold-tbody');
                tbody.innerHTML = thresholds.map(t => `
                    <tr>
                        <td>${escapeHtml(t.check_type)}</td>
                        <td>${escapeHtml(t.field_path)}</td>
                        <td>${escapeHtml(t.operator)} ${t.threshold_value}</td>
                        <td><span style="color: ${t.severity === 'critical' ? '#ef5350' : '#ffa726'}">${t.severity}</span></td>
                        <td>${t.consecutive_required}x</td>
                        <td>
                            <button class="toggle-btn ${t.enabled ? 'active' : ''}"
                                data-action="threshold-toggle" data-id="${t.id}" data-enabled="${t.enabled ? 0 : 1}">
                                ${t.enabled ? 'ON' : 'OFF'}
                            </button>
                        </td>
                        <td><button class="toggle-btn" data-action="threshold-delete" data-id="${t.id}">Delete</button></td>
                    </tr>
                `).join('');
            } catch (err) {
                console.error('Failed to load thresholds:', err);
            }
        }

        async function toggleThreshold(id, enabled) {
            try {
                await fetchWithAuth(`${API}/api/alerts/thresholds/${id}`, {
                    method: 'PATCH',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ enabled })
                });
                loadThresholds();
            } catch (err) {
                console.error('Failed to toggle threshold:', err);
            }
        }

        async function deleteThreshold(id) {
            if (!confirm('Delete this threshold?')) return;
            try {
                await fetchWithAuth(`${API}/api/alerts/thresholds/${id}`, { method: 'DELETE' });
                loadThresholds();
            } catch (err) {
                console.error('Failed to delete threshold:', err);
            }
        }

        async function loadChannels() {
            try {
                const res = await fetchWithAuth(`${API}/api/alerts/channels`);
                const channels = await res.json();
                const tbody = document.getElementById('channel-tbody');
                if (channels.length === 0) {
                    tbody.innerHTML = '<tr><td colspan="4" style="color:#8f98a0; text-align:center;">No notification channels configured.</td></tr>';
                    return;
                }
                tbody.innerHTML = channels.map(c => `
                    <tr>
                        <td>${escapeHtml(c.name)}</td>
                        <td>${escapeHtml(c.channel_type)}</td>
                        <td>
                            <button class="toggle-btn ${c.enabled ? 'active' : ''}"
                                data-action="channel-toggle" data-id="${c.id}" data-enabled="${c.enabled ? 0 : 1}">
                                ${c.enabled ? 'ON' : 'OFF'}
                            </button>
                        </td>
                        <td>
                            <button class="toggle-btn" data-action="channel-test" data-id="${c.id}">Test</button>
                            <button class="toggle-btn" data-action="channel-delete" data-id="${c.id}">Delete</button>
                        </td>
                    </tr>
                `).join('');
            } catch (err) {
                console.error('Failed to load channels:', err);
            }
        }

        function showAddChannelForm() {
            document.getElementById('add-channel-form').style.display = 'block';
        }

        function hideAddChannelForm() {
            document.getElementById('add-channel-form').style.display = 'none';
        }

        async function addChannel() {
            const name = document.getElementById('channel-name').value.trim();
            const type = document.getElementById('channel-type').value;
            const url = document.getElementById('channel-url').value.trim();

            if (!name || !url) {
                alert('Name and URL are required');
                return;
            }

            try {
                await fetchWithAuth(`${API}/api/alerts/channels`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ name, channel_type: type, config: { url } })
                });
                document.getElementById('channel-name').value = '';
                document.getElementById('channel-url').value = '';
                hideAddChannelForm();
                loadChannels();
            } catch (err) {
                console.error('Failed to add channel:', err);
            }
        }

        async function toggleChannel(id, enabled) {
            try {
                await fetchWithAuth(`${API}/api/alerts/channels/${id}`, {
                    method: 'PATCH',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ enabled })
                });
                loadChannels();
            } catch (err) {
                console.error('Failed to toggle channel:', err);
            }
        }

        async function testChannel(id) {
            try {
                const res = await fetchWithAuth(`${API}/api/alerts/channels/${id}/test`, { method: 'POST' });
                const data = await res.json();
                alert(data.success ? 'Test notification sent!' : 'Test failed: ' + (data.error || 'Unknown error'));
            } catch (err) {
                alert('Test failed: ' + err.message);
            }
        }

        async function deleteChannel(id) {
            if (!confirm('Delete this notification channel?')) return;
            try {
                await fetchWithAuth(`${API}/api/alerts/channels/${id}`, { method: 'DELETE' });
                loadChannels();
            } catch (err) {
                console.error('Failed to delete channel:', err);
            }
        }

        // ---- Lazy section toggles ----
        function toggleSysToolsSection() {
            const content = document.getElementById('sys-tools-content');
            const toggle = document.getElementById('sys-tools-toggle');
            const loaded = document.getElementById('sys-tools-section-loaded');
            const isOpen = content.style.display !== 'none';
            if (isOpen) {
                content.style.display = 'none';
                toggle.innerHTML = '&#x25BC;';
            } else {
                content.style.display = '';
                toggle.innerHTML = '&#x25B2;';
                if (!loaded.value) {
                    loaded.value = '1';
                    switchSysTab('processes');
                    loadProcesses();
                }
            }
        }

        function toggleFileBrowserSection() {
            const content = document.getElementById('file-section-content');
            const toggle = document.getElementById('file-section-toggle');
            const loaded = document.getElementById('file-section-loaded');
            const isOpen = content.style.display !== 'none';
            if (isOpen) {
                content.style.display = 'none';
                toggle.innerHTML = '&#x25BC;';
            } else {
                content.style.display = '';
                toggle.innerHTML = '&#x25B2;';
                if (!loaded.value) {
                    loaded.value = '1';
                    browseFiles('');
                }
            }
        }

        // ---- File Browser ----
        let currentBrowsePath = '';
        let fileBrowserHistory = [];
        let selectedFiles = new Set();
        let fileClipboard = { operation: null, paths: [], sourcePath: '' };

        function browseFiles(path) {
            if (!currentDeviceId || !socket) return;
            if (path === undefined || path === null) {
                path = '';
            }
            currentBrowsePath = path;
            document.getElementById('file-browser-area').innerHTML = '<div style="color:#8f98a0; padding:20px; text-align:center;">Loading...</div>';
            socket.emit('request_file_browse', { deviceId: currentDeviceId, path });
        }

        function updateBreadcrumb(path) {
            const bc = document.getElementById('file-breadcrumb');
            if (!bc) return;

            let html = '<span style="color:#66c0f4; cursor:pointer; font-size:14px;" data-action="browse" data-path="" title="Drives">&#x1F4BB;</span>';

            if (path) {
                html += '<span style="color:#4a6278;">&#x203A;</span>';
                const normalized = path.replace(/\//g, '\\');
                const parts = normalized.split('\\').filter(p => p);
                let accumulated = '';
                parts.forEach((part, i) => {
                    accumulated += (i === 0) ? part + '\\' : part + '\\';
                    const clickPath = accumulated;
                    const isLast = i === parts.length - 1;
                    html += `<span style="color:${isLast ? '#c7d5e0' : '#66c0f4'}; cursor:pointer; font-size:13px; ${isLast ? 'font-weight:bold;' : ''}" data-action="browse" data-path="${clickPath.replace(/"/g, '&quot;')}">${escapeHtml(part)}</span>`;
                    if (!isLast) html += '<span style="color:#4a6278;">&#x203A;</span>';
                });
            }

            bc.innerHTML = html;
        }

        function renderFileBrowser(data) {
            // Clear selection on every new browse result
            selectedFiles = new Set();
            updateFileActionToolbar();

            const area = document.getElementById('file-browser-area');
            if (!data.approved) {
                area.innerHTML = '<div style="color:#ef5350; padding:20px; text-align:center;">Access denied by user</div>';
                return;
            }
            if (data.error) {
                area.innerHTML = '<div style="color:#ef5350; padding:20px; text-align:center;">' + escapeHtml(data.error) + '</div>';
                return;
            }

            updateBreadcrumb(data.path || '');

            const entries = data.entries || [];
            if (entries.length === 0) {
                area.innerHTML = '<div style="color:#8f98a0; padding:20px; text-align:center;">Empty directory</div>';
                return;
            }

            // Check if this is a drives listing
            const isDrives = entries.some(e => e.Type === 'drive' || e.type === 'drive');

            if (isDrives) {
                // Drives: no checkboxes, just grid
                let html = '<div style="display:grid; grid-template-columns:repeat(auto-fill, minmax(140px, 1fr)); gap:12px; padding:8px;">';
                entries.forEach(entry => {
                    const name = entry.Name || entry.name;
                    const size = entry.SizeBytes || entry.sizeBytes || 0;
                    const sizeGB = (size / (1024*1024*1024)).toFixed(1);
                    const driveLetter = name.replace('\\', '');
                    html += `<div class="drive-card" data-action="browse" data-path="${name.replace(/"/g, '&quot;')}"
                        style="background:#0e1621; border:1px solid #2a475e; border-radius:8px; padding:16px; cursor:pointer; text-align:center; transition:border-color 0.2s;">
                        <div style="font-size:32px; margin-bottom:8px;">&#x1F4BE;</div>
                        <div style="color:#c7d5e0; font-weight:bold; font-size:15px;">${escapeHtml(driveLetter)}</div>
                        <div style="color:#8f98a0; font-size:11px; margin-top:4px;">${sizeGB} GB</div>
                    </div>`;
                });
                html += '</div>';
                area.innerHTML = html;
                return;
            }

            // Render file/folder list with checkboxes
            let html = '<table style="width:100%; border-collapse:collapse; font-size:13px;">';
            html += '<thead><tr style="border-bottom:1px solid #2a475e; color:#8f98a0; font-size:11px; text-transform:uppercase;">';
            html += '<th style="padding:6px 8px; width:28px;"><input type="checkbox" class="file-row-cb" id="file-select-all" /></th>';
            html += '<th style="text-align:left; padding:6px 8px;">Name</th>';
            html += '<th style="text-align:right; padding:6px 8px; width:90px;">Size</th>';
            html += '<th style="text-align:right; padding:6px 8px; width:150px;">Modified</th>';
            html += '</tr></thead><tbody>';

            // Back navigation row — no checkbox
            if (data.path) {
                const parentPath = data.path.replace(/\\[^\\]+\\?$/, '');
                const backTarget = (parentPath === data.path || parentPath.length <= 2) ? '' : parentPath;
                html += `<tr class="file-row" data-action="browse" data-path="${backTarget.replace(/"/g, '&quot;')}"
                    style="cursor:pointer; border-bottom:1px solid #1b2838;">
                    <td style="padding:8px;"></td>
                    <td style="padding:8px; color:#66c0f4;">&#x2B06;&#xFE0F; ..</td>
                    <td></td><td></td>
                </tr>`;
            }

            // Sort: dirs first, then files, alphabetical
            const sorted = [...entries].sort((a, b) => {
                const aType = a.Type || a.type;
                const bType = b.Type || b.type;
                if (aType === 'dir' && bType !== 'dir') return -1;
                if (aType !== 'dir' && bType === 'dir') return 1;
                return (a.Name || a.name).localeCompare(b.Name || b.name);
            });

            sorted.forEach(entry => {
                const name = entry.Name || entry.name;
                const type = entry.Type || entry.type;
                const size = entry.SizeBytes || entry.sizeBytes || 0;
                const modified = entry.LastModified || entry.lastModified || '';
                const isDir = type === 'dir';
                const icon = isDir ? '&#x1F4C1;' : getFileIcon(name);

                const fullPath = (data.path || '').replace(/\\$/, '') + '\\' + name;
                const escapedPath = fullPath.replace(/\\/g, '\\\\').replace(/'/g, "\\'");
                const cbId = 'cb-' + fullPath.replace(/[\\: ]/g, '_');

                const rowAction = isDir ? 'browse' : 'file-read';

                let sizeStr = '';
                if (!isDir) {
                    if (size > 1024*1024*1024) sizeStr = (size/(1024*1024*1024)).toFixed(1) + ' GB';
                    else if (size > 1024*1024) sizeStr = (size/(1024*1024)).toFixed(1) + ' MB';
                    else if (size > 1024) sizeStr = (size/1024).toFixed(1) + ' KB';
                    else sizeStr = size + ' B';
                }

                let modStr = '';
                if (modified) {
                    try { modStr = new Date(modified).toLocaleDateString(undefined, { year:'numeric', month:'short', day:'numeric', hour:'2-digit', minute:'2-digit' }); } catch(e) {}
                }

                html += `<tr class="file-row" data-action="${rowAction}" data-path="${fullPath.replace(/"/g, '&quot;')}"
                    style="cursor:pointer; border-bottom:1px solid #1b2838;">
                    <td class="file-cb-cell" style="padding:8px;">
                        <input type="checkbox" class="file-row-cb" id="${cbId}"
                            data-path="${fullPath.replace(/"/g, '&quot;')}" />
                    </td>
                    <td style="padding:8px; color:${isDir ? '#66c0f4' : '#c7d5e0'};">${icon} ${escapeHtml(name)}</td>
                    <td style="padding:8px; color:#8f98a0; text-align:right; font-size:12px;">${sizeStr}</td>
                    <td style="padding:8px; color:#8f98a0; text-align:right; font-size:12px;">${modStr}</td>
                </tr>`;
            });

            html += '</tbody></table>';
            area.innerHTML = html;
        }

        function toggleSelectAll(checked) {
            selectedFiles = new Set();
            document.querySelectorAll('#file-browser-area input[type=checkbox].file-row-cb[data-path]').forEach(cb => {
                cb.checked = checked;
                if (checked) selectedFiles.add(cb.dataset.path);
            });
            updateFileActionToolbar();
        }

        function onFileCheckboxChange(cb) {
            if (cb.checked) {
                selectedFiles.add(cb.dataset.path);
            } else {
                selectedFiles.delete(cb.dataset.path);
            }
            // Sync select-all checkbox
            const all = document.querySelectorAll('#file-browser-area input[type=checkbox].file-row-cb[data-path]');
            const selectAll = document.getElementById('file-select-all');
            if (selectAll) selectAll.checked = all.length > 0 && [...all].every(c => c.checked);
            updateFileActionToolbar();
        }

        function updateFileActionToolbar() {
            const toolbar = document.getElementById('file-action-toolbar');
            if (!toolbar) return;
            const count = selectedFiles.size;
            if (count > 0) {
                toolbar.style.display = 'flex';
                document.getElementById('file-selection-count').textContent = count + ' item' + (count !== 1 ? 's' : '') + ' selected';
            } else {
                toolbar.style.display = 'none';
            }
            // Enable paste only when clipboard has items and we're in a folder (not drives view)
            const pasteBtn = document.getElementById('file-paste-btn');
            if (pasteBtn) {
                pasteBtn.disabled = !(fileClipboard.operation && fileClipboard.paths.length > 0 && currentBrowsePath);
            }
        }

        function updatePasteBtn() {
            const pasteBtn = document.getElementById('file-paste-btn');
            if (pasteBtn) {
                pasteBtn.disabled = !(fileClipboard.operation && fileClipboard.paths.length > 0 && currentBrowsePath);
            }
        }

        // ---- File actions ----
        function fileActionCopy() {
            if (selectedFiles.size === 0) return;
            fileClipboard = { operation: 'copy', paths: [...selectedFiles], sourcePath: currentBrowsePath };
            updatePasteBtn();
            showFileBrowserMsg('Copied ' + selectedFiles.size + ' item(s) to clipboard');
        }

        function fileActionCut() {
            if (selectedFiles.size === 0) return;
            fileClipboard = { operation: 'move', paths: [...selectedFiles], sourcePath: currentBrowsePath };
            updatePasteBtn();
            showFileBrowserMsg('Cut ' + selectedFiles.size + ' item(s) to clipboard');
        }

        function fileActionPaste() {
            if (!fileClipboard.operation || fileClipboard.paths.length === 0 || !currentBrowsePath || !currentDeviceId || !socket) return;
            socket.emit('request_file_paste', {
                deviceId: currentDeviceId,
                operation: fileClipboard.operation,
                paths: fileClipboard.paths,
                destination: currentBrowsePath
            });
            showFileBrowserMsg('Paste operation sent...');
        }

        function fileActionDelete() {
            if (selectedFiles.size === 0 || !currentDeviceId || !socket) return;
            const count = selectedFiles.size;
            if (!confirm('Delete ' + count + ' item' + (count !== 1 ? 's' : '') + '? This cannot be undone.')) return;
            socket.emit('request_file_delete', {
                deviceId: currentDeviceId,
                paths: [...selectedFiles]
            });
            showFileBrowserMsg('Delete operation sent...');
        }

        function fileActionCopyPaths() {
            if (selectedFiles.size === 0) return;
            copyToClipboard([...selectedFiles].join('\n')).then(() => {
                showFileBrowserMsg('Paths copied to clipboard');
            }).catch(() => {
                alert([...selectedFiles].join('\n'));
            });
        }

        function fileActionProperties() {
            if (selectedFiles.size === 0 || !currentDeviceId || !socket) return;
            const path = [...selectedFiles][0];
            socket.emit('request_file_properties', { deviceId: currentDeviceId, path });
            showFileBrowserMsg('Loading properties...');
        }

        function fileActionUpload() {
            const input = document.getElementById('file-upload-input');
            if (input) input.click();
        }

        function onFileUploadSelected(event) {
            if (!currentDeviceId || !socket) return;
            const files = event.target.files;
            if (!files || files.length === 0) return;
            const MAX_SIZE = 50 * 1024 * 1024;
            for (const file of files) {
                if (file.size > MAX_SIZE) {
                    alert('File "' + file.name + '" is too large (max 50MB)');
                    continue;
                }
                const reader = new FileReader();
                reader.onload = (e) => {
                    const base64 = e.target.result.split(',')[1];
                    socket.emit('request_file_upload', {
                        deviceId: currentDeviceId,
                        destinationPath: currentBrowsePath,
                        filename: file.name,
                        data: base64,
                        size: file.size
                    });
                    showFileBrowserMsg('Uploading ' + file.name + '...');
                };
                reader.readAsDataURL(file);
            }
            event.target.value = '';
        }

        function fileActionDownload() {
            if (selectedFiles.size === 0 || !currentDeviceId || !socket) return;
            [...selectedFiles].forEach(path => {
                socket.emit('request_file_download', { deviceId: currentDeviceId, path });
            });
            showFileBrowserMsg('Download request sent for ' + selectedFiles.size + ' file(s)...');
        }

        function showFileBrowserMsg(msg) {
            const area = document.getElementById('file-browser-area');
            const existing = document.getElementById('fb-msg');
            if (existing) existing.remove();
            const el = document.createElement('div');
            el.id = 'fb-msg';
            el.style.cssText = 'color:#66c0f4; font-size:12px; padding:4px 8px; margin-bottom:6px; background:#0e1621; border-radius:4px;';
            el.textContent = msg;
            if (area && area.parentNode) area.parentNode.insertBefore(el, area);
            setTimeout(() => { el.remove(); }, 3000);
        }

        // ---- File operation result handlers ----
        function handleFileDeleteResult(data) {
            const failed = (data.results || []).filter(r => !r.ok);
            if (failed.length > 0) {
                alert('Delete failed for:\n' + failed.map(r => r.path + ': ' + r.error).join('\n'));
            } else {
                showFileBrowserMsg('Deleted successfully');
            }
            browseFiles(currentBrowsePath);
        }

        function handleFilePasteResult(data) {
            if (!data.success) {
                const failed = (data.results || []).filter(r => !r.ok);
                alert('Paste failed:\n' + (failed.length > 0 ? failed.map(r => r.path + ': ' + r.error).join('\n') : data.error || 'Unknown error'));
            } else {
                showFileBrowserMsg('Paste completed');
                if (fileClipboard.operation === 'move') {
                    fileClipboard = { operation: null, paths: [], sourcePath: '' };
                }
            }
            browseFiles(currentBrowsePath);
        }

        function handleFilePropertiesResult(data) {
            const panel = document.getElementById('file-properties-panel');
            const content = document.getElementById('file-properties-content');
            if (!panel || !content) return;
            if (!data.success) {
                content.textContent = 'Error: ' + (data.error || 'Unknown error');
                panel.style.display = '';
                return;
            }
            const props = data.properties || {};
            const rows = Object.entries(props).map(([k, v]) => {
                let display = v;
                if (k === 'size') display = formatFileSize(Number(v));
                else if (k === 'created' || k === 'modified' || k === 'accessed') {
                    try { display = new Date(v).toLocaleString(); } catch(e) {}
                }
                return `<div style="display:flex; gap:8px; padding:2px 0;"><span style="color:#8f98a0; min-width:120px;">${escapeHtml(k)}:</span><span>${escapeHtml(String(display))}</span></div>`;
            }).join('');
            content.innerHTML = rows || '<span style="color:#8f98a0;">No properties</span>';
            panel.style.display = '';
        }

        function handleFileDownloadResult(data) {
            if (!data.success) {
                alert('Download failed: ' + (data.error || 'Unknown error'));
                return;
            }
            try {
                const bytes = atob(data.data);
                const arr = new Uint8Array(bytes.length);
                for (let i = 0; i < bytes.length; i++) arr[i] = bytes.charCodeAt(i);
                const blob = new Blob([arr], { type: data.mimeType || 'application/octet-stream' });
                const url = URL.createObjectURL(blob);
                const a = document.createElement('a');
                a.href = url;
                a.download = data.filename || 'download';
                document.body.appendChild(a);
                a.click();
                document.body.removeChild(a);
                URL.revokeObjectURL(url);
            } catch (e) {
                alert('Download error: ' + e.message);
            }
        }

        function handleFileUploadResult(data) {
            if (!data.success) {
                alert('Upload failed: ' + (data.error || 'Unknown error'));
            } else {
                showFileBrowserMsg('Upload complete: ' + (data.path || ''));
                browseFiles(currentBrowsePath);
            }
        }

        function formatFileSize(bytes) {
            if (bytes > 1024*1024*1024) return (bytes/(1024*1024*1024)).toFixed(2) + ' GB';
            if (bytes > 1024*1024) return (bytes/(1024*1024)).toFixed(2) + ' MB';
            if (bytes > 1024) return (bytes/1024).toFixed(2) + ' KB';
            return bytes + ' B';
        }

        function getFileIcon(name) {
            const ext = (name.split('.').pop() || '').toLowerCase();
            const icons = {
                txt: '&#x1F4DD;', log: '&#x1F4DD;', md: '&#x1F4DD;', csv: '&#x1F4DD;',
                json: '&#x1F4CB;', xml: '&#x1F4CB;', yaml: '&#x1F4CB;', yml: '&#x1F4CB;', ini: '&#x1F4CB;', cfg: '&#x1F4CB;', conf: '&#x1F4CB;',
                js: '&#x1F4DC;', ts: '&#x1F4DC;', py: '&#x1F4DC;', cs: '&#x1F4DC;', java: '&#x1F4DC;', cpp: '&#x1F4DC;', c: '&#x1F4DC;', h: '&#x1F4DC;', css: '&#x1F4DC;', html: '&#x1F4DC;',
                jpg: '&#x1F5BC;&#xFE0F;', jpeg: '&#x1F5BC;&#xFE0F;', png: '&#x1F5BC;&#xFE0F;', gif: '&#x1F5BC;&#xFE0F;', bmp: '&#x1F5BC;&#xFE0F;', svg: '&#x1F5BC;&#xFE0F;', ico: '&#x1F5BC;&#xFE0F;', webp: '&#x1F5BC;&#xFE0F;',
                pdf: '&#x1F4D5;', doc: '&#x1F4D8;', docx: '&#x1F4D8;', xls: '&#x1F4D7;', xlsx: '&#x1F4D7;', ppt: '&#x1F4D9;', pptx: '&#x1F4D9;',
                zip: '&#x1F4E6;', rar: '&#x1F4E6;', '7z': '&#x1F4E6;', tar: '&#x1F4E6;', gz: '&#x1F4E6;',
                exe: '&#x2699;&#xFE0F;', dll: '&#x2699;&#xFE0F;', msi: '&#x2699;&#xFE0F;', bat: '&#x2699;&#xFE0F;', cmd: '&#x2699;&#xFE0F;', ps1: '&#x2699;&#xFE0F;',
                mp3: '&#x1F3B5;', wav: '&#x1F3B5;', flac: '&#x1F3B5;', ogg: '&#x1F3B5;',
                mp4: '&#x1F3AC;', avi: '&#x1F3AC;', mkv: '&#x1F3AC;', mov: '&#x1F3AC;',
                db: '&#x1F5C4;&#xFE0F;', sqlite: '&#x1F5C4;&#xFE0F;', sql: '&#x1F5C4;&#xFE0F;'
            };
            return icons[ext] || '&#x1F4C4;';
        }

        function navigateToPath(path) {
            browseFiles(path);
        }

        function requestFileRead(path) {
            if (!currentDeviceId || !socket) return;
            socket.emit('request_file_read', { deviceId: currentDeviceId, path });
        }

        function renderFileContent(data) {
            const area = document.getElementById('file-browser-area');
            if (!data.approved) {
                alert('File read denied by user');
                return;
            }
            if (data.error) {
                alert('Error: ' + data.error);
                return;
            }

            const filename = (data.path || '').split('\\').pop();
            const sizeKB = ((data.sizeBytes || 0) / 1024).toFixed(1);

            let html = '<div style="border:1px solid #2a475e; border-radius:8px; overflow:hidden;">';
            html += '<div style="display:flex; justify-content:space-between; align-items:center; padding:8px 12px; background:#0e1621; border-bottom:1px solid #2a475e;">';
            html += '<div style="color:#c7d5e0; font-size:13px;"><strong>' + escapeHtml(filename) + '</strong> <span style="color:#8f98a0;">(' + sizeKB + ' KB)</span></div>';
            html += '<button data-action="file-close" style="background:#2a475e; color:#c7d5e0; border:none; border-radius:4px; padding:4px 12px; cursor:pointer; font-size:12px;">&#x2715; Close</button>';
            html += '</div>';
            html += '<pre style="margin:0; padding:12px; background:#0a0f18; color:#c7d5e0; font-size:12px; font-family:Consolas,monospace; max-height:400px; overflow:auto; white-space:pre-wrap; word-break:break-all;">' + escapeHtml(data.content || '') + '</pre>';
            html += '</div>';
            area.innerHTML = html;
        }

        function copyFileContent() {
            const pre = document.getElementById('file-content-pre');
            if (pre) copyToClipboard(pre.textContent);
        }

        function formatFileSize(bytes) {
            if (!bytes) return '';
            if (bytes < 1024) return bytes + ' B';
            if (bytes < 1048576) return (bytes / 1024).toFixed(1) + ' KB';
            return (bytes / 1048576).toFixed(1) + ' MB';
        }

        // ---- Remote Scripts ----
        let scriptLibraryData = [];

        async function loadScriptLibrary() {
            try {
                const res = await fetchWithAuth(`${API}/api/scripts`);
                scriptLibraryData = await res.json();
                const sel = document.getElementById('script-library-select');
                sel.innerHTML = '<option value="">-- Select from library --</option>' +
                    [...scriptLibraryData].sort((a, b) => (a.name || '').localeCompare(b.name || '')).map(s => `<option value="${s.id}">${escapeHtml(s.name)} (${escapeHtml(s.category)})</option>`).join('');
            } catch (err) {
                console.error('Failed to load scripts:', err);
            }
        }

        function runLibraryScript() {
            if (!currentDeviceId || !socket) return;
            const sel = document.getElementById('script-library-select');
            const scriptId = parseInt(sel.value);
            if (!scriptId) { alert('Select a script from the library'); return; }
            showScriptRunning();
            socket.emit('execute_library_script', { deviceId: currentDeviceId, scriptId });
        }

        function runAdhocScript() {
            if (!currentDeviceId || !socket) return;
            const content = document.getElementById('adhoc-script').value.trim();
            if (!content) { alert('Enter a script to execute'); return; }
            const elevation = document.getElementById('adhoc-elevation').checked;
            const timeout = parseInt(document.getElementById('adhoc-timeout').value) || 60;
            showScriptRunning();
            socket.emit('execute_script', {
                deviceId: currentDeviceId,
                scriptName: 'Ad-hoc Script',
                scriptContent: content,
                requiresElevation: elevation,
                timeoutSeconds: timeout
            });
        }

        function showScriptRunning() {
            document.getElementById('script-output-area').innerHTML = '<div style="font-size:13px; color:#8f98a0; margin-top:8px;"><span class="script-spinner"></span>Waiting for user approval and execution...</div>';
        }

        function renderScriptResult(data) {
            const area = document.getElementById('script-output-area');
            let statusBadge = data.success
                ? '<span style="color:#66bb6a;">Success</span>'
                : '<span style="color:#ef5350;">Failed</span>';
            if (data.timedOut) statusBadge = '<span style="color:#ffa726;">Timed Out</span>';
            if (data.validationError) statusBadge = '<span style="color:#ef5350;">Blocked</span>';

            let html = `<div class="script-output">
                <div class="meta">
                    Status: ${statusBadge} | Exit Code: ${data.exitCode ?? '—'} | Duration: ${data.durationMs ?? 0}ms
                    ${data.truncated ? ' | <span style="color:#ffa726;">Output truncated</span>' : ''}
                </div>`;

            if (data.validationError) {
                html += `<pre class="stderr">${escapeHtml(data.validationError)}</pre>`;
            } else {
                if (data.output) html += `<pre class="stdout">${escapeHtml(data.output)}</pre>`;
                if (data.errorOutput) html += `<pre class="stderr">${escapeHtml(data.errorOutput)}</pre>`;
                if (!data.output && !data.errorOutput) html += `<pre class="stdout">(no output)</pre>`;
            }

            html += '</div>';
            area.innerHTML = html;
        }

        // ---- Auto-Remediation Policies ----
        async function loadPolicies() {
            try {
                const res = await fetchWithAuth(`${API}/api/alerts/policies`);
                const policies = await res.json();
                const tbody = document.getElementById('policy-tbody');
                if (policies.length === 0) {
                    tbody.innerHTML = '<tr><td colspan="7" style="color:#8f98a0; text-align:center;">No auto-remediation policies configured.</td></tr>';
                    return;
                }
                tbody.innerHTML = policies.map(p => `
                    <tr>
                        <td>${escapeHtml(p.check_type)} ${escapeHtml(p.operator)}${p.threshold_value} (${p.severity})</td>
                        <td>${escapeHtml(p.action_id)}</td>
                        <td>${p.parameter ? escapeHtml(p.parameter) : '<span style="color:#8f98a0">—</span>'}</td>
                        <td>${p.cooldown_minutes}min</td>
                        <td>${p.require_consent ? 'Yes' : '<span style="color:#ffa726">No</span>'}</td>
                        <td>
                            <button class="toggle-btn ${p.enabled ? 'active' : ''}"
                                data-action="policy-toggle" data-id="${p.id}" data-enabled="${p.enabled ? 0 : 1}">
                                ${p.enabled ? 'ON' : 'OFF'}
                            </button>
                        </td>
                        <td><button class="toggle-btn" data-action="policy-delete" data-id="${p.id}">Delete</button></td>
                    </tr>
                `).join('');
            } catch (err) {
                console.error('Failed to load policies:', err);
            }
        }

        function showAddPolicyForm() {
            document.getElementById('add-policy-form').style.display = 'block';
            // Populate threshold dropdown
            fetchWithAuth(`${API}/api/alerts/thresholds`).then(r => r.json()).then(thresholds => {
                const sel = document.getElementById('policy-threshold');
                sel.innerHTML = [...thresholds].sort((a, b) => (a.check_type || '').localeCompare(b.check_type || '')).map(t =>
                    `<option value="${t.id}">${escapeHtml(t.check_type)} ${escapeHtml(t.operator)} ${t.threshold_value} (${t.severity})</option>`
                ).join('');
            });
        }

        function hideAddPolicyForm() {
            document.getElementById('add-policy-form').style.display = 'none';
        }

        async function addPolicy() {
            const threshold_id = parseInt(document.getElementById('policy-threshold').value);
            const action_id = document.getElementById('policy-action').value;
            const parameter = document.getElementById('policy-parameter').value.trim() || null;
            const cooldown_minutes = parseInt(document.getElementById('policy-cooldown').value) || 30;
            const require_consent = document.getElementById('policy-consent').checked ? 1 : 0;
            try {
                await fetchWithAuth(`${API}/api/alerts/policies`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ threshold_id, action_id, parameter, cooldown_minutes, require_consent })
                });
                hideAddPolicyForm();
                loadPolicies();
            } catch (err) {
                console.error('Failed to add policy:', err);
            }
        }

        async function togglePolicy(id, enabled) {
            try {
                await fetchWithAuth(`${API}/api/alerts/policies/${id}`, {
                    method: 'PATCH',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ enabled })
                });
                loadPolicies();
            } catch (err) {
                console.error('Failed to toggle policy:', err);
            }
        }

        async function deletePolicy(id) {
            if (!confirm('Delete this policy?')) return;
            try {
                await fetchWithAuth(`${API}/api/alerts/policies/${id}`, { method: 'DELETE' });
                loadPolicies();
            } catch (err) {
                console.error('Failed to delete policy:', err);
            }
        }

        // ---- Init ----
        async function init() {
            try {
                // Auto-login on localhost — skip the login screen
                if (location.hostname === 'localhost' || location.hostname === '127.0.0.1') {
                    const autoRes = await fetch(`${API}/api/admin/auto-login`, { method: 'POST' });
                    if (autoRes.ok) {
                        const data = await autoRes.json();
                        authToken = data.token;
                        sessionStorage.setItem('pocket_it_token', authToken);
                        setupClientData(data);
                        hideLogin();
                        initSocket();
                        setupDesktopInput();
                        await loadUserPreferences();
                        if (!restoreFromHash()) {
                            showPage(userPreferences.defaultPage || 'fleet');
                            history.replaceState({ page: userPreferences.defaultPage || 'fleet' }, '', '#' + (userPreferences.defaultPage || 'fleet'));
                        }
                        return;
                    }
                }
                // Normal auth check (remote or auto-login failed)
                if (!authToken) {
                    showLogin();
                    return;
                }
                const res = await fetchWithAuth(`${API}/api/admin/stats`);
                if (res.ok) {
                    // Fetch user profile + clients to populate session data
                    const [profileRes, clientsRes] = await Promise.all([
                        fetchWithAuth(`${API}/api/admin/user/profile`),
                        fetchWithAuth(`${API}/api/clients`)
                    ]);
                    if (profileRes.ok) {
                        const user = await profileRes.json();
                        const clients = clientsRes.ok ? await clientsRes.json() : [];
                        setupClientData({ user, clients });
                    }
                    hideLogin();
                    initSocket();
                    setupDesktopInput();
                    await loadUserPreferences();
                    if (!restoreFromHash()) {
                        showPage(userPreferences.defaultPage || 'fleet');
                        history.replaceState({ page: userPreferences.defaultPage || 'fleet' }, '', '#' + (userPreferences.defaultPage || 'fleet'));
                    }
                } else {
                    showLogin();
                }
            } catch (err) {
                showLogin();
            }
        }
        init();

        // ========== REPORTS ==========
        let reportDays = 7;
        let chartInstances = {};

        function destroyChart(id) {
          if (chartInstances[id]) {
            chartInstances[id].destroy();
            delete chartInstances[id];
          }
        }

        const chartDefaults = {
          responsive: true,
          plugins: {
            legend: { labels: { color: '#c7d5e0' } }
          },
          scales: {
            x: { ticks: { color: '#8f98a0' }, grid: { color: 'rgba(102,192,244,0.1)' } },
            y: { ticks: { color: '#8f98a0' }, grid: { color: 'rgba(102,192,244,0.1)' } }
          }
        };

        document.querySelectorAll('.report-range-btn').forEach(btn => {
          btn.addEventListener('click', () => {
            document.querySelectorAll('.report-range-btn').forEach(b => b.classList.remove('active'));
            btn.classList.add('active');
            reportDays = parseInt(btn.dataset.days);
            loadReports();
          });
        });

        async function loadReports() {
          await Promise.all([
            loadFleetHealthChart(),
            loadAlertSummaryReport(),
            loadTicketSummaryReport(),
            loadDeviceList(),
            loadSchedules(),
            loadReportHistory()
          ]);
        }

        async function loadFleetHealthChart() {
          try {
            const res = await fetchWithAuth(`${API}/api/reports/fleet/health-trend?days=${reportDays}`);
            const data = await res.json();
            destroyChart('fleet-health');
            const ctx = document.getElementById('chart-fleet-health').getContext('2d');
            chartInstances['fleet-health'] = new Chart(ctx, {
              type: 'line',
              data: {
                labels: data.map(d => d.day),
                datasets: [{
                  label: 'Avg Health Score',
                  data: data.map(d => Math.round(d.avg_score * 10) / 10),
                  borderColor: '#66c0f4',
                  backgroundColor: 'rgba(102,192,244,0.1)',
                  fill: true,
                  tension: 0.3
                }]
              },
              options: {
                ...chartDefaults,
                scales: {
                  ...chartDefaults.scales,
                  y: { ...chartDefaults.scales.y, min: 0, max: 100, title: { display: true, text: 'Health Score', color: '#8f98a0' } }
                }
              }
            });
          } catch (err) { console.error('Fleet health chart error:', err); }
        }

        async function loadAlertSummaryReport() {
          try {
            const res = await fetchWithAuth(`${API}/api/reports/alerts/summary?days=${reportDays}`);
            const data = await res.json();

            document.getElementById('stat-alert-total').textContent = data.total || 0;
            document.getElementById('stat-alert-active').textContent = data.active || 0;
            document.getElementById('stat-alert-resolved').textContent = data.resolved || 0;
            document.getElementById('stat-alert-mttr').textContent = data.mttr_hours != null ? data.mttr_hours : '-';

            // Alerts per day chart
            destroyChart('alerts-per-day');
            const ctx1 = document.getElementById('chart-alerts-per-day').getContext('2d');
            chartInstances['alerts-per-day'] = new Chart(ctx1, {
              type: 'bar',
              data: {
                labels: (data.per_day || []).map(d => d.day),
                datasets: [{
                  label: 'Alerts',
                  data: (data.per_day || []).map(d => d.count),
                  backgroundColor: '#ef5350'
                }]
              },
              options: { ...chartDefaults, plugins: { ...chartDefaults.plugins, title: { display: true, text: 'Alerts Per Day', color: '#c7d5e0' } } }
            });

            // Alerts by severity chart
            destroyChart('alerts-by-severity');
            const ctx2 = document.getElementById('chart-alerts-by-severity').getContext('2d');
            const severityColors = { critical: '#d50000', warning: '#ffa726', info: '#66c0f4' };
            chartInstances['alerts-by-severity'] = new Chart(ctx2, {
              type: 'doughnut',
              data: {
                labels: (data.by_severity || []).map(d => d.severity),
                datasets: [{
                  data: (data.by_severity || []).map(d => d.count),
                  backgroundColor: (data.by_severity || []).map(d => severityColors[d.severity] || '#8f98a0')
                }]
              },
              options: { responsive: true, plugins: { legend: { labels: { color: '#c7d5e0' } }, title: { display: true, text: 'By Severity', color: '#c7d5e0' } } }
            });
          } catch (err) { console.error('Alert summary error:', err); }
        }

        async function loadTicketSummaryReport() {
          try {
            const res = await fetchWithAuth(`${API}/api/reports/tickets/summary?days=${reportDays}`);
            const data = await res.json();

            document.getElementById('stat-ticket-total').textContent = data.total || 0;
            document.getElementById('stat-ticket-open').textContent = data.open || 0;
            document.getElementById('stat-ticket-resolved').textContent = data.resolved || 0;
            document.getElementById('stat-ticket-avgres').textContent = data.avg_resolution_hours != null ? data.avg_resolution_hours : '-';

            destroyChart('tickets-per-day');
            const ctx = document.getElementById('chart-tickets-per-day').getContext('2d');
            chartInstances['tickets-per-day'] = new Chart(ctx, {
              type: 'bar',
              data: {
                labels: (data.per_day || []).map(d => d.day),
                datasets: [
                  { label: 'Opened', data: (data.per_day || []).map(d => d.opened), backgroundColor: '#ffa726' },
                  { label: 'Closed', data: (data.per_day || []).map(d => d.closed), backgroundColor: '#66bb6a' }
                ]
              },
              options: { ...chartDefaults, plugins: { ...chartDefaults.plugins, title: { display: true, text: 'Tickets Per Day', color: '#c7d5e0' } } }
            });
          } catch (err) { console.error('Ticket summary error:', err); }
        }

        async function loadDeviceList() {
          try {
            const res = await fetchWithAuth(`${API}/api/devices`);
            const devices = await res.json();
            const select = document.getElementById('report-device-select');
            const currentVal = select.value;
            select.innerHTML = '<option value="">Select a device...</option>' +
              [...devices].sort((a, b) => (a.hostname || a.device_id || '').localeCompare(b.hostname || b.device_id || '')).map(d => `<option value="${d.device_id}">${d.hostname || d.device_id}</option>`).join('');
            if (currentVal) select.value = currentVal;
          } catch (err) { console.error('Load devices for reports error:', err); }
        }

        async function loadDeviceMetrics() {
          const deviceId = document.getElementById('report-device-select').value;
          const checkType = document.getElementById('report-metric-select').value;
          const emptyEl = document.getElementById('device-metrics-empty');

          if (!deviceId) {
            emptyEl.style.display = 'block';
            return;
          }
          emptyEl.style.display = 'none';

          try {
            const res = await fetchWithAuth(`${API}/api/reports/device/${deviceId}/metrics?check_type=${checkType}&days=${reportDays}`);
            const data = await res.json();

            destroyChart('device-metrics');
            const ctx = document.getElementById('chart-device-metrics').getContext('2d');
            chartInstances['device-metrics'] = new Chart(ctx, {
              type: 'line',
              data: {
                labels: data.map(d => d.period),
                datasets: [
                  { label: 'Average', data: data.map(d => d.avg_value), borderColor: '#66c0f4', tension: 0.3 },
                  { label: 'Max', data: data.map(d => d.max_value), borderColor: '#ef5350', borderDash: [5, 5], tension: 0.3 },
                  { label: 'Min', data: data.map(d => d.min_value), borderColor: '#66bb6a', borderDash: [5, 5], tension: 0.3 }
                ]
              },
              options: {
                ...chartDefaults,
                scales: {
                  ...chartDefaults.scales,
                  y: { ...chartDefaults.scales.y, min: 0, max: 100, title: { display: true, text: checkType.toUpperCase() + ' %', color: '#8f98a0' } }
                }
              }
            });
          } catch (err) { console.error('Device metrics error:', err); }
        }

        function exportReport(format) {
          // Use current view's report type — default to fleet_health
          const url = `${API}/api/reports/export?type=fleet_health&days=${reportDays}&format=${format}`;
          window.open(url, '_blank');
        }

        async function loadSchedules() {
          try {
            const res = await fetchWithAuth(`${API}/api/reports/schedules`);
            const schedules = await res.json();
            const container = document.getElementById('schedules-list');
            if (!schedules.length) {
              container.innerHTML = '<div class="empty-state">No scheduled reports</div>';
              return;
            }
            container.innerHTML = schedules.map(s => `
              <div style="background:#1b2838; border:1px solid #2a475e; border-radius:8px; padding:14px 20px; margin-bottom:8px; display:flex; align-items:center; gap:16px;">
                <div style="flex:1;">
                  <div style="color:#c7d5e0; font-weight:600;">${s.name}</div>
                  <div style="color:#8f98a0; font-size:12px;">${s.report_type} &middot; ${s.schedule} &middot; ${s.format.toUpperCase()}</div>
                </div>
                <span style="color:${s.enabled ? '#66bb6a' : '#8f98a0'}; font-size:12px;">${s.enabled ? 'Active' : 'Disabled'}</span>
                <button class="diag-btn" data-action="schedule-toggle" data-id="${s.id}" data-enabled="${s.enabled ? 0 : 1}" style="font-size:12px;">${s.enabled ? 'Disable' : 'Enable'}</button>
                <button class="diag-btn" data-action="schedule-delete" data-id="${s.id}" style="font-size:12px; color:#ef5350;">Delete</button>
              </div>
            `).join('');
          } catch (err) { console.error('Load schedules error:', err); }
        }

        function showScheduleForm() { document.getElementById('schedule-form').style.display = 'block'; }
        function hideScheduleForm() { document.getElementById('schedule-form').style.display = 'none'; }

        async function saveSchedule() {
          try {
            const body = {
              name: document.getElementById('sched-name').value,
              report_type: document.getElementById('sched-type').value,
              schedule: document.getElementById('sched-cron').value,
              format: document.getElementById('sched-format').value,
              filters: { days: reportDays }
            };
            if (!body.name || !body.schedule) return alert('Name and cron schedule are required');
            await fetchWithAuth(`${API}/api/reports/schedules`, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify(body)
            });
            hideScheduleForm();
            loadSchedules();
          } catch (err) { console.error('Save schedule error:', err); }
        }

        async function toggleSchedule(id, enabled) {
          try {
            await fetchWithAuth(`${API}/api/reports/schedules/${id}`, {
              method: 'PATCH',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ enabled })
            });
            loadSchedules();
          } catch (err) { console.error('Toggle schedule error:', err); }
        }

        async function deleteSchedule(id) {
          if (!confirm('Delete this scheduled report?')) return;
          try {
            await fetchWithAuth(`${API}/api/reports/schedules/${id}`, { method: 'DELETE' });
            loadSchedules();
          } catch (err) { console.error('Delete schedule error:', err); }
        }

        async function loadReportHistory() {
          try {
            const res = await fetchWithAuth(`${API}/api/reports/history?limit=20`);
            const history = await res.json();
            const container = document.getElementById('report-history-list');
            if (!history.length) {
              container.innerHTML = '<div class="empty-state">No reports generated yet</div>';
              return;
            }
            container.innerHTML = history.map(h => `
              <div style="background:#1b2838; border:1px solid #2a475e; border-radius:8px; padding:12px 20px; margin-bottom:6px; display:flex; align-items:center; gap:16px;">
                <div style="flex:1;">
                  <span style="color:#c7d5e0;">${h.schedule_name || 'On-demand'}</span>
                  <span style="color:#8f98a0; font-size:12px; margin-left:8px;">${h.report_type} &middot; ${h.format.toUpperCase()}</span>
                </div>
                <span style="color:#8f98a0; font-size:12px;">${new Date(h.created_at).toLocaleString()}</span>
              </div>
            `).join('');
          } catch (err) { console.error('Load history error:', err); }
        }

        // ---- System Tools ----
        let procAutoRefreshTimer = null;
        let cachedProcessList = null;
        let procSortCol = 'cpuPercent';
        let procSortAsc = false;
        let cachedServiceList = null;
        let svcSortCol = 'displayName';
        let svcSortAsc = true;
        let cachedEventList = null;
        let evtSortCol = 'time';
        let evtSortAsc = false;

        function switchSysTab(tab) {
            document.querySelectorAll('.sys-tools-tab').forEach(t => t.classList.remove('active'));
            document.querySelectorAll('.sys-tools-panel').forEach(p => p.classList.remove('active'));
            document.querySelector(`.sys-tools-tab[data-tab="${tab}"]`).classList.add('active');
            document.getElementById('sys-panel-' + tab).classList.add('active');
            if (tab === 'processes' && !cachedProcessList) loadProcesses();
            if (tab === 'services' && !cachedServiceList) loadServices();
        }

        function loadProcesses() {
            if (!currentDeviceId || !socket) return;
            document.getElementById('proc-table-container').innerHTML = '<div style="color:#8f98a0; font-size:13px;">Loading processes...</div>';
            const requestId = 'st-' + Date.now();
            socket.emit('system_tool_request', { deviceId: currentDeviceId, requestId, tool: 'process_list', params: {} });
        }

        function renderProcessList(data) {
            const container = document.getElementById('proc-table-container');
            if (!data.success) {
                container.innerHTML = `<div style="color:#ef5350; font-size:13px;">Error: ${escapeHtml(data.error || 'Unknown')}</div>`;
                return;
            }
            cachedProcessList = data.data.processes || [];
            document.getElementById('proc-count').textContent = cachedProcessList.length + ' processes';
            renderProcessTable();
        }

        function sortProcesses(col) {
            if (procSortCol === col) { procSortAsc = !procSortAsc; }
            else { procSortCol = col; procSortAsc = col === 'name' || col === 'user'; }
            renderProcessTable();
        }

        function renderProcessTable() {
            const procs = [...cachedProcessList];
            procs.sort((a, b) => {
                let va = a[procSortCol] ?? '', vb = b[procSortCol] ?? '';
                if (typeof va === 'string') { va = va.toLowerCase(); vb = (vb || '').toLowerCase(); }
                if (va < vb) return procSortAsc ? -1 : 1;
                if (va > vb) return procSortAsc ? 1 : -1;
                return 0;
            });
            const arrow = col => procSortCol === col ? (procSortAsc ? ' ▲' : ' ▼') : '';
            const container = document.getElementById('proc-table-container');
            let html = `<table class="sys-table"><thead><tr>
                <th data-action="sort-proc" data-col="name">Name${arrow('name')}</th>
                <th data-action="sort-proc" data-col="pid">PID${arrow('pid')}</th>
                <th data-action="sort-proc" data-col="cpuPercent">CPU%${arrow('cpuPercent')}</th>
                <th data-action="sort-proc" data-col="memoryMB">Memory${arrow('memoryMB')}</th>
                <th data-action="sort-proc" data-col="user">User${arrow('user')}</th>
                <th></th>
            </tr></thead><tbody>`;
            procs.forEach(p => {
                const cpuClass = p.cpuPercent > 50 ? 'cpu-high' : p.cpuPercent > 20 ? 'cpu-med' : '';
                html += `<tr>
                    <td>${escapeHtml(p.name)}</td>
                    <td style="font-family:monospace; font-size:12px;">${p.pid}</td>
                    <td class="${cpuClass}">${p.cpuPercent}%</td>
                    <td>${p.memoryMB} MB</td>
                    <td style="font-size:12px; color:#8f98a0;">${escapeHtml(p.user || '')}</td>
                    <td><button class="svc-btn danger" data-action="kill-proc" data-pid="${p.pid}" data-name="${escapeHtml(p.name)}">Kill</button></td>
                </tr>`;
            });
            html += '</tbody></table>';
            container.innerHTML = html;
        }

        function killProcess(pid, name) {
            if (!confirm(`Kill process ${name} (PID ${pid})?`)) return;
            const requestId = 'st-' + Date.now();
            socket.emit('system_tool_request', { deviceId: currentDeviceId, requestId, tool: 'process_kill', params: { pid } });
        }

        function toggleProcAutoRefresh() {
            if (document.getElementById('proc-auto-refresh').checked) {
                loadProcesses();
                procAutoRefreshTimer = setInterval(loadProcesses, 10000);
            } else {
                clearInterval(procAutoRefreshTimer);
                procAutoRefreshTimer = null;
            }
        }

        function loadServices() {
            if (!currentDeviceId || !socket) return;
            document.getElementById('svc-table-container').innerHTML = '<div style="color:#8f98a0; font-size:13px;">Loading services...</div>';
            const filter = document.getElementById('svc-filter').value;
            const requestId = 'st-' + Date.now();
            socket.emit('system_tool_request', { deviceId: currentDeviceId, requestId, tool: 'service_list', params: { filter: filter || undefined } });
        }

        function renderServiceList(data) {
            const container = document.getElementById('svc-table-container');
            if (!data.success) {
                container.innerHTML = `<div style="color:#ef5350; font-size:13px;">Error: ${escapeHtml(data.error || 'Unknown')}</div>`;
                return;
            }
            cachedServiceList = data.data.services || [];
            document.getElementById('svc-count').textContent = cachedServiceList.length + ' services';
            renderServiceTable(cachedServiceList);
        }

        function sortServices(col) {
            if (svcSortCol === col) { svcSortAsc = !svcSortAsc; }
            else { svcSortCol = col; svcSortAsc = col === 'displayName' || col === 'name'; }
            if (cachedServiceList) renderServiceTable(cachedServiceList);
        }

        function renderServiceTable(services) {
            const search = (document.getElementById('svc-search').value || '').toLowerCase();
            const filtered = search ? services.filter(s => s.displayName.toLowerCase().includes(search) || s.name.toLowerCase().includes(search)) : services;
            filtered.sort((a, b) => {
                let va = a[svcSortCol] ?? '', vb = b[svcSortCol] ?? '';
                if (typeof va === 'string') { va = va.toLowerCase(); vb = (vb || '').toLowerCase(); }
                if (va < vb) return svcSortAsc ? -1 : 1;
                if (va > vb) return svcSortAsc ? 1 : -1;
                return 0;
            });
            const arrow = col => svcSortCol === col ? (svcSortAsc ? ' ▲' : ' ▼') : '';
            const container = document.getElementById('svc-table-container');
            let html = `<table class="sys-table"><thead><tr>
                <th data-action="sort-svc" data-col="displayName">Display Name${arrow('displayName')}</th>
                <th data-action="sort-svc" data-col="name">Name${arrow('name')}</th>
                <th data-action="sort-svc" data-col="status">Status${arrow('status')}</th>
                <th data-action="sort-svc" data-col="startType">Start Type${arrow('startType')}</th>
                <th>Actions</th>
            </tr></thead><tbody>`;
            filtered.forEach(s => {
                const isRunning = s.status === 'Running';
                const isStopped = s.status === 'Stopped';
                const statusColor = isRunning ? '#66bb6a' : isStopped ? '#ef5350' : '#ffa726';
                html += `<tr>
                    <td>${escapeHtml(s.displayName)}</td>
                    <td style="font-size:12px; font-family:monospace; color:#8f98a0;">${escapeHtml(s.name)}</td>
                    <td style="color:${statusColor};">${s.status}</td>
                    <td style="font-size:12px; color:#8f98a0;">${s.startType}</td>
                    <td>
                        <button class="svc-btn" data-action="svc-action" data-svc="${escapeHtml(s.name)}" data-svc-action="start" ${isRunning ? 'disabled' : ''}>Start</button>
                        <button class="svc-btn danger" data-action="svc-action" data-svc="${escapeHtml(s.name)}" data-svc-action="stop" ${isStopped ? 'disabled' : ''}>Stop</button>
                        <button class="svc-btn" data-action="svc-action" data-svc="${escapeHtml(s.name)}" data-svc-action="restart" ${isStopped ? 'disabled' : ''}>Restart</button>
                    </td>
                </tr>`;
            });
            html += '</tbody></table>';
            container.innerHTML = html;
        }

        function filterServicesLocal() {
            if (cachedServiceList) renderServiceTable(cachedServiceList);
        }

        function serviceAction(serviceName, action) {
            if (!confirm(`${action.charAt(0).toUpperCase() + action.slice(1)} service "${serviceName}"?`)) return;
            const requestId = 'st-' + Date.now();
            socket.emit('system_tool_request', { deviceId: currentDeviceId, requestId, tool: 'service_action', params: { serviceName, action } });
            document.getElementById('svc-table-container').innerHTML = '<div style="color:#8f98a0; font-size:13px;">Performing action...</div>';
        }

        function loadEventLog() {
            if (!currentDeviceId || !socket) return;
            document.getElementById('evt-table-container').innerHTML = '<div style="color:#8f98a0; font-size:13px;">Querying event log...</div>';
            const requestId = 'st-' + Date.now();
            socket.emit('system_tool_request', {
                deviceId: currentDeviceId, requestId, tool: 'event_log_query',
                params: {
                    logName: document.getElementById('evt-log-name').value,
                    level: document.getElementById('evt-level').value,
                    hours: parseInt(document.getElementById('evt-hours').value),
                    maxEvents: 200
                }
            });
        }

        function presetEventLog(level, hours, logName) {
            document.getElementById('evt-log-name').value = logName;
            document.getElementById('evt-level').value = level;
            document.getElementById('evt-hours').value = hours;
            loadEventLog();
        }

        function renderEventLog(data) {
            const container = document.getElementById('evt-table-container');
            if (!data.success) {
                container.innerHTML = `<div style="color:#ef5350; font-size:13px;">Error: ${escapeHtml(data.error || 'Unknown')}</div>`;
                return;
            }
            cachedEventList = data.data.events || [];
            document.getElementById('evt-count').textContent = cachedEventList.length + ' events';
            renderEventTable();
        }

        function sortEvents(col) {
            if (evtSortCol === col) { evtSortAsc = !evtSortAsc; }
            else { evtSortCol = col; evtSortAsc = col === 'source'; }
            renderEventTable();
        }

        function filterEventsLocal() {
            renderEventTable();
        }

        function renderEventTable() {
            if (!cachedEventList) return;
            const search = (document.getElementById('evt-search')?.value || '').trim();
            let events = cachedEventList;
            if (search) {
                const lower = search.toLowerCase();
                events = events.filter(e =>
                    String(e.eventId).includes(search) ||
                    (e.source || '').toLowerCase().includes(lower) ||
                    (e.message || '').toLowerCase().includes(lower)
                );
            }
            if (events.length === 0) {
                document.getElementById('evt-table-container').innerHTML = '<div style="color:#8f98a0; font-size:13px;">No events found matching filters</div>';
                return;
            }
            const sorted = [...events].sort((a, b) => {
                let va = a[evtSortCol] ?? '', vb = b[evtSortCol] ?? '';
                if (typeof va === 'string') { va = va.toLowerCase(); vb = (vb || '').toLowerCase(); }
                if (va < vb) return evtSortAsc ? -1 : 1;
                if (va > vb) return evtSortAsc ? 1 : -1;
                return 0;
            });
            const arrow = col => evtSortCol === col ? (evtSortAsc ? ' ▲' : ' ▼') : '';
            const container = document.getElementById('evt-table-container');
            let html = `<table class="sys-table"><thead><tr>
                <th data-action="sort-evt" data-col="time">Time${arrow('time')}</th>
                <th data-action="sort-evt" data-col="level">Level${arrow('level')}</th>
                <th data-action="sort-evt" data-col="source">Source${arrow('source')}</th>
                <th data-action="sort-evt" data-col="eventId">Event ID${arrow('eventId')}</th>
                <th>Message</th>
            </tr></thead><tbody>`;
            sorted.forEach(e => {
                const lvlClass = e.level === 'Error' ? 'evt-level-error' : e.level === 'Warning' ? 'evt-level-warning' : 'evt-level-information';
                const time = new Date(e.time).toLocaleString();
                const msg = (e.message || '').substring(0, 150);
                html += `<tr>
                    <td style="white-space:nowrap; font-size:12px;">${time}</td>
                    <td class="${lvlClass}">${e.level}</td>
                    <td style="font-size:12px;">${escapeHtml(e.source)}</td>
                    <td style="font-family:monospace; font-size:12px;">${e.eventId}</td>
                    <td style="font-size:12px; max-width:300px; overflow:hidden; text-overflow:ellipsis; white-space:nowrap;" title="${escapeHtml(e.message || '')}">${escapeHtml(msg)}</td>
                </tr>`;
            });
            html += '</tbody></table>';
            container.innerHTML = html;
        }

        // ========== CLIENT MULTI-TENANCY ==========

        function setupClientData(data) {
            currentClients = data.clients || [];
            currentUserRole = data.user?.role || null;
            currentUser = data.user || null;
            // Update user avatar
            const avatarEl = document.getElementById('nav-user-avatar');
            if (avatarEl && currentUser) {
                const name = currentUser.display_name || currentUser.username || '';
                const parts = name.trim().split(/\s+/);
                const initials = parts.length >= 2
                    ? (parts[0][0] + parts[parts.length - 1][0]).toUpperCase()
                    : name.substring(0, 2).toUpperCase();
                avatarEl.textContent = initials;
                avatarEl.title = name;
                avatarEl.style.display = '';
            }

            // Populate client selector in nav
            const sel = document.getElementById('client-selector');
            sel.innerHTML = '<option value="">All Clients</option>';
            [...currentClients].sort((a, b) => (a.name || '').localeCompare(b.name || '')).forEach(c => {
                sel.innerHTML += `<option value="${c.id}">${escapeHtml(c.name)}</option>`;
            });

            // Show selector if there are clients
            if (currentClients.length > 0) {
                sel.style.display = '';
            }

            // Restore selection from session
            const saved = sessionStorage.getItem('pocket_it_selected_client');
            if (saved && currentClients.find(c => String(c.id) === saved)) {
                sel.value = saved;
                selectedClientId = parseInt(saved);
            }

            // For non-admin with single client, auto-select and hide "All" option
            if (currentUserRole !== 'admin' && currentUserRole !== 'superadmin' && currentClients.length === 1) {
                sel.value = String(currentClients[0].id);
                selectedClientId = currentClients[0].id;
                sel.querySelector('option[value=""]').style.display = 'none';
            }

            // Show Admin dropdown (Updates, Settings, Wishlist, Clients)
            if (currentUserRole === 'admin' || currentUserRole === 'superadmin') {
                document.getElementById('nav-admin-dropdown').style.display = '';
            }

            // Show fleet installer button if a client is selected
            updateFleetInstallerBtn();
        }

        function updateFleetInstallerBtn() {
            const btn = document.getElementById('fleet-installer-btn');
            if (!btn) return;
            if (selectedClientId) {
                const client = currentClients.find(c => c.id === selectedClientId);
                btn.textContent = 'Download Installer for ' + (client ? client.name : 'Client');
                btn.style.display = '';
            } else {
                btn.style.display = 'none';
            }
        }

        async function loadUserPreferences() {
            try {
                const res = await fetchWithAuth(`${API}/api/admin/user/preferences`);
                if (res.ok) {
                    userPreferences = await res.json();
                    sessionStorage.setItem('pocket_it_prefs', JSON.stringify(userPreferences));
                }
            } catch (e) {
                // Fall back to cached
                try { userPreferences = JSON.parse(sessionStorage.getItem('pocket_it_prefs') || '{}'); } catch(e2) {}
            }
            applyPreferences();
        }

        function applyPreferences() {
            // Theme
            document.documentElement.dataset.theme = userPreferences.theme || 'dark';
            // Items per page & date format stored as globals for table rendering
            window.pocketItemsPerPage = parseInt(userPreferences.itemsPerPage) || 25;
            window.pocketDateFormat = userPreferences.dateFormat || 'MM/DD/YYYY';
        }

        function onClientChange() {
            const sel = document.getElementById('client-selector');
            const val = sel.value;
            selectedClientId = val ? parseInt(val) : null;
            sessionStorage.setItem('pocket_it_selected_client', val);
            // Show/hide fleet installer button
            updateFleetInstallerBtn();
            // Reload current page data
            const activePage = document.querySelector('.nav-link.active');
            if (activePage) {
                const page = activePage.dataset.page;
                if (page === 'fleet') loadFleet();
                else if (page === 'tickets') loadTickets();
                else if (page === 'alerts') loadAlerts();
                else if (page === 'reports') loadReports();
            }
        }

        // ---- Client Management (admin) ----
        async function loadClients() {
            try {
                const res = await fetchWithAuth(`${API}/api/clients`);
                const clients = await res.json();
                const tbody = document.getElementById('client-table-body');

                // Get device counts
                const devRes = await fetchWithAuth(`${API}/api/devices`);
                const devices = await devRes.json();
                const counts = {};
                devices.forEach(d => { counts[d.client_id] = (counts[d.client_id] || 0) + 1; });

                tbody.innerHTML = clients.map(c => `
                    <tr>
                        <td><strong>${escapeHtml(c.name)}</strong><br><span style="font-size:11px;color:#8f98a0;">${escapeHtml(c.slug)}</span></td>
                        <td>${counts[c.id] || 0}</td>
                        <td>${escapeHtml(c.contact_name || '')}${c.contact_email ? '<br><span style="font-size:11px;color:#8f98a0;">' + escapeHtml(c.contact_email) + '</span>' : ''}</td>
                        <td style="font-size:12px;color:#8f98a0;">${c.created_at ? new Date(c.created_at).toLocaleDateString() : ''}</td>
                        <td>
                            <button class="diag-btn" data-action="client-detail" data-id="${c.id}" data-name="${escapeHtml(c.name)}" style="font-size:11px;padding:4px 8px;">Details</button>
                            <button class="diag-btn" data-action="client-devices" data-id="${c.id}" style="font-size:11px;padding:4px 8px;">Devices</button>
                            <button class="diag-btn" data-action="client-users" data-id="${c.id}" data-name="${escapeHtml(c.name)}" style="font-size:11px;padding:4px 8px;margin-left:4px;">Users</button>
                            <button class="diag-btn" data-action="client-installer" data-id="${c.id}" style="font-size:11px;padding:4px 8px;margin-left:4px;">Installer</button>
                            ${c.slug !== 'default' ? `<button class="diag-btn" data-action="client-delete" data-id="${c.id}" style="font-size:11px;padding:4px 8px;margin-left:4px;background:#5c2020;">Delete</button>` : ''}
                        </td>
                    </tr>
                `).join('');
            } catch (err) {
                console.error('Failed to load clients:', err);
            }
        }

        async function createClient() {
            const name = document.getElementById('new-client-name').value.trim();
            if (!name) return alert('Client name is required');
            try {
                const res = await fetchWithAuth(`${API}/api/clients`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        name,
                        contact_name: document.getElementById('new-client-contact').value.trim() || undefined,
                        contact_email: document.getElementById('new-client-email').value.trim() || undefined,
                        notes: document.getElementById('new-client-notes').value.trim() || undefined
                    })
                });
                if (res.ok) {
                    document.getElementById('new-client-name').value = '';
                    document.getElementById('new-client-contact').value = '';
                    document.getElementById('new-client-email').value = '';
                    document.getElementById('new-client-notes').value = '';
                    loadClients();
                    // Refresh client selector
                    const clientsRes = await fetchWithAuth(`${API}/api/clients`);
                    const clients = await clientsRes.json();
                    currentClients = clients;
                    const sel = document.getElementById('client-selector');
                    sel.innerHTML = '<option value="">All Clients</option>' +
                        [...clients].sort((a, b) => (a.name || '').localeCompare(b.name || '')).map(c => `<option value="${c.id}">${escapeHtml(c.name)}</option>`).join('');
                    if (selectedClientId) sel.value = String(selectedClientId);
                } else {
                    const data = await res.json();
                    alert(data.error || 'Failed to create client');
                }
            } catch (err) {
                alert('Error: ' + err.message);
            }
        }

        function viewClientDevices(clientId) {
            // Set client filter and navigate to Fleet page
            const sel = document.getElementById('client-selector');
            if (sel) {
                sel.value = String(clientId);
                selectedClientId = clientId;
                sessionStorage.setItem('pocket_it_selected_client', String(clientId));
            }
            showPage('fleet');
            loadFleet();
        }

        async function deleteClient(id) {
            if (!confirm('Delete this client? All devices must be reassigned first.')) return;
            try {
                const res = await fetchWithAuth(`${API}/api/clients/${id}`, { method: 'DELETE' });
                if (res.ok) {
                    loadClients();
                } else {
                    const data = await res.json();
                    alert(data.error || 'Failed to delete client');
                }
            } catch (err) {
                alert('Error: ' + err.message);
            }
        }

        let managingClientId = null;
        async function manageClientUsers(clientId, clientName) {
            managingClientId = clientId;
            document.getElementById('client-users-title').textContent = clientName;
            document.getElementById('client-users-panel').style.display = '';

            // Load assigned users
            try {
                const res = await fetchWithAuth(`${API}/api/clients/${clientId}/users`);
                const users = await res.json();
                document.getElementById('client-users-list').innerHTML = users.length === 0
                    ? '<div style="color:#8f98a0;font-size:13px;">No technicians assigned.</div>'
                    : users.map(u => `
                        <div style="display:flex;align-items:center;justify-content:space-between;padding:6px 0;border-bottom:1px solid #2a475e;">
                            <span>${escapeHtml(u.display_name || u.username)} <span style="font-size:11px;color:#8f98a0;">(${u.role})</span></span>
                            <button class="diag-btn" data-action="unassign-user" data-client-id="${clientId}" data-user-id="${u.id}" style="font-size:11px;padding:2px 6px;background:#5c2020;">Remove</button>
                        </div>
                    `).join('');
            } catch (err) { console.error('Load users error:', err); }

            // Load all users for assignment dropdown
            try {
                const res = await fetchWithAuth(`${API}/api/admin/users`);
                const allUsers = await res.json();
                const sel = document.getElementById('assign-user-select');
                sel.innerHTML = [...allUsers].sort((a, b) => (a.display_name || a.username || '').localeCompare(b.display_name || b.username || '')).map(u =>
                    `<option value="${u.id}">${escapeHtml(u.display_name || u.username)} (${u.role})</option>`
                ).join('');
            } catch (err) { console.error('Load all users error:', err); }
        }

        async function assignUserToClient() {
            if (!managingClientId) return;
            const userId = document.getElementById('assign-user-select').value;
            if (!userId) return;
            try {
                const res = await fetchWithAuth(`${API}/api/clients/${managingClientId}/users`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ user_id: parseInt(userId) })
                });
                if (res.ok) {
                    manageClientUsers(managingClientId, document.getElementById('client-users-title').textContent);
                } else {
                    const data = await res.json();
                    alert(data.error || 'Failed to assign user');
                }
            } catch (err) { alert('Error: ' + err.message); }
        }

        async function unassignUser(clientId, userId) {
            try {
                const res = await fetchWithAuth(`${API}/api/clients/${clientId}/users/${userId}`, { method: 'DELETE' });
                if (res.ok) {
                    manageClientUsers(clientId, document.getElementById('client-users-title').textContent);
                }
            } catch (err) { console.error('Unassign error:', err); }
        }

        // === Client Detail Panel (Notes + Custom Fields) ===
        let activeClientDetailId = null;

        async function openClientDetail(clientId, clientName) {
            activeClientDetailId = clientId;
            document.getElementById('client-detail-title').textContent = clientName;
            document.getElementById('client-detail-panel').style.display = '';
            document.getElementById('client-field-add-form').style.display = 'none';
            await Promise.all([loadClientCustomFields(clientId), loadClientNotes(clientId)]);
            document.getElementById('client-detail-panel').scrollIntoView({ behavior: 'smooth' });
        }

        function closeClientDetail() {
            activeClientDetailId = null;
            document.getElementById('client-detail-panel').style.display = 'none';
        }

        async function loadClientCustomFields(clientId) {
            try {
                const res = await fetchWithAuth(`${API}/api/clients/${clientId}/custom-fields`);
                const fields = await res.json();
                const container = document.getElementById('client-custom-fields-list');
                if (fields.length === 0) {
                    container.innerHTML = '<div style="color:#8f98a0; font-size:13px;">No custom fields.</div>';
                    return;
                }
                container.innerHTML = fields.map(f => `
                    <div style="background:#0f1923; border:1px solid #3d5a2e; border-left:3px solid #3d5a2e; border-radius:6px; padding:10px;">
                        <div style="display:flex; justify-content:space-between; align-items:start;">
                            <div>
                                <div style="font-size:15px; font-weight:600; color:#c7d5e0;">${escapeHtml(f.field_value || '')}</div>
                                <div style="font-size:11px; color:#8f98a0; margin-top:2px;">${escapeHtml(f.field_name)}</div>
                                <div style="font-size:10px; color:#556b7a; margin-top:2px;">by ${escapeHtml(f.updated_by)} &middot; ${f.updated_at ? new Date(f.updated_at + 'Z').toLocaleString() : ''}</div>
                            </div>
                            <button class="diag-btn" data-action="delete-client-field" data-field="${escapeHtml(f.field_name)}" style="font-size:10px; padding:2px 6px; background:#5c2020; color:#ef5350;">&times;</button>
                        </div>
                    </div>
                `).join('');
            } catch (err) {
                console.error('Failed to load client custom fields:', err);
            }
        }

        async function saveClientCustomField() {
            if (!activeClientDetailId) return;
            const nameEl = document.getElementById('client-field-name');
            const valueEl = document.getElementById('client-field-value');
            const name = nameEl.value.trim();
            const value = valueEl.value.trim();
            if (!name) return showToast('Field name is required');
            try {
                const res = await fetchWithAuth(`${API}/api/clients/${activeClientDetailId}/custom-fields`, {
                    method: 'PUT',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ fields: { [name]: value } })
                });
                if (res.ok) {
                    nameEl.value = '';
                    valueEl.value = '';
                    document.getElementById('client-field-add-form').style.display = 'none';
                    await loadClientCustomFields(activeClientDetailId);
                    showToast('Field saved');
                } else {
                    const data = await res.json();
                    showToast(data.error || 'Failed to save field');
                }
            } catch (err) { showToast('Error: ' + err.message); }
        }

        async function deleteClientCustomField(fieldName) {
            if (!activeClientDetailId) return;
            try {
                const res = await fetchWithAuth(`${API}/api/clients/${activeClientDetailId}/custom-fields/${encodeURIComponent(fieldName)}`, { method: 'DELETE' });
                if (res.ok) {
                    await loadClientCustomFields(activeClientDetailId);
                    showToast('Field deleted');
                }
            } catch (err) { showToast('Error: ' + err.message); }
        }

        async function loadClientNotes(clientId) {
            try {
                const res = await fetchWithAuth(`${API}/api/clients/${clientId}/notes`);
                const notes = await res.json();
                document.getElementById('client-notes-count').textContent = notes.length > 0 ? `(${notes.length})` : '';
                const container = document.getElementById('client-notes-list');
                if (notes.length === 0) {
                    container.innerHTML = '<div style="color:#8f98a0; font-size:13px;">No notes yet.</div>';
                    return;
                }
                container.innerHTML = notes.map(n => `
                    <div style="background:#0f1923; border:1px solid #2a475e; border-radius:6px; padding:10px; margin-bottom:8px;">
                        <div style="display:flex; justify-content:space-between; align-items:start; margin-bottom:4px;">
                            <span style="font-size:12px; color:#66c0f4; font-weight:600;">${escapeHtml(n.author)}</span>
                            <div style="display:flex; align-items:center; gap:8px;">
                                <span style="font-size:11px; color:#556b7a;">${n.created_at ? new Date(n.created_at + 'Z').toLocaleString() : ''}</span>
                                <button class="diag-btn" data-action="delete-client-note" data-note-id="${n.id}" style="font-size:10px; padding:2px 6px; background:#5c2020; color:#ef5350;">&times;</button>
                            </div>
                        </div>
                        <div style="font-size:13px; color:#c7d5e0; white-space:pre-wrap;">${escapeHtml(n.content)}</div>
                    </div>
                `).join('');
            } catch (err) {
                console.error('Failed to load client notes:', err);
            }
        }

        async function addClientNote() {
            if (!activeClientDetailId) return;
            const input = document.getElementById('client-note-input');
            const content = input.value.trim();
            if (!content) return;
            try {
                const res = await fetchWithAuth(`${API}/api/clients/${activeClientDetailId}/notes`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ content })
                });
                if (res.ok) {
                    input.value = '';
                    await loadClientNotes(activeClientDetailId);
                    showToast('Note added');
                } else {
                    const data = await res.json();
                    showToast(data.error || 'Failed to add note');
                }
            } catch (err) { showToast('Error: ' + err.message); }
        }

        async function deleteClientNote(noteId) {
            if (!activeClientDetailId) return;
            try {
                const res = await fetchWithAuth(`${API}/api/clients/${activeClientDetailId}/notes/${noteId}`, { method: 'DELETE' });
                if (res.ok) {
                    await loadClientNotes(activeClientDetailId);
                    showToast('Note deleted');
                }
            } catch (err) { showToast('Error: ' + err.message); }
        }

        async function downloadInstaller(clientId, btn) {
            const origText = btn.textContent;
            btn.textContent = 'Downloading...';
            btn.disabled = true;
            btn.style.opacity = '0.6';

            try {
                const res = await fetchWithAuth(`${API}/api/clients/${clientId}/installer`);
                if (!res.ok) {
                    const data = await res.json();
                    alert(data.error || 'Failed to download installer');
                    return;
                }
                const blob = await res.blob();
                const filename = res.headers.get('Content-Disposition')?.match(/filename="(.+)"/)?.[1] || 'PocketIT-setup.zip';
                const url = URL.createObjectURL(blob);
                const a = document.createElement('a');
                a.href = url;
                a.download = filename;
                document.body.appendChild(a);
                a.click();
                document.body.removeChild(a);
                URL.revokeObjectURL(url);

                // Show instructions dialog
                showInstallerInstructions(filename);
            } catch (err) {
                alert('Download failed: ' + err.message);
            } finally {
                btn.textContent = origText;
                btn.disabled = false;
                btn.style.opacity = '';
            }
        }

        function showInstallerInstructions(filename) {
            const isExe = filename.toLowerCase().endsWith('.exe');
            const overlay = document.createElement('div');
            overlay.style.cssText = 'position:fixed;top:0;left:0;width:100%;height:100%;background:rgba(0,0,0,0.7);display:flex;align-items:center;justify-content:center;z-index:10000;';
            overlay.onclick = e => { if (e.target === overlay) overlay.remove(); };

            const exeSteps = `
                <ol style="margin:0 0 16px;padding-left:20px;line-height:1.8;font-size:13px;">
                    <li>Copy <code style="background:#0e1621;padding:2px 6px;border-radius:3px;">${escapeHtml(filename)}</code> to the target machine</li>
                    <li>Double-click to run — Windows will prompt for admin rights</li>
                    <li>The installer will download, install, and launch Pocket IT automatically</li>
                    <li>A system tray icon will appear once connected</li>
                </ol>
                <p style="margin:0 0 16px;font-size:12px;color:#8f98a0;">
                    <strong>Note:</strong> The target machine needs network access to this server.
                    The embedded enrollment token expires in 24 hours.
                </p>`;

            const zipSteps = `
                <ol style="margin:0 0 16px;padding-left:20px;line-height:1.8;font-size:13px;">
                    <li>Extract the ZIP to <code style="background:#0e1621;padding:2px 6px;border-radius:3px;">C:\\Program Files\\PocketIT</code></li>
                    <li>Run <code style="background:#0e1621;padding:2px 6px;border-radius:3px;">PocketIT.exe</code> <strong>as Administrator</strong></li>
                    <li>The client will auto-enroll with the pre-seeded token</li>
                    <li>A system tray icon will appear once connected</li>
                </ol>
                <p style="margin:0 0 16px;font-size:12px;color:#8f98a0;">
                    <strong>Note:</strong> The enrollment token expires in 24 hours. The ZIP includes a pre-configured
                    <code style="background:#0e1621;padding:2px 6px;border-radius:3px;">appsettings.json</code> with the server URL and token.
                </p>`;

            overlay.innerHTML = `
                <div style="background:#1b2838;border:1px solid #2a475e;border-radius:8px;padding:24px;max-width:520px;width:90%;color:#c7d5e0;">
                    <h3 style="margin:0 0 16px 0;color:#66c0f4;">${isExe ? 'Online Installer Ready' : 'Installer Downloaded'}</h3>
                    <p style="margin:0 0 8px;color:#8f98a0;font-size:13px;"><strong style="color:#c7d5e0;">${escapeHtml(filename)}</strong> has been saved to your Downloads folder.</p>
                    <h4 style="margin:16px 0 8px;color:#c7d5e0;">${isExe ? 'Deployment Steps:' : 'Installation Steps:'}</h4>
                    ${isExe ? exeSteps : zipSteps}
                    <div style="text-align:right;">
                        <button class="diag-btn" data-action="dismiss-overlay" style="padding:8px 20px;">Got it</button>
                    </div>
                </div>
            `;
            document.body.appendChild(overlay);
        }

        // ========== ACTIVITY HISTORY ==========
        let activityCurrentPage = 1;
        const ACTIVITY_LIMIT = 50;

        const ACTIVITY_ACTION_MAP = {
            'script_requested':          { label: 'Script Executed',         color: '#3b82f6' },
            'script_completed':          { label: 'Script Completed',        color: '#22c55e' }, // overridden by exitCode
            'terminal_session_started':  { label: 'Terminal Started',        color: '#3b82f6' },
            'terminal_session_ended':    { label: 'Terminal Ended',          color: '#6b7280' },
            'desktop_session_started':   { label: 'Desktop Started',         color: '#3b82f6' },
            'desktop_session_ended':     { label: 'Desktop Ended',           color: '#6b7280' },
            'file_browse_requested':     { label: 'File Browsed',            color: '#14b8a6' },
            'file_browse_completed':     { label: 'File Browsed',            color: '#14b8a6' },
            'file_read_requested':       { label: 'File Read',               color: '#14b8a6' },
            'file_read_completed':       { label: 'File Read',               color: '#14b8a6' },
            'diagnostic_requested':      { label: 'Diagnostic Requested',    color: '#eab308' },
            'diagnostic_completed':      { label: 'Diagnostic Completed',    color: '#22c55e' },
            'remediation_requested':     { label: 'Remediation Requested',   color: '#f97316' },
            'remediation_executed':      { label: 'Remediation Executed',    color: '#22c55e' }, // overridden by success
            'system_tool_requested':     { label: 'System Tool',             color: '#a855f7' },
            'system_tool_completed':     { label: 'System Tool',             color: '#a855f7' },
            'auto_remediation_triggered':{ label: 'Auto-Remediation',        color: '#f97316' },
            'terminal_denied':           { label: 'Access Denied',           color: '#ef4444' },
            'desktop_denied':            { label: 'Access Denied',           color: '#ef4444' },
            'ticket_created':            { label: 'Ticket Created',          color: '#3b82f6' },
            'ticket_updated':            { label: 'Ticket Updated',          color: '#6b7280' },
            'ticket_comment_added':      { label: 'Comment Added',           color: '#6b7280' },
            'alert_acknowledged':        { label: 'Alert Acknowledged',      color: '#eab308' },
            'alert_resolved':            { label: 'Alert Resolved',          color: '#22c55e' },
            'device_note_added':         { label: 'Note Added',              color: '#4caf50' },
            'device_note_deleted':       { label: 'Note Deleted',            color: '#6b7280' },
            'custom_fields_updated':     { label: 'Fields Updated',          color: '#4caf50' },
            'custom_field_deleted':      { label: 'Field Deleted',           color: '#6b7280' },
        };

        function formatActivityTimestamp(ts) {
            if (!ts) return '—';
            const d = new Date(ts);
            return d.toLocaleString('en-US', { month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit', hour12: true });
        }

        function formatActivityDetails(action, detailsJson) {
            let details = {};
            if (detailsJson) {
                try { details = typeof detailsJson === 'string' ? JSON.parse(detailsJson) : detailsJson; } catch (e) { return escapeHtml(String(detailsJson)); }
            }
            if (action === 'script_requested' || action === 'script_completed') {
                const parts = [];
                if (details.scriptName) parts.push(escapeHtml(details.scriptName));
                if (details.exitCode !== undefined && details.exitCode !== null) parts.push('exit ' + details.exitCode);
                if (details.durationMs) parts.push(details.durationMs + 'ms');
                return parts.join(' &middot; ') || '—';
            }
            if (action === 'file_browse_requested' || action === 'file_browse_completed' ||
                action === 'file_read_requested' || action === 'file_read_completed') {
                return details.path ? escapeHtml(details.path) : '—';
            }
            if (action === 'system_tool_requested' || action === 'system_tool_completed') {
                return details.tool ? escapeHtml(details.tool) : '—';
            }
            if (action === 'diagnostic_requested' || action === 'diagnostic_completed') {
                return details.checkType ? escapeHtml(details.checkType) : '—';
            }
            if (action === 'remediation_requested' || action === 'remediation_executed' || action === 'auto_remediation_triggered') {
                const parts = [];
                if (details.actionId || details.action) parts.push(escapeHtml(details.actionId || details.action));
                if (details.success !== undefined) parts.push(details.success ? 'success' : 'failed');
                return parts.join(' &middot; ') || '—';
            }
            if (action === 'ticket_created' || action === 'ticket_updated' || action === 'ticket_comment_added') {
                const parts = [];
                if (details.ticketId) parts.push('#' + details.ticketId);
                if (details.title) parts.push(escapeHtml(details.title));
                if (details.status) parts.push(escapeHtml(details.status));
                return parts.join(' &middot; ') || '—';
            }
            if (action === 'alert_acknowledged' || action === 'alert_resolved') {
                const parts = [];
                if (details.alertId) parts.push('#' + details.alertId);
                if (details.message) parts.push(escapeHtml(String(details.message).substring(0, 80)));
                return parts.join(' &middot; ') || '—';
            }
            // Default: render top-level keys as key=value
            const keys = Object.keys(details);
            if (keys.length === 0) return '—';
            return keys.slice(0, 4).map(k => `${escapeHtml(k)}=${escapeHtml(String(details[k]).substring(0, 40))}`).join(', ');
        }

        function getActivityBadgeColor(action, detailsJson) {
            const map = ACTIVITY_ACTION_MAP[action];
            if (!map) return '#6b7280';
            let color = map.color;
            // Override for exit-code-dependent actions
            if (action === 'script_completed') {
                let details = {};
                try { details = typeof detailsJson === 'string' ? JSON.parse(detailsJson) : (detailsJson || {}); } catch (e) {}
                color = (details.exitCode === 0 || details.exitCode === undefined) ? '#22c55e' : '#ef4444';
            }
            if (action === 'remediation_executed') {
                let details = {};
                try { details = typeof detailsJson === 'string' ? JSON.parse(detailsJson) : (detailsJson || {}); } catch (e) {}
                color = details.success !== false ? '#22c55e' : '#ef4444';
            }
            return color;
        }

        function renderActivityRow(activity) {
            const action = activity.action || '';
            const map = ACTIVITY_ACTION_MAP[action];
            const label = map ? map.label : escapeHtml(action);
            const color = getActivityBadgeColor(action, activity.details);
            const ts = formatActivityTimestamp(activity.created_at || activity.timestamp);
            const actor = escapeHtml(activity.actor || activity.performed_by || '—');
            const detailsHtml = formatActivityDetails(action, activity.details);

            return `<tr>
                <td class="activity-timestamp">${ts}</td>
                <td><span class="activity-badge" style="background:${color};">${label}</span></td>
                <td style="font-size:13px; color:#c7d5e0;">${actor}</td>
                <td class="activity-details">${detailsHtml}</td>
            </tr>`;
        }

        async function loadDeviceActivity(deviceId, page = 1, append = false) {
            if (!deviceId) return;
            const tbody = document.getElementById('activity-tbody');
            const loadMoreBtn = document.getElementById('activity-load-more');

            if (!append) {
                tbody.innerHTML = '<tr><td colspan="4" style="color:#8f98a0; text-align:center; padding:24px;">Loading...</td></tr>';
                loadMoreBtn.style.display = 'none';
            }

            try {
                const category = document.getElementById('activity-category-filter').value;
                const dateFrom = document.getElementById('activity-date-from').value;
                const dateTo = document.getElementById('activity-date-to').value;

                let url = `${API}/api/devices/${deviceId}/activity?page=${page}&limit=${ACTIVITY_LIMIT}`;
                if (category) url += `&actions=${encodeURIComponent(category)}`;
                if (dateFrom) url += `&from=${encodeURIComponent(dateFrom)}`;
                if (dateTo) url += `&to=${encodeURIComponent(dateTo)}`;

                const res = await fetchWithAuth(url);
                if (!res.ok) {
                    if (!append) tbody.innerHTML = '<tr><td colspan="4" style="color:#8f98a0; text-align:center; padding:24px;">Failed to load activity.</td></tr>';
                    return;
                }
                const data = await res.json();
                const activities = data.activities || data;

                if (!append) {
                    if (activities.length === 0) {
                        tbody.innerHTML = '<tr><td colspan="4" style="color:#8f98a0; text-align:center; padding:24px;">No activity found.</td></tr>';
                        loadMoreBtn.style.display = 'none';
                        return;
                    }
                    tbody.innerHTML = activities.map(a => renderActivityRow(a)).join('');
                } else {
                    if (activities.length === 0) {
                        loadMoreBtn.style.display = 'none';
                        return;
                    }
                    tbody.insertAdjacentHTML('beforeend', activities.map(a => renderActivityRow(a)).join(''));
                }

                activityCurrentPage = page;
                loadMoreBtn.style.display = (activities.length < ACTIVITY_LIMIT || activities.length === 0) ? 'none' : 'block';
            } catch (err) {
                console.error('Failed to load activity:', err);
                if (!append) tbody.innerHTML = '<tr><td colspan="4" style="color:#8f98a0; text-align:center; padding:24px;">Error loading activity.</td></tr>';
            }
        }

        function loadMoreActivity() {
            loadDeviceActivity(currentDeviceId, activityCurrentPage + 1, true);
        }

        function applyActivityFilter() {
            activityCurrentPage = 1;
            loadDeviceActivity(currentDeviceId, 1, false);
        }

        // Real-time: prepend new audit events for the current device
        // Hooked into socket setup after initSocket() is called (see initSocket addition below)

        // ---- Updates Management ----
        async function loadUpdates() {
            try {
                const [pkgRes, fleetRes] = await Promise.all([
                    fetchWithAuth(`${API}/api/updates`),
                    fetchWithAuth(`${API}/api/updates/fleet-versions`)
                ]);
                const packages = await pkgRes.json();
                const fleetVersions = await fleetRes.json();

                // Fleet version distribution
                const row = document.getElementById('fleet-versions-row');
                row.innerHTML = fleetVersions.map(v => `
                    <div class="stat-card">
                        <div class="value" style="font-size: 20px;">${v.count}</div>
                        <div class="label">${escapeHtml(v.version)}</div>
                    </div>
                `).join('') || '<div style="color:#8f98a0; padding:16px;">No version data yet.</div>';

                // Expected client version
                try {
                    const latestRes = await fetchWithAuth(`${API}/api/updates/latest`);
                    const latestData = await latestRes.json();
                    const expectedEl = document.getElementById('expected-version');
                    const statusEl = document.getElementById('fleet-update-status');

                    if (latestData.available && latestData.version) {
                        expectedEl.textContent = 'v' + latestData.version;
                        const latest = latestData.version;
                        let upToDate = 0, outdated = 0;
                        fleetVersions.forEach(v => {
                            if (v.version === latest) upToDate += v.count;
                            else outdated += v.count;
                        });
                        if (outdated === 0 && upToDate > 0) {
                            statusEl.innerHTML = `<span style="color:#66bb6a;">All ${upToDate} device(s) up to date</span>`;
                        } else if (outdated > 0) {
                            statusEl.innerHTML = `<span style="color:#66bb6a;">${upToDate} up to date</span> &middot; <span style="color:#ffa726;">${outdated} outdated</span>`;
                        } else {
                            statusEl.textContent = 'No devices reporting';
                        }
                    } else {
                        expectedEl.textContent = '\u2014';
                        statusEl.textContent = 'No update packages registered';
                    }
                } catch (latestErr) {
                    console.error('Failed to load latest version:', latestErr);
                }

                // Packages table
                const tbody = document.getElementById('updates-table-body');
                if (packages.length === 0) {
                    tbody.innerHTML = '<tr><td colspan="5" style="color:#8f98a0; text-align:center; padding:24px;">No update packages uploaded yet.</td></tr>';
                    return;
                }
                tbody.innerHTML = packages.map((p, i) => `
                    <tr>
                        <td><strong>v${escapeHtml(p.version)}</strong>${p.release_notes ? '<br><span style="font-size:11px;color:#8f98a0;">' + escapeHtml(p.release_notes).substring(0, 100) + '</span>' : ''}</td>
                        <td>${formatFileSize(p.file_size)}</td>
                        <td style="font-size:11px; font-family:monospace; color:#8f98a0;">${p.sha256.substring(0, 16)}...</td>
                        <td style="font-size:12px;color:#8f98a0;">${p.uploaded_by || ''}<br>${p.created_at ? new Date(p.created_at).toLocaleString() : ''}</td>
                        <td>
                            ${i === 0 ? `<button class="diag-btn" data-action="update-push" data-version="${escapeHtml(p.version)}" style="font-size:11px;padding:4px 8px;">Push to Fleet</button>` : ''}
                            <button class="diag-btn" data-action="update-delete" data-version="${escapeHtml(p.version)}" style="font-size:11px;padding:4px 8px;${i === 0 ? 'margin-left:4px;' : ''}background:#5c2020;">Delete</button>
                        </td>
                    </tr>
                `).join('');
            } catch (err) {
                console.error('Failed to load updates:', err);
            }
        }

        function formatFileSize(bytes) {
            if (bytes >= 1024 * 1024) return (bytes / (1024 * 1024)).toFixed(1) + ' MB';
            if (bytes >= 1024) return (bytes / 1024).toFixed(1) + ' KB';
            return bytes + ' B';
        }


        async function deleteUpdate(version) {
            if (!confirm(`Delete update package v${version}? This cannot be undone.`)) return;
            try {
                const res = await fetchWithAuth(`${API}/api/updates/${version}`, { method: 'DELETE' });
                if (res.ok) {
                    loadUpdates();
                } else {
                    const data = await res.json();
                    alert(data.error || 'Delete failed');
                }
            } catch (err) {
                alert('Delete error: ' + err.message);
            }
        }

        async function pushUpdateToFleet(version) {
            if (!confirm(`Push update v${version} notification to all outdated online devices?`)) return;
            try {
                const res = await fetchWithAuth(`${API}/api/updates/push/${version}`, { method: 'POST' });
                if (res.ok) {
                    const data = await res.json();
                    alert(`Update notification sent to ${data.notified} device(s).`);
                } else {
                    const data = await res.json();
                    alert(data.error || 'Push failed');
                }
            } catch (err) {
                alert('Push error: ' + err.message);
            }
        }

        // ---- Client Release Check (git) ----
        document.getElementById('btn-client-check').addEventListener('click', async () => {
            const btn = document.getElementById('btn-client-check');
            btn.disabled = true;
            btn.textContent = 'Checking...';
            try {
                const res = await fetchWithAuth(`${API}/api/updates/client-check`);
                const data = await res.json();
                if (data.updated) {
                    alert(`New client v${data.version} found! ${data.notified || 0} device(s) notified.`);
                    loadUpdates();
                } else {
                    alert(data.reason || 'No new client release found');
                }
            } catch (err) {
                alert('Check failed: ' + err.message);
            } finally {
                btn.disabled = false;
                btn.textContent = 'Check for Client Update';
            }
        });

        // ========== SETTINGS ==========

        // ---- Server Update ----
        let _lastUpdateCheck = null;

        async function checkServerUpdate() {
            const btn = document.getElementById('btn-check-update');
            btn.disabled = true;
            btn.textContent = 'Checking...';

            try {
                const res = await fetchWithAuth(`${API}/api/updates/server-check`);
                const data = await res.json();

                document.getElementById('srv-update-version').textContent = data.serverVersion || '—';
                document.getElementById('srv-update-commit').textContent = data.currentCommit || '—';
                _lastUpdateCheck = new Date();
                document.getElementById('srv-update-checked').textContent = _lastUpdateCheck.toLocaleTimeString();

                const resultDiv = document.getElementById('srv-update-result');
                const statusEl = document.getElementById('srv-update-status');
                const detailsEl = document.getElementById('srv-update-details');
                const commitsEl = document.getElementById('srv-update-commits');
                const applyWrap = document.getElementById('srv-update-apply-wrap');

                resultDiv.style.display = 'block';

                if (data.available) {
                    statusEl.textContent = 'Update Available';
                    statusEl.style.color = '#fbbf24';
                    detailsEl.textContent = `Remote: ${data.remoteCommit} (${data.commitsBehind} commit${data.commitsBehind !== 1 ? 's' : ''} behind)`;
                    commitsEl.innerHTML = (data.summary || []).map(s => `<div style="padding:2px 0;">• ${s.replace(/</g, '&lt;')}</div>`).join('');
                    applyWrap.style.display = 'block';
                } else {
                    statusEl.textContent = 'Up to date';
                    statusEl.style.color = '#66bb6a';
                    detailsEl.textContent = `Current: ${data.currentCommit}`;
                    commitsEl.innerHTML = '';
                    applyWrap.style.display = 'none';
                }
            } catch (err) {
                const resultDiv = document.getElementById('srv-update-result');
                resultDiv.style.display = 'block';
                document.getElementById('srv-update-status').textContent = 'Check failed';
                document.getElementById('srv-update-status').style.color = '#ef5350';
                document.getElementById('srv-update-details').textContent = err.message;
            } finally {
                btn.disabled = false;
                btn.textContent = 'Check for Updates';
            }
        }

        async function applyServerUpdate() {
            if (!confirm('Apply server update? The server will restart and you will be briefly disconnected.')) return;

            const btn = document.getElementById('btn-apply-update');
            btn.disabled = true;
            btn.textContent = 'Updating...';

            const progressDiv = document.getElementById('srv-update-progress');
            const stepsDiv = document.getElementById('srv-update-progress-steps');
            progressDiv.style.display = 'block';
            stepsDiv.innerHTML = '';

            const addStep = (step, status, detail) => {
                const icon = status === 'done' ? '✓' : status === 'in_progress' ? '○' : status === 'warning' ? '⚠' : '✗';
                const color = status === 'done' ? '#66bb6a' : status === 'in_progress' ? '#66c0f4' : status === 'warning' ? '#fbbf24' : '#ef5350';
                const existing = document.getElementById('srv-step-' + step);
                const html = `<div style="padding:3px 0;color:${color};">${icon} ${step}: ${(detail || '').replace(/</g, '&lt;')}</div>`;
                if (existing) {
                    existing.outerHTML = html.replace('<div ', `<div id="srv-step-${step}" `);
                } else {
                    stepsDiv.insertAdjacentHTML('beforeend', html.replace('<div ', `<div id="srv-step-${step}" `));
                }
            };

            // Listen for progress events
            if (socket) {
                socket.on('server_update_progress', (data) => {
                    addStep(data.step, data.status, data.detail);

                    if (data.step === 'restart' && data.status === 'in_progress') {
                        addStep('reconnect', 'in_progress', 'Waiting for server to come back...');
                        pollServerHealth();
                    }
                });
            }

            try {
                const res = await fetchWithAuth(`${API}/api/updates/server-apply`, { method: 'POST' });
                const data = await res.json();
                if (!data.success) {
                    addStep('error', 'failed', data.error || 'Unknown error');
                }
            } catch (err) {
                // Expected — server is restarting, connection drops
                addStep('reconnect', 'in_progress', 'Server restarting, waiting for reconnect...');
                pollServerHealth();
            }
        }

        function pollServerHealth() {
            let attempts = 0;
            const maxAttempts = 30;
            const interval = setInterval(async () => {
                attempts++;
                try {
                    const res = await fetch(`${API}/health`, { signal: AbortSignal.timeout(2000) });
                    if (res.ok) {
                        clearInterval(interval);
                        const existing = document.getElementById('srv-step-reconnect');
                        if (existing) {
                            existing.outerHTML = '<div id="srv-step-reconnect" style="padding:3px 0;color:#66bb6a;">✓ reconnect: Server back online!</div>';
                        }
                        document.getElementById('btn-apply-update').disabled = false;
                        document.getElementById('btn-apply-update').textContent = 'Update Server';
                        document.getElementById('srv-update-apply-wrap').style.display = 'none';
                        // Refresh update status
                        setTimeout(() => checkServerUpdate(), 1000);
                    }
                } catch {
                    // Server still down, keep polling
                }
                if (attempts >= maxAttempts) {
                    clearInterval(interval);
                    const existing = document.getElementById('srv-step-reconnect');
                    if (existing) {
                        existing.outerHTML = '<div id="srv-step-reconnect" style="padding:3px 0;color:#ef5350;">✗ reconnect: Server did not come back after 60s. Check manually.</div>';
                    }
                    document.getElementById('btn-apply-update').disabled = false;
                    document.getElementById('btn-apply-update').textContent = 'Update Server';
                }
            }, 2000);
        }

        function loadSettings() {
            fetchWithAuth(`${API}/api/admin/settings`)
                .then(res => res.json())
                .then(settings => {
                    document.getElementById('setting-server-url').value = settings['server.publicUrl'] || '';
                    document.getElementById('setting-llm-provider').value = settings['llm.provider'] || 'ollama';
                    document.getElementById('setting-ollama-url').value = settings['llm.ollama.url'] || '';
                    document.getElementById('setting-ollama-model').value = settings['llm.ollama.model'] || '';
                    document.getElementById('setting-openai-key').value = settings['llm.openai.apiKey'] || '';
                    document.getElementById('setting-openai-model').value = settings['llm.openai.model'] || '';
                    document.getElementById('setting-anthropic-key').value = settings['llm.anthropic.apiKey'] || '';
                    document.getElementById('setting-anthropic-model').value = settings['llm.anthropic.model'] || '';
                    document.getElementById('setting-claude-cli-model').value = settings['llm.claudeCli.model'] || '';
                    document.getElementById('setting-gemini-key').value = settings['llm.gemini.apiKey'] || '';
                    document.getElementById('setting-gemini-model').value = settings['llm.gemini.model'] || '';
                    document.getElementById('setting-llm-timeout').value = settings['llm.timeout'] ? Math.round(parseInt(settings['llm.timeout'], 10) / 1000) : 120;

                    const aiEnabled = settings['ai.enabled'] !== 'false';
                    const aiToggle = document.getElementById('setting-ai-enabled');
                    if (aiToggle) aiToggle.checked = aiEnabled;

                    toggleLLMProvider();
                    updateSystemInfo(settings);
                })
                .catch(err => console.error('Failed to load settings:', err));
        }

        function toggleLLMProvider() {
            const provider = document.getElementById('setting-llm-provider').value;
            document.getElementById('llm-ollama-settings').style.display = provider === 'ollama' ? 'block' : 'none';
            document.getElementById('llm-openai-settings').style.display = provider === 'openai' ? 'block' : 'none';
            document.getElementById('llm-anthropic-settings').style.display = provider === 'anthropic' ? 'block' : 'none';
            document.getElementById('llm-claude-cli-settings').style.display = provider === 'claude-cli' ? 'block' : 'none';
            document.getElementById('llm-gemini-settings').style.display = provider === 'gemini' ? 'block' : 'none';
        }

        // Wire up provider change
        document.getElementById('setting-llm-provider')?.addEventListener('change', toggleLLMProvider);

        async function saveSettings() {
            const statusEl = document.getElementById('save-settings-status');
            statusEl.textContent = 'Saving...';
            statusEl.style.color = '#66c0f4';

            const settings = {
                'server.publicUrl': document.getElementById('setting-server-url').value.trim(),
                'llm.provider': document.getElementById('setting-llm-provider').value,
                'llm.ollama.url': document.getElementById('setting-ollama-url').value.trim(),
                'llm.ollama.model': document.getElementById('setting-ollama-model').value.trim(),
                'llm.openai.apiKey': document.getElementById('setting-openai-key').value.trim(),
                'llm.openai.model': document.getElementById('setting-openai-model').value.trim(),
                'llm.anthropic.apiKey': document.getElementById('setting-anthropic-key').value.trim(),
                'llm.anthropic.model': document.getElementById('setting-anthropic-model').value.trim(),
                'llm.claudeCli.model': document.getElementById('setting-claude-cli-model').value.trim(),
                'llm.gemini.apiKey': document.getElementById('setting-gemini-key').value.trim(),
                'llm.gemini.model': document.getElementById('setting-gemini-model').value.trim(),
                'llm.timeout': String(Math.max(15, Math.min(600, parseInt(document.getElementById('setting-llm-timeout').value, 10) || 120)) * 1000),
                'ai.enabled': document.getElementById('setting-ai-enabled').checked ? 'true' : 'false'
            };

            try {
                const res = await fetchWithAuth(`${API}/api/admin/settings`, {
                    method: 'PUT',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify(settings)
                });
                if (res.ok) {
                    statusEl.textContent = 'Settings saved successfully!';
                    statusEl.style.color = '#66bb6a';
                    setTimeout(() => { statusEl.textContent = ''; }, 3000);
                } else {
                    const data = await res.json();
                    statusEl.textContent = data.error || 'Save failed';
                    statusEl.style.color = '#ef5350';
                }
            } catch (err) {
                statusEl.textContent = 'Save error: ' + err.message;
                statusEl.style.color = '#ef5350';
            }
        }

        let _llmTestRunning = false;
        async function testLLMConnection() {
            if (_llmTestRunning) return;
            _llmTestRunning = true;

            const btns = [document.getElementById('test-llm-btn'), document.getElementById('test-llm-btn-inline')].filter(Boolean);
            const resultDiv = document.getElementById('llm-test-result');
            const statusSpan = document.getElementById('test-llm-status');

            btns.forEach(b => { b.disabled = true; b.style.opacity = '0.5'; b.style.pointerEvents = 'none'; });
            if (resultDiv) { resultDiv.textContent = 'Testing LLM connection... (may take up to 2 minutes)'; resultDiv.style.color = '#8f98a0'; resultDiv.style.display = 'block'; }
            if (statusSpan) statusSpan.textContent = 'Testing...';

            try {
                const res = await fetchWithAuth(`${API}/api/llm/test`, { method: 'POST' });
                const data = await res.json();

                const msg = data.success
                    ? `OK — ${data.provider}/${data.model} responded in ${data.durationMs}ms: "${data.response}"`
                    : `FAILED — ${data.provider}/${data.model}: ${data.error}`;
                const color = data.success ? '#22c55e' : '#ef4444';

                if (resultDiv) { resultDiv.style.color = color; resultDiv.textContent = msg; resultDiv.style.display = 'block'; }
                if (statusSpan) { statusSpan.style.color = color; statusSpan.textContent = data.success ? 'Connected' : 'Failed'; }
            } catch (err) {
                const msg = `Connection error: ${err.message}`;
                if (resultDiv) { resultDiv.style.color = '#ef4444'; resultDiv.textContent = msg; resultDiv.style.display = 'block'; }
                if (statusSpan) { statusSpan.style.color = '#ef4444'; statusSpan.textContent = 'Error'; }
            } finally {
                btns.forEach(b => { b.disabled = false; b.style.opacity = ''; b.style.pointerEvents = ''; });
                _llmTestRunning = false;
            }
        }

        function updateSystemInfo(settings) {
            document.getElementById('sys-info-port').textContent = location.port || '9100';
            document.getElementById('sys-info-provider').textContent = settings['llm.provider'] || 'ollama';
            // Database size
            if (settings['_dbSizeBytes']) {
                const bytes = settings['_dbSizeBytes'];
                const mb = (bytes / (1024 * 1024)).toFixed(1);
                document.getElementById('sys-info-db-size').textContent = mb >= 1 ? `${mb} MB` : `${(bytes / 1024).toFixed(0)} KB`;
            }
            // Fetch online device count from stats
            fetchWithAuth(`${API}/api/admin/stats`)
                .then(r => r.json())
                .then(stats => {
                    document.getElementById('sys-info-devices').textContent = `${stats.onlineDevices || 0} online / ${stats.totalDevices || 0} total`;
                })
                .catch(() => {});
        }

        // ---- Deploy Page ----
        let deployDevicesCache = [];

        function showDeployTab(tab) {
            document.getElementById('deploy-new').style.display = tab === 'new' ? '' : 'none';
            document.getElementById('deploy-history').style.display = tab === 'history' ? '' : 'none';
            document.getElementById('deploy-templates').style.display = tab === 'templates' ? '' : 'none';
            document.getElementById('deploy-tab-new').classList.toggle('active', tab === 'new');
            document.getElementById('deploy-tab-history').classList.toggle('active', tab === 'history');
            document.getElementById('deploy-tab-templates').classList.toggle('active', tab === 'templates');
            if (tab === 'history') loadDeployHistory();
            if (tab === 'templates') loadDeployTemplates();
        }

        function toggleDeployType() {
            const type = document.querySelector('input[name="deploy-type"]:checked').value;
            document.getElementById('deploy-script-panel').style.display = type === 'script' ? '' : 'none';
            document.getElementById('deploy-installer-panel').style.display = type === 'installer' ? '' : 'none';
        }

        function toggleDeploySchedule() {
            const val = document.querySelector('input[name="deploy-schedule"]:checked').value;
            const picker = document.getElementById('deploy-schedule-picker');
            picker.style.display = val === 'later' ? '' : 'none';
            if (val === 'later') {
                const tomorrow = new Date();
                tomorrow.setDate(tomorrow.getDate() + 1);
                const dateInput = document.getElementById('deploy-schedule-date');
                const timeInput = document.getElementById('deploy-schedule-time-input');
                if (!dateInput.value) {
                    dateInput.value = tomorrow.toISOString().split('T')[0];
                    timeInput.value = '09:00';
                }
                updateSchedulePreview();
            }
        }

        function updateSchedulePreview() {
            const dateVal = document.getElementById('deploy-schedule-date').value;
            const timeVal = document.getElementById('deploy-schedule-time-input').value;
            const preview = document.getElementById('deploy-schedule-preview');
            if (dateVal && timeVal) {
                const dt = new Date(dateVal + 'T' + timeVal);
                preview.textContent = dt.toLocaleString(undefined, { weekday: 'short', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
            } else {
                preview.textContent = '';
            }
        }

        async function loadDeployPage() {
            // Load script library
            try {
                const res = await fetchWithAuth(`${API}/api/scripts`);
                const scripts = await res.json();
                const sel = document.getElementById('deploy-script-select');
                sel.innerHTML = '<option value="">-- Ad-hoc script --</option>';
                [...scripts].sort((a, b) => (a.name || '').localeCompare(b.name || '')).forEach(s => {
                    sel.innerHTML += `<option value="${s.id}" data-content="${escapeHtml(s.script_content)}" data-elevation="${s.requires_elevation}">${escapeHtml(s.name)}</option>`;
                });
            } catch (err) { console.error('Load scripts error:', err); }

            // Load devices
            try {
                const res = await fetchWithAuth(`${API}/api/devices`);
                const devices = await res.json();
                deployDevicesCache = devices;
                renderDeployDeviceList(devices);
                // Populate client filter from existing client selector
                const clientSel = document.getElementById('client-selector');
                const deployClientFilter = document.getElementById('deploy-filter-client');
                if (clientSel && deployClientFilter) {
                    deployClientFilter.innerHTML = '<option value="">All Clients</option>';
                    Array.from(clientSel.options).forEach(opt => {
                        if (opt.value) deployClientFilter.innerHTML += `<option value="${opt.value}">${escapeHtml(opt.textContent)}</option>`;
                    });
                }
            } catch (err) { console.error('Load devices error:', err); }

            // Load templates
            loadDeployTemplates();
        }

        function renderDeployDeviceList(devices) {
            const el = document.getElementById('deploy-device-list');
            if (devices.length === 0) {
                el.innerHTML = '<div style="color:#8f98a0; padding:24px; text-align:center; grid-column:1/-1;">No devices match filters.</div>';
                return;
            }
            el.innerHTML = devices.map(d => {
                const online = d.status === 'online';
                return `<div class="deploy-device-card" data-device-id="${d.device_id}" data-online="${online}" data-hostname="${escapeHtml(d.hostname || '')}" data-client-id="${d.client_id || ''}" data-action="deploy-toggle-device">
                    <div class="dd-check"></div>
                    <div class="dd-hostname">${escapeHtml(d.hostname || d.device_id)}</div>
                    <div class="dd-status">
                        <span class="deploy-device-dot ${online ? 'online' : 'offline'}"></span>
                        ${online ? 'online' : 'offline'}
                    </div>
                </div>`;
            }).join('');
            updateDeploySelectedCount();
        }

        function toggleDeployDevice(card) {
            card.classList.toggle('selected');
            card.querySelector('.dd-check').textContent = card.classList.contains('selected') ? '✓' : '';
            updateDeploySelectedCount();
        }

        function updateDeploySelectedCount() {
            const count = document.querySelectorAll('.deploy-device-card.selected').length;
            const el = document.getElementById('deploy-selected-count');
            if (el) el.textContent = count + ' selected';
        }

        function filterDeployDevices() {
            const clientFilter = document.getElementById('deploy-filter-client').value;
            const searchFilter = document.getElementById('deploy-filter-search').value.toLowerCase();
            let filtered = deployDevicesCache;
            if (clientFilter) {
                filtered = filtered.filter(d => String(d.client_id) === clientFilter);
            }
            if (searchFilter) {
                filtered = filtered.filter(d => (d.hostname || d.device_id).toLowerCase().includes(searchFilter));
            }
            renderDeployDeviceList(filtered);
        }

        function onDeployScriptSelect() {
            const sel = document.getElementById('deploy-script-select');
            const opt = sel.options[sel.selectedIndex];
            if (opt.value) {
                document.getElementById('deploy-script-content').value = opt.dataset.content || '';
                document.getElementById('deploy-elevation').checked = opt.dataset.elevation === '1';
            }
        }

        function onDeployInstallerSelected() {
            const input = document.getElementById('deploy-installer-file');
            const info = document.getElementById('deploy-installer-info');
            if (input.files.length > 0) {
                const f = input.files[0];
                const sizeMB = (f.size / 1024 / 1024).toFixed(1);
                info.textContent = `${f.name} (${sizeMB} MB)`;
                info.className = 'deploy-file-info';
                if (f.size > 52_428_800) {
                    info.textContent += ' — exceeds 50MB limit!';
                    info.className = 'deploy-file-info error';
                }
            }
        }

        function deploySelectAllOnline() {
            document.querySelectorAll('.deploy-device-card').forEach(card => {
                const isOnline = card.dataset.online === 'true';
                card.classList.toggle('selected', isOnline);
                card.querySelector('.dd-check').textContent = isOnline ? '✓' : '';
            });
            updateDeploySelectedCount();
        }
        function deploySelectAll() {
            document.querySelectorAll('.deploy-device-card').forEach(card => {
                card.classList.add('selected');
                card.querySelector('.dd-check').textContent = '✓';
            });
            updateDeploySelectedCount();
        }
        function deploySelectNone() {
            document.querySelectorAll('.deploy-device-card').forEach(card => {
                card.classList.remove('selected');
                card.querySelector('.dd-check').textContent = '';
            });
            updateDeploySelectedCount();
        }

        async function submitDeployment() {
            const name = document.getElementById('deploy-name').value.trim();
            if (!name) { alert('Deployment name is required'); return; }

            const type = document.querySelector('input[name="deploy-type"]:checked').value;
            const targetDeviceIds = Array.from(document.querySelectorAll('.deploy-device-card.selected')).map(card => card.dataset.deviceId);
            if (targetDeviceIds.length === 0) { alert('Select at least one target device'); return; }

            const timeoutSeconds = parseInt(document.getElementById('deploy-timeout').value, 10) || 300;
            const scheduleVal = document.querySelector('input[name="deploy-schedule"]:checked').value;
            let scheduledAt = null;
            if (scheduleVal === 'later') {
                const dateVal = document.getElementById('deploy-schedule-date').value;
                const timeVal = document.getElementById('deploy-schedule-time-input').value;
                if (!dateVal || !timeVal) { alert('Please select a schedule date and time'); return; }
                scheduledAt = dateVal + 'T' + timeVal;
            }

            const payload = { name, type, targetDeviceIds, timeoutSeconds, scheduledAt: scheduledAt ? new Date(scheduledAt).toISOString() : null };

            if (type === 'script') {
                const scriptSel = document.getElementById('deploy-script-select');
                if (scriptSel.value) {
                    payload.scriptId = parseInt(scriptSel.value, 10);
                }
                payload.scriptContent = document.getElementById('deploy-script-content').value;
                payload.requiresElevation = document.getElementById('deploy-elevation').checked;

                if (!payload.scriptContent && !payload.scriptId) { alert('Script content is required'); return; }
            } else {
                const fileInput = document.getElementById('deploy-installer-file');
                if (!fileInput.files.length) { alert('Select an installer file'); return; }
                const file = fileInput.files[0];
                if (file.size > 52_428_800) { alert('File exceeds 50MB limit'); return; }

                // Read as base64
                const reader = new FileReader();
                const base64 = await new Promise((resolve, reject) => {
                    reader.onload = () => resolve(reader.result.split(',')[1]);
                    reader.onerror = reject;
                    reader.readAsDataURL(file);
                });

                payload.installerFilename = file.name;
                payload.installerData = base64;
                payload.silentArgs = document.getElementById('deploy-silent-args').value.trim();
            }

            socket.emit('create_deployment', payload);
            showDeployTab('history');
        }

        function loadDeployHistory() {
            socket.emit('get_deployments');
            socket.once('deployment_list', (data) => {
                const el = document.getElementById('deploy-history-list');
                if (!data.deployments || data.deployments.length === 0) {
                    el.innerHTML = '<div style="color:#8f98a0; text-align:center; padding:24px;">No deployments yet.</div>';
                    return;
                }
                el.innerHTML = data.deployments.map(d => {
                    const totalTargets = d.results ? d.results.length : 0;
                    const done = d.results ? d.results.filter(r => ['success', 'failed', 'skipped'].includes(r.status)).length : 0;
                    const succeeded = d.results ? d.results.filter(r => r.status === 'success').length : 0;
                    const statusColor = d.status === 'completed' ? '#4caf50' : d.status === 'running' ? '#ff9800' : d.status === 'cancelled' ? '#ef5350' : '#8f98a0';
                    const scheduledInfo = d.scheduled_at ? `<div class="dh-meta">Scheduled: ${new Date(d.scheduled_at).toLocaleString()}</div>` : '';

                    const resultsHtml = d.results ? d.results.map(r => {
                        const rColor = r.status === 'success' ? '#4caf50' : r.status === 'failed' ? '#ef5350' : r.status === 'running' ? '#ff9800' : '#8f98a0';
                        return `<div class="deploy-result-row">
                            <span class="deploy-device-dot" style="background:${rColor};"></span>
                            <span class="deploy-result-host">${escapeHtml(r.hostname || r.device_id)}</span>
                            <span class="deploy-result-status" style="color:${rColor};">${r.status}</span>
                            <span class="deploy-result-meta">${r.exit_code !== null ? 'exit=' + r.exit_code : ''} ${r.duration_ms ? (r.duration_ms / 1000).toFixed(1) + 's' : ''} ${r.timed_out ? '(timed out)' : ''}</span>
                        </div>`;
                    }).join('') : '';

                    return `<div class="deploy-history-card">
                        <div class="dh-header">
                            <div>
                                <span class="dh-name">${escapeHtml(d.name)}</span>
                                <span class="dh-type">${d.type}</span>
                            </div>
                            <div style="display:flex; align-items:center; gap:10px;">
                                <span class="dh-status" style="color:${statusColor};">${d.status.toUpperCase()}</span>
                                <span class="dh-count">${succeeded}/${totalTargets} succeeded</span>
                                ${d.status === 'pending' || d.status === 'running' ? `<button class="deploy-cancel-btn" data-action="deploy-cancel" data-id="${d.id}">Cancel</button>` : ''}
                            </div>
                        </div>
                        ${scheduledInfo}
                        <div class="dh-meta">Created: ${new Date(d.created_at).toLocaleString()}</div>
                        <details style="margin-top:4px;">
                            <summary style="cursor:pointer; font-size:12px; color:#66c0f4;">Per-device results (${done}/${totalTargets} complete)</summary>
                            <div style="margin-top:8px; background:#0f1923; border-radius:6px; max-height:220px; overflow-y:auto;">${resultsHtml || '<div style="padding:10px; color:#8f98a0; text-align:center;">No results yet.</div>'}</div>
                        </details>
                    </div>`;
                }).join('');
            });
        }

        function cancelDeployment(id) {
            if (!confirm('Cancel this deployment? Pending devices will be skipped.')) return;
            socket.emit('cancel_deployment', { deploymentId: id });
            setTimeout(loadDeployHistory, 500);
        }

        // ---- Deploy Templates ----
        function loadDeployTemplates() {
            socket.emit('get_deploy_templates');
            socket.once('deploy_template_list', (data) => {
                const el = document.getElementById('deploy-templates-list');
                const sel = document.getElementById('deploy-template-select');

                // Update the dropdown in the form
                sel.innerHTML = '<option value="">Load from template...</option>';
                if (data.templates) {
                    [...data.templates].sort((a, b) => (a.name || '').localeCompare(b.name || '')).forEach(t => {
                        sel.innerHTML += `<option value="${t.id}">${escapeHtml(t.name)} (${t.type})</option>`;
                    });
                }

                // Render template cards
                if (!data.templates || data.templates.length === 0) {
                    el.innerHTML = '<div style="color:#8f98a0; text-align:center; padding:24px;">No templates saved yet. Create a deployment and click "Save as Template".</div>';
                    return;
                }
                el.innerHTML = data.templates.map(t => {
                    const details = [];
                    if (t.type === 'script' && t.script_content) details.push('Script: ' + t.script_content.substring(0, 60) + (t.script_content.length > 60 ? '...' : ''));
                    if (t.type === 'installer' && t.installer_filename) details.push('File: ' + t.installer_filename);
                    if (t.silent_args) details.push('Args: ' + t.silent_args);
                    if (t.requires_elevation) details.push('Elevated');
                    details.push('Timeout: ' + t.timeout_seconds + 's');

                    return `<div class="deploy-history-card">
                        <div class="dh-header">
                            <div>
                                <span class="dh-name">${escapeHtml(t.name)}</span>
                                <span class="dh-type">${t.type}</span>
                            </div>
                            <div style="display:flex; align-items:center; gap:8px;">
                                <button class="diag-btn" data-action="template-use" data-id="${t.id}" style="font-size:11px; padding:3px 10px;">Use</button>
                                <button class="deploy-cancel-btn" data-action="template-delete" data-id="${t.id}">Delete</button>
                            </div>
                        </div>
                        <div class="dh-meta">${details.map(d => escapeHtml(d)).join(' &middot; ')}</div>
                        <div class="dh-meta">Created: ${new Date(t.created_at).toLocaleString()} by ${escapeHtml(t.created_by || 'unknown')}</div>
                    </div>`;
                }).join('');
            });
        }

        function saveDeployTemplate() {
            const name = document.getElementById('deploy-name').value.trim();
            if (!name) { alert('Enter a deployment name first — it will be used as the template name'); return; }

            const type = document.querySelector('input[name="deploy-type"]:checked').value;
            const payload = {
                name,
                type,
                timeoutSeconds: parseInt(document.getElementById('deploy-timeout').value, 10) || 300,
                requiresElevation: document.getElementById('deploy-elevation').checked
            };

            if (type === 'script') {
                const scriptSel = document.getElementById('deploy-script-select');
                if (scriptSel.value) payload.scriptId = parseInt(scriptSel.value, 10);
                payload.scriptContent = document.getElementById('deploy-script-content').value;
            } else {
                const fileInput = document.getElementById('deploy-installer-file');
                if (fileInput.files.length) payload.installerFilename = fileInput.files[0].name;
                payload.silentArgs = document.getElementById('deploy-silent-args').value.trim();
            }

            socket.emit('save_deploy_template', payload);
            socket.once('deploy_template_saved', (data) => {
                alert('Template "' + data.name + '" saved!');
                loadDeployTemplates();
            });
            socket.once('deploy_template_error', (data) => {
                alert('Error saving template: ' + data.error);
            });
        }

        function loadDeployTemplate() {
            const sel = document.getElementById('deploy-template-select');
            if (!sel.value) return;

            socket.emit('get_deploy_templates');
            socket.once('deploy_template_list', (data) => {
                const t = data.templates.find(tpl => tpl.id === parseInt(sel.value, 10));
                if (!t) return;

                document.getElementById('deploy-name').value = t.name;
                document.getElementById('deploy-timeout').value = t.timeout_seconds || 300;
                document.getElementById('deploy-elevation').checked = !!t.requires_elevation;

                // Set type
                document.querySelector(`input[name="deploy-type"][value="${t.type}"]`).checked = true;
                toggleDeployType();

                if (t.type === 'script') {
                    if (t.script_id) {
                        const scriptSel = document.getElementById('deploy-script-select');
                        scriptSel.value = String(t.script_id);
                        onDeployScriptSelect();
                    }
                    if (t.script_content) {
                        document.getElementById('deploy-script-content').value = t.script_content;
                    }
                } else {
                    if (t.installer_filename) {
                        document.getElementById('deploy-installer-info').textContent = 'Template file: ' + t.installer_filename + ' (re-select file to deploy)';
                        document.getElementById('deploy-installer-info').className = 'deploy-file-info';
                    }
                    if (t.silent_args) {
                        document.getElementById('deploy-silent-args').value = t.silent_args;
                    }
                }
            });
        }

        function useDeployTemplate(id) {
            const sel = document.getElementById('deploy-template-select');
            sel.value = String(id);
            loadDeployTemplate();
            showDeployTab('new');
        }

        function deleteDeployTemplate(id) {
            if (!confirm('Delete this template?')) return;
            socket.emit('delete_deploy_template', { id });
            socket.once('deploy_template_deleted', () => { loadDeployTemplates(); });
        }

        // ---- AI Guidance Chat ----
        function switchChatTab(tab) {
            document.getElementById('chat-panel-user').style.display = tab === 'user' ? 'flex' : 'none';
            document.getElementById('chat-panel-guidance').style.display = tab === 'guidance' ? 'flex' : 'none';
            document.getElementById('chat-tab-user').style.background = tab === 'user' ? '#1a3a5c' : '';
            document.getElementById('chat-tab-user').style.borderBottomColor = tab === 'user' ? '#66c0f4' : 'transparent';
            document.getElementById('chat-tab-guidance').style.background = tab === 'guidance' ? '#1a3a5c' : '';
            document.getElementById('chat-tab-guidance').style.borderBottomColor = tab === 'guidance' ? '#e65100' : 'transparent';

            if (tab === 'guidance' && currentDeviceId) {
                socket.emit('get_it_guidance_history', { deviceId: currentDeviceId });
            }
        }

        function sendGuidanceMessage() {
            const input = document.getElementById('guidance-chat-input');
            const content = input.value.trim();
            if (!content || !currentDeviceId) return;
            input.value = '';

            appendGuidanceMessage('it_tech', content);
            document.getElementById('guidance-status').textContent = 'AI is thinking...';
            socket.emit('it_guidance_message', { deviceId: currentDeviceId, content });
        }

        function appendGuidanceMessage(sender, content) {
            const chatEl = document.getElementById('guidance-chat');
            const div = document.createElement('div');
            div.style.cssText = 'margin-bottom:8px; font-size:13px;';

            const senderLabel = sender === 'it_tech' ? 'IT' : sender === 'ai' ? 'AI' : sender;
            const senderColor = sender === 'it_tech' ? '#e65100' : sender === 'ai' ? '#66c0f4' : '#8f98a0';

            div.innerHTML = `<span style="font-weight:600; color:${senderColor}; font-size:11px;">${escapeHtml(senderLabel)}</span><br><span style="color:#c7d5e0;">${escapeHtml(content || '')}</span>`;
            chatEl.appendChild(div);
            chatEl.scrollTop = chatEl.scrollHeight;
        }

        function clearGuidanceContext() {
            if (!currentDeviceId) return;
            socket.emit('clear_it_guidance_context', { deviceId: currentDeviceId });
        }

        // ---- Script Library ----
        async function loadScripts() {
            const category = document.getElementById('script-filter-category')?.value || '';
            const url = category ? `${API}/api/scripts?category=${category}` : `${API}/api/scripts`;
            try {
                const res = await fetchWithAuth(url);
                const scripts = await res.json();
                const tbody = document.getElementById('scripts-table-body');
                document.getElementById('script-count').textContent = `${scripts.length} script${scripts.length !== 1 ? 's' : ''}`;
                const osLabels = { 'windows': 'Windows', 'windows-server': 'Win Server', 'macos': 'macOS', 'linux': 'Linux' };
                if (scripts.length === 0) {
                    tbody.innerHTML = '<tr><td colspan="8" style="text-align:center; padding:32px; color:#8f98a0;">No scripts found. Create one above.</td></tr>';
                    return;
                }
                tbody.innerHTML = scripts.map(s => `
                    <tr style="border-bottom:1px solid #1a2a3a;">
                        <td style="padding:8px 12px; color:#c7d5e0; font-weight:600;">${escapeHtml(s.name)}</td>
                        <td style="padding:8px 12px;"><span style="background:#1a3a5c; color:#66c0f4; padding:2px 8px; border-radius:10px; font-size:11px;">${escapeHtml(s.category || 'general')}</span></td>
                        <td style="padding:8px 12px;"><span style="background:#1a2a1a; color:#8bc34a; padding:2px 8px; border-radius:10px; font-size:11px;">${escapeHtml(osLabels[s.os_type] || 'Windows')}</span></td>
                        <td style="padding:8px 12px; color:#8f98a0; font-size:12px; max-width:300px; overflow:hidden; text-overflow:ellipsis; white-space:nowrap;">${escapeHtml(s.description || '—')}</td>
                        <td style="padding:8px 12px; text-align:center;">${s.requires_elevation ? '<span style="color:#ffa726;" title="Runs as Administrator">&#x1F6E1;</span>' : '—'}</td>
                        <td style="padding:8px 12px; color:#8f98a0; font-size:12px;">${s.timeout_seconds}s</td>
                        <td style="padding:8px 12px;">${s.ai_tool ? '<span style="color:#66c0f4; font-size:12px;">Active</span>' : '<span style="color:#8f98a0; font-size:12px;">—</span>'}</td>
                        <td style="padding:8px 12px;">
                            <button class="diag-btn" data-action="script-edit" data-id="${s.id}" style="font-size:11px; padding:3px 10px;">Edit</button>
                            <button class="diag-btn" data-action="script-delete" data-id="${s.id}" style="font-size:11px; padding:3px 10px; color:#ef5350;">Delete</button>
                        </td>
                    </tr>
                `).join('');
            } catch (err) {
                console.error('Failed to load scripts:', err);
            }
        }

        function resetScriptForm() {
            document.getElementById('script-edit-id').value = '';
            document.getElementById('script-name').value = '';
            document.getElementById('script-description').value = '';
            document.getElementById('script-content').value = '';
            document.getElementById('script-category').value = 'general';
            document.getElementById('script-os').value = 'windows';
            document.getElementById('script-elevation').checked = false;
            document.getElementById('script-timeout').value = '60';
            document.getElementById('script-ai-tool').checked = false;
            document.getElementById('script-form-title').textContent = 'New Script';
            document.getElementById('btn-cancel-script').style.display = 'none';
            document.getElementById('btn-save-script').textContent = 'Save Script';
        }

        async function editScript(id) {
            try {
                const res = await fetchWithAuth(`${API}/api/scripts/${id}`);
                const s = await res.json();
                document.getElementById('script-edit-id').value = s.id;
                document.getElementById('script-name').value = s.name;
                document.getElementById('script-description').value = s.description || '';
                document.getElementById('script-content').value = s.script_content;
                document.getElementById('script-category').value = s.category || 'general';
                document.getElementById('script-os').value = s.os_type || 'windows';
                document.getElementById('script-elevation').checked = !!s.requires_elevation;
                document.getElementById('script-timeout').value = s.timeout_seconds || 60;
                document.getElementById('script-ai-tool').checked = !!s.ai_tool;
                document.getElementById('script-form-title').textContent = 'Edit Script';
                document.getElementById('btn-cancel-script').style.display = '';
                document.getElementById('btn-save-script').textContent = 'Update Script';
                document.getElementById('script-form').scrollIntoView({ behavior: 'smooth' });
            } catch (err) {
                showToast('Failed to load script');
            }
        }

        async function saveScript() {
            const editId = document.getElementById('script-edit-id').value;
            const name = document.getElementById('script-name').value.trim();
            const content = document.getElementById('script-content').value.trim();
            if (!name || !content) {
                showToast('Name and script content are required');
                return;
            }
            const payload = {
                name,
                description: document.getElementById('script-description').value.trim(),
                script_content: content,
                category: document.getElementById('script-category').value,
                os_type: document.getElementById('script-os').value || 'windows',
                requires_elevation: document.getElementById('script-elevation').checked ? 1 : 0,
                timeout_seconds: parseInt(document.getElementById('script-timeout').value) || 60,
                ai_tool: document.getElementById('script-ai-tool').checked ? 1 : 0
            };
            try {
                const res = await fetchWithAuth(`${API}/api/scripts${editId ? '/' + editId : ''}`, {
                    method: editId ? 'PATCH' : 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify(payload)
                });
                if (!res.ok) {
                    const data = await res.json();
                    showToast(data.error || 'Failed to save script');
                    return;
                }
                showToast(editId ? 'Script updated' : 'Script created');
                resetScriptForm();
                loadScripts();
            } catch (err) {
                showToast('Failed to save script');
            }
        }

        async function deleteScript(id) {
            if (!confirm('Delete this script? This cannot be undone.')) return;
            try {
                const res = await fetchWithAuth(`${API}/api/scripts/${id}`, { method: 'DELETE' });
                if (!res.ok) {
                    showToast('Failed to delete script');
                    return;
                }
                showToast('Script deleted');
                loadScripts();
            } catch (err) {
                showToast('Failed to delete script');
            }
        }

        // ---- Event handler bindings (migrated from inline HTML) ----
        // ---- AI Script Generation ----
        async function generateScriptWithAI(contentElId, opts = {}) {
            const buttonEl = opts.btn || null;
            const originalText = buttonEl ? buttonEl.textContent : '';
            if (buttonEl) { buttonEl.disabled = true; buttonEl.textContent = 'Generating...'; }

            const contentEl = document.getElementById(contentElId);
            const content = contentEl ? contentEl.value : '';
            const description = opts.descriptionElId ? (document.getElementById(opts.descriptionElId)?.value || '') : '';
            const name = opts.nameElId ? (document.getElementById(opts.nameElId)?.value || '') : '';
            const os = opts.osElId ? (document.getElementById(opts.osElId)?.value || 'windows') : 'windows';

            try {
                const res = await fetchWithAuth(`${API}/api/llm/generate-script`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ content, description, name, os })
                });
                const data = await res.json();
                if (!res.ok) throw new Error(data.error || 'Generation failed');
                if (contentEl) contentEl.value = data.script;
            } catch (err) {
                alert('AI generation failed: ' + err.message);
            } finally {
                if (buttonEl) { buttonEl.disabled = false; buttonEl.textContent = originalText; }
            }
        }

        document.addEventListener('DOMContentLoaded', () => {
            // Login
            document.getElementById('btn-login').addEventListener('click', doLogin);

            // Nav client selector
            document.getElementById('client-selector').addEventListener('change', onClientChange);

            // Fleet stat cards — event delegation
            document.querySelector('#page-fleet .stats-row').addEventListener('click', (e) => {
                const card = e.target.closest('.stat-card[data-page]');
                if (card) navigateTo(card.dataset.page);
            });

            // Fleet installer button
            document.getElementById('fleet-installer-btn').addEventListener('click', function() {
                downloadInstaller(selectedClientId, this);
            });

            // Device detail — back button
            document.getElementById('btn-back-to-fleet').addEventListener('click', backToFleet);

            // Diagnostics buttons — event delegation
            document.getElementById('diag-actions').addEventListener('click', (e) => {
                const btn = e.target.closest('[data-diag]');
                if (btn) requestDiag(btn.dataset.diag);
            });

            // System tools heading collapse
            document.getElementById('sys-tools-heading').addEventListener('click', toggleSysToolsSection);

            // Sys tools tabs — event delegation
            document.querySelector('.sys-tools-tabs').addEventListener('click', (e) => {
                const btn = e.target.closest('.sys-tools-tab[data-tab]');
                if (btn) switchSysTab(btn.dataset.tab);
            });

            // Processes
            document.getElementById('btn-refresh-processes').addEventListener('click', loadProcesses);
            document.getElementById('proc-auto-refresh').addEventListener('change', toggleProcAutoRefresh);

            // Services
            document.getElementById('btn-refresh-services').addEventListener('click', loadServices);
            document.getElementById('svc-filter').addEventListener('change', loadServices);
            document.getElementById('svc-search').addEventListener('input', filterServicesLocal);

            // Event log
            document.getElementById('btn-query-eventlog').addEventListener('click', loadEventLog);
            document.getElementById('btn-preset-errors-24h').addEventListener('click', () => presetEventLog('error', '24', 'System'));
            document.getElementById('btn-preset-critical-7d').addEventListener('click', () => presetEventLog('error', '168', 'System'));
            document.getElementById('evt-search').addEventListener('input', filterEventsLocal);

            // File browser heading collapse
            document.getElementById('file-browser-heading').addEventListener('click', toggleFileBrowserSection);

            // File action toolbar
            document.getElementById('file-action-copy').addEventListener('click', fileActionCopy);
            document.getElementById('file-action-cut').addEventListener('click', fileActionCut);
            document.getElementById('file-paste-btn').addEventListener('click', fileActionPaste);
            document.getElementById('file-action-delete').addEventListener('click', fileActionDelete);
            document.getElementById('file-action-copy-paths').addEventListener('click', fileActionCopyPaths);
            document.getElementById('file-properties-btn').addEventListener('click', fileActionProperties);
            document.getElementById('file-action-upload').addEventListener('click', fileActionUpload);
            document.getElementById('file-action-download').addEventListener('click', fileActionDownload);

            // File upload input
            document.getElementById('file-upload-input').addEventListener('change', onFileUploadSelected);

            // Breadcrumb drives root
            document.getElementById('breadcrumb-drives').addEventListener('click', () => browseFiles(''));

            // File properties close
            document.getElementById('btn-close-file-properties').addEventListener('click', () => {
                document.getElementById('file-properties-panel').style.display = 'none';
            });

            // Scripts
            document.getElementById('btn-run-library-script').addEventListener('click', runLibraryScript);
            document.getElementById('btn-run-adhoc-script').addEventListener('click', runAdhocScript);

            // Chat tabs
            document.getElementById('chat-tab-user').addEventListener('click', function() { switchChatTab(this.dataset.tab); });
            document.getElementById('chat-tab-guidance').addEventListener('click', function() { switchChatTab(this.dataset.tab); });

            // User chat send
            document.getElementById('detail-chat-input').addEventListener('keydown', (e) => { if (e.key === 'Enter') sendChatToDevice(); });
            document.getElementById('btn-send-chat').addEventListener('click', sendChatToDevice);

            // Guidance chat send + clear
            document.getElementById('guidance-chat-input').addEventListener('keydown', (e) => { if (e.key === 'Enter') sendGuidanceMessage(); });
            document.getElementById('btn-send-guidance').addEventListener('click', sendGuidanceMessage);
            document.getElementById('btn-clear-guidance').addEventListener('click', clearGuidanceContext);

            // Remote desktop controls
            document.getElementById('btn-start-desktop').addEventListener('click', startDesktop);
            document.getElementById('btn-stop-desktop').addEventListener('click', stopDesktop);
            document.getElementById('btn-popout-desktop').addEventListener('click', popOutDesktop);
            document.getElementById('desktop-quality').addEventListener('change', updateDesktopQuality);
            document.getElementById('desktop-fps').addEventListener('change', updateDesktopQuality);
            document.getElementById('desktop-scale').addEventListener('change', updateDesktopQuality);

            // Remote terminal controls
            document.getElementById('btn-start-terminal').addEventListener('click', startTerminal);
            document.getElementById('btn-stop-terminal').addEventListener('click', stopTerminal);

            // Activity history
            document.getElementById('btn-activity-apply').addEventListener('click', applyActivityFilter);
            document.getElementById('btn-activity-reset').addEventListener('click', () => loadDeviceActivity(currentDeviceId, 1, false));
            document.getElementById('btn-activity-load-more').addEventListener('click', loadMoreActivity);

            // v0.19.0: Device notes events
            document.getElementById('btn-add-device-note').addEventListener('click', addDeviceNote);
            document.getElementById('device-note-input').addEventListener('keydown', (e) => {
                if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); addDeviceNote(); }
            });
            // Device notes collapsible
            document.getElementById('device-notes-heading').addEventListener('click', () => {
                const content = document.getElementById('device-notes-content');
                const toggle = document.getElementById('device-notes-toggle');
                if (content.style.display === 'none') {
                    content.style.display = '';
                    toggle.innerHTML = '&#x25BC;';
                } else {
                    content.style.display = 'none';
                    toggle.innerHTML = '&#x25B6;';
                }
            });

            // v0.19.0: Custom fields events
            document.getElementById('btn-add-custom-field').addEventListener('click', () => {
                document.getElementById('custom-fields-add-form').style.display = '';
                document.getElementById('cf-new-name').focus();
            });
            document.getElementById('btn-cancel-custom-field').addEventListener('click', () => {
                document.getElementById('custom-fields-add-form').style.display = 'none';
            });
            document.getElementById('btn-save-custom-field').addEventListener('click', saveCustomField);
            document.getElementById('cf-new-value').addEventListener('keydown', (e) => {
                if (e.key === 'Enter') { e.preventDefault(); saveCustomField(); }
            });

            // Remove device
            document.getElementById('btn-remove-device').addEventListener('click', removeDevice);

            // Device page — "View all tickets" navigates to tickets page filtered by current device
            document.getElementById('btn-device-view-all-tickets').addEventListener('click', () => {
                showPage('tickets');
                loadTickets({ device_id: currentDeviceId });
            });

            // Tickets
            document.getElementById('btn-new-ticket').addEventListener('click', showCreateTicketForm);
            document.getElementById('btn-cancel-ticket-form').addEventListener('click', hideCreateTicketForm);
            document.getElementById('btn-cancel-ticket-form2').addEventListener('click', hideCreateTicketForm);
            document.getElementById('btn-submit-ticket').addEventListener('click', submitNewTicket);
            document.getElementById('new-ticket-device-search').addEventListener('input', filterTicketDevices);
            document.getElementById('new-ticket-device-search').addEventListener('focus', filterTicketDevices);
            document.getElementById('btn-close-ticket').addEventListener('click', closeTicketDetail);
            document.getElementById('ticket-status-select').addEventListener('change', function() { updateTicket('status', this.value); });
            document.getElementById('ticket-priority-select').addEventListener('change', function() { updateTicket('priority', this.value); });
            document.getElementById('btn-add-ticket-comment').addEventListener('click', addTicketComment);

            // Alert filter — event delegation
            document.getElementById('alert-filter-row').addEventListener('click', (e) => {
                const btn = e.target.closest('[data-filter]');
                if (btn) filterAlerts(btn.dataset.filter, btn);
            });

            // Alert configuration
            document.getElementById('btn-show-add-channel').addEventListener('click', showAddChannelForm);
            document.getElementById('btn-save-channel').addEventListener('click', addChannel);
            document.getElementById('btn-cancel-channel').addEventListener('click', hideAddChannelForm);
            document.getElementById('btn-show-add-policy').addEventListener('click', showAddPolicyForm);
            document.getElementById('btn-save-policy').addEventListener('click', addPolicy);
            document.getElementById('btn-cancel-policy').addEventListener('click', hideAddPolicyForm);

            // Clients
            document.getElementById('btn-create-client').addEventListener('click', createClient);
            document.getElementById('btn-assign-user').addEventListener('click', assignUserToClient);
            document.getElementById('btn-close-client-detail')?.addEventListener('click', closeClientDetail);
            document.getElementById('btn-add-client-field')?.addEventListener('click', () => {
                document.getElementById('client-field-add-form').style.display = '';
            });
            document.getElementById('btn-cancel-client-field')?.addEventListener('click', () => {
                document.getElementById('client-field-add-form').style.display = 'none';
            });
            document.getElementById('btn-save-client-field')?.addEventListener('click', saveClientCustomField);
            document.getElementById('btn-add-client-note')?.addEventListener('click', addClientNote);
            document.getElementById('client-note-input')?.addEventListener('keydown', (e) => {
                if (e.key === 'Enter') addClientNote();
            });

            // Reports
            document.getElementById('btn-export-csv').addEventListener('click', () => exportReport('csv'));
            document.getElementById('btn-export-pdf').addEventListener('click', () => exportReport('pdf'));
            document.getElementById('btn-load-device-metrics').addEventListener('click', loadDeviceMetrics);
            document.getElementById('btn-show-schedule-form').addEventListener('click', showScheduleForm);
            document.getElementById('btn-cancel-schedule').addEventListener('click', hideScheduleForm);
            document.getElementById('btn-save-schedule').addEventListener('click', saveSchedule);

            // Reports stat cards — event delegation
            document.getElementById('alert-summary-stats').addEventListener('click', (e) => {
                const card = e.target.closest('.stat-card[data-page]');
                if (card) navigateTo(card.dataset.page);
            });
            document.getElementById('ticket-summary-stats').addEventListener('click', (e) => {
                const card = e.target.closest('.stat-card[data-page]');
                if (card) navigateTo(card.dataset.page);
            });

            // Deploy tabs — event delegation
            document.getElementById('deploy-tabs').addEventListener('click', (e) => {
                const btn = e.target.closest('[data-tab]');
                if (btn) showDeployTab(btn.dataset.tab);
            });

            // Deploy form
            document.getElementById('deploy-template-select').addEventListener('change', loadDeployTemplate);
            document.getElementById('btn-save-deploy-template').addEventListener('click', saveDeployTemplate);
            document.getElementById('deploy-type-group').addEventListener('change', toggleDeployType);
            document.getElementById('deploy-script-select').addEventListener('change', onDeployScriptSelect);
            document.getElementById('deploy-installer-file').addEventListener('change', onDeployInstallerSelected);
            document.getElementById('btn-deploy-select-online').addEventListener('click', deploySelectAllOnline);
            document.getElementById('btn-deploy-select-all').addEventListener('click', deploySelectAll);
            document.getElementById('btn-deploy-select-none').addEventListener('click', deploySelectNone);
            document.getElementById('deploy-filter-client').addEventListener('change', filterDeployDevices);
            document.getElementById('deploy-filter-search').addEventListener('input', filterDeployDevices);
            document.getElementById('deploy-schedule-group').addEventListener('change', toggleDeploySchedule);
            document.getElementById('deploy-schedule-date').addEventListener('change', updateSchedulePreview);
            document.getElementById('deploy-schedule-time-input').addEventListener('change', updateSchedulePreview);
            document.getElementById('btn-deploy-submit').addEventListener('click', submitDeployment);

            // Wishlist
            document.getElementById('wish-filter-status').addEventListener('change', loadWishes);
            document.getElementById('wish-filter-category').addEventListener('change', loadWishes);
            document.getElementById('btn-refresh-wishes').addEventListener('click', loadWishes);

            // AI Script Generation
            document.getElementById('btn-generate-script-library')?.addEventListener('click', function() {
                generateScriptWithAI('script-content', { descriptionElId: 'script-description', nameElId: 'script-name', osElId: 'script-os', btn: this });
            });
            document.getElementById('btn-generate-script-deploy')?.addEventListener('click', function() {
                generateScriptWithAI('deploy-script-content', { osElId: 'deploy-script-os', btn: this });
            });
            document.getElementById('btn-generate-script-adhoc')?.addEventListener('click', function() {
                generateScriptWithAI('adhoc-script', { osElId: 'adhoc-os', btn: this });
            });

            // Script Library
            document.getElementById('btn-save-script')?.addEventListener('click', saveScript);
            document.getElementById('btn-cancel-script')?.addEventListener('click', resetScriptForm);
            document.getElementById('btn-refresh-scripts')?.addEventListener('click', loadScripts);
            document.getElementById('script-filter-category')?.addEventListener('change', loadScripts);
            document.getElementById('scripts-table-body')?.addEventListener('click', (e) => {
                const btn = e.target.closest('[data-action]');
                if (!btn) return;
                const id = parseInt(btn.dataset.id, 10);
                if (btn.dataset.action === 'script-edit') editScript(id);
                else if (btn.dataset.action === 'script-delete') deleteScript(id);
            });

            // Settings
            document.getElementById('test-llm-btn-inline').addEventListener('click', testLLMConnection);
            document.getElementById('btn-check-update').addEventListener('click', checkServerUpdate);
            document.getElementById('btn-apply-update').addEventListener('click', applyServerUpdate);
            document.getElementById('btn-save-settings').addEventListener('click', saveSettings);
            document.getElementById('test-llm-btn').addEventListener('click', testLLMConnection);

            // Users
            document.getElementById('btn-create-user').addEventListener('click', createUser);

            // Account page
            document.getElementById('btn-save-profile')?.addEventListener('click', saveProfile);
            document.getElementById('btn-change-password')?.addEventListener('click', changePassword);
            document.getElementById('btn-regen-backup')?.addEventListener('click', regenOwnBackupCodes);
            document.getElementById('btn-reset-own-2fa')?.addEventListener('click', resetOwnMFA);
            document.getElementById('btn-save-prefs')?.addEventListener('click', savePreferences);
            document.getElementById('btn-copy-account-backup')?.addEventListener('click', () => {
                const codes = document.getElementById('account-backup-codes').textContent;
                copyToClipboard(codes).then(() => {
                    document.getElementById('btn-copy-account-backup').textContent = 'Copied!';
                    setTimeout(() => { document.getElementById('btn-copy-account-backup').textContent = 'Copy All'; }, 2000);
                });
            });

            // Theme live preview
            document.getElementById('pref-theme')?.addEventListener('change', (e) => {
                document.documentElement.dataset.theme = e.target.value;
            });
        });

        // ---- Event delegation for dynamically generated content ----

        // Wishlist — update wish status
        document.getElementById('wish-tbody').addEventListener('click', (e) => {
            const btn = e.target.closest('[data-action="wish-update"]');
            if (btn) updateWish(parseInt(btn.dataset.id, 10), btn.dataset.status);
        });

        // Users table — name change, role change, reset pw, delete
        document.getElementById('users-table-body').addEventListener('change', (e) => {
            const el = e.target.closest('[data-action]');
            if (!el) return;
            const id = parseInt(el.dataset.id, 10);
            if (el.dataset.action === 'user-update-name') updateUser(id, 'display_name', el.value);
            else if (el.dataset.action === 'user-update-role') updateUser(id, 'role', el.value);
        });
        document.getElementById('users-table-body').addEventListener('click', (e) => {
            const btn = e.target.closest('[data-action]');
            if (!btn) return;
            const id = parseInt(btn.dataset.id, 10);
            if (btn.dataset.action === 'user-reset-pw') resetUserPassword(id, btn.dataset.username);
            else if (btn.dataset.action === 'user-delete') deleteUser(id, btn.dataset.username);
            else if (btn.dataset.action === 'user-reset-2fa') reset2FA(id, btn.dataset.username);
            else if (btn.dataset.action === 'user-regen-codes') regenBackupCodes(id, btn.dataset.username);
        });

        // Device grid — open device
        document.getElementById('device-grid').addEventListener('click', (e) => {
            const card = e.target.closest('[data-device-id]');
            if (card) openDevice(card.dataset.deviceId);
        });

        // Device AI controls
        document.getElementById('device-ai-controls')?.addEventListener('click', (e) => {
            const btn = e.target.closest('.diag-btn[data-ai-mode]');
            if (!btn || !currentDeviceId || !socket) return;
            const mode = btn.dataset.aiMode;
            socket.emit('set_device_ai', { deviceId: currentDeviceId, mode });
        });

        // Move device to client
        document.getElementById('btn-move-device')?.addEventListener('click', () => {
            if (!currentDeviceId) return;
            showMoveDeviceDialog(currentDeviceId);
        });

        // Device detail info — stat card navigation
        document.getElementById('detail-info').addEventListener('click', (e) => {
            const card = e.target.closest('.stat-card[data-page]');
            if (card) navigateTo(card.dataset.page);
        });

        // Ticket device dropdown — mousedown to select before blur fires
        document.getElementById('new-ticket-device-dropdown').addEventListener('mousedown', (e) => {
            const opt = e.target.closest('.ticket-device-option[data-device-id]');
            if (opt) selectTicketDevice(opt.dataset.deviceId, opt.dataset.label);
        });
        document.getElementById('new-ticket-device-dropdown').addEventListener('mouseover', (e) => {
            const opt = e.target.closest('.ticket-device-option');
            if (opt) opt.style.background = '#2a475e';
        });
        document.getElementById('new-ticket-device-dropdown').addEventListener('mouseout', (e) => {
            const opt = e.target.closest('.ticket-device-option');
            if (opt) opt.style.background = '';
        });

        // Ticket list — open ticket
        document.getElementById('ticket-list').addEventListener('click', (e) => {
            const item = e.target.closest('[data-ticket-id]');
            if (item) openTicket(parseInt(item.dataset.ticketId, 10));
        });

        // Alert list — acknowledge / resolve
        document.getElementById('alert-list').addEventListener('click', (e) => {
            const btn = e.target.closest('[data-action]');
            if (!btn) return;
            const id = parseInt(btn.dataset.id, 10);
            if (btn.dataset.action === 'alert-acknowledge') acknowledgeAlert(id);
            else if (btn.dataset.action === 'alert-resolve') resolveAlert(id);
        });

        // Alert thresholds table
        document.getElementById('threshold-tbody').addEventListener('click', (e) => {
            const btn = e.target.closest('[data-action]');
            if (!btn) return;
            const id = parseInt(btn.dataset.id, 10);
            if (btn.dataset.action === 'threshold-toggle') toggleThreshold(id, parseInt(btn.dataset.enabled, 10));
            else if (btn.dataset.action === 'threshold-delete') deleteThreshold(id);
        });

        // Alert channels table
        document.getElementById('channel-tbody').addEventListener('click', (e) => {
            const btn = e.target.closest('[data-action]');
            if (!btn) return;
            const id = parseInt(btn.dataset.id, 10);
            if (btn.dataset.action === 'channel-toggle') toggleChannel(id, parseInt(btn.dataset.enabled, 10));
            else if (btn.dataset.action === 'channel-test') testChannel(id);
            else if (btn.dataset.action === 'channel-delete') deleteChannel(id);
        });

        // File breadcrumb — browse on click
        document.getElementById('file-breadcrumb').addEventListener('click', (e) => {
            const span = e.target.closest('[data-action="browse"]');
            if (span) browseFiles(span.dataset.path);
        });

        // File browser area — browse, file-read, file-close, file-cb-cell (stop propagation), checkboxes, select-all
        document.getElementById('file-browser-area').addEventListener('click', (e) => {
            // Stop click propagation for checkbox cell clicks (don't trigger row navigation)
            if (e.target.closest('.file-cb-cell')) {
                e.stopPropagation();
                return;
            }
            const fileClose = e.target.closest('[data-action="file-close"]');
            if (fileClose) { browseFiles(currentBrowsePath); return; }
            const driveCard = e.target.closest('.drive-card[data-action="browse"]');
            if (driveCard) { browseFiles(driveCard.dataset.path); return; }
            const row = e.target.closest('.file-row[data-action]');
            if (row) {
                if (row.dataset.action === 'browse') browseFiles(row.dataset.path);
                else if (row.dataset.action === 'file-read') requestFileRead(row.dataset.path);
            }
        });
        document.getElementById('file-browser-area').addEventListener('change', (e) => {
            const cb = e.target.closest('input[type="checkbox"].file-row-cb');
            if (!cb) return;
            if (cb.id === 'file-select-all') toggleSelectAll(cb.checked);
            else onFileCheckboxChange(cb);
        });

        // Alert policies table
        document.getElementById('policy-tbody').addEventListener('click', (e) => {
            const btn = e.target.closest('[data-action]');
            if (!btn) return;
            const id = parseInt(btn.dataset.id, 10);
            if (btn.dataset.action === 'policy-toggle') togglePolicy(id, parseInt(btn.dataset.enabled, 10));
            else if (btn.dataset.action === 'policy-delete') deletePolicy(id);
        });

        // Schedules list
        document.getElementById('schedules-list').addEventListener('click', (e) => {
            const btn = e.target.closest('[data-action]');
            if (!btn) return;
            const id = parseInt(btn.dataset.id, 10);
            if (btn.dataset.action === 'schedule-toggle') toggleSchedule(id, parseInt(btn.dataset.enabled, 10));
            else if (btn.dataset.action === 'schedule-delete') deleteSchedule(id);
        });

        // Process table — sort columns + kill process
        document.getElementById('proc-table-container').addEventListener('click', (e) => {
            const el = e.target.closest('[data-action]');
            if (!el) return;
            if (el.dataset.action === 'sort-proc') sortProcesses(el.dataset.col);
            else if (el.dataset.action === 'kill-proc') killProcess(el.dataset.pid, el.dataset.name);
        });

        // Services table — sort columns + service actions
        document.getElementById('svc-table-container').addEventListener('click', (e) => {
            const el = e.target.closest('[data-action]');
            if (!el) return;
            if (el.dataset.action === 'sort-svc') sortServices(el.dataset.col);
            else if (el.dataset.action === 'svc-action') serviceAction(el.dataset.svc, el.dataset.svcAction);
        });

        // Event log table — sort columns
        document.getElementById('evt-table-container').addEventListener('click', (e) => {
            const el = e.target.closest('[data-action="sort-evt"]');
            if (el) sortEvents(el.dataset.col);
        });

        // Clients table
        document.getElementById('client-table-body').addEventListener('click', (e) => {
            const btn = e.target.closest('[data-action]');
            if (!btn) return;
            const id = parseInt(btn.dataset.id, 10);
            if (btn.dataset.action === 'client-detail') openClientDetail(id, btn.dataset.name);
            else if (btn.dataset.action === 'client-devices') viewClientDevices(id);
            else if (btn.dataset.action === 'client-users') manageClientUsers(id, btn.dataset.name);
            else if (btn.dataset.action === 'client-installer') downloadInstaller(id, btn);
            else if (btn.dataset.action === 'client-delete') deleteClient(id);
        });

        // Client detail panel — custom fields and notes
        document.getElementById('client-custom-fields-list').addEventListener('click', (e) => {
            const btn = e.target.closest('[data-action="delete-client-field"]');
            if (btn) deleteClientCustomField(btn.dataset.field);
        });
        document.getElementById('client-notes-list').addEventListener('click', (e) => {
            const btn = e.target.closest('[data-action="delete-client-note"]');
            if (btn) deleteClientNote(parseInt(btn.dataset.noteId, 10));
        });

        // Client users panel — unassign user
        document.getElementById('client-users-list').addEventListener('click', (e) => {
            const btn = e.target.closest('[data-action="unassign-user"]');
            if (btn) unassignUser(parseInt(btn.dataset.clientId, 10), parseInt(btn.dataset.userId, 10));
        });

        // Installer instructions overlay — dismiss
        document.body.addEventListener('click', (e) => {
            const btn = e.target.closest('[data-action="dismiss-overlay"]');
            if (btn) btn.closest('div[style*="fixed"]').remove();
        });

        // Updates table
        document.getElementById('updates-table-body').addEventListener('click', (e) => {
            const btn = e.target.closest('[data-action]');
            if (!btn) return;
            if (btn.dataset.action === 'update-push') pushUpdateToFleet(btn.dataset.version);
            else if (btn.dataset.action === 'update-delete') deleteUpdate(btn.dataset.version);
        });

        // Deploy device list — toggle selection
        document.getElementById('deploy-device-list').addEventListener('click', (e) => {
            const card = e.target.closest('.deploy-device-card[data-action="deploy-toggle-device"]');
            if (card) toggleDeployDevice(card);
        });

        // Deploy history list — cancel deployment
        document.getElementById('deploy-history-list').addEventListener('click', (e) => {
            const btn = e.target.closest('[data-action="deploy-cancel"]');
            if (btn) cancelDeployment(parseInt(btn.dataset.id, 10));
        });

        // Deploy templates list — use / delete template
        document.getElementById('deploy-templates-list').addEventListener('click', (e) => {
            const btn = e.target.closest('[data-action]');
            if (!btn) return;
            const id = parseInt(btn.dataset.id, 10);
            if (btn.dataset.action === 'template-use') useDeployTemplate(id);
            else if (btn.dataset.action === 'template-delete') deleteDeployTemplate(id);
        });
