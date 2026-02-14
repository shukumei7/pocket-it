const { getSystemPrompt, getAgentName } = require('../ai/systemPrompt');
const { parseResponse } = require('../ai/decisionEngine');

class DiagnosticAI {
  constructor(llmService, db) {
    this.llm = llmService;
    this.db = db;
    // In-memory conversation contexts per device (last N messages)
    this.contexts = new Map();
    this.maxContextMessages = 20;
  }

  getOrCreateContext(deviceId, deviceInfo) {
    if (!this.contexts.has(deviceId)) {
      const agentName = getAgentName(deviceId);
      this.contexts.set(deviceId, {
        agentName,
        deviceInfo,
        messages: [],
        isFirstMessage: true
      });
    }
    return this.contexts.get(deviceId);
  }

  async processMessage(deviceId, userMessage, deviceInfo) {
    const ctx = this.getOrCreateContext(deviceId, deviceInfo);

    // Add user message to context
    ctx.messages.push({ role: 'user', content: userMessage });

    // Trim context if too long
    if (ctx.messages.length > this.maxContextMessages) {
      ctx.messages = ctx.messages.slice(-this.maxContextMessages);
    }

    // Build messages array for LLM
    const systemPrompt = getSystemPrompt(ctx.deviceInfo, ctx.agentName);
    const llmMessages = [
      { role: 'system', content: systemPrompt },
      ...ctx.messages
    ];

    // If first message, prepend instruction to introduce with name
    if (ctx.isFirstMessage) {
      llmMessages[0].content += '\n\nIMPORTANT: This is your first interaction with this user. Greet them warmly and introduce yourself by name. Vary your greeting style — sometimes casual, sometimes professional. Examples: "Hi there! I\'m Rick, your IT assistant.", "Good to meet you! My name\'s Mabel and I\'m here to help.", "Hey! I\'m Jordan from Pocket IT — what\'s going on?"';
      ctx.isFirstMessage = false;
    }

    try {
      // Call LLM
      const rawResponse = await this.llm.chat(llmMessages);

      // Parse for actions
      const parsed = parseResponse(rawResponse);

      // Add assistant response to context
      ctx.messages.push({ role: 'assistant', content: rawResponse });

      // Save to database
      this._saveMessage(deviceId, 'user', userMessage);
      this._saveMessage(deviceId, 'ai', parsed.text, parsed.action);

      return {
        text: parsed.text,
        action: parsed.action,
        agentName: ctx.agentName
      };
    } catch (err) {
      console.error('DiagnosticAI error:', err.message);
      return {
        text: `I'm having trouble connecting to my brain right now. Let me try again in a moment, or you can describe your issue again.`,
        action: null,
        agentName: ctx.agentName
      };
    }
  }

  // Feed diagnostic results back into conversation
  async processDiagnosticResult(deviceId, checkType, results) {
    const ctx = this.getOrCreateContext(deviceId, {});

    const resultText = `[DIAGNOSTIC RESULTS - ${checkType}]\n${JSON.stringify(results, null, 2)}`;
    ctx.messages.push({ role: 'user', content: resultText });

    const systemPrompt = getSystemPrompt(ctx.deviceInfo, ctx.agentName);
    const llmMessages = [
      { role: 'system', content: systemPrompt },
      ...ctx.messages
    ];

    try {
      const rawResponse = await this.llm.chat(llmMessages);
      const parsed = parseResponse(rawResponse);
      ctx.messages.push({ role: 'assistant', content: rawResponse });
      this._saveMessage(deviceId, 'ai', parsed.text, parsed.action);

      return {
        text: parsed.text,
        action: parsed.action,
        agentName: ctx.agentName
      };
    } catch (err) {
      console.error('DiagnosticAI processDiagnosticResult error:', err.message);
      return {
        text: 'I received the diagnostic results but had trouble analyzing them. Could you describe what you\'re experiencing?',
        action: null,
        agentName: ctx.agentName
      };
    }
  }

  _saveMessage(deviceId, sender, content, action) {
    try {
      const metadata = action ? JSON.stringify(action) : null;
      const messageType = action ? action.type : 'text';
      this.db.prepare(
        'INSERT INTO chat_messages (device_id, sender, content, message_type, metadata) VALUES (?, ?, ?, ?, ?)'
      ).run(deviceId, sender, content, messageType, metadata);
    } catch (err) {
      console.error('Failed to save message:', err.message);
    }
  }

  // Get the assigned agent name for a device
  getAgentNameForDevice(deviceId) {
    return getAgentName(deviceId);
  }

  clearContext(deviceId) {
    this.contexts.delete(deviceId);
  }
}

module.exports = DiagnosticAI;
