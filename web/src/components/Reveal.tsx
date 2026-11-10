import type { CSSProperties, ElementType, ReactNode } from "react";
import { useInView } from "../lib/motion.ts";

/** Fades and lifts its content in the first time it scrolls into view. */
export function Reveal({
  as: Tag = "div",
  delay = 0,
  className = "",
  children,
}: {
  as?: ElementType;
  delay?: number;
  className?: string;
  children: ReactNode;
}) {
  const [ref, seen] = useInView<HTMLElement>();
  return (
    <Tag
      ref={ref}
      className={`reveal${seen ? " is-in" : ""}${className ? ` ${className}` : ""}`}
      style={{ "--delay": `${delay}ms` } as CSSProperties}
    >
      {children}
    </Tag>
  );
}
