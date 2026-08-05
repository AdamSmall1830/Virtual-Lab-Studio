import React, { createContext, useContext, useEffect, useState } from 'react';
import { useWorkspace } from '@/demo/useWorkspace';
import { mutate } from '@/demo/store';

type ThemeProviderProps = {
  children: React.ReactNode;
};

export function ThemeProvider({ children }: ThemeProviderProps) {
  const workspace = useWorkspace();
  const theme = workspace.theme;

  useEffect(() => {
    const root = window.document.documentElement;
    root.classList.remove('light', 'dark');
    root.dataset.theme = theme;
    root.classList.add(theme);
  }, [theme]);

  const toggleTheme = () => {
    mutate((state) => {
      state.theme = state.theme === 'dark' ? 'light' : 'dark';
    });
  };

  return (
    <div className="min-h-[100dvh] w-full vls-app-background flex flex-col">
      {children}
    </div>
  );
}
