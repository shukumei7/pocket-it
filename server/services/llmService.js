const { execFile } = require('child_process');
const { promisify } = require('util');
const execFileAsync = promisify(execFile);

class LLMService {
  constructor(config) {
    this.provider = config.provider || 'ollama'; // 'openai', 'anthropic', 'claude-cli', or 'ollama'
    this.ollamaUrl = config.ollamaUrl || 'http://localhost:11434';
    this.openaiKey = config.openaiKey || '';
    this.openaiModel = config.openaiModel || 'gpt-4o-mini';
    this.anthropicKey = config.anthropicKey || '';
    this.anthropicModel = config.anthropicModel || 'claude-sonnet-4-5-20250929';
    this.ollamaModel = config.ollamaModel || 'llama3.2';
    this.claudeCliModel = config.claudeCliModel || ''; // empty = use default
  }

  async chat(messages) {
    switch (this.provider) {
      case 'openai': return this._openaiChat(messages);
      case 'anthropic': return this._anthropicChat(messages);
      case 'claude-cli': return this._claudeCliChat(messages);
      default: return this._ollamaChat(messages);
    }
  }

  async _openaiChat(messages) {
    const response = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${this.openaiKey}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        model: this.openaiModel,
        messages,
        temperature: 0.7
      })
    });
    if (!response.ok) {
      const err = await response.text();
      throw new Error(`OpenAI API error: ${response.status} ${err}`);
    }
    const data = await response.json();
    return data.choices[0].message.content;
  }

  async _anthropicChat(messages) {
    // Anthropic Messages API uses a separate system param
    const systemMsg = messages.find(m => m.role === 'system');
    const chatMessages = messages.filter(m => m.role !== 'system').map(m => ({
      role: m.role === 'assistant' ? 'assistant' : 'user',
      content: m.content
    }));

    const body = {
      model: this.anthropicModel,
      max_tokens: 1024,
      messages: chatMessages
    };
    if (systemMsg) {
      body.system = systemMsg.content;
    }

    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'x-api-key': this.anthropicKey,
        'anthropic-version': '2023-06-01',
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(body)
    });
    if (!response.ok) {
      const err = await response.text();
      throw new Error(`Anthropic API error: ${response.status} ${err}`);
    }
    const data = await response.json();
    return data.content[0].text;
  }

  async _claudeCliChat(messages) {
    // Use "claude -p" (pipe mode) — sends prompt via stdin, gets response on stdout
    // Flatten messages into a single prompt string
    const systemMsg = messages.find(m => m.role === 'system');
    const chatMessages = messages.filter(m => m.role !== 'system');

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

    try {
      const { stdout } = await execFileAsync('claude', args, {
        input: prompt,
        timeout: 60000,
        maxBuffer: 1024 * 1024
      });
      return stdout.trim();
    } catch (err) {
      throw new Error(`Claude CLI error: ${err.message}`);
    }
  }

  async _ollamaChat(messages) {
    const response = await fetch(`${this.ollamaUrl}/api/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: this.ollamaModel,
        messages,
        stream: false
      })
    });
    if (!response.ok) {
      const err = await response.text();
      throw new Error(`Ollama API error: ${response.status} ${err}`);
    }
    const data = await response.json();
    return data.message.content;
  }

  getModels() {
    const modelMap = {
      openai: this.openaiModel,
      anthropic: this.anthropicModel,
      'claude-cli': this.claudeCliModel || 'default',
      ollama: this.ollamaModel
    };
    return {
      provider: this.provider,
      model: modelMap[this.provider] || this.ollamaModel
    };
  }
}

module.exports = LLMService;
