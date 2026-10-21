import type { Metadata } from 'next';
import type { ReactNode } from 'react';
import '../styles/tokens.css';
import '../styles/admin.css';

export const metadata: Metadata = {
  title: { default: 'Agentic Office', template: '%s · Agentic Office' },
  description: 'Sign in and manage Agentic Office.',
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
