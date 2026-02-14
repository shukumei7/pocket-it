const { Router } = require('express');
const { requireIT } = require('../auth/middleware');

function createLLMRouter(llmService) {
  const router = Router();

  // GET /api/llm/models — show current LLM configuration
  router.get('/models', (req, res) => {
    res.json(llmService.getModels());
  });

  return router;
}

module.exports = createLLMRouter;
