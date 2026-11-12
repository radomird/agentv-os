// Shared by the screen checks that look at what's drawn: everything on a
// screen that's cut off. T4.1 (sizes.test.mts) and T14.2 (words.test.mts)
// both use it.

import type { Page } from "playwright-core";

// Everything on the page that's cut off: off the screen, past the edge of the
// box it's drawn in, under the status bar, or clipped inside itself, unless
// that's an ellipsis or a line clamp, or it's in a list that scrolls.
// Within is what to look at, the page or the screen saver by default; an
// overlay, such as the PIN pad, covers the status bar, so the bar doesn't
// count for it.
export function cutOff(page: Page, within?: string, overlay = false): Promise<string[]> {
  return page.evaluate(([within, overlay]) => {
    const found: string[] = [];
    // Each thing once: what's inside something already found isn't said again.
    const flagged = new Set<Element>();
    const push = (el: Element, text: string) => {
      for (let at: Element | null = el; at; at = at.parentElement) if (flagged.has(at)) return;
      flagged.add(el);
      found.push(text);
    };
    const say = (el: Element) => (el.textContent ?? "").trim().replace(/\s+/g, " ").slice(0, 40) || (el as HTMLElement).dataset.action || String(el.className);
    const clips = (style: CSSStyleDeclaration) => style.overflowX !== "visible" || style.overflowY !== "visible";
    const scrolls = (el: Element, style: CSSStyleDeclaration) => el.hasAttribute("data-scroll") || /auto|scroll/.test(style.overflowY) || /auto|scroll/.test(style.overflowX);
    const shortened = (style: CSSStyleDeclaration) => style.textOverflow === "ellipsis" || (style.webkitLineClamp !== "none" && style.webkitLineClamp !== "");
    const barEl = overlay ? null : document.querySelector("#page .bar");
    const bar = barEl?.getBoundingClientRect() ?? null;
    const shown = within ?? (document.querySelector("#ambient.on") ? "#ambient.on *" : "#page *");
    for (const el of document.querySelectorAll<HTMLElement>(shown)) {
      const style = getComputedStyle(el);
      if (style.visibility !== "visible" || el.closest("svg, [aria-hidden='true']") || el instanceof HTMLImageElement) continue;
      const own = [...el.childNodes].some((node) => node.nodeType === Node.TEXT_NODE && node.textContent!.trim());
      if (!own && !el.hasAttribute("data-focus")) continue;
      const box = el.getBoundingClientRect();
      if (!box.width || !box.height) continue;
      let opacity = 1;
      for (let at: Element | null = el; at; at = at.parentElement) opacity *= Number(getComputedStyle(at).opacity);
      if (opacity === 0) continue;
      // Inside itself: words that don't fit and aren't shortened on purpose.
      if (own && clips(style) && !shortened(style) && !scrolls(el, style) && (el.scrollWidth > el.clientWidth + 1 || el.scrollHeight > el.clientHeight + 1)) {
        push(el, `"${say(el)}" doesn't fit in itself`);
        continue;
      }
      // In a list that scrolls, what's below comes into view with the
      // focus, so only the part in sight counts. A list must stop above a
      // status bar along the bottom, or what it scrolls into view ends up
      // under it. (Glass and Cinema have theirs along the top, and their
      // pages start below it.)
      let seen: DOMRect | null = box;
      for (let at = el.parentElement; at && at !== document.body; at = at.parentElement) {
        if (!scrolls(at, getComputedStyle(at))) continue;
        const edge = at.getBoundingClientRect();
        // The part of the list in sight: a list inside another that scrolls
        // is cut off at that one's edges.
        let shownTop = edge.top;
        let shownBottom = edge.bottom;
        for (let outer = at.parentElement; outer && outer !== document.body; outer = outer.parentElement) {
          if (!scrolls(outer, getComputedStyle(outer))) continue;
          const outerEdge = outer.getBoundingClientRect();
          shownTop = Math.max(shownTop, outerEdge.top);
          shownBottom = Math.min(shownBottom, outerEdge.bottom);
        }
        const bottomBar = bar && bar.top > innerHeight / 2;
        if (bottomBar && barEl && !at.contains(barEl) && shownBottom > bar.top + 1) push(at, `the list "${say(at)}" runs under the status bar`);
        const top = Math.max(box.top, shownTop);
        const bottom = Math.min(box.bottom, shownBottom);
        seen = bottom > top ? new DOMRect(box.left, top, box.width, bottom - top) : null;
        break;
      }
      const inScroller = seen !== box;
      // The box it's drawn in: the nearest one that clips and doesn't scroll.
      for (let at = el.parentElement; at && at !== document.body; at = at.parentElement) {
        const outer = getComputedStyle(at);
        if (!clips(outer)) continue;
        if (scrolls(at, outer)) break;
        const edge = at.getBoundingClientRect();
        if (box.left < edge.left - 1 || box.right > edge.right + 1 || box.top < edge.top - 1 || box.bottom > edge.bottom + 1) {
          push(el, `"${say(el)}" is cut off by its ${at.className || at.tagName.toLowerCase()}`);
        }
        break;
      }
      if (seen && bar && barEl && !barEl.contains(el) && !el.contains(barEl) && seen.bottom > bar.top + 1 && seen.top < bar.bottom - 1 && seen.right > bar.left && seen.left < bar.right) {
        push(el, `"${say(el)}" is under the status bar`);
      }
      if (inScroller) continue;
      if (box.left < -1 || box.top < -1 || box.right > innerWidth + 1 || box.bottom > innerHeight + 1) push(el, `"${say(el)}" is off the screen`);
    }
    return found;
  }, [within, overlay] as const);
}
