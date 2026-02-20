const { getSystemPrompt, getAgentName } = require('../ai/systemPrompt');
const { parseResponse } = require('../ai/decisionEngine');
const { getITGuidancePrompt } = require('../ai/itGuidancePrompt');

function sanitizeForLLM(text) {
  return text
    .replace(/\[ACTION:[A-Z_]+(?::[^\]]+)?\]/gi, '[BLOCKED_TAG]')
    .replace(/\[DIAGNOSTIC RESULTS[^\]]*\]/gi, '[BLOCKED_TAG]')
    .replace(/<\/?(user_message|it_guidance|system|assistant|tool_result)[^>]*>/gi, '[BLOCKED_TAG]')
    .replace(/^(system|assistant|user)\s*:/gim, '[BLOCKED_TAG]:');
}

function sanitizeDiagnosticData(data) {
  if (typeof data === 'string') return sanitizeForLLM(data);
  if (Array.isArray(data)) return data.map(sanitizeDiagnosticData);
  if (data && typeof data === 'object') {
    const sanitized = {};
    for (const [key, value] of Object.entries(data)) {
      sanitized[key] = sanitizeDiagnosticData(value);
    }
    return sanitized;
  }
  return data;
}

class DiagnosticAI {
  constructor(llmService, db) {
    this.llm = llmService;
    this.db = db;
    // In-memory conversation contexts per device (last N messages)
    this.contexts = new Map();
    this.maxContextMessages = 20;
    // IT Guidance: separate conversation contexts per device
    this.itGuidanceContexts = new Map();
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
    ctx.messages.push({ role: 'user', content: `<user_message>${sanitizeForLLM(userMessage)}</user_message>` });

    // Trim context if too long
    if (ctx.messages.length > this.maxContextMessages) {
      ctx.messages = ctx.messages.slice(-this.maxContextMessages);
    }

    // Fetch AI-enabled scripts for system prompt
    const aiToolScripts = this.db.prepare('SELECT id, name, description, category FROM script_library WHERE ai_tool = 1').all();

    // Build messages array for LLM
    const systemPrompt = getSystemPrompt(ctx.deviceInfo, ctx.agentName, aiToolScripts);
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

    const sanitizedResults = sanitizeDiagnosticData(results);
    const resultText = `[DIAGNOSTIC RESULTS - ${sanitizeForLLM(checkType)}]\n${JSON.stringify(sanitizedResults, null, 2)}`;
    ctx.messages.push({ role: 'user', content: resultText });

    const aiToolScripts = this.db.prepare('SELECT id, name, description, category FROM script_library WHERE ai_tool = 1').all();
    const systemPrompt = getSystemPrompt(ctx.deviceInfo, ctx.agentName, aiToolScripts);
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

  async processScreenshotResult(deviceId, imageBase64, width, height) {
    const ctx = this.getOrCreateContext(deviceId, {});

    // Check if provider supports vision
    const provider = this.llm.provider;
    const supportsVision = ['anthropic', 'openai', 'gemini'].includes(provider);

    if (supportsVision) {
      ctx.messages.push({
        role: 'user',
        content: '[SCREENSHOT received — analyze what you see on the user\'s screen. Describe any errors, issues, or relevant information visible.]',
        images: [{ data: imageBase64, mediaType: 'image/jpeg' }]
      });
    } else {
      ctx.messages.push({
        role: 'user',
        content: `[SCREENSHOT received (${width}x${height}) but your current provider (${provider}) does not support image analysis. Let the user know you received the screenshot but cannot visually analyze it. Ask them to describe what they see instead.]`
      });
    }

    if (ctx.messages.length > this.maxContextMessages) {
      ctx.messages = ctx.messages.slice(-this.maxContextMessages);
    }

    const aiToolScripts = this.db.prepare('SELECT id, name, description, category FROM script_library WHERE ai_tool = 1').all();
    const systemPrompt = getSystemPrompt(ctx.deviceInfo, ctx.agentName, aiToolScripts);
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
      console.error('DiagnosticAI processScreenshotResult error:', err.message);
      return {
        text: 'I received the screenshot but had trouble analyzing it. Could you describe what you see on your screen?',
        action: null,
        agentName: ctx.agentName
      };
    }
  }

