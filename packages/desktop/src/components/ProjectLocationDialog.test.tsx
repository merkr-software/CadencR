import type { ReactNode } from "react";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { http, HttpResponse } from "msw";
import { describe, expect, it, vi } from "vitest";
import type { UpdateProjectRequest } from "@/api/generated";
import { server } from "@/test/msw-server";
import { ProjectLocationDialog, type ProjectLocationTarget } from "./ProjectLocationDialog";

const project = { id: 7, name: "app", path: "/Users/me/code/app" };

function renderDialog(
  mode: ProjectLocationTarget["mode"],
  onClose = vi.fn(),
  folderMissing = false,
) {
  const client = new QueryClient({ defaultOptions: { mutations: { retry: false } } });
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={client}>{children}</QueryClientProvider>
  );
  render(<ProjectLocationDialog target={{ ...project, folderMissing, mode }} onClose={onClose} />, {
    wrapper,
  });
  return onClose;
}

function captureUpdate(status = 200, body: unknown = null) {
  const requests: UpdateProjectRequest[] = [];
  server.use(
    http.patch("*/api/projects/7", async ({ request }) => {
      requests.push((await request.json()) as UpdateProjectRequest);
      return HttpResponse.json(
        body ?? {
          project: { ...project, name: "Shop", path: "/Users/me/code/Shop", path_missing: false },
          warnings: [],
        },
        { status },
      );
    }),
  );
  return requests;
}

describe("ProjectLocationDialog", () => {
  it("renames the folder with the project unless the user edits its name", async () => {
    const requests = captureUpdate();
    const onClose = renderDialog("rename");

    fireEvent.change(screen.getByLabelText("Name"), { target: { value: "Shop" } });
    expect(screen.getByLabelText("Folder name")).toHaveValue("Shop");
    expect(screen.getByText("/Users/me/code/Shop")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Rename" }));

    await waitFor(() => expect(onClose).toHaveBeenCalled());
    expect(requests).toEqual([
      { name: "Shop", folder: { path: "/Users/me/code/Shop", mode: "move" } },
    ]);
  });

  it("renames only the project while its folder is missing", async () => {
    const requests = captureUpdate();
    renderDialog("rename", vi.fn(), true);

    fireEvent.change(screen.getByLabelText("Name"), { target: { value: "Shop" } });
    expect(screen.queryByRole("checkbox", { name: "Also rename the folder" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Rename" }));

    await waitFor(() => expect(requests).toEqual([{ name: "Shop" }]));
  });

  it("can rename the project alone", async () => {
    const requests = captureUpdate();
    renderDialog("rename");

    fireEvent.change(screen.getByLabelText("Name"), { target: { value: "Shop" } });
    fireEvent.click(screen.getByRole("checkbox", { name: "Also rename the folder" }));
    fireEvent.click(screen.getByRole("button", { name: "Rename" }));

    await waitFor(() => expect(requests).toEqual([{ name: "Shop" }]));
  });

  it("shows the service's refusal and stays open", async () => {
    captureUpdate(409, { error: "/Users/me/code/Shop already exists", code: "CONFLICT" });
    const onClose = renderDialog("rename");

    fireEvent.change(screen.getByLabelText("Name"), { target: { value: "Shop" } });
    fireEvent.click(screen.getByRole("button", { name: "Rename" }));

    expect(await screen.findByRole("alert")).toHaveTextContent("already exists");
    expect(onClose).not.toHaveBeenCalled();
  });

  it("locates a folder moved outside Cadencr", async () => {
    const requests = captureUpdate();
    renderDialog("locate");

    expect(screen.getByRole("button", { name: "Use this folder" })).toBeDisabled();
    fireEvent.change(screen.getByLabelText("Folder"), {
      target: { value: "/Users/me/elsewhere/app" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Use this folder" }));

    await waitFor(() =>
      expect(requests).toEqual([{ folder: { path: "/Users/me/elsewhere/app", mode: "locate" } }]),
    );
  });
});
