import { describe, expect, it } from "vitest";
import { CadencrError } from "./errors.js";
import { connected } from "./test-utils.js";

describe("exec", () => {
  it("runs a declared program and resolves any exit status", async () => {
    const { host, client } = await connected();
    host.handle("exec.run", ({ program, args, timeoutMs }) => ({
      exitCode: 1,
      success: false,
      stdout: `${program} ${(args ?? []).join(" ")} ${String(timeoutMs)}`,
      stderr: "",
      durationMs: 3,
    }));
    const result = await client.exec.run("git", ["log", "-1"], { timeoutMs: 500 });
    expect(result).toMatchObject({ exitCode: 1, success: false, stdout: "git log -1 500" });
    client.close();
    host.close();
  });

  it("rejects what the host refuses", async () => {
    const { host, client } = await connected();
    await expect(client.exec.run("bash")).rejects.toMatchObject({ code: "PLUGIN_EXEC_DENIED" });
    client.close();
    host.close();
  });
});

describe("backend", () => {
  it("resolves the backend's result and throws its own error code", async () => {
    const { host, client } = await connected();
    host.handle("backend.request", ({ method, params }) =>
      method === "ports"
        ? { result: { echo: params ?? null } }
        : { error: { code: "NOPE", message: "no" } },
    );
    await expect(client.backend.request("ports", { all: true })).resolves.toEqual({
      echo: { all: true },
    });
    const failure = client.backend.request("other");
    await expect(failure).rejects.toBeInstanceOf(CadencrError);
    await expect(failure).rejects.toMatchObject({ code: "NOPE", message: "no" });
    client.close();
    host.close();
  });

  it("resolves null when the backend answers no result", async () => {
    const { host, client } = await connected();
    host.handle("backend.request", () => ({}));
    await expect(client.backend.request("ping")).resolves.toBeNull();
    client.close();
    host.close();
  });
});
