"use client";

import React, { createContext, useContext, useState, useEffect, useCallback } from "react";
import { useRouter } from "next/navigation";
import { apiFetch, ensureCsrfToken } from "@/lib/api-client";

export interface User {
  id: string;
  fullName: string;
  email: string;
  emailVerified: boolean;
}

interface AuthContextType {
  user: User | null;
  isAuthenticated: boolean;
  isLoading: boolean;
  forgotPasswordEmail: string;
  setForgotPasswordEmail: (email: string) => void;
  consumeForgotPasswordEmail: () => string;
  refreshSession: () => Promise<User | null>;
  signOut: () => Promise<void>;
  setUser: (user: User | null) => void;
}

const AuthContext = createContext<AuthContextType | undefined>(undefined);

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const router = useRouter();
  const [user, setUser] = useState<User | null>(null);
  const [isLoading, setIsLoading] = useState<boolean>(true);
  const [forgotPasswordEmail, setForgotPasswordEmailState] = useState<string>("");

  const refreshSession = useCallback(async (): Promise<User | null> => {
    try {
      await ensureCsrfToken();
      const res = await apiFetch<{ user: User }>("/api/auth/session", {
        method: "GET",
      });

      if (res.success && res.data?.user) {
        setUser(res.data.user);
        setIsLoading(false);
        return res.data.user;
      } else {
        setUser(null);
        setIsLoading(false);
        return null;
      }
    } catch {
      setUser(null);
      setIsLoading(false);
      return null;
    }
  }, []);

  const signOut = useCallback(async () => {
    try {
      await apiFetch("/api/auth/signout");
    } catch {
      // Ignore network errors during sign-out
    } finally {
      setUser(null);
      router.push("/signin");
      router.refresh();
    }
  }, [router]);

  const setForgotPasswordEmail = useCallback((email: string) => {
    setForgotPasswordEmailState(email);
  }, []);

  const consumeForgotPasswordEmail = useCallback((): string => {
    const val = forgotPasswordEmail;
    setForgotPasswordEmailState("");
    return val;
  }, [forgotPasswordEmail]);

  useEffect(() => {
    let isMounted = true;
    ensureCsrfToken().finally(() => {
      apiFetch<{ user: User }>("/api/auth/session", { method: "GET" })
        .then((res) => {
          if (isMounted) {
            if (res.success && res.data?.user) {
              setUser(res.data.user);
            } else {
              setUser(null);
            }
            setIsLoading(false);
          }
        })
        .catch(() => {
          if (isMounted) {
            setUser(null);
            setIsLoading(false);
          }
        });
    });

    return () => {
      isMounted = false;
    };
  }, []);

  const value: AuthContextType = {
    user,
    isAuthenticated: !!user,
    isLoading,
    forgotPasswordEmail,
    setForgotPasswordEmail,
    consumeForgotPasswordEmail,
    refreshSession,
    signOut,
    setUser,
  };

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthContextType {
  const context = useContext(AuthContext);
  if (context === undefined) {
    throw new Error("useAuth must be used within an AuthProvider");
  }
  return context;
}
