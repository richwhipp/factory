/** The labels a Repo must have for the Factory to track a Run in its issues. */
export const FACTORY_LABELS = [
  { name: "factory:run", description: "A Factory Run: its sub-issues are the Tickets" },
  { name: "factory:ticket", description: "One Ticket of a Factory Run" },
  { name: "factory:building", description: "A session has claimed this Ticket" },
  { name: "factory:needs-operator", description: "Escalation: the Operator must decide" },
  { name: "factory:limited", description: "Limit stop: resumes after the usage limit resets" },
  { name: "factory:paused", description: "The Operator paused this Run" },
] as const;
