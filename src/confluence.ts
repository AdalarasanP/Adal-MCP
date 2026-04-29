/**
 * CONFLUENCE CLIENT
 * Thin wrapper around the Confluence REST API v1.
 * Reuses the same JIRA_BASE_URL, JIRA_EMAIL, JIRA_TOKEN from .env —
 * Atlassian Cloud shares credentials across Jira and Confluence.
 */

function getConfig() {
  const baseUrl = process.env.JIRA_BASE_URL;
  const email = process.env.JIRA_EMAIL;
  const token = process.env.JIRA_TOKEN;

  if (!baseUrl || !email || !token) {
    throw new Error("Missing Confluence config: set JIRA_BASE_URL, JIRA_EMAIL, JIRA_TOKEN in .env");
  }

  const auth = Buffer.from(`${email}:${token}`).toString("base64");
  return { baseUrl: baseUrl.replace(/\/$/, ""), auth };
}

async function confluenceFetch(path: string, options: RequestInit = {}): Promise<Response> {
  const { baseUrl, auth } = getConfig();
  const url = `${baseUrl}/wiki/rest/api${path}`;
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

export interface ConfluencePage {
  id: string;
  title: string;
  space: { key: string; name: string };
  version: { number: number };
  body: { storage: { value: string } };
  _links: { webui: string };
}

export async function getPage(pageId: string): Promise<ConfluencePage> {
  const res = await confluenceFetch(`/content/${pageId}?expand=body.storage,version,space`);
  if (!res.ok) {
    throw new Error(`Confluence GET page failed: ${res.status} ${await res.text()}`);
  }
  return res.json() as Promise<ConfluencePage>;
}

export async function searchPages(query: string, limit = 10): Promise<ConfluencePage[]> {
  const cql = encodeURIComponent(`type=page AND text~"${query}" ORDER BY lastmodified DESC`);
  const res = await confluenceFetch(`/content/search?cql=${cql}&limit=${limit}&expand=space,version`);
  if (!res.ok) {
    throw new Error(`Confluence search failed: ${res.status} ${await res.text()}`);
  }
  const data = (await res.json()) as { results: ConfluencePage[] };
  return data.results;
}

export interface CreatePageOptions {
  spaceKey: string;
  title: string;
  body: string;
  parentId?: string;
}

export async function createPage(opts: CreatePageOptions): Promise<ConfluencePage> {
  const payload: Record<string, unknown> = {
    type: "page",
    title: opts.title,
    space: { key: opts.spaceKey },
    body: {
      storage: {
        value: opts.body,
        representation: "storage",
      },
    },
  };

  if (opts.parentId) {
    payload.ancestors = [{ id: opts.parentId }];
  }

  const res = await confluenceFetch("/content", {
    method: "POST",
    body: JSON.stringify(payload),
  });
  if (!res.ok) {
    throw new Error(`Confluence create page failed: ${res.status} ${await res.text()}`);
  }
  return res.json() as Promise<ConfluencePage>;
}

export async function updatePage(
  pageId: string,
  title: string,
  body: string,
  currentVersion: number
): Promise<ConfluencePage> {
  const res = await confluenceFetch(`/content/${pageId}`, {
    method: "PUT",
    body: JSON.stringify({
      type: "page",
      title,
      version: { number: currentVersion + 1 },
      body: {
        storage: {
          value: body,
          representation: "storage",
        },
      },
    }),
  });
  if (!res.ok) {
    throw new Error(`Confluence update page failed: ${res.status} ${await res.text()}`);
  }
  return res.json() as Promise<ConfluencePage>;
}
