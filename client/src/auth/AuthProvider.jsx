import { createContext, useCallback, useEffect, useMemo, useState } from "react";
import { config } from "@/config";
import {
  getAccountPolicyError,
  getCurrentAccount,
  isMsalAuthEnabled,
  mapAccountToUser,
  signInWithMicrosoft,
  signOutFromMicrosoft,
} from "./msalClient";
import { MOCK_AUTH_STORAGE_KEY } from "./constants";
import { clearStudioSession, studioSessionUser } from "./studioSession.js";

const AuthContext = createContext(null);

function getMockUser() {
  return {
    email: "student@example.edu",
    name: "Demo Student",
    tenantId: "mock-tenant",
  };
}

function buildErrorMessage(error) {
  if (error instanceof Error && error.message) {
    return error.message;
  }

  return "Authentication is not configured correctly.";
}

export function AuthProvider({ children, bootstrapError = null }) {
  const [state, setState] = useState(() => ({
    isAuthenticated: false,
    isLoading: true,
    error: bootstrapError ? buildErrorMessage(bootstrapError) : "",
    user: null,
  }));

  const refreshAuthState = useCallback(async () => {
    if (bootstrapError) {
      setState({
        isAuthenticated: false,
        isLoading: false,
        error: buildErrorMessage(bootstrapError),
        user: null,
      });
      return;
    }

    // Voice Studio email + password session (no Microsoft account).
    const passwordUser = studioSessionUser();
    if (passwordUser) {
      setState({ isAuthenticated: true, isLoading: false, error: "", user: passwordUser });
      return;
    }

    if (!isMsalAuthEnabled()) {
      const authenticated =
        window.localStorage.getItem(MOCK_AUTH_STORAGE_KEY) === "true";
      setState({
        isAuthenticated: authenticated,
        isLoading: false,
        error: "",
        user: authenticated ? getMockUser() : null,
      });
      return;
    }

    try {
      const account = await getCurrentAccount();
      const policyError = getAccountPolicyError(account);

      if (!account || policyError) {
        setState({
          isAuthenticated: false,
          isLoading: false,
          error: policyError,
          user: null,
        });
        return;
      }

      setState({
        isAuthenticated: true,
        isLoading: false,
        error: "",
        user: mapAccountToUser(account),
      });
    } catch (error) {
      setState({
        isAuthenticated: false,
        isLoading: false,
        error: buildErrorMessage(error),
        user: null,
      });
    }
  }, [bootstrapError]);

  useEffect(() => {
    void refreshAuthState();
  }, [refreshAuthState]);

  const signIn = useCallback(
    async (redirectPath = "/") => {
      if (config.authMode === "mock") {
        window.localStorage.setItem(MOCK_AUTH_STORAGE_KEY, "true");
        setState({
          isAuthenticated: true,
          isLoading: false,
          error: "",
          user: getMockUser(),
        });
        return;
      }

      setState((current) => ({
        ...current,
        isLoading: true,
        error: "",
      }));

      try {
        await signInWithMicrosoft(redirectPath);
      } catch (error) {
        setState((current) => ({
          ...current,
          isLoading: false,
          error: buildErrorMessage(error),
        }));
        throw error;
      }
    },
    [],
  );

  const signOut = useCallback(async () => {
    if (studioSessionUser()) {
      clearStudioSession();
      setState({ isAuthenticated: false, isLoading: false, error: "", user: null });
      return;
    }

    if (config.authMode === "mock") {
      window.localStorage.removeItem(MOCK_AUTH_STORAGE_KEY);
      setState({
        isAuthenticated: false,
        isLoading: false,
        error: "",
        user: null,
      });
      return;
    }

    await signOutFromMicrosoft();
  }, []);

  const value = useMemo(
    () => ({
      ...state,
      authMode: config.authMode,
      signIn,
      signOut,
      refreshAuthState,
    }),
    [refreshAuthState, signIn, signOut, state],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export { AuthContext };
