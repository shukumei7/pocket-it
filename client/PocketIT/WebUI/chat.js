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

    function formatMessage(text) {
        // Basic markdown-lite: bold, italic, code
        return text
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
            container.innerHTML = '<span style="color: #66bb6a; font-size: 13px;">Approved — running...</span>';
        };

        const denyBtn = document.createElement('button');
        denyBtn.className = 'action-button deny';
        denyBtn.textContent = 'Deny';
        denyBtn.onclick = () => {
            sendBridgeMessage('deny_remediation', { actionId: action.actionId });
            container.innerHTML = '<span style="color: #ef5350; font-size: 13px;">Denied</span>';
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

    // ---- Send/receive ----

    function sendMessage() {
        const content = inputEl.value.trim();
        if (!content) return;
        addMessage(content, 'user');
        inputEl.value = '';
        showTyping();
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
                    addMessage(data.text || data.content, data.sender || 'ai', {
                        action: data.action,
                        diagnosticResults: data.diagnosticResults
                    });
                    break;

                case 'agent_info':
                    agentName = data.agentName || 'Pocket IT';
                    break;

                case 'connection_status':
                    if (data.connected) {
                        statusEl.className = 'online';
                        statusEl.textContent = 'Connected';
                    } else {
                        statusEl.className = 'offline';
                        statusEl.textContent = 'Disconnected';
                    }
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
