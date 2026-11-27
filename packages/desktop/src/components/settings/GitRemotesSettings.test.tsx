import { QueryClient } from "@tanstack/react-query";
import { expect, it } from "vitest";
import { GitHost, getGetForgeAuthStatusQueryKey, type ForgeAuthStatus } from "@/api/generated";
import { uiI18n } from "@/lib/i18n/ui";
import { act, render, screen } from "@/test-utils";
import { GitRemotesSettings } from "./GitRemotesSettings";

it("retranslates connected host descriptions and the generic provider label", async () => {
  const host: ForgeAuthStatus = {
    hostname: "forge.example.test",
    kind: GitHost.Other,
    source: "stored",
    validated_user: { username: "ada" },
    cli_auth_available: false,
    token_present: true,
    use_cli_auth: false,
    username_required: false,
  };
  const queryClient = new QueryClient({ defaultOptions: { queries: { staleTime: Infinity } } });
  queryClient.setQueryData(getGetForgeAuthStatusQueryKey(), [
    host,
    {
      ...host,
      hostname: "github.example.test",
      kind: GitHost.GitHub,
      source: "cli",
      validated_user: { username: "grace" },
    },
    { ...host, hostname: "token.example.test", source: null, validated_user: { username: "lin" } },
  ] satisfies ForgeAuthStatus[]);
  render(<GitRemotesSettings />, { queryClient });

  expect(screen.getByText("Connected as ada via a stored token")).toBeVisible();
  expect(screen.getByText("Connected as grace via the CLI")).toBeVisible();
  expect(screen.getByText("Connected as lin via a token")).toBeVisible();
  const providers = screen.getAllByRole("combobox", { name: "Provider" });
  expect(providers.map((provider) => provider.textContent)).toEqual(["Other", "GitHub", "Other"]);

  const prefix = "workspace.git.gitRemotesSettings";
  uiI18n.addResource(
    "fr",
    "ui",
    `${prefix}.connectedAsWithStoredToken`,
    "Jeton stocké pour {{username}}",
  );
  uiI18n.addResource("fr", "ui", `${prefix}.connectedAsWithCli`, "CLI pour {{username}}");
  uiI18n.addResource("fr", "ui", `${prefix}.connectedAsWithToken`, "Jeton pour {{username}}");
  uiI18n.addResource("fr", "ui", `${prefix}.otherProvider`, "Autre");
  try {
    await act(() => uiI18n.changeLanguage("fr"));
    expect(screen.getByText("Jeton stocké pour ada")).toBeVisible();
    expect(screen.getByText("CLI pour grace")).toBeVisible();
    expect(screen.getByText("Jeton pour lin")).toBeVisible();
    expect(providers.map((provider) => provider.textContent)).toEqual(["Autre", "GitHub", "Autre"]);
    expect(screen.getByText(host.hostname)).toBeVisible();
  } finally {
    await act(() => uiI18n.changeLanguage("en"));
    uiI18n.removeResourceBundle("fr", "ui");
  }
});
