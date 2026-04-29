/**
 * JIRA CLIENT
 * Thin wrapper around the Jira REST API v3.
 * Credentials are loaded from environment variables.
 */

function getConfig() {
  const baseUrl = process.env.JIRA_BASE_URL;
  const email = process.env.JIRA_EMAIL;
  const token = process.env.JIRA_TOKEN;

  if (!baseUrl || !email || !token) {
    throw new Error("Missing Jira config: set JIRA_BASE_URL, JIRA_EMAIL, JIRA_TOKEN in .env");
  }

  const auth = Buffer.from(`${email}:${token}`).toString("base64");
  return { baseUrl: baseUrl.replace(/\/$/, ""), auth };
}

async function jiraFetch(path: string, options: RequestInit = {}): Promise<Response> {
  const { baseUrl, auth } = getConfig();
  const url = `${baseUrl}/rest/api/3${path}`;
  return fetch(url, {
    ...options,
    headers: {
      Authorization: `Basic ${auth}`,
      "Content-Type": "application/json",
      Accept: "application/json",
      ...(options.headers ?? {}),
    },
  });
}

export interface JiraIssue {
  key: string;
  fields: {
    summary: string;
    status: { name: string };
    assignee: { displayName: string } | null;
    priority: { name: string } | null;
    description: unknown;
    comment: { total: number };
  };
}

export async function getIssue(issueKey: string): Promise<JiraIssue> {
  const res = await jiraFetch(`/issue/${issueKey}?fields=summary,status,assignee,priority,description,comment`);
  if (!res.ok) {
    throw new Error(`Jira GET issue failed: ${res.status} ${await res.text()}`);
  }
  return res.json() as Promise<JiraIssue>;
}

export async function addComment(issueKey: string, body: string): Promise<{ id: string }> {
  const res = await jiraFetch(`/issue/${issueKey}/comment`, {
    method: "POST",
    body: JSON.stringify({
      body: {
        type: "doc",
        version: 1,
        content: [{ type: "paragraph", content: [{ type: "text", text: body }] }],
      },
    }),
  });
  if (!res.ok) {
    throw new Error(`Jira add comment failed: ${res.status} ${await res.text()}`);
  }
  return res.json() as Promise<{ id: string }>;
}

export interface JiraTransition {
  id: string;
  name: string;
}

export async function getTransitions(issueKey: string): Promise<JiraTransition[]> {
  const res = await jiraFetch(`/issue/${issueKey}/transitions`);
  if (!res.ok) {
    throw new Error(`Jira get transitions failed: ${res.status} ${await res.text()}`);
  }
  const data = (await res.json()) as { transitions: JiraTransition[] };
  return data.transitions;
}

export async function transitionIssue(issueKey: string, statusName: string): Promise<string> {
  const transitions = await getTransitions(issueKey);
  const match = transitions.find(
    (t) => t.name.toLowerCase() === statusName.toLowerCase()
  );
  if (!match) {
    const available = transitions.map((t) => t.name).join(", ");
    throw new Error(`Status "${statusName}" not found. Available: ${available}`);
  }
  const res = await jiraFetch(`/issue/${issueKey}/transitions`, {
    method: "POST",
    body: JSON.stringify({ transition: { id: match.id } }),
  });
  if (!res.ok) {
    throw new Error(`Jira transition failed: ${res.status} ${await res.text()}`);
  }
  return match.name;
}

export interface JiraSearchResult {
  key: string;
  fields: {
    summary: string;
    status: { name: string };
    assignee: { displayName: string } | null;
    priority: { name: string } | null;
    issuetype: { name: string };
    story_points?: number;
  };
}

export async function searchIssues(jql: string, maxResults = 20): Promise<JiraSearchResult[]> {
  const res = await jiraFetch("/search/jql", {
    method: "POST",
    body: JSON.stringify({
      jql,
      maxResults,
      fields: ["summary", "status", "assignee", "priority", "issuetype", "customfield_10016"],
    }),
  });
  if (!res.ok) {
    throw new Error(`Jira search failed: ${res.status} ${await res.text()}`);
  }
  const data = (await res.json()) as { issues: Array<{ key: string; fields: Record<string, unknown> }> };
  return data.issues.map((i) => ({
    key: i.key,
    fields: {
      summary: i.fields.summary as string,
      status: i.fields.status as { name: string },
      assignee: i.fields.assignee as { displayName: string } | null,
      priority: i.fields.priority as { name: string } | null,
      issuetype: i.fields.issuetype as { name: string },
    },
  }));
}

/* ------------------------------------------------------------------ */
/* SPRINT / BOARD                                                        */
/* ------------------------------------------------------------------ */

async function agileFetch(path: string, options: RequestInit = {}): Promise<Response> {
  const { baseUrl, auth } = getConfig();
  const url = `${baseUrl}/rest/agile/1.0${path}`;
  return fetch(url, {
    ...options,
    headers: {
      Authorization: `Basic ${auth}`,
      "Content-Type": "application/json",
      Accept: "application/json",
      ...(options.headers ?? {}),
    },
  });
}

