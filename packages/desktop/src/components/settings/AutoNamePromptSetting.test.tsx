import { describe, expect, it, vi } from "vitest";
import { http, HttpResponse } from "msw";
import userEvent from "@testing-library/user-event";
import { render, screen, waitFor } from "@/test-utils";
import { server } from "@/test/msw-server";
import { AutoNamePromptSetting } from "./AutoNamePromptSetting";

const url = "*/api/workspace/settings/auto_name_system_prompt";

describe("AutoNamePromptSetting", () => {
  it("shows the stored prompt and debounces writes", async () => {
    let saved: string | undefined;
    server.use(
      http.get(url, () => HttpResponse.json({ value: "Name sessions my way" })),
      http.put(url, async ({ request }) => {
        const body = (await request.json()) as { value: string };
        saved = body.value;
        return HttpResponse.json({ value: body.value });
      }),
    );
    render(<AutoNamePromptSetting />);
    const user = userEvent.setup();

    const textarea = await screen.findByRole("textbox");
    await waitFor(() => expect(textarea).toHaveValue("Name sessions my way"));

    await user.clear(textarea);
    await user.type(textarea, "Name sessions differently");
    await waitFor(() => expect(saved).toBe("Name sessions differently"));
  });

  it("disables Reset until a custom prompt exists, then clears the setting on click", async () => {
    let value = "Name sessions my way";
    const put = vi.fn();
    server.use(
      http.get(url, () => HttpResponse.json({ value })),
      http.put(url, () => {
        put();
        value = "";
        return HttpResponse.json({ value: "" });
      }),
    );
    render(<AutoNamePromptSetting />);

    const reset = await screen.findByRole("button", { name: /reset/i });
    await waitFor(() => expect(reset).not.toBeDisabled());
    reset.click();

    await waitFor(() => expect(put).toHaveBeenCalled());
    await waitFor(() => expect(screen.getByRole("textbox")).toHaveValue(""));
    await waitFor(() => expect(screen.getByRole("button", { name: /reset/i })).toBeDisabled());
  });

  it("treats an unset setting as an empty prompt", async () => {
    server.use(http.get(url, () => HttpResponse.json({ value: null })));
    render(<AutoNamePromptSetting />);

    const textarea = await screen.findByRole("textbox");
    await waitFor(() => expect(textarea).not.toBeDisabled());
    expect(textarea).toHaveValue("");
    expect(screen.getByRole("button", { name: /reset/i })).toBeDisabled();
  });
});
