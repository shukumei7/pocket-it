const { spawn } = require('child_process');

class LLMService {
  constructor(config) {
    this.provider = config.provider || 'ollama'; // 'openai', 'anthropic', 'claude-cli', 'gemini', or 'ollama'
    this.ollamaUrl = config.ollamaUrl || 'http://localhost:11434';
    this.openaiKey = config.openaiKey || '';
    this.openaiModel = config.openaiModel || 'gpt-4o-mini';
    this.anthropicKey = config.anthropicKey || '';
    this.anthropicModel = config.anthropicModel || 'claude-sonnet-4-5-20250929';
    this.ollamaModel = config.ollamaModel || 'llama3.2';
    this.claudeCliModel = config.claudeCliModel || ''; // empty = use default
    this.geminiKey = config.geminiKey || '';
    this.geminiModel = config.geminiModel || 'gemini-2.0-flash';
    this.timeoutMs = config.timeoutMs || 120000; // default 120s
  }

  reconfigure(config) {
    if (config.provider !== undefined) this.provider = config.provider;
    if (config.ollamaUrl !== undefined) this.ollamaUrl = config.ollamaUrl;
    if (config.ollamaModel !== undefined) this.ollamaModel = config.ollamaModel;
    if (config.openaiKey !== undefined) this.openaiKey = config.openaiKey;
    if (config.openaiModel !== undefined) this.openaiModel = config.openaiModel;
    if (config.anthropicKey !== undefined) this.anthropicKey = config.anthropicKey;
    if (config.anthropicModel !== undefined) this.anthropicModel = config.anthropicModel;
    if (config.claudeCliModel !== undefined) this.claudeCliModel = config.claudeCliModel;
    if (config.geminiKey !== undefined) this.geminiKey = config.geminiKey;
    if (config.geminiModel !== undefined) this.geminiModel = config.geminiModel;
    if (config.timeoutMs !== undefined) this.timeoutMs = config.timeoutMs;
    console.log(`[LLM] Reconfigured: provider=${this.provider}`);
  }

  async chat(messages) {
    switch (this.provider) {
      case 'openai': return this._openaiChat(messages);
      case 'anthropic': return this._anthropicChat(messages);
      case 'claude-cli': return this._claudeCliChat(messages);
      case 'gemini': return this._geminiChat(messages);
      default: return this._ollamaChat(messages);
    }
  }

