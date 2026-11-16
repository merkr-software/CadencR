import { useState, useCallback, useEffect, useMemo, useRef } from "react";
import { Search, ChevronUp, ChevronDown, X } from "lucide-react";
import { formatCompactCombo } from "@/lib/shortcuts/format";

// Mirrors the input's Shift+Enter handler.
const PREVIOUS_MATCH_COMBO = formatCompactCombo(["shift", "enter"]);

interface DiffSearchProps {
  /** Container element to search within */
  containerRef: React.RefObject<HTMLElement | null>;
}

function clearHighlightElements(highlights: HTMLElement[]): void {
  for (const element of highlights) {
    const parent = element.parentNode;
    if (parent) {
      parent.replaceChild(document.createTextNode(element.textContent ?? ""), element);
      parent.normalize();
    }
  }
}

function createDiffHighlights(container: HTMLElement, searchText: string): HTMLElement[] {
  const walker = document.createTreeWalker(container, NodeFilter.SHOW_TEXT, null);
  const textNodes: Text[] = [];
  let node: Node | null;
  while ((node = walker.nextNode())) textNodes.push(node as Text);

  const lowerQuery = searchText.toLowerCase();
  const highlights: HTMLElement[] = [];
  for (let index = textNodes.length - 1; index >= 0; index -= 1) {
    const textNode = textNodes[index];
    const text = textNode.textContent ?? "";
    const parent = textNode.parentNode;
    if (!parent || (parent as HTMLElement).closest?.("[data-diff-search]")) continue;

    const lowerText = text.toLowerCase();
    const positions: number[] = [];
    let position = 0;
    while ((position = lowerText.indexOf(lowerQuery, position)) !== -1) {
      positions.push(position);
      position += lowerQuery.length;
    }
    if (positions.length === 0) continue;

    const fragment = document.createDocumentFragment();
    let lastEnd = 0;
    for (const start of positions) {
      if (start > lastEnd) {
        fragment.appendChild(document.createTextNode(text.slice(lastEnd, start)));
      }
      const mark = document.createElement("mark");
      mark.setAttribute("data-diff-search-match", "true");
      mark.className = "bg-[#f1fa8c]/40 text-inherit rounded-sm";
      mark.textContent = text.slice(start, start + searchText.length);
      fragment.appendChild(mark);
      highlights.push(mark);
      lastEnd = start + searchText.length;
    }
    if (lastEnd < text.length) {
      fragment.appendChild(document.createTextNode(text.slice(lastEnd)));
    }
    parent.replaceChild(fragment, textNode);
  }
  return highlights.reverse();
}

function useDiffSearchController(containerRef: DiffSearchProps["containerRef"]) {
  const [query, setQuery] = useState("");
  const [matchCount, setMatchCount] = useState(0);
  const [currentIndex, setCurrentIndex] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const highlightsRef = useRef<HTMLElement[]>([]);
  const clearHighlights = useCallback(() => {
    clearHighlightElements(highlightsRef.current);
    highlightsRef.current = [];
    setMatchCount(0);
    setCurrentIndex(0);
  }, []);
  const performSearch = useCallback(
    (searchText: string) => {
      clearHighlights();
      if (!searchText.trim() || !containerRef.current) return;
      const highlights = createDiffHighlights(containerRef.current, searchText);
      highlightsRef.current = highlights;
      setMatchCount(highlights.length);
      setCurrentIndex(0);
      if (highlights.length > 0) {
        highlights[0].className = "bg-[#ffb86c] text-[#282a36] rounded-sm";
        highlights[0].scrollIntoView({ behavior: "smooth", block: "center" });
      }
    },
    [clearHighlights, containerRef],
  );
  const navigateTo = useCallback(
    (index: number) => {
      const highlights = highlightsRef.current;
      if (highlights.length === 0) return;
      const previous = highlights[currentIndex];
      if (previous) previous.className = "bg-[#f1fa8c]/40 text-inherit rounded-sm";
      const next = ((index % highlights.length) + highlights.length) % highlights.length;
      const element = highlights[next];
      if (element) {
        element.className = "bg-[#ffb86c] text-[#282a36] rounded-sm";
        element.scrollIntoView({ behavior: "smooth", block: "center" });
      }
      setCurrentIndex(next);
    },
    [currentIndex],
  );
  const goNext = useCallback(() => navigateTo(currentIndex + 1), [currentIndex, navigateTo]);
  const goPrev = useCallback(() => navigateTo(currentIndex - 1), [currentIndex, navigateTo]);
  const handleClear = useCallback(() => {
    setQuery("");
    clearHighlights();
    inputRef.current?.focus();
  }, [clearHighlights]);
  useEffect(() => {
    const timer = setTimeout(() => performSearch(query), 200);
    return () => clearTimeout(timer);
  }, [performSearch, query]);
  useEffect(() => () => clearHighlights(), [clearHighlights]);
  return useMemo(
    () => ({
      query,
      setQuery,
      matchCount,
      currentIndex,
      inputRef,
      goNext,
      goPrev,
      handleClear,
    }),
    [currentIndex, goNext, goPrev, handleClear, matchCount, query],
  );
}

/**
 * Search-in-diff component. Searches rendered diff DOM text and highlights matches.
 * Supports navigation between matches with up/down arrows and keyboard shortcuts.
 */
export function DiffSearch({ containerRef }: DiffSearchProps) {
  const controller = useDiffSearchController(containerRef);

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key === "Enter") {
        e.preventDefault();
        if (e.shiftKey) {
          controller.goPrev();
        } else {
          controller.goNext();
        }
      } else if (e.key === "Escape") {
        controller.handleClear();
      }
    },
    [controller],
  );

  return (
    <div data-diff-search className="flex items-center gap-1.5 rounded bg-[#44475a] px-2 py-1">
      <Search className="h-3.5 w-3.5 text-[#6272a4]" />
      <input
        ref={controller.inputRef}
        type="text"
        value={controller.query}
        onChange={(e) => controller.setQuery(e.target.value)}
        onKeyDown={handleKeyDown}
        placeholder="Search in diff"
        className="w-36 bg-transparent text-xs text-[#f8f8f2] placeholder-[#6272a4] outline-none"
      />
      {controller.query && (
        <>
          <span className="text-xs text-[#6272a4]">
            {controller.matchCount > 0
              ? `${controller.currentIndex + 1}/${controller.matchCount}`
              : "0/0"}
          </span>
          <button
            onClick={controller.goPrev}
            className="rounded p-0.5 text-[#6272a4] hover:text-[#f8f8f2]"
            title={`Previous match (${PREVIOUS_MATCH_COMBO})`}
          >
            <ChevronUp className="h-3.5 w-3.5" />
          </button>
          <button
            onClick={controller.goNext}
            className="rounded p-0.5 text-[#6272a4] hover:text-[#f8f8f2]"
            title="Next match (Enter)"
          >
            <ChevronDown className="h-3.5 w-3.5" />
          </button>
          <button
            onClick={controller.handleClear}
            className="rounded p-0.5 text-[#6272a4] hover:text-[#f8f8f2]"
            title="Clear search (Escape)"
          >
            <X className="h-3.5 w-3.5" />
          </button>
        </>
      )}
    </div>
  );
}
