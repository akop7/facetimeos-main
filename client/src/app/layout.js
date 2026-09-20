import { Geist, Geist_Mono } from 'next/font/google';
import './globals.css';
import { AuthProvider } from '../context/AuthContext';
import { ThemeProvider } from '../context/ThemeContext';

const body = Geist({
  subsets: ['latin'],
  variable: '--font-body',
});

const mono = Geist_Mono({
  subsets: ['latin'],
  variable: '--font-mono',
});

export const metadata = {
  title: 'FaceTimeOS — The call where the work stays open',
  description: 'A shared room for video, code, whiteboards, notes, and decisions that stay there when the call ends.',
  keywords: 'webrtc, collaboration, video call, spatial, code editor, whiteboard, peer-to-peer',
};

export default function RootLayout({ children }) {
  return (
    <html
      lang="en"
      className={`${body.variable} ${mono.variable} h-full antialiased`}
      data-scroll-behavior="smooth"
      suppressHydrationWarning
    >
      <body className="min-h-full flex flex-col transition-colors duration-300" style={{ fontFamily: 'var(--font-body)' }}>
        <ThemeProvider>
          <AuthProvider>
            {children}
          </AuthProvider>
        </ThemeProvider>
      </body>
    </html>
  );
}
