// Parse AI response into structured parts
function parseResponse(responseText) {
  const result = {
    text: responseText,
    action: null
  };

  // Check for diagnostic action
  const diagnoseMatch = responseText.match(/\[ACTION:DIAGNOSE:(\w+)\]/);
  if (diagnoseMatch) {
    result.action = {
      type: 'diagnose',
      checkType: diagnoseMatch[1]
    };
    result.text = responseText.replace(diagnoseMatch[0], '').trim();
    return result;
  }

  // Check for remediation action (with optional parameter after second colon)
  const remediateMatch = responseText.match(/\[ACTION:REMEDIATE:(\w+)(?::(.+?))?\]/);
  if (remediateMatch) {
    result.action = {
      type: 'remediate',
      actionId: remediateMatch[1],
      parameter: remediateMatch[2] || null
    };
    result.text = responseText.replace(remediateMatch[0], '').trim();
    return result;
  }

  // Check for ticket action
  const ticketMatch = responseText.match(/\[ACTION:TICKET:(\w+):(.+?)\]/);
  if (ticketMatch) {
    result.action = {
      type: 'ticket',
      priority: ticketMatch[1],
      title: ticketMatch[2]
    };
    result.text = responseText.replace(ticketMatch[0], '').trim();
    return result;
  }

  return result;
}

module.exports = { parseResponse };
