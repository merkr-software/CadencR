import { act, render, screen } from "@testing-library/react";
import { expect, it, vi } from "vitest";
import { PROVIDER_IDS } from "@/lib/providers";
import { uiI18n } from "@/lib/i18n/ui";
import { ProviderAccessModeSetting } from "./ProviderAccessModeSetting";

const connectorModes = [
  { id: "default", label: "Default", description: "Connector-defined description" },
  { id: "fullAccess", label: "Full Access", description: "Connector-defined full access" },
];

vi.mock("@/api/agentRuntime", () => ({
  useAgentCatalog: () => ({
    data: {
      providers: [
        {
          id: "codex_cli",
          label: "Codex",
          access_modes: [
            {
              id: "default",
              label: "Default",
              description:
                "Runs in the workspace-write sandbox. Codex asks you to review command, network, or file access when approval is needed.",
            },
            {
              id: "fullAccess",
              label: "New service wording",
            },
          ],
        },
        { id: "custom-connector", label: "My Connector", access_modes: connectorModes },
      ],
    },
  }),
}));

vi.mock("@/hooks/useAccessModeSetting", () => ({
  useAccessModeSetting: () => ({
    globalAccessMode: "default",
    isError: false,
    isLoading: false,
    isPending: false,
    handleAccessModeChange: vi.fn(),
  }),
}));

it("updates built-in access instructions while keeping connector copy intact", async () => {
  render(
    <>
      <ProviderAccessModeSetting providerId={PROVIDER_IDS.CODEX_CLI} />
      <ProviderAccessModeSetting providerId="custom-connector" />
    </>,
  );

  expect(screen.getAllByText("Default")).toHaveLength(2);
  expect(screen.getByText(/Runs in the workspace-write sandbox/)).toBeInTheDocument();

  const prefix = "settings.providers.accessMode.codex";
  uiI18n.addResource("fr", "ui", `${prefix}.default.label`, "[default]");
  uiI18n.addResource("fr", "ui", `${prefix}.default.description`, "[default description]");
  uiI18n.addResource("fr", "ui", `${prefix}.fullAccess.label`, "[full access]");
  try {
    await act(async () => {
      await uiI18n.changeLanguage("fr");
    });
    expect(screen.getByText("[default]")).toBeInTheDocument();
    expect(screen.getByText("[default description]")).toBeInTheDocument();
    expect(screen.getByText("Default")).toBeInTheDocument();
    expect(screen.getByText("New service wording")).toBeInTheDocument();
    expect(screen.queryByText("[full access]")).toBeNull();
    expect(screen.getByText("Connector-defined description")).toBeInTheDocument();
  } finally {
    await act(async () => {
      await uiI18n.changeLanguage("en");
    });
    uiI18n.removeResourceBundle("fr", "ui");
  }
});