  async _openaiChat(messages) {
    const formatted = messages.map(m => {
      if (m.images && m.images.length > 0 && m.role !== 'system') {
        const content = [
          { type: 'text', text: m.content }
        ];
        for (const img of m.images) {
          content.push({
            type: 'image_url',
            image_url: { url: `data:${img.mediaType || 'image/jpeg'};base64,${img.data}` }
          });
        }
        return { role: m.role, content };
      }
      return { role: m.role, content: m.content };
    });

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const response = await fetch('https://api.openai.com/v1/chat/completions', {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${this.openaiKey}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          model: this.openaiModel,
          messages: formatted,
          temperature: 0.7
        }),
        signal: controller.signal
      });
      if (!response.ok) {
        const err = await response.text();
        throw new Error(`OpenAI API error: ${response.status} ${err}`);
      }
      const data = await response.json();
      return data.choices[0].message.content;
    } finally {
      clearTimeout(timeout);
    }
  }

  async _anthropicChat(messages) {
    // Anthropic Messages API uses a separate system param
    const systemMsg = messages.find(m => m.role === 'system');
    const chatMessages = messages.filter(m => m.role !== 'system').map(m => {
      if (m.images && m.images.length > 0) {
        // Multimodal: text + images
        const content = [
          { type: 'text', text: m.content }
        ];
        for (const img of m.images) {
          content.push({
            type: 'image',
            source: { type: 'base64', media_type: img.mediaType || 'image/jpeg', data: img.data }
          });
        }
        return { role: m.role === 'assistant' ? 'assistant' : 'user', content };
      }
      return { role: m.role === 'assistant' ? 'assistant' : 'user', content: m.content };
    });

    const body = {
      model: this.anthropicModel,
      max_tokens: 1024,
      messages: chatMessages
    };
    if (systemMsg) {
      body.system = systemMsg.content;
    }

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const response = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: {
          'x-api-key': this.anthropicKey,
          'anthropic-version': '2023-06-01',
          'Content-Type': 'application/json'
        },
        body: JSON.stringify(body),
        signal: controller.signal
      });
      if (!response.ok) {
        const err = await response.text();
        throw new Error(`Anthropic API error: ${response.status} ${err}`);
      }
      const data = await response.json();
      return data.content[0].text;
    } finally {
      clearTimeout(timeout);
    }
  }

  async _geminiChat(messages) {
    const systemMsg = messages.find(m => m.role === 'system');
    const chatMessages = messages.filter(m => m.role !== 'system').map(m => {
      const parts = [];
      if (m.content) parts.push({ text: m.content });
      if (m.images && m.images.length > 0) {
        for (const img of m.images) {
          parts.push({ inlineData: { mimeType: img.mediaType || 'image/jpeg', data: img.data } });
        }
      }
      return { role: m.role === 'assistant' ? 'model' : 'user', parts };
    });

    const body = {
      contents: chatMessages,
      generationConfig: { temperature: 0.7, maxOutputTokens: 1024 }
    };
    if (systemMsg) {
      body.systemInstruction = { parts: [{ text: systemMsg.content }] };
    }

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const url = `https://generativelanguage.googleapis.com/v1beta/models/${this.geminiModel}:generateContent`;
      const response = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-goog-api-key': this.geminiKey },
        body: JSON.stringify(body),
        signal: controller.signal
      });
      if (!response.ok) {
        const err = await response.text();
        throw new Error(`Gemini API error: ${response.status} ${err}`);
      }
      const data = await response.json();
      return data.candidates[0].content.parts[0].text;
    } finally {
      clearTimeout(timeout);
    }
  }

  async _claudeCliChat(messages) {
    // Use "claude -p" (pipe mode) — sends prompt via stdin, gets response on stdout
    const systemMsg = messages.find(m => m.role === 'system');
    const chatMessages = messages.filter(m => m.role !== 'system');

    // Flatten messages into a single prompt string with system in <system> tags
    let prompt = '';
    if (systemMsg) {
      prompt += `<system>\n${systemMsg.content}\n</system>\n\n`;
    }
    for (const msg of chatMessages) {
      const role = msg.role === 'assistant' ? 'Assistant' : 'User';
      prompt += `${role}: ${msg.content}\n\n`;
    }
    prompt += 'Assistant:';

    const args = ['-p'];
    if (this.claudeCliModel) {
      args.push('--model', this.claudeCliModel);
    }

    const env = { ...process.env };
    delete env.CLAUDECODE;
    delete env.CLAUDE_CODE_ENTRYPOINT;

    console.log(`[LLM] Claude CLI: spawning, prompt length=${prompt.length}`);

    return new Promise((resolve, reject) => {
      const child = spawn('claude', args, { env, windowsHide: true });
      let stdout = '';
      let stderr = '';

      child.stdout.on('data', (d) => { stdout += d; });
      child.stderr.on('data', (d) => { stderr += d; });

      child.on('error', (err) => {
        clearTimeout(timer);
        console.error(`[LLM] Claude CLI spawn failed: ${err.message}`);
        reject(new Error(`Claude CLI spawn error: ${err.message}`));
      });

      child.on('close', (code) => {
        clearTimeout(timer);
        if (code !== 0) {
          console.error(`[LLM] Claude CLI failed (exit ${code}): ${stderr.substring(0, 500)}`);
          reject(new Error(`Claude CLI exited with code ${code}: ${stderr}`));
        } else {
          console.log(`[LLM] Claude CLI responded (${stdout.length} chars)`);
          resolve(stdout.trim());
        }
      });

      const timer = setTimeout(() => {
        console.error(`[LLM] Claude CLI timed out after ${this.timeoutMs / 1000}s`);
        child.kill();
        reject(new Error(`Claude CLI timed out after ${this.timeoutMs / 1000}s`));
      }, this.timeoutMs);

      // Pipe prompt via stdin (original working approach)
      child.stdin.write(prompt);
      child.stdin.end();
    });
  }

  async _ollamaChat(messages) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const response = await fetch(`${this.ollamaUrl}/api/chat`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: this.ollamaModel,
          messages,
          stream: false
        }),
        signal: controller.signal
      });
      if (!response.ok) {
        const err = await response.text();
        throw new Error(`Ollama API error: ${response.status} ${err}`);
      }
      const data = await response.json();
      return data.message.content;
    } finally {
      clearTimeout(timeout);
    }
  }

  getModels() {
    const modelMap = {
      openai: this.openaiModel,
      anthropic: this.anthropicModel,
      'claude-cli': this.claudeCliModel || 'default',
      gemini: this.geminiModel,
      ollama: this.ollamaModel
    };
    return {
      provider: this.provider,
      model: modelMap[this.provider] || this.ollamaModel
    };
  }
}

module.exports = LLMService;