  async processScriptResult(deviceId, scriptName, scriptOutput) {
    const ctx = this.getOrCreateContext(deviceId, {});

    const sanitizedOutput = sanitizeDiagnosticData(scriptOutput);
    const resultText = `[SCRIPT RESULT - ${sanitizeForLLM(scriptName)}]\n${typeof sanitizedOutput === 'string' ? sanitizedOutput : JSON.stringify(sanitizedOutput, null, 2)}`;
    ctx.messages.push({ role: 'user', content: resultText });

    if (ctx.messages.length > this.maxContextMessages) {
      ctx.messages = ctx.messages.slice(-this.maxContextMessages);
    }

    const aiToolScripts = this.db.prepare('SELECT id, name, description, category FROM script_library WHERE ai_tool = 1').all();
    const systemPrompt = getSystemPrompt(ctx.deviceInfo, ctx.agentName, aiToolScripts);
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
      console.error('DiagnosticAI processScriptResult error:', err.message);
      return {
        text: 'I received the script results but had trouble analyzing them. Could you describe what you\'re experiencing?',
        action: null,
        agentName: ctx.agentName
      };
    }
  }

  async processITGuidanceScreenshotResult(deviceId, imageBase64, width, height) {
    const ctx = this.getOrCreateITGuidanceContext(deviceId, {});

    // Check if provider supports vision
    const provider = this.llm.provider;
    const supportsVision = ['anthropic', 'openai', 'gemini'].includes(provider);

    if (supportsVision) {
      ctx.messages.push({
        role: 'user',
        content: '[SCREENSHOT received — analyze what you see on the user\'s screen. Describe any errors, issues, or relevant information visible.]',
        images: [{ data: imageBase64, mediaType: 'image/jpeg' }]
      });
    } else {
      ctx.messages.push({
        role: 'user',
        content: `[SCREENSHOT received (${width}x${height}) but your current provider (${provider}) does not support image analysis. Let the user know you received the screenshot but cannot visually analyze it. Ask them to describe what they see instead.]`
      });
    }

    if (ctx.messages.length > this.maxContextMessages) {
      ctx.messages = ctx.messages.slice(-this.maxContextMessages);
    }

    const systemPrompt = getITGuidancePrompt(ctx.deviceInfo, ctx.agentName);
    const llmMessages = [
      { role: 'system', content: systemPrompt },
      ...ctx.messages
    ];

    try {
      const rawResponse = await this.llm.chat(llmMessages);
      const parsed = parseResponse(rawResponse);
      ctx.messages.push({ role: 'assistant', content: rawResponse });
      this._saveMessage(deviceId, 'ai', parsed.text, parsed.action, 'it_guidance');

      return {
        text: parsed.text,
        action: parsed.action,
        agentName: ctx.agentName
      };
    } catch (err) {
      console.error('DiagnosticAI processITGuidanceScreenshotResult error:', err.message);
      return {
        text: 'I received the screenshot but had trouble analyzing it. Could you describe what you see instead?',
        action: null,
        agentName: ctx.agentName
      };
    }
  }

  // ---- IT Guidance Methods ----

  getOrCreateITGuidanceContext(deviceId, deviceInfo) {
    if (!this.itGuidanceContexts.has(deviceId)) {
      const agentName = getAgentName(deviceId);
      this.itGuidanceContexts.set(deviceId, {
        agentName,
        deviceInfo,
        messages: []
      });
    }
    return this.itGuidanceContexts.get(deviceId);
  }

  async processITGuidanceMessage(deviceId, itMessage, deviceInfo) {
    const ctx = this.getOrCreateITGuidanceContext(deviceId, deviceInfo);

    // Update device info if provided
    if (deviceInfo) ctx.deviceInfo = deviceInfo;

    ctx.messages.push({ role: 'user', content: `<it_guidance>${sanitizeForLLM(itMessage)}</it_guidance>` });

    if (ctx.messages.length > this.maxContextMessages) {
      ctx.messages = ctx.messages.slice(-this.maxContextMessages);
    }

    const systemPrompt = getITGuidancePrompt(ctx.deviceInfo, ctx.agentName);
    const llmMessages = [
      { role: 'system', content: systemPrompt },
      ...ctx.messages
    ];

    try {
      const rawResponse = await this.llm.chat(llmMessages);
      const parsed = parseResponse(rawResponse);
      ctx.messages.push({ role: 'assistant', content: rawResponse });

      // Save to DB with channel = 'it_guidance'
      this._saveMessage(deviceId, 'it_tech', itMessage, null, 'it_guidance');
      this._saveMessage(deviceId, 'ai', parsed.text, parsed.action, 'it_guidance');

      return {
        text: parsed.text,
        action: parsed.action,
        agentName: ctx.agentName
      };
    } catch (err) {
      console.error('DiagnosticAI IT guidance error:', err.message);
      return {
        text: 'Error processing guidance request. Check LLM connectivity.',
        action: null,
        agentName: ctx.agentName
      };
    }
  }

  async processITGuidanceDiagnosticResult(deviceId, checkType, results) {
    const ctx = this.getOrCreateITGuidanceContext(deviceId, {});

    const sanitizedResults = sanitizeDiagnosticData(results);
    const resultText = `[DIAGNOSTIC RESULTS - ${sanitizeForLLM(checkType)}]\n${JSON.stringify(sanitizedResults, null, 2)}`;
    ctx.messages.push({ role: 'user', content: resultText });

    const systemPrompt = getITGuidancePrompt(ctx.deviceInfo, ctx.agentName);
    const llmMessages = [
      { role: 'system', content: systemPrompt },
      ...ctx.messages
    ];

    try {
      const rawResponse = await this.llm.chat(llmMessages);
      const parsed = parseResponse(rawResponse);
      ctx.messages.push({ role: 'assistant', content: rawResponse });
      this._saveMessage(deviceId, 'ai', parsed.text, parsed.action, 'it_guidance');

      return {
        text: parsed.text,
        action: parsed.action,
        agentName: ctx.agentName
      };
    } catch (err) {
      console.error('DiagnosticAI IT guidance diagnostic error:', err.message);
      return {
        text: 'Error analyzing diagnostic results.',
        action: null,
        agentName: ctx.agentName
      };
    }
  }

  clearITGuidanceContext(deviceId) {
    this.itGuidanceContexts.delete(deviceId);
  }

  _saveMessage(deviceId, sender, content, action, channel) {
    try {
      const metadata = action ? JSON.stringify(action) : null;
      const messageType = action ? action.type : 'text';
      this.db.prepare(
        'INSERT INTO chat_messages (device_id, sender, content, message_type, metadata, channel) VALUES (?, ?, ?, ?, ?, ?)'
      ).run(deviceId, sender, content, messageType, metadata, channel || 'user');
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
