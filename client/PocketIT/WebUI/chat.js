// Pocket IT Chat UI
(function() {
    const messagesEl = document.getElementById('messages');
    const inputEl = document.getElementById('message-input');
    const sendBtn = document.getElementById('send-btn');
    const statusEl = document.getElementById('status');

    let agentName = 'Pocket IT';
    let aiEnabled = true;

    // ---- Message rendering ----

    function addMessage(content, sender, options = {}) {
        const div = document.createElement('div');
        div.className = `message ${sender}`;

        if (sender !== 'system') {
            const senderLabel = document.createElement('div');
            senderLabel.className = 'sender';
            senderLabel.textContent = sender === 'user' ? 'You' : sender === 'ai' ? agentName : 'IT Support';
            div.appendChild(senderLabel);
        }

        const text = document.createElement('div');
        text.innerHTML = formatMessage(content);
        div.appendChild(text);

        // Diagnostic card
        if (options.diagnosticResults) {
            div.appendChild(createDiagnosticCard(options.diagnosticResults));
        }

        // Action buttons (remediation and diagnostic approval)
        if (options.action && (options.action.type === 'remediate' || options.action.type === 'diagnostic')) {
            div.appendChild(createActionButtons(options.action));
        }

        // Timestamp
        const ts = document.createElement('div');
        ts.className = 'timestamp';
        ts.textContent = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
        div.appendChild(ts);

        messagesEl.appendChild(div);
        messagesEl.scrollTop = messagesEl.scrollHeight;
        return div;
    }

    function appendToChat(element) {
        messagesEl.appendChild(element);
        messagesEl.scrollTop = messagesEl.scrollHeight;
    }

    function escapeHtml(text) {
        const div = document.createElement('div');
        div.textContent = text;
        return div.innerHTML;
    }

    function formatMessage(text) {
        // Escape HTML entities FIRST to prevent XSS
        let safe = escapeHtml(text);
        // Then apply markdown-lite formatting on the escaped text
        return safe
            .replace(/\*\*(.*?)\*\*/g, '<strong>$1</strong>')
            .replace(/\*(.*?)\*/g, '<em>$1</em>')
            .replace(/`(.*?)`/g, '<code>$1</code>')
            .replace(/\n/g, '<br>');
    }

    function createProcessTable(processes) {
        if (!processes || !processes.length) return '';
        let html = '<table class="process-table"><thead><tr><th>Name</th><th>PID</th><th>CPU %</th><th>Memory</th></tr></thead><tbody>';
        processes.forEach(p => {
            const isWarn = p.cpuPercent > 50 || p.memoryMB > 2048;
            html += `<tr class="${isWarn ? 'warn-row' : ''}">`;
            html += `<td>${escapeHtml(p.name)}</td>`;
            html += `<td>${p.pid}</td>`;
            html += `<td>${p.cpuPercent.toFixed(1)}%</td>`;
            html += `<td>${p.memoryMB.toFixed(0)} MB</td>`;
            html += '</tr>';
        });
        html += '</tbody></table>';
        return html;
    }

    function createEventLogList(entries) {
        if (!entries || !entries.length) return '<div class="event-log-empty">No errors found</div>';
        let html = '<div class="event-log-list">';
        entries.forEach(e => {
            const badgeClass = e.level === 'Critical' ? 'critical' : 'error';
            html += '<div class="event-log-entry">';
            html += `<span class="event-timestamp">${escapeHtml(e.timestamp || '')}</span> `;
            html += `<span class="level-badge ${badgeClass}">${escapeHtml(e.level)}</span> `;
            html += `<span class="event-source">${escapeHtml(e.source || '')}</span>: `;
            html += `<span class="event-message">${escapeHtml(e.message || '')}</span>`;
            html += '</div>';
        });
        html += '</div>';
        return html;
    }

    function createSoftwareList(programs) {
        if (!programs || !programs.length) return '';
        let html = '<div class="software-list">';
        html += '<input type="text" class="software-filter" placeholder="Filter software..." oninput="window._filterSoftwareList(this)">';
        html += '<div class="software-items">';
        programs.forEach(p => {
            html += '<div class="software-item">';
            html += `<span class="software-name">${escapeHtml(p.name)}</span>`;
            if (p.version) html += ` <span class="software-version">${escapeHtml(p.version)}</span>`;
            if (p.publisher) html += ` <span class="software-publisher">— ${escapeHtml(p.publisher)}</span>`;
            html += '</div>';
        });
        html += '</div></div>';
        return html;
    }

    window._filterSoftwareList = function(input) {
        const filter = input.value.toLowerCase();
        const items = input.parentElement.querySelectorAll('.software-item');
        items.forEach(item => {
            const text = item.textContent.toLowerCase();
            item.style.display = text.includes(filter) ? '' : 'none';
        });
    };

    function createServicesList(stoppedServices) {
        if (!stoppedServices || !stoppedServices.length) return '<div class="services-ok">All auto-start services running</div>';
        let html = '<div class="services-list">';
        stoppedServices.forEach(s => {
            html += '<div class="service-stopped-item">';
            html += `<span class="service-status-badge stopped">STOPPED</span> `;
            html += `<span class="service-name">${escapeHtml(s.displayName || s.name)}</span>`;
            html += ` <span class="service-id">(${escapeHtml(s.name)})</span>`;
            html += '</div>';
        });
        html += '</div>';
        return html;
    }

    function createDiagnosticCard(results) {
        const card = document.createElement('div');
        card.className = 'diagnostic-card';

        if (Array.isArray(results)) {
            results.forEach(item => {
                const row = document.createElement('div');
                row.className = 'check-item';

                const label = document.createElement('span');
                label.textContent = item.label || item.checkType || 'Check';
                row.appendChild(label);

                const status = document.createElement('span');
                status.className = `status-${item.status === 'ok' ? 'ok' : item.status === 'warning' ? 'warn' : 'error'}`;
                status.textContent = item.value || item.status;
                row.appendChild(status);

                card.appendChild(row);
            });
        } else if (typeof results === 'object') {
            Object.entries(results).forEach(([key, value]) => {
                const row = document.createElement('div');
                row.className = 'check-item';

                const label = document.createElement('span');
                label.textContent = key;
                row.appendChild(label);

                const val = document.createElement('span');
                val.textContent = typeof value === 'object' ? JSON.stringify(value) : String(value);
                row.appendChild(val);

                card.appendChild(row);
            });
        }

        // Render detail panels for specific check types
        const detailSource = Array.isArray(results) ? null : results;
        if (detailSource) {
            if (detailSource.processes) {
                const div = document.createElement('div');
                div.innerHTML = createProcessTable(detailSource.processes);
                card.appendChild(div);
            }
            if (detailSource.entries) {
                const div = document.createElement('div');
                div.innerHTML = createEventLogList(detailSource.entries);
                card.appendChild(div);
            }
            if (detailSource.programs) {
                const div = document.createElement('div');
                div.innerHTML = createSoftwareList(detailSource.programs);
                card.appendChild(div);
            }
            if (detailSource.stoppedAutoServices) {
                const div = document.createElement('div');
                div.innerHTML = createServicesList(detailSource.stoppedAutoServices);
                card.appendChild(div);
            }
        }

        return card;
    }

    function createActionButtons(action) {
        const container = document.createElement('div');
        container.className = 'action-buttons';

        const approveBtn = document.createElement('button');
        approveBtn.className = 'action-button approve';
        approveBtn.textContent = 'Approve';
        approveBtn.onclick = () => {
            const msgType = action.type === 'diagnostic' ? 'approve_diagnostic' : 'approve_remediation';
            const payload = action.type === 'diagnostic'
                ? { checkType: action.checkType, requestId: action.requestId }
                : { actionId: action.actionId, requestId: action.requestId, parameter: action.parameter || null };
            sendBridgeMessage(msgType, payload);
            container.textContent = '';
            const span = document.createElement('span');
            span.style.cssText = 'color: #66bb6a; font-size: 13px;';
            span.textContent = action.type === 'diagnostic' ? 'Approved \u2014 running diagnostic...' : 'Approved \u2014 running...';
            container.appendChild(span);
        };

        const denyBtn = document.createElement('button');
        denyBtn.className = 'action-button deny';
        denyBtn.textContent = 'Deny';
        denyBtn.onclick = () => {
            const msgType = action.type === 'diagnostic' ? 'deny_diagnostic' : 'deny_remediation';
            const payload = action.type === 'diagnostic'
                ? { checkType: action.checkType, requestId: action.requestId }
                : { actionId: action.actionId, requestId: action.requestId };
            sendBridgeMessage(msgType, payload);
            container.textContent = '';
            const span = document.createElement('span');
            span.style.cssText = 'color: #ef5350; font-size: 13px;';
            span.textContent = 'Denied';
            container.appendChild(span);
        };

        container.appendChild(approveBtn);
        container.appendChild(denyBtn);
        return container;
    }

    function createFileAccessPrompt(operation, path, requestId) {
        const card = document.createElement('div');
        card.className = 'action-card';

        const icon = operation === 'browse' ? '\uD83D\uDCC1' : '\uD83D\uDCC4';
        const opLabel = operation === 'browse' ? 'Browse Directory' : 'Read File';

        card.innerHTML = `
            <div class="action-header">
                <strong>${icon} File Access Request</strong>
            </div>
            <div class="action-body" style="margin: 8px 0;">
                <div style="font-size: 13px; color: #8f98a0;">Operation: <strong>${opLabel}</strong></div>
                <div style="font-size: 13px; color: #66c0f4; font-family: monospace; word-break: break-all; margin-top: 4px;">${escapeHtml(path)}</div>
                <div style="font-size: 11px; color: #8f98a0; margin-top: 4px;">IT staff is requesting access to this ${operation === 'browse' ? 'directory' : 'file'}.</div>
            </div>
        `;

        const btnRow = document.createElement('div');
        btnRow.className = 'action-buttons';

        const approveBtn = document.createElement('button');
        approveBtn.className = 'btn-approve';
        approveBtn.textContent = 'Allow';
        approveBtn.onclick = () => {
            sendBridgeMessage('approve_file_access', { requestId, operation, path });
            approveBtn.disabled = true;
            denyBtn.disabled = true;
            btnRow.innerHTML = '<span style="color: #66bb6a; font-size: 12px;">Allowed</span>';
        };

        const denyBtn = document.createElement('button');
        denyBtn.className = 'btn-deny';
        denyBtn.textContent = 'Deny';
        denyBtn.onclick = () => {
            sendBridgeMessage('deny_file_access', { requestId, operation, path });
            approveBtn.disabled = true;
            denyBtn.disabled = true;
            btnRow.innerHTML = '<span style="color: #ef5350; font-size: 12px;">Denied</span>';
        };

        btnRow.appendChild(approveBtn);
        btnRow.appendChild(denyBtn);
        card.appendChild(btnRow);
        return card;
    }

    function createScriptPrompt(scriptName, scriptContent, requiresElevation, timeoutSeconds, requestId) {
        const card = document.createElement('div');
        card.className = 'action-card';

        card.innerHTML = `
            <div class="action-header">
                <strong>\uD83D\uDCDC Script Execution Request</strong>
                ${requiresElevation ? '<span style="background:#4a1919; color:#ef5350; font-size:10px; padding:2px 6px; border-radius:4px; margin-left:8px;">ADMIN</span>' : ''}
            </div>
            <div class="action-body" style="margin: 8px 0;">
                <div style="font-size: 13px; color: #8f98a0;">Script: <strong style="color: #c7d5e0;">${escapeHtml(scriptName)}</strong></div>
                <div style="font-size: 11px; color: #8f98a0; margin-top: 2px;">Timeout: ${timeoutSeconds}s</div>
                <pre style="background: #0a0f14; border: 1px solid #2a475e; border-radius: 4px; padding: 8px; margin-top: 8px; font-size: 11px; max-height: 200px; overflow: auto; white-space: pre-wrap; color: #a8b4c0;">${escapeHtml(scriptContent)}</pre>
                <div style="font-size: 11px; color: #ffa726; margin-top: 4px;">IT staff wants to run this script on your computer. Review the content before approving.</div>
            </div>
        `;

        const btnRow = document.createElement('div');
        btnRow.className = 'action-buttons';

        const approveBtn = document.createElement('button');
        approveBtn.className = 'btn-approve';
        approveBtn.textContent = 'Run Script';
        approveBtn.onclick = () => {
            sendBridgeMessage('approve_script', { requestId, scriptName, scriptContent, requiresElevation, timeoutSeconds });
            approveBtn.disabled = true;
            denyBtn.disabled = true;
            btnRow.innerHTML = '<span style="color: #66bb6a; font-size: 12px;">Running...</span>';
        };

        const denyBtn = document.createElement('button');
        denyBtn.className = 'btn-deny';
        denyBtn.textContent = 'Deny';
        denyBtn.onclick = () => {
            sendBridgeMessage('deny_script', { requestId, scriptName });
            approveBtn.disabled = true;
            denyBtn.disabled = true;
            btnRow.innerHTML = '<span style="color: #ef5350; font-size: 12px;">Denied</span>';
        };

        btnRow.appendChild(approveBtn);
        btnRow.appendChild(denyBtn);
        card.appendChild(btnRow);
        return card;
    }

    function createTerminalPrompt(requestId) {
        const card = document.createElement('div');
        card.className = 'action-card';

        card.innerHTML = `
            <div class="action-header">
                <strong>\uD83D\uDCBB Remote Terminal Request</strong>
            </div>
            <div class="action-body" style="margin: 8px 0;">
                <div style="font-size: 13px; color: #c7d5e0;">IT staff wants to open a remote terminal session on your computer.</div>
                <div style="font-size: 13px; color: #8f98a0; margin-top: 4px;">They will be able to run commands interactively.</div>
                <div style="font-size: 11px; color: #ffa726; margin-top: 4px;">You can end the session at any time.</div>
            </div>
        `;

        const btnRow = document.createElement('div');
        btnRow.className = 'action-buttons';

        const approveBtn = document.createElement('button');
        approveBtn.className = 'btn-approve';
        approveBtn.textContent = 'Allow';
        approveBtn.onclick = () => {
            sendBridgeMessage('approve_terminal', { requestId });
            approveBtn.disabled = true;
            denyBtn.disabled = true;
            btnRow.innerHTML = '<span style="color: #66bb6a; font-size: 12px;">Allowed \u2014 session starting...</span>';
        };

        const denyBtn = document.createElement('button');
        denyBtn.className = 'btn-deny';
        denyBtn.textContent = 'Deny';
        denyBtn.onclick = () => {
            sendBridgeMessage('deny_terminal', { requestId });
            approveBtn.disabled = true;
            denyBtn.disabled = true;
            btnRow.innerHTML = '<span style="color: #ef5350; font-size: 12px;">Denied</span>';
        };

        btnRow.appendChild(approveBtn);
        btnRow.appendChild(denyBtn);
        card.appendChild(btnRow);
        return card;
    }

    function showTerminalActive() {
        hideTerminalActive();
        const banner = document.createElement('div');
        banner.className = 'terminal-active-banner';
        banner.id = 'terminal-active-banner';

        const label = document.createElement('span');
        label.textContent = '\uD83D\uDCBB Remote terminal session active';
        banner.appendChild(label);

        const endBtn = document.createElement('button');
        endBtn.className = 'terminal-end-btn';
        endBtn.textContent = 'End Session';
        endBtn.onclick = () => {
            sendBridgeMessage('end_terminal', {});
        };
        banner.appendChild(endBtn);

        messagesEl.parentElement.insertBefore(banner, messagesEl);
    }

    function hideTerminalActive() {
        const existing = document.getElementById('terminal-active-banner');
        if (existing) {
            existing.remove();
            addMessage('Terminal session ended.', 'system');
        }
    }

    // ---- Typing indicator ----

    let typingEl = null;
    let typingTimer = null;

    function showTyping() {
        if (typingEl) return;
        typingEl = document.createElement('div');
        typingEl.className = 'message ai';
        typingEl.innerHTML = `<div class="sender">${agentName}</div><div class="typing-indicator"><span></span><span></span><span></span></div>`;
        messagesEl.appendChild(typingEl);
        messagesEl.scrollTop = messagesEl.scrollHeight;
    }

    function showTypingDelayed() {
        clearTimeout(typingTimer);
        typingTimer = setTimeout(showTyping, 2000);
    }

    function hideTyping() {
        clearTimeout(typingTimer);
        typingTimer = null;
        if (typingEl) {
            typingEl.remove();
            typingEl = null;
        }
    }

    // ---- Offline responses ----

    let isConnected = false;

    // Configurable contact info — IT admins can customize these in appsettings.json
    // For now, placeholders that the C# bridge can override via 'offline_config' message
    let offlineContacts = {
        phone: '',
        email: '',
        portal: ''
    };

    function contactBlock() {
        const lines = [];
        if (offlineContacts.phone) lines.push(`Phone: **${offlineContacts.phone}**`);
        if (offlineContacts.email) lines.push(`Email: **${offlineContacts.email}**`);
        if (offlineContacts.portal) lines.push(`Portal: **${offlineContacts.portal}**`);
        if (lines.length === 0) lines.push('Please contact your IT department directly for urgent issues.');
        return '\n\n' + lines.join('\n');
    }

    const offlineResponses = [
        () => "Hey there! I'm sorry, but I can't reach the server right now. Your message has been saved and I'll process it once we're back online.\n\nIn the meantime, if this is urgent you can reach IT support directly:" + contactBlock(),
        () => "Hi! Unfortunately the server is offline at the moment. Your message is queued and I'll get right on it once the connection is restored.\n\nFor immediate help:" + contactBlock(),
        () => "Sorry about this — the server appears to be down. I've saved your message and will respond once we reconnect.\n\nIf you need help right away:" + contactBlock(),
        () => "Looks like we've lost connection to the server. Your message is saved and queued for when we're back.\n\nNeed help now? You can reach IT directly:" + contactBlock(),
        () => "I'm having trouble reaching the server. Your message is stored locally and will be sent when the connection returns.\n\nFor urgent issues, please contact:" + contactBlock(),
        () => "Apologies! The server is down right now, so I can't process your request. It's saved and will go through once we reconnect.\n\nIn the meantime:" + contactBlock(),
        () => "Hey! I'm currently offline. Your message is saved though — I'll pick up where we left off once the connection is restored.\n\nIf this can't wait:" + contactBlock(),
        () => "Oh no — the server seems to be taking a break! Your message is safely queued.\n\nFor immediate assistance, you can reach IT support here:" + contactBlock()
    ];
    let offlineResponseIndex = 0;

    function getOfflineResponse() {
        const responseFn = offlineResponses[offlineResponseIndex];
        offlineResponseIndex = (offlineResponseIndex + 1) % offlineResponses.length;
        return responseFn();
    }

    // ---- Send/receive ----

    function sendMessage() {
        const content = inputEl.value.trim();
        if (!content) return;
        addMessage(content, 'user');
        inputEl.value = '';

        if (!isConnected) {
            // Offline: show canned response after a brief delay
            setTimeout(() => {
                addMessage(getOfflineResponse(), 'ai');
            }, 500);
        } else if (!aiEnabled) {
            addMessage('Your message has been sent to IT support. A technician will respond shortly.', 'system');
        } else {
            showTypingDelayed();
        }

        // Always send to bridge (C# will queue if offline)
        sendBridgeMessage('chat_message', { content });
    }

    function sendBridgeMessage(type, data) {
        if (window.chrome && window.chrome.webview) {
            window.chrome.webview.postMessage(JSON.stringify({ type, ...data }));
        }
    }

    sendBtn.addEventListener('click', sendMessage);
    inputEl.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' && !e.shiftKey) {
            e.preventDefault();
            sendMessage();
        }
    });

    document.getElementById('clear-btn').addEventListener('click', () => {
        messagesEl.innerHTML = '';
        addMessage('Chat cleared. Start a new conversation.', 'system');
        sendBridgeMessage('clear_chat', {});
    });

    // Listen for messages from C# bridge
    if (window.chrome && window.chrome.webview) {
        window.chrome.webview.addEventListener('message', (event) => {
            const data = JSON.parse(event.data);

            switch (data.type) {
                case 'chat_response':
                    hideTyping();
                    if (data.agentName) agentName = data.agentName;
                    addMessage(data.text || data.content, data.ai_disabled ? 'system' : (data.sender || 'ai'), {
                        action: data.action,
                        diagnosticResults: data.diagnosticResults
                    });
                    break;

                case 'agent_info':
                    agentName = data.agentName || 'Pocket IT';
                    break;

                case 'connection_status':
                    isConnected = data.connected;
                    if (data.connected) {
                        statusEl.className = 'online';
                        statusEl.textContent = 'Connected';
                        addMessage('Connected to ' + agentName + '. How can I help you today?', 'system');
                    } else {
                        statusEl.className = 'offline';
                        statusEl.textContent = 'Disconnected';
                    }
                    break;

                case 'offline_config':
                    if (data.phone) offlineContacts.phone = data.phone;
                    if (data.email) offlineContacts.email = data.email;
                    if (data.portal) offlineContacts.portal = data.portal;
                    break;

                case 'diagnostic_progress':
                    addMessage(`Running ${data.checkType} diagnostic...`, 'system');
                    break;

                case 'chat_history':
                    if (data.messages && Array.isArray(data.messages)) {
                        data.messages.forEach(function(msg) {
                            addMessage(msg.content, msg.sender);
                        });
                    }
                    break;

                case 'remediation_request':
                    var remDesc = data.description;
                    if (data.parameter) {
                        if (data.actionId === 'kill_process') {
                            remDesc += ` (PID: ${data.parameter})`;
                        } else if (data.actionId === 'restart_service') {
                            remDesc += `: ${data.parameter}`;
                        } else {
                            remDesc += ` (${data.parameter})`;
                        }
                    }
                    addMessage(`${agentName} wants to run: **${remDesc}**`, 'ai');
                    showApprovalBanner(remDesc, { type: 'remediate', actionId: data.actionId, requestId: data.requestId, parameter: data.parameter || null });
                    break;

                case 'diagnostic_request':
                    addMessage(`${agentName} wants to run: **${data.description || data.checkType}**`, 'ai');
                    showApprovalBanner(data.description || data.checkType, { type: 'diagnostic', checkType: data.checkType, requestId: data.requestId });
                    break;

                case 'file_access_request':
                    const fileCard = createFileAccessPrompt(data.operation, data.path, data.requestId);
                    appendToChat(fileCard);
                    break;

                case 'script_request':
                    const scriptCard = createScriptPrompt(data.scriptName, data.scriptContent, data.requiresElevation, data.timeoutSeconds, data.requestId);
                    appendToChat(scriptCard);
                    break;

                case 'terminal_start_request':
                    const terminalCard = createTerminalPrompt(data.requestId);
                    appendToChat(terminalCard);
                    break;

                case 'terminal_session_active':
                    showTerminalActive();
                    break;

                case 'terminal_session_ended':
                    hideTerminalActive();
                    break;

                case 'remediation_result':
                    hideTyping();
                    if (data.success) {
                        addMessage(`Action completed successfully: ${data.message}`, 'system');
                    } else {
                        addMessage(`Action failed: ${data.message}`, 'system');
                    }
                    break;

                case 'ai_status':
                    aiEnabled = data.enabled;
                    if (!data.enabled) {
                        const reason = data.reason === 'it_active'
                            ? 'An IT technician is actively helping you.'
                            : 'AI assistant is currently offline. Your messages will be sent to IT support.';
                        addMessage(reason, 'system');
                    }
                    break;

                case 'desktop_session_notify':
                    if (data.active) {
                        addMessage((data.username || 'IT Support') + ' is connecting to your device.', 'system');
                    } else {
                        addMessage((data.username || 'IT Support') + ' has left your device.', 'system');
                    }
                    break;

                default:
                    console.log('Unknown message type:', data.type);
            }
        });
    }

    // Approval banner container — sticky at top of chat scroll area
    const approvalBannersEl = document.createElement('div');
    approvalBannersEl.className = 'approval-banner-container';
    approvalBannersEl.id = 'approval-banners';
    messagesEl.insertBefore(approvalBannersEl, messagesEl.firstChild);

    function showApprovalBanner(description, action) {
        const isDialognostic = action.type === 'diagnostic';
        const banner = document.createElement('div');
        banner.className = 'approval-banner' + (isDialognostic ? ' diagnostic' : '');
        banner.id = 'approval-banner-' + action.requestId;

        const header = document.createElement('div');
        header.className = 'banner-header';

        const icon = document.createElement('span');
        icon.className = 'banner-icon';
        icon.textContent = isDialognostic ? '\uD83D\uDD0D' : '\u26A0\uFE0F';
        header.appendChild(icon);

        const label = document.createElement('span');
        label.className = 'banner-label';
        label.textContent = isDialognostic ? 'Diagnostic Request' : 'Remediation Request';
        header.appendChild(label);

        banner.appendChild(header);

        const desc = document.createElement('div');
        desc.className = 'banner-description';
        desc.textContent = description;
        banner.appendChild(desc);

        const actions = document.createElement('div');
        actions.className = 'banner-actions';

        function removeBanner() {
            banner.style.transition = 'opacity 0.4s';
            banner.style.opacity = '0';
            setTimeout(function() { banner.remove(); }, 400);
        }

        const approveBtn = document.createElement('button');
        approveBtn.className = 'banner-btn approve';
        approveBtn.textContent = 'Approve';
        approveBtn.onclick = function() {
            const msgType = isDialognostic ? 'approve_diagnostic' : 'approve_remediation';
            const payload = isDialognostic
                ? { checkType: action.checkType, requestId: action.requestId }
                : { actionId: action.actionId, requestId: action.requestId, parameter: action.parameter || null };
            sendBridgeMessage(msgType, payload);
            actions.innerHTML = '';
            const result = document.createElement('div');
            result.className = 'banner-result';
            result.style.color = '#66bb6a';
            result.textContent = isDialognostic ? 'Approved \u2014 running diagnostic...' : 'Approved \u2014 running...';
            banner.appendChild(result);
            setTimeout(removeBanner, 2000);
        };

        const denyBtn = document.createElement('button');
        denyBtn.className = 'banner-btn deny';
        denyBtn.textContent = 'Deny';
        denyBtn.onclick = function() {
            const msgType = isDialognostic ? 'deny_diagnostic' : 'deny_remediation';
            const payload = isDialognostic
                ? { checkType: action.checkType, requestId: action.requestId }
                : { actionId: action.actionId, requestId: action.requestId };
            sendBridgeMessage(msgType, payload);
            actions.innerHTML = '';
            const result = document.createElement('div');
            result.className = 'banner-result';
            result.style.color = '#ef5350';
            result.textContent = 'Denied';
            banner.appendChild(result);
            setTimeout(removeBanner, 2000);
        };

        actions.appendChild(approveBtn);
        actions.appendChild(denyBtn);
        banner.appendChild(actions);

        approvalBannersEl.prepend(banner);
    }

    // Welcome message — will be replaced by server greeting once connected
    addMessage('Connecting to Pocket IT...', 'system');
})();
