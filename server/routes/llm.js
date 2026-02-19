const { Router } = require('express');
const { requireIT } = require('../auth/middleware');

function createLLMRouter(llmService) {
  const router = Router();

  // GET /api/llm/models — show current LLM configuration
  router.get('/models', (req, res) => {
    res.json(llmService.getModels());
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
