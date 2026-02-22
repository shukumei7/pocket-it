const { Router } = require('express');
const { requireIT } = require('../auth/middleware');

function createLLMRouter(llmService) {
  const router = Router();

  // GET /api/llm/models — show current LLM configuration
  router.get('/models', (req, res) => {
    res.json(llmService.getModels());
  });

  // POST /api/llm/generate-script — generate or fix a PowerShell or cmd script
  router.post('/generate-script', requireIT, async (req, res) => {
    const { content = '', description = '', name = '' } = req.body;
    const userMessage = [
      name        ? `Name: ${name}`               : '',
      description ? `Description: ${description}` : '',
      content     ? `Current content:\n${content}` : '',
      'Generate the script.'
    ].filter(Boolean).join('\n');

    try {
      let script = await llmService.chat([
        {
          role: 'system',
          content: `You are a Windows script generator for IT administration. Given an intended purpose, description, or partial/broken script, produce a clean, working script for Windows.
Rules:
- Choose the most appropriate scripting language: PowerShell for complex tasks, system management, WMI/CIM queries, and structured output; cmd/batch for simple commands, quick one-liners, or when the user's intent is clearly a cmd command
- If given a plain-English purpose, write a complete script from scratch
- If given a broken or incomplete script, fix and complete it
- Return ONLY the raw script — no markdown fencing, no explanation, no code blocks
- Scripts must be safe for production Windows environments
- Use proper error handling where appropriate`
        },
        { role: 'user', content: userMessage }
      ]);
      // Strip markdown code fences if the LLM included them (powershell, cmd, batch, or plain)
      script = script.replace(/^```(?:powershell|cmd|batch|bat|shell)?\r?\n/i, '').replace(/\r?\n```\s*$/i, '').trim();
      res.json({ script });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // POST /api/llm/test — test LLM connectivity
  router.post('/test', async (req, res) => {
    const startTime = Date.now();
    try {
      const result = await llmService.chat([
        { role: 'system', content: 'You are a test assistant.' },
        { role: 'user', content: 'Respond with exactly: LLM_OK' }
      ]);
      res.json({
        success: true,
        provider: llmService.provider,
        model: llmService.getModels().model,
        response: result.substring(0, 200),
        durationMs: Date.now() - startTime
      });
    } catch (err) {
      res.status(500).json({
        success: false,
        provider: llmService.provider,
        model: llmService.getModels().model,
        error: err.message,
        durationMs: Date.now() - startTime
      });
    }
  });

  return router;
}

module.exports = createLLMRouter;
