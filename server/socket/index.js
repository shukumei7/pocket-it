function setupSocket(io, app) {
  const agentNamespace = require('./agentNamespace');
  const itNamespace = require('./itNamespace');

  agentNamespace.setup(io, app);
  itNamespace.setup(io, app);

  console.log('[Socket.IO] Namespaces registered: /agent, /it');
}

module.exports = { setupSocket };
