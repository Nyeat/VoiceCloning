import {
  InteractionRequiredAuthError,
  PublicClientApplication,
} from "@azure/msal-browser";
import { config } from "@/config";
import { POST_LOGIN_PATH_STORAGE_KEY } from "./constants";
import { tokenNeedsRefresh } from "./tokenExpiry.js";
import {
  ID_TOKEN,
  NO_TOKEN,
  loginApiScope,
  resolveApiTokenMode,
} from "./apiTokenMode";

const MICROSOFT_LOGIN_SCOPES = ["openid", "profile", "email"];
const CONSUMER_TENANT_ID = "9188040d-6c67-4c5b-b112-36a304b66dad";

let msalInstancePromise;

function normalizeEmailDomain(domain) {
  return domain.trim().replace(/^@+/, "").toLowerCase();
}

function formatAllowedDomains(domains) {
  return domains.join(", ");
}

function createConfigurationError(variableName) {
  return new Error(`Missing required frontend environment variable: ${variableName}`);
}

function buildMsalConfig() {
  if (!config.entraClientId) {
    throw createConfigurationError("VITE_ENTRA_CLIENT_ID");
  }

  return {
    auth: {
      clientId: config.entraClientId,
      authority: config.entraTenantAuthority,
      redirectUri: config.entraRedirectUri,
    },
    cache: {
      cacheLocation: "sessionStorage",
      storeAuthStateInCookie: false,
    },
  };
}

function apiTokenModeInputs() {
  return {
    msalEnabled: isMsalAuthEnabled(),
    apiAuthMode: config.apiAuthMode,
    entraApiScope: config.entraApiScope,
  };
}

function getInteractionScopes() {
  return [...MICROSOFT_LOGIN_SCOPES, loginApiScope(apiTokenModeInputs())].filter(Boolean);
}

/**
 * Whether this build sends a token to its own backends at all.
 *
 * The backends verify one token type or the other via ENTRA_AUDIENCE, so this
 * and their audience must be chosen together; see apiTokenMode.js and
 * docs/user-transcript-storage-plan.md.
 */
export function shouldAttachApiToken() {
  return resolveApiTokenMode(apiTokenModeInputs()) !== NO_TOKEN;
}

/** The token for whichever mode is configured. */
export async function acquireApiToken() {
  return resolveApiTokenMode(apiTokenModeInputs()) === ID_TOKEN
    ? acquireMicrosoftIdToken()
    : acquireApiAccessToken();
}

function getApiScopes() {
  if (!config.entraApiScope) {
    throw createConfigurationError("VITE_ENTRA_API_SCOPE");
  }

  return [config.entraApiScope];
}

function setStoredPostLoginPath(pathname) {
  if (typeof window === "undefined") {
    return;
  }

  if (!pathname) {
    window.sessionStorage.removeItem(POST_LOGIN_PATH_STORAGE_KEY);
    return;
  }

  window.sessionStorage.setItem(POST_LOGIN_PATH_STORAGE_KEY, pathname);
}

function getAccountUsername(account) {
  return typeof account?.username === "string" ? account.username.toLowerCase() : "";
}

export function isMsalAuthEnabled() {
  return config.authEnabled && config.authMode === "msal";
}

export function getAllowedEmailDomains() {
  return config.entraAllowedEmailDomains.map(normalizeEmailDomain).filter(Boolean);
}

export function isAllowedAccount(account) {
  const allowedDomains = getAllowedEmailDomains();
  if (allowedDomains.length === 0) {
    return true;
  }

  const username = getAccountUsername(account);
  if (!username || username.includes("#ext#")) {
    return false;
  }

  return allowedDomains.some((domain) => username.endsWith(`@${domain}`));
}

export function getAccountPolicyError(account) {
  if (!account) {
    return "";
  }

  const username = getAccountUsername(account);
  if (!username) {
    return "The signed-in Microsoft account is missing a usable email address.";
  }

  if (username.includes("#ext#")) {
    return "Guest Microsoft accounts are not allowed for this app.";
  }

  if (account.tenantId === CONSUMER_TENANT_ID) {
    return "Personal Microsoft accounts are not allowed for this app.";
  }

  const allowedDomains = getAllowedEmailDomains();
  if (
    allowedDomains.length > 0 &&
    !allowedDomains.some((domain) => username.endsWith(`@${domain}`))
  ) {
    return `Only these Microsoft account domains are allowed for this app: ${formatAllowedDomains(allowedDomains)}.`;
  }

  return "";
}

export function mapAccountToUser(account) {
  if (!account) {
    return null;
  }

  return {
    email: account.username,
    name: account.name || account.username,
    tenantId: account.tenantId || "",
  };
}

export async function initializeMsal() {
  if (!isMsalAuthEnabled()) {
    return null;
  }

  if (!msalInstancePromise) {
    msalInstancePromise = (async () => {
      const instance = new PublicClientApplication(buildMsalConfig());
      await instance.initialize();

      const redirectResult = await instance.handleRedirectPromise();
      const account =
        redirectResult?.account ||
        instance.getActiveAccount() ||
        instance.getAllAccounts()[0] ||
        null;

      if (account) {
        instance.setActiveAccount(account);
      }

      return instance;
    })();
  }

  return msalInstancePromise;
}