export interface JiraSprint {
  id: number;
  name: string;
  state: string;
  startDate?: string;
  endDate?: string;
}

export async function getBoardId(projectKey: string): Promise<number> {
  const res = await agileFetch(`/board?projectKeyOrId=${projectKey}&type=scrum`);
  if (!res.ok) throw new Error(`Get board failed: ${res.status} ${await res.text()}`);
  const data = (await res.json()) as { values: Array<{ id: number; name: string }> };
  if (!data.values.length) throw new Error(`No scrum board found for project ${projectKey}`);
  return data.values[0].id;
}

export async function getSprints(projectKey: string): Promise<JiraSprint[]> {
  const boardId = await getBoardId(projectKey);
  const res = await agileFetch(`/board/${boardId}/sprint?maxResults=20`);
  if (!res.ok) throw new Error(`Get sprints failed: ${res.status} ${await res.text()}`);
  const data = (await res.json()) as { values: JiraSprint[] };
  return data.values;
}

/* ------------------------------------------------------------------ */
/* CREATE / UPDATE ISSUES                                               */
/* ------------------------------------------------------------------ */

export interface CreateIssueOptions {
  projectKey: string;
  issuetype: "Story" | "Task" | "Sub-task" | "Bug" | "Epic";
  summary: string;
  description?: string;
  epicKey?: string;
  sprintId?: number;
  storyPoints?: number;
  assigneeAccountId?: string;
  labels?: string[];
  fixVersions?: string[];
}

export async function createIssue(opts: CreateIssueOptions): Promise<{ key: string; id: string }> {
  const fields: Record<string, unknown> = {
    project: { key: opts.projectKey },
    issuetype: { name: opts.issuetype },
    summary: opts.summary,
  };

  if (opts.description) {
    fields.description = {
      type: "doc",
      version: 1,
      content: [{ type: "paragraph", content: [{ type: "text", text: opts.description }] }],
    };
  }

  // Epic link — try parent (next-gen) and classic epic link field
  if (opts.epicKey) {
    fields.parent = { key: opts.epicKey };
  }

  if (opts.sprintId) {
    fields.customfield_10020 = { id: opts.sprintId };
  }

  if (opts.storyPoints !== undefined) {
    fields.customfield_10016 = opts.storyPoints;
    fields.story_points = opts.storyPoints;
  }

  if (opts.assigneeAccountId) {
    fields.assignee = { accountId: opts.assigneeAccountId };
  }

  if (opts.labels?.length) {
    fields.labels = opts.labels;
  }

  if (opts.fixVersions?.length) {
    fields.fixVersions = opts.fixVersions.map((v) => ({ name: v }));
  }

  const res = await jiraFetch("/issue", {
    method: "POST",
    body: JSON.stringify({ fields }),
  });
  if (!res.ok) throw new Error(`Create issue failed: ${res.status} ${await res.text()}`);
  return res.json() as Promise<{ key: string; id: string }>;
}

export async function updateIssue(
  issueKey: string,
  fields: Record<string, unknown>
): Promise<void> {
  const res = await jiraFetch(`/issue/${issueKey}`, {
    method: "PUT",
    body: JSON.stringify({ fields }),
  });
  if (!res.ok) throw new Error(`Update issue failed: ${res.status} ${await res.text()}`);
}

/* ------------------------------------------------------------------ */
/* ISSUE LINKS (dependencies)                                           */
/* ------------------------------------------------------------------ */

export async function linkIssues(
  inwardKey: string,
  outwardKey: string,
  linkType: string
): Promise<void> {
  const res = await jiraFetch("/issueLink", {
    method: "POST",
    body: JSON.stringify({
      type: { name: linkType },
      inwardIssue: { key: inwardKey },
      outwardIssue: { key: outwardKey },
    }),
  });
  if (!res.ok) throw new Error(`Link issues failed: ${res.status} ${await res.text()}`);
}

export async function getLinkTypes(): Promise<Array<{ name: string; inward: string; outward: string }>> {
  const res = await jiraFetch("/issueLinkType");
  if (!res.ok) throw new Error(`Get link types failed: ${res.status} ${await res.text()}`);
  const data = (await res.json()) as { issueLinkTypes: Array<{ name: string; inward: string; outward: string }> };
  return data.issueLinkTypes;
}

/* ------------------------------------------------------------------ */
/* CURRENT USER                                                          */
/* ------------------------------------------------------------------ */

export async function getCurrentUser(): Promise<{ accountId: string; displayName: string; emailAddress: string }> {
  const res = await jiraFetch("/myself");
  if (!res.ok) throw new Error(`Get current user failed: ${res.status} ${await res.text()}`);
  return res.json() as Promise<{ accountId: string; displayName: string; emailAddress: string }>;
}
