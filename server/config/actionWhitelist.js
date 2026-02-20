/**
 * Centralized action whitelists for remediation validation.
 * Single source of truth — imported by agentNamespace.js and itNamespace.js.
 */

const VALID_ACTIONS = [
  'flush_dns',
  'clear_temp',
  'restart_spooler',
  'repair_network',
  'clear_browser_cache',
  'kill_process',
  'restart_service',
  'restart_explorer',
  'sfc_scan',
  'dism_repair',
  'clear_update_cache',
  'reset_network_adapter'
];

const ALLOWED_SERVICES = [
  'spooler',
  'wuauserv',
  'bits',
  'dnscache',
  'w32time',
  'winmgmt',
  'themes',
  'audiosrv',
  'wsearch',
  'tabletinputservice',
  'sysmain',
  'diagtrack'
];

module.exports = { VALID_ACTIONS, ALLOWED_SERVICES };
