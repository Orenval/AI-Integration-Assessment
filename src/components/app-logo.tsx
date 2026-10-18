import React from "react";

interface AppLogoProps extends React.SVGProps<SVGSVGElement> {
  size?: number;
  className?: string;
}

export function AppLogo({ size = 32, className, ...props }: AppLogoProps) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 64 64"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      className={className}
      aria-label="AI Integration Logo"
      {...props}
    >
      {/* Left Antenna */}
      <line
        x1="23"
        y1="19"
        x2="16"
        y2="9"
        stroke="#2563eb"
        strokeWidth="3.5"
        strokeLinecap="round"
      />
      <circle cx="15" cy="8" r="4.5" fill="#2563eb" />

      {/* Right Antenna */}
      <line
        x1="41"
        y1="19"
        x2="48"
        y2="9"
        stroke="#2563eb"
        strokeWidth="3.5"
        strokeLinecap="round"
      />
      <circle cx="49" cy="8" r="4.5" fill="#2563eb" />

      {/* Left Ear */}
      <rect x="7" y="29" width="4" height="11" rx="2" fill="#2563eb" />

      {/* Right Ear */}
      <rect x="53" y="29" width="4" height="11" rx="2" fill="#2563eb" />

      {/* Robot Head with rounded corners */}
      <rect x="10" y="18" width="44" height="36" rx="10" fill="#2563eb" />

      {/* White Eyes */}
      <circle cx="23" cy="33" r="5" fill="#ffffff" />
      <circle cx="41" cy="33" r="5" fill="#ffffff" />

      {/* White Friendly Smile */}
      <path
        d="M26 43 Q32 48 38 43"
        stroke="#ffffff"
        strokeWidth="3"
        strokeLinecap="round"
        fill="none"
      />
    </svg>
  );
}
