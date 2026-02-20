        const params = new URLSearchParams(window.location.search);
        const deviceId = params.get('deviceId');
        const deviceName = params.get('name') || deviceId || 'Unknown';

        if (!deviceId) {
            document.getElementById('overlay').textContent = 'Error: No deviceId specified';
            throw new Error('No deviceId');
        }

        document.getElementById('device-name').textContent = deviceName;
        document.title = `Remote Desktop \u2014 ${deviceName}`;

        const canvas = document.getElementById('canvas');
        const ctx = canvas.getContext('2d');
        const overlay = document.getElementById('overlay');
        const statusEl = document.getElementById('status');
        const viewer = document.getElementById('viewer');
        const img = new Image();
        let socket = null;
        let active = false;
        let itInputEnabled = true;
        let currentMonitor = 0;

        // --- Sidebar functions ---

        function toggleSidebar() {
            document.getElementById('sidebar').classList.toggle('collapsed');
        }

        function toggleSection(header) {
            const body = header.nextElementSibling;
            const arrow = header.querySelector('.arrow');
            body.classList.toggle('collapsed');
            arrow.classList.toggle('collapsed');
        }

        // Monitor selector
        function renderMonitors(monitors) {
            const list = document.getElementById('monitor-list');
            list.innerHTML = '';
            monitors.forEach(m => {
                const btn = document.createElement('button');
                btn.className = 'sb-btn monitor-btn' + (m.index === currentMonitor ? ' active' : '');
                btn.textContent = (m.primary ? '\u2605 ' : '') + m.name + ' (' + m.width + 'x' + m.height + ')';
                btn.onclick = () => {
                    currentMonitor = m.index;
                    socket.emit('desktop_switch_monitor', { deviceId, monitorIndex: m.index });
                };
                list.appendChild(btn);
            });
        }

        // Ctrl+Alt+Del
        function sendCtrlAltDel() {
            if (!active || !socket) return;
            socket.emit('desktop_ctrl_alt_del', { deviceId });
        }

        // Paste clipboard as keystrokes
        async function pasteClipboardAsKeystrokes() {
            if (!active || !socket) return;
            const el = document.getElementById('paste-status');
            try {
                if (!navigator.clipboard || !navigator.clipboard.readText) {
                    el.textContent = 'Clipboard API unavailable (requires HTTPS)';
                    el.style.color = '#ef5350';
                    return;
                }
                const text = await navigator.clipboard.readText();
                if (!text) { el.textContent = 'Clipboard empty'; return; }
                socket.emit('desktop_paste_text', { deviceId, text });
                el.textContent = 'Sent ' + text.length + ' chars';
                el.style.color = '#66bb6a';
            } catch (e) {
                el.textContent = 'Clipboard access denied';
                el.style.color = '#ef5350';
            }
        }

        // Tool launcher
        function launchTool(tool) {
            if (!active || !socket) return;
            socket.emit('desktop_launch_tool', { deviceId, tool });
        }

        // File upload
        const MAX_UPLOAD_SIZE = 50 * 1024 * 1024;

        function handleFileSelect(input) {
            if (input.files.length > 0) uploadFile(input.files[0]);
        }

        function uploadFile(file) {
            if (!active || !socket) return;
            if (file.size > MAX_UPLOAD_SIZE) {
                document.getElementById('upload-status').textContent = 'File too large (max 50MB)';
                return;
            }
            const statusEl = document.getElementById('upload-status');
            statusEl.textContent = 'Uploading ' + file.name + '...';
            statusEl.style.color = '#8f98a0';
            const reader = new FileReader();
            reader.onload = () => {
                const base64 = reader.result.split(',')[1];
                socket.emit('desktop_file_upload', { deviceId, fileName: file.name, data: base64 });
            };
            reader.onerror = () => { statusEl.textContent = 'Read error'; };
            reader.readAsDataURL(file);
        }

        // Drag and drop
        const uploadZone = document.getElementById('upload-zone');
        uploadZone.addEventListener('dragover', (e) => { e.preventDefault(); uploadZone.classList.add('dragover'); });
        uploadZone.addEventListener('dragleave', () => { uploadZone.classList.remove('dragover'); });
        uploadZone.addEventListener('drop', (e) => {
            e.preventDefault();
            uploadZone.classList.remove('dragover');
            if (e.dataTransfer.files.length > 0) uploadFile(e.dataTransfer.files[0]);
        });

        // Performance bars
        function updatePerfBar(id, value) {
            const bar = document.getElementById(id);
            const val = document.getElementById(id + '-val');
            const pct = Math.round(value);
            bar.style.width = pct + '%';
            val.textContent = pct + '%';
            bar.className = 'perf-bar-fill' + (pct > 90 ? ' crit' : pct > 70 ? ' warn' : '');
        }

        // Toggles
        function handleToggle(name, el) {
            if (!active || !socket) return;
            const isOn = el.classList.contains('on');
            const newState = !isOn;

            if (name === 'it_input') {
                itInputEnabled = newState;
            }

            el.classList.toggle('on');
            socket.emit('desktop_toggle', { deviceId, toggle: name, enabled: newState });
        }

        // --- Socket connection ---

        async function init() {
            try {
                const resp = await fetch('/api/admin/auto-login', { method: 'POST' });
                if (resp.ok) {
                    const data = await resp.json();
                    connectSocket(data.token);
                    return;
                }
            } catch (e) {}

            connectSocket(null);
        }

        function connectSocket(token) {
            const opts = {};
            if (token) opts.auth = { token };
            socket = io('/it', opts);

            socket.on('connect', () => {
                statusEl.textContent = 'Connected to server, starting desktop...';
                statusEl.style.color = '#ffa726';
                socket.emit('start_desktop', { deviceId });
            });

            socket.on('desktop_started', (data) => {
                if (data.deviceId !== deviceId) return;
                active = true;
                overlay.classList.add('hidden');
                statusEl.textContent = 'Live';
                statusEl.style.color = '#66bb6a';
            });

            socket.on('desktop_frame', (data) => {
                if (data.deviceId !== deviceId || !active) return;
                img.onload = function() {
                    if (canvas.width !== data.width || canvas.height !== data.height) {
                        canvas.width = data.width;
                        canvas.height = data.height;
                    }
                    ctx.drawImage(img, 0, 0);
                };
                img.src = 'data:image/jpeg;base64,' + data.frame;
            });

            socket.on('desktop_stopped', (data) => {
                if (data.deviceId !== deviceId) return;
                active = false;
                overlay.textContent = 'Session ended: ' + (data.reason || 'disconnected');
                overlay.classList.remove('hidden');
                statusEl.textContent = 'Disconnected';
                statusEl.style.color = '#ef5350';
            });

            socket.on('desktop_denied', (data) => {
                if (data.deviceId !== deviceId) return;
                overlay.textContent = 'Desktop access denied by device';
                overlay.classList.remove('hidden');
                statusEl.textContent = 'Denied';
                statusEl.style.color = '#ef5350';
            });

            socket.on('error_message', (data) => {
                overlay.textContent = 'Error: ' + (data.message || 'Unknown error');
                overlay.classList.remove('hidden');
                statusEl.textContent = 'Error';
                statusEl.style.color = '#ef5350';
            });

            socket.on('disconnect', () => {
                if (active) {
                    overlay.textContent = 'Connection lost';
                    overlay.classList.remove('hidden');
                    statusEl.textContent = 'Disconnected';
                    statusEl.style.color = '#ef5350';
                    active = false;
                }
            });

            // Sidebar socket events
            socket.on('desktop_monitors', (data) => {
                if (data.deviceId !== deviceId) return;
                renderMonitors(data.monitors);
            });

            socket.on('desktop_perf_data', (data) => {
                if (data.deviceId !== deviceId) return;
                updatePerfBar('perf-cpu', data.cpu);
                updatePerfBar('perf-mem', data.memoryPercent);
                updatePerfBar('perf-disk', data.diskPercent);
            });

            socket.on('desktop_file_upload_ack', (data) => {
                if (data.deviceId !== deviceId) return;
                const el = document.getElementById('upload-status');
                if (data.success) {
                    el.textContent = 'Uploaded to: ' + data.path;
                    el.style.color = '#66bb6a';
                } else {
                    el.textContent = 'Failed: ' + data.error;
                    el.style.color = '#ef5350';
                }
            });
        }

        // --- Input handling ---

        function getCanvasCoords(e) {
            const rect = canvas.getBoundingClientRect();
            return {
                x: (e.clientX - rect.left) / rect.width,
                y: (e.clientY - rect.top) / rect.height
            };
        }

        canvas.addEventListener('mousedown', (e) => {
            if (!active || !socket) return;
            if (!itInputEnabled) return;
            e.preventDefault();
            viewer.focus();
            const pos = getCanvasCoords(e);
            const btn = e.button === 2 ? 'right' : e.button === 1 ? 'middle' : 'left';
            socket.emit('desktop_mouse', { deviceId, x: pos.x, y: pos.y, button: btn, action: 'down' });
        });

        canvas.addEventListener('mouseup', (e) => {
            if (!active || !socket) return;
            if (!itInputEnabled) return;
            e.preventDefault();
            const pos = getCanvasCoords(e);
            const btn = e.button === 2 ? 'right' : e.button === 1 ? 'middle' : 'left';
            socket.emit('desktop_mouse', { deviceId, x: pos.x, y: pos.y, button: btn, action: 'up' });
        });

        let lastMove = 0;
        canvas.addEventListener('mousemove', (e) => {
            if (!active || !socket) return;
            if (!itInputEnabled) return;
            const now = Date.now();
            if (now - lastMove < 33) return;
            lastMove = now;
            const pos = getCanvasCoords(e);
            socket.emit('desktop_mouse', { deviceId, x: pos.x, y: pos.y, button: 'left', action: 'move' });
        });

        canvas.addEventListener('wheel', (e) => {
            if (!active || !socket) return;
            if (!itInputEnabled) return;
            e.preventDefault();
            const pos = getCanvasCoords(e);
            socket.emit('desktop_mouse', { deviceId, x: pos.x, y: pos.y, button: e.deltaY < 0 ? 'up' : 'down', action: 'scroll' });
        }, { passive: false });

        canvas.addEventListener('contextmenu', (e) => e.preventDefault());

        viewer.addEventListener('keydown', (e) => {
            if (!active || !socket) return;
            if (!itInputEnabled) return;
            if (e.target.tagName === 'TEXTAREA' || e.target.tagName === 'INPUT') return;
            e.preventDefault();
            socket.emit('desktop_keyboard', { deviceId, vkCode: e.keyCode, action: 'down' });
        });

        viewer.addEventListener('keyup', (e) => {
            if (!active || !socket) return;
            if (!itInputEnabled) return;
            if (e.target.tagName === 'TEXTAREA' || e.target.tagName === 'INPUT') return;
            e.preventDefault();
            socket.emit('desktop_keyboard', { deviceId, vkCode: e.keyCode, action: 'up' });
        });

        function updateQuality() {
            if (!active || !socket) return;
            socket.emit('desktop_quality', {
                deviceId,
                quality: parseInt(document.getElementById('quality').value),
                fps: parseInt(document.getElementById('fps').value),
                scale: parseFloat(document.getElementById('scale').value)
            });
        }

        function disconnect() {
            if (socket) {
                socket.emit('stop_desktop', { deviceId });
                active = false;
                overlay.textContent = 'Disconnected';
                overlay.classList.remove('hidden');
                statusEl.textContent = 'Disconnected';
                statusEl.style.color = '#ef5350';
            }
        }

        window.addEventListener('beforeunload', () => {
            if (active && socket) {
                socket.emit('stop_desktop', { deviceId });
            }
        });

        init();

        // ---- Event handler bindings ----
        document.addEventListener('DOMContentLoaded', () => {
            document.getElementById('quality').addEventListener('change', updateQuality);
            document.getElementById('fps').addEventListener('change', updateQuality);
            document.getElementById('scale').addEventListener('change', updateQuality);
            document.getElementById('btn-sidebar').addEventListener('click', toggleSidebar);
            document.getElementById('btn-disconnect').addEventListener('click', disconnect);
            document.getElementById('btn-ctrl-alt-del').addEventListener('click', sendCtrlAltDel);
            document.getElementById('btn-paste-keystrokes').addEventListener('click', pasteClipboardAsKeystrokes);
            document.getElementById('upload-zone').addEventListener('click', () => document.getElementById('upload-input').click());
            document.getElementById('upload-input').addEventListener('change', function() { handleFileSelect(this); });

            // Sidebar section headers — event delegation
            document.getElementById('sidebar').addEventListener('click', (e) => {
                const header = e.target.closest('.sidebar-section-header');
                if (header) toggleSection(header);
            });

            // Tool buttons — event delegation via data-tool
            document.getElementById('sidebar').addEventListener('click', (e) => {
                const btn = e.target.closest('[data-tool]');
                if (btn) launchTool(btn.dataset.tool);
            });

            // Toggle switches — event delegation via data-toggle
            document.getElementById('sidebar').addEventListener('click', (e) => {
                const toggle = e.target.closest('[data-toggle]');
                if (toggle) handleToggle(toggle.dataset.toggle, toggle);
            });
        });
