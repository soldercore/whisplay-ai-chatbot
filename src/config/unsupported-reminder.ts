// The current tool registry has no timed-reminder capability. These are narrow
// direct English requests, not keyword matching or general intent detection.
// Revisit this guard before adding a supported scheduling tool.
const timing = "(?:in (?:[1-9]\\d*|one|two) (?:seconds?|minutes?|hours?)|tomorrow)";
const prefix = "^(?:(?:can|could|would) you |please )?";
const reminderRequests = [
  new RegExp(`${prefix}remind me (?:${timing} to \\S[^\\r\\n]*|to \\S[^\\r\\n]* ${timing})[.!?]*$`, "i"),
  new RegExp(`${prefix}set a reminder for \\S[^\\r\\n]*$`, "i"),
];

export function unsupportedReminderReply(text: string): string | null {
  return reminderRequests.some(pattern => pattern.test(text.trim()))
    ? "I can't set timed reminders yet, so no reminder has been created."
    : null;
}
