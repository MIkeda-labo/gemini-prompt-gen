import './globals.css';

export const metadata = {
  title: 'Gemini Prompt Generator',
  description: 'AI-driven prompt improvement app with rich UI',
};

export default function RootLayout({ children }) {
  return (
    <html lang="ja">
      <body>
        {children}
      </body>
    </html>
  );
}
