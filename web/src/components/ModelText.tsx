import type { ReactNode } from "react";

// The agent's model writes light markdown. Bold and inline code become elements; the rest
// stays plain text, so nothing an attacker gets the model to write can turn into HTML.

const MARKS = /\*\*([^*\n]+)\*\*|`([^`\n]+)`/g;

export function ModelText({ text }: { text: string }) {
  const plain = text.replace(/^#{1,6} /gm, "");
  const parts: ReactNode[] = [];
  let last = 0;
  for (const match of plain.matchAll(MARKS)) {
    parts.push(plain.slice(last, match.index));
    parts.push(
      match[1] !== undefined ? (
        <strong key={match.index}>{match[1]}</strong>
      ) : (
        <code key={match.index}>{match[2]}</code>
      ),
    );
    last = match.index + match[0].length;
  }
  parts.push(plain.slice(last));
  return <>{parts}</>;
}
