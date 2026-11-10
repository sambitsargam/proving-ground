// Small motion helpers. Every one of them settles instantly under reduced motion.
import { type RefObject, useEffect, useRef, useState } from "react";

export function prefersReducedMotion(): boolean {
  return window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}

/** True once the element has scrolled into view. It stays true. */
export function useInView<T extends Element>(
  margin = "0px 0px -12% 0px",
): [RefObject<T | null>, boolean] {
  const ref = useRef<T>(null);
  const [seen, setSeen] = useState(false);
  useEffect(() => {
    const element = ref.current;
    if (!element || seen) return;
    if (!("IntersectionObserver" in window)) {
      setSeen(true);
      return;
    }
    const observer = new IntersectionObserver(
      ([entry]) => {
        if (entry?.isIntersecting) {
          setSeen(true);
          observer.disconnect();
        }
      },
      { rootMargin: margin },
    );
    observer.observe(element);
    return () => observer.disconnect();
  }, [margin, seen]);
  return [ref, seen];
}

/** Counts from 0 to `target` once `start` is true. Integers only. */
export function useCountUp(target: number, start: boolean, duration = 1100): number {
  const [value, setValue] = useState(0);
  useEffect(() => {
    if (!start) return;
    if (prefersReducedMotion() || target === 0) {
      setValue(target);
      return;
    }
    let frame = 0;
    const began = performance.now();
    const tick = (now: number) => {
      const t = Math.min((now - began) / duration, 1);
      setValue(Math.round(target * (1 - (1 - t) ** 3)));
      if (t < 1) frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  }, [target, start, duration]);
  return value;
}

/**
 * How far the page has scrolled through a tall element, 0 at its top and 1 when its end
 * reaches the bottom of the viewport. Written to `--progress` on the element and reported
 * through `onProgress`, without re-rendering on every frame.
 */
export function useScrollProgress<T extends HTMLElement>(
  onProgress: (progress: number) => void,
): RefObject<T | null> {
  const ref = useRef<T>(null);
  const callback = useRef(onProgress);
  callback.current = onProgress;
  useEffect(() => {
    const element = ref.current;
    if (!element) return;
    let frame = 0;
    const measure = () => {
      frame = 0;
      const box = element.getBoundingClientRect();
      const range = box.height - window.innerHeight;
      const progress = range > 0 ? Math.min(Math.max(-box.top / range, 0), 1) : 1;
      element.style.setProperty("--progress", progress.toFixed(4));
      callback.current(progress);
    };
    const schedule = () => {
      if (!frame) frame = requestAnimationFrame(measure);
    };
    measure();
    window.addEventListener("scroll", schedule, { passive: true });
    window.addEventListener("resize", schedule);
    return () => {
      window.removeEventListener("scroll", schedule);
      window.removeEventListener("resize", schedule);
      if (frame) cancelAnimationFrame(frame);
    };
  }, []);
  return ref;
}

/** Leans an element a few pixels toward the pointer, for the main calls to action. */
export function useMagnetic<T extends HTMLElement>(
  strength = 0.25,
  limit = 8,
): RefObject<T | null> {
  const ref = useRef<T>(null);
  useEffect(() => {
    const element = ref.current;
    if (!element || prefersReducedMotion()) return;
    if (!window.matchMedia("(hover: hover) and (pointer: fine)").matches) return;
    const move = (event: PointerEvent) => {
      const box = element.getBoundingClientRect();
      const clamp = (n: number) => Math.max(-limit, Math.min(limit, n));
      const x = clamp((event.clientX - (box.left + box.width / 2)) * strength);
      const y = clamp((event.clientY - (box.top + box.height / 2)) * strength);
      element.style.transform = `translate(${x}px, ${y}px)`;
    };
    const leave = () => {
      element.style.transform = "";
    };
    element.addEventListener("pointermove", move);
    element.addEventListener("pointerleave", leave);
    return () => {
      element.removeEventListener("pointermove", move);
      element.removeEventListener("pointerleave", leave);
    };
  }, [strength, limit]);
  return ref;
}
