interface DocPage {
  slug: string;
  title: string;
  navLabel: string;
  description: string;
  section: "Start Here" | "Core Views" | "Features" | "Reference";
}

const DOC_PAGES: DocPage[] = [
  {
    slug: "",
    title: "Docs",
    navLabel: "Overview",
    description: "Start here for the short version of what Cadencr is and where to click next.",
    section: "Start Here",
  },
  {
    slug: "concept",
    title: "The IDE for the era of agents",
    navLabel: "Concept",
    description:
      "What Cadencr is, who it is for, and why it feels different from regular chat tools.",
    section: "Start Here",
  },
  {
    slug: "workspace-pages",
    title: "Workspace pages",
    navLabel: "Workspace Pages",
    description: "A guided tour of the major surfaces you will bounce between while working.",
    section: "Start Here",
  },
  {
    slug: "feature-workspace",
    title: "Feature workspace",
    navLabel: "Feature Workspace",
    description: "How a feature becomes your home base for files, agents, terminal, and Git.",
    section: "Core Views",
  },
  {
    slug: "session-view",
    title: "Session view",
    navLabel: "Session View",
    description: "How to read an agent session, stay oriented, and steer work without chaos.",
    section: "Core Views",
  },
  {
    slug: "unified-agent-list",
    title: "Unified agent list",
    navLabel: "Unified Agent List",
    description: "Find, filter, scan, and pin agent sessions across your workspace.",
    section: "Core Views",
  },
  {
    slug: "prompting",
    title: "Prompt",
    navLabel: "Prompt",
    description:
      "How to ask for work clearly without turning every prompt into a tiny legal document.",
    section: "Features",
  },
  {
    slug: "git",
    title: "Git in Cadencr",
    navLabel: "Git",
    description: "How Git shows up in the product and how to stay confident instead of git-scared.",
    section: "Features",
  },
  {
    slug: "editor",
    title: "Editor",
    navLabel: "Editor",
    description:
      "Browse files, open diffs, split panes, and stay close to the code without getting buried.",
    section: "Features",
  },
  {
    slug: "terminal",
    title: "Terminal",
    navLabel: "Terminal",
    description: "Use the built-in terminal when agent work needs a little human keyboard energy.",
    section: "Features",
  },
  {
    slug: "browser",
    title: "Browser",
    navLabel: "Browser",
    description: "Preview local apps, keep tabs feature-scoped, and send page context to agents.",
    section: "Features",
  },
  {
    slug: "custom-actions",
    title: "Custom actions",
    navLabel: "Custom Actions",
    description: "What the plus button does and why it is more helpful than it first looks.",
    section: "Features",
  },
  {
    slug: "shortcuts",
    title: "Shortcuts",
    navLabel: "Shortcuts",
    description: "A practical keyboard cheat sheet for faster navigation and less mouse mileage.",
    section: "Features",
  },
  {
    slug: "approvals",
    title: "Approvals & permissions",
    navLabel: "Approvals & Permissions",
    description:
      "Plan approval, tool permissions, multi-choice questions, and the permission-mode toggle.",
    section: "Reference",
  },
  {
    slug: "worktrees",
    title: "Worktrees",
    navLabel: "Worktrees",
    description: "Why each feature lives in its own Git worktree and how to work with them safely.",
    section: "Reference",
  },
  {
    slug: "settings",
    title: "Settings",
    navLabel: "Settings",
    description: "A tour of every Settings section and when you actually need it.",
    section: "Reference",
  },
];

interface DocSection {
  title: DocPage["section"];
  pages: DocPage[];
}

const SECTION_ORDER: DocPage["section"][] = ["Start Here", "Core Views", "Features", "Reference"];

export const DOC_SECTIONS: DocSection[] = SECTION_ORDER.map((section) => ({
  title: section,
  pages: DOC_PAGES.filter((page) => page.section === section),
}));

export function getDocHref(slug: string): string {
  const base = import.meta.env.BASE_URL;
  return slug.length > 0 ? `${base}docs/${slug}/` : `${base}docs/`;
}