export async function getMsalInstance() {
  const instance = await initializeMsal();
  if (!instance) {
    throw new Error("MSAL authentication is not enabled.");
  }
  return instance;
}

export async function getCurrentAccount() {
  const instance = await getMsalInstance();
  const account =
    instance.getActiveAccount() || instance.getAllAccounts()[0] || null;

  if (account) {
    instance.setActiveAccount(account);
  }

  return account;
}

export function consumeStoredPostLoginPath() {
  if (typeof window === "undefined") {
    return "";
  }

  const stored = window.sessionStorage.getItem(POST_LOGIN_PATH_STORAGE_KEY) || "";
  window.sessionStorage.removeItem(POST_LOGIN_PATH_STORAGE_KEY);
  return stored;
}

export async function signInWithMicrosoft(redirectPath = "/") {
  const instance = await getMsalInstance();
  setStoredPostLoginPath(redirectPath);
  await instance.loginRedirect({
    prompt: "select_account",
    scopes: getInteractionScopes(),
  });
}

export async function signOutFromMicrosoft() {
  const instance = await getMsalInstance();
  const account =
    instance.getActiveAccount() || instance.getAllAccounts()[0] || undefined;

  setStoredPostLoginPath("");
  await instance.logoutRedirect({
    account,
    postLogoutRedirectUri: config.entraRedirectUri,
  });
}

/**
 * The API token, or "" if it cannot be obtained without user interaction.
 *
 * **Never navigates.** The two functions below fall back to
 * `acquireTokenRedirect`, which takes the whole page to Microsoft — correct
 * when the user just asked to start a conversation and is waiting for it, and
 * badly wrong for anything that runs on its own at mount. An eager background
 * caller using those would bounce a freshly signed-in student straight back to
 * a sign-in prompt.
 *
 * Use this for anything speculative; use the redirecting versions only in
 * response to a deliberate user action.
 */
export async function acquireApiTokenSilent() {
  const mode = resolveApiTokenMode(apiTokenModeInputs());
  if (mode === NO_TOKEN) {
    return "";
  }

  const instance = await getMsalInstance();
  const account = await getCurrentAccount();
  if (!account) {
    return "";
  }

  try {
    const request = {
      account,
      scopes: mode === ID_TOKEN ? MICROSOFT_LOGIN_SCOPES : getApiScopes(),
    };
    const pick = (result) => (mode === ID_TOKEN ? result.idToken : result.accessToken) || "";
    let token = pick(await instance.acquireTokenSilent(request));
    // A cached ID token may already be expired (see tokenExpiry.js).
    if (mode === ID_TOKEN && tokenNeedsRefresh(token)) {
      token = pick(await instance.acquireTokenSilent({ ...request, forceRefresh: true }));
    }
    return token;
  } catch {
    // Including InteractionRequiredAuthError: the caller does without a token
    // rather than seizing the page.
    return "";
  }
}

export async function acquireApiAccessToken() {
  const instance = await getMsalInstance();
  const account = await getCurrentAccount();

  if (!account) {
    throw new Error("You are not signed in.");
  }

  const scopes = getApiScopes();

  try {
    const tokenResult = await instance.acquireTokenSilent({
      account,
      scopes,
    });

    if (tokenResult.account) {
      instance.setActiveAccount(tokenResult.account);
    }

    return tokenResult.accessToken;
  } catch (error) {
    if (error instanceof InteractionRequiredAuthError) {
      setStoredPostLoginPath(
        typeof window !== "undefined"
          ? `${window.location.pathname}${window.location.search}`
          : "/",
      );
      await instance.acquireTokenRedirect({
        account,
        scopes,
      });
      throw new Error("Redirecting to Microsoft sign-in.");
    }

    throw error;
  }
}

export async function acquireMicrosoftIdToken() {
  const instance = await getMsalInstance();
  const account = await getCurrentAccount();

  if (!account) {
    throw new Error("You are not signed in.");
  }

  try {
    let tokenResult = await instance.acquireTokenSilent({
      account,
      scopes: MICROSOFT_LOGIN_SCOPES,
    });
    // The cached ID token may already be expired; the server would then reject
    // it ("Sign in to …"). Refresh it silently before it is sent.
    if (tokenNeedsRefresh(tokenResult.idToken)) {
      tokenResult = await instance.acquireTokenSilent({
        account,
        scopes: MICROSOFT_LOGIN_SCOPES,
        forceRefresh: true,
      });
    }

    if (tokenResult.account) {
      instance.setActiveAccount(tokenResult.account);
    }

    if (!tokenResult.idToken) {
      throw new Error("Microsoft sign-in did not return an ID token.");
    }

    return tokenResult.idToken;
  } catch (error) {
    if (error instanceof InteractionRequiredAuthError) {
      setStoredPostLoginPath(
        typeof window !== "undefined"
          ? `${window.location.pathname}${window.location.search}`
          : "/",
      );
      await instance.acquireTokenRedirect({
        account,
        scopes: MICROSOFT_LOGIN_SCOPES,
      });
      throw new Error("Redirecting to Microsoft sign-in.");
    }

    throw error;
  }
}
