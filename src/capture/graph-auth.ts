/**
 * Microsoft Graph authentication using MSAL device code flow.
 * Token is cached to disk so you only need to sign in once.
 *
 * Setup:
 *   1. Register an Azure AD app at portal.azure.com
 *      - Platform: Mobile/Desktop, Redirect URI: http://localhost
 *      - Permissions: Mail.Read, Mail.ReadWrite, User.Read, People.Read, offline_access
 *   2. Add to .env:
 *      AZURE_CLIENT_ID=<your-app-client-id>
 *      AZURE_TENANT_ID=<your-tenant-id>
 *
 * First use: run `npm run auth-graph` — opens browser, you sign in once.
 * After that: tokens auto-refresh silently.
 */

import { PublicClientApplication, DeviceCodeRequest, AccountInfo, SilentFlowRequest } from "@azure/msal-node";
import fs from "fs";
import path from "path";
import os from "os";

const TOKEN_CACHE_FILE = path.join("C:/Users/apand270/.adal-agent", "graph-token-cache.json");
const SCOPES = [
  "https://graph.microsoft.com/Mail.Read",
  "https://graph.microsoft.com/Mail.ReadWrite",
  "https://graph.microsoft.com/User.Read",
  "https://graph.microsoft.com/People.Read",
  "https://graph.microsoft.com/Chat.Read",
  "offline_access",
];

function getClientConfig() {
  const clientId = process.env.AZURE_CLIENT_ID;
  const tenantId = process.env.AZURE_TENANT_ID;
  if (!clientId || !tenantId) {
    throw new Error("AZURE_CLIENT_ID and AZURE_TENANT_ID must be set in .env");
  }
  return { clientId, tenantId };
}

function loadCacheData(): string | undefined {
  if (fs.existsSync(TOKEN_CACHE_FILE)) {
    return fs.readFileSync(TOKEN_CACHE_FILE, "utf8");
  }
  return undefined;
}

function saveCacheData(data: string) {
  const dir = path.dirname(TOKEN_CACHE_FILE);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(TOKEN_CACHE_FILE, data, "utf8");
}

let _pca: PublicClientApplication | null = null;
let _account: AccountInfo | null = null;

function getPca(): PublicClientApplication {
  if (_pca) return _pca;
  const { clientId, tenantId } = getClientConfig();

  const pca = new PublicClientApplication({
    auth: {
      clientId,
      authority: `https://login.microsoftonline.com/${tenantId}`,
    },
    cache: {
      cachePlugin: {
        beforeCacheAccess: async (context) => {
          const data = loadCacheData();
          if (data) context.tokenCache.deserialize(data);
        },
        afterCacheAccess: async (context) => {
          if (context.cacheHasChanged) saveCacheData(context.tokenCache.serialize());
        },
      },
    },
  });

  _pca = pca;
  return pca;
}

/** Get a valid access token, refreshing silently or prompting device code */
export async function getAccessToken(): Promise<string> {
  const pca = getPca();

  // Try silent first
  const accounts = await pca.getTokenCache().getAllAccounts();
  if (accounts.length > 0) {
    const account = _account ?? accounts[0];
    try {
      const result = await pca.acquireTokenSilent({ scopes: SCOPES, account } as SilentFlowRequest);
      if (result?.accessToken) {
        _account = result.account;
        return result.accessToken;
      }
    } catch { /* fall through to device code */ }
  }

  // Device code flow
  const result = await pca.acquireTokenByDeviceCode({
    scopes: SCOPES,
    deviceCodeCallback: (response) => {
      console.log("\n" + response.message + "\n");
    },
  } as DeviceCodeRequest);

  if (!result?.accessToken) throw new Error("Graph auth failed — no access token returned");
  _account = result.account;
  return result.accessToken;
}

/** Make an authenticated Graph API call */
export async function graphFetch(path: string, options: RequestInit = {}): Promise<any> {
  const token = await getAccessToken();
  const url = path.startsWith("https://") ? path : `https://graph.microsoft.com/v1.0${path}`;
  const res = await fetch(url, {
    ...options,
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
      ...options.headers,
    },
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Graph API ${res.status}: ${text}`);
  }
  return res.json();
}

/** Check if the user has authenticated (token cache exists) */
export function isAuthenticated(): boolean {
  return fs.existsSync(TOKEN_CACHE_FILE);
}
