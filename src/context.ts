/**
 * ACTIVE WORK CONTEXT
 * Tracks which story you're currently working on
 */

export interface ActiveStory {
  jiraKey: string;
  sprint?: string;
  epic?: string;
  title?: string;
  startedAt: string;
}

let activeStory: ActiveStory | null = null;

export function setActiveStory(story: ActiveStory): ActiveStory {
  activeStory = {
    ...story,
    startedAt: new Date().toISOString(),
  };
  return activeStory;
}

export function getActiveStory(): ActiveStory | null {
  return activeStory;
}

export function clearActiveStory(): void {
  activeStory = null;
}
