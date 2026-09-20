'use client';

import React from 'react';

export default function Button({
  variant = 'primary',
  size = 'md',
  children,
  className = '',
  disabled = false,
  ...props
}) {
  const baseStyles = "inline-flex items-center justify-center rounded-[0.65rem] font-semibold transition-colors duration-150 focus:outline-none focus:ring-2 focus:ring-[var(--accent-primary)] focus:ring-offset-2 focus:ring-offset-[var(--bg-primary)] disabled:opacity-50 disabled:cursor-not-allowed";

  /**
   * `--accent-gradient` was never defined in globals.css, so `primary` resolved
   * to no background at all — white text on whatever was behind it. And
   * `secondary`/`ghost` hard-coded `text-white`, which is invisible on the light
   * theme. All four variants now use tokens that exist in both themes.
   */
  const variants = {
    primary: "bg-[var(--accent-primary-strong)] hover:bg-[var(--accent-primary)] text-white border border-[var(--accent-primary-strong)]",
    secondary: "bg-[var(--surface-raised)] border border-[var(--surface-border)] text-[var(--on-surface)] hover:bg-[var(--bg-muted)] focus:ring-[var(--accent-primary)]",
    ghost: "bg-transparent text-[var(--text-secondary)] hover:text-[var(--text-primary)] hover:bg-[var(--bg-muted)] border-transparent focus:ring-[var(--accent-primary)]",
    danger: "bg-red-500/10 border border-red-500/50 text-red-600 dark:text-red-400 hover:bg-red-500 hover:text-white focus:ring-red-500",
  };
  
  const sizes = {
    sm: "px-3 py-1.5 text-sm",
    md: "px-4 py-2 text-base",
    lg: "px-6 py-3 text-lg",
  };

  return (
    <button
      className={`${baseStyles} ${variants[variant]} ${sizes[size]} ${className}`}
      disabled={disabled}
      {...props}
    >
      {children}
    </button>
  );
}
