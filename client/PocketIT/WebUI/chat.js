// Pocket IT Chat UI
(function() {
    const messagesEl = document.getElementById('messages');
    const inputEl = document.getElementById('message-input');
    const sendBtn = document.getElementById('send-btn');
    const statusEl = document.getElementById('status');

    let agentName = 'Pocket IT';

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

        // Action buttons (remediation approval)
        if (options.action && options.action.type === 'remediate') {
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

        return card;
    }

    function createActionButtons(action) {
        const container = document.createElement('div');
        container.className = 'action-buttons';

        const approveBtn = document.createElement('button');
        approveBtn.className = 'action-button approve';
        approveBtn.textContent = 'Approve';
        approveBtn.onclick = () => {
            sendBridgeMessage('approve_remediation', { actionId: action.actionId });
            container.textContent = '';
            const span = document.createElement('span');
            span.style.cssText = 'color: #66bb6a; font-size: 13px;';
            span.textContent = 'Approved \u2014 running...';
            container.appendChild(span);
        };

        const denyBtn = document.createElement('button');
        denyBtn.className = 'action-button deny';
        denyBtn.textContent = 'Deny';
        denyBtn.onclick = () => {
            sendBridgeMessage('deny_remediation', { actionId: action.actionId });
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

    // ---- Typing indicator ----

    let typingEl = null;

    function showTyping() {
        if (typingEl) return;
        typingEl = document.createElement('div');
        typingEl.className = 'message ai';
        typingEl.innerHTML = `<div class="sender">${agentName}</div><div class="typing-indicator"><span></span><span></span><span></span></div>`;
        messagesEl.appendChild(typingEl);
        messagesEl.scrollTop = messagesEl.scrollHeight;
    }

    function hideTyping() {
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
        } else {
            showTyping();
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

    // Listen for messages from C# bridge
    if (window.chrome && window.chrome.webview) {
        window.chrome.webview.addEventListener('message', (event) => {
            const data = JSON.parse(event.data);

            switch (data.type) {
                case 'chat_response':
                    hideTyping();
                    if (data.agentName) agentName = data.agentName;
                    addMessage(data.text || data.content, data.sender || 'ai', {
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

                case 'remediation_result':
                    hideTyping();
                    if (data.success) {
                        addMessage(`Action completed successfully: ${data.message}`, 'system');
                    } else {
                        addMessage(`Action failed: ${data.message}`, 'system');
                    }
                    break;

                default:
                    console.log('Unknown message type:', data.type);
            }
        });
    }

    // Welcome message — will be replaced by server greeting once connected
    addMessage('Connecting to Pocket IT...', 'system');
})();
