import type { Metadata } from 'next';
import './globals.css';

export const metadata: Metadata = {
  title: 'Gas Town Control Center',
  description: 'AI Agent Orchestration Engine — MEOW Stack',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
