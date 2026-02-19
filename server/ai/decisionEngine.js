// Parse AI response into structured parts
function parseResponse(responseText) {
  const result = {
    text: responseText,
    action: null,
    wish: null
  };

  // Check for wish action FIRST (extract it separately since it can coexist with other actions)
  const wishMatch = result.text.match(/\[ACTION:WISH:(\w+):(.+?)\]/);
  if (wishMatch) {
    result.wish = {
      type: 'wish',
      category: wishMatch[1],
      need: wishMatch[2]
    };
    result.text = result.text.replace(wishMatch[0], '').trim();
  }

  // Then check for other actions (existing logic unchanged)
  const diagnoseMatch = result.text.match(/\[ACTION:DIAGNOSE:(\w+)\]/);
  if (diagnoseMatch) {
    result.action = {
      type: 'diagnose',
      checkType: diagnoseMatch[1]
    };
    result.text = result.text.replace(diagnoseMatch[0], '').trim();
    return result;
  }

  const remediateMatch = result.text.match(/\[ACTION:REMEDIATE:(\w+)(?::(.+?))?\]/);
  if (remediateMatch) {
    result.action = {
      type: 'remediate',
      actionId: remediateMatch[1],
      parameter: remediateMatch[2] || null
    };
    result.text = result.text.replace(remediateMatch[0], '').trim();
    return result;
  }

  const screenshotMatch = result.text.match(/\[ACTION:SCREENSHOT\]/);
  if (screenshotMatch) {
    result.action = { type: 'screenshot' };
    result.text = result.text.replace(screenshotMatch[0], '').trim();
    return result;
  }

  const ticketMatch = result.text.match(/\[ACTION:TICKET:(\w+):(.+?)\]/);
  if (ticketMatch) {
    result.action = {
      type: 'ticket',
      priority: ticketMatch[1],
      title: ticketMatch[2]
    };
    result.text = result.text.replace(ticketMatch[0], '').trim();
    return result;
  }

  return result;
}

module.exports = { parseResponse };
