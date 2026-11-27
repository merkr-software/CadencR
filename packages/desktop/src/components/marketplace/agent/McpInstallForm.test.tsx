import { afterEach, expect, it } from "vitest";
import type { ExtensionCliSummary, McpInstallOption, McpRegistryServer } from "@/api/generated";
import { uiI18n } from "@/lib/i18n/ui";
import { act, render, screen } from "@/test-utils";
import { AgentExtensionActionsProvider } from "./AgentExtensionActions";
import { McpInstallSection } from "./McpInstallSection";

const command = "npx -y acme@1.0.0 --label <example>";
const option: McpInstallOption = {
  kind: "npm",
  transport: "stdio",
  summary: command,
  inputs: [
    {
      key: "env:TOKEN",
      kind: "env",
      label: "ACCESS_TOKEN",
      description: "Example provider's own instructions.",
      required: true,
      secret: true,
    },
  ],
};

const server: McpRegistryServer = {
  name: "io.github.example/acme",
  version: "1.0.0",
  description: "Example registry server.",
  options: [option],
};

const cli: ExtensionCliSummary = {
  provider_id: "example",
  label: "Example CLI",
  installed: true,
  support: { mcp_headers: false, mcp_transports: ["stdio"], skill_update: false, skills: false },
};

afterEach(async () => {
  await act(async () => {
    await uiI18n.changeLanguage("en");
  });
  uiI18n.removeResourceBundle("fr", "ui");
});

it("updates the mounted MCP form while preserving command and registry data", async () => {
  const { user } = render(
    <AgentExtensionActionsProvider>
      <McpInstallSection server={server} clis={[cli]} />
    </AgentExtensionActionsProvider>,
  );
  const name = screen.getByLabelText("Server name in the CLI");
  const token = screen.getByLabelText(/ACCESS_TOKEN/);
  const install = screen.getByRole("button", { name: "Add to Example CLI" });
  expect(install).toBeDisabled();
  expect(screen.getByText(command).parentElement).toHaveTextContent(`The CLI runs ${command}`);
  await user.type(token, "example-value");
  expect(install).toBeEnabled();

  uiI18n.addResourceBundle("fr", "ui", {
    marketplace: {
      agent: {
        mcpDetail: { cliRuns: "La CLI lance <target>{{target}}</target>" },
        mcpInstallForm: {
          serverNameInTheCli: "Nom du serveur dans la CLI",
          environment: "Variable d’environnement",
          requiredInput: "{{kind}} · obligatoire",
          secretHandling: "Les secrets sont transmis à <command>{{command}}</command>.",
        },
      },
    },
  });
  await act(async () => {
    await uiI18n.changeLanguage("fr");
  });

  expect(screen.getByLabelText("Nom du serveur dans la CLI")).toBe(name);
  expect(name).toHaveValue("acme");
  expect(screen.getByLabelText(/ACCESS_TOKEN.*obligatoire/)).toBe(token);
  expect(token).toHaveValue("example-value");
  const commandCode = screen.getByText(command);
  expect(commandCode.tagName).toBe("CODE");
  expect(commandCode.parentElement).toHaveTextContent(`La CLI lance ${command}`);
  expect(install).toBeEnabled();
  expect(screen.getByText("mcp add").tagName).toBe("CODE");
  expect(screen.getByText("Example provider's own instructions.")).toBeVisible();
});
