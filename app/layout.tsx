import type { Metadata } from 'next';
import { Geist_Mono, Manrope } from 'next/font/google';
import './globals.css';

const manrope = Manrope({
  variable: '--font-manrope',
  subsets: ['latin'],
});

const geistMono = Geist_Mono({
  variable: '--font-geist-mono',
  subsets: ['latin'],
});

export const metadata: Metadata = {
  title: 'Plinth Playground — Compile Plinth in your browser',
  description: 'Write Plinth Haskell and compile it locally to Untyped Plutus Core and Flat bytes with the real Plinth compiler.',
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en">
      <body className={`${manrope.variable} ${geistMono.variable}`}>{children}</body>
    </html>
  );
}
