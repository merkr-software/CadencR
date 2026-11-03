interface DocPage {
  slug: string;
  title: string;
  navLabel: string;
  description: string;
  section:
    | "Start Here"
    | "Core Views"
    | "Features"
    | "Reference"
    | "Libraries"
    | "npm packages"
    | "Rust crates";
}

const DOC_PAGES: DocPage[] = [
  {
    slug: "",
    title: "Docs",
    navLabel: "Overview",
    description: "Practical guides to the current CadencR workspace, agents, and review workflows.",
    section: "Start Here",
  },
  {
    slug: "installation",
    title: "Install CadencR on macOS and Linux",
    navLabel: "Installation",
    description: "Download, install, update, and uninstall CadencR on macOS and Linux.",
    section: "Start Here",
  },
  {
    slug: "concept",
    title: "The IDE for the era of agents",
    navLabel: "Concept",
    description: "How projects, conversations, agents, and worktrees fit together.",
    section: "Start Here",
  },
  {
    slug: "workspace-pages",
    title: "Workspace pages",
    navLabel: "Workspace Pages",
    description: "Find conversations, schedules, tools, and settings in the current workspace.",
    section: "Start Here",
  },
  {
    slug: "feature-workspace",
    title: "Feature workspace",
    navLabel: "Feature Workspace",
    description: "Work with an agent, files, a browser, terminal, and Git in one task workspace.",
    section: "Core Views",
  },
  {
    slug: "session-view",
    title: "Session view",
    navLabel: "Session View",
    description: "Read, navigate, copy, and continue an agent conversation.",
    section: "Core Views",
  },
  {
    slug: "unified-agent-list",
    title: "Unified agent list",
    navLabel: "Unified Agent List",
    description: "Supervise several conversations in a searchable, adjustable live grid.",
    section: "Core Views",
  },
  {
    slug: "sidebar",
    title: "Sidebar",
    navLabel: "Sidebar",
    description:
      "Shape conversation navigation around focus, supervision, and the work that needs you.",
    section: "Core Views",
  },
  {
    slug: "prompting",
    title: "Prompt",
    navLabel: "Prompt",
    description: "Give agents context, choose their runtime, and send or schedule work.",
    section: "Features",
  },
  {
    slug: "git",
    title: "Git in CadencR",
    navLabel: "Git",
    description:
      "Review changes, manage branches and stashes, and work with GitHub or GitLab review.",
    section: "Features",
  },
  {
    slug: "editor",
    title: "Editor",
    navLabel: "Editor",
    description:
      "Navigate files, edit with language tooling, draw diagrams, or use your own Neovim.",
    section: "Features",
  },
  {
    slug: "terminal",
    title: "Terminal",
    navLabel: "Terminal",
    description: "Run commands in persistent shell panes tied to your conversation.",
    section: "Features",
  },
  {
    slug: "browser",
    title: "Browser",
    navLabel: "Browser",
    description:
      "Preview local apps, keep browser tabs scoped to a feature, and send page context back to an agent.",
    section: "Features",
  },
  {
    slug: "mcp",
    title: "MCP & orchestration",
    navLabel: "MCP & Orchestration",
    description:
      "Use CadencR's workspace and project MCP tools to search session history, coordinate agents, and run provider-neutral orchestration commands.",
    section: "Features",
  },
  {
    slug: "custom-actions",
    title: "Custom actions",
    navLabel: "Custom Actions",
    description:
      "Reusable shell commands you can run on demand or on a schedule against any feature, with project-defined variables.",
    section: "Features",
  },
  {
    slug: "schedules",
    title: "Schedules",
    navLabel: "Schedules",
    description: "Send agent prompts once or on a recurring rule, in the conversation you choose.",
    section: "Features",
  },
  {
    slug: "rewind-and-fork",
    title: "Rewind & Fork",
    navLabel: "Rewind & Fork",
    description:
      "Return to an earlier turn or branch a conversation while understanding what happens to code.",
    section: "Features",
  },
  {
    slug: "usage-stats",
    title: "Usage Stats",
    navLabel: "Usage Stats",
    description:
      "Inspect durable token and message activity by day, provider, model, and thinking level.",
    section: "Features",
  },
  {
    slug: "marketplace",
    title: "Marketplace",
    navLabel: "Marketplace",
    description:
      "Discover, install, update, and manage plugins, themes, providers, custom tabs, skills, and MCP servers.",
    section: "Features",
  },
  {
    slug: "themes",
    title: "Themes & appearance",
    navLabel: "Themes",
    description: "Install a marketplace theme or create, edit, export, and publish your own.",
    section: "Features",
  },
  {
    slug: "shortcuts",
    title: "Shortcuts",
    navLabel: "Shortcuts",
    description:
      "A practical keyboard shortcuts guide for moving around CadencR with less mouse travel and less hunting around.",
    section: "Features",
  },
  {
    slug: "approvals",
    title: "Approvals & permissions",
    navLabel: "Approvals & Permissions",
    description: "Choose provider modes and answer plan, tool, and question requests.",
    section: "Reference",
  },
  {
    slug: "worktrees",
    title: "Worktrees",
    navLabel: "Worktrees",
    description: "Choose a branch and checkout for a task, reuse work safely, and control cleanup.",
    section: "Reference",
  },
  {
    slug: "providers",
    title: "Providers & profiles",
    navLabel: "Providers",
    description:
      "Configure local agent CLIs, select native profiles, or author a local ACP connector.",
    section: "Reference",
  },
  {
    slug: "remote-access",
    title: "Remote access",
    navLabel: "Remote Access",
    description: "Pair a phone, tablet, or browser with the host running your workspace.",
    section: "Reference",
  },
  {
    slug: "settings",
    title: "Settings",
    navLabel: "Settings",
    description: "Find the current settings sections and the workflows they control.",
    section: "Reference",
  },
  {
    slug: "libraries",
    title: "Cadencr libraries for custom tabs and providers",
    navLabel: "Libraries overview",
    description:
      "Choose an npm package or Rust crate to build a Cadencr custom tab or agent provider.",
    section: "Libraries",
  },
  {
    slug: "marketplace-publishing",
    title: "Publish to the marketplace",
    navLabel: "Publish to the marketplace",
    description:
      "Prepare an extension, publish immutable GitHub Release assets, and submit a marketplace registry pull request.",
    section: "Libraries",
  },
  {
    slug: "tab-sdk",
    title: "@cadencr/tab-sdk — custom tab SDK",
    navLabel: "@cadencr/tab-sdk",
    description:
      "Connect a custom tab to Cadencr, call typed APIs, subscribe to events, and test with a fake host.",
    section: "npm packages",
  },
  {
    slug: "tab-kit",
    title: "@cadencr/tab-kit — custom tab UI",
    navLabel: "@cadencr/tab-kit",
    description:
      "Build theme-aware custom tabs with React components, bundled fonts, and a Tailwind CSS v4 preset.",
    section: "npm packages",
  },
  {
    slug: "tab-backend",
    title: "cadencr-tab-backend — native custom tab backends",
    navLabel: "cadencr-tab-backend",
    description:
      "Write a Rust backend for a custom tab with stdio framing, scoped API access, and conformance checks.",
    section: "Rust crates",
  },
  {
    slug: "provider-sdk",
    title: "cadencr-provider-sdk — agent provider harness",
    navLabel: "cadencr-provider-sdk",
    description:
      "Implement the command contract for a native Cadencr agent provider speaking ACP v1.",
    section: "Rust crates",
  },
];

interface DocSection {
  title: DocPage["section"];
  pages: DocPage[];
}

const SECTION_ORDER: DocPage["section"][] = [
  "Start Here",
  "Core Views",
  "Features",
  "Reference",
  "Libraries",
  "npm packages",
  "Rust crates",
];

export const DOC_SECTIONS: DocSection[] = SECTION_ORDER.map((section) => ({
  title: section,
  pages: DOC_PAGES.filter((page) => page.section === section),
}));

export function getDocHref(slug: string): string {
  const base = import.meta.env.BASE_URL;
  return slug.length > 0 ? `${base}docs/${slug}/` : `${base}docs/`;
}
