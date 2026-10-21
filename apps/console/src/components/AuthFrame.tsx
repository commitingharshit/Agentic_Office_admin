import type { ReactNode } from 'react';

/** The shared frame for sign-in, verification and the landing page: the real mark, centered, nothing else. */
export function AuthFrame({ title, children }: { title: string; children: ReactNode }) {
  return (
    <main className="auth-page">
      <div className="auth">
        <div className="brand"><img src="/agentic-office-icon.svg" alt="" /><span>Agentic Office</span></div>
        <h1>{title}</h1>
        {children}
      </div>
    </main>
  );
}
