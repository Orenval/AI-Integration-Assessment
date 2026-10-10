"use client";

import { useState, useEffect, useRef, useCallback } from "react";
import { useAuth } from "@/context/auth-context";

// Palette used to derive a per-user avatar background. The color is picked
// deterministically from the user's identity so it is stable across sessions
// but varies between users.
const AVATAR_COLORS = [
  "#E8837D",
  "#F59E0B",
  "#10B981",
  "#3B82F6",
  "#8B5CF6",
  "#EC4899",
  "#14B8A6",
  "#F97316",
  "#6366F1",
  "#EF4444",
];

function hashString(value: string): number {
  let hash = 0;
  for (let i = 0; i < value.length; i++) {
    hash = (hash * 31 + value.charCodeAt(i)) >>> 0;
  }
  return hash;
}

function getAvatarColor(seed: string): string {
  return AVATAR_COLORS[hashString(seed) % AVATAR_COLORS.length];
}

// Darken a hex color so the avatar's border is a contrasting shade that still
// matches the background colour's hue.
function darkenColor(hex: string, amount: number): string {
  const value = parseInt(hex.replace("#", ""), 16);
  const clamp = (v: number) => Math.max(0, Math.min(255, Math.round(v)));
  const r = clamp(((value >> 16) & 0xff) * (1 - amount));
  const g = clamp(((value >> 8) & 0xff) * (1 - amount));
  const b = clamp((value & 0xff) * (1 - amount));
  return `rgb(${r}, ${g}, ${b})`;
}

function getInitials(fullName: string): string {
  const parts = fullName.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return "?";
  if (parts.length === 1) return parts[0][0].toUpperCase();
  return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
}

export function DashboardHeader({
  user,
}: {
  user: { fullName: string; email: string };
}) {
  const { signOut } = useAuth();
  const [open, setOpen] = useState(false);
  const [isSigningOut, setIsSigningOut] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);

  // Close the dropdown on outside click and Escape.
  useEffect(() => {
    if (!open) return;

    const handlePointerDown = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    };
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };

    document.addEventListener("mousedown", handlePointerDown);
    document.addEventListener("keydown", handleKeyDown);
    return () => {
      document.removeEventListener("mousedown", handlePointerDown);
      document.removeEventListener("keydown", handleKeyDown);
    };
  }, [open]);

  const handleSignOut = useCallback(async () => {
    setIsSigningOut(true);
    try {
      await signOut();
    } finally {
      setIsSigningOut(false);
    }
  }, [signOut]);

  const initials = getInitials(user.fullName);
  const avatarColor = getAvatarColor(`${user.email}:${user.fullName}`);

  return (
    <header className="dashboard-header">
      <div className="dashboard-header__brand">Auth</div>

      <div className="user-menu" ref={menuRef}>
        <button
          type="button"
          className="user-avatar"
          style={{
            backgroundColor: avatarColor,
            borderColor: darkenColor(avatarColor, 0.25),
          }}
          onClick={() => setOpen((prev) => !prev)}
          aria-haspopup="menu"
          aria-expanded={open}
          aria-label="Open account menu"
          title={user.fullName}
        >
          {initials}
        </button>

        {open && (
          <div className="user-menu-dropdown" role="menu">
            <div className="user-menu-info">
              <span className="user-menu-name">{user.fullName}</span>
              <span className="user-menu-email">{user.email}</span>
            </div>
            <button
              type="button"
              role="menuitem"
              className="user-menu-signout"
              onClick={handleSignOut}
              disabled={isSigningOut}
            >
              {isSigningOut ? "Signing out..." : "Sign out"}
            </button>
          </div>
        )}
      </div>
    </header>
  );
}