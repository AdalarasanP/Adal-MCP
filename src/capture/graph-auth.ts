/**
 * Microsoft Graph authentication using MSAL.
 * Auth strategy (tries in order):
 *   1. Silent (cached token from previous run)
 *   2. Integrated Windows Authentication (IWA) — uses your Windows Kerberos session,
 *      no browser/device code needed. Works on domain-joined Marriott machines.
 *   3. Device code fallback (if IWA fails — e.g. on non-domain machine)
 *
 * Run `npm run auth-graph` once to prime the cache. After that fully silent.
 */

import { PublicClientApplication, DeviceCodeRequest, AccountInfo, SilentFlowRequest } from "@azure/msal-node";
import fs from "fs";
import path from "path";

const TOKEN_CACHE_FILE = path.join("C:/Users/apand270/.adal-agent", "graph-token-cache.json");
const SCOPES = [
  "https://graph.microsoft.com/Mail.Read",
  "https://graph.microsoft.com/Mail.ReadWrite",
  "https://graph.microsoft.com/User.Read",
  "https://graph.microsoft.com/People.Read",
  "https://graph.microsoft.com/Chat.Read",
  "offline_access",
];

// Microsoft Graph PowerShell — Microsoft-owned public client trusted in all Azure AD tenants.
const CLIENT_ID = "14d82eec-204b-4c2f-b7e8-296a70dab67e";
const TENANT_ID = process.env.AZURE_TENANT_ID ?? "d2033364-dec3-4a1c-9772-3f41ca7c4b75";
// UPN used for IWA — reads from JIRA_EMAIL or falls back to apand270@marriott.com
const UPN = process.env.JIRA_EMAIL ?? "adalarasan.pandian2@marriott.com";

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

  const pca = new PublicClientApplication({
    auth: {
      clientId: CLIENT_ID,
      authority: `https://login.microsoftonline.com/${TENANT_ID}`,
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

/** Get a valid access token — silent → IWA → device code */
export async function getAccessToken(): Promise<string> {
  const pca = getPca();

  // 1. Try silent (cached token)
  const accounts = await pca.getTokenCache().getAllAccounts();
  if (accounts.length > 0) {
    const account = _account ?? accounts[0];
    try {
      const result = await pca.acquireTokenSilent({ scopes: SCOPES, account } as SilentFlowRequest);
      if (result?.accessToken) {
        _account = result.account;
        return result.accessToken;
      }
    } catch { /* fall through */ }
  }

  // 2. Integrated Windows Authentication — uses current Windows/Kerberos session.
  //    Works on domain-joined machines without any browser prompt.
  //    Marriott Conditional Access allows this flow (compliant device + corp network).
  try {
    console.log("Attempting Integrated Windows Authentication (IWA)...");
    const result = await pca.acquireTokenByIntegratedWindowsAuth({
      scopes: SCOPES,
      username: UPN,
    });
    if (result?.accessToken) {
      console.log("IWA authentication successful.");
      _account = result.account;
      return result.accessToken;
    }
  } catch (iwaErr: any) {
    console.warn(`IWA failed (${iwaErr?.message ?? iwaErr}), falling back to device code...`);
  }

  // 3. Device code fallback
  console.log("\nIWA not available. Using device code flow:");
  console.log("NOTE: If Marriott Conditional Access blocks this, use a corporate browser instead.\n");
  const result = await pca.acquireTokenByDeviceCode({
    scopes: SCOPES,
    deviceCodeCallback: (response) => {
      console.log(response.message + "\n");
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
