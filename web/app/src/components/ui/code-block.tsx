import { useEffect, useState } from 'react';
import { codeToHtml } from 'shiki';

export function CodeBlock({ code, language }: { code: string; language: string }) {
  const [html, setHtml] = useState<string>();
  useEffect(() => {
    let active = true;
    void codeToHtml(code, {
      lang: language || 'text',
      themes: { light: 'github-light', dark: 'github-dark' },
      defaultColor: false,
    })
      .then((highlighted) => {
        if (active) setHtml(highlighted);
      })
      .catch(() => {
        if (active) setHtml(undefined);
      });
    return () => {
      active = false;
    };
  }, [code, language]);

  if (!html)
    return (
      <pre className="my-3 overflow-x-auto rounded-lg bg-muted p-3">
        <code>{code}</code>
      </pre>
    );
  return (
    <div
      className="my-3 overflow-x-auto rounded-lg [&>pre]:p-3"
      dangerouslySetInnerHTML={{ __html: html }}
    />
  );
}
